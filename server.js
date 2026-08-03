// Clio: inviolate logs that live outside FileMaker.
// Two surfaces:
//   /v1/*  machine surface, Bearer auth, chassis envelope { ok, data | error }.
//          The navarre-sidecars chassis shipper posts here unchanged.
//   /api/* + static UI, SITE_PASSWORD gate (Hecate's three-way pattern),
//          plain JSON for the single-file frontend.

import "./env.js";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { openDb, openDbReadOnly } from "./db.js";
import { appendBatch, head, verifyRange } from "./chain.js";
import { runScan, getPrefs } from "./scan.js";
import { askLogs, aiFindings, aiAvailable, pulseText, authorRule, setModel, currentModel, MODELS, listModels } from "./ai.js";
import { runRules, dryRun, createRule, listRules } from "./rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MAX_BATCH = Number(process.env.MAX_BATCH || 500);
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "clio.db");
const db = openDb(DB_PATH);
let dbRead = null; // opened lazily; the file must exist first
function readHandle() { return (dbRead ||= openDbReadOnly(DB_PATH)); }

// ---- helpers ----------------------------------------------------------------

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { timingSafeEqual(ba, ba); return false; }
  return timingSafeEqual(ba, bb);
}

const ok = (data) => ({ ok: true, data });
const errBody = (code, message, requestId) =>
  ({ ok: false, error: { code, message, request_id: requestId || null } });

function fail(res, status, code, message) {
  return res.status(status).json(errBody(code, message, res.locals.requestId));
}

// nk_clio_<24 base62>, chassis format. Plaintext shown once; sha256 at rest.
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function generateApiKey() {
  let s = "";
  for (const b of randomBytes(24)) s += B62[b % 62];
  return `nk_clio_${s}`;
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

// Clio eats its own dog food: admin/scan events go on Clio's own chain.
function selfLog(event, fields = {}) {
  const entry = {
    event_id: randomUUID(),
    ts_client: new Date().toISOString(),
    category: `clio.${event.split(".")[0]}`,
    action: `clio.${event}`,
    payload_json: JSON.stringify(fields),
  };
  console.log(JSON.stringify({ level: "audit", action: entry.action, ...fields }));
  appendBatch(db, "clio", [entry]);
  emit(); // clio's own activity is live too
}

// ---- live push (SSE) + visible rejects --------------------------------------
// One in-process fan-out. Every append pings open EventSource clients so the
// UI updates with zero polling. Clients then pull new rows since their cursor.
const sseClients = new Set();
function emit() { for (const res of sseClients) { try { res.write("event: log\ndata: 1\n\n"); } catch {} } }

// A rejected/failed post is recorded so a silent drop is never invisible.
const insReject = db.prepare("INSERT INTO rejects (id, system_id, code, message, snippet) VALUES (?, ?, ?, ?, ?)");
function recordReject(systemId, code, message, snippet) {
  try { insReject.run(randomUUID(), systemId || null, code, String(message).slice(0, 200), String(snippet || "").slice(0, 300)); } catch {}
}

// ---- auth middlewares -------------------------------------------------------

// Reads (head/verify with a key) stay strict: an unknown key gets 401.
function keyAuth(req, res, next) {
  const key = req.params?.key || bearer(req) || (req.query.key ? String(req.query.key) : "");
  if (!key) return fail(res, 401, "unauthorized", "API key required (Bearer header, URL path, or ?key=).");
  const row = db.prepare("SELECT id, system_id, label FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL").get(sha256Hex(key));
  if (!row) return fail(res, 401, "unauthorized", "Unknown or revoked API key.");
  req.system = { systemId: row.system_id, keyId: row.id, label: row.label };
  next();
}

// The Unfiled catch-all: a logging tool NEVER drops data. Its rows are stored
// like any other, and it exists so nothing sent to /v1/log/<anything> is lost.
function ensureUnfiled() {
  db.prepare("INSERT INTO systems (system_id, label) VALUES ('unfiled', 'Unfiled') ON CONFLICT(system_id) DO NOTHING").run();
}
// INGEST auth: no matter what follows /v1/log/, log the data. A valid key files
// under its system; an unknown or missing key files under "Unfiled" with the
// attempted key recorded, so the admin can adopt it into the right system later.
function ingestAuth(req, res, next) {
  const key = req.params?.key || bearer(req) || (req.query.key ? String(req.query.key) : "");
  const row = key ? db.prepare("SELECT id, system_id, label FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL").get(sha256Hex(key)) : null;
  if (row) {
    // ONE key for all apps: a key whose system is "universal" routes each post
    // to a system derived from the data (the FileMaker file name), so you paste
    // the same URL into every file and they still separate cleanly.
    req.system = { systemId: row.system_id, keyId: row.id, label: row.label, universal: row.system_id === "universal" };
    return next();
  }
  ensureUnfiled();
  req.system = { systemId: "unfiled", unfiledKey: key ? key.slice(0, 24) : "(none)" };
  recordReject(null, key ? "unknown_api_key" : "no_api_key",
    `logged to Unfiled (key ${key ? key.slice(0, 16) + "…" : "missing"})`, "");
  next();
}
// The system a post belongs to when using the universal key: the file name
// from a transaction, or a "system"/"file"/"table" hint on a flat event.
function routeSystem(body) {
  if (looksLikeTxn(body)) {
    for (const [file, tables] of Object.entries(body)) {
      if (tables && typeof tables === "object" && !Array.isArray(tables) && Object.values(tables).some((r) => Array.isArray(r))) return slugify(file);
    }
  }
  const hint = body?.system || body?.file || body?.table;
  return hint ? slugify(hint) : "unfiled";
}

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) return fail(res, 503, "admin_disabled", "ADMIN_TOKEN is not set.");
  if (!constantTimeEqual(bearer(req), ADMIN_TOKEN)) {
    return fail(res, 401, "unauthorized", "Admin token required.");
  }
  req.isAdmin = true;
  next();
}

// Key callers are scoped to their own system; admin picks one with ?system_id=.
function keyOrAdmin(req, res, next) {
  if (ADMIN_TOKEN && constantTimeEqual(bearer(req), ADMIN_TOKEN)) {
    req.isAdmin = true;
    const sid = req.query.system_id || req.body?.system_id;
    req.scopedSystemId = sid ? String(sid) : null;
    return next();
  }
  keyAuth(req, res, () => {
    req.scopedSystemId = req.system.systemId;
    next();
  });
}

function requireSystemId(req, res) {
  if (!req.scopedSystemId) {
    fail(res, 400, "missing_system_id", "Pass ?system_id= (admin callers).");
    return null;
  }
  return req.scopedSystemId;
}

// ---- app --------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // behind Fly's proxy: honor x-forwarded-proto so req.protocol is https

// Every URL Clio hands out MUST be https: Fly 301-redirects http, and a
// redirect drops the POST body, so an http log URL silently fails.
function publicUrl(req, path) { return `https://${req.get("host")}${path}`; }
// Clean, complete slug for a system id from a name (no truncation).
function slugify(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "system"; }

