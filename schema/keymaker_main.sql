-- Keymaker Main Schema
-- Instance #2 contribution - Integration layer

-- =====================================================
-- OBSERVATIONS (Raw Input Layer)
-- =====================================================

-- Immutable record of all inputs to the system
CREATE TABLE IF NOT EXISTS observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The raw observation
    content TEXT NOT NULL,
    observation_type VARCHAR(50),          -- chat_message, note, voice_transcript, calendar_event, email

    -- Source metadata
    source VARCHAR(100),                   -- claude_chat, obsidian, calendar, email, voice_assistant
    source_session_id VARCHAR(255),        -- chat session, conversation ID, etc.

    -- When did this happen?
    observed_at TIMESTAMP DEFAULT NOW(),

    -- Has this been processed?
    processing_status VARCHAR(50) DEFAULT 'pending',  -- pending, processing, processed, failed
    processed_at TIMESTAMP,
    processing_errors TEXT[],

    -- Extracted data (after processing)
    extracted_entities JSONB,              -- people, projects, commitments found
    extracted_beliefs JSONB,               -- beliefs/facts extracted
    extracted_events JSONB,                -- events identified

    -- Link to hierarchical memory if stored there
    memory_id UUID,

    -- Never modify observations
    created_at TIMESTAMP DEFAULT NOW(),

    -- Ensure we can find observations efficiently
    CHECK (content IS NOT NULL AND content != '')
);

-- =====================================================
-- EXTRACTION PIPELINE TRACKING
-- =====================================================

-- Track extraction jobs and their status
CREATE TABLE IF NOT EXISTS extraction_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    observation_id UUID REFERENCES observations(id) ON DELETE CASCADE,

    -- Pipeline stages
    stage VARCHAR(50),                     -- entity_extraction, belief_extraction, event_extraction, integration
    status VARCHAR(50) DEFAULT 'pending',  -- pending, running, completed, failed

    -- Timing
    started_at TIMESTAMP,
    completed_at TIMESTAMP,

    -- Results
    entities_found INTEGER DEFAULT 0,
    beliefs_found INTEGER DEFAULT 0,
    events_found INTEGER DEFAULT 0,
    contradictions_detected INTEGER DEFAULT 0,

    -- Errors
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,

    created_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- EVENT TRACKING (Episodic Layer)
-- =====================================================

-- Events that happened in Brian's life
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What happened
    event_type VARCHAR(50),                -- meeting, decision, milestone, incident, conversation
    summary TEXT NOT NULL,
    detailed_description TEXT,

    -- When
    occurred_at TIMESTAMP NOT NULL,
    duration_minutes INTEGER,

    -- Where (if applicable)
    location VARCHAR(255),
    is_virtual BOOLEAN DEFAULT FALSE,

    -- Who was involved
    participant_ids UUID[],                -- references to entities_people
    primary_person_id UUID,                -- main person if applicable

    -- Related to what
    project_id UUID REFERENCES entities_projects(id),
    commitment_ids UUID[],                 -- commitments discussed/created

    -- Outcome and impact
    outcome VARCHAR(100),                  -- successful, failed, mixed, inconclusive
    impact_level VARCHAR(20),              -- high, medium, low
    followup_required BOOLEAN DEFAULT FALSE,

    -- Source
    source_observation_id UUID REFERENCES observations(id),
    extraction_confidence FLOAT DEFAULT 0.5,

    -- For similarity search
    embedding vector(1536),

    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- INTEGRATION WITH HIERARCHICAL MEMORY
-- =====================================================

-- Bridge table to link Keymaker entities with hierarchical-memory
CREATE TABLE IF NOT EXISTS memory_entity_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Hierarchical memory reference
    memory_id UUID NOT NULL,               -- ID in hierarchical-memory system
    memory_tier VARCHAR(50),               -- working, session, project

    -- Keymaker entity reference
    entity_type VARCHAR(50) NOT NULL,      -- person, project, commitment, concept, belief
    entity_id UUID NOT NULL,

    -- Relationship
    link_type VARCHAR(50),                 -- mentions, about, created_by, relevant_to
    relevance_score FLOAT DEFAULT 0.5,

    created_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT unique_memory_entity UNIQUE(memory_id, entity_type, entity_id)
);

