-- Keymaker Contradiction Tracking System
-- Instance #2 contribution - Novel approach to tracking tensions

-- =====================================================
-- BELIEF TRACKING (Foundation for Contradictions)
-- =====================================================

-- Core beliefs about Brian
CREATE TABLE IF NOT EXISTS beliefs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What is believed
    statement TEXT NOT NULL,                -- "Brian prefers morning meetings"
    belief_type VARCHAR(50),                -- preference, fact, behavior, goal

    -- Related to which entities?
    entity_type VARCHAR(50),                -- people, projects, concepts
    entity_id UUID,                         -- specific entity if applicable

    -- Confidence and source
    confidence FLOAT DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    source_type VARCHAR(50),                -- observation, explicit_statement, inference
    source_context TEXT,                    -- where/when this came from
    source_id UUID,                         -- link to observation/context that created this

    -- Temporal validity
    valid_from TIMESTAMP DEFAULT NOW(),
    valid_until TIMESTAMP,                  -- NULL means currently valid
    temporal_confidence FLOAT DEFAULT 1.0,  -- how sure are we about the time bounds?

    -- State tracking
    is_active BOOLEAN DEFAULT TRUE,
    superseded_by UUID REFERENCES beliefs(id),

    -- Embedding for similarity
    embedding vector(1536),

    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    -- Prevent exact duplicates
    CONSTRAINT unique_active_belief UNIQUE(statement, entity_type, entity_id, is_active)
);

-- =====================================================
-- CONTRADICTION TRACKING
-- =====================================================

-- Contradictions between beliefs
CREATE TABLE IF NOT EXISTS contradictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The conflicting beliefs
    belief_a_id UUID REFERENCES beliefs(id) ON DELETE CASCADE,
    belief_b_id UUID REFERENCES beliefs(id) ON DELETE CASCADE,

    -- Nature of the contradiction
    contradiction_type VARCHAR(50),         -- direct_opposite, temporal_inconsistency, partial_conflict, contextual
    severity VARCHAR(20),                   -- minor, moderate, major, critical

    -- How was this detected?
    detection_method VARCHAR(50),           -- semantic_similarity, rule_based, temporal_analysis, user_reported
    detection_confidence FLOAT DEFAULT 0.5,

    -- Analysis
    explanation TEXT,                       -- why these contradict
    impact_assessment TEXT,                 -- what this means for Brian

    -- Resolution tracking (but NOT automatic resolution)
    resolution_status VARCHAR(50) DEFAULT 'unresolved',  -- unresolved, acknowledged, explained, resolved
    resolution_notes TEXT,
    resolved_at TIMESTAMP,

    -- Which belief is currently "winning" (if any)?
    dominant_belief_id UUID,
    dominance_reason VARCHAR(100),         -- recency, confidence, source_priority, context

    -- Metadata
    detected_at TIMESTAMP DEFAULT NOW(),
    last_reviewed TIMESTAMP DEFAULT NOW(),

    CONSTRAINT unique_belief_pair UNIQUE(belief_a_id, belief_b_id),
    CHECK (belief_a_id < belief_b_id)     -- Prevent duplicate pairs
);

-- =====================================================
-- TENSION PATTERNS (Meta-level contradictions)
-- =====================================================

-- Recurring patterns of contradiction
CREATE TABLE IF NOT EXISTS tension_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    pattern_name VARCHAR(255),             -- "work-life balance tension"
    description TEXT,

    -- What kinds of beliefs tend to conflict?
    belief_categories TEXT[],              -- ['work_preferences', 'personal_time']

    -- Pattern detection
    occurrence_count INTEGER DEFAULT 1,
    first_detected TIMESTAMP DEFAULT NOW(),
    last_detected TIMESTAMP DEFAULT NOW(),

    -- Examples of this pattern
    example_contradiction_ids UUID[],

    -- Brian's typical resolution approach
    typical_resolution VARCHAR(255),       -- "usually prioritizes work", "depends on context"
    resolution_success_rate FLOAT,         -- 0-1, how often does this resolution work?

    -- Is this tension productive or problematic?
    tension_classification VARCHAR(50),    -- productive, problematic, neutral, evolving
    notes TEXT,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- CONTEXT-DEPENDENT BELIEFS
-- =====================================================