app.use((req, res, next) => {
  res.locals.requestId = randomBytes(4).toString("hex");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate"); // FM web viewers cache aggressively
  next();
});
app.use(express.json({ limit: "25mb" })); // a Delete All / big Replace arrives as ONE OnWindowTransaction payload

// Password gate for the UI surface only. Machine routes (/v1, /health) use
// Bearer auth and must stay reachable by shippers and FileMaker scripts.
if (SITE_PASSWORD) {
  const cookieVal = `clio_auth=${encodeURIComponent(SITE_PASSWORD)}`;
  app.use((req, res, next) => {
    if (req.path.startsWith("/v1/") || req.path === "/health") return next();
    if (req.query.key === SITE_PASSWORD) {
      const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      res.setHeader("Set-Cookie", `${cookieVal}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${secure}`);
      return next();
    }
    const cookies = req.headers.cookie || "";
    if (cookies.split(";").some((c) => c.trim() === cookieVal)) return next();
    const header = req.headers.authorization || "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      if (decoded.slice(decoded.indexOf(":") + 1) === SITE_PASSWORD) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Clio"');
    return res.status(401).send("Authentication required. Load with ?key=<password> in a web viewer.");
  });
}
app.use(express.static(path.join(__dirname, "public")));

// ---- open routes ------------------------------------------------------------

app.get("/health", (_req, res) => {
  try {
    db.prepare("SELECT 1 AS x").get();
    res.json(ok({ status: "ok", uptime_s: Math.round(process.uptime()) }));
  } catch (e) {
    res.status(500).json(errBody("db_unavailable", String(e.message || e), res.locals.requestId));
  }
});

app.get("/v1/info", (_req, res) => {
  res.json(ok({ name: "clio", version: VERSION, ai: aiAvailable() }));
});

// ---- ingest -----------------------------------------------------------------

// Accepts two body shapes:
//   { entries: [ {event_id, ts_client, category, action, payload_json}, ... ] }  (batch, chassis contract)
//   { category, action, payload, ...extras }  (single flat event, hand-written FM calls)
// In the flat shape, "payload" or "payload_json" both work, and any other
// top-level keys (table, account_name, ...) fold into the payload.
function normalizeBody(b) {
  if (Array.isArray(b?.entries)) return b.entries;
  if (!b || (!b.action && !b.category)) return null;
  const { category, action, payload, payload_json, event_id, ts_client,
    ["server-side"]: _transport, ...rest } = b; // "server-side" is FM transport metadata, not payload
  let pl = payload_json ?? payload ?? {};
  if (typeof pl === "string") { try { pl = JSON.parse(pl); } catch { pl = { text: pl }; } }
  if (pl && typeof pl === "object" && !Array.isArray(pl)) pl = { ...pl, ...rest };
  return [{ event_id, ts_client, category, action, payload_json: pl }];
}

// Is this body an OnWindowTransaction payload? It has at least one top-level
// key whose value is an object of arrays (File -> Table -> [[op,id,data]]).
function looksLikeTxn(b) {
  if (!b || typeof b !== "object" || Array.isArray(b) || Array.isArray(b.entries)) return false;
  return Object.values(b).some((v) =>
    v && typeof v === "object" && !Array.isArray(v) && Object.values(v).some((rows) => Array.isArray(rows)));
}

// ONE endpoint, three shapes. FileMaker posts whatever it has to /v1/log/<key>
// and Clio figures it out: a transaction dump (auto-detected, unpacked, diffed),
// a chassis batch { entries:[...] }, or one flat { category, action, payload }.
// This is what lets a client run a single dead-simple script.
function ingest(req, res) {
  if (req.system.universal) { ensureUnfiled(); req.system.systemId = routeSystem(req.body); }
  const systemId = req.system.systemId;
  if (looksLikeTxn(req.body)) return ingestTxn(req, res);
  const entries = normalizeBody(req.body);
  if (req.system.unfiledKey && Array.isArray(entries)) for (const e of entries) { if (e.payload_json && typeof e.payload_json === "object") e.payload_json._unfiled_key = req.system.unfiledKey; }
  if (!Array.isArray(entries) || entries.length === 0) {
    recordReject(systemId, "bad_request", "unrecognized body shape", JSON.stringify(req.body).slice(0, 300));
    return fail(res, 400, "bad_request", "Body must be a transaction dump, { entries: [...] }, or one flat { category, action, payload } event.");
  }
  if (entries.length > MAX_BATCH) {
    recordReject(systemId, "batch_too_large", `${entries.length} entries`, "");
    return fail(res, 413, "batch_too_large", `At most ${MAX_BATCH} entries per batch.`);
  }
  const result = appendBatch(db, systemId, entries);
  emit();
  res.json(ok(echoData(systemId, entries, result, entries.length > 1 ? "batch" : "event")));
}

app.post("/v1/log", ingestAuth, ingest);
app.post("/v1/log/:key", ingestAuth, ingest); // key-in-URL: unknown key -> Unfiled, never dropped

// OnWindowTransaction ingest: FileMaker POSTs the trigger's parameter
// UNTOUCHED — { "File" : { "Table" : [ [ "Op", recId, contextFieldValue ], ... ] } }.
// Clio does the unpacking: one chain entry per record op, in payload order.
// action = <system>.<Table>.<op>, payload = { file, table, record_id, data }.
function normalizeTxn(b, systemId) {
  const entries = [];
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  // FileMaker may fold stray scalar keys alongside the transaction (account_name,
  // and leftover empty action/category/payload/table). Use account_name as the
  // who; ignore the rest. Only object-valued top-level keys are File envelopes.
  const account = typeof b.account_name === "string" && b.account_name ? b.account_name : null;
  let sawFile = false;
  for (const [file, tables] of Object.entries(b)) {
    if (!tables || typeof tables !== "object" || Array.isArray(tables)) continue; // skip scalars
    for (const [table, rows] of Object.entries(tables)) {
      if (!Array.isArray(rows)) continue;
      sawFile = true;
      for (const r of rows) {
        if (!Array.isArray(r)) continue;
        const [op, recId, data] = r;
        const payload = { file, table, record_id: recId, data: data ?? "" };
        if (account && !(data && typeof data === "object" && data.z_Modifier)) payload.account_name = account;
        entries.push({
          category: `${systemId}.data`,
          action: `${systemId}.${table}.${String(op).toLowerCase()}`,
          payload_json: payload,
        });
      }
    }
  }
  return sawFile ? entries : null;
}

// The chain holds each record's previous full snapshot, so Clio can say
// exactly which fields an edit touched: diff the incoming snapshot against
// the last one for the same (table, record_id). FileMaker stays dumb.
function previousData(systemId, table, recId) {
  const row = db.prepare(
    `SELECT payload_json FROM log_entries
     WHERE system_id = ? AND json_extract(payload_json, '$.table') = ?
       AND json_extract(payload_json, '$.record_id') = ?
     ORDER BY seq DESC LIMIT 1`
  ).get(systemId, table, recId);
  if (!row) return null;
  try {
    const p = JSON.parse(row.payload_json);
    return p.data && typeof p.data === "object" ? p.data : null;
  } catch { return null; }
}

