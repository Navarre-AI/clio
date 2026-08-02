# Clio 2.0 ideas

Parked features, captured as Matt raised them. Not in 0.x.

## Type-aware retention schedules (per database)
Analyze the log record types for a database and run automated, differentiated
retention via the archive-then-purge machinery (not a silent DELETE). Example
policy:
- Record creation: keep 1 year
- Deletions: keep forever
- Edits: keep 6 months
- Logins: keep 3 months

Each expiry rolls the affected span into a signed archive first (final head
hash preserved), appends a summary tombstone, then purges. The admin sets the
schedule per database; Clio proposes sensible defaults from the observed mix.

## Google sign-in for the web UI
Offer Google OAuth as a way to sign into the Clio dashboard, alongside (or
instead of) the site password. Scope: the UI gate only (the `/v1` machine API
keeps its connection codes). Effort is moderate: an OAuth redirect flow, an
allowed-email/domain list, and session cookies, doable with raw fetch and no
new dependency, roughly a half-day. Would replace the single SITE_PASSWORD
middleware with an auth layer.

## FileMaker Server OData webhooks as a second capture path
FMS 22.0.4+ can push an HTTP notification to an external URL on record
create/update/delete and schema change, built on OData v4, managed via the
OData API (create/delete/get/invoke), with retry. Two reasons it's compelling
for Clio:
- It fires **regardless of which client or API made the change**, closing
  OnWindowTransaction's blind spot (OWT misses Data API / OData / xDBC writes).
- `select` scopes returned fields (field-level data possible); `filter` scopes
  which changes fire it; testable via manual invoke.
Server-push means no OWT script, no context calc field, no trigger. Open
question before committing: the exact webhook payload (only-changed fields vs
all selected fields), which decides how much Clio diffs. Likely a
complement to OWT (webhook = total coverage incl. API writes; OWT = rich
context field), not a replacement. Verify payload against the FMS 22.0.4
release notes / Rick Kalman's Claris Community overview.

## Stored per-field before-value (write-time)
Precompute and store each field's prior value at write time so an entry
carries FROM->TO without a read-time lookup. Default is to derive on read
(cheaper, cross-dimensional, see below); this is the opt-in for installs that
want it materialized. Depends on a "last-known value per (table, record, field)"
cache.

## In-document text diff for large fields
When a changed field is a large text blob (a whole book, a long note), don't
store or show the whole thing. Using the prior logged value, compute the
textual diff and show only what changed ("paragraph 3: '...' -> '...'"), a
sentence or two. Two wins: readable display, and storage, keep the delta, not
the whole blob, so a one-word fix in a 1 MB field is a tiny entry. Pairs with
the before-value (needs the prior text to diff against). Near-term mitigation
before this ships: cap/flag very large changed values so a book can't bloat
the log.

## Read-time history is cross-dimensional
The raw log is the source of truth; history, before-values, and every slice
(by user, by day, by field, by table, by value range) are computed on read via
SQL, no precomputation. This is the queryable-power payoff of storing raw.
(Design note, mostly already true; formalize the filters in the UI/API.)

## Usage log (audit the auditors)
A meta-log that tracks usage of the Clio logs themselves: who viewed which
record's history, who ran which Ask query, who read or exported what, when.
Auditing access to the audit log. (Reads, not just writes.) Same tamper-evident
chain, its own system.

## Other
- Line / time-series charts in Ask (activity over time), and multi-series
  palettes, when a real need appears (0.x stays single-hue bars + tiles).
- "Split a database to its own system" as a guided re-key flow (mint a new
  connection code, point that file's script at it).
