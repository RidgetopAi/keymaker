-- Distilled State: Living Summaries that evolve at write-time
-- This is the architectural shift from query-time recomputation to write-time memory
--
-- Instead of re-analyzing all observations every time you ask "what are my commitments?",
-- Keymaker now maintains evolving "living documents" that get updated when you add observations.
-- 
-- This makes Keymaker feel like a friend who remembers, not a search engine that recalculates.

CREATE TABLE IF NOT EXISTS distilled_state (
  key TEXT PRIMARY KEY,           -- 'commitments', 'people', 'projects', 'tensions', 'mood'
  content TEXT NOT NULL,          -- The living document (human-readable summary)
  last_observation_id UUID,       -- Track which observation last updated this
  observation_count INTEGER DEFAULT 0,  -- How many observations have been digested
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the initial living documents with empty states
INSERT INTO distilled_state (key, content) VALUES
  ('commitments', 'No commitments tracked yet.'),
  ('people', 'No people tracked yet.'),
  ('projects', 'No projects tracked yet.'),
  ('tensions', 'No tensions or open loops detected.'),
  ('mood', 'No mood patterns observed yet.')
ON CONFLICT (key) DO NOTHING;

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_distilled_state_updated 
ON distilled_state (updated_at DESC);

-- Digestion log: track what observations have been digested
-- This allows incremental digestion and rebuild from any point
CREATE TABLE IF NOT EXISTS digestion_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL REFERENCES observations(id),
  categories_touched TEXT[] NOT NULL,  -- ['commitments', 'people']
  digested_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_digestion_log_observation 
ON digestion_log (observation_id);

CREATE INDEX IF NOT EXISTS idx_digestion_log_time 
ON digestion_log (digested_at DESC);
