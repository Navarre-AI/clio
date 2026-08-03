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
  if (Array.isArray(match.files) && match.files.length) {
    where.push(`json_extract(payload_json, '$.file') IN (${match.files.map(() => "?").join(",")})`);
    params.push(...match.files.map(String));
  }
  if (Number(match.rows_gte) > 0) {
    where.push("CAST(json_extract(payload_json, '$.rows') AS INTEGER) >= ?"); params.push(Number(match.rows_gte));
  }
  // Numeric/value conditions on a payload field: field + op + value. The field
  // is looked up in the changed value first (new value), then the flat data,
  // then the top-level payload, so "amount over 5000" works on edits and events.
  if (match.field && match.value !== undefined && match.value !== "") {
    const op = ({ gte: ">=", gt: ">", lte: "<=", lt: "<", eq: "=", ne: "<>" })[match.op] || ">=";
    const f = String(match.field).replace(/["'\\]/g, "");
    const cleanVal = String(match.value).replace(/[$,\s]/g, ""); // strip $ , and spaces
    const numeric = /^-?\d+(\.\d+)?$/.test(cleanVal);
    // look in the changed new-value first, then the flat data, then top-level
    const coalesced = `COALESCE(json_extract(payload_json,'$.changed."${f}".to'), json_extract(payload_json,'$.data."${f}"'), json_extract(payload_json,'$."${f}"'))`;
    if (numeric) {
      // strip currency/commas from the stored value too, so "$7,500" compares as 7500
      where.push(`CAST(REPLACE(REPLACE(${coalesced},'$',''),',','') AS REAL) ${op} ?`);
      params.push(Number(cleanVal));
    } else {
      where.push(`${coalesced} ${op === "<>" ? "<>" : "="} ?`);
      params.push(String(match.value));
    }
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

  // Silence is the absence of entries: a system with a real baseline that has
  // logged nothing recently. The one rule that flags broken logging.
  if (match.silence) {
    const quietHrs = Number(match.quiet_hours) || 36;
    const baseStart = new Date(now - 15 * 86400000).toISOString();
    const cutoff = new Date(now - quietHrs * 3600000).toISOString();
    const rows = db.prepare(
      `SELECT system_id, COUNT(*) AS base, MAX(ts_server) AS last_ts FROM log_entries
       WHERE system_id != 'clio' AND ts_server >= ? GROUP BY system_id`
    ).all(baseStart);
    const findings = [];
    for (const r of rows) {
      if (r.base >= 14 && r.last_ts && r.last_ts < cutoff) {
        findings.push({ system_id: r.system_id, severity: rule.severity, title: rule.name,
          detail: `${rule.description} No entries since ${r.last_ts.slice(0, 16).replace("T", " ")}, after ${r.base} in the prior 15 days.`,
          class: rule.class || null, source: `rule:${rule.id}`,
          evidence: { rule_id: rule.id, last_entry: r.last_ts, baseline_15d: r.base } });
      }
    }
    return findings;
  }

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
    const detail = `${rule.description}: ${hits.length} matching event${hits.length === 1 ? "" : "s"} ` +
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

export function updateRule(db, id, r) {
  const sets = []; const params = [];
  for (const k of ["name", "description", "effect", "severity", "class"]) {
    if (r[k] !== undefined) { sets.push(`${k} = ?`); params.push(r[k] === null ? null : String(r[k])); }
  }
  if (r.enabled !== undefined) { sets.push("enabled = ?"); params.push(r.enabled ? 1 : 0); }
  if (r.match !== undefined) { sets.push("match_json = ?"); params.push(JSON.stringify(r.match)); }
  if (!sets.length) return db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  params.push(id);
  db.prepare(`UPDATE rules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
}

export function listRules(db) {
  const rules = db.prepare("SELECT * FROM rules ORDER BY created_at DESC").all();
  return rules.map((r) => {
    let match = {}; try { match = JSON.parse(r.match_json); } catch {}
    let would = null;
    try { would = dryRun(db, match, 30).would_fire; } catch {}
    return { ...r, enabled: !!r.enabled, match, would_fire_30d: would };
  });
}

// A rule's firings = warnings it produced (source "rule:<id>"), newest first,
// with the sample matching entries it cited.
export function ruleFirings(db, id) {
  return db.prepare(
    "SELECT id, system_id, severity, title, detail, evidence_json, created_at FROM warnings WHERE source = ? ORDER BY created_at DESC LIMIT 200"
  ).all("rule:" + id).map((w) => { let ev = null; try { ev = JSON.parse(w.evidence_json); } catch {} return { ...w, evidence: ev }; });
}

// Sensible defaults seeded on a fresh install, so day one is useful. The
// flagship: a database that normally logs going quiet (logging probably broke).
export function seedDefaultRules(db) {
  if (db.prepare("SELECT COUNT(*) n FROM rules").get().n > 0) return;
  const defaults = [
    { name: "Logging went quiet", description: "A system that normally logs has gone silent, which usually means logging broke (a script change, a removed trigger, or a server offline).", severity: "warn", match: { silence: true } },
    { name: "Weekend activity", description: "Any changes made on a weekend.", severity: "info", match: { weekend: true } },
    { name: "Mass deletion", description: "20 or more record deletions within an hour.", severity: "critical", class: "HIPAA", match: { action_like: "%.deleted", count_gte: 20, window_minutes: 60 } },
    { name: "Big export", description: "An export of 1,000 or more records.", severity: "warn", match: { rows_gte: 1000 } },
  ];
  for (const d of defaults) createRule(db, { ...d, effect: "alert" });
}

function humanWindow(min) {
  if (min % 1440 === 0) { const d = min / 1440; return d === 1 ? "24 hours" : `${d} days`; }
  if (min % 60 === 0) return `${min / 60} hours`;
  return `${min} minutes`;
}