function diffRecords(prev, next) {
  const changed = {};
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
      changed[k] = { from: prev[k] ?? null, to: next[k] ?? null };
    }
  }
  return changed;
}

// Auto-discover database files from a transaction batch: upsert each file
// under this system, bump its lifetime count, flag new ones for the admin.
// Counters make per-file totals instant (no scan).
// A newly-seen file arrives placed=0 (unplaced): its entries are stored, but
// it waits in the wizard until the admin names it and either makes it its own
// system or links it to an existing one. No silent auto-attach.
const upsertDbNew = db.prepare(
  `INSERT INTO databases (system_id, file_name, entry_count, placed) VALUES (?, ?, ?, 0)
   ON CONFLICT(system_id, file_name) DO UPDATE SET
     last_seen = datetime('now'), entry_count = entry_count + excluded.entry_count`
);
function trackFiles(systemId, entries) {
  const counts = new Map();
  for (const e of entries) {
    const f = e.payload_json?.file;
    if (f) counts.set(f, (counts.get(f) || 0) + 1);
  }
  for (const [file, n] of counts) upsertDbNew.run(systemId, file, n);
}

// A transaction touching more than this many records (an import, a mass
// Replace, a Delete All) collapses to one summary entry per file/table/op,
// instead of exploding every record. Keeps the log readable and the ingest
// fast, and never hangs the client on a monster payload.
const BULK_THRESHOLD = Number(process.env.BULK_THRESHOLD || 100);

function collapseBulk(systemId, entries) {
  const groups = new Map();
  for (const e of entries) {
    const p = e.payload_json;
    const op = e.action.split(".").pop();
    const key = `${p.file}|${p.table}|${op}`;
    let g = groups.get(key);
    if (!g) { g = { file: p.file, table: p.table, op, count: 0, account: p.account_name || null, first: p.record_id, last: p.record_id }; groups.set(key, g); }
    g.count++; g.last = p.record_id; if (p.account_name) g.account = p.account_name;
  }
  return [...groups.values()].map((g) => ({
    event_id: randomUUID(), ts_client: new Date().toISOString(),
    category: `${systemId}.bulk`, action: `${systemId}.${g.table}.${g.op}`,
    payload_json: {
      message: `${g.count.toLocaleString()} records ${g.op} in ${g.table}`,
      bulk: true, count: g.count, file: g.file, table: g.table, op: g.op,
      account_name: g.account, first_record: g.first, last_record: g.last,
    },
  }));
}

function ingestTxn(req, res) {
  if (req.system.universal) { ensureUnfiled(); req.system.systemId = routeSystem(req.body); }
  const systemId = req.system.systemId;
  let entries = normalizeTxn(req.body, systemId);
  if (entries === null) {
    recordReject(systemId, "bad_request", "not an OnWindowTransaction body", JSON.stringify(req.body).slice(0, 300));
    return fail(res, 400, "bad_request", "Body must be the OnWindowTransaction JSON, posted as-is.");
  }
  if (entries.length === 0) return res.json(ok({ accepted: 0, duplicates: 0, head: head(db, systemId) })); // Find-mode empty firing
  if (req.system.unfiledKey) for (const e of entries) e.payload_json._unfiled_key = req.system.unfiledKey;

  let collapsed = 0;
  if (entries.length > BULK_THRESHOLD) {
    collapsed = entries.length;
    entries = collapseBulk(systemId, entries);
  } else {
    // per-record diff against the last snapshot for that record
    const latestInBatch = new Map();
    for (const e of entries) {
      const p = e.payload_json;
      if (!p.data || typeof p.data !== "object") continue;
      const k = `${p.table}#${p.record_id}`;
      const prev = latestInBatch.get(k) ?? previousData(systemId, p.table, p.record_id);
      if (prev && e.action.endsWith(".modified")) p.changed = diffRecords(prev, p.data);
      latestInBatch.set(k, p.data);
    }
  }
  const result = appendBatch(db, systemId, entries);
  trackFiles(systemId, entries);
  emit();
  res.json(ok(echoData(systemId, entries, result, collapsed ? "bulk" : "transaction", collapsed)));
}

// The response echoes what Clio understood: kind, what changed, who, a human
// summary, capped for big batches. The fire-and-forget path ignores it; a
// test call reads it to confirm attribution and shape without opening the UI.
function echoData(systemId, entries, result, kind, collapsed = 0) {
  const cap = 10;
  const byAction = {};
  for (const e of entries) byAction[e.action] = (byAction[e.action] || 0) + 1;
  const shown = entries.slice(0, cap).map((e) => {
    const p = typeof e.payload_json === "object" ? e.payload_json
      : (() => { try { return JSON.parse(e.payload_json); } catch { return {}; } })();
    const out = { action: e.action, file: p.file || null, table: p.table || null,
      account_name: p.account_name || p.data?.z_Modifier || null, message: p.message || null };
    if (p.changed) out.changed = Object.fromEntries(
      Object.entries(p.changed).filter(([k]) => !k.startsWith("z_")).map(([k, v]) => [k, [v.from, v.to]]));
    return out;
  });
  return {
    accepted: result.accepted, duplicates: result.duplicates,
    system_id: systemId, kind, head: result.head,
    lifetime_entries: result.head?.seq ?? head(db, systemId).seq,
    ...(collapsed ? { collapsed_from: collapsed } : {}),
    by_action: byAction,
    entries: shown,
    truncated: entries.length > cap ? entries.length - cap : 0,
  };
}

app.post("/v1/txn", ingestAuth, ingestTxn);
app.post("/v1/txn/:key", ingestAuth, ingestTxn);

// ---- chain reads ------------------------------------------------------------

app.get("/v1/head", keyOrAdmin, (req, res) => {
  const sid = requireSystemId(req, res); if (!sid) return;
  res.json(ok(head(db, sid)));
});

app.get("/v1/verify", keyOrAdmin, (req, res) => {
  const sid = requireSystemId(req, res); if (!sid) return;
  const { expect_seq, expect_hash, from_seq } = req.query;
  const result = verifyRange(db, sid, {
    fromSeq: from_seq ? Number(from_seq) : 1,
    expectSeq: expect_seq !== undefined ? Number(expect_seq) : null,
    expectHash: expect_hash !== undefined ? String(expect_hash) : null,
  });
  if (!result.valid) selfLog("verify.failed", { system_id: sid, first_bad_seq: result.first_bad_seq });
  res.json(ok(result));
});

