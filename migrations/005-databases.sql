-- Two tiers: a system (one connection code = one hash log) contains one or more
-- database FILES, discovered from the OnWindowTransaction payload's file name.
-- Files share their system's log; this table just names and counts them.
CREATE TABLE IF NOT EXISTS databases (
  system_id     TEXT NOT NULL,
  file_name     TEXT NOT NULL,          -- as it appears in the transaction payload
  friendly_name TEXT,                    -- editable display name
  first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
  entry_count   INTEGER NOT NULL DEFAULT 0,  -- lifetime, maintained on ingest (instant, no scan)
  acknowledged  INTEGER NOT NULL DEFAULT 0,  -- 0 until an admin has seen/named it
  PRIMARY KEY (system_id, file_name)
);
