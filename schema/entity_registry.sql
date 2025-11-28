-- Keymaker Entity Registry Schema
-- Instance #2 contribution - concrete artifact

-- =====================================================
-- CORE ENTITY TABLES
-- =====================================================

-- People: Individuals Brian interacts with
CREATE TABLE IF NOT EXISTS entities_people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name VARCHAR(255) NOT NULL,  -- "Sarah Chen"
    aliases TEXT[],                         -- ["Sarah", "S.Chen", "Dr. Chen"]
    first_seen TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW(),

    -- Temporal identity tracking
    active_period tstzrange DEFAULT tstzrange(NOW(), NULL),

    -- Core attributes (JSON for flexibility)
    attributes JSONB DEFAULT '{}'::jsonb,  -- role, company, expertise, etc.

    -- Relationship metadata
    relationship_type VARCHAR(100),        -- friend, colleague, family, mentor
    interaction_frequency VARCHAR(50),     -- daily, weekly, monthly, rare
    trust_level FLOAT DEFAULT 0.5,        -- 0-1 scale

    -- Context and notes
    context_summary TEXT,

    -- Embedding for similarity search
    embedding vector(1536),

    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    confidence FLOAT DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    source_type VARCHAR(50),              -- observation, explicit, inferred

    CONSTRAINT unique_canonical_name UNIQUE(canonical_name)
);

-- Projects: Work Brian is involved in
CREATE TABLE IF NOT EXISTS entities_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    code_name VARCHAR(100),               -- internal reference name
    status VARCHAR(50) DEFAULT 'active',  -- active, paused, completed, cancelled

    -- Temporal tracking
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    active_period tstzrange,

    -- Project details
    description TEXT,
    goals TEXT[],
    success_criteria JSONB DEFAULT '[]'::jsonb,

    -- Priority and importance
    priority VARCHAR(20),                 -- critical, high, medium, low
    effort_hours_estimated FLOAT,
    effort_hours_actual FLOAT,

    -- Related entities
    stakeholder_ids UUID[],              -- references to entities_people
    dependencies UUID[],                 -- references to other projects

    -- Embedding for similarity
    embedding vector(1536),

    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    confidence FLOAT DEFAULT 0.7,

    CONSTRAINT unique_project_name UNIQUE(name)
);

-- Commitments: Things Brian said he would do
CREATE TABLE IF NOT EXISTS entities_commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What was committed
    description TEXT NOT NULL,
    commitment_type VARCHAR(50),         -- deliverable, meeting, habit, goal

    -- When
    committed_at TIMESTAMP NOT NULL,
    due_date TIMESTAMP,
    completed_at TIMESTAMP,

    -- Status tracking
    status VARCHAR(50) DEFAULT 'open',   -- open, in_progress, completed, cancelled, overdue
    completion_confidence FLOAT,         -- how confident are we it's done?

    -- Who/What is involved
    committed_to UUID,                   -- person_id if commitment to someone
    project_id UUID REFERENCES entities_projects(id),

    -- Importance and tracking
    priority VARCHAR(20),
    is_recurring BOOLEAN DEFAULT FALSE,
    recurrence_pattern VARCHAR(100),     -- daily, weekly, monthly, etc.
    reminder_sent_at TIMESTAMP,

    -- Evidence of completion
    completion_evidence TEXT,

    -- Source of commitment
    source_context TEXT,                 -- where/how this commitment was made
    source_confidence FLOAT DEFAULT 0.7,

    -- Embedding
    embedding vector(1536),

    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Concepts: Abstract ideas, principles, preferences Brian holds
CREATE TABLE IF NOT EXISTS entities_concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),              -- preference, principle, goal, constraint

    -- The concept itself
    description TEXT,
    examples TEXT[],

    -- How strongly Brian holds this
    strength FLOAT DEFAULT 0.5,         -- 0-1, how important/rigid

    -- Temporal validity
    valid_from TIMESTAMP DEFAULT NOW(),
    valid_until TIMESTAMP,
    context_dependent BOOLEAN DEFAULT FALSE,
    contexts JSONB DEFAULT '[]'::jsonb, -- when this applies

    -- Conflicts with other concepts
    conflicts_with UUID[],              -- other concept IDs

    -- Embedding
    embedding vector(1536),

    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    confidence FLOAT DEFAULT 0.5,

    CONSTRAINT unique_concept_name UNIQUE(name)
);

-- =====================================================
-- RELATIONSHIP TABLES
-- =====================================================

