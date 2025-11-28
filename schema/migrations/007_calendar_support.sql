-- Migration 007: Calendar Support for Commitments
-- Instance #51: Add time-specific event support and CalDAV sync tracking
--
-- Extends entities_commitments to support:
-- - Specific event times (not just due dates)
-- - Duration tracking
-- - Location information
-- - CalDAV sync status for Radicale integration

-- New columns for calendar functionality
ALTER TABLE entities_commitments ADD COLUMN IF NOT EXISTS event_time TIMESTAMP WITH TIME ZONE;
ALTER TABLE entities_commitments ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
ALTER TABLE entities_commitments ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE entities_commitments ADD COLUMN IF NOT EXISTS caldav_uid TEXT;
ALTER TABLE entities_commitments ADD COLUMN IF NOT EXISTS synced_to_calendar BOOLEAN DEFAULT FALSE;

-- Index for efficient schedule queries (only dated events)
CREATE INDEX IF NOT EXISTS idx_commitments_event_time
ON entities_commitments(event_time)
WHERE event_time IS NOT NULL;

-- Index for calendar sync status (for sync retry logic)
CREATE INDEX IF NOT EXISTS idx_commitments_calendar_sync
ON entities_commitments(synced_to_calendar, caldav_uid)
WHERE synced_to_calendar = TRUE;

-- Add comment for documentation
COMMENT ON COLUMN entities_commitments.event_time IS 'Specific datetime for calendar events (null = undated commitment)';
COMMENT ON COLUMN entities_commitments.duration_minutes IS 'Event duration in minutes (null = point-in-time or default 60)';
COMMENT ON COLUMN entities_commitments.location IS 'Physical or virtual location (e.g., "Office", "Zoom")';
COMMENT ON COLUMN entities_commitments.caldav_uid IS 'Unique ID for CalDAV event sync (format: keymaker-commitment-{id}@localhost)';
COMMENT ON COLUMN entities_commitments.synced_to_calendar IS 'True if user explicitly requested "add to calendar"';
