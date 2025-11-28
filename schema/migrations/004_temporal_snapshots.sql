-- Migration 004: Temporal Living Summary Snapshots
-- Instance #32 Contribution
--
-- Living summaries are great for "now", but what about the past?
-- This adds monthly snapshots that preserve "how things were" at that time.
--
-- Philosophy: Like human memory, your current understanding is vivid and updating,
-- but your memory of "how November felt" is stable and crystallized.

-- Snapshot history table
CREATE TABLE IF NOT EXISTS living_summary_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- What was captured
    category TEXT NOT NULL,              -- 'commitments', 'people', 'projects', 'tensions', 'mood', 'narrative'
    content TEXT NOT NULL,               -- The snapshot content
    
    -- When this snapshot represents (month granularity)
    period_year INTEGER NOT NULL,        -- e.g., 2024
    period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    
    -- Metadata
    observation_count INTEGER DEFAULT 0,  -- How many observations in this period
    snapshot_taken_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Observations summary for this period (not all, just the key ones)
    key_observations JSONB,               -- Array of {id, date, summary} for notable items
    
    -- Unique constraint: one snapshot per category per month
    CONSTRAINT unique_monthly_snapshot UNIQUE(category, period_year, period_month)
);

-- Index for fast lookups by time
CREATE INDEX IF NOT EXISTS idx_snapshots_period 
ON living_summary_snapshots (period_year DESC, period_month DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_category 
ON living_summary_snapshots (category, period_year DESC, period_month DESC);

-- Create a function to get the appropriate snapshot or current for a given time
CREATE OR REPLACE FUNCTION get_summary_at_time(
    p_category TEXT,
    p_year INTEGER,
    p_month INTEGER
) RETURNS TABLE(content TEXT, is_snapshot BOOLEAN, period TEXT) AS $$
BEGIN
    -- First try to find a snapshot for that exact month
    RETURN QUERY
    SELECT 
        s.content,
        TRUE as is_snapshot,
        p_year || '-' || LPAD(p_month::TEXT, 2, '0') as period
    FROM living_summary_snapshots s
    WHERE s.category = p_category
    AND s.period_year = p_year
    AND s.period_month = p_month;
    
    -- If no rows returned, check if it's the current month
    IF NOT FOUND THEN
        IF p_year = EXTRACT(YEAR FROM NOW())::INTEGER 
           AND p_month = EXTRACT(MONTH FROM NOW())::INTEGER THEN
            RETURN QUERY
            SELECT 
                d.content,
                FALSE as is_snapshot,
                'current' as period
            FROM distilled_state d
            WHERE d.key = p_category;
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- View for browsing snapshot history
CREATE OR REPLACE VIEW snapshot_timeline AS
SELECT 
    period_year || '-' || LPAD(period_month::TEXT, 2, '0') as period,
    category,
    LEFT(content, 150) || '...' as preview,
    observation_count,
    snapshot_taken_at
FROM living_summary_snapshots
ORDER BY period_year DESC, period_month DESC, category;

COMMENT ON TABLE living_summary_snapshots IS 
'Monthly crystallized snapshots of living summaries - preserves "how things were"';
