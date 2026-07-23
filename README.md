# Clio

Inviolate logs that live outside FileMaker. Patterns, warnings, answers.

Named for the Muse of history, the one drawn holding an open scroll. The dirty
secret of every FileMaker audit log is that it lives inside the file it is
auditing, where any full-access developer can quietly rewrite history. Clio
lives outside. The historian does not take edits from the people she is
writing about.

What it is not: another log table. Log tables are diaries. Clio is testimony.

## How it works

- **Append-only API.** FileMaker sends events with one `Insert from URL`
  script (`filemaker/Clio Log.md`). Update and delete don't exist in the code,
  and the database schema refuses them too.
- **Hash-chained per system.** Every entry's hash covers its content and the
  previous entry's hash. Any number of systems, each with its own key and its
  own tamper-evident chain, all logging to one Clio. Spec: `CHAIN.md`.
- **Daily anchor.** A FileMaker Server schedule stores Clio's chain head
  inside your own file and re-verifies yesterday's anchor
  (`filemaker/Clio Daily Anchor.md`). Even the server operator rewriting
  history would be caught.
- **The pulse, not just the record.** A daily pattern scan compares the last
  24 hours against a 14-day baseline (error spikes, brand-new event types,
  systems gone silent) and files warnings. With an Anthropic key, AI words the
  warnings and answers questions about the logs; without one, plain thresholds
  still warn. The AI never computes a number (`RULES.md`).
- **Yours.** Runs in your own cloud account. One tiny Node service, one
  npm dependency (express), SQLite via `node:sqlite`, one Docker image.

## Quick start (local)

```
npm install
node setup.mjs --local     # writes .env with a fresh ADMIN_TOKEN
npm start
```

Mint a key (the setup script prints this command with your token):

```
curl -s -X POST localhost:8080/v1/admin/keys \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"system_id":"my-system","label":"first key"}'
```

Log something:

```
curl -s -X POST localhost:8080/v1/log \
  -H "Authorization: Bearer nk_clio_..." \
  -H "Content-Type: application/json" \
  -d '{"entries":[{"event_id":"e-1","category":"crm.order","action":"crm.order.created","payload_json":"{\"order\":101}"}]}'
```

Open `http://localhost:8080` for the UI. Run the tests with `npm test`.

## Deploy (Fly.io)

```
node setup.mjs
```

Creates the app and volume, sets secrets, deploys, mints your first key, and
prints the two values the FileMaker side needs. Scale-to-zero friendly: the
machine sleeps until FileMaker's next request wakes it.

## API

Machine surface, `Authorization: Bearer <key>`, envelope `{ok, data|error}`:

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/log` | key | Append a batch `{entries:[...]}` (max 500) |
| `GET /v1/head` | key or admin | Current chain head for the key's system |
| `GET /v1/verify?expect_seq=&expect_hash=` | key or admin | Recompute the whole chain, check an anchor |
| `GET /v1/logs?action=&since=&q=&limit=` | key or admin | Read entries |
| `GET /v1/warnings` | key or admin | Open warnings |
| `POST /v1/scan` | key or admin | Run the daily pattern scan (deduped per day) |
| `POST /v1/admin/keys`, `GET`, `DELETE /:id` | admin | Mint (plaintext shown once) / list / revoke |
| `GET /health`, `GET /v1/info` | none | Liveness and version |

Admin callers pass `?system_id=`; key callers are scoped to their own system.
The ingest contract matches the navarre-sidecars chassis shipper exactly:
point any sidecar's `CLIO_URL` + `CLIO_API_KEY` here and its audit events flow
in unchanged.

## Many databases, many servers

One Clio serves any number of FileMaker files on any number of servers.
Each database is a "system": its own API key, its own independent chain,
its own anchor schedule. The systems registry (admin section of the UI, or
`POST /v1/admin/systems`) records which server and file each chain belongs
to; minting a key registers its system in the same call. Clio never
connects to FileMaker; every file pushes to Clio, so a new server is just a
new key.

## FileMaker side

Three scripts, fully specified in `filemaker/`:

- `Clio Log.md`: the one fire-and-forget logging script for event-shaped
  history (logins, exports, failures).
- `Clio Window Transactions.md`: the OnWindowTransaction file trigger that
  turns every committed record change into chain entries automatically,
  with per-table payloads from an unstored calc field.
- `Clio Daily Anchor.md`: the daily anchor + verify + scan schedule.

Server setup notes: `SETUP.md`. Security model and its honest limits:
`SECURITY.md`.
