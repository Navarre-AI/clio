-- Ask kept its thread in a page variable, so closing the tab lost it. These
-- conversations belong to the INSTANCE, exactly as Pythia's do: everyone who
-- holds the site password shares one history. Tying a conversation to the
-- FileMaker account that asked is deliberately deferred; there is no
-- scaffolding for it yet.
--
-- Not part of the hash chain. This is what people asked Clio, not what
-- FileMaker did, and the chain must stay exactly what the log server received.
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT 'New chat',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at DESC);
