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

## Other
- Line / time-series charts in Ask (activity over time), and multi-series
  palettes, when a real need appears (0.x stays single-hue bars + tiles).
- "Split a database to its own system" as a guided re-key flow (mint a new
  connection code, point that file's script at it).
