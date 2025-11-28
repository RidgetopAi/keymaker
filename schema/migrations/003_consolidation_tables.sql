-- Migration 003: Consolidation tables for memory "sleep" process
-- Instance #31 contribution

-- Track consolidation runs
CREATE TABLE IF NOT EXISTS consolidation_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Statistics
    patterns_detected INTEGER DEFAULT 0,
    stale_items_faded INTEGER DEFAULT 0,
    strengthened_items INTEGER DEFAULT 0,
    
    -- Outputs
    weekly_digest TEXT,
    pattern_details JSONB,
    
    -- Performance
    duration_ms INTEGER
);

-- Add staleness tracking to observations (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'staleness_score'
    ) THEN
        ALTER TABLE observations ADD COLUMN staleness_score FLOAT DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'last_consolidated_at'
    ) THEN
        ALTER TABLE observations ADD COLUMN last_consolidated_at TIMESTAMPTZ;
    END IF;
END $$;

-- Index for stale observation queries
CREATE INDEX IF NOT EXISTS idx_observations_staleness 
ON observations(staleness_score) WHERE staleness_score > 0.5;

-- Index for consolidation log lookups
CREATE INDEX IF NOT EXISTS idx_consolidation_created 
ON consolidation_log(created_at DESC);

COMMENT ON TABLE consolidation_log IS 'Tracks weekly memory consolidation runs - the "sleep" process that strengthens important memories and fades stale ones';
COMMENT ON COLUMN observations.staleness_score IS '0 = fresh/important, 1 = very stale. Updated during consolidation.';
