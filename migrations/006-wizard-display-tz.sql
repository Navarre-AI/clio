-- New-database wizard: a file arrives "unplaced" until the admin names it and
-- either makes it its own system or links it to an existing one. placed=0 means
-- it still needs the wizard. system_display is which system it shows under
-- (null = the system whose key it arrived on).
ALTER TABLE databases ADD COLUMN placed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN system_display TEXT;

-- Per-system: a display toggle (Clio's own log ships hidden) and a timezone
-- offset (hours from UTC) for the watchdog's business-hours math and for
-- reading FileMaker's zone-less payload timestamps.
ALTER TABLE systems ADD COLUMN display INTEGER NOT NULL DEFAULT 1;
ALTER TABLE systems ADD COLUMN tz_offset INTEGER;

-- Clio's self-log exists but is hidden by default.
INSERT INTO systems (system_id, label, display) VALUES ('clio', 'Clio', 0)
  ON CONFLICT(system_id) DO UPDATE SET display = 0;

-- Visible rejects: failed/malformed posts, so a silent drop is never invisible.
CREATE TABLE IF NOT EXISTS rejects (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  system_id TEXT,
  code TEXT,
  message TEXT,
  snippet TEXT
);
CREATE INDEX IF NOT EXISTS idx_rejects_ts ON rejects(ts);
