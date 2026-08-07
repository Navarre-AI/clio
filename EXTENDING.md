# Extending Clio

Clio is meant to be forked. It is small on purpose (one runtime dependency, no
build step, a UI in a single file) so that you and an AI coding tool can read
the whole thing in one sitting and change it with confidence.

This doc is the map: what each file owns, where the seams are, and where you
would start for the extensions people ask about most. The recipes below are
**not** shipped features and several are deliberately not on Clio's own
roadmap. They are here because the code is yours and these are the doors.

## The one principle that must survive every change

**The log is testimony, and every number is deterministic SQL.**

Two halves, both load-bearing:

1. **Append-only, with exactly one door.** There is no update path at all, and
   no delete path reachable with an API key: not in the routes, not in
   `chain.js`, and not in the schema (SQLite triggers refuse `UPDATE` and
   `DELETE` on the entries table). If you add a feature that needs to change a
   past entry, you have not found a missing feature, you have found the point
   of the project. Append a correcting entry instead.

   The single exception is deliberate and worth understanding before you touch
   it: an admin can archive a system and then purge it (see the retention
   recipe below). It requires the admin token, names the system in a
   confirmation string, restores the trigger immediately, and is scoped to one
   system. That is the whole escape hatch. Keep it to one, keep it loud, and
   never widen it to something a logging key can reach.
2. **AI words things; it never counts them.** The model turns findings into
   sentences and questions into filters. Every count, rate, and comparison
   comes from SQL. Keep that split (`RULES.md` is the contract) and Clio stays
   evidence. Break it and it becomes a chatbot with opinions about your data.

One more that is easy to trip over: **the canonical hash form is frozen.**
`canonical()` in `chain.js` defines exactly what bytes get hashed. Change the
field order, the separator, or the stringification and every existing chain
fails verification forever. Add new columns alongside the hashed ones, never
inside them.

## The map

| File | Owns |
|---|---|
| `server.js` | The Express app: every route, auth (`keyAuth`/`ingestAuth`/`adminAuth`), ingest and its normalizers (`normalizeBody`, `normalizeTxn`, `diffRecords`), the SSE feed (`emit`), and the notification channels (`channels`/`postJson`/`deliver`). |
| `chain.js` | The tamper-evidence itself: `canonical`, `entryHash`, `appendBatch`, `head`, `verifyRange`. Frozen format. Spec in `CHAIN.md`. |
| `db.js`, `migrations/` | SQLite via `node:sqlite`. Migrations are numbered and run in order; the append-only triggers live here. |
| `rules.js` | The deterministic rule engine: `buildWhere` compiles a rule's match into SQL, `evaluateRule`/`runRules` fire it, `dryRun` counts what a rule *would* have caught. |
| `scan.js` | The daily pattern scan: `aggregatesForSystem` computes 24h-vs-14-day baselines in SQL, `warningsFromAggregates` turns those into warnings, `runScan` orchestrates and dedupes per day. |
| `ai.js` | Every Anthropic call. Wording warnings, answering questions, authoring rules conversationally. The only file that talks to a model. |
| `public/index.html` | The entire front end: markup, CSS, and JS in one file. No build step, no framework. |
| `filemaker/` | The FileMaker side, fully specified: the logging script, the OnWindowTransaction trigger, the daily anchor schedule. |

**Data flow, one event:** FileMaker `Insert from URL` → `POST /v1/log` →
`ingestAuth` resolves the key to a system → `normalizeBody` → `appendBatch`
hashes and links it → SSE `emit` wakes the UI. The scan and the rules run on
their own schedule over what has landed.

**There is no cron.** Timing is read-time and request-driven (see
`docs/WATCHDOG.md`). If you add a periodic job, follow that pattern rather than
introducing a scheduler.

## Extension recipes

Each names the goal, the seam, and the honest cost.

