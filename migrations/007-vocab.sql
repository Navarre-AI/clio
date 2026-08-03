-- The first derived layer: a shadow table of the distinct action vocabulary
-- seen per system, with counts. Maintained on ingest so History's type filter
-- and the rule/AshK vocabulary lookups are instant, not a scan of the whole log.
CREATE TABLE IF NOT EXISTS action_vocab (
  system_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (system_id, action)
);
