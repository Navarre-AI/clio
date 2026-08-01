// The rules engine. Rules are authored by an AI conversation but stored fully
// structured and fired DETERMINISTICALLY here: same log data in, same warnings
// out, every run. The model never evaluates a rule; it only writes the match
// spec that this code executes as plain SQL.
//
// match spec (all fields optional):
//   system          only this system_id
//   action_like     SQL LIKE against action (e.g. "%.deleted", "%login%")
//   category_like   SQL LIKE against category
//   actor           payload account_name equals this
//   rows_gte        payload.rows >= this (big exports)
//   off_hours       true: only entries outside business hours (per prefs tz)
//   weekend         true: only Saturday/Sunday entries (per prefs tz)
//   count_gte       fire only when matches in the window reach this count
//   window_minutes  the sliding window for count_gte (default 1440 = 24h)

import { randomUUID } from "node:crypto";
import { getPrefs } from "./scan.js";

function tzModifier(db) { return `${Number(getPrefs(db).tz_offset || 0)} hours`; }

function businessBounds(db) {
  const p = getPrefs(db);
  const [h1, h2] = p.business_hours.split("-").map(Number);
  const [d1, d2] = p.business_days.split("-").map(Number);
  return { h1, h2, d1, d2 };
}

// Build the WHERE clause + params for a match spec. `sinceIso` bounds the scan.
function buildWhere(db, match, sinceIso) {
  const tz = tzModifier(db);
  const where = ["ts_server >= ?"]; const params = [sinceIso];
  if (match.system) { where.push("system_id = ?"); params.push(match.system); }
  if (match.action_like) { where.push("action LIKE ?"); params.push(match.action_like); }
  if (match.category_like) { where.push("category LIKE ?"); params.push(match.category_like); }
  if (match.actor) { where.push("json_extract(payload_json, '$.account_name') = ?"); params.push(match.actor); }
  if (Number(match.rows_gte) > 0) {
    where.push("CAST(json_extract(payload_json, '$.rows') AS INTEGER) >= ?"); params.push(Number(match.rows_gte));
  }
  if (match.off_hours) {
    const { h1, h2 } = businessBounds(db);
    where.push(`CAST(strftime('%H', datetime(ts_server, ?)) AS INTEGER) NOT BETWEEN ? AND ?`);
    params.push(tz, h1, h2 - 1);
  }
  if (match.weekend) {
    const { d1, d2 } = businessBounds(db);
    where.push(`CAST(strftime('%w', datetime(ts_server, ?)) AS INTEGER) NOT BETWEEN ? AND ?`);
    params.push(tz, d1, d2);
  }
  return { sql: where.join(" AND "), params };
}

// Evaluate one rule against recent activity. Returns a finding or null.
export function evaluateRule(db, rule, now = Date.now()) {
  let match = {};
  try { match = JSON.parse(rule.match_json); } catch { return null; }
  const windowMin = Number(match.window_minutes) || 1440;
  const sinceIso = new Date(now - windowMin * 60000).toISOString();
  const { sql, params } = buildWhere(db, match, sinceIso);

  const rows = db.prepare(
    `SELECT system_id, action, ts_server, payload_json FROM log_entries WHERE ${sql} ORDER BY ts_server`
  ).all(...params);
  if (!rows.length) return null;

  const threshold = Number(match.count_gte) || 1;
  if (rows.length < threshold) return null;

  // Fire. Group by system so one rule can flag several systems at once.
  const bySystem = {};
  for (const r of rows) (bySystem[r.system_id] ||= []).push(r);
  const findings = [];
  for (const [systemId, hits] of Object.entries(bySystem)) {
    if (hits.length < threshold && Object.keys(bySystem).length > 1) continue;
    const actors = [...new Set(hits.map((h) => {
      try { return JSON.parse(h.payload_json).account_name; } catch { return null; }
    }).filter(Boolean))];
    const detail = `${rule.description} — ${hits.length} matching event${hits.length === 1 ? "" : "s"} ` +
      `in the last ${humanWindow(windowMin)}` + (actors.length ? ` (${actors.join(", ")})` : "") + ".";
    findings.push({
      system_id: systemId,
      severity: rule.severity,
      title: rule.name,
      detail,
      class: rule.class || null,
      source: `rule:${rule.id}`,
      evidence: { rule_id: rule.id, count: hits.length, window_minutes: windowMin,
        sample: hits.slice(-5).map((h) => ({ action: h.action, ts: h.ts_server })) },
    });
  }
  return findings;
}

// Run all enabled rules; return findings for the scan to persist.
export function runRules(db, now = Date.now()) {
  const rules = db.prepare("SELECT * FROM rules WHERE enabled = 1").all();
  const out = [];
  for (const rule of rules) {
    const f = evaluateRule(db, rule, now);
    if (f && f.length) {
      out.push(...f);
      db.prepare("UPDATE rules SET last_fired_at = ? WHERE id = ?").run(new Date(now).toISOString(), rule.id);
    }
  }
  return out;
}

// Dry-run a match spec against history: how often WOULD it have fired, with a
// few real examples. This is the "buttah" gate before saving a rule.
export function dryRun(db, match, days = 30, now = Date.now()) {
  const windowMin = Number(match.window_minutes) || 1440;
  const sinceIso = new Date(now - days * 86400000).toISOString();
  const { sql, params } = buildWhere(db, match, sinceIso);
  const rows = db.prepare(
    `SELECT system_id, action, ts_server, payload_json FROM log_entries WHERE ${sql} ORDER BY ts_server DESC LIMIT 500`
  ).all(...params);

  const threshold = Number(match.count_gte) || 1;
  // Count distinct firing-days when a threshold rule, else raw matches.
  let fireCount;
  if (threshold > 1) {
    const byDay = {};
    for (const r of rows) (byDay[r.ts_server.slice(0, 10)] ||= 0, byDay[r.ts_server.slice(0, 10)]++);
    fireCount = Object.values(byDay).filter((n) => n >= threshold).length;
  } else {
    fireCount = rows.length;
  }
  return {
    would_fire: fireCount,
    total_matches: rows.length,
    days,
    sample: rows.slice(0, 6).map((r) => {
      let who = null; try { who = JSON.parse(r.payload_json).account_name; } catch {}
      return { system_id: r.system_id, action: r.action, ts: r.ts_server, who };
    }),
  };
}

export function createRule(db, r) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO rules (id, name, description, effect, severity, class, enabled, match_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, String(r.name || "Untitled rule").slice(0, 120), String(r.description || "").slice(0, 500),
    ["alert", "highlight", "mute"].includes(r.effect) ? r.effect : "alert",
    ["info", "warn", "critical"].includes(r.severity) ? r.severity : "warn",
    r.class ? String(r.class).slice(0, 40) : null,
    r.enabled === false ? 0 : 1,
    JSON.stringify(r.match || {})
  );
  return db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
}

export function listRules(db) {
  const rules = db.prepare("SELECT * FROM rules ORDER BY created_at DESC").all();
  // annotate with 30-day dry-run counts so the list can show "fired N times"
  return rules.map((r) => {
    let match = {}; try { match = JSON.parse(r.match_json); } catch {}
    let would = null;
    try { would = dryRun(db, match, 30).would_fire; } catch {}
    return { ...r, enabled: !!r.enabled, match, would_fire_30d: would };
  });
}

function humanWindow(min) {
  if (min % 1440 === 0) { const d = min / 1440; return d === 1 ? "24 hours" : `${d} days`; }
  if (min % 60 === 0) return `${min / 60} hours`;
  return `${min} minutes`;
}
