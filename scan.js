// scan.js: the deterministic half of "the pulse". Fixed SQL aggregates over a
// trailing baseline; every number here comes straight from the database. The
// AI (ai.js) only decides which aggregates are worth a warning and how to say
// it. With no AI key configured, plain thresholds still emit warnings.

import { randomUUID } from "node:crypto";

const DAY = 24 * 60 * 60 * 1000;

// Watchdog config, all optional. This is usage auditing for the database
// admin (who did what, when), not performance tuning.
//   CLIO_TZ_OFFSET   hours from UTC for "local" business time, e.g. 3 or -7
//   BUSINESS_HOURS   local hours considered on-hours, "07-19"
//   BUSINESS_DAYS    "1-5" = Monday-Friday (0=Sunday, 6=Saturday)
//   EXPORT_ROWS_THRESHOLD  payload {"rows": N} at or above this is a big export
// UI-saved prefs (meta key "prefs") win over env; env wins over defaults.
export function getPrefs(db) {
  let saved = {};
  try {
    const row = db.prepare("SELECT v FROM meta WHERE k = 'prefs'").get();
    if (row) saved = JSON.parse(row.v);
  } catch {}
  return {
    tz_offset: saved.tz_offset ?? Number(process.env.CLIO_TZ_OFFSET || 0),
    business_hours: saved.business_hours || process.env.BUSINESS_HOURS || "07-19",
    business_days: saved.business_days || process.env.BUSINESS_DAYS || "1-5",
    export_rows: saved.export_rows ?? Number(process.env.EXPORT_ROWS_THRESHOLD || 1000),
    watch: Array.isArray(saved.watch) ? saved.watch : [],
    mute: Array.isArray(saved.mute) ? saved.mute : [],
    slack_webhook: saved.slack_webhook || "",
    alert_webhook: saved.alert_webhook || "",
  };
}

function watchdogConfig(db) {
  const p = getPrefs(db);
  const [h1, h2] = p.business_hours.split("-").map(Number);
  const [d1, d2] = p.business_days.split("-").map(Number);
  return {
    tzModifier: `${Number(p.tz_offset)} hours`,
    hourStart: h1, hourEnd: h2, dayStart: d1, dayEnd: d2,
    exportRows: p.export_rows,
  };
}

