-- Rules: admin-authored watchdog logic. Written by an AI conversation, but
-- stored fully structured so the scan engine fires them deterministically
-- (same inputs, same result, every run). The AI never evaluates a rule.
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,          -- the plain-English sentence shown in the list
  effect TEXT NOT NULL DEFAULT 'alert' CHECK (effect IN ('alert','highlight','mute')),
  severity TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','critical')),
  class TEXT,                          -- optional label, e.g. "HIPAA"
  enabled INTEGER NOT NULL DEFAULT 1,
  -- match: a structured spec the evaluator understands (see rules.js)
  --   { system, action_like, category_like, actor,
  --     off_hours, weekend, op, count_gte, window_minutes, rows_gte }
  match_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_fired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled);
