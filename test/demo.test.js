// DEMO_MODE is a promise about what the public sandbox can and cannot do, and a
// promise like that is worth exactly as much as its enforcement. So this test
// does not poke at a middleware function: it boots the real server over a real
// socket, against a copy of the real demo dataset, and behaves like a stranger
// with curl. Three claims are checked from the outside:
//
//   1. The shared dataset is read-only. Ingest, the admin surface, prefs, scans,
//      key minting: all refused, with an admin token and an AI key present.
//   2. The interactive surface (rules, warnings, ask) works, is scoped to the
//      visitor's own session, and leaves the dataset untouched for the next one.
//   3. The AI is capped per visitor, and log content cannot instruct it.
//
// The last test boots the same server WITHOUT DEMO_MODE to prove the gate is
// demo-only and normal Clio still ingests.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_DB = path.join(ROOT, "demo", "data", "clio.db");
const HAVE_DATASET = fs.existsSync(DEMO_DB);
const REFUSAL = "demo instance is read-only";
const AI_LIMIT = 2;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// `reuseDir` boots a second server over the first one's data directory, which
// is how the durability of the AI spend counters gets tested the only way worth
// testing it: kill the process, start it again, see whether the caps remember.
async function boot(extraEnv, { withDataset = false, reuseDir = null } = {}) {
  const port = await freePort();
  const dir = reuseDir || fs.mkdtempSync(path.join(os.tmpdir(), "clio-demo-test-"));
  // The generated demo database, so the tests run against the rules, warnings
  // and log entries a visitor actually meets.
  if (withDataset && HAVE_DATASET) fs.copyFileSync(DEMO_DB, path.join(dir, "clio.db"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      // Present on purpose: DEMO_MODE must ignore the first two entirely, and
      // must use the third ONLY through the capped, cheap-model demo path.
      ADMIN_TOKEN: "test-admin-token",
      SITE_PASSWORD: "test-site-password",
      ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key",
      DEMO_AI_LIMIT: String(AI_LIMIT),
      // Trickle immediately, so the live-entry tests do not sleep.
      DEMO_LIVE_FIRST_MS: "0",
      DEMO_LIVE_EVERY_MS: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, base, dir };
}

function stop(s, { keepDir = false } = {}) {
  if (!s) return;
  try { s.child.kill("SIGKILL"); } catch {}
  if (!keepDir) try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
}

const req = (base, method, path, { body, token, cookie } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined || method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });

// A "visitor": one cookie jar, exactly like a browser tab. The demo's whole
// session model hangs off this, so the tests have to model it honestly.
async function visitor(base) {
  const r = await fetch(base + "/api/overview");
  const set = r.headers.getSetCookie?.() || [];
  const cookie = set.map((c) => c.split(";")[0]).join("; ");
  const call = (method, p, body) => req(base, method, p, { body, cookie });
  return {
    cookie,
    get: async (p) => (await call("GET", p)).json(),
    post: async (p, body) => (await call("POST", p, body ?? {})).json(),
    patch: async (p, body) => (await call("PATCH", p, body)).json(),
    del: async (p) => (await call("DELETE", p)).json(),
    raw: call,
  };
}

// Every route that must still refuse. Method + path is the whole point: the
// gate must not depend on the handler being reached.
const WRITE_ROUTES = [
  // ingest
  ["POST", "/v1/log"],
  ["POST", "/v1/log/nk_clio_anything"],
  ["POST", "/v1/txn"],
  ["POST", "/v1/txn/nk_clio_anything"],
  // admin surface, including its reads (they list keys and systems)
  ["POST", "/v1/admin/keys"],
  ["GET", "/v1/admin/keys"],
  ["DELETE", "/v1/admin/keys/some-id"],
  ["POST", "/v1/admin/systems"],
  ["GET", "/v1/admin/systems"],
  ["PATCH", "/v1/admin/systems/cascade-office"],
  ["POST", "/v1/admin/systems/cascade-office/archive"],
  ["POST", "/v1/admin/systems/cascade-office/purge"],
  ["GET", "/v1/admin/databases"],
  ["PATCH", "/v1/admin/databases/cascade-office/CascadeOps"],
  // machine surface writes
  ["POST", "/v1/warnings/some-id/ack"],
  ["POST", "/v1/scan"],
  // UI surface writes that stay off in the demo
  ["POST", "/api/scan"],
  ["POST", "/api/ai"],            // in particular: nobody can hand the demo a key
  ["POST", "/api/prefs"],
  ["POST", "/api/notify-test"],
  ["POST", "/api/rules/author"],  // the one AI surface the demo does not offer
  ["POST", "/api/rejects/ack"],
  ["POST", "/api/databases/place"],
  ["POST", "/api/databases/unlink"],
  ["POST", "/api/databases/rename"],
  ["POST", "/api/systems/cascade-office"],
];

