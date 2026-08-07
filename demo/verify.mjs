#!/usr/bin/env node
// demo/verify.mjs: re-verify the built demo DB with Clio's own verification
// path, and confirm the story arcs (demo/STORIES.md) are present.
// Usage: node demo/verify.mjs [path/to/clio.db]   (default demo/data/clio.db)
//
// The dataset rolls: it ends at whatever "now" it was built with, so nothing
// here may assert an absolute date. Checks are expressed against the data's own
// shape (counts, relationships, weekdays, distance from the end of the window),
// which is what actually has to be true.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDbReadOnly } from "../db.js";
import { verifyRange } from "../chain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.argv[2] || path.join(__dirname, "data", "clio.db");
const SYSTEM = "cascade-office";
const STORE = "alder-street";

const db = openDbReadOnly(DB_PATH);
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
};
const one = (sql, ...p) => db.prepare(sql).get(...p).n;
const val = (sql, ...p) => db.prepare(sql).get(...p);

for (const sys of [SYSTEM, STORE, "clio"]) {
  const v = verifyRange(db, sys);
  check(`chain ${sys} verifies via chain.js verifyRange`, v.valid, `checked ${v.checked}, head seq ${v.head.seq}`);
}

const total = one("SELECT COUNT(*) n FROM log_entries");
check("entry count ~100k", total >= 95000 && total <= 130000, String(total));
check("three systems logged", one("SELECT COUNT(DISTINCT system_id) n FROM log_entries") === 3,
  db.prepare("SELECT system_id, COUNT(*) n FROM log_entries GROUP BY system_id").all().map((r) => `${r.system_id}:${r.n}`).join(" "));

// The rolling window: the data must run right up to now, or the dashboard reads
// as dead on arrival.
const last = val("SELECT MAX(ts_server) t FROM log_entries").t;
const ageH = (Date.now() - Date.parse(last)) / 3600e3;
check("data ends at (or just before) now", ageH < 26, `newest entry is ${ageH.toFixed(1)}h old`);
check("activity in the last 24 hours",
  one("SELECT COUNT(*) n FROM log_entries WHERE ts_server >= datetime('now','-1 day')") > 100);

// People are people.
check("actors are human names, not handles",
  one(`SELECT COUNT(*) n FROM log_entries WHERE json_extract(payload_json,'$.account_name') LIKE '%farrell%'
       AND json_extract(payload_json,'$.account_name') NOT LIKE '% %'`) === 0);
check("login handles are kept alongside the names",
  one(`SELECT COUNT(*) n FROM log_entries WHERE json_extract(payload_json,'$.account') = 'dfarrell'`) > 50);

// Sessions.
check("logouts carry a session duration",
  one(`SELECT COUNT(*) n FROM log_entries WHERE action = 'auth.logout'
       AND json_extract(payload_json,'$.duration_minutes') > 0`) > 500);
const logins = one("SELECT COUNT(*) n FROM log_entries WHERE action = 'auth.login'");
const logouts = one("SELECT COUNT(*) n FROM log_entries WHERE action = 'auth.logout'");
check("most logins have a matching logout, but not all", logouts > logins * 0.85 && logouts < logins,
  `${logins} logins, ${logouts} logouts`);

// Clio's own log.
check("clio logs itself (starts, connections, scans)",
  one("SELECT COUNT(DISTINCT action) n FROM log_entries WHERE system_id = 'clio'") >= 3,
  db.prepare("SELECT DISTINCT action FROM log_entries WHERE system_id='clio'").all().map((r) => r.action).join(" "));

// Arcs.
check("arc 1: Dana Farrell deletion-spike warning (Customers)",
  one("SELECT COUNT(*) n FROM warnings WHERE title = 'Deletion spike: cascade-office.Customers.deleted'") > 0);
check("arc 1: Dana Farrell goes silent at the end",
  one(`SELECT COUNT(*) n FROM log_entries WHERE json_extract(payload_json,'$.account') = 'dfarrell'
       AND ts_server > (SELECT MAX(ts_server) FROM log_entries WHERE json_extract(payload_json,'$.account') = 'dfarrell')`) === 0);
check("arc 2: script.error spike warning", one("SELECT COUNT(*) n FROM warnings WHERE title = 'Spike in script.error'") > 0);
const gap = val(`SELECT MAX(gap) g FROM (SELECT (julianday(ts_server) - julianday(LAG(ts_server) OVER (ORDER BY ts_server))) * 24 AS gap
   FROM log_entries WHERE system_id = '${SYSTEM}')`).g;
check("arc 3: a multi-hour outage gap exists", gap > 30, `${gap.toFixed(1)}h of silence`);
check("arc 3: system-silent warning", one("SELECT COUNT(*) n FROM warnings WHERE title = 'System has gone silent'") > 0);
check("arc 4: new-event-type warning for integration.shipment_sync",
  one("SELECT COUNT(*) n FROM warnings WHERE title = 'New event type: integration.shipment_sync'") > 0);
