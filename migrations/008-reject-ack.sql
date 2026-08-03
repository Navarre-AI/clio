-- Rejects are the red banner on Live: refused/malformed posts, kept so a silent
-- drop is never invisible. Once the operator has seen them they can acknowledge
-- them, which hides the banner without losing the record. ack = when acknowledged.
ALTER TABLE rejects ADD COLUMN ack TEXT;