let demo = null;
before(async () => { demo = await boot({ DEMO_MODE: "1" }, { withDataset: true }); });
after(() => stop(demo));

test("every write-shaped route returns 403 in DEMO_MODE", async () => {
  for (const [method, p] of WRITE_ROUTES) {
    const r = await req(demo.base, method, p, { body: { category: "x", action: "x.y", payload: {} } });
    assert.equal(r.status, 403, `${method} ${p} should be 403, got ${r.status}`);
    const b = await r.json();
    assert.equal(b.error, REFUSAL, `${method} ${p} should say "${REFUSAL}"`);
    assert.equal(b.code, "demo_read_only", `${method} ${p} should carry the demo_read_only code`);
  }
});

test("the admin token does not unlock the admin surface", async () => {
  for (const [method, p] of WRITE_ROUTES.filter(([, x]) => x.startsWith("/v1/admin"))) {
    const r = await req(demo.base, method, p, { body: { system_id: "x" }, token: "test-admin-token" });
    assert.equal(r.status, 403, `${method} ${p} with a token should still be 403`);
  }
});

test("a refused post really did not land", async () => {
  const before = (await (await fetch(demo.base + "/api/overview")).json()).systems
    .reduce((n, s) => n + (s.entry_count || 0), 0);
  await req(demo.base, "POST", "/v1/log", { body: { category: "sneak", action: "sneak.in", payload: { x: 1 } } });
  const { entries } = await (await fetch(demo.base + "/api/logs?limit=50&q=sneak")).json();
  assert.equal(entries.length, 0, "nothing should have been written");
  const after = (await (await fetch(demo.base + "/api/overview")).json()).systems
    .reduce((n, s) => n + (s.entry_count || 0), 0);
  assert.equal(after, before, "the entry count must not move");
});

test("the viewer opens with no login, and AI is on when a key is present", async () => {
  const page = await fetch(demo.base + "/");
  assert.equal(page.status, 200, "SITE_PASSWORD must be ignored in DEMO_MODE");
  assert.match(await page.text(), /<title>/i);

  const ov = await (await fetch(demo.base + "/api/overview")).json();
  assert.equal(ov.demo, true, "the UI needs the demo flag to show its banner");
  assert.equal(ov.ai, true, "AI is the product: with a key in the environment it is on");
  assert.equal(ov.demo_ai.limit, AI_LIMIT, "the UI needs the per-visitor cap");

  const info = await (await fetch(demo.base + "/v1/info")).json();
  assert.equal(info.data.demo, true);
});

test("the demo AI runs a cheap model and cannot be reconfigured", async () => {
  const ai = await (await fetch(demo.base + "/api/ai")).json();
  assert.equal(ai.demo, true);
  // The invariant is "a fixed, capped model the visitor cannot change", not one
  // specific model: Haiku reasoned badly over 100k rows, so the demo runs Sonnet.
  assert.match(ai.model, /^claude-(haiku|sonnet)-/, "the demo must run a fixed capped model");
  assert.equal(ai.thinking, "off", "the demo must not pay for thinking");
  assert.equal(ai.key_set, false, "the key comes from the environment, never from stored config");
  const r = await req(demo.base, "POST", "/api/ai", { body: { api_key: "sk-ant-someone-elses-key" } });
  assert.equal(r.status, 403, "nobody can hand the demo a key or change its model");
});

test("reads still work", async () => {
  for (const p of ["/health", "/api/overview", "/api/logs?limit=5", "/api/warnings", "/api/rules",
    "/api/verify?system_id=cascade-office", "/api/actors", "/api/vocab", "/api/prefs", "/api/rejects"]) {
    const r = await fetch(demo.base + p);
    assert.equal(r.status, 200, `GET ${p} should be 200, got ${r.status}`);
  }
});

// ---- session-scoped interactivity ------------------------------------------

test("rules are interactive per visitor and never mutate the dataset", { skip: !HAVE_DATASET && "no generated dataset" }, async () => {
  const a = await visitor(demo.base);
  const b = await visitor(demo.base);
  assert.notEqual(a.cookie, b.cookie, "each visitor gets their own session cookie");

  const base = (await a.get("/api/rules")).rules;
  assert.ok(base.length >= 4, "the dataset ships with rules");
  const target = base.find((r) => r.enabled) || base[0];

  // toggle off + rename, as visitor A
  const patched = await a.patch("/api/rules/" + target.id, { enabled: false, name: "A's renamed rule" });
  assert.equal(patched.ok, true);
  assert.equal(patched.demo_session_only, true, "the change is session-scoped and says so");

  const aRules = (await a.get("/api/rules")).rules;
  const aSeen = aRules.find((r) => r.id === target.id);
  assert.equal(aSeen.enabled, false, "A sees their own toggle");
  assert.equal(aSeen.name, "A's renamed rule", "A sees their own edit");

  const bSeen = (await b.get("/api/rules")).rules.find((r) => r.id === target.id);
  assert.equal(bSeen.enabled, true, "B must not see A's toggle");
  assert.equal(bSeen.name, target.name, "B must not see A's rename");

  // create + delete, still only for A
  const made = await a.post("/api/rules", { name: "A's new rule", match: { action_like: "%.deleted" }, severity: "warn" });
  assert.ok(made.id, "a rule was created for this session");
  assert.equal((await a.get("/api/rules")).rules.some((r) => r.id === made.id), true);
  assert.equal((await b.get("/api/rules")).rules.some((r) => r.id === made.id), false, "B must not see A's new rule");

  await a.del("/api/rules/" + target.id);
  assert.equal((await a.get("/api/rules")).rules.some((r) => r.id === target.id), false, "A deleted it for themselves");
  assert.equal((await b.get("/api/rules")).rules.some((r) => r.id === target.id), true, "B still has it");

  // a fresh visitor gets the pristine baseline back
  const c = await visitor(demo.base);
  const cRules = (await c.get("/api/rules")).rules;
  assert.equal(cRules.length, base.length, "the next visitor sees the untouched rule set");
  assert.equal(cRules.find((r) => r.id === target.id).name, target.name);
});

test("clicking a rule shows what it matches, not an empty panel", { skip: !HAVE_DATASET && "no generated dataset" }, async () => {
  const a = await visitor(demo.base);
  const rules = (await a.get("/api/rules")).rules;
  const withMatches = rules.find((r) => (r.would_fire_30d || 0) > 0 && !r.match.silence);
  assert.ok(withMatches, "at least one rule matches recent entries");
  const detail = await a.get("/api/rules/" + withMatches.id + "/firings");
  assert.ok(Array.isArray(detail.matches), "the route returns matching entries");
  assert.ok(detail.matches.length > 0, `a rule that reports ${withMatches.would_fire_30d} matches must be able to show them`);
  assert.ok(detail.matches[0].ts && detail.matches[0].action, "each match is a real log entry");
});

test("dry-run works in the demo and is read-only", async () => {
  const a = await visitor(demo.base);
  const r = await a.post("/api/rules/dry-run", { match: { action_like: "%.deleted" }, days: 30 });
  assert.ok(Number.isFinite(r.total_matches), "dry run returns counts");
});

test("warnings dismiss per visitor and reset for the next", { skip: !HAVE_DATASET && "no generated dataset" }, async () => {
  const a = await visitor(demo.base);
  const b = await visitor(demo.base);
  const open = (await a.get("/api/warnings")).warnings;
  assert.ok(open.length > 0, "the demo has open warnings to dismiss");

  const one = open[0];
  const ack = await a.post("/api/warnings/" + one.id + "/ack");
  assert.equal(ack.acknowledged, true);
  const aAfter = (await a.get("/api/warnings")).warnings;
  assert.equal(aAfter.some((w) => w.id === one.id), false, "A no longer sees it");
  assert.equal((await b.get("/api/warnings")).warnings.some((w) => w.id === one.id), true, "B still does");

  const all = await a.post("/api/warnings/ack-all", {});
  assert.ok(all.acknowledged >= 1);
  assert.equal((await a.get("/api/warnings")).warnings.length, 0, "A cleared their own list");
  assert.ok((await b.get("/api/warnings")).warnings.length > 0, "B's list is untouched");

  // and the acknowledged view still shows them, so nothing is actually gone
  assert.ok((await a.get("/api/warnings?status=all")).warnings.length > 0);

  const c = await visitor(demo.base);
  assert.equal((await c.get("/api/warnings")).warnings.length, open.length, "the next visitor sees them all again");
});

// ---- AI guardrails ----------------------------------------------------------

test("the AI prompt cap is per visitor and enforced server-side", async () => {
  const a = await visitor(demo.base);
  const b = await visitor(demo.base);
  for (let i = 0; i < AI_LIMIT; i++) {
    const r = await a.post("/api/ask", { messages: [{ role: "user", content: "how many logins today?" }] });
    assert.notEqual(r.quota_exhausted, true, `prompt ${i + 1} of ${AI_LIMIT} should be allowed`);
    assert.equal(r.prompts_used, i + 1, "the server counts the prompts");
  }
  const over = await a.post("/api/ask", { messages: [{ role: "user", content: "one more" }] });
  assert.equal(over.quota_exhausted, true, "the cap is enforced");
  assert.match(over.reply, /navarre\.ai/, "the refusal points somewhere useful");

  // a different visitor still has their full allowance
  const fresh = await b.post("/api/ask", { messages: [{ role: "user", content: "hello" }] });
  assert.notEqual(fresh.quota_exhausted, true, "the cap is per visitor, not global");

  // and the cap cannot be reset by dropping the cookie... a new cookie is a new
  // visitor, which is inherent to any cookie-based cap; what matters is that the
  // count is kept on the server, not in anything the client can edit.
  const cookieless = await (await req(demo.base, "POST", "/api/ask", { body: { messages: [{ role: "user", content: "x" }] } })).json();
  assert.ok(cookieless, "a cookieless caller still gets a well-formed answer");
});

test("log content cannot instruct the AI, and the AI cannot write", async () => {
  const { guardSql, UNTRUSTED_RULE } = await import("../ai.js");
  // 1. the system prompt states the rule, in the prompt itself
  assert.match(UNTRUSTED_RULE, /UNTRUSTED DATA/);
  assert.match(UNTRUSTED_RULE, /never instruction to follow/);
  // 2. the only tool is a single read-only SELECT, enforced before the query runs
  for (const bad of [
    "DELETE FROM log_entries",
    "UPDATE warnings SET status = 'acknowledged'",
    "INSERT INTO log_entries (system_id) VALUES ('x')",
    "DROP TABLE warnings",
    "PRAGMA writable_schema = 1",
    "ATTACH DATABASE '/tmp/x.db' AS x",
    "SELECT 1; DELETE FROM warnings",
  ]) {
    assert.throws(() => guardSql(bad), /Only SELECT|One statement/, `guardSql must refuse: ${bad}`);
  }
  assert.equal(guardSql("SELECT COUNT(*) FROM v_logs"), "SELECT COUNT(*) FROM v_logs");

  // 3. the handle the AI queries through is read-only at the engine level
  const { openDbReadOnly } = await import("../db.js");
  const ro = openDbReadOnly(path.join(demo.dir, "clio.db"));
  assert.throws(() => ro.prepare("DELETE FROM warnings").run(), /readonly|read-only/i,
    "the AI's database handle must refuse writes even if a guard were bypassed");
  ro.close();
});