// Aggregates for one system. Baseline: the 14 days before the last 24 hours.
export function aggregatesForSystem(db, systemId, now = Date.now()) {
  const dayAgo = iso(now - DAY);
  const baseStart = iso(now - 15 * DAY);
  const out = [];
  const cfg = watchdogConfig(db);

  // Volume per action: last 24h vs baseline daily mean.
  const rows = db.prepare(
    `SELECT action,
            SUM(CASE WHEN ts_server >= ? THEN 1 ELSE 0 END) AS last24,
            SUM(CASE WHEN ts_server >= ? AND ts_server < ? THEN 1 ELSE 0 END) AS base
     FROM log_entries WHERE system_id = ? GROUP BY action`
  ).all(dayAgo, baseStart, dayAgo, systemId);

  for (const r of rows) {
    const baseMean = r.base / 14;
    const errorShaped = /error|fail|denied|invalid|tamper/i.test(r.action);
    const deleteShaped = /\.deleted?$/i.test(r.action);
    // Danger shapes outrank novelty: a brand-new action that is also a
    // delete or error burst reports as the burst, not as trivia.
    if (deleteShaped && r.last24 >= 10 && r.last24 > 3 * baseMean) {
      out.push({ kind: "delete_spike", system_id: systemId, action: r.action,
        last24: r.last24, baseline_daily_mean: round2(baseMean) });
    } else if (r.base === 0 && r.last24 > 0) {
      out.push({ kind: "new_action", system_id: systemId, action: r.action,
        last24: r.last24, note: "action never seen in the prior 14 days" });
    } else if (r.last24 >= 10 && baseMean > 0 && r.last24 > 3 * baseMean) {
      out.push({ kind: errorShaped ? "error_spike" : "volume_spike", system_id: systemId,
        action: r.action, last24: r.last24, baseline_daily_mean: round2(baseMean) });
    } else if (errorShaped && r.last24 >= 5 && r.last24 > 2 * baseMean) {
      out.push({ kind: "error_spike", system_id: systemId, action: r.action,
        last24: r.last24, baseline_daily_mean: round2(baseMean) });
    } else if (baseMean >= 5 && r.last24 === 0) {
      out.push({ kind: "action_silent", system_id: systemId, action: r.action,
        last24: 0, baseline_daily_mean: round2(baseMean) });
    }
  }

  // Off-hours activity: events outside the business window (local time via
  // CLIO_TZ_OFFSET), last 24h vs the baseline's daily off-hours mean.
  const offCond = `(
      CAST(strftime('%H', datetime(ts_server, ?)) AS INTEGER) NOT BETWEEN ? AND ?
      OR CAST(strftime('%w', datetime(ts_server, ?)) AS INTEGER) NOT BETWEEN ? AND ?
    )`;
  const offArgs = [cfg.tzModifier, cfg.hourStart, cfg.hourEnd - 1, cfg.tzModifier, cfg.dayStart, cfg.dayEnd];
  const off = db.prepare(
    `SELECT SUM(CASE WHEN ts_server >= ? THEN 1 ELSE 0 END) AS last24,
            SUM(CASE WHEN ts_server >= ? AND ts_server < ? THEN 1 ELSE 0 END) AS base
     FROM log_entries WHERE system_id = ? AND ${offCond}`
  ).get(dayAgo, baseStart, dayAgo, systemId, ...offArgs);
  const offBaseMean = (off.base || 0) / 14;
  if ((off.last24 || 0) >= 5 && off.last24 > 3 * Math.max(offBaseMean, 1)) {
    const top = db.prepare(
      `SELECT action, COUNT(*) AS n FROM log_entries
       WHERE system_id = ? AND ts_server >= ? AND ${offCond}
       GROUP BY action ORDER BY n DESC LIMIT 5`
    ).all(systemId, dayAgo, ...offArgs);
    out.push({ kind: "off_hours", system_id: systemId, last24: off.last24,
      baseline_daily_mean: round2(offBaseMean),
      window: `outside ${cfg.hourStart}:00-${cfg.hourEnd}:00 local or weekend`,
      top_actions: top.map((t) => `${t.action} (${t.n})`) });
  }

  // Big exports: any event whose payload reports {"rows": N} at or over the
  // threshold and whose action looks export/print/save-shaped.
  const exports_ = db.prepare(
    `SELECT action, ts_server, CAST(json_extract(payload_json, '$.rows') AS INTEGER) AS rows
     FROM log_entries
     WHERE system_id = ? AND ts_server >= ?
       AND (action LIKE '%export%' OR action LIKE '%print%' OR action LIKE '%save%' OR action LIKE '%pdf%')
       AND CAST(json_extract(payload_json, '$.rows') AS INTEGER) >= ?
     ORDER BY rows DESC LIMIT 10`
  ).all(systemId, dayAgo, cfg.exportRows);
  for (const e of exports_) {
    out.push({ kind: "big_export", system_id: systemId, action: e.action,
      rows: e.rows, at: e.ts_server, threshold: cfg.exportRows });
  }

  // Whole system gone silent: steady baseline, nothing in 36 hours.
  const sys = db.prepare(
    `SELECT COUNT(*) AS base, MAX(ts_server) AS last_ts
     FROM log_entries WHERE system_id = ? AND ts_server >= ?`
  ).get(systemId, baseStart);
  if (sys.base >= 14 && sys.last_ts && sys.last_ts < iso(now - 1.5 * DAY)) {
    out.push({ kind: "system_silent", system_id: systemId,
      baseline_count_15d: sys.base, last_entry: sys.last_ts });
  }

  return out;
}

// Threshold fallback: no model, just the aggregates mapped to severities.
export function warningsFromAggregates(aggregates) {
  return aggregates.map((a) => {
    const sev = ["error_spike", "system_silent", "action_silent", "off_hours", "big_export", "delete_spike"]
      .includes(a.kind) ? "warn" : "info";
    return {
      system_id: a.system_id, severity: sev,
      title: titleFor(a),
      detail: detailFor(a),
      evidence: a,
    };
  });
}

function titleFor(a) {
  const names = {
    new_action: `New event type: ${a.action}`,
    error_spike: `Spike in ${a.action}`,
    volume_spike: `Unusual volume for ${a.action}`,
    delete_spike: `Deletion spike: ${a.action}`,
    action_silent: `${a.action} went quiet`,
    system_silent: `System has gone silent`,
    off_hours: `Off-hours activity`,
    big_export: `Large export: ${a.action}`,
  };
  return names[a.kind] || a.kind;
}

function detailFor(a) {
  switch (a.kind) {
    case "new_action":
      return `${a.last24} "${a.action}" events in the last 24 hours; none in the prior 14 days.`;
    case "error_spike":
    case "volume_spike":
      return `${a.last24} "${a.action}" events in the last 24 hours vs a daily average of ${a.baseline_daily_mean}.`;
    case "action_silent":
      return `No "${a.action}" events in the last 24 hours vs a daily average of ${a.baseline_daily_mean}.`;
    case "delete_spike":
      return `${a.last24} "${a.action}" deletions in the last 24 hours vs a daily average of ${a.baseline_daily_mean}.`;
    case "system_silent":
      return `No events since ${a.last_entry}, after ${a.baseline_count_15d} events in the prior 15 days.`;
    case "off_hours":
      return `${a.last24} events ${a.window} in the last 24 hours vs a daily average of ${a.baseline_daily_mean}. Top: ${(a.top_actions || []).join(", ")}.`;
    case "big_export":
      return `"${a.action}" reported ${a.rows} rows at ${a.at} (threshold ${a.threshold}).`;
    default:
      return JSON.stringify(a);
  }
}

