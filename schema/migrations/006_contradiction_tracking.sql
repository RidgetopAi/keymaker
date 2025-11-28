-- Migration 006: Contradiction and Belief Tracking
-- Instance #41 - Applies contradiction tracking with correct 768-dimension embeddings
--
-- This migration adds:
-- 1. Beliefs table - core beliefs about Brian
-- 2. Contradictions table - tracks conflicting beliefs
-- 3. Tension patterns - recurring themes of conflict
-- 4. Belief evolution tracking
-- 5. Views for active contradictions

BEGIN;

-- =====================================================
-- BELIEF TRACKING (Foundation for Contradictions)
-- =====================================================

CREATE TABLE IF NOT EXISTS beliefs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    statement TEXT NOT NULL,
    belief_type VARCHAR(50),
    entity_type VARCHAR(50),
    entity_id UUID,
    confidence FLOAT DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    source_type VARCHAR(50),
    source_context TEXT,
    source_id UUID,
    valid_from TIMESTAMP DEFAULT NOW(),
    valid_until TIMESTAMP,
    temporal_confidence FLOAT DEFAULT 1.0,
    is_active BOOLEAN DEFAULT TRUE,
    superseded_by UUID REFERENCES beliefs(id),
    embedding vector(768),  -- Using 768 for nomic-embed-text
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- CONTRADICTION TRACKING
-- =====================================================

CREATE TABLE IF NOT EXISTS contradictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    belief_a_id UUID REFERENCES beliefs(id) ON DELETE CASCADE,
    belief_b_id UUID REFERENCES beliefs(id) ON DELETE CASCADE,
    contradiction_type VARCHAR(50),
    severity VARCHAR(20),
    detection_method VARCHAR(50),
    detection_confidence FLOAT DEFAULT 0.5,
    explanation TEXT,
    impact_assessment TEXT,
    resolution_status VARCHAR(50) DEFAULT 'unresolved',
    resolution_notes TEXT,
    resolved_at TIMESTAMP,
    dominant_belief_id UUID,
    dominance_reason VARCHAR(100),
    detected_at TIMESTAMP DEFAULT NOW(),
    last_reviewed TIMESTAMP DEFAULT NOW(),
    CONSTRAINT unique_belief_pair UNIQUE(belief_a_id, belief_b_id),
    CHECK (belief_a_id < belief_b_id)
);

-- =====================================================
-- TENSION PATTERNS (Meta-level contradictions)
-- =====================================================

CREATE TABLE IF NOT EXISTS tension_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern_name VARCHAR(255),
    description TEXT,
    belief_categories TEXT[],
    occurrence_count INTEGER DEFAULT 1,
    first_detected TIMESTAMP DEFAULT NOW(),
    last_detected TIMESTAMP DEFAULT NOW(),
    example_contradiction_ids UUID[],
    typical_resolution VARCHAR(255),
    resolution_success_rate FLOAT,
    tension_classification VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- CONTEXT-DEPENDENT BELIEFS
-- =====================================================

CREATE TABLE IF NOT EXISTS belief_contexts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    belief_id UUID REFERENCES beliefs(id) ON DELETE CASCADE,
    context_type VARCHAR(50),
    context_value TEXT,
    context_weight FLOAT DEFAULT 0.5,
    evidence_count INTEGER DEFAULT 1,
    last_observed TIMESTAMP DEFAULT NOW(),
    CONSTRAINT unique_belief_context UNIQUE(belief_id, context_type, context_value)
);

-- =====================================================
-- BELIEF EVOLUTION TRACKING
-- =====================================================

CREATE TABLE IF NOT EXISTS belief_evolution (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_belief_id UUID REFERENCES beliefs(id),
    new_belief_id UUID REFERENCES beliefs(id),
    change_type VARCHAR(50),
    change_magnitude FLOAT,
    trigger_type VARCHAR(50),
    trigger_description TEXT,
    cascaded_changes UUID[],
    changed_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_beliefs_entity ON beliefs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_beliefs_active ON beliefs(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_beliefs_temporal ON beliefs(valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_beliefs_embedding ON beliefs USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

CREATE INDEX IF NOT EXISTS idx_contradictions_status ON contradictions(resolution_status);
CREATE INDEX IF NOT EXISTS idx_contradictions_severity ON contradictions(severity);
CREATE INDEX IF NOT EXISTS idx_contradictions_beliefs ON contradictions(belief_a_id, belief_b_id);

CREATE INDEX IF NOT EXISTS idx_belief_contexts_belief ON belief_contexts(belief_id);
CREATE INDEX IF NOT EXISTS idx_belief_evolution_original ON belief_evolution(original_belief_id);

-- =====================================================
-- HELPER FUNCTIONS
-- =====================================================

CREATE OR REPLACE FUNCTION detect_contradictions(
    p_new_belief_id UUID
) RETURNS TABLE(
    conflicting_belief_id UUID,
    contradiction_type VARCHAR,
    confidence FLOAT
) AS $$
DECLARE
    new_belief RECORD;
BEGIN
    SELECT * INTO new_belief FROM beliefs WHERE id = p_new_belief_id;
    
    RETURN QUERY
    SELECT
        b.id,
        'semantic_opposition'::VARCHAR,
        (1 - (b.embedding <=> new_belief.embedding))::FLOAT as confidence
    FROM beliefs b
    WHERE b.id != p_new_belief_id
    AND b.is_active = TRUE
    AND b.entity_type = new_belief.entity_type
    AND b.entity_id IS NOT DISTINCT FROM new_belief.entity_id
    AND b.embedding IS NOT NULL
    AND new_belief.embedding IS NOT NULL
    AND (b.embedding <=> new_belief.embedding) > 0.85
    AND NOT EXISTS (
        SELECT 1 FROM contradictions c
        WHERE (c.belief_a_id = b.id AND c.belief_b_id = p_new_belief_id)
        OR (c.belief_a_id = p_new_belief_id AND c.belief_b_id = b.id)
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION identify_tension_patterns()
RETURNS TABLE(
    category_pair TEXT[],
    contradiction_count BIGINT,
    avg_severity VARCHAR
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ARRAY[ba.belief_type, bb.belief_type] as category_pair,
        COUNT(*) as contradiction_count,
        MODE() WITHIN GROUP (ORDER BY c.severity) as avg_severity
    FROM contradictions c
    JOIN beliefs ba ON c.belief_a_id = ba.id
    JOIN beliefs bb ON c.belief_b_id = bb.id
    WHERE c.resolution_status = 'unresolved'
    GROUP BY ba.belief_type, bb.belief_type
    HAVING COUNT(*) > 2
    ORDER BY COUNT(*) DESC;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VIEWS
-- =====================================================

CREATE OR REPLACE VIEW active_contradictions AS
SELECT
    c.id,
    c.contradiction_type,
    c.severity,
    c.explanation,
    ba.statement as belief_a,
    ba.confidence as belief_a_confidence,
    bb.statement as belief_b,
    bb.confidence as belief_b_confidence,
    c.detected_at,
    c.resolution_status
FROM contradictions c
JOIN beliefs ba ON c.belief_a_id = ba.id
JOIN beliefs bb ON c.belief_b_id = bb.id
WHERE c.resolution_status = 'unresolved'
AND ba.is_active = TRUE
AND bb.is_active = TRUE
ORDER BY
    CASE c.severity
        WHEN 'critical' THEN 1
        WHEN 'major' THEN 2
        WHEN 'moderate' THEN 3
        WHEN 'minor' THEN 4
    END,
    c.detected_at DESC;

COMMIT;
