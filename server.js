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
import { runScan } from "./scan.js";
import { askLogs, aiFindings, aiAvailable } from "./ai.js";

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
}

// ---- auth middlewares -------------------------------------------------------

function keyAuth(req, res, next) {
  const key = bearer(req);
  if (!key) return fail(res, 401, "unauthorized", "Bearer API key required.");
  const row = db.prepare(
    "SELECT id, system_id, label FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL"
  ).get(sha256Hex(key));
  if (!row) return fail(res, 401, "unauthorized", "Unknown or revoked API key.");
  req.system = { systemId: row.system_id, keyId: row.id, label: row.label };
  next();
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

app.use((req, res, next) => {
  res.locals.requestId = randomBytes(4).toString("hex");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate"); // FM web viewers cache aggressively
  next();
});
app.use(express.json({ limit: "5mb" }));

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

app.post("/v1/log", keyAuth, (req, res) => {
  const entries = req.body?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return fail(res, 400, "bad_request", "Body must be { entries: [...] } with at least one entry.");
  }
  if (entries.length > MAX_BATCH) {
    return fail(res, 413, "batch_too_large", `At most ${MAX_BATCH} entries per batch.`);
  }
  const result = appendBatch(db, req.system.systemId, entries);
  res.json(ok(result));
});

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
    `SELECT id, system_id, severity, title, detail, evidence_json, scan_id, status, created_at
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

// Alerting: if ALERT_WEBHOOK is set, warn/critical findings from each scan
// are POSTed there as JSON, fire-and-forget. Works with a Slack incoming
// webhook, the Comm bus, or anything that accepts JSON. Email stays the
// anchor script's job (FMS schedule notifications).
async function pushAlerts(scanId) {
  const hook = process.env.ALERT_WEBHOOK;
  if (!hook || !scanId) return;
  const alerts = db.prepare(
    "SELECT system_id, severity, title, detail FROM warnings WHERE scan_id = ? AND severity IN ('warn','critical')"
  ).all(scanId);
  if (!alerts.length) return;
  const text = alerts.map((a) => `[${a.severity}] ${a.system_id}: ${a.title}. ${a.detail}`).join("\n");
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "clio", text, alerts }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "alert webhook failed", error: String(e.message || e) }));
  }
}

async function doScan(force) {
  const result = await runScan(db, { force, aiFindings: aiAvailable() ? aiFindings : null });
  if (!result.skipped) {
    selfLog("scan.run", { scan_id: result.scan_id, findings: result.findings });
    pushAlerts(result.scan_id); // deliberately not awaited
  }
  return result;
}

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

app.get("/api/overview", (_req, res) => {
  const reg = systemsIndex();
  const chains = db.prepare("SELECT DISTINCT system_id FROM log_entries").all().map((r) => r.system_id);
  const ids = [...new Set([...Object.keys(reg), ...chains])];
  const openCounts = Object.fromEntries(
    db.prepare("SELECT system_id, COUNT(*) AS n FROM warnings WHERE status = 'open' GROUP BY system_id")
      .all().map((r) => [r.system_id, r.n])
  );
  const systems = ids.map((sid) => ({
    ...head(db, sid),
    open_warnings: openCounts[sid] || 0,
    label: reg[sid]?.label || null,
    fm_server: reg[sid]?.fm_server || null,
    fm_file: reg[sid]?.fm_file || null,
  }));
  // Group by server in the UI: sort by server, then system id.
  systems.sort((a, b) => (a.fm_server || "~").localeCompare(b.fm_server || "~") || a.system_id.localeCompare(b.system_id));
  res.json({ systems, ai: aiAvailable(), version: VERSION });
});

app.get("/api/logs", (req, res) => {
  const sid = String(req.query.system_id || "");
  if (!sid) return res.status(400).json({ error: "system_id required" });
  res.json(queryLogs(sid, req.query));
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

app.listen(PORT, () => {
  console.log(JSON.stringify({ level: "info", msg: `Clio listening on :${PORT}`, db: DB_PATH, ai: aiAvailable() }));
});
