-- Excluding a system is a view setting for this dashboard, never a logging
-- setting. Entries keep arriving and the chain keeps growing; these views only
-- change what the AI is shown.
--
-- Enforced in the view rather than in the prompt, so an excluded system is not
-- merely discouraged, it is unreachable. "Ask the logs" and the Systems list
-- can then never disagree about what is in scope.
DROP VIEW IF EXISTS v_logs;
CREATE VIEW v_logs AS
  SELECT system_id, seq, ts_client, ts_server, category, action, payload_json
  FROM log_entries
  WHERE system_id NOT IN (SELECT system_id FROM systems WHERE display = 0);

-- Warnings are the deliberate exception. A critical finding escapes exclusion
-- and is always visible: a system someone stopped watching is exactly where a
-- serious problem goes unnoticed, and the developer will want to know.
DROP VIEW IF EXISTS v_warnings;
CREATE VIEW v_warnings AS
  SELECT system_id, severity, title, detail, status, created_at
  FROM warnings
  WHERE severity = 'critical'
     OR system_id NOT IN (SELECT system_id FROM systems WHERE display = 0);
