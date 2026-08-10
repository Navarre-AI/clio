-- Warnings deduped on a stable finding identity, not on their wording.
--
-- The dedupe used to key on (system_id, source, title). That works while a
-- deterministic threshold writes the title, because the same condition always
-- produces the same string. With an Anthropic key the model writes the title,
-- and it words the same condition differently every night: "Login activity
-- silent", "Login activity has stopped", "Logins and logouts both silent".
-- Every variant looked new, so a persisting condition refiled daily and
-- acknowledgements never stuck. One live system reached 200+ warnings that
-- were about two conditions.
--
-- The fingerprint is derived from the DETECTOR, which never changes wording:
-- the aggregate's kind plus the action it concerns (rules use their rule id).
-- The AI title becomes display text only, which is the same split the rest of
-- Clio already enforces: the model words things, it never decides them.

ALTER TABLE warnings ADD COLUMN fingerprint TEXT;

-- Backfill from evidence already stored on every existing warning.
UPDATE warnings
   SET fingerprint = COALESCE(
         'rule:' || json_extract(evidence_json, '$.rule_id'),
         json_extract(evidence_json, '$.kind') || ':' ||
           COALESCE(json_extract(evidence_json, '$.action'), ''),
         'title:' || title
       )
 WHERE fingerprint IS NULL;

CREATE INDEX IF NOT EXISTS idx_warnings_fingerprint
  ON warnings(system_id, source, fingerprint, status);
