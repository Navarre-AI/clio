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
  // Clio's own operational log is never watchdogged, for the same reason the
  // automatic detectors skip it (scan.js): its scan/connect/verify entries would
  // trip generic rules every day, and a log server warning about its own logging
  // is noise. Target it deliberately with match.system if you really want it.
  else where.push("system_id != 'clio'");
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
  // The window is a SLIDING one inside the last day, not the N minutes that
  // happen to precede the scan. Without this, "20 deletions in an hour" could
  // only ever fire if the burst landed in the hour before the nightly scan, so
  // the rule looked broken every other time: the burst was in the log, the scan
  // ran at 6 AM, and nothing was reported. Fetch a day (or the window, whichever
  // is longer) and slide.
  const lookbackMin = Math.max(windowMin, 1440);
  const sinceIso = new Date(now - lookbackMin * 60000).toISOString();
  const { sql, params } = buildWhere(db, match, sinceIso);

  let rows = db.prepare(
    `SELECT system_id, action, ts_server, payload_json FROM log_entries WHERE ${sql} ORDER BY ts_server`
  ).all(...params);
  if (!rows.length) return null;

  // A single suspicious event is a fact; the same event happening every Friday is
  // the finding. Look back over `recur_days` (90 by default) with the SAME match
  // spec, in local time, and report a weekday cadence only when the data really
  // shows one (see recurrence()). Nothing is asserted that the log does not say.
  const recur = recurrence(db, match, Number(match.recur_days) || 90, now); // Map system_id -> {text, evidence}

  const threshold = Number(match.count_gte) || 1;
  if (rows.length < threshold) return null;

  // Fire. Group by system so one rule can flag several systems at once.
  const bySystem = {};
  for (const r of rows) (bySystem[r.system_id] ||= []).push(r);
  const findings = [];
  for (let [systemId, hits] of Object.entries(bySystem)) {
    if (threshold > 1) {
      const burst = densestWindow(hits, windowMin);
      if (burst.length < threshold) continue;
      hits = burst; // report the burst, not the whole day
    }
    if (hits.length < threshold && Object.keys(bySystem).length > 1) continue;
    // Name the person the data points at. Listing all seven people who touched
    // the table that hour buries the one who did 380 of the 391. When one actor
    // dominates, say so; when it is genuinely spread, list them as before.
    const actorCounts = new Map();
    for (const h of hits) {
      let who = null;
      try { who = JSON.parse(h.payload_json).account_name; } catch { who = null; }
      if (who) actorCounts.set(who, (actorCounts.get(who) || 0) + 1);
    }
    const ranked = [...actorCounts.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const dominant = top && ranked.length > 1 && top[1] / hits.length >= 0.6 ? top : null;
    const actors = dominant
      ? [`${dominant[0]}, ${Math.round((dominant[1] / hits.length) * 100)}% of them`]
      : ranked.map(([who]) => who);
    const example = exampleOf(hits[hits.length - 1]);
    const detail = `${String(rule.description || "").replace(/\.\s*$/, "")}: ${hits.length} matching event${hits.length === 1 ? "" : "s"} ` +
      `in the last ${humanWindow(windowMin)}` + (actors.length ? ` (${actors.join(", ")})` : "") + "." +
      (example ? ` For example: ${example}.` : "") +
      (recur.get(systemId) ? ` ${recur.get(systemId).text}` : "");
    findings.push({
      system_id: systemId,
      severity: rule.severity,
      title: rule.name,
      detail,
      class: rule.class || null,
      source: `rule:${rule.id}`,
      evidence: { rule_id: rule.id, count: hits.length, window_minutes: windowMin,
        example: example || null,
        recurrence: recur.get(systemId)?.evidence || null,
        sample: hits.slice(-5).map((h) => ({ action: h.action, ts: h.ts_server })) },
    });
  }
  return findings;
}

// The most entries this rule matched inside any window_minutes-wide span of the
// rows given (two pointers over an already time-ordered list).
function densestWindow(hits, windowMin) {
  const span = windowMin * 60000;
  let best = [], lo = 0;
  for (let hi = 0; hi < hits.length; hi++) {
    while (Date.parse(hits[hi].ts_server) - Date.parse(hits[lo].ts_server) > span) lo++;
    if (hi - lo + 1 > best.length) best = hits.slice(lo, hi + 1);
  }
  return best;
}

// ---- recurrence + example ---------------------------------------------------
// "Invoice 2614 was created and deleted the same day" is a fact. "This happens
// every Friday" is what makes someone act. Both are computed from the log here,
// deterministically; the model is never asked to spot a pattern, and no cadence
// is claimed unless the entries really cluster on one weekday.

const DOW_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

