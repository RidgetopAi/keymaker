-- Migration 003: Performance indexes for deduplication and queries
-- Instance #38: VPS performance optimization

-- Index for fast deduplication check (content + recent time)
-- This enables sub-millisecond checks for duplicate content
CREATE INDEX IF NOT EXISTS idx_observations_content_created 
ON observations (content, created_at DESC);

-- Hash index for exact content matching (faster than btree for equality)
CREATE INDEX IF NOT EXISTS idx_observations_content_hash 
ON observations USING hash (content);

-- Partial index for recent observations (most queried)
CREATE INDEX IF NOT EXISTS idx_observations_recent 
ON observations (created_at DESC) 
WHERE created_at > NOW() - INTERVAL '30 days';

-- Index for digestion log to prevent re-processing
CREATE INDEX IF NOT EXISTS idx_digestion_log_observation 
ON digestion_log (observation_id);
