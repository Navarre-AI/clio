// demostate.js: the ONE piece of demo state that must outlive the process.
//
// Everything else a visitor does in the demo (rule toggles, warning dismissals,
// the live trickle) lives in memory in demosession.js, and losing it on a
// restart is harmless: the next page load looks like a fresh visit. The AI
// spend counters are different. They protect a real bill on a public URL, and
// Fly restarts, migrates or redeploys a machine whenever it likes. A counter
// that resets on restart is not a cap, it is a suggestion: every visitor got a
// fresh ten prompts and the hourly ceiling across all visitors went back to
// zero every deploy.
//
// So the counters live in their own SQLite file on a Fly volume (DEMO_STATE_DIR),
// deliberately NOT in the baked demo dataset: that file is the read-only exhibit
// and stays pristine in the image.
//
// One table does both jobs. Every question a visitor asks is a row: what they
// typed, when, which session, and whether it spent a prompt. The counters are
// then just two COUNTs over that table, and Matt gets to read what people
// actually ask their logs, which is the other thing this file is for.
//
// This is the DEMO only. Nothing here is wired up when DEMO_MODE is off, and a
// self-hosted Clio neither creates this file nor sends anything anywhere.

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import fs from "fs";
import path from "path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,          -- epoch ms, what the counters window on
  ts           TEXT    NOT NULL,          -- ISO 8601, what a human reads
  session_id   TEXT    NOT NULL,          -- the demo cookie's random id, nothing else
  ip_hash      TEXT,                      -- salted, truncated; enough to spot one abuser
  question     TEXT    NOT NULL,
  spent        INTEGER NOT NULL DEFAULT 0,-- did this cost a prompt against the caps
  outcome      TEXT    NOT NULL,          -- pending|answered|error|out_of_prompts|hourly_cap|ai_off
  session_used INTEGER,                   -- prompts this session had spent, this one included
  ms           INTEGER,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS questions_at ON questions (at);
CREATE INDEX IF NOT EXISTS questions_session ON questions (session_id);
CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

// Rows are tiny and they are the point (Matt reads them), so retention is long
// and pruning only exists so an unattended year cannot fill a 1GB volume.
const RETAIN_DAYS = Number(process.env.DEMO_QUESTIONS_RETAIN_DAYS || 365);

let db = null;
let durable = false;
let salt = "";

// Opening must never be able to take the demo down: a missing mount is a
// degraded cap, not an outage. Falling back to an in-memory database keeps
// every call site identical and keeps the caps working for this process's
// lifetime, which is exactly today's behavior, and says so loudly in the log.
export function open(dir) {
  const file = path.join(dir, "demo-state.db");
  try {
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(file);
    durable = true;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "demo state db unavailable, AI caps are in-memory only", file, error: String(e.message || e) }));
    db = new DatabaseSync(":memory:");
    durable = false;
  }
  if (durable) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  db.prepare("DELETE FROM questions WHERE at < ?").run(Date.now() - RETAIN_DAYS * 86400_000);
  // A per-install salt, generated once and kept, so an ip hash means the same
  // thing across restarts (and means nothing at all outside this database).
  const row = db.prepare("SELECT v FROM state WHERE k = 'ip_salt'").get();
  salt = row?.v || randomBytes(16).toString("hex");
  if (!row) db.prepare("INSERT INTO state (k, v) VALUES ('ip_salt', ?)").run(salt);
  console.log(JSON.stringify({ level: "info", msg: "demo state", file: durable ? file : ":memory:", durable,
    questions: db.prepare("SELECT COUNT(*) n FROM questions").get().n }));
  return { durable, file };
}

export const isDurable = () => durable;

export function ipHash(ip) {
  if (!ip) return null;
  return createHash("sha256").update(salt + "|" + String(ip)).digest("hex").slice(0, 12);
}

// ---- the counters -----------------------------------------------------------

// What this visitor has spent. Counted from the durable rows, not from a number
// held in a session object, so a restart does not hand them a fresh allowance.
export function sessionUsed(sessionId) {
  return db.prepare("SELECT COUNT(*) n FROM questions WHERE session_id = ? AND spent = 1").get(sessionId).n;
}

// The sliding one-hour window across ALL visitors: how many prompts were spent,
// and when the oldest one ages out.
export function hourly(windowMs = 3600_000) {
  const cutoff = Date.now() - windowMs;
  const r = db.prepare("SELECT COUNT(*) n, MIN(at) oldest FROM questions WHERE spent = 1 AND at >= ?").get(cutoff);
  return { count: r.n, oldest: r.oldest };
}

// ---- capture ----------------------------------------------------------------

export function record({ session_id, ip_hash, question, spent, outcome, session_used }) {
  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO questions (at, ts, session_id, ip_hash, question, spent, outcome, session_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(now, new Date(now).toISOString(), String(session_id || ""), ip_hash || null,
    String(question || "").slice(0, 2000), spent ? 1 : 0, outcome, session_used ?? null);
  return Number(r.lastInsertRowid);
}

export function finish(id, { outcome, ms, error }) {
  if (!id) return;
  db.prepare("UPDATE questions SET outcome = ?, ms = ?, error = ? WHERE id = ?")
    .run(outcome, ms ?? null, error ? String(error).slice(0, 300) : null, id);
}

// ---- reading it back --------------------------------------------------------

export function recent(limit = 200) {
  return db.prepare(
    `SELECT id, ts, session_id, ip_hash, question, spent, outcome, session_used, ms, error
     FROM questions ORDER BY id DESC LIMIT ?`
  ).all(Math.min(Math.max(Number(limit) || 200, 1), 2000));
}

export function stats() {
  const s = db.prepare(
    `SELECT COUNT(*) asked, SUM(spent) spent, COUNT(DISTINCT session_id) sessions,
            MIN(ts) first, MAX(ts) last FROM questions`
  ).get();
  return {
    durable,
    asked: s.asked, spent: s.spent || 0, sessions: s.sessions,
    first: s.first, last: s.last,
    last_hour_spent: hourly().count,
    last_24h_asked: db.prepare("SELECT COUNT(*) n FROM questions WHERE at >= ?").get(Date.now() - 86400_000).n,
  };
}

export function close() { try { db?.close(); } catch {} db = null; }
