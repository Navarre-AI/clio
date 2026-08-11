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
import { appendBatch, head, verifyRange, entryHash, GENESIS } from "./chain.js";
import { runScan, getPrefs } from "./scan.js";
import { askLogs, aiFindings, aiAvailable, pulseText, authorRule, setModel, setAIConfig, aiConfig, currentModel, MODELS, listModels } from "./ai.js";
import { diffRecords } from "./diff.js";
import { runRules, dryRun, createRule, listRules, updateRule, ruleFirings, ruleMatches, seedDefaultRules } from "./rules.js";
import * as demoSession from "./demo/demosession.js";
import * as demoState from "./demo/demostate.js";
import { liveFor } from "./demo/demolive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);

// DEMO_MODE: the public read-only sandbox (Fly app clio-demo). One canned,
// fictional dataset is baked into the image; the viewer opens straight into it
// with no login and no key minting, and every write-shaped route refuses at the
// route level (see demoReadOnly below) except a short allowlist of the routes
// that make the product demonstrable (rules, warnings, ask), which are served
// from per-visitor session state and never touch the shared dataset.
// No admin token exists in the demo image, so it is forced off rather than
// merely unset. AI is on when (and only when) a key is in the environment, with
// a per-visitor prompt cap and a cheap model.
const DEMO_MODE = process.env.DEMO_MODE === "1";
const DEMO_AI_LIMIT = Number(process.env.DEMO_AI_LIMIT || 10);       // prompts per visitor
const DEMO_AI_HOURLY = Number(process.env.DEMO_AI_HOURLY || 10);     // prompts per hour, ALL visitors
const DEMO_AI_MODEL = process.env.DEMO_AI_MODEL || "claude-sonnet-5"; // Haiku reasons badly over 100k log rows
const DEMO_AI_MAX_TOKENS = Number(process.env.DEMO_AI_MAX_TOKENS || 1000);
const DEMO_AI_MAX_HOPS = Number(process.env.DEMO_AI_MAX_HOPS || 4);
const VIEW_PASSWORD = process.env.VIEW_PASSWORD || "";   // read-only dashboard
const DEMO_LINK = process.env.DEMO_LINK || "https://www.navarre.ai";
// Where the demo's durable state lives (see demo/demostate.js): the AI spend
// counters and the captured questions. A Fly volume in production, DATA_DIR
// locally so a dev run and the test suite need no extra setup. Never the baked
// dataset's business: that file stays read-only and pristine.
const DEMO_STATE_DIR = process.env.DEMO_STATE_DIR || process.env.DATA_DIR || "";
// Reading back what visitors asked. Off unless the secret is set.
const DEMO_QUESTIONS_TOKEN = process.env.DEMO_QUESTIONS_TOKEN || "";

const ADMIN_TOKEN = DEMO_MODE ? "" : (process.env.ADMIN_TOKEN || "");
const SITE_PASSWORD = DEMO_MODE ? "" : (process.env.SITE_PASSWORD || "");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MAX_BATCH = Number(process.env.MAX_BATCH || 500);
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "clio.db");
const db = openDb(DB_PATH);
// The demo's durable side-file. Opened before any route can need it.
if (DEMO_MODE) demoState.open(DEMO_STATE_DIR || DATA_DIR);
let dbRead = null; // opened lazily; the file must exist first
function readHandle() { return (dbRead ||= openDbReadOnly(DB_PATH)); }

// ---- helpers ----------------------------------------------------------------

// AI is on wherever a key is present, demo included: "talk to your logs" is the
// product, so a demo without it is not a demo. What the demo changes is the
// blast radius, not the feature: the key comes from the environment only (never
// baked into the image, never settable through the UI), the model is the cheap
// one, answers are short, hops are few, and each visitor gets DEMO_AI_LIMIT
// prompts (see askQuota). With no key the demo degrades to today's behavior and
// says so honestly.
const aiOn = () => aiAvailable();

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

// clio_in_<24 base62>. Plaintext shown once; sha256 at rest.
//
// The prefix says what the secret is FOR, because Clio has two and they are
// not interchangeable: clio_in_ writes log entries and lives in a FileMaker
// script that any full-access developer can read, while clio_ui_ reads the
// whole dashboard. Pasting one where the other belongs used to be silent.
// Older nk_clio_ keys keep working: nothing validates the prefix, keys are
// matched by hash.
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function generateApiKey() {
  let s = "";
  for (const b of randomBytes(24)) s += B62[b % 62];
  return `clio_in_${s}`;
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
  // Name Clio's own chain the first time it has anything on it. Not at boot: an
  // install's own log starts empty and only becomes a card once a real
  // administrative act has been recorded on it.
  try { db.prepare("INSERT INTO systems (system_id, label) VALUES ('clio', 'Clio (this log server)') ON CONFLICT(system_id) DO NOTHING").run(); } catch {}
  appendBatch(db, "clio", [entry]);
  emit(); // clio's own activity is live too
}

// ---- live push (SSE) + visible rejects --------------------------------------
// One in-process fan-out. Every append pings open EventSource clients so the
// UI updates with zero polling. Clients then pull new rows since their cursor.
const sseClients = new Set();
function emit(ev = "log") { for (const res of sseClients) { try { res.write(`event: ${ev}\ndata: 1\n\n`); } catch {} } }

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