function queryLogs(sid, q) {
  const where = ["system_id = ?"]; const params = [sid];
  if (q.action) { where.push("action = ?"); params.push(String(q.action)); }
  if (q.category) { where.push("category = ?"); params.push(String(q.category)); }
  if (q.since) { where.push("ts_server >= ?"); params.push(String(q.since)); }
  if (q.until) { where.push("ts_server < ?"); params.push(String(q.until)); }
  if (q.q) { where.push("payload_json LIKE ?"); params.push(`%${q.q}%`); }
  if (q.after_seq) { where.push("seq > ?"); params.push(Number(q.after_seq)); }
  const limit = Math.min(Number(q.limit) || 100, 1000);
  const order = q.after_seq ? "ASC" : "DESC"; // cursor walks forward; default view is newest-first
  const rows = db.prepare(
    `SELECT seq, event_id, ts_client, ts_server, category, action, payload_json
     FROM log_entries WHERE ${where.join(" AND ")} ORDER BY seq ${order} LIMIT ${limit}`
  ).all(...params);
  return { entries: rows, next_after_seq: rows.length ? Math.max(...rows.map((r) => r.seq)) : null };
}

app.get("/v1/logs", keyOrAdmin, (req, res) => {
  const sid = requireSystemId(req, res); if (!sid) return;
  res.json(ok(queryLogs(sid, req.query)));
});

// ---- warnings + scan --------------------------------------------------------

function listWarnings(systemId, status) {
  const where = []; const params = [];
  if (systemId) { where.push("system_id = ?"); params.push(systemId); }
  if (status) { where.push("status = ?"); params.push(status); }
  return db.prepare(
    `SELECT id, system_id, severity, title, detail, evidence_json, scan_id, status, created_at, source, class
     FROM warnings ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY created_at DESC LIMIT 200`
  ).all(...params);
}

app.get("/v1/warnings", keyOrAdmin, (req, res) => {
  res.json(ok({ warnings: listWarnings(req.scopedSystemId, req.query.status && String(req.query.status)) }));
});

app.post("/v1/warnings/:id/ack", adminAuth, (req, res) => {
  const r = db.prepare("UPDATE warnings SET status = 'acknowledged' WHERE id = ?").run(req.params.id);
  if (!r.changes) return fail(res, 404, "not_found", "No such warning.");
  res.json(ok({ acknowledged: req.params.id }));
});

// Notification channels. Two, fire-and-forget, never block a scan:
//   Slack  — an incoming-webhook URL; we send Slack's { text } (+ blocks).
//   Webhook — a generic JSON POST for the Comm bus or anything else.
// Both are read from prefs first (UI-settable), env as fallback. Email
// stays the anchor script's job (FMS schedule notifications).
function channels() {
  const p = getPrefs(db);
  return {
    slack: p.slack_webhook || process.env.SLACK_WEBHOOK || "",
    webhook: p.alert_webhook || process.env.ALERT_WEBHOOK || "",
  };
}

const SEV_EMOJI = { critical: ":rotating_light:", warn: ":warning:", info: ":information_source:" };

async function postJson(url, body) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "notify failed", url: url.slice(0, 40), error: String(e.message || e) }));
  }
}

async function deliver(alerts, { test = false } = {}) {
  const ch = channels();
  const plain = alerts.map((a) => `[${a.severity}] ${a.system_id}: ${a.title}. ${a.detail}`).join("\n");
  const jobs = [];
  if (ch.slack) {
    const header = test ? "Clio test alert" :
      `Clio: ${alerts.length} thing${alerts.length === 1 ? "" : "s"} worth a look`;
    const lines = alerts.map((a) =>
      `${SEV_EMOJI[a.severity] || "•"} *${a.system_id}* — ${a.title}\n${a.detail}`).join("\n\n");
    jobs.push(postJson(ch.slack, {
      text: `${header}\n${lines}`, // fallback/notification text
      blocks: [
        { type: "header", text: { type: "plain_text", text: header } },
        { type: "section", text: { type: "mrkdwn", text: lines.slice(0, 2900) } },
      ],
    }));
  }
  if (ch.webhook) jobs.push(postJson(ch.webhook, { source: "clio", text: plain, alerts, test }));
  await Promise.all(jobs);
  return { slack: Boolean(ch.slack), webhook: Boolean(ch.webhook) };
}

async function pushAlerts(scanId) {
  if (!scanId) return;
  const alerts = db.prepare(
    "SELECT system_id, severity, title, detail FROM warnings WHERE scan_id = ? AND severity IN ('warn','critical')"
  ).all(scanId);
  if (!alerts.length) return;
  await deliver(alerts);
}

async function doScan(force) {
  const result = await runScan(db, {
    force,
    aiFindings: aiAvailable() ? aiFindings : null,
    ruleFindings: (now) => runRules(db, now),
  });
  if (!result.skipped) {
    selfLog("scan.run", { scan_id: result.scan_id, findings: result.findings });
    pushAlerts(result.scan_id); // deliberately not awaited
  }
  return result;
}

// ---- rules ------------------------------------------------------------------

function actionVocab() {
  return db.prepare(
    "SELECT system_id, action, COUNT(*) AS n FROM log_entries GROUP BY system_id, action ORDER BY n DESC LIMIT 80"
  ).all().map((a) => `${a.system_id} ${a.action} (${a.n})`).join("\n");
}

app.get("/api/rules", (_req, res) => res.json({ rules: listRules(db) }));

app.post("/api/rules", (req, res) => {
  const r = req.body || {};
  if (!r.name || !r.match) return res.status(400).json({ error: "name and match required" });
  res.json(createRule(db, r));
});

