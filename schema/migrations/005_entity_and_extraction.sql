-- Migration 005: Entity Registry and Extraction Pipeline
-- Instance #41 - Applies entity registry with correct 768-dimension embeddings
--
-- This migration adds:
-- 1. Entity tables (people, projects, commitments, concepts)
-- 2. Relationship tables
-- 3. Extraction job tracking
-- 4. Missing columns on observations table
-- 5. All required indexes

BEGIN;

-- =====================================================
-- ADD MISSING COLUMNS TO OBSERVATIONS
-- =====================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'observation_type'
    ) THEN
        ALTER TABLE observations ADD COLUMN observation_type VARCHAR(50);
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'source_session_id'
    ) THEN
        ALTER TABLE observations ADD COLUMN source_session_id VARCHAR(255);
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'observed_at'
    ) THEN
        ALTER TABLE observations ADD COLUMN observed_at TIMESTAMP DEFAULT NOW();
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'processing_status'
    ) THEN
        ALTER TABLE observations ADD COLUMN processing_status VARCHAR(50) DEFAULT 'processed';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'processed_at'
    ) THEN
        ALTER TABLE observations ADD COLUMN processed_at TIMESTAMP;
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'processing_errors'
    ) THEN
        ALTER TABLE observations ADD COLUMN processing_errors TEXT[];
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'extracted_entities'
    ) THEN
        ALTER TABLE observations ADD COLUMN extracted_entities JSONB;
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'extracted_beliefs'
    ) THEN
        ALTER TABLE observations ADD COLUMN extracted_beliefs JSONB;
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'extracted_events'
    ) THEN
        ALTER TABLE observations ADD COLUMN extracted_events JSONB;
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'memory_id'
    ) THEN
        ALTER TABLE observations ADD COLUMN memory_id UUID;
    END IF;
END $$;

-- =====================================================
-- CORE ENTITY TABLES (using 768-dimension embeddings)
-- =====================================================

-- Enable pg_trgm for fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- People: Individuals Brian interacts with
CREATE TABLE IF NOT EXISTS entities_people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name VARCHAR(255) NOT NULL,
    aliases TEXT[],
    first_seen TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW(),
    active_period tstzrange DEFAULT tstzrange(NOW(), NULL),
    attributes JSONB DEFAULT '{}'::jsonb,
    relationship_type VARCHAR(100),
    interaction_frequency VARCHAR(50),
    trust_level FLOAT DEFAULT 0.5,
    context_summary TEXT,
    embedding vector(768),  -- Using 768 for nomic-embed-text
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    confidence FLOAT DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    source_type VARCHAR(50),
    CONSTRAINT unique_canonical_name UNIQUE(canonical_name)
);

-- Projects: Work Brian is involved in
CREATE TABLE IF NOT EXISTS entities_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    code_name VARCHAR(100),
    status VARCHAR(50) DEFAULT 'active',
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    active_period tstzrange,
    description TEXT,
    goals TEXT[],
    success_criteria JSONB DEFAULT '[]'::jsonb,
    priority VARCHAR(20),
    effort_hours_estimated FLOAT,
    effort_hours_actual FLOAT,
    stakeholder_ids UUID[],
    dependencies UUID[],
    embedding vector(768),  -- Using 768 for nomic-embed-text
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    confidence FLOAT DEFAULT 0.7,
    CONSTRAINT unique_project_name UNIQUE(name)
);

-- Commitments: Things Brian said he would do
CREATE TABLE IF NOT EXISTS entities_commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    description TEXT NOT NULL,
    commitment_type VARCHAR(50),
    committed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    due_date TIMESTAMP,
    completed_at TIMESTAMP,
    status VARCHAR(50) DEFAULT 'open',
    completion_confidence FLOAT,
    committed_to UUID,
    project_id UUID REFERENCES entities_projects(id),
    priority VARCHAR(20),
    is_recurring BOOLEAN DEFAULT FALSE,
    recurrence_pattern VARCHAR(100),
    reminder_sent_at TIMESTAMP,
    completion_evidence TEXT,
    source_context TEXT,
    source_confidence FLOAT DEFAULT 0.7,
    embedding vector(768),  -- Using 768 for nomic-embed-text
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Concepts: Abstract ideas, principles, preferences Brian holds
CREATE TABLE IF NOT EXISTS entities_concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    description TEXT,
    examples TEXT[],
    strength FLOAT DEFAULT 0.5,
    valid_from TIMESTAMP DEFAULT NOW(),
    valid_until TIMESTAMP,
    context_dependent BOOLEAN DEFAULT FALSE,
    contexts JSONB DEFAULT '[]'::jsonb,
    conflicts_with UUID[],
    embedding vector(768),  -- Using 768 for nomic-embed-text
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    confidence FLOAT DEFAULT 0.5,
    CONSTRAINT unique_concept_name UNIQUE(name)
);

-- =====================================================
-- RELATIONSHIP TABLES
-- =====================================================