-- =====================================================
-- PROACTIVE SURFACING QUEUE
-- =====================================================

-- Things Keymaker wants to proactively tell Brian
CREATE TABLE IF NOT EXISTS surfacing_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What to surface
    surface_type VARCHAR(50),              -- reminder, contradiction, pattern, insight, warning
    priority VARCHAR(20),                  -- urgent, high, medium, low

    -- The content
    title VARCHAR(255),
    message TEXT NOT NULL,

    -- Related entities
    related_entities JSONB,                -- {type: 'commitment', id: 'uuid', ...}

    -- When to surface
    surface_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,

    -- Has it been shown?
    surfaced BOOLEAN DEFAULT FALSE,
    surfaced_at TIMESTAMP,
    user_response VARCHAR(50),             -- acknowledged, snoozed, dismissed, actioned

    -- Why surface this?
    trigger_type VARCHAR(100),             -- overdue_commitment, new_contradiction, detected_pattern
    trigger_context TEXT,
    confidence FLOAT DEFAULT 0.5,

    created_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- SYNTHESIS TEMPLATES
-- =====================================================

-- Templates for synthesizing information for different contexts
CREATE TABLE IF NOT EXISTS synthesis_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    template_name VARCHAR(255) NOT NULL,
    use_case VARCHAR(100),                 -- daily_summary, project_status, person_context, decision_support

    -- The template (with placeholders)
    template_structure TEXT NOT NULL,
    required_data_types TEXT[],            -- what entities/beliefs needed

    -- How to gather the data
    gathering_queries JSONB,               -- SQL queries or function calls

    -- Post-processing
    post_processing_steps JSONB,

    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT unique_template_name UNIQUE(template_name)
);

-- =====================================================
-- SYSTEM CONFIGURATION
-- =====================================================

