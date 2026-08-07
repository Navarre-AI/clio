# Updates

The human-readable changelog. Newest first. The commit log has the detail;
this is the story.

## August 2026

- **Log Entries.** A full table over the raw entries: search, sort, filters.
- **Hardening.** Rules and warnings tightened, XSS fixes, the Clio license.

## July 2026

- **One key for everything.** A single universal key and one URL for all your
  files; Clio routes each entry to its system by file name. An unknown or
  missing key files the entry under "Unfiled" rather than bouncing it with a
  401. Never drop data is the rule that outranks tidiness.
- **Rules engine.** Deterministic evaluation, conversational rule authoring,
  dry-run before you commit to a rule, source and class recorded on every
  warning.
- **Notifications.** A Slack incoming webhook and a generic JSON webhook,
  both configured in Settings, with a test button. Off until you paste a URL.
- **Transaction capture.** `/v1/txn` takes FileMaker's raw
  OnWindowTransaction trigger JSON and turns it into per-record chain entries,
  with snapshot diffing so you see what actually changed.
- **A feed you can read.** Every row is a sentence: who did what to which
  record. Plumbing is muted by default.
- **The UI.** Systems landing, setup wizard, live feed over SSE, History,
  Ask the logs, and plain language throughout.

## June and July 2026: the core

Append-only `/v1/log`, per-system hash chains, verify, the daily anchor pull
for FileMaker, and the pattern scan that files warnings. The chain format is
frozen and specified in `CHAIN.md`; the threat model and its honest limits are
in `SECURITY.md`.