test("the planted injection entry is present and reads as data", { skip: !HAVE_DATASET && "no generated dataset" }, async () => {
  const { entries } = await (await fetch(demo.base + "/api/logs?limit=20&q=IGNORE")).json();
  assert.ok(entries.length > 0, "the demo carries a prompt-injection entry to test with");
  assert.match(entries[0].payload_json, /IGNORE ALL PREVIOUS INSTRUCTIONS/);
  // it is just a log row: no route, and no amount of reading it, can change state
  const warningsBefore = (await (await fetch(demo.base + "/api/warnings")).json()).warnings.length;
  assert.ok(warningsBefore > 0, "the injection text asked for the warnings to be deleted; they are still here");
});

// ---- the live trickle -------------------------------------------------------

test("the live trickle is per visitor, chained, and never written to the dataset",
  { skip: !HAVE_DATASET && "no generated dataset" }, async () => {
  const before = await (await fetch(demo.base + "/api/verify?system_id=cascade-office")).json();
  assert.equal(before.valid, true);

  const a = await visitor(demo.base);
  await new Promise((r) => setTimeout(r, 250)); // a few bursts, with the test timings
  const feed = await a.get("/api/logs?limit=50");
  const fresh = feed.entries.filter((e) => e.seq > before.head.seq && e.system_id === "cascade-office");
  assert.ok(fresh.length > 0, "new entries appear in the visitor's feed");
  assert.ok(Date.parse(fresh[0].ts_server) > Date.now() - 120000, "they are stamped now, not in the past");

  // the chain still verifies THROUGH the live entries, for that visitor
  const av = await a.get("/api/verify?system_id=cascade-office");
  assert.equal(av.valid, true, "the visitor's chain, live entries included, verifies");
  assert.ok(av.checked > before.checked, "and the live entries were actually walked");

  // a different visitor gets their own, and the underlying dataset is untouched
  const b = await visitor(demo.base);
  const bv = await b.get("/api/verify?system_id=cascade-office");
  assert.equal(bv.valid, true, "B's chain verifies too");
  // Deliberately NOT a comparison of counts. Both visitors trickle on the same
  // timer, so which one has more entries at any instant is a race, and the
  // count never showed what this is about anyway. The real property is that
  // the two visitors' live entries are generated independently: at a given seq
  // past the shared head, B holds B's event, not a copy of A's. (The feed does
  // not expose event_id, so compare the payload, which is what a visitor sees.)
  const bFeed = await b.get("/api/logs?limit=50");
  const bFresh = bFeed.entries.filter((e) => e.seq > before.head.seq && e.system_id === "cascade-office");
  assert.ok(bFresh.length > 0, "B gets a live trickle of their own");
  const aBySeq = new Map(fresh.map((e) => [e.seq, e.payload_json]));
  const overlap = bFresh.filter((e) => aBySeq.has(e.seq));
  assert.ok(overlap.length > 0, "the two visitors' chains cover the same seq range");
  const identical = overlap.filter((e) => aBySeq.get(e.seq) === e.payload_json);
  assert.ok(identical.length < overlap.length,
    `B's live entries must be generated for B, not copied from A ` +
    `(${identical.length}/${overlap.length} payloads matched A's exactly)`);
  const plain = await (await fetch(demo.base + "/api/verify?system_id=cascade-office")).json();
  assert.equal(plain.valid, true, "the shared dataset still verifies untouched");
});

// ---- one truth for the counts ----------------------------------------------