-- Configuration for the Keymaker system
CREATE TABLE IF NOT EXISTS system_config (
    key VARCHAR(255) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Insert default configuration
INSERT INTO system_config (key, value, description) VALUES
('extraction_model', '"llama2-7b"'::jsonb, 'Local model for entity/belief extraction'),
('embedding_model', '"all-minilm-l6-v2"'::jsonb, 'Model for generating embeddings'),
('contradiction_threshold', '0.85'::jsonb, 'Similarity threshold for detecting contradictions'),
('belief_decay_rate', '0.95'::jsonb, 'Monthly decay rate for belief confidence'),
('surfacing_frequency', '"daily"'::jsonb, 'How often to check for proactive surfacing'),
('max_extraction_retries', '3'::jsonb, 'Maximum retries for failed extraction jobs')
ON CONFLICT (key) DO NOTHING;

-- =====================================================
-- INDEXES
-- =====================================================

-- Observations
CREATE INDEX idx_observations_status ON observations(processing_status);
CREATE INDEX idx_observations_source ON observations(source);
CREATE INDEX idx_observations_observed_at ON observations(observed_at DESC);

-- Events
CREATE INDEX idx_events_occurred_at ON events(occurred_at DESC);
CREATE INDEX idx_events_project ON events(project_id);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_embedding ON events USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Surfacing
CREATE INDEX idx_surfacing_pending ON surfacing_queue(surfaced, surface_at) WHERE surfaced = FALSE;
CREATE INDEX idx_surfacing_priority ON surfacing_queue(priority, surface_at);

-- Memory links
CREATE INDEX idx_memory_links_entity ON memory_entity_links(entity_type, entity_id);
CREATE INDEX idx_memory_links_memory ON memory_entity_links(memory_id);

-- =====================================================
-- PROCESSING FUNCTIONS
-- =====================================================

-- Main function to process a new observation
CREATE OR REPLACE FUNCTION process_observation(
    p_observation_id UUID
) RETURNS VOID AS $$
DECLARE
    v_job_id UUID;
BEGIN
    -- Create extraction job
    INSERT INTO extraction_jobs (observation_id, stage, status)
    VALUES (p_observation_id, 'entity_extraction', 'pending')
    RETURNING id INTO v_job_id;

    -- Mark observation as processing
    UPDATE observations
    SET processing_status = 'processing'
    WHERE id = p_observation_id;

    -- The actual extraction would be done by an external service
    -- This just sets up the tracking

    RAISE NOTICE 'Created extraction job % for observation %', v_job_id, p_observation_id;
END;
$$ LANGUAGE plpgsql;

-- Function to check for items to surface proactively
CREATE OR REPLACE FUNCTION check_for_surfacing()
RETURNS TABLE(
    item_id UUID,
    surface_type VARCHAR,
    priority VARCHAR,
    title VARCHAR,
    message TEXT
) AS $$
BEGIN
    -- Check overdue commitments
    INSERT INTO surfacing_queue (surface_type, priority, title, message, related_entities, trigger_type)
    SELECT
        'reminder',
        'high',
        'Overdue: ' || LEFT(description, 50),
        format('This commitment is %s days overdue: %s',
               EXTRACT(DAY FROM NOW() - due_date)::INTEGER,
               description),
        jsonb_build_object('type', 'commitment', 'id', id),
        'overdue_commitment'
    FROM entities_commitments
    WHERE status = 'open'
    AND due_date < NOW()
    AND NOT EXISTS (
        SELECT 1 FROM surfacing_queue sq
        WHERE sq.trigger_type = 'overdue_commitment'
        AND (sq.related_entities->>'id')::UUID = entities_commitments.id
        AND sq.surfaced = FALSE
    );

    -- Return pending items to surface
    RETURN QUERY
    SELECT
        sq.id,
        sq.surface_type,
        sq.priority,
        sq.title,
        sq.message
    FROM surfacing_queue sq
    WHERE sq.surfaced = FALSE
    AND sq.surface_at <= NOW()
    AND (sq.expires_at IS NULL OR sq.expires_at > NOW())
    ORDER BY
        CASE sq.priority
            WHEN 'urgent' THEN 1
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 3
            WHEN 'low' THEN 4
        END,
        sq.surface_at;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VIEWS FOR COMMON QUERIES
-- =====================================================

-- View of recent unprocessed observations
CREATE OR REPLACE VIEW pending_observations AS
SELECT
    id,
    content,
    observation_type,
    source,
    observed_at
FROM observations
WHERE processing_status = 'pending'
ORDER BY observed_at DESC;

-- View of Brian's current commitments
CREATE OR REPLACE VIEW current_commitments AS
SELECT
    c.id,
    c.description,
    c.commitment_type,
    c.due_date,
    c.status,
    c.priority,
    p.name as project_name,
    person.canonical_name as committed_to_person
FROM entities_commitments c
LEFT JOIN entities_projects p ON c.project_id = p.id
LEFT JOIN entities_people person ON c.committed_to = person.id
WHERE c.status IN ('open', 'in_progress')
ORDER BY
    c.due_date NULLS LAST,
    CASE c.priority
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
    END;

-- View of active beliefs with their contradictions
CREATE OR REPLACE VIEW beliefs_with_tensions AS
SELECT
    b.id,
    b.statement,
    b.confidence,
    b.source_type,
    COUNT(DISTINCT c.id) as contradiction_count,
    ARRAY_AGG(DISTINCT c.severity) FILTER (WHERE c.severity IS NOT NULL) as contradiction_severities
FROM beliefs b
LEFT JOIN contradictions c ON
    (c.belief_a_id = b.id OR c.belief_b_id = b.id)
    AND c.resolution_status = 'unresolved'
WHERE b.is_active = TRUE
GROUP BY b.id, b.statement, b.confidence, b.source_type
ORDER BY
    COUNT(DISTINCT c.id) DESC,
    b.confidence DESC;