CREATE TABLE IF NOT EXISTS relationships_people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_a_id UUID REFERENCES entities_people(id) ON DELETE CASCADE,
    person_b_id UUID REFERENCES entities_people(id) ON DELETE CASCADE,
    relationship_type VARCHAR(100),
    strength FLOAT DEFAULT 0.5,
    first_interaction TIMESTAMP,
    last_interaction TIMESTAMP,
    interaction_count INTEGER DEFAULT 0,
    context JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT unique_person_pair UNIQUE(person_a_id, person_b_id),
    CHECK (person_a_id < person_b_id)
);

CREATE TABLE IF NOT EXISTS relationships_person_project (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID REFERENCES entities_people(id) ON DELETE CASCADE,
    project_id UUID REFERENCES entities_projects(id) ON DELETE CASCADE,
    role VARCHAR(100),
    involvement_level VARCHAR(50),
    started_at TIMESTAMP DEFAULT NOW(),
    ended_at TIMESTAMP,
    contribution_summary TEXT,
    hours_allocated FLOAT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT unique_person_project UNIQUE(person_id, project_id)
);

-- =====================================================
-- ENTITY RESOLUTION & MERGING
-- =====================================================

CREATE TABLE IF NOT EXISTS entity_merges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(50) NOT NULL,
    primary_id UUID NOT NULL,
    merged_id UUID NOT NULL,
    merge_reason TEXT,
    merge_confidence FLOAT DEFAULT 0.8,
    merged_data JSONB,
    merged_at TIMESTAMP DEFAULT NOW(),
    merged_by VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS entity_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    alias VARCHAR(255) NOT NULL,
    confidence FLOAT DEFAULT 0.7,
    source_context TEXT,
    first_seen TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW(),
    occurrence_count INTEGER DEFAULT 1,
    CONSTRAINT unique_alias UNIQUE(entity_type, alias)
);

-- =====================================================
-- EXTRACTION PIPELINE TRACKING
-- =====================================================

CREATE TABLE IF NOT EXISTS extraction_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    observation_id UUID REFERENCES observations(id) ON DELETE CASCADE,
    stage VARCHAR(50),
    status VARCHAR(50) DEFAULT 'pending',
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    entities_found INTEGER DEFAULT 0,
    beliefs_found INTEGER DEFAULT 0,
    events_found INTEGER DEFAULT 0,
    contradictions_detected INTEGER DEFAULT 0,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- Text search indexes
CREATE INDEX IF NOT EXISTS idx_people_canonical_name ON entities_people USING gin(to_tsvector('english', canonical_name));
CREATE INDEX IF NOT EXISTS idx_projects_name ON entities_projects USING gin(to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_commitments_description ON entities_commitments USING gin(to_tsvector('english', description));
CREATE INDEX IF NOT EXISTS idx_concepts_name ON entities_concepts USING gin(to_tsvector('english', name));

-- Vector similarity indexes (using ivfflat for approximate nearest neighbor)
-- Note: These require data to exist before they're effective
CREATE INDEX IF NOT EXISTS idx_people_embedding ON entities_people USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE INDEX IF NOT EXISTS idx_projects_embedding ON entities_projects USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE INDEX IF NOT EXISTS idx_commitments_embedding ON entities_commitments USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE INDEX IF NOT EXISTS idx_concepts_embedding ON entities_concepts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

-- Foreign key and lookup indexes
CREATE INDEX IF NOT EXISTS idx_commitments_project ON entities_commitments(project_id);
CREATE INDEX IF NOT EXISTS idx_commitments_status ON entities_commitments(status);
CREATE INDEX IF NOT EXISTS idx_relationships_person_a ON relationships_people(person_a_id);
CREATE INDEX IF NOT EXISTS idx_relationships_person_b ON relationships_people(person_b_id);

-- Temporal query indexes
CREATE INDEX IF NOT EXISTS idx_people_active_period ON entities_people USING gist(active_period);
CREATE INDEX IF NOT EXISTS idx_projects_active_period ON entities_projects USING gist(active_period);

-- Extraction job indexes
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_observation ON extraction_jobs(observation_id);
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_status ON extraction_jobs(status);

-- Observations additional indexes
CREATE INDEX IF NOT EXISTS idx_observations_status ON observations(processing_status);
CREATE INDEX IF NOT EXISTS idx_observations_observed_at ON observations(observed_at DESC);

-- =====================================================
-- HELPER FUNCTIONS
-- =====================================================

CREATE OR REPLACE FUNCTION get_entity_aliases(
    p_entity_type VARCHAR,
    p_entity_id UUID
) RETURNS TEXT[] AS $$
BEGIN
    RETURN ARRAY(
        SELECT alias
        FROM entity_aliases
        WHERE entity_type = p_entity_type
        AND entity_id = p_entity_id
        ORDER BY confidence DESC
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_entity_similarity(
    p_entity_type VARCHAR,
    p_name1 VARCHAR,
    p_name2 VARCHAR
) RETURNS FLOAT AS $$
DECLARE
    similarity_score FLOAT;
BEGIN
    similarity_score := similarity(p_name1, p_name2);
    RETURN similarity_score;
END;
$$ LANGUAGE plpgsql;

COMMIT;