// A system card and that system's own panel used to show two different numbers
// for the same word, because the panel's per-file rows came from a counter that
// only ever counted entries whose payload names a file. Both now come from the
// log, so the parts add up to the whole. Cookieless on purpose: no visitor
// session means no live trickle, so the two reads see the same instant.
test("a system's file counts and its total come from one count", { skip: !HAVE_DATASET && "no generated dataset", concurrency: false }, async () => {
  const ov = await (await fetch(demo.base + "/api/overview")).json();
  for (const s of ov.systems) {
    const c = await (await fetch(demo.base + "/api/system-counts?system_id=" + encodeURIComponent(s.system_id))).json();
    assert.equal(c.total, s.entry_count, `${s.system_id}: the card total and the panel total must be the same number`);
    const parts = Object.values(c.files).reduce((n, x) => n + x, 0) + c.other;
    assert.equal(parts, c.total, `${s.system_id}: per-file counts plus the rest must add up to the total`);
    for (const d of s.databases || []) {
      assert.equal(typeof c.files[`${d.system_id}|${d.file_name}`], "number",
        `${s.system_id}: every listed file needs a count from the same query`);
    }
  }
  const cascade = await (await fetch(demo.base + "/api/system-counts?system_id=cascade-office")).json();
  assert.ok(cascade.files["cascade-office|CascadeOps"] > 0, "the file has record-change entries");
  assert.ok(cascade.other > 0, "and the system has event-shaped entries that belong to no file");
});

// ---- the money counters, and what people asked ------------------------------

