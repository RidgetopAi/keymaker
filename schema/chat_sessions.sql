-- Chat Sessions Schema
-- Instance #49: Conversational interface with session-based memory
-- Retention: 7 days, pruned automatically

-- Chat sessions track a conversation thread
CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP DEFAULT NOW(),
    last_activity TIMESTAMP DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Chat messages within a session
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    intent VARCHAR(50), -- 'query', 'observation', 'update', 'clarification', NULL if not classified
    intent_confidence FLOAT,
    action_taken JSONB, -- What action was performed (e.g., {"type": "observe", "id": "..."})
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_activity ON chat_sessions(last_activity);

-- Function to prune old sessions (older than 7 days)
CREATE OR REPLACE FUNCTION prune_old_chat_sessions() RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM chat_sessions
    WHERE last_activity < NOW() - INTERVAL '7 days';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Update last_activity on new message
CREATE OR REPLACE FUNCTION update_session_activity() RETURNS TRIGGER AS $$
BEGIN
    UPDATE chat_sessions
    SET last_activity = NOW()
    WHERE id = NEW.session_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists, then create
DROP TRIGGER IF EXISTS trigger_update_session_activity ON chat_messages;
CREATE TRIGGER trigger_update_session_activity
    AFTER INSERT ON chat_messages
    FOR EACH ROW
    EXECUTE FUNCTION update_session_activity();
