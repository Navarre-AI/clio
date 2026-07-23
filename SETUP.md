# Setting up the FileMaker side

Clio needs nothing installed in FileMaker: no plugin, no extra account, no
extended privileges. FileMaker only ever calls out to Clio over HTTPS.

## 1. Deploy Clio

`node setup.mjs` (Fly.io) or run the Docker image anywhere with a persistent
volume at `DATA_DIR`. The installer prints the two values below.

## 2. Add the settings

Create the one-record `ClioSettings` table with global text fields:

- `ClioURL`, e.g. `https://clio-acme.fly.dev`
- `ClioAPIKey`, the `nk_clio_...` key minted at install

One key per system. A "system" is whatever should share one tamper-evident
chain; usually one solution, even if it spans several files.

## 3. Add the two scripts

Follow the specs in `filemaker/`:

- `Clio Log.md`: the fire-and-forget logging script. Call it anywhere you
  want history recorded: record deletes, permission changes, logins, exports,
  script failures. One line: `Perform Script [ "Clio Log" ; Parameter: <json> ]`.
- `Clio Daily Anchor.md`: the anchor + verify + scan script, plus its
  `ClioAnchor` table.

## 4. Schedule the anchor

FileMaker Server Admin Console, Script Schedules: run `Clio Daily Anchor`
daily (hourly if you want a tighter tamper window), with email notification
on error enabled. A non-empty exit result from the script means the anchor
failed or, worse, verification failed; that email is the alarm.

## 5. Optional: other sidecars

Pythia (and any navarre-sidecars service) ships its own audit events to Clio
when you set two environment variables on that service:

```
CLIO_URL=https://clio-acme.fly.dev
CLIO_API_KEY=nk_clio_...   (mint a separate key, system_id e.g. "pythia")
```

## Answers to fair questions

- **What if Clio is down?** Logging scripts time out after 5 seconds and
  carry on; nothing in FileMaker blocks. Events sent while Clio is down are
  lost from the chain (fire-and-forget is the point); the anchor script will
  still verify history the next time it runs.
- **What does Clio know about my data?** Only what you put in payloads. Log
  IDs and facts, not documents. The payload is yours to shape.
- **Can I read the logs from FileMaker?** Yes: `GET /v1/logs` with the same
  Bearer key, `Insert from URL`, parse with `JSONGetElement`.