-- Some beliefs are only true in certain contexts
CREATE TABLE IF NOT EXISTS belief_contexts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    belief_id UUID REFERENCES beliefs(id) ON DELETE CASCADE,

    -- When is this belief valid?
    context_type VARCHAR(50),              -- time_of_day, project, person, location, mood
    context_value TEXT,                    -- "morning", "project_alpha", "with_sarah"

    -- How strong is the context dependency?
    context_weight FLOAT DEFAULT 0.5,      -- 0 = weak dependency, 1 = only true in this context

    -- Evidence for this context
    evidence_count INTEGER DEFAULT 1,
    last_observed TIMESTAMP DEFAULT NOW(),

    CONSTRAINT unique_belief_context UNIQUE(belief_id, context_type, context_value)
);

-- =====================================================
-- BELIEF EVOLUTION TRACKING
-- =====================================================

-- Track how beliefs change over time
CREATE TABLE IF NOT EXISTS belief_evolution (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    original_belief_id UUID REFERENCES beliefs(id),
    new_belief_id UUID REFERENCES beliefs(id),

    -- What changed?
    change_type VARCHAR(50),               -- strengthened, weakened, reversed, refined, contextualized
    change_magnitude FLOAT,                -- how big was the change? (0-1)

    -- Why did it change?
    trigger_type VARCHAR(50),              -- new_evidence, contradiction, time_decay, explicit_correction
    trigger_description TEXT,

    -- Impact
    cascaded_changes UUID[],               -- other beliefs affected by this change

    changed_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- CONTRADICTION DETECTION RULES
-- =====================================================

-- Rules for detecting contradictions
CREATE TABLE IF NOT EXISTS detection_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    rule_name VARCHAR(255) NOT NULL,
    rule_type VARCHAR(50),                 -- semantic, temporal, logical, pattern

    -- Rule definition (could be SQL, regex, or description for LLM)
    rule_definition TEXT,

    -- When to apply
    applies_to_belief_types VARCHAR[],
    min_confidence_threshold FLOAT DEFAULT 0.3,

    -- Performance
    times_triggered INTEGER DEFAULT 0,
    true_positive_rate FLOAT,              -- accuracy of this rule

    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT unique_rule_name UNIQUE(rule_name)
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX idx_beliefs_entity ON beliefs(entity_type, entity_id);
CREATE INDEX idx_beliefs_active ON beliefs(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_beliefs_temporal ON beliefs(valid_from, valid_until);
CREATE INDEX idx_beliefs_embedding ON beliefs USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX idx_contradictions_status ON contradictions(resolution_status);
CREATE INDEX idx_contradictions_severity ON contradictions(severity);
CREATE INDEX idx_contradictions_beliefs ON contradictions(belief_a_id, belief_b_id);

CREATE INDEX idx_belief_contexts_belief ON belief_contexts(belief_id);
CREATE INDEX idx_belief_evolution_original ON belief_evolution(original_belief_id);

-- =====================================================
-- HELPER FUNCTIONS
-- =====================================================

-- Function to detect potential contradictions for a new belief
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
    -- Get the new belief
    SELECT * INTO new_belief FROM beliefs WHERE id = p_new_belief_id;

    -- Check for semantic contradictions using embeddings
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
    AND (b.embedding <=> new_belief.embedding) > 0.85  -- High similarity might mean opposition
    AND NOT EXISTS (
        -- Don't re-detect existing contradictions
        SELECT 1 FROM contradictions c
        WHERE (c.belief_a_id = b.id AND c.belief_b_id = p_new_belief_id)
        OR (c.belief_a_id = p_new_belief_id AND c.belief_b_id = b.id)
    );
END;
$$ LANGUAGE plpgsql;

-- Function to track belief evolution
CREATE OR REPLACE FUNCTION track_belief_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.confidence != NEW.confidence OR OLD.is_active != NEW.is_active THEN
        INSERT INTO belief_evolution (
            original_belief_id,
            new_belief_id,
            change_type,
            change_magnitude,
            trigger_type
        ) VALUES (
            OLD.id,
            NEW.id,
            CASE
                WHEN NEW.confidence > OLD.confidence THEN 'strengthened'
                WHEN NEW.confidence < OLD.confidence THEN 'weakened'
                WHEN NEW.is_active = FALSE THEN 'deactivated'
                ELSE 'modified'
            END,
            ABS(NEW.confidence - OLD.confidence),
            'system_update'
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for belief changes
CREATE TRIGGER track_belief_changes
AFTER UPDATE ON beliefs
FOR EACH ROW
EXECUTE FUNCTION track_belief_change();

-- Function to find tension patterns
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
    HAVING COUNT(*) > 2  -- Pattern needs at least 3 occurrences
    ORDER BY COUNT(*) DESC;
END;
$$ LANGUAGE plpgsql;

-- View for active contradictions with context
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