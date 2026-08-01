-- Warnings can now come from a rule, not just an automatic detector.
-- source: "auto:<kind>" or "rule:<rule_id>"; class: optional label like "HIPAA".
ALTER TABLE warnings ADD COLUMN source TEXT;
ALTER TABLE warnings ADD COLUMN class TEXT;
