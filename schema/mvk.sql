-- Minimal Viable Keymaker Schema
-- Just observations + embeddings

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding vector(768),
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- Index for similarity search
CREATE INDEX IF NOT EXISTS idx_observations_embedding
ON observations USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Index for recent queries
CREATE INDEX IF NOT EXISTS idx_observations_created_at
ON observations (created_at DESC);