// Whoever holds the dashboard password already controls this Clio: they can
// read every entry, and they own the Fly account it runs on. A second token in
// front of "mint a code" and "purge" therefore defended against nobody, and
// cost every install a third secret to store and a browser prompt to meet
// weeks later. So the site password is sufficient here.
//
// The token still works when set, for scripts and for anyone who wants the
// admin surface reachable without the dashboard.
//
// What this deliberately does NOT do is grant admin to a read-only session:
// see requireWrite. Reading the log and destroying it stay different powers.
function adminAuth(req, res, next) {
  // Check the credential itself, not a flag set by earlier middleware: /v1/
  // paths skip the site gate, so req.isViewer is never set for them.
  if (req.isViewer || hasViewAuth(req)) return fail(res, 403, "read_only", "This is a read-only link.");
  const bySite = SITE_PASSWORD ? hasSiteAuth(req) : false;
  const byToken = ADMIN_TOKEN ? constantTimeEqual(bearer(req), ADMIN_TOKEN) : false;
  if (!bySite && !byToken) {
    if (!ADMIN_TOKEN && !SITE_PASSWORD) {
      return fail(res, 503, "admin_disabled", "Set SITE_PASSWORD (or ADMIN_TOKEN) to use the admin surface.");
    }
    return fail(res, 401, "unauthorized", "Sign in to the dashboard, or send the admin token.");
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
// Standard headers, set before anything can answer. Clio serves one HTML file
// with no external assets, so a strict CSP costs nothing and closes the whole
// injected-script class: log content is untrusted by design (anyone who can
// write a record in a logged file can put text in a payload).
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // A dashboard URL carries its password in ?key=, so it must never leave in a
  // Referer header, and nothing may be embedded from elsewhere.
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(express.json({ limit: "25mb" })); // a Delete All / big Replace arrives as ONE OnWindowTransaction payload

// ---- demo read-only gate ----------------------------------------------------
// The demo's whole claim is that it cannot be written to, so enforcement lives
// here, in front of every route, and not in the UI: it has to hold for someone
// with curl, not just for someone clicking. Two rules, deliberately blunt:
//   1. Only GET/HEAD/OPTIONS get through. That covers ingest (/v1/log, /v1/txn),
//      warning acks, prefs, rules CRUD, scans, AI settings (including setting a
//      key), notify-test, and the whole /api write surface, without depending on
//      a route list that a later commit could forget to update.
//   2. Nothing under /v1/admin at all, whatever the method: key minting,
//      registration, archive, purge, and the admin reads that list keys.
// A new write route added tomorrow is refused by rule 1 on the day it lands.
// The one exception, added deliberately and enumerated exactly: the handful of
// UI routes a visitor must be able to POST for the demo to demonstrate anything
// (toggle/edit/dry-run a rule, dismiss a warning, ask the logs a question).
// Every one of them is implemented against per-session state in DEMO_MODE
// (demo/demosession.js) and writes nothing to the shared database, which is the
// invariant test/demo.test.js checks from the outside. Anything not on this
// list, and anything under /v1/admin, still refuses.
const DEMO_INTERACTIVE = [
  { method: "POST", re: /^\/api\/ask$/ },
  { method: "POST", re: /^\/api\/rules$/ },
  { method: "POST", re: /^\/api\/rules\/dry-run$/ },
  { method: "PATCH", re: /^\/api\/rules\/[^/]+$/ },
  { method: "DELETE", re: /^\/api\/rules\/[^/]+$/ },
  { method: "POST", re: /^\/api\/warnings\/[^/]+\/ack$/ },
  { method: "POST", re: /^\/api\/warnings\/ack-all$/ },
];
const demoInteractive = (req) =>
  req.path !== "/api/rules/author" && // AI rule authoring stays off: not a demo path
  DEMO_INTERACTIVE.some((r) => r.method === req.method && r.re.test(req.path));

const DEMO_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
function demoReadOnly(req, res, next) {
  const isAdminSurface = req.path === "/v1/admin" || req.path.startsWith("/v1/admin/");
  if (isAdminSurface) return demoRefuse(req, res);
  if (DEMO_READ_METHODS.has(req.method) || demoInteractive(req)) return next();
  return demoRefuse(req, res);
}
function demoRefuse(req, res) {
  return res.status(403).json({
    ok: false,
    error: "demo instance is read-only",
    code: "demo_read_only",
    request_id: res.locals.requestId,
  });
}

// Per-visitor identity for the demo's session-scoped state. Server-side only:
// the cookie carries a random id and nothing else, so a visitor cannot hand
// themselves extra AI prompts or another visitor's rules by editing it. HttpOnly
// so page scripts cannot read or forge it either.
function demoSessionMw(req, res, next) {
  const cookies = req.headers.cookie || "";
  let sid = "";
  for (const c of cookies.split(";")) {
    const [k, ...v] = c.trim().split("=");
    if (k === demoSession.COOKIE) { sid = decodeURIComponent(v.join("=")); break; }
  }
  if (!demoSession.validSessionId(sid)) {
    sid = demoSession.newSessionId();
    req.demoNew = true;
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.append("Set-Cookie", `${demoSession.COOKIE}=${sid}; Path=/; Max-Age=21600; SameSite=Lax; HttpOnly${secure}`);
  }
  req.demoSid = sid;
  next();
}
// The session state itself, created lazily so a crawler hitting one GET does not
// allocate a bucket.
const sess = (req) => demoSession.getSession(req.demoSid);

// The visitor's own live trickle (demo/demolive.js): a minute of ambient activity
// that starts when they arrive, chained onto the real head, held in their
// session, merged into reads. Never written to the database.
// A caller that did not present a cookie is not a visitor sitting on the page,
// it is the first request of one (or a crawler): no trickle, so a bare curl sees
// exactly the dataset and nothing else. The stream starts once the browser comes
// back carrying the session it was given.
const live = (req) => (DEMO_MODE && req.demoSid && !req.demoNew ? liveFor(db, sess(req)) : []);
// The same word-start search the log feed does, applied to in-memory rows.
function liveMatches(rows, q) {
  const terms = String(q.q || "").trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const bounds = terms.map((t) => new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const sysList = String(q.systems || "").split(",").filter(Boolean);
  const actions = String(q.actions || "").split(",").filter(Boolean);
  const sid = q.system_id ? String(q.system_id) : "";
  return rows.filter((r) => {
    if (sid && r.system_id !== sid) return false;
    if (sysList.length && !sysList.includes(r.system_id)) return false;
    if (actions.length && !actions.includes(r.action)) return false;
    if (q.since && !(r.ts_server > String(q.since))) return false;
    if (q.from && !(r.ts_server >= String(q.from))) return false;
    if (q.to && !(r.ts_server < String(q.to))) return false;
    if (q.until && !(r.ts_server < String(q.until))) return false;
    if (q.action && r.action !== String(q.action)) return false;
    if (q.category && r.category !== String(q.category)) return false;
    if (q.person || q.actor) {
      let p = {}; try { p = JSON.parse(r.payload_json); } catch {}
      const whoIs = p.account_name || p.data?.z_Modifier || "";
      if (whoIs !== String(q.person || q.actor)) return false;
    }
    if (bounds.length) { const hay = r.action + " " + r.payload_json; if (!bounds.every((re) => re.test(hay))) return false; }
    return true;
  });
}

if (DEMO_MODE) {
  // /health is for uptime checks, not visitors. It was minting a demo session
  // per probe, so a monitor hitting it every minute filled the session map
  // with sessions nobody was in.
  app.use((req, res, next) => (req.path === "/health" ? next() : demoSessionMw(req, res, next)));
  app.use(demoReadOnly);
}

// Password gate for the UI surface only. Machine routes (/v1, /health) use
// Bearer auth and must stay reachable by shippers and FileMaker scripts.
const SITE_COOKIE = `clio_auth=${encodeURIComponent(SITE_PASSWORD || "")}`;
const VIEW_COOKIE = `clio_view=${encodeURIComponent(VIEW_PASSWORD || "")}`;

// A viewer link opens the same dashboard and changes nothing. It exists because
// the people who most need to read a log (an auditor, a manager, a client) are
// exactly the people who should not be able to touch it.
function hasViewAuth(req) {
  if (!VIEW_PASSWORD) return false;
  if (req.query.key === VIEW_PASSWORD) return true;
  return (req.headers.cookie || "").split(";").some((c) => c.trim() === VIEW_COOKIE);
}
// Read-only for a viewer, enforced as a METHOD rule ahead of every route, so a
// write route added next year is refused the day it lands rather than the day
// somebody notices. Same shape the demo has used since it shipped.
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
function viewerReadOnly(req, res, next) {
  if (!req.isViewer) return next();
  if (READ_METHODS.has(req.method)) return next();
  // Ask the logs reads: it is the most persuasive thing in the product, and on
  // the owner's own instance it is their key and their bill.
  if (req.method === "POST" && req.path === "/api/ask") return next();
  return res.status(403).json({
    ok: false,
    error: { code: "read_only", message: "This is a read-only link.", request_id: res.locals.requestId },
  });
}
// Has this request already proved it holds the dashboard password? Same three
// ways the gate below accepts it, so /v1/admin and the UI agree.
function hasSiteAuth(req) {
  if (!SITE_PASSWORD) return false;
  if (req.query.key === SITE_PASSWORD) return true;
  if ((req.headers.cookie || "").split(";").some((c) => c.trim() === SITE_COOKIE)) return true;
  const h = req.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const d = Buffer.from(h.slice(6), "base64").toString("utf8");
    if (d.slice(d.indexOf(":") + 1) === SITE_PASSWORD) return true;
  }
  return false;
}

if (SITE_PASSWORD) {
  const cookieVal = SITE_COOKIE;
  app.use((req, res, next) => {
    if (req.path.startsWith("/v1/") || req.path === "/health") return next();
    // A write-shaped request outside /api/ is not a browser asking for the UI;
    // it is almost always a FileMaker script posting to the wrong URL. Let it
    // through so the catch-all can file it under Unfiled instead of answering
    // 401, which would drop the entry exactly as the old HTML 404 did.
    if ((req.method === "POST" || req.method === "PUT" || req.method === "PATCH")
        && !req.path.startsWith("/api/")) return next();
    if (req.query.key === SITE_PASSWORD) {
      const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      res.setHeader("Set-Cookie", `${cookieVal}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${secure}`);
      return next();
    }
    if (hasViewAuth(req)) {
      if (req.query.key === VIEW_PASSWORD) {
        const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.setHeader("Set-Cookie", `${VIEW_COOKIE}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${secure}`);
      }
      req.isViewer = true;
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
app.use(viewerReadOnly);
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

app.get("/v1/info", (req, res) => {
  res.json(ok({ name: "clio", version: VERSION, ai: aiOn(), demo: DEMO_MODE, viewer: req.isViewer || hasViewAuth(req) }));
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
  trackVocab(systemId, entries);
  emit(); scheduleWatch();
  res.json(ok(echoData(systemId, entries, result, entries.length > 1 ? "batch" : "event")));
}

// ---- connection check --------------------------------------------------------
// "Did I paste the right thing?" answered while the user is still in the
// terminal, or standing in FileMaker with the Test Connection button, instead
// of three days later when nothing has appeared.
//
// GET on purpose: it must never be mistaken for ingest, and it writes NOTHING.
// No entry, no reject row, no database registration. A test that leaves a mark
// would put the shipped Clio.fmp12 on the user's own systems list.
//
// It reports the app it reached as well as the system, because the failure it
// is catching is usually a wrong host or a stale URL, not a bad code.
app.get("/v1/check/:key", (req, res) => {
  const key = String(req.params.key || "");
  const row = key
    ? db.prepare("SELECT system_id, label FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL").get(sha256Hex(key))
    : null;
  const app_host = req.get("host") || "";
  if (!row) {
    return res.status(401).json(errBody("unknown_code",
      `Reached ${app_host}, but that connection code is not valid here. ` +
      "Mint one from the dashboard, or check you pasted the whole URL.",
      res.locals.requestId));
  }
  const sys = db.prepare("SELECT label FROM systems WHERE system_id = ?").get(row.system_id);
  res.json(ok({
    app: app_host,
    system_id: row.system_id,
    system: (sys && sys.label) || row.system_id,
    universal: row.system_id === "universal",
    message: `Connected to ${app_host} (${(sys && sys.label) || row.system_id})`,
  }));
});

app.post("/v1/log", ingestAuth, ingest);
app.post("/v1/log/:key", ingestAuth, ingest); // key-in-URL: unknown key -> Unfiled, never dropped

// OnWindowTransaction ingest: FileMaker POSTs the trigger's parameter
// UNTOUCHED: { "File" : { "Table" : [ [ "Op", recId, contextFieldValue ], ... ] } }.
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

// Shadow vocabulary: every distinct action per system, with counts. Keeps
// History's type filter and the AI's vocabulary instant at any log size.
const upsertVocab = db.prepare(
  `INSERT INTO action_vocab (system_id, action, count) VALUES (?, ?, ?)
   ON CONFLICT(system_id, action) DO UPDATE SET count = count + excluded.count, last_seen = datetime('now')`
);
function trackVocab(systemId, entries) {
  const counts = new Map();
  for (const e of entries) counts.set(e.action || "", (counts.get(e.action || "") || 0) + 1);
  for (const [a, n] of counts) if (a) upsertVocab.run(systemId, a, n);
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
  trackVocab(systemId, entries);
  emit(); scheduleWatch();
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
//   Slack: an incoming-webhook URL; we send Slack's { text } (+ blocks).
//   Webhook: a generic JSON POST for the Comm bus or anything else.
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
      `${SEV_EMOJI[a.severity] || "•"} *${a.system_id}*: ${a.title}\n${a.detail}`).join("\n\n");
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
    aiFindings: aiOn() ? aiFindings : null,
    ruleFindings: (now) => runRules(db, now),
  });
  if (!result.skipped) {
    selfLog("scan.run", { scan_id: result.scan_id, findings: result.findings });
    if (result.findings > 0) emit("warn"); // push new firings so the UI updates live
    pushAlerts(result.scan_id); // deliberately not awaited
  }
  return result;
}

// Auto-watchdog: the scan runs on its own, debounced 20s after arrivals (so a
// burst is judged once), plus an hourly sweep for silence-type rules. No Scan
// button, nothing manual.
let watchTimer = null;
function scheduleWatch() {
  if (DEMO_MODE || watchTimer) return;
  watchTimer = setTimeout(() => { watchTimer = null; doScan(true).catch(() => {}); }, 20000);
}
// The demo's dataset is frozen and its warnings were filed by a real scan when
// it was generated. Re-scanning it can only add "this system went quiet" noise
// (nothing has arrived since the data ends) and burn CPU on 100k rows at every
// boot, so the watchdog stays parked in DEMO_MODE.
if (!DEMO_MODE) setInterval(() => doScan(true).catch(() => {}), 3600000); // hourly, for silence

// ---- rules ------------------------------------------------------------------

function actionVocab() {
  return db.prepare(
    "SELECT system_id, action, count AS n FROM action_vocab ORDER BY n DESC LIMIT 80"
  ).all().map((a) => `${a.system_id} ${a.action} (${a.n})`).join("\n");
}

// The distinct action vocabulary (from the shadow table, instant), for History's
// type filter. Optionally scoped to one or more systems.
app.get("/api/vocab", (req, res) => {
  const sys = String(req.query.system_id || "").split(",").filter(Boolean);
  const where = sys.length ? `WHERE system_id IN (${sys.map(() => "?").join(",")})` : "";
  const rows = db.prepare(
    `SELECT action, SUM(count) AS n FROM action_vocab ${where} GROUP BY action ORDER BY n DESC`
  ).all(...sys);
  res.json({ actions: rows });
});

// Distinct people seen in the log (for the Person filter). Cached: the scan over
// payload JSON is not free at 170k rows, and the set changes slowly.
let actorsCache = { at: 0, rows: [] };
app.get("/api/actors", (_req, res) => {
  if (Date.now() - actorsCache.at > 300000) {
    actorsCache = { at: Date.now(), rows: db.prepare(
      `SELECT COALESCE(json_extract(payload_json,'$.account_name'), json_extract(payload_json,'$.data.z_Modifier')) AS who, COUNT(*) AS n
       FROM log_entries WHERE system_id != 'clio' GROUP BY who HAVING who IS NOT NULL AND who != '' ORDER BY n DESC LIMIT 300`
    ).all() };
  }
  res.json({ actors: actorsCache.rows });
});

// In DEMO_MODE the rule list a visitor sees is the baseline rules with their own
// session's edits layered on top; everywhere else it is just the table.
const parseMatch = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const wouldFire = (m) => { try { return dryRun(db, m, 30).would_fire; } catch { return null; } };

function rulesFor(req) {
  const base = listRules(db);
  return DEMO_MODE ? demoSession.overlayRules(sess(req), base, wouldFire) : base;
}
function ruleFor(req, id) {
  const row = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  const base = row ? { ...row, enabled: !!row.enabled, match: parseMatch(row.match_json) } : null;
  return DEMO_MODE ? demoSession.overlayRule(sess(req), base, id) : base;
}

app.get("/api/rules", (req, res) => res.json({ rules: rulesFor(req) }));

// What a rule has to show when you click it. Two different things, and the demo
// made the difference obvious: `firings` are warnings a scan actually filed for
// this rule, `matches` are the log entries the rule's spec selects right now.
// A rule can legitimately have hundreds of matches and zero firings (nothing has
// scanned since it was written, or its findings were all deduped), and showing
// an empty panel in that case reads as broken.
app.get("/api/rules/:id/firings", (req, res) => {
  const rule = ruleFor(req, req.params.id);
  let matches = [];
  if (rule) { try { matches = ruleMatches(db, rule.match, { days: 30, limit: 25 }); } catch {} }
  res.json({
    firings: ruleFirings(db, req.params.id),
    matches,
    match_window_days: 30,
    silence: Boolean(rule?.match?.silence),
  });
});

app.post("/api/rules", (req, res) => {
  const r = req.body || {};
  if (!r.name || !r.match) return res.status(400).json({ error: "name and match required" });
  if (DEMO_MODE) {
    const rule = demoSession.createRule(sess(req), r);
    return res.json({ ...rule, would_fire_30d: wouldFire(rule.match), demo_session_only: true });
  }
  res.json(createRule(db, r));
});

app.patch("/api/rules/:id", (req, res) => {
  if (DEMO_MODE) {
    const base = ruleFor(req, req.params.id);
    if (!base) return res.status(404).json({ error: "no such rule" });
    demoSession.patchRule(sess(req), req.params.id, req.body || {}, base.match);
    const rule = ruleFor(req, req.params.id);
    return res.json({ ok: true, rule, demo_session_only: true });
  }
  const body = { ...req.body };
  if (body.match_patch !== undefined) { // merge a partial into the existing match (e.g. just the files scope)
    const cur = parseMatch(db.prepare("SELECT match_json FROM rules WHERE id = ?").get(req.params.id)?.match_json);
    body.match = { ...cur, ...body.match_patch };
  }
  const rule = updateRule(db, req.params.id, body);
  if (!rule) return res.status(404).json({ error: "no such rule" });
  res.json({ ok: true, rule: { ...rule, enabled: !!rule.enabled } });
});

app.delete("/api/rules/:id", (req, res) => {
  if (DEMO_MODE) { demoSession.deleteRule(sess(req), req.params.id); return res.json({ ok: true, demo_session_only: true }); }
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
    if (!aiOn()) return res.json({ reply: "Set an Anthropic API key to author rules by chat. You can still add them by hand.", draft: null });
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

app.get("/api/ai", async (req, res) => {
  const { models, fallback } = await listModels();
  const cfg = aiConfig();
  const body = { available: aiOn(), demo: DEMO_MODE, model: currentModel(), models, fallback,
    thinking: cfg.thinking, speed: cfg.speed, key_set: cfg.key_override };
  if (DEMO_MODE) {
    body.prompts_used = demoAiUsed(req);
    body.prompts_limit = DEMO_AI_LIMIT;
    body.link = DEMO_LINK;
  }
  res.json(body);
});

app.post("/api/ai", async (req, res) => {
  const b = req.body || {};
  if (b.model !== undefined) {
    const m = String(b.model || "");
    const { models } = await listModels();
    if (!m || !(models.some((x) => x.id === m) || MODELS.some((x) => x.id === m)))
      return res.status(400).json({ error: "unknown model" });
    setModel(m); metaSet("model", m);
  }
  if (b.thinking !== undefined) { setAIConfig({ thinking: String(b.thinking || "") }); metaSet("ai_thinking", String(b.thinking || "")); }
  if (b.speed !== undefined) { setAIConfig({ speed: String(b.speed || "") }); metaSet("ai_speed", String(b.speed || "")); }
  if (b.api_key !== undefined && String(b.api_key).trim() !== "") { // blank = keep current key
    setAIConfig({ api_key: String(b.api_key).trim() }); metaSet("ai_key", String(b.api_key).trim());
  }
  res.json({ ok: true, model: currentModel(), ...aiConfig() });
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

// Purge: deletes ALL of a system's rows (including any archive tombstone) and its
// file registrations; the next entry starts a fresh chain from genesis. If you want
// provable pre-purge history, call archive first and keep its export. Admin-gated;
// irreversible.
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
  const openRows = db.prepare("SELECT id, system_id FROM warnings WHERE status = 'open'").all();
  const acked = DEMO_MODE ? sess(req).warningAcked : null; // this visitor's own dismissals
  const openCounts = {};
  for (const r of openRows) {
    if (acked && acked.has(r.id)) continue;
    openCounts[r.system_id] = (openCounts[r.system_id] || 0) + 1;
  }
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const todayCounts = Object.fromEntries(
    db.prepare("SELECT system_id, COUNT(*) AS n FROM log_entries WHERE COALESCE(NULLIF(ts_client,''), ts_server) >= ? GROUP BY system_id").all(dayAgo)
      .map((r) => [r.system_id, r.n]));
  // A file displays under its link target (system_display) if set, otherwise its own
  // system. Linked files keep their own chain but show under the target as a group.
  const dbsByHome = {}; const linkedChildren = {};
  for (const d of db.prepare("SELECT * FROM databases").all()) {
    const home = d.system_display || d.system_id;
    (dbsByHome[home] ||= []).push(d);
    if (d.system_display && d.system_display !== d.system_id) (linkedChildren[d.system_display] ||= new Set()).add(d.system_id);
  }
  const systems = ids
    .filter((sid) => showHidden || (reg[sid]?.display ?? 1))
    .map((sid) => {
      const base = head(db, sid);
      let entry_count = base.entry_count || 0, today = todayCounts[sid] || 0, last = base.last_ts_server || null;
      for (const c of (linkedChildren[sid] || [])) { // fold linked files' separate chains into the group's totals
        const h = head(db, c); entry_count += h.entry_count || 0; today += todayCounts[c] || 0;
        if (h.last_ts_server && (!last || h.last_ts_server > last)) last = h.last_ts_server;
      }
      return {
        ...base, entry_count, last_ts_server: last,
        display: reg[sid]?.display ?? 1,
        today, open_warnings: openCounts[sid] || 0,
        label: reg[sid]?.label || null,
        fm_server: reg[sid]?.fm_server || null,
        tz_offset: reg[sid]?.tz_offset ?? null,
        databases: (dbsByHome[sid] || []).map((d) => ({
          file_name: d.file_name, name: d.friendly_name || d.file_name,
          entry_count: d.entry_count, placed: !!d.placed, last_seen: d.last_seen,
          system_id: d.system_id, linked: !!(d.system_display && d.system_display !== d.system_id),
        })),
      };
    })
    // Unfiled is the catch-all safety net: only worth showing once something has landed
    // in it. Empty = nothing was dropped, so don't clutter the list with it.
    .filter((s) => !(s.system_id === "unfiled" && (s.entry_count || 0) === 0));
  // Fold the visitor's live trickle into the cards, so the counters tick up
  // while they watch instead of the page quietly disagreeing with the feed.
  if (DEMO_MODE) {
    for (const r of live(req)) {
      const s = systems.find((x) => x.system_id === r.system_id);
      if (!s) continue;
      s.entry_count = (s.entry_count || 0) + 1;
      s.today = (s.today || 0) + 1;
      s.seq = Math.max(s.seq || 0, r.seq);
      if (!s.last_ts_server || r.ts_server > s.last_ts_server) s.last_ts_server = r.ts_server;
    }
  }
  systems.sort((a, b) => (a.label || a.system_id).localeCompare(b.label || b.system_id));
  // Unplaced files (any system) drive the new-database wizard.
  const unplaced = db.prepare("SELECT system_id, file_name, entry_count, last_seen FROM databases WHERE placed = 0 ORDER BY last_seen DESC").all();
  res.json({ systems, ai: aiOn(), demo: DEMO_MODE, version: VERSION, unplaced,
    viewer: !!req.isViewer,
    ...(DEMO_MODE ? { demo_ai: { limit: DEMO_AI_LIMIT, used: demoAiUsed(req), link: DEMO_LINK } } : {}),
    tagline: "FileMaker logging for the AI Age." });
});

// One truth for "how many entries", counted in one pass over the log.
//
// A system card and that system's own detail panel used to disagree, because
// they were reading two different things that were both called "entries": the
// card showed the chain (every entry under that system id), while each file's
// row showed databases.entry_count, a running counter maintained at ingest that
// only ever counts entries whose payload names a file. Record changes from the
// OnWindowTransaction script carry a file; event-shaped entries from the plain
// Clio Log script (logins, script errors, exports) do not. So the file numbers
// were legitimately smaller than the chain, with nothing on screen to say why,
// and any drift between the counter and the log had nowhere to show up.
//
// Now both come from log_entries, so the files plus the remainder always add up
// to the total the card shows. Linked files' separate chains fold in exactly as
// they do on the card.
function systemCounts(req, sid) {
  const kids = db.prepare("SELECT DISTINCT system_id FROM databases WHERE system_display = ? AND system_id != ?").all(sid, sid).map((r) => r.system_id);
  const ids = [sid, ...kids];
  const rows = db.prepare(
    `SELECT system_id, json_extract(payload_json, '$.file') AS file, COUNT(*) AS n
       FROM log_entries WHERE system_id IN (${ids.map(() => "?").join(",")})
      GROUP BY system_id, file`
  ).all(...ids);
  const files = {}; let other = 0, total = 0;
  const add = (system_id, file, n) => {
    total += n;
    if (file) files[`${system_id}|${file}`] = (files[`${system_id}|${file}`] || 0) + n;
    else other += n;
  };
  for (const r of rows) add(r.system_id, r.file, r.n);
  // The visitor's own live trickle counts on the card, so it counts here too.
  for (const r of live(req)) {
    if (!ids.includes(r.system_id)) continue;
    let p = {}; try { p = JSON.parse(r.payload_json); } catch {}
    add(r.system_id, p.file || null, 1);
  }
  return { system_id: sid, total, files, other };
}

app.get("/api/system-counts", (req, res) => {
  const sid = String(req.query.system_id || "");
  if (!sid) return res.status(400).json({ error: "system_id required" });
  res.json(systemCounts(req, sid));
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
  res.json({ rejects: db.prepare("SELECT * FROM rejects WHERE ack IS NULL ORDER BY ts DESC LIMIT 50").all() });
});
// Acknowledge the visible rejects (clears the red Live banner). Pass an id to ack
// just one, or nothing to ack them all. The rows stay for the record, just hidden.
app.post("/api/rejects/ack", (req, res) => {
  const id = req.body?.id;
  const r = id
    ? db.prepare("UPDATE rejects SET ack = datetime('now') WHERE id = ? AND ack IS NULL").run(id)
    : db.prepare("UPDATE rejects SET ack = datetime('now') WHERE ack IS NULL").run();
  res.json({ ok: true, acknowledged: r.changes });
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
    const dest = String(target || system_id);
    db.prepare("UPDATE databases SET placed = 1, system_display = ?, friendly_name = COALESCE(?, friendly_name) WHERE system_id = ? AND file_name = ?")
      .run(dest, name || null, system_id, file_name);
    // Hide the file's own auto-created system so it doesn't also show as a duplicate card;
    // its file + activity now display under the destination system (chains stay separate).
    // Ensure the row exists first: a universal-key-routed system has no systems row yet.
    if (dest !== system_id) { upsertSystem(system_id, {}); db.prepare("UPDATE systems SET display = 0 WHERE system_id = ?").run(system_id); }
    return res.json({ ok: true });
  }
  // own: this file already logs to its own system (routed by name via the universal
  // key). Just confirm it: name it, show it, mark placed. No per-file key or URL.
  // An existing label wins: if the admin already renamed this system, the wizard's
  // default (the file name) must not clobber it.
  upsertSystem(system_id, {});
  db.prepare("UPDATE systems SET label = COALESCE(label, ?), display = 1 WHERE system_id = ?")
    .run(name || file_name, system_id);
  db.prepare("UPDATE databases SET placed = 1, system_display = ?, friendly_name = COALESCE(?, friendly_name) WHERE system_id = ? AND file_name = ?")
    .run(system_id, name || file_name, system_id, file_name);
  selfLog("admin.system_confirmed", { system_id, from_file: file_name });
  res.json({ ok: true, system_id });
});
app.post("/api/databases/unlink", (req, res) => {
  const { system_id, file_name } = req.body || {};
  db.prepare("UPDATE databases SET placed = 0, system_display = NULL WHERE system_id = ? AND file_name = ?").run(system_id, file_name);
  // Bring the file's own system back into view (it was hidden when linked).
  db.prepare("UPDATE systems SET display = 1 WHERE system_id = ?").run(system_id);
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
// Rows from the visitor's live trickle that belong in this query, newest first.
// They are always the newest entries there are, so they go on the front.
function liveRows(req) {
  if (!DEMO_MODE) return [];
  const rows = liveMatches(live(req), req.query);
  return rows.slice().sort((a, b) => (a.ts_server < b.ts_server ? 1 : -1))
    .map(({ prev_hash, entry_hash, event_id, ...r }) => r);
}

app.get("/api/logs", (req, res) => {
  const sid = String(req.query.system_id || "");
  if (sid && !req.query.q) {
    const out = queryLogs(sid, req.query);
    if (DEMO_MODE && !req.query.after_seq) out.entries = [...liveRows(req), ...out.entries];
    return res.json(out);
  }
  const where = []; const params = [];
  if (sid) { where.push("system_id = ?"); params.push(sid); }
  // Multi-select systems filter. With no explicit selection, Clio's own internal
  // log stays out of the way; pick the clio system to see it.
  const sysList = String(req.query.systems || "").split(",").filter(Boolean);
  if (sysList.length) { where.push(`system_id IN (${sysList.map(() => "?").join(",")})`); params.push(...sysList); }
  else if (!sid) where.push("system_id != 'clio'");
  if (req.query.person) {
    where.push("COALESCE(json_extract(payload_json,'$.account_name'), json_extract(payload_json,'$.data.z_Modifier')) = ?");
    params.push(String(req.query.person));
  }
  // Event-time range (from/to use real event time; `since` stays ts_server for tail polling)
  const EVT = "COALESCE(NULLIF(ts_client,''), ts_server)";
  if (req.query.from) { where.push(`${EVT} >= ?`); params.push(String(req.query.from)); }
  if (req.query.to) { where.push(`${EVT} < ?`); params.push(String(req.query.to)); }
  if (req.query.since) { where.push("ts_server > ?"); params.push(String(req.query.since)); }
  // Search: FileMaker Find semantics. Each term must match at the START of a word,
  // and multiple terms AND together. SQL LIKE narrows the candidates cheaply; the
  // word-boundary test happens here, where \b actually exists.
  const terms = String(req.query.q || "").trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  for (const t of terms) {
    where.push("(LOWER(payload_json) LIKE ? OR LOWER(action) LIKE ?)");
    params.push(`%${t}%`, `%${t}%`);
  }
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  let sql = `SELECT system_id, seq, ts_client, ts_server, category, action, payload_json
     FROM log_entries ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ts_server DESC, system_id, seq DESC`;
  let rows;
  if (terms.length) {
    // Over-fetch, then enforce word-start (\b) per term; page after the boundary test.
    const boundary = terms.map((t) => new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    const candidates = db.prepare(sql + ` LIMIT ${Math.min((offset + limit) * 4 + 200, 5000)}`).all(...params);
    rows = candidates.filter((r) => { const hay = r.action + " " + r.payload_json; return boundary.every((re) => re.test(hay)); })
      .slice(offset, offset + limit);
  } else {
    rows = db.prepare(sql + ` LIMIT ${limit} OFFSET ${offset}`).all(...params);
  }
  // The trickle is newer than anything in the database, so it rides on the front
  // of the first page (and of every tail poll), and never disturbs paging.
  if (DEMO_MODE && !offset) rows = [...liveRows(req), ...rows].slice(0, limit + 20);
  res.json({ entries: rows, latest_ts: rows.length && !offset ? rows[0].ts_server : (req.query.since || null) });
});

// History, computed at read time from the raw log. Two modes:
//   record mode (table + record_id): the full before->after timeline for one
//     record, derived by walking its entries oldest-first and tracking the last
//     value per field (works for lean "only-changed" and fat "full-record").
//   list mode: cross-dimensional filter (actor, table, field, date, value) ->
//     matching changes, newest first. No precomputation, pure SQL + a walk.
// Bookkeeping fields change on every commit and say nothing but "an edit happened".
// They stay in the raw payload; they just don't get paraded in change lists.
function isHousekeeping(f) {
  return /^z_|^(modif|creat)/i.test(f) || /(_|\b)(ts|time|timestamp|date)$/i.test(f);
}

app.get("/api/history", (req, res) => {
  const q = req.query;
  const where = []; const params = [];
  // one system, or a multi-select list, or (nothing) = all
  if (q.system_id) { where.push("system_id = ?"); params.push(String(q.system_id)); }
  else if (q.systems) { const list = String(q.systems).split(",").filter(Boolean); if (list.length) { where.push(`system_id IN (${list.map(() => "?").join(",")})`); params.push(...list); } }
  if (q.table) { where.push("json_extract(payload_json,'$.table') = ?"); params.push(String(q.table)); }
  if (q.record_id) { where.push("json_extract(payload_json,'$.record_id') = ?"); params.push(Number(q.record_id)); }
  if (q.actor) { where.push("(json_extract(payload_json,'$.account_name') = ? OR json_extract(payload_json,'$.data.z_Modifier') = ?)"); params.push(String(q.actor), String(q.actor)); }
  if (q.actions) { const list = String(q.actions).split(",").filter(Boolean); if (list.length) { where.push(`action IN (${list.map(() => "?").join(",")})`); params.push(...list); } }
  // event time = client stamp when present, else arrival (old rows have blank ts_client)
  const TS = "COALESCE(NULLIF(ts_client,''), ts_server)";
  if (q.since) { where.push(`${TS} >= ?`); params.push(String(q.since)); }
  if (q.until) { where.push(`${TS} < ?`); params.push(String(q.until)); }
  if (q.q) { where.push("payload_json LIKE ?"); params.push(`%${q.q}%`); }
  const recordMode = Boolean(q.record_id && q.table);
  const field = q.field ? String(q.field) : null;
  const limit = Math.min(Number(q.limit) || 300, 2000);
  const rows = db.prepare(
    `SELECT seq, system_id, ${TS} AS ts, action, payload_json FROM log_entries
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq ${recordMode ? "ASC" : "DESC"} LIMIT ${limit}`
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
      const shown = field ? changes.filter((c) => c.field === field) : changes.filter((c) => !isHousekeeping(c.field));
      // Record mode is "this record's history": every logged event for the
      // record belongs in it, whether or not a field-level diff can be computed.
      // The FIRST entry for a record never has a diff (there is nothing before
      // it to compare against), and a delete or a no-op edit may not either;
      // dropping those made the timeline of any record whose earliest logged
      // event was an edit come back empty, which reads as broken. With a field
      // filter, only entries touching that field are wanted, so that still
      // filters.
      if (shown.length || !field) items.push({ seq: e.seq, system_id: e.system_id, ts: e.ts, who, action: e.action, changes: shown });
    }
    items.reverse(); // newest first for display
  } else {
    for (const e of rows) {
      const p = parse(e.payload_json);
      const data = p.data && typeof p.data === "object" ? p.data : null;
      const fields = data ? Object.keys(data).filter((k) => !/^(id|record_id)/.test(k) && !isHousekeeping(k)) : [];
      if (field && !fields.includes(field)) continue;
      items.push({ seq: e.seq, system_id: e.system_id, ts: e.ts, who: p.account_name || data?.z_Modifier || null,
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
    "SELECT system_id, COUNT(*) AS n FROM log_entries WHERE COALESCE(NULLIF(ts_client,''), ts_server) >= ? GROUP BY system_id ORDER BY n DESC"
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
  // The demo spends its AI budget on the thing visitors came for (asking the
  // logs) and on warning wording. The pulse uses the deterministic sentence.
  if (aiOn() && !DEMO_MODE) {
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
  const sys = req.query.system_id && String(req.query.system_id);
  // status=all → open + acknowledged (for "show acknowledged"); default open only
  const wantAll = req.query.status === "all";
  const status = wantAll ? null : (req.query.status ? String(req.query.status) : "open");
  let warnings = listWarnings(sys, DEMO_MODE ? null : status);
  if (DEMO_MODE) {
    // A visitor's dismissals live in their session, so the stored row still says
    // "open" and the next visitor sees the demo intact. Apply the overlay here,
    // then honor the status filter the client asked for.
    const acked = sess(req).warningAcked;
    warnings = warnings.map((w) => (acked.has(w.id) ? { ...w, status: "acknowledged" } : w));
    if (status) warnings = warnings.filter((w) => w.status === status);
  }
  res.json({ warnings });
});

app.post("/api/warnings/:id/ack", (req, res) => {
  if (DEMO_MODE) {
    const exists = db.prepare("SELECT 1 AS x FROM warnings WHERE id = ?").get(req.params.id);
    if (exists) sess(req).warningAcked.add(req.params.id);
    return res.json({ acknowledged: Boolean(exists), demo_session_only: true });
  }
  const r = db.prepare("UPDATE warnings SET status = 'acknowledged' WHERE id = ?").run(req.params.id);
  res.json({ acknowledged: Boolean(r.changes) });
});
// Acknowledge every open warning at once (optionally scoped to one system).
app.post("/api/warnings/ack-all", (req, res) => {
  const sys = req.body?.system_id;
  if (DEMO_MODE) {
    const s = sess(req);
    const rows = sys
      ? db.prepare("SELECT id FROM warnings WHERE status = 'open' AND system_id = ?").all(String(sys))
      : db.prepare("SELECT id FROM warnings WHERE status = 'open'").all();
    let n = 0;
    for (const r of rows) if (!s.warningAcked.has(r.id)) { s.warningAcked.add(r.id); n++; }
    return res.json({ ok: true, acknowledged: n, demo_session_only: true });
  }
  const r = sys
    ? db.prepare("UPDATE warnings SET status = 'acknowledged' WHERE status = 'open' AND system_id = ?").run(String(sys))
    : db.prepare("UPDATE warnings SET status = 'acknowledged' WHERE status = 'open'").run();
  res.json({ ok: true, acknowledged: r.changes });
});
// One log entry's full detail (for the History row detail modal).
app.get("/api/entry", (req, res) => {
  const sys = String(req.query.system_id || ""); const seq = Number(req.query.seq);
  if (!sys || !Number.isFinite(seq)) return res.status(400).json({ error: "system_id and seq required" });
  let e = db.prepare("SELECT seq, system_id, ts_client, ts_server, category, action, payload_json FROM log_entries WHERE system_id = ? AND seq = ?").get(sys, seq);
  if (!e && DEMO_MODE) {
    const r = live(req).find((x) => x.system_id === sys && x.seq === seq);
    if (r) { const { prev_hash, entry_hash, event_id, ...rest } = r; e = rest; }
  }
  res.json({ entry: e || null });
});

app.get("/api/verify", (req, res) => {
  const sid = String(req.query.system_id || "");
  if (!sid) return res.status(400).json({ error: "system_id required" });
  const result = verifyRange(db, sid);
  // The live trickle is part of the chain, not decoration: continue the walk
  // over the visitor's own entries and recompute their hashes the same way. If
  // this ever disagreed, the demo would be claiming something it cannot show.
  if (DEMO_MODE && result.valid) {
    let prev = result.head.entry_hash || GENESIS;
    let seq = result.head.seq;
    for (const r of live(req).filter((x) => x.system_id === sid)) {
      if (r.seq !== seq + 1 || r.prev_hash !== prev || entryHash(prev, r) !== r.entry_hash) {
        result.valid = false; result.first_bad_seq = r.seq; break;
      }
      seq = r.seq; prev = r.entry_hash; result.checked++;
      result.head = { seq, entry_hash: prev };
    }
  }
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

// Two caps, both counted server-side and both spent BEFORE the model call, so
// no prompt is free because a visitor aborted the request or edited something
// the browser can reach.
//
//   per visitor  DEMO_AI_LIMIT prompts against the session cookie. Bypassable by
//                clearing the cookie, so it protects the experience, not the bill.
//   per hour     DEMO_AI_HOURLY prompts across ALL visitors, sliding window.
//                This one protects the bill, and nothing a visitor can do
//                touches it.
//
// Both counts come from the durable questions table (demo/demostate.js), NOT
// from process memory: they used to be a field on an in-memory session and an
// in-process array, which meant every deploy or machine restart handed every
// visitor a fresh allowance and set the hourly ceiling back to zero.
const demoAiUsed = (req) => (DEMO_MODE ? demoState.sessionUsed(req.demoSid || "") : 0);

function hourlyQuota() {
  const h = demoState.hourly();
  if (h.count >= DEMO_AI_HOURLY) {
    // Minutes until the oldest spend in the window ages out. With the cap set
    // to 0 (AI off by configuration) there is no oldest spend, so say an hour
    // rather than NaN.
    const oldest = h.oldest ?? Date.now();
    return { ok: false, waitMin: Math.max(1, Math.ceil((oldest + 3600_000 - Date.now()) / 60_000)) };
  }
  return { ok: true };
}

// Spends a prompt if both caps allow it, and records the question either way:
// a refused question is still a question somebody wanted to ask.
function askQuota(req, question) {
  if (!DEMO_MODE) return { ok: true };
  const sid = req.demoSid || "";
  const ip_hash = demoState.ipHash(req.ip);
  const used = demoState.sessionUsed(sid);
  if (used >= DEMO_AI_LIMIT) {
    demoState.record({ session_id: sid, ip_hash, question, spent: 0, outcome: "out_of_prompts", session_used: used });
    return { ok: false, used, limit: DEMO_AI_LIMIT };
  }
  const global = hourlyQuota();
  if (!global.ok) {
    demoState.record({ session_id: sid, ip_hash, question, spent: 0, outcome: "hourly_cap", session_used: used });
    return { ok: false, used, limit: DEMO_AI_LIMIT, busy: true, waitMin: global.waitMin };
  }
  const id = demoState.record({ session_id: sid, ip_hash, question, spent: 1, outcome: "pending", session_used: used + 1 });
  return { ok: true, used: used + 1, limit: DEMO_AI_LIMIT, askId: id };
}

const finishAsk = (quota, fields) => { if (DEMO_MODE && quota.askId) demoState.finish(quota.askId, fields); };

// The last thing in the message list is what the visitor just typed.
const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return String(messages[i].content || "");
  return "";
};

app.post("/api/ask", async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!aiOn()) {
      if (DEMO_MODE && messages.length) {
        demoState.record({ session_id: req.demoSid || "", ip_hash: demoState.ipHash(req.ip),
          question: lastUserText(messages), spent: 0, outcome: "ai_off", session_used: demoAiUsed(req) });
      }
      return res.json({
        reply: DEMO_MODE
          ? "Ask the logs is unavailable right now: this demo runs on a spend-capped API key and one is not configured at the moment. Everything else here is live."
          : "The AI key isn't set, so I can't answer questions yet. Set ANTHROPIC_API_KEY.",
        artifacts: [],
      });
    }
    if (!messages.length) return res.status(400).json({ error: "messages required" });
    const quota = askQuota(req, lastUserText(messages));
    if (!quota.ok) {
      // Two different refusals: this visitor is out, or the whole demo is
      // out for the hour. Say which, so nobody thinks they broke it.
      const reply = quota.busy
        ? `The demo has hit its hourly question limit (it runs on Matt's bill). Try again in about ${quota.waitMin} ${quota.waitMin === 1 ? "minute" : "minutes"}. The full Clio has no cap: it answers from your own logs, on your own server. ${DEMO_LINK}`
        : `That's all ${quota.limit} questions for this demo session. The full Clio has no cap: it answers from your own logs, on your own server. ${DEMO_LINK}`;
      return res.json({
        reply, artifacts: [], quota_exhausted: !quota.busy, demo_busy: !!quota.busy,
        wait_min: quota.waitMin || null,
        prompts_used: quota.used, prompts_limit: quota.limit,
      });
    }
    // The prompt is spent whether or not the model answers, so the counters ride
    // on the failure path too: a visitor must never see "0 used" after a call
    // that was, in fact, charged against their allowance.
    const counters = DEMO_MODE ? { prompts_used: quota.used, prompts_limit: quota.limit } : {};
    const t0 = Date.now();
    try {
      const out = await askLogs(readHandle(), messages);
      finishAsk(quota, { outcome: "answered", ms: Date.now() - t0 });
      res.json({ ...out, ...counters });
    } catch (e) {
      finishAsk(quota, { outcome: "error", ms: Date.now() - t0, error: e.message || e });
      res.status(200).json({ reply: "", error: String(e.message || e), ...counters });
    }
  } catch (e) {
    res.status(200).json({ reply: "", error: String(e.message || e) });
  }
});

// Reading back what visitors asked the demo. Matt's own server, Matt's own
// questions log: it exists so he can see what people actually want from their
// logs. Registered only in DEMO_MODE, and only when the token secret is set, so
// a self-hosted Clio has no such route at all.
//
//   curl -s -H "Authorization: Bearer $DEMO_QUESTIONS_TOKEN" \
//     https://<your-demo-app>.fly.dev/api/demo/questions | jq
if (DEMO_MODE && DEMO_QUESTIONS_TOKEN) {
  app.get("/api/demo/questions", (req, res) => {
    if (!constantTimeEqual(bearer(req), DEMO_QUESTIONS_TOKEN)) {
      return fail(res, 401, "unauthorized", "Bearer DEMO_QUESTIONS_TOKEN required.");
    }
    res.json({ ...demoState.stats(), questions: demoState.recent(req.query.limit) });
  });
}

// ---- error handler ----------------------------------------------------------

app.use((e, req, res, _next) => {
  console.error(JSON.stringify({
    level: "error", request_id: res.locals.requestId, path: req.path,
    message: e?.message, stack: e?.stack,
  }));
  fail(res, 500, "internal", "Internal error");
});

// Restore the saved AI model choice (Settings > AI persists it to meta).
// Skipped entirely in the demo: a key stored in a database is still a key, and
// the demo must not be able to acquire one from anywhere.
if (!DEMO_MODE) {
  try { const m = metaGet("model"); if (m) setModel(m); } catch {}
  try { setAIConfig({ api_key: metaGet("ai_key") || undefined, thinking: metaGet("ai_thinking") ?? undefined, speed: metaGet("ai_speed") ?? undefined }); } catch {}
  // Warm the model list (non-blocking) so Settings opens instantly.
  setTimeout(() => { listModels().catch(() => {}); }, 3000);
} else {
  // Demo AI policy, fixed at boot and unreachable from any route: the cheapest
  // current model, short answers, few hops, no thinking, no fast mode, and the
  // key strictly from the environment (a key stored in the database is still a
  // key, so the demo never reads or writes one).
  setModel(DEMO_AI_MODEL);
  // "off" explicitly: an empty string falls through to thinking ENABLED with a
  // 6000-token budget and an 8000 max_tokens floor, which silently overrode the
  // spend caps below. The comment above always said no thinking; now it is true.
  setAIConfig({ thinking: "off", speed: "", max_tokens: DEMO_AI_MAX_TOKENS, max_hops: DEMO_AI_MAX_HOPS });
}
// Seed sensible default rules on a fresh install (day one is useful).
try { seedDefaultRules(db); } catch {}
// Backfill the vocabulary shadow table once, so History's type filter works
// for logs that predate it.
try {
  if (db.prepare("SELECT COUNT(*) n FROM action_vocab").get().n === 0) {
    db.prepare("INSERT INTO action_vocab (system_id, action, count) SELECT system_id, action, COUNT(*) FROM log_entries GROUP BY system_id, action").run();
  }
} catch {}

// ---- catch-all ---------------------------------------------------------------
// Never drop a log entry because the URL was wrong.
//
// /v1/log files an unknown or missing key under "Unfiled" rather than bouncing
// it. That protection only ever applied once a request REACHED /v1/log. A post
// to any other path fell through to Express's default handler, which answers
// with an HTML 404, so the entry was discarded without a trace: no entry, no
// reject row, nothing in the UI. And the likeliest mistake of all is pasting
// the dashboard URL instead of the ingest endpoint, which lands on "/".
//
// So: anything POST-shaped that carries a body we can read is treated as a log
// entry that arrived at the wrong door. It is filed, and the reply says in
// JSON (never HTML, because a FileMaker caller has to parse it) where the door
// actually is.
app.use((req, res, next) => {
  if (res.headersSent) return next();
  const writeish = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
  if (!writeish) return next();
  if (req.path.startsWith("/api/")) return next();   // UI surface answers for itself

  const correct = publicUrl(req, "/v1/log/<your connection code>");
  const body = req.body;
  const hasBody = body && typeof body === "object" && Object.keys(body).length > 0;

  if (!hasBody) {
    return res.status(404).json(errBody("wrong_endpoint",
      `Nothing to log here. The ingest endpoint is ${correct}`, res.locals.requestId));
  }
  try {
    ensureUnfiled();
    // Last resort matters most here. normalizeBody wants an action or a
    // category; a payload missing both is exactly the confused post this
    // rescue exists for, and discarding it would repeat the bug. So anything
    // JSON-shaped that reached the wrong door is kept verbatim under a
    // generic action, and the operator can see what actually arrived.
    const entries = looksLikeTxn(body) ? normalizeTxn(body, "unfiled")
      : (normalizeBody(body) || [{
          event_id: typeof body.event_id === "string" ? body.event_id : undefined,
          ts_client: typeof body.ts_client === "string" ? body.ts_client : undefined,
          category: "unfiled.wrong_endpoint",
          action: "unfiled.wrong_endpoint.received",
          payload_json: body,
        }]);
    if (entries && entries.length) {
      const r = appendBatch(db, "unfiled", entries);
      trackFiles("unfiled", entries);
      trackVocab("unfiled", entries);
      emit();
      recordReject("unfiled", "wrong_endpoint",
        `Posted to ${req.method} ${req.path}; filed under Unfiled`, JSON.stringify(body).slice(0, 400));
      return res.status(404).json({
        ok: false,
        error: { code: "wrong_endpoint",
          message: `Saved under Unfiled so nothing was lost, but this is the wrong URL. Post to ${correct}`,
          request_id: res.locals.requestId },
        data: { accepted: r.accepted, system_id: "unfiled", head: r.head },
      });
    }
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "wrong-endpoint rescue failed", error: String(e.message || e) }));
  }
  return res.status(404).json(errBody("wrong_endpoint",
    `Wrong URL, and the body was not log-shaped. The ingest endpoint is ${correct}`, res.locals.requestId));
});

const server = app.listen(PORT, () => {
  console.log(JSON.stringify({ level: "info", msg: `Clio listening on :${PORT}`, db: DB_PATH, ai: aiOn(), model: currentModel() }));
});

// Graceful shutdown: stop accepting, finish in-flight requests, close the DB
// cleanly so WAL checkpoints. A kill mid-append can't corrupt the chain (SQLite
// transactions see to that), but a clean close keeps restarts instant.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref(); // don't hang the deploy
});