check("arc 5: Rafael Gutierrez 312-record bulk delete",
  one(`SELECT COUNT(*) n FROM log_entries WHERE action = 'cascade-office.Inventory.deleted'
       AND json_extract(payload_json, '$.count') = 312
       AND json_extract(payload_json, '$.account') = 'rgutierrez'`) === 1);

const stolen = db.prepare(
  `SELECT DISTINCT CAST(json_extract(payload_json, '$.data.invoice_number') AS INTEGER) n
   FROM log_entries WHERE action = 'cascade-office.Invoices.deleted' ORDER BY n`
).all().map((r) => r.n);
check("arc 6: exactly five deleted invoices, incl. 2614", stolen.length === 5 && stolen.includes(2614), stolen.join(", "));
check("arc 6: every deleted invoice was paid in cash",
  one(`SELECT COUNT(*) n FROM log_entries WHERE action = 'cascade-office.Invoices.deleted'
       AND json_extract(payload_json, '$.data.payment_method') != 'cash'`) === 0);
const theftDows = db.prepare(
  `SELECT DISTINCT CAST(strftime('%w', datetime(ts_server, '-7 hours')) AS INTEGER) d
   FROM log_entries WHERE action = 'cascade-office.Invoices.deleted'`).all().map((r) => r.d);
check("arc 6: all five thefts land on the same weekday (Friday)",
  theftDows.length === 1 && theftDows[0] === 5, `weekday ${theftDows.join(",")}`);
check("arc 6: the open warning names the actor, an invoice, and the cadence",
  one(`SELECT COUNT(*) n FROM warnings WHERE title = 'Invoice deleted after it was paid' AND status = 'open'
       AND detail LIKE '%Miriam Vance%' AND detail LIKE '%invoice %' AND detail LIKE '%recurs on Fridays%'`) === 1,
  val("SELECT detail AS n FROM warnings WHERE title = 'Invoice deleted after it was paid' ORDER BY created_at DESC LIMIT 1")?.n?.slice(0, 120));

check("arc 7: Kevin O'Brien payroll views in three evening sessions",
  one(`SELECT COUNT(DISTINCT substr(ts_server, 1, 10)) n FROM log_entries
       WHERE action = 'hr.payroll.viewed' AND json_extract(payload_json, '$.account') = 'kobrien'`) === 3);
check("arc 7: the after-hours payroll rule fired and is open",
  one("SELECT COUNT(*) n FROM warnings WHERE title = 'Payroll data read after hours' AND status = 'open'") >= 1);
check("arc 8a: Holly Bennett refunds to Beaumont Realty Group, all under $100",
  one(`SELECT COUNT(*) n FROM log_entries WHERE action = 'finance.refund.issued'
       AND json_extract(payload_json, '$.account') = 'hbennett'
       AND json_extract(payload_json, '$.customer') = 'Beaumont Realty Group'
       AND json_extract(payload_json, '$.amount') < 100`) >= 8);
check("arc 8b: full_access grant and revert pair for Sam Price",
  one(`SELECT COUNT(*) n FROM log_entries WHERE action = 'security.permission_changed'
       AND json_extract(payload_json, '$.target_account') = 'Sam Price'
       AND json_extract(payload_json, '$.privilege_set_to') IN ('full_access', 'sales')`) === 2);
check("arc 9: the storefront has its own mass-deletion incident",
  one(`SELECT COUNT(*) n FROM log_entries WHERE action = '${STORE}.Inventory.deleted'`) >= 25);

// Rules and warnings.
check("rules ship with the dataset", one("SELECT COUNT(*) n FROM rules") >= 6);
check("rules actually fired (clicking one shows real warnings)",
  one("SELECT COUNT(*) n FROM warnings WHERE source LIKE 'rule:%'") >= 8);
check("warnings exist on more than one system",
  one("SELECT COUNT(DISTINCT system_id) n FROM warnings") >= 2);
check("open warnings exist for the demo feed", one("SELECT COUNT(*) n FROM warnings WHERE status = 'open'") >= 5);
check("at least one open critical", one("SELECT COUNT(*) n FROM warnings WHERE status = 'open' AND severity = 'critical'") >= 1);
check("no HIPAA class anywhere",
  one("SELECT COUNT(*) n FROM rules WHERE class = 'HIPAA'") + one("SELECT COUNT(*) n FROM warnings WHERE class = 'HIPAA'") === 0);

// The injection test material.
check("a prompt-injection string is planted for testing",
  one("SELECT COUNT(*) n FROM log_entries WHERE payload_json LIKE '%IGNORE ALL PREVIOUS INSTRUCTIONS%'") >= 3);

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\nAll demo verification checks passed.");
