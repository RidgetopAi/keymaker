-- Migration: Change embedding dimensions from 1536 (OpenAI) to 768 (nomic-embed-text)
-- Instance #4 - 2025-11-23
--
-- This migration updates all embedding columns to use 768 dimensions
-- compatible with local nomic-embed-text model via Ollama

BEGIN;

-- Entity Registry tables
ALTER TABLE entities_people
    ALTER COLUMN embedding TYPE vector(768);

ALTER TABLE entities_projects
    ALTER COLUMN embedding TYPE vector(768);

ALTER TABLE entities_commitments
    ALTER COLUMN embedding TYPE vector(768);

ALTER TABLE entities_concepts
    ALTER COLUMN embedding TYPE vector(768);

-- Contradiction tracking
ALTER TABLE beliefs
    ALTER COLUMN embedding TYPE vector(768);

-- Main observations/events
ALTER TABLE observations
    ALTER COLUMN embedding TYPE vector(768);

-- Update system config to reflect new embedding model
UPDATE system_config
SET value = '768'
WHERE key = 'embedding_dimensions';

UPDATE system_config
SET value = 'nomic-embed-text'
WHERE key = 'embedding_model';

-- Rebuild indexes for new dimensions (IVFFlat needs rebuild after dimension change)
-- Note: Run REINDEX after migration if data exists
-- REINDEX INDEX idx_people_embedding;
-- REINDEX INDEX idx_projects_embedding;
-- etc.

COMMIT;