// The caps exist to protect a bill on a public URL. Both used to live in
// process memory, so a deploy or a machine move reset every visitor to a full
// allowance and the hourly ceiling to zero. This is the test that would have
// caught that: kill the server, start it again, ask again.
test("AI spend counters and captured questions survive a restart", async () => {
  const TOKEN = "questions-token";
  let s = await boot({ DEMO_MODE: "1", DEMO_AI_LIMIT: "2", DEMO_AI_HOURLY: "50", DEMO_QUESTIONS_TOKEN: TOKEN });
  let cookie;
  try {
    const v = await visitor(s.base);
    cookie = v.cookie;
    for (let i = 1; i <= 2; i++) {
      const r = await v.post("/api/ask", { messages: [{ role: "user", content: `question ${i}` }] });
      assert.equal(r.prompts_used, i);
    }
    const over = await v.post("/api/ask", { messages: [{ role: "user", content: "one too many" }] });
    assert.equal(over.quota_exhausted, true);

    // every question is captured, refused ones included, and reading them back
    // needs the token
    assert.equal((await fetch(s.base + "/api/demo/questions")).status, 401, "the questions are not public");
    const q = await (await fetch(s.base + "/api/demo/questions", { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(q.durable, true, "the questions table must be on disk, not in memory");
    assert.equal(q.asked, 3, "all three questions were recorded");
    assert.equal(q.spent, 2, "only two of them cost a prompt");
    assert.equal(q.questions[0].question, "one too many");
    assert.equal(q.questions[0].outcome, "out_of_prompts");
    assert.equal(q.questions[0].spent, 0);
    assert.ok(q.questions.every((x) => x.session_id), "each question carries the session it came from");
  } finally { stop(s, { keepDir: true }); }

  // same data directory, new process: the counters must remember
  const dir = s.dir;
  s = await boot({ DEMO_MODE: "1", DEMO_AI_LIMIT: "2", DEMO_AI_HOURLY: "50", DEMO_QUESTIONS_TOKEN: TOKEN }, { reuseDir: dir });
  try {
    const again = await (await req(s.base, "POST", "/api/ask", {
      body: { messages: [{ role: "user", content: "after the restart" }] }, cookie,
    })).json();
    assert.equal(again.quota_exhausted, true, "a restart must not hand this visitor a fresh allowance");
    assert.equal(again.prompts_used, 2, "the count is the same one it was before the restart");
    const q = await (await fetch(s.base + "/api/demo/questions", { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(q.asked, 4, "and the earlier questions are still there");
  } finally { stop(s); }
});

// The per-visitor cap protects the experience (clear the cookie and you get
// another ten). This one protects the bill, so it has to hold across visitors,
// and it has to say something different when it fires.
test("the hourly cap is global across visitors and reads as its own state", async () => {
  const s = await boot({ DEMO_MODE: "1", DEMO_AI_LIMIT: "10", DEMO_AI_HOURLY: "1" });
  try {
    const a = await visitor(s.base);
    const b = await visitor(s.base);
    const first = await a.post("/api/ask", { messages: [{ role: "user", content: "the one prompt this hour" }] });
    assert.notEqual(first.demo_busy, true, "the first question goes through");
    const second = await b.post("/api/ask", { messages: [{ role: "user", content: "and now the demo is out" }] });
    assert.equal(second.demo_busy, true, "a different visitor is stopped by the global cap");
    assert.notEqual(second.quota_exhausted, true, "which is NOT the same thing as using up your own ten");
    assert.equal(second.prompts_used, 0, "and it costs them nothing");
    assert.ok(second.wait_min >= 1, "the UI needs to say how long");
    assert.match(second.reply, /hourly/i, "and the visitor is told which limit they hit");
  } finally { stop(s); }
});

// ---- normal Clio ------------------------------------------------------------

test("without DEMO_MODE the write routes are open again", async () => {
  const normal = await boot({ DEMO_MODE: "", DEMO_QUESTIONS_TOKEN: "questions-token" });
  try {
    const r = await req(normal.base, "POST", "/v1/log", {
      body: { category: "test", action: "test.happened", payload: { n: 1 } },
    });
    assert.equal(r.status, 200, "normal Clio must still ingest");
    const b = await r.json();
    assert.equal(b.ok, true);
    assert.equal(b.data.accepted, 1);

    // A self-hosted Clio captures nothing and offers no way to read a capture
    // back, whatever is set in its environment. The demo's question log is the
    // demo's, and it is Matt's own server.
    // ?key= gets past this install's site password, so a 404 here means the
    // route is genuinely absent rather than merely gated.
    assert.equal((await fetch(normal.base + "/api/demo/questions?key=test-site-password")).status, 404,
      "the questions route must not exist outside the demo");
    assert.equal(fs.existsSync(path.join(normal.dir, "demo-state.db")), false,
      "and no capture file is created");
  } finally {
    stop(normal);
  }
});

// The likeliest install mistake is pasting the dashboard URL instead of the
// ingest endpoint, which posts to "/". That used to fall through to Express's
// HTML 404 and the entry was gone: no entry, no reject row, no trace. Which
// made a liar of the never-drop-data promise at exactly the moment it mattered.
test("a post to the wrong path is filed, not dropped", async () => {
  const s = await boot({}, { withDataset: false });   // no DEMO_MODE: a real install
  try {
    const payload = { file: "AI Demo DB", table: "Organization", record_id: 1,
                      account_name: "Someone", event_id: "wrong-door-1" };
    const r = await req(s.base, "POST", "/?key=some-site-password", { body: payload });
    assert.equal(r.status, 404, "still an error: the URL really is wrong");
    const b = await r.json();
    assert.equal(b.error.code, "wrong_endpoint", "and it says which kind of wrong");
    assert.match(b.error.message, /\/v1\/log\//, "the reply names the right endpoint");
    assert.ok(b.data && b.data.accepted >= 1, "but the entry was kept");

    const logs = await (await fetch(s.base + "/v1/logs?system_id=unfiled&limit=10", {
      headers: { Authorization: "Bearer test-admin-token" } })).json();
    const hit = (logs.data?.entries || []).some((e) => String(e.payload_json).includes("wrong-door-1"));
    assert.ok(hit, "and it is readable under Unfiled");
  } finally { stop(s); }
});

test("a wrong-path post with no body still answers in JSON, never HTML", async () => {
  const s = await boot({}, { withDataset: false });
  try {
    const r = await req(s.base, "POST", "/nonsense", {});
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type") || "", /json/, "a FileMaker caller has to parse this");
    const b = await r.json();
    assert.equal(b.error.code, "wrong_endpoint");
  } finally { stop(s); }
});