-- Interactions between people
CREATE TABLE IF NOT EXISTS relationships_people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_a_id UUID REFERENCES entities_people(id) ON DELETE CASCADE,
    person_b_id UUID REFERENCES entities_people(id) ON DELETE CASCADE,

    relationship_type VARCHAR(100),     -- colleague, friend, reports_to, collaborates_with
    strength FLOAT DEFAULT 0.5,         -- 0-1 scale

    -- Interaction history
    first_interaction TIMESTAMP,
    last_interaction TIMESTAMP,
    interaction_count INTEGER DEFAULT 0,

    -- Context
    context JSONB DEFAULT '{}'::jsonb,  -- shared projects, how they met, etc.

    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT unique_person_pair UNIQUE(person_a_id, person_b_id),
    CHECK (person_a_id < person_b_id)  -- Enforce ordering to prevent duplicates
);

-- Person-Project associations
CREATE TABLE IF NOT EXISTS relationships_person_project (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID REFERENCES entities_people(id) ON DELETE CASCADE,
    project_id UUID REFERENCES entities_projects(id) ON DELETE CASCADE,

    role VARCHAR(100),                  -- owner, contributor, stakeholder, observer
    involvement_level VARCHAR(50),      -- primary, secondary, advisory

    -- Time bounds
    started_at TIMESTAMP DEFAULT NOW(),
    ended_at TIMESTAMP,

    -- Contribution tracking
    contribution_summary TEXT,
    hours_allocated FLOAT,

    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT unique_person_project UNIQUE(person_id, project_id)
);

-- =====================================================
-- ENTITY RESOLUTION & MERGING
-- =====================================================

-- Track entity merges (when we realize two entities are the same)
CREATE TABLE IF NOT EXISTS entity_merges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    entity_type VARCHAR(50) NOT NULL,   -- people, projects, concepts
    primary_id UUID NOT NULL,           -- The ID we're keeping
    merged_id UUID NOT NULL,            -- The ID being merged

    merge_reason TEXT,
    merge_confidence FLOAT DEFAULT 0.8,

    -- Preserve original data
    merged_data JSONB,

    merged_at TIMESTAMP DEFAULT NOW(),
    merged_by VARCHAR(100)              -- system, user, specific agent
);

-- Track entity name variations we've seen
CREATE TABLE IF NOT EXISTS entity_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    alias VARCHAR(255) NOT NULL,

    -- How confident are we this alias refers to this entity?
    confidence FLOAT DEFAULT 0.7,

    -- Where did we see this alias?
    source_context TEXT,
    first_seen TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW(),
    occurrence_count INTEGER DEFAULT 1,

    CONSTRAINT unique_alias UNIQUE(entity_type, alias)
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- Text search
CREATE INDEX idx_people_canonical_name ON entities_people USING gin(to_tsvector('english', canonical_name));
CREATE INDEX idx_projects_name ON entities_projects USING gin(to_tsvector('english', name));
CREATE INDEX idx_commitments_description ON entities_commitments USING gin(to_tsvector('english', description));
CREATE INDEX idx_concepts_name ON entities_concepts USING gin(to_tsvector('english', name));

-- Vector similarity
CREATE INDEX idx_people_embedding ON entities_people USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_projects_embedding ON entities_projects USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_commitments_embedding ON entities_commitments USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_concepts_embedding ON entities_concepts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Foreign keys and lookups
CREATE INDEX idx_commitments_project ON entities_commitments(project_id);
CREATE INDEX idx_commitments_status ON entities_commitments(status);
CREATE INDEX idx_relationships_person_a ON relationships_people(person_a_id);
CREATE INDEX idx_relationships_person_b ON relationships_people(person_b_id);

-- Temporal queries
CREATE INDEX idx_people_active_period ON entities_people USING gist(active_period);
CREATE INDEX idx_projects_active_period ON entities_projects USING gist(active_period);

-- =====================================================
-- HELPER FUNCTIONS
-- =====================================================

-- Function to get all aliases for an entity
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

-- Function to check if entities might be the same (for resolution)
CREATE OR REPLACE FUNCTION check_entity_similarity(
    p_entity_type VARCHAR,
    p_name1 VARCHAR,
    p_name2 VARCHAR
) RETURNS FLOAT AS $$
DECLARE
    similarity_score FLOAT;
BEGIN
    -- Use PostgreSQL's similarity function
    similarity_score := similarity(p_name1, p_name2);

    -- Could enhance with:
    -- - Soundex matching
    -- - Nickname detection
    -- - Vector embedding similarity

    RETURN similarity_score;
END;
$$ LANGUAGE plpgsql;

-- Enable pg_trgm for fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;