app.patch("/api/rules/:id", (req, res) => {
  const fields = [];
  const params = [];
  for (const k of ["name", "description", "effect", "severity", "class"]) {
    if (req.body[k] !== undefined) { fields.push(`${k} = ?`); params.push(String(req.body[k])); }
  }
  if (req.body.enabled !== undefined) { fields.push("enabled = ?"); params.push(req.body.enabled ? 1 : 0); }
  if (req.body.match !== undefined) { fields.push("match_json = ?"); params.push(JSON.stringify(req.body.match)); }
  if (req.body.match_patch !== undefined) { // merge into existing match (e.g. just the files scope)
    let cur = {}; try { cur = JSON.parse(db.prepare("SELECT match_json FROM rules WHERE id = ?").get(req.params.id)?.match_json || "{}"); } catch {}
    fields.push("match_json = ?"); params.push(JSON.stringify({ ...cur, ...req.body.match_patch }));
  }
  if (!fields.length) return res.json({ ok: true });
  params.push(req.params.id);
  const r = db.prepare(`UPDATE rules SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  if (!r.changes) return res.status(404).json({ error: "no such rule" });
  res.json({ ok: true });
});

app.delete("/api/rules/:id", (req, res) => {
  db.prepare("DELETE FROM rules WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Dry-run a match spec against history before saving.
app.post("/api/rules/dry-run", (req, res) => {
  try {
    res.json(dryRun(db, req.body?.match || {}, Number(req.body?.days) || 30));
  } catch (e) {
    res.status(200).json({ error: String(e.message || e) });
  }
});

// The conversational rule author: chat in, reply + optional structured draft
// (already dry-run) out.
app.post("/api/rules/author", async (req, res) => {
  try {
    if (!aiAvailable()) return res.json({ reply: "Set an Anthropic API key to author rules by chat. You can still add them by hand.", draft: null });
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const { reply, draft } = await authorRule(messages, actionVocab());
    let preview = null;
    if (draft && draft.match) {
      try { preview = dryRun(db, draft.match, 30); } catch {}
    }
    res.json({ reply, draft, preview });
  } catch (e) {
    res.status(200).json({ reply: "", error: String(e.message || e) });
  }
});

// ---- AI settings ------------------------------------------------------------

app.get("/api/ai", async (_req, res) => {
  const { models, fallback } = await listModels();
  res.json({ available: aiAvailable(), model: currentModel(), models, fallback });
});

app.post("/api/ai", async (req, res) => {
  const m = String(req.body?.model || "");
  const { models } = await listModels();
  if (m && (models.some((x) => x.id === m) || MODELS.some((x) => x.id === m))) {
    setModel(m); metaSet("model", m);
    return res.json({ ok: true, model: m });
  }
  res.status(400).json({ error: "unknown model" });
});

app.post("/v1/scan", keyOrAdmin, async (req, res) => {
  try {
    res.json(ok(await doScan(Boolean(req.body?.force))));
  } catch (e) {
    fail(res, 500, "scan_failed", String(e.message || e));
  }
});

// ---- systems registry -------------------------------------------------------
// One row per logged system (chain): usually one file on one FM Server.
// Minting a key auto-registers its system, so the registry is optional
// bookkeeping, never a gate.

function upsertSystem(systemId, { label, fm_server, fm_file, notes } = {}) {
  db.prepare(
    `INSERT INTO systems (system_id, label, fm_server, fm_file, notes) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(system_id) DO UPDATE SET
       label = COALESCE(excluded.label, label),
       fm_server = COALESCE(excluded.fm_server, fm_server),
       fm_file = COALESCE(excluded.fm_file, fm_file),
       notes = COALESCE(excluded.notes, notes)`
  ).run(systemId, label ?? null, fm_server ?? null, fm_file ?? null, notes ?? null);
}

function systemsIndex() {
  return Object.fromEntries(db.prepare("SELECT * FROM systems").all().map((s) => [s.system_id, s]));
}

app.post("/v1/admin/systems", adminAuth, (req, res) => {
  const systemId = String(req.body?.system_id || "").trim();
  if (!systemId) return fail(res, 400, "bad_request", "system_id is required.");
  upsertSystem(systemId, req.body);
  selfLog("admin.system_registered", { system_id: systemId, fm_server: req.body?.fm_server, fm_file: req.body?.fm_file });
  res.json(ok(db.prepare("SELECT * FROM systems WHERE system_id = ?").get(systemId)));
});

app.get("/v1/admin/systems", adminAuth, (_req, res) => {
  const reg = systemsIndex();
  const chains = db.prepare("SELECT DISTINCT system_id FROM log_entries").all().map((r) => r.system_id);
  const keyCounts = Object.fromEntries(
    db.prepare("SELECT system_id, COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL GROUP BY system_id")
      .all().map((r) => [r.system_id, r.n])
  );
  const ids = [...new Set([...Object.keys(reg), ...chains])].sort();
  res.json(ok({
    systems: ids.map((sid) => ({
      ...(reg[sid] || { system_id: sid }),
      active_keys: keyCounts[sid] || 0,
      ...head(db, sid),
    })),
  }));
});

// Edit a system's display fields.
app.patch("/v1/admin/systems/:id", adminAuth, (req, res) => {
  const fields = []; const params = [];
  for (const k of ["label", "fm_server", "notes"]) {
    if (req.body[k] !== undefined) { fields.push(`${k} = ?`); params.push(req.body[k] === null ? null : String(req.body[k])); }
  }
  if (!fields.length) return res.json(ok({ unchanged: true }));
  // ensure the row exists (a system may exist only as a chain until now)
  upsertSystem(req.params.id, {});
  params.push(req.params.id);
  db.prepare(`UPDATE systems SET ${fields.join(", ")} WHERE system_id = ?`).run(...params);
  res.json(ok(db.prepare("SELECT * FROM systems WHERE system_id = ?").get(req.params.id)));
});

// Databases (files) under systems. Auto-discovered on ingest; named here.
function databasesFor(systemId) {
  return db.prepare("SELECT * FROM databases WHERE system_id = ? ORDER BY last_seen DESC").all(systemId);
}
app.get("/v1/admin/databases", adminAuth, (req, res) => {
  const sid = req.query.system_id ? String(req.query.system_id) : null;
  const rows = sid ? databasesFor(sid) : db.prepare("SELECT * FROM databases ORDER BY system_id, last_seen DESC").all();
  res.json(ok({ databases: rows, unacknowledged: db.prepare("SELECT COUNT(*) AS n FROM databases WHERE acknowledged = 0").get().n }));
});
app.patch("/v1/admin/databases/:system/:file", adminAuth, (req, res) => {
  const file = decodeURIComponent(req.params.file);
  const sets = []; const params = [];
  if (req.body.friendly_name !== undefined) { sets.push("friendly_name = ?"); params.push(req.body.friendly_name ? String(req.body.friendly_name) : null); }
  if (req.body.acknowledged !== undefined) { sets.push("acknowledged = ?"); params.push(req.body.acknowledged ? 1 : 0); }
  if (!sets.length) return res.json(ok({ unchanged: true }));
  params.push(req.params.system, file);
  const r = db.prepare(`UPDATE databases SET ${sets.join(", ")} WHERE system_id = ? AND file_name = ?`).run(...params);
  if (!r.changes) return fail(res, 404, "not_found", "No such database.");
  res.json(ok({ updated: true }));
});

// Archive: summarize + snapshot a system's whole log, append a tombstone entry
// describing exactly what was archived. Non-destructive; the log still verifies.
app.post("/v1/admin/systems/:id/archive", adminAuth, (req, res) => {
  const sid = req.params.id;
  const rows = db.prepare(
    "SELECT * FROM log_entries WHERE system_id = ? ORDER BY seq"
  ).all(sid);
  if (!rows.length) return fail(res, 400, "empty", "Nothing to archive.");
  const h = head(db, sid);
  // detailed summary by action, file, actor
  const byAction = {}, byFile = {}, byActor = {};
  for (const r of rows) {
    byAction[r.action] = (byAction[r.action] || 0) + 1;
    let p = {}; try { p = JSON.parse(r.payload_json); } catch {}
    if (p.file) byFile[p.file] = (byFile[p.file] || 0) + 1;
    const who = p.account_name || p.data?.z_Modifier; if (who) byActor[who] = (byActor[who] || 0) + 1;
  }
  const summary = {
    system_id: sid, entries: rows.length,
    span: { from: rows[0].ts_server, to: rows[rows.length - 1].ts_server },
    archived_head: { seq: h.seq, entry_hash: h.entry_hash },
    by_action: byAction, by_file: byFile, by_actor: byActor,
  };
  // tombstone on the chain (append-only, so the archival act is itself logged)
  appendBatch(db, sid, [{
    event_id: randomUUID(), ts_client: new Date().toISOString(),
    category: `${sid}.archive`, action: `${sid}.archive.created`,
    payload_json: { message: `Archived ${rows.length} entries (${summary.span.from.slice(0,10)} to ${summary.span.to.slice(0,10)})`, ...summary },
  }]);
  selfLog("admin.archive_created", { system_id: sid, entries: rows.length });
  res.json(ok({ summary, archive: { system_id: sid, head: summary.archived_head, entries: rows } }));
});

// Purge: the deliberate second pass. Delete the pre-tombstone rows and
// re-genesis from the archive tombstone forward. Admin-gated; irreversible.
app.post("/v1/admin/systems/:id/purge", adminAuth, (req, res) => {
  const sid = req.params.id;
  if (req.body?.confirm !== sid) return fail(res, 400, "confirm_required", `Send { "confirm": "${sid}" } to purge.`);
  const before = db.prepare("SELECT COUNT(*) AS n FROM log_entries WHERE system_id = ?").get(sid).n;
  db.exec("BEGIN");
  try {
    db.exec("DROP TRIGGER IF EXISTS log_no_delete");
    db.prepare("DELETE FROM log_entries WHERE system_id = ?").run(sid);
    db.exec("CREATE TRIGGER log_no_delete BEFORE DELETE ON log_entries BEGIN SELECT RAISE(ABORT, 'log_entries is append-only'); END");
    db.prepare("DELETE FROM databases WHERE system_id = ?").run(sid);
    db.prepare("UPDATE databases SET entry_count = 0 WHERE system_id = ?").run(sid);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return fail(res, 500, "purge_failed", String(e.message || e)); }
  selfLog("admin.purge", { system_id: sid, removed: before });
  res.json(ok({ purged: before, system_id: sid }));
});

// ---- admin keys (chassis-verbatim semantics) --------------------------------

app.post("/v1/admin/keys", adminAuth, (req, res) => {
  const systemId = String(req.body?.system_id || "").trim();
  if (!systemId) return fail(res, 400, "bad_request", "system_id is required.");
  const label = req.body?.label ? String(req.body.label) : null;
  upsertSystem(systemId, req.body); // registering rides along with minting
  const key = generateApiKey();
  const id = randomUUID();
  db.prepare("INSERT INTO api_keys (id, system_id, label, key_hash) VALUES (?, ?, ?, ?)")
    .run(id, systemId, label, sha256Hex(key));
  selfLog("admin.key_minted", { key_id: id, system_id: systemId, label });
  res.status(201).json(ok({ id, system_id: systemId, label, key })); // plaintext appears exactly once
});

app.get("/v1/admin/keys", adminAuth, (_req, res) => {
  const keys = db.prepare(
    "SELECT id, system_id, label, created_at, revoked_at FROM api_keys ORDER BY created_at DESC"
  ).all();
  res.json(ok({ keys }));
});

app.delete("/v1/admin/keys/:id", adminAuth, (req, res) => {
  const r = db.prepare(
    "UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL"
  ).run(req.params.id);
  if (!r.changes) return fail(res, 404, "not_found", "No such active key.");
  selfLog("admin.key_revoked", { key_id: req.params.id });
  res.json(ok({ revoked: req.params.id }));
});

// ---- UI surface (behind the gate) ------------------------------------------

app.get("/api/overview", (req, res) => {
  const showHidden = req.query.all === "1";
  const reg = systemsIndex();
  const chains = db.prepare("SELECT DISTINCT system_id FROM log_entries").all().map((r) => r.system_id);
  const ids = [...new Set([...Object.keys(reg), ...chains])];
  const openCounts = Object.fromEntries(
    db.prepare("SELECT system_id, COUNT(*) AS n FROM warnings WHERE status = 'open' GROUP BY system_id")
      .all().map((r) => [r.system_id, r.n]));
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const todayCounts = Object.fromEntries(
    db.prepare("SELECT system_id, COUNT(*) AS n FROM log_entries WHERE ts_server >= ? GROUP BY system_id").all(dayAgo)
      .map((r) => [r.system_id, r.n]));
  const dbsBySystem = {};
  for (const d of db.prepare("SELECT * FROM databases").all()) (dbsBySystem[d.system_id] ||= []).push(d);
  const systems = ids
    .filter((sid) => showHidden || (reg[sid]?.display ?? 1))
    .map((sid) => ({
      ...head(db, sid),
      display: reg[sid]?.display ?? 1,
      today: todayCounts[sid] || 0,
      open_warnings: openCounts[sid] || 0,
      label: reg[sid]?.label || null,
      fm_server: reg[sid]?.fm_server || null,
      tz_offset: reg[sid]?.tz_offset ?? null,
      databases: (dbsBySystem[sid] || []).map((d) => ({
        file_name: d.file_name, name: d.friendly_name || d.file_name,
        entry_count: d.entry_count, placed: !!d.placed, last_seen: d.last_seen,
      })),
    }));
  systems.sort((a, b) => (a.label || a.system_id).localeCompare(b.label || b.system_id));
  // Unplaced files (any system) drive the new-database wizard.
  const unplaced = db.prepare("SELECT system_id, file_name, entry_count, last_seen FROM databases WHERE placed = 0 ORDER BY last_seen DESC").all();
  res.json({ systems, ai: aiAvailable(), version: VERSION, unplaced, tagline: "FileMaker logging for the AI Age." });
});

// Live push: the browser opens this once; every append writes an event and the
// client pulls new rows. No polling, stays fresh across sleep (browser auto-
// reconnects EventSource on its own).
app.get("/api/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("event: hello\ndata: 1\n\n");
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

app.get("/api/rejects", (_req, res) => {
  res.json({ rejects: db.prepare("SELECT * FROM rejects ORDER BY ts DESC LIMIT 50").all() });
});

// New-database wizard. Placed files show under their system; unplaced wait here.
// Placing "own" makes a file its own system (mints a key, hands back the URL);
// "link" attaches it to an existing system for display. Unlink returns it to
// the unplaced state. (Entries stay under the key they arrived on; this governs
// naming and grouping, reversibly.)
app.post("/api/databases/place", (req, res) => {
  const { system_id, file_name, mode, name, target } = req.body || {};
  if (!system_id || !file_name) return res.status(400).json({ error: "system_id and file_name required" });
  if (mode === "link") {
    db.prepare("UPDATE databases SET placed = 1, system_display = ?, friendly_name = COALESCE(?, friendly_name) WHERE system_id = ? AND file_name = ?")
      .run(String(target || system_id), name || null, system_id, file_name);
    return res.json({ ok: true });
  }
  // own: create/keep a system named after the file, hand back a fresh key + URL
  const newSid = slugify(name || file_name);
  upsertSystem(newSid, { label: name || file_name });
  db.prepare("UPDATE databases SET placed = 1, system_display = ?, friendly_name = COALESCE(?, friendly_name) WHERE system_id = ? AND file_name = ?")
    .run(newSid, name || file_name, system_id, file_name);
  const key = generateApiKey(); const id = randomUUID();
  db.prepare("INSERT INTO api_keys (id, system_id, label, key_hash) VALUES (?, ?, ?, ?)").run(id, newSid, name || file_name, sha256Hex(key));
  selfLog("admin.system_created", { system_id: newSid, from_file: file_name });
  res.json({ ok: true, system_id: newSid, url: publicUrl(req, `/v1/log/${key}`) });
});
app.post("/api/databases/unlink", (req, res) => {
  const { system_id, file_name } = req.body || {};
  db.prepare("UPDATE databases SET placed = 0, system_display = NULL WHERE system_id = ? AND file_name = ?").run(system_id, file_name);
  res.json({ ok: true });
});

// Per-system saves (rename, show/hide, timezone) are ordinary, not destructive,
// so they sit behind the site-password gate, no admin token prompt.
app.post("/api/systems/:id", (req, res) => {
  upsertSystem(req.params.id, {});
  const sets = []; const params = [];
  if (req.body.label !== undefined) { sets.push("label = ?"); params.push(req.body.label || null); }
  if (req.body.fm_server !== undefined) { sets.push("fm_server = ?"); params.push(req.body.fm_server || null); }
  if (req.body.display !== undefined) { sets.push("display = ?"); params.push(req.body.display ? 1 : 0); }
  if (req.body.tz_offset !== undefined) { sets.push("tz_offset = ?"); params.push(req.body.tz_offset === null ? null : Number(req.body.tz_offset)); }
  if (sets.length) { params.push(req.params.id); db.prepare(`UPDATE systems SET ${sets.join(", ")} WHERE system_id = ?`).run(...params); }
  res.json({ ok: true });
});
app.post("/api/databases/rename", (req, res) => {
  const { system_id, file_name, name } = req.body || {};
  db.prepare("UPDATE databases SET friendly_name = ? WHERE system_id = ? AND file_name = ?").run(name || null, system_id, file_name);
  res.json({ ok: true });
});

// With system_id: that chain, seq-cursor paging. Without: the live feed,
// newest first across every system (poll with since=<last ts_server seen>).
app.get("/api/logs", (req, res) => {
  const sid = String(req.query.system_id || "");
  if (sid) return res.json(queryLogs(sid, req.query));
  const where = []; const params = [];
  if (req.query.since) { where.push("ts_server > ?"); params.push(String(req.query.since)); }
  if (req.query.q) { where.push("(payload_json LIKE ? OR action LIKE ?)"); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const rows = db.prepare(
    `SELECT system_id, seq, ts_client, ts_server, category, action, payload_json
     FROM log_entries ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ts_server DESC, system_id, seq DESC LIMIT ${limit}`
  ).all(...params);
  res.json({ entries: rows, latest_ts: rows.length ? rows[0].ts_server : (req.query.since || null) });
});

// History, computed at read time from the raw log. Two modes:
//   record mode (table + record_id): the full before->after timeline for one
//     record, derived by walking its entries oldest-first and tracking the last
//     value per field (works for lean "only-changed" and fat "full-record").
//   list mode: cross-dimensional filter (actor, table, field, date, value) ->
//     matching changes, newest first. No precomputation, pure SQL + a walk.
app.get("/api/history", (req, res) => {
  const q = req.query;
  const sid = String(q.system_id || "");
  if (!sid) return res.status(400).json({ error: "system_id required" });
  const where = ["system_id = ?"]; const params = [sid];
  if (q.table) { where.push("json_extract(payload_json,'$.table') = ?"); params.push(String(q.table)); }
  if (q.record_id) { where.push("json_extract(payload_json,'$.record_id') = ?"); params.push(Number(q.record_id)); }
  if (q.actor) { where.push("(json_extract(payload_json,'$.account_name') = ? OR json_extract(payload_json,'$.data.z_Modifier') = ?)"); params.push(String(q.actor), String(q.actor)); }
  if (q.action_type) { // friendly CRUD filter -> action patterns
    const map = { create: "%.new", update: "%.modified", delete: "%.deleted", read: "%view%", login: "%login%", export: "%export%" };
    const pat = map[String(q.action_type)];
    if (pat) { where.push("(action LIKE ? OR action LIKE ?)"); params.push(pat, pat.replace("%.", "%.created")); }
  }
  if (q.since) { where.push("ts_client >= ?"); params.push(String(q.since)); }
  if (q.until) { where.push("ts_client < ?"); params.push(String(q.until)); }
  if (q.q) { where.push("payload_json LIKE ?"); params.push(`%${q.q}%`); }
  const recordMode = Boolean(q.record_id && q.table);
  const field = q.field ? String(q.field) : null;
  const limit = Math.min(Number(q.limit) || 300, 2000);
  const rows = db.prepare(
    `SELECT seq, ts_server, action, payload_json FROM log_entries
     WHERE ${where.join(" AND ")} ORDER BY seq ${recordMode ? "ASC" : "DESC"} LIMIT ${limit}`
  ).all(...params);

  const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
  const items = [];
  if (recordMode) {
    const last = {};
    for (const e of rows) { // oldest first: accumulate last-seen value per field
      const p = parse(e.payload_json);
      const data = p.data && typeof p.data === "object" ? p.data : null;
      const who = p.account_name || data?.z_Modifier || null;
      const changes = [];
      if (data) for (const [f, v] of Object.entries(data)) {
        if (f === "id" || f === "record_id") continue;
        const before = last[f];
        if (before !== undefined && JSON.stringify(before) !== JSON.stringify(v)) changes.push({ field: f, from: before, to: v });
        last[f] = v;
      }
      const shown = field ? changes.filter((c) => c.field === field) : changes.filter((c) => !c.field.startsWith("z_"));
      if (shown.length || (!field && e.action.endsWith(".new"))) items.push({ seq: e.seq, ts: e.ts_server, who, action: e.action, changes: shown });
    }
    items.reverse(); // newest first for display
  } else {
    for (const e of rows) {
      const p = parse(e.payload_json);
      const data = p.data && typeof p.data === "object" ? p.data : null;
      const fields = data ? Object.keys(data).filter((k) => !/^(id|record_id|z_)/.test(k)) : [];
      if (field && !fields.includes(field)) continue;
      items.push({ seq: e.seq, ts: e.ts_server, who: p.account_name || data?.z_Modifier || null,
        action: e.action, table: p.table || null, record_id: p.record_id ?? null, fields, message: p.message || null });
    }
  }
  res.json({ items, mode: recordMode ? "record" : "list", count: items.length });
});

// ---- prefs (what the admin cares about) --------------------------------------

const metaGet = (k) => db.prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v;
const metaSet = (k, v) => db.prepare(
  "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
).run(k, v);

app.get("/api/prefs", (_req, res) => {
  const p = getPrefs(db);
  res.json({ ...p, slack_webhook: mask(p.slack_webhook), alert_webhook: mask(p.alert_webhook) });
});

app.post("/api/prefs", (req, res) => {
  const current = getPrefs(db);
  const b = req.body || {};
  const next = {
    tz_offset: Number.isFinite(Number(b.tz_offset)) ? Number(b.tz_offset) : current.tz_offset,
    business_hours: /^\d{1,2}-\d{1,2}$/.test(b.business_hours || "") ? b.business_hours : current.business_hours,
    business_days: /^\d-\d$/.test(b.business_days || "") ? b.business_days : current.business_days,
    export_rows: Number.isFinite(Number(b.export_rows)) ? Number(b.export_rows) : current.export_rows,
    watch: Array.isArray(b.watch) ? b.watch.map(String).filter(Boolean).slice(0, 50) : current.watch,
    mute: Array.isArray(b.mute) ? b.mute.map(String).filter(Boolean).slice(0, 50) : current.mute,
    // A value ending in the mask ellipsis is the unchanged display value; keep the stored one.
    slack_webhook: keepOrSet(b.slack_webhook, current.slack_webhook),
    alert_webhook: keepOrSet(b.alert_webhook, current.alert_webhook),
  };
  metaSet("prefs", JSON.stringify(next));
  res.json({ ...next, slack_webhook: mask(next.slack_webhook), alert_webhook: mask(next.alert_webhook) });
});

// Never echo full webhook URLs back to the browser.
function mask(u) { return u ? u.slice(0, 30) + "…" : ""; }
function keepOrSet(incoming, current) {
  if (typeof incoming !== "string") return current;
  if (incoming.endsWith("…")) return current; // unchanged masked display value
  return incoming.trim();
}

// Fire a test alert through the configured channels, so the UI's Test button works.
app.post("/api/notify-test", async (_req, res) => {
  const sent = await deliver([{
    system_id: "clio", severity: "info",
    title: "Channels are working",
    detail: "This is a test alert from Clio. If you can read this, delivery is wired up.",
  }], { test: true });
  res.json({ sent });
});

// ---- the pulse ----------------------------------------------------------------
// Cheap when idle: cached until new entries arrive AND the cache is >60s old.

async function buildPulse(total) {
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const perSystem = db.prepare(
    "SELECT system_id, COUNT(*) AS n FROM log_entries WHERE ts_server >= ? GROUP BY system_id ORDER BY n DESC"
  ).all(dayAgo);
  const topActions = db.prepare(
    "SELECT action, COUNT(*) AS n FROM log_entries WHERE ts_server >= ? GROUP BY action ORDER BY n DESC LIMIT 8"
  ).all(dayAgo);
  const trouble = db.prepare(
    `SELECT action, COUNT(*) AS n FROM log_entries WHERE ts_server >= ?
     AND (action LIKE '%error%' OR action LIKE '%fail%' OR action LIKE '%denied%' OR action LIKE '%.deleted')
     GROUP BY action ORDER BY n DESC LIMIT 5`
  ).all(dayAgo);
  const openWarnings = db.prepare("SELECT COUNT(*) AS n FROM warnings WHERE status = 'open'").get().n;
  const stats = {
    events_last_24h: perSystem.reduce((s, r) => s + r.n, 0),
    systems_active_24h: perSystem.map((r) => `${r.system_id} (${r.n})`),
    top_actions: topActions.map((r) => `${r.action} (${r.n})`),
    trouble_shaped: trouble.map((r) => `${r.action} (${r.n})`),
    open_warnings: openWarnings,
  };
  let summary = "";
  if (aiAvailable()) {
    try { summary = await pulseText(stats); } catch {}
  }
  if (!summary) {
    summary = `${stats.events_last_24h} events in the last 24 hours across ` +
      `${perSystem.length} system${perSystem.length === 1 ? "" : "s"}` +
      (trouble.length ? `; trouble-shaped: ${stats.trouble_shaped.join(", ")}` : "; nothing trouble-shaped") +
      `. ${openWarnings} open warning${openWarnings === 1 ? "" : "s"}.`;
  }
  return { summary, stats, generated_at: new Date().toISOString(), total };
}

let pulseBuilding = null;
app.get("/api/pulse", async (_req, res) => {
  try {
    const total = db.prepare("SELECT COUNT(*) AS n FROM log_entries").get().n;
    let cached = null;
    try { cached = JSON.parse(metaGet("pulse") || "null"); } catch {}
    const stale = !cached || (cached.total !== total &&
      Date.now() - Date.parse(cached.generated_at) > 60000);
    if (!stale) return res.json(cached);
    pulseBuilding ||= buildPulse(total).then((p) => {
      metaSet("pulse", JSON.stringify(p));
      pulseBuilding = null;
      return p;
    }).catch((e) => { pulseBuilding = null; throw e; });
    res.json(await pulseBuilding);
  } catch (e) {
    res.status(200).json({ summary: "", error: String(e.message || e) });
  }
});

app.get("/api/warnings", (req, res) => {
  res.json({ warnings: listWarnings(req.query.system_id && String(req.query.system_id), "open") });
});

app.post("/api/warnings/:id/ack", (req, res) => {
  const r = db.prepare("UPDATE warnings SET status = 'acknowledged' WHERE id = ?").run(req.params.id);
  res.json({ acknowledged: Boolean(r.changes) });
});

app.get("/api/verify", (req, res) => {
  const sid = String(req.query.system_id || "");
  if (!sid) return res.status(400).json({ error: "system_id required" });
  const result = verifyRange(db, sid);
  if (!result.valid) selfLog("verify.failed", { system_id: sid, first_bad_seq: result.first_bad_seq });
  res.json(result);
});

app.post("/api/scan", async (req, res) => {
  try {
    res.json(await doScan(Boolean(req.body?.force)));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/ask", async (req, res) => {
  try {
    if (!aiAvailable()) {
      return res.json({ reply: "The AI key isn't set, so I can't answer questions yet. Set ANTHROPIC_API_KEY.", artifacts: [] });
    }
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ error: "messages required" });
    res.json(await askLogs(readHandle(), messages));
  } catch (e) {
    res.status(200).json({ reply: "", error: String(e.message || e) });
  }
});

// ---- error handler ----------------------------------------------------------

app.use((e, req, res, _next) => {
  console.error(JSON.stringify({
    level: "error", request_id: res.locals.requestId, path: req.path,
    message: e?.message, stack: e?.stack,
  }));
  fail(res, 500, "internal", "Internal error");
});

// Restore the saved AI model choice (Settings > AI persists it to meta).
try { const m = metaGet("model"); if (m) setModel(m); } catch {}
// Warm the model list (non-blocking) so Settings opens instantly.
setTimeout(() => { listModels().catch(() => {}); }, 3000);

app.listen(PORT, () => {
  console.log(JSON.stringify({ level: "info", msg: `Clio listening on :${PORT}`, db: DB_PATH, ai: aiAvailable(), model: currentModel() }));
});
