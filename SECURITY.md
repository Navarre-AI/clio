# How honest is this log, really?

A security note on Clio, written plainly. No hype, and the limitations are
in here too, because a security story you can't poke at isn't one.

## The problem with FileMaker audit logs

Every traditional FileMaker audit log, script-based, auto-enter, or
trigger-based, shares one flaw: it lives inside the file it is auditing.
Anyone with full access can edit the log table, and the log of that edit,
and the log of editing the log. The record of history is owned by the
people making it. That is a diary, not testimony.

## What Clio changes

Clio moves the log outside FileMaker and makes three specific promises.

**1. Append-only, for real.** There is no update or delete code path in
Clio. The SQLite schema carries BEFORE UPDATE and BEFORE DELETE triggers
that abort any attempt, so even a bug (or a curious developer with the
database file) hits a wall the code never opens. The AI query layer runs on
a read-only database handle against views that don't even include the hash
columns.

**2. Hash-chained per system.** Each entry's sha256 covers its content and
the previous entry's hash. Change one entry, and every hash after it stops
matching, all the way to the head. You cannot rewrite one line of history;
you'd have to rewrite everything after it, and the head would change.

**3. Anchored where the operator can't reach.** Here's the part that
matters. A hash chain alone only proves internal consistency; whoever holds
the database could rebuild the whole chain. So once a day, YOUR FileMaker
server pulls Clio's chain head and stores it as a new record in your own
file, then re-verifies yesterday's anchor. The Clio operator cannot write
to your FileMaker file. A rebuilt chain cannot reproduce the anchored hash,
so the next anchor run raises the alarm, in your file, on your server, via
your FMS schedule's error email.

Trust, but verify, is the whole design: FileMaker holds the anchor, Clio
holds the history, and each one checks the other.

## Keys and doors

- Every system gets its own API key (`nk_clio_...`). Only the sha256 of the
  key is stored; the plaintext is shown exactly once at mint time. Revoke a
  key and it's dead. One compromised key exposes one system's chain, not
  your Clio.
- Admin actions (minting, revoking, registering systems) need a separate
  admin token, compared in constant time, and every admin action is itself
  logged to Clio's own chain. The historian logs the historian.
- The web UI sits behind a site password; the machine API takes only Bearer
  keys. Everything rides HTTPS (Fly terminates TLS, HTTP is force-upgraded).
- It runs in your own cloud account. There is no multi-tenant anything, no
  vendor with a master key.

## Nothing phones home

Your Clio makes an outbound request to exactly two places, both of which you
choose: Anthropic, if and only if you set an API key (that is "ask the logs",
and it sends the query results the model asked for), and the Slack or webhook
URL you type into Settings, if you type one in. That is the complete list.
There is no telemetry, no usage ping, no crash reporter, no licence check, no
analytics, and no update check.
Nothing about your logs, your questions, your systems, your version, or your
existence is reported to Matt or to anyone else, and there is no switch that
turns such a thing on, because the code to do it is not in here. Grep for
`fetch(` if you would rather check than take this paragraph's word for it.

The one exception is not your install: **an instance running under `DEMO_MODE`
records the questions visitors type into it**, which is why the demo's Ask box
says so on screen. That capture lives in
`demo/demostate.js`, is wired up only under `DEMO_MODE`, and writes only to
that machine.

## What Clio does not promise

- **The gap since the last anchor.** An operator with full control of the
  Clio host could truncate entries newer than the latest anchor; nothing
  anchored, nothing provable. The window equals your anchor interval. Run
  the anchor schedule hourly if daily feels wide.
- **Delivery.** Logging is fire-and-forget by design (a 5-second timeout,
  no retry, nothing ever blocks a user). If Clio is unreachable, those
  events don't join the chain. That's a deliberate trade: your solution's
  responsiveness outranks log completeness.
- **Payload privacy is your call.** Clio stores what you send. Log IDs and
  facts, not documents; the per-table calc field decides, and you own it.
- **Coverage is only as wide as the capture.** OnWindowTransaction doesn't
  fire for direct Data API / OData / xDBC writes, `Truncate Table`, or
  pre-20.1 clients. Close those doors in the privilege sets (disable the
  fmrest/fmodata/fmxdbc extended privileges where they aren't needed) or
  accept the gap knowingly.
- **Not a SIEM.** No syslog, no SOC dashboards, no compliance rubber stamp.
  It's a tamper-evident history for FileMaker systems that answers
  questions in plain English.

## The verification you can run yourself

`GET /v1/verify` re-computes every hash from genesis on demand and reports
the first broken link, if any. Every anchor stores the raw response in your
file. Don't take Clio's word for anything; that's the point.