// Run a full scan across every system that has ever logged. Dedupes on
// scan_date unless forced. aiFindings, when provided, turns aggregates into
// findings via the model; otherwise thresholds do it.
export async function runScan(db, { force = false, aiFindings = null, ruleFindings = null, now = Date.now() } = {}) {
  const scanDate = iso(now).slice(0, 10);
  const already = db.prepare(
    "SELECT id FROM scans WHERE scan_date = ? AND status = 'done'"
  ).get(scanDate);
  if (already && !force) return { scan_id: already.id, skipped: true };

  const scanId = randomUUID();
  db.prepare("INSERT INTO scans (id, started_at, scan_date) VALUES (?, ?, ?)")
    .run(scanId, iso(now), scanDate);

  try {
    // Never watchdog Clio's own self-log: its internal events (scan.run, key_minted)
    // would otherwise trip "new event type" every scan, in a self-feeding loop.
    const systems = db.prepare("SELECT DISTINCT system_id FROM log_entries WHERE system_id != 'clio'").all()
      .map((r) => r.system_id);
    let findings = 0;
    const ins = db.prepare(
      `INSERT INTO warnings (id, system_id, severity, title, detail, evidence_json, scan_id, source, class, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // Dedup: a finding is "the same" by system + source + FINGERPRINT. Don't re-create it
    // if an open one already exists, or if it was acknowledged within the last 20 hours.
    // This is what makes acknowledgements stick instead of the finding re-appearing.
    //
    // Deliberately NOT the title: with an AI key the model writes the title and rewords
    // the same condition every night, so a title-keyed check never matches and a
    // persisting problem refiles daily. The fingerprint comes from the detector instead.
    const dupe = db.prepare(
      `SELECT 1 FROM warnings WHERE system_id = ? AND source = ? AND fingerprint = ?
         AND (status = 'open' OR (status = 'acknowledged' AND created_at > datetime('now','-20 hours')))
       LIMIT 1`
    );
    const put = (w, source, cls) => {
      const fp = fingerprintOf(w);
      if (dupe.get(w.system_id, source, fp)) return; // already surfaced, or acked recently
      ins.run(randomUUID(), w.system_id, w.severity, w.title, w.detail,
        JSON.stringify(w.evidence ?? null), scanId, source, cls ?? null, fp);
      findings++;
    };
    // Automatic detectors, per system.
    for (const systemId of systems) {
      const aggregates = aggregatesForSystem(db, systemId, now);
      if (!aggregates.length) continue;
      const warnings = aiFindings ? await aiFindings(systemId, aggregates) : warningsFromAggregates(aggregates);
      for (const w of warnings) put(w, "auto", null);
    }
    // Admin-authored rules, evaluated deterministically.
    if (ruleFindings) {
      for (const w of ruleFindings(now)) put(w, w.source || "rule", w.class || null);
    }
    db.prepare("UPDATE scans SET finished_at = ?, systems_scanned = ?, findings = ?, status = 'done' WHERE id = ?")
      .run(iso(Date.now()), systems.length, findings, scanId);
    return { scan_id: scanId, systems_scanned: systems.length, findings, skipped: false };
  } catch (e) {
    db.prepare("UPDATE scans SET finished_at = ?, status = 'error' WHERE id = ?")
      .run(iso(Date.now()), scanId);
    throw e;
  }
}

// A finding's stable identity, independent of how it is worded.
//
// Taken from the evidence the detector produced, never from the title: the
// aggregate's kind plus the action it concerns (a rule uses its rule id).
// Two scans that find the same condition produce the same fingerprint even
// when the model describes it in completely different words.
//
// The last resort is the title, which only applies to a finding that arrived
// with no evidence at all. That degrades to the old behaviour rather than
// crashing, and it is the one case where rewording still duplicates.
export function fingerprintOf(w) {
  const e = w.evidence;
  if (e && typeof e === "object" && !Array.isArray(e)) {
    if (e.rule_id) return `rule:${e.rule_id}`;
    if (e.kind) return `${e.kind}:${e.action ?? ""}`;
  }
  return `title:${w.title}`;
}

function iso(ms) { return new Date(ms).toISOString(); }
function round2(n) { return Math.round(n * 100) / 100; }
