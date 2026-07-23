// scan.js: the deterministic half of "the pulse". Fixed SQL aggregates over a
// trailing baseline; every number here comes straight from the database. The
// AI (ai.js) only decides which aggregates are worth a warning and how to say
// it. With no AI key configured, plain thresholds still emit warnings.

import { randomUUID } from "node:crypto";

const DAY = 24 * 60 * 60 * 1000;

// Aggregates for one system. Baseline: the 14 days before the last 24 hours.
export function aggregatesForSystem(db, systemId, now = Date.now()) {
  const dayAgo = iso(now - DAY);
  const baseStart = iso(now - 15 * DAY);
  const out = [];

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
    if (r.base === 0 && r.last24 > 0) {
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
    const sev = a.kind === "error_spike" || a.kind === "system_silent" ? "warn"
      : a.kind === "action_silent" ? "warn" : "info";
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
    action_silent: `${a.action} went quiet`,
    system_silent: `System has gone silent`,
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
    case "system_silent":
      return `No events since ${a.last_entry}, after ${a.baseline_count_15d} events in the prior 15 days.`;
    default:
      return JSON.stringify(a);
  }
}

// Run a full scan across every system that has ever logged. Dedupes on
// scan_date unless forced. aiFindings, when provided, turns aggregates into
// findings via the model; otherwise thresholds do it.
export async function runScan(db, { force = false, aiFindings = null, now = Date.now() } = {}) {
  const scanDate = iso(now).slice(0, 10);
  const already = db.prepare(
    "SELECT id FROM scans WHERE scan_date = ? AND status = 'done'"
  ).get(scanDate);
  if (already && !force) return { scan_id: already.id, skipped: true };

  const scanId = randomUUID();
  db.prepare("INSERT INTO scans (id, started_at, scan_date) VALUES (?, ?, ?)")
    .run(scanId, iso(now), scanDate);

  try {
    const systems = db.prepare("SELECT DISTINCT system_id FROM log_entries").all()
      .map((r) => r.system_id);
    let findings = 0;
    for (const systemId of systems) {
      const aggregates = aggregatesForSystem(db, systemId, now);
      if (!aggregates.length) continue;
      const warnings = aiFindings
        ? await aiFindings(systemId, aggregates)
        : warningsFromAggregates(aggregates);
      const ins = db.prepare(
        `INSERT INTO warnings (id, system_id, severity, title, detail, evidence_json, scan_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const w of warnings) {
        ins.run(randomUUID(), w.system_id, w.severity, w.title, w.detail,
          JSON.stringify(w.evidence ?? null), scanId);
        findings++;
      }
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

function iso(ms) { return new Date(ms).toISOString(); }
function round2(n) { return Math.round(n * 100) / 100; }