// A rule fires on a weekday cadence when, over the lookback window, its matches
// land on the SAME local weekday on at least 3 different dates and that weekday
// holds at least 80% of them. Anything looser is noise and stays unsaid.
export function recurrence(db, match, days = 90, now = Date.now()) {
  const out = new Map();
  if (!match || match.silence) return out;
  const sinceIso = new Date(now - days * 86400000).toISOString();
  let sql, params;
  try { ({ sql, params } = buildWhere(db, match, sinceIso)); } catch { return out; }
  const tz = tzModifier(db);
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT system_id,
              CAST(strftime('%w', datetime(ts_server, ?)) AS INTEGER) AS dow,
              COUNT(*) AS n,
              COUNT(DISTINCT date(datetime(ts_server, ?))) AS dates,
              MAX(ts_server) AS last_ts
       FROM log_entries WHERE ${sql} GROUP BY system_id, dow`
    ).all(tz, tz, ...params);
  } catch { return out; }

  const bySystem = {};
  for (const r of rows) (bySystem[r.system_id] ||= []).push(r);
  for (const [systemId, list] of Object.entries(bySystem)) {
    const total = list.reduce((s, r) => s + r.n, 0);
    const top = list.reduce((a, b) => (b.n > a.n ? b : a));
    if (total < 3 || top.dates < 3 || top.n / total < 0.8) continue;
    const when = DOW_PLURAL[top.dow] || `day ${top.dow}`;
    out.set(systemId, {
      text: `This pattern recurs on ${when}: ${top.n} time${top.n === 1 ? "" : "s"} across ${top.dates} separate ${when} in the last ${days} days, most recently ${top.last_ts.slice(0, 10)}.`,
      evidence: { weekday: top.dow, weekday_name: when, occurrences: top.n, distinct_dates: top.dates,
        total_matches: total, lookback_days: days, last_seen: top.last_ts },
    });
  }
  return out;
}

// One concrete instance a human can go and look at, pulled straight from the
// payload: the business identifier if the record has one, else the record.
function exampleOf(hit) {
  if (!hit) return null;
  let p = {}; try { p = JSON.parse(hit.payload_json); } catch { return null; }
  const d = (p.data && typeof p.data === "object") ? p.data : {};
  const named = [
    ["invoice", d.invoice_number], ["order", d.order_number ?? d.order_ref ?? p.order_ref],
    ["customer", d.customer ?? p.customer], ["employee", p.employee], ["SKU", d.sku],
  ].find(([, v]) => v !== undefined && v !== null && v !== "");
  if (named) return `${named[0]} ${named[1]}`;
  if (typeof p.message === "string" && p.message) return p.message.slice(0, 120);
  if (p.table && p.record_id != null) return `${p.table} record ${p.record_id}`;
  return null;
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
  // A rule that watches for the ABSENCE of entries has no match count; saying
  // "500 matches" for it (the old row-limit artefact) was just wrong.
  if (match?.silence) return { would_fire: null, total_matches: null, days, silence: true, sample: [] };
  const windowMin = Number(match.window_minutes) || 1440;
  const sinceIso = new Date(now - days * 86400000).toISOString();
  const { sql, params } = buildWhere(db, match, sinceIso);
  // The true total comes from COUNT(*), not from however many rows we chose to
  // read: the badge on the Rules screen quotes this number, and a capped one
  // made a rule matching 4,000 entries claim exactly 500, every time.
  const total = db.prepare(`SELECT COUNT(*) AS n FROM log_entries WHERE ${sql}`).get(...params).n;
  const rows = db.prepare(
    `SELECT system_id, action, ts_server, payload_json FROM log_entries WHERE ${sql} ORDER BY ts_server DESC LIMIT 2000`
  ).all(...params);

  const threshold = Number(match.count_gte) || 1;
  // Count distinct firing-days when a threshold rule, else raw matches.
  let fireCount;
  if (threshold > 1) {
    const byDay = {};
    for (const r of rows) (byDay[r.ts_server.slice(0, 10)] ||= 0, byDay[r.ts_server.slice(0, 10)]++);
    fireCount = Object.values(byDay).filter((n) => n >= threshold).length;
  } else {
    fireCount = total;
  }
  return {
    would_fire: fireCount,
    total_matches: total,
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

// The log entries a rule's match spec selects right now, newest first. The
// firings list below only shows warnings a scan actually filed; a rule that has
// never fired (or was authored after the last scan) still has to be able to show
// its work, which is what this answers: "what does this rule actually match?"
export function ruleMatches(db, match, { days = 30, limit = 25, now = Date.now() } = {}) {
  if (match?.silence) return []; // silence is the absence of entries; nothing to list
  const sinceIso = new Date(now - days * 86400000).toISOString();
  const { sql, params } = buildWhere(db, match || {}, sinceIso);
  return db.prepare(
    `SELECT system_id, seq, action, ts_server, ts_client, payload_json FROM log_entries
     WHERE ${sql} ORDER BY ts_server DESC LIMIT ${Math.min(Number(limit) || 25, 200)}`
  ).all(...params).map((r) => {
    let p = {}; try { p = JSON.parse(r.payload_json); } catch {}
    return {
      system_id: r.system_id, seq: r.seq, action: r.action,
      ts: r.ts_client || r.ts_server,
      who: p.account_name || p.data?.z_Modifier || null,
      message: p.message || null, table: p.table || null, record_id: p.record_id ?? null,
    };
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
    { name: "Mass deletion", description: "20 or more record deletions within an hour.", severity: "critical", match: { action_like: "%.deleted", count_gte: 20, window_minutes: 60 } },
    { name: "Big export", description: "An export of 1,000 or more records.", severity: "warn", match: { rows_gte: 1000 } },
  ];
  for (const d of defaults) createRule(db, { ...d, effect: "alert" });
}

function humanWindow(min) {
  if (min % 1440 === 0) { const d = min / 1440; return d === 1 ? "24 hours" : `${d} days`; }
  if (min % 60 === 0) { const h = min / 60; return h === 1 ? "hour" : `${h} hours`; }
  return `${min} minutes`;
}
