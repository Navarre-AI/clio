-- api_keys + meta are verbatim from navarre-sidecars chassis 001-chassis.sql
-- so the key model (and any future shared tooling) matches byte for byte.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  label TEXT,
  key_hash TEXT NOT NULL UNIQUE,
  require_signing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- The log. Append-only: no UPDATE/DELETE anywhere in the code, and the
-- schema itself refuses them. Every entry extends a per-system hash chain.
CREATE TABLE IF NOT EXISTS log_entries (
  system_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,          -- per-system, 1-based, dense
  event_id     TEXT NOT NULL,             -- client UUID (dedupe key)
  ts_client    TEXT NOT NULL DEFAULT '',  -- as received, hashed as received
  ts_server    TEXT NOT NULL,             -- ISO, assigned by Clio, in the hash
  category     TEXT NOT NULL DEFAULT '',
  action       TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '',  -- exact string stored at ingest, never re-serialized
  prev_hash    TEXT NOT NULL,             -- 64 hex; genesis links to 64 zeros
  entry_hash   TEXT NOT NULL,             -- sha256 hex, see CHAIN.md
  PRIMARY KEY (system_id, seq),
  UNIQUE (system_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_log_ts     ON log_entries(ts_server);
CREATE INDEX IF NOT EXISTS idx_log_action ON log_entries(system_id, action, ts_server);

-- "Update and delete don't exist in the code", and can't exist in the schema either.
CREATE TRIGGER IF NOT EXISTS log_no_update BEFORE UPDATE ON log_entries
  BEGIN SELECT RAISE(ABORT, 'log_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS log_no_delete BEFORE DELETE ON log_entries
  BEGIN SELECT RAISE(ABORT, 'log_entries is append-only'); END;

CREATE TABLE IF NOT EXISTS warnings (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_json TEXT NOT NULL,            -- the aggregate rows the finding cites
  scan_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',    -- open | acknowledged
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_warnings ON warnings(system_id, status, created_at);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  scan_date TEXT NOT NULL,                -- YYYY-MM-DD; dedupe key for the daily run
  systems_scanned INTEGER,
  findings INTEGER,
  status TEXT NOT NULL DEFAULT 'running'  -- running | done | error
);

-- What the AI layer is allowed to see: no hash columns, no key material.
CREATE VIEW IF NOT EXISTS v_logs AS
  SELECT system_id, seq, ts_client, ts_server, category, action, payload_json
  FROM log_entries;
CREATE VIEW IF NOT EXISTS v_warnings AS
  SELECT system_id, severity, title, detail, status, created_at
  FROM warnings;
