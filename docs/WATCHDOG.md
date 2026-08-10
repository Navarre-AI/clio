# The watchdog: timed analysis and alerts

Clio's second job after remembering: noticing. This is usage auditing for
the database admin (who is doing what, and does it look right), not
performance monitoring. Server-log tools (Zabbix, FMS Detective) watch the
engine; Clio watches the people.

## How timing works (no cron anywhere)

The FMS schedule that runs `Clio Daily Anchor` also fires `POST /v1/scan`.
Daily by default; schedule it hourly for a tighter loop. Scans dedupe per
day unless forced, warnings accumulate in the warnings table, and anything
warn-or-critical goes out through `ALERT_WEBHOOK` the moment the scan
finishes (Slack incoming webhook, the Comm bus, anything that takes JSON).
The anchor script's email-on-error remains the tamper alarm; the webhook is
the behavior alarm.

## Shipped detectors (v1, deterministic SQL, AI words the findings)

| Detector | Fires when | Feeds on |
|---|---|---|
| `off_hours` | Activity outside BUSINESS_HOURS/BUSINESS_DAYS jumps past 3x its baseline | any events; weekend logins land here |
| `big_export` | An export/print/save/pdf-shaped action reports `payload.rows` >= threshold | `Clio Log` calls that include `rows` |
| `delete_spike` | A `.deleted` action runs 3x its daily baseline (min 10) | OnWindowTransaction entries |
| `error_spike` | Error-shaped actions (fail/denied/invalid) surge | login failures, script errors |
| `volume_spike` / `new_action` / `action_silent` / `system_silent` | Volume anomalies, brand-new event types, things going quiet | everything |

Config: `CLIO_TZ_OFFSET`, `BUSINESS_HOURS`, `BUSINESS_DAYS`,
`EXPORT_ROWS_THRESHOLD`, `ALERT_WEBHOOK` (all in `.env.example`).

## Next detectors, in rough order of value

Per-user detectors need `"user": Get ( AccountName )` in payloads (the AI
the example build guide already does this); they read it via
`json_extract(payload_json, '$.user')`.

1. **Dormant account wakes up.** An account with no activity in 30+ days
   suddenly acting, especially off-hours. Classic departed-employee signal.
2. **Per-user velocity.** Each account gets its own baseline (records
   touched per day); flag 10x days. A user who normally edits 20 records
   touching 2,000 is either doing year-end cleanup or something worse.
3. **Sequential walking.** One account modifying/viewing records across a
   table in tight sequence (scraping pattern): many records, short window,
   one table, one user.
4. **First-seen pairs.** First time an account acts from a new system, or
   an action appears for a user who never did it before ("bookkeeper
   suddenly deleting products").
5. **Schema-and-power events.** If logged (account created, privilege set
   changed, full-access login), always warn, no baseline needed.
6. **Mass modification bursts.** N modifies of one table inside M minutes
   by one account (Replace Field Contents shape), distinct from a spread-out
   busy day.
7. **Cross-system correlation.** Same account failing logins on one system
   then succeeding on another within minutes; only possible because many
   servers share one Clio.
8. **AI weekly digest.** Beyond alerts: a scheduled ask-the-logs run that
   writes a plain-English "week in review" (top users, growth, anomalies,
   chain status) and posts it to the webhook. The pulse, on a schedule.
9. **Roll-forward assist** (the dead fmDataGuard feature worth resurrecting):
   after restoring a backup, replay what changed since, from the chain, as
   a human-readable worklist.

## Ingesting existing logs (why analysis gets history)

`filemaker/Clio Import Log Table.md` pulls a solution's existing log table
(fmLog, Audit, a legacy `Log` table) onto the chain with original
timestamps preserved in `ts_client` and source-record UUIDs as `event_id`
(idempotent re-runs). The scan detectors and ask-the-logs then see years of
history on day one instead of starting blind, and the old table can retire.

## What we're deliberately not building

Server-log analytics. Soliant's Zabbix templates and Admin API tool, FMS
Detective, and the log-viewer FM files all watch FileMaker Server's own
text logs: CPU, calls, elapsed time, disconnects. Useful, different job,
already served. Clio stays on the question those tools can't answer:
what did the humans (and scripts) do to the data, and was it normal?
