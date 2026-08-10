-- The systems registry: one row per logged system (chain). A "system" is
-- usually one database file on one FileMaker Server; many databases on many
-- servers all log to this one Clio, each with its own key and chain.
-- Additive: the api_keys table (chassis-verbatim) is untouched; system_id
-- remains the join.
CREATE TABLE IF NOT EXISTS systems (
  system_id  TEXT PRIMARY KEY,
  label      TEXT,
  fm_server  TEXT,                        -- e.g. fms.example.com
  fm_file    TEXT,                        -- e.g. Operations
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