### A new alert channel (start here)
The smallest useful change in the codebase, and the best first PR. `channels()`
in `server.js` reads two URLs from prefs, `deliver()` fans out to them, and
`postJson()` does the sending. To add [ntfy](https://ntfy.sh) push, a Discord
webhook, or your own bus: add the pref, add a branch in `deliver()`, add the
field to the Settings panel in `public/index.html`. Everything is
fire-and-forget by design and must never block a scan. An hour, most of it in
the UI.

### Type-aware retention (`docs/ROADMAP-2.0.md`)
Different record types deserve different lifespans: deletions forever, edits
six months, logins three.

**The hard part is already built.** `POST /v1/admin/systems/:id/archive`
snapshots a system's whole log (counts by action, file, and actor, plus the
final head hash), returns the export, and appends a tombstone entry so the act
of archiving is itself on the chain. `POST /v1/admin/systems/:id/purge` then
removes that system's rows, dropping and immediately recreating the append-only
trigger inside a transaction. Admin-gated, and it refuses unless the body
carries `{ "confirm": "<system_id>" }`. Both are wired to the "Danger zone" in
each system's settings panel.

What retention adds on top is *selection and schedule*: today archive and purge
are all-or-nothing for one system, and retention needs them to act on a span
(everything older than N months, for these action types). Seam: a new module
beside `scan.js` that decides what expires, then drives the existing
archive-then-purge pair per span. Do not add a second delete path; there should
stay exactly one, and it should stay this one.

### Retroactive rule runs (`docs/ROADMAP-2.0.md`)
Today a new rule only sees new entries; `dryRun` in `rules.js` already counts
what it *would* have caught historically. Materializing those past matches as
real firings is mostly plumbing from `dryRun` into the firings table, with one
real decision: whether a retroactive firing is marked as such (it should be).

### Audit the auditors (`docs/ROADMAP-2.0.md`)
A meta-log of who read which history, ran which question, exported what. Same
chain machinery, its own system, so the reads get the same tamper-evidence the
writes have. Seam: `selfLog()` in `server.js` already exists for internal
events; this widens it and gives it a dedicated system.

### A second capture path: FileMaker Server OData webhooks
FMS 22.0.4+ can push an HTTP notification on record change and schema change.
That is a second, script-free way to feed Clio. Seam: a sibling to
`ingestTxn()` that normalizes the OData notification shape into entries. Worth
it if you want capture without touching the FileMaker file at all.

### Sign-in for the UI (`docs/ROADMAP-2.0.md`)
Today the dashboard is gated by a single site password; the machine API keeps
its own connection codes and is unaffected. Swapping that for Google OAuth with
an allowed-domain list is a redirect flow, a session cookie, and replacing one
middleware. Doable with raw fetch and no new dependency, roughly half a day.

### Diff large text fields in place (`docs/ROADMAP-2.0.md`)
When someone edits a 1 MB text field, `diffRecords()` currently logs the change
whole. Computing a textual delta against the prior logged value gives you both
a readable entry ("paragraph 3 changed") and a small one. Seam: `diffRecords()`
in `server.js`. Note the ordering constraint: you need the prior value stored
before you can diff against it.

### Semantic search over the log (`docs/ROADMAP-3.0.md`)
Embed each entry's human message and payload so questions can match on meaning:
"anything that looks like someone covering their tracks." Seam: a vector column
plus a new query path in `ai.js`. **The guardrail applies with full force here.**
Similarity is a suggestion, never a count. The deterministic filters stay.

### Behavioral sequences and learned baselines (`docs/ROADMAP-3.0.md`)
Beyond the fixed thresholds in `scan.js`: recognize meaningful chains (login →
large export → delete), and learn each user's normal rhythm so a dormant
account waking up is itself the signal. Seam: new detectors alongside
`warningsFromAggregates`. Start deterministic (sequence matching in SQL) before
reaching for anything learned; most of the value is in the first half.

### Entity resolution across systems (`docs/ROADMAP-3.0.md`)
One Clio already serves many files. Linking the same person or record across
them turns per-file history into estate-wide history. Seam: a resolution table
plus joins in `queryLogs`. Label every link as inferred, because it is.

## Working style

- **Run the tests.** `npm test`, no framework beyond `node:test`. The chain
  tests are the ones that matter: they prove tampering, gaps, and truncation
  are all caught. If a change makes them awkward to write, be suspicious of the
  change.
- **Prefer a new file over a new dependency.** The whole pitch is that you can
  audit this thing in an afternoon. Express is the one runtime dependency and
  it should stay that way unless something genuinely can't be done without.
- **Keep the UI one file.** No build step is a feature, not an oversight.
- **Read `SECURITY.md` before touching auth.** It documents the threat model
  and, more usefully, its honest limits.

License: see `LICENSE`. Attribution required, no resale without permission.
© 2026 Matt Navarre (www.navarre.ai)
