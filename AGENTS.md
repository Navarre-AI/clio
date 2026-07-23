# Clio, explained to an AI agent

You are probably an AI coding agent asked to install, integrate, or extend
Clio. Read this first; it is written for you.

## What this is

An append-only, hash-chained, tamper-evident log service for FileMaker
systems. Node >= 24, ESM, one npm dependency (express), SQLite via the
built-in `node:sqlite`. No SDKs; the Anthropic API is called with raw fetch.

## Map

- `server.js`: all routes. `/v1/*` is the machine surface (Bearer keys,
  envelope `{ok, data|error}`). `/api/*` + `public/index.html` is the UI
  surface (SITE_PASSWORD gate).
- `chain.js`: canonicalization, hashing, append, verify. Read `CHAIN.md`
  before touching it. Changing the canonical form breaks every existing
  chain; treat it as frozen.
- `db.js`: `node:sqlite` + numbered migrations in `migrations/`.
- `scan.js`: deterministic aggregates and threshold warnings.
- `ai.js`: the only file that talks to a model. `RULES.md` governs it.
- `filemaker/`: the FileMaker-side script specs.

## Contracts you must not break

1. **Ingest wire contract**: `POST /v1/log`, Bearer `nk_clio_<24 base62>`,
   body `{entries:[{event_id, ts_client, category, action, payload_json}]}`.
   The navarre-sidecars chassis shipper (`packages/chassis/src/audit.js`)
   posts exactly this and only checks `res.ok`. It must keep working
   unchanged.
2. **The canonical hash form** in `chain.js` (see `CHAIN.md`). Frozen.
3. **Append-only**: never add an update or delete path for `log_entries`.
   The schema triggers will abort you anyway.
4. **RULES.md**: the model never computes numbers and never writes.

## Install for a customer

```
npm install
node setup.mjs        # Fly.io: app, volume, secrets, deploy, first key
```

The installer prints `ClioURL` and `ClioAPIKey` for the FileMaker side, and
the admin token exactly once. Then build the two FileMaker scripts from
`filemaker/Clio Log.md` and `filemaker/Clio Daily Anchor.md`, and schedule
the anchor daily on FileMaker Server with email-on-error.

## Verify an install

```
npm test                                  # chain invariants
curl <url>/health                         # {ok:true,...}
POST /v1/admin/keys                       # mint (admin token)
POST /v1/log                              # append one event (the new key)
GET  /v1/verify                           # valid:true
```

Then run the FileMaker anchor script once by hand; it should create a
`ClioAnchor` record with status `first anchor`.
