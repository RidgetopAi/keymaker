# Keymaker Calendar Integration Plan

**Project**: keymaker
**Created**: 2025-11-28
**Status**: Planning

---

## Overview

Extend keymaker's commitment system to support time-specific events with optional one-way sync to a self-hosted CalDAV server (Radicale). Keymaker remains the source of truth; the CalDAV server acts as a notification/visibility layer accessible from any calendar app (iOS, Android, desktop).

**Privacy Principle**: All data stays on your infrastructure. No third-party services have access to your calendar data.

---

## Architecture

```
                                 +------------------+
                                 |   iOS Calendar   |
                                 |  Android Calendar|
                                 |  Thunderbird     |
                                 +--------+---------+
                                          |
                                     CalDAV Protocol
                                          |
                                 +--------v---------+
                                 |    Radicale      |
                                 | (CalDAV Server)  |
                                 | Port 5232        |
                                 +--------+---------+
                                          ^
                                    Push Events
                                          |
+------------------+             +--------+---------+
|   User Input     | ---------> |    Keymaker      |
| "Meeting at 3pm  |  Observe   |   server.ts      |
|  add to calendar"|            |   Port 3001      |
+------------------+             +--------+---------+
                                          |
                                    PostgreSQL
                                          |
                                 +--------v---------+
                                 | entities_        |
                                 | commitments      |
                                 | (extended)       |
                                 +------------------+
```

**Data Flow**:
1. User creates observation with calendar intent
2. Keymaker extracts commitment with datetime
3. If "add to calendar" intent detected, push to Radicale
4. Radicale serves event to any connected calendar app
5. Keymaker is always source of truth

---

## 1. Database Schema Changes

**Extend `entities_commitments` table:**

```sql
-- New columns for calendar functionality
ALTER TABLE entities_commitments ADD COLUMN event_time TIMESTAMP WITH TIME ZONE;
ALTER TABLE entities_commitments ADD COLUMN duration_minutes INTEGER;
ALTER TABLE entities_commitments ADD COLUMN location TEXT;
ALTER TABLE entities_commitments ADD COLUMN caldav_uid TEXT;
ALTER TABLE entities_commitments ADD COLUMN synced_to_calendar BOOLEAN DEFAULT FALSE;

-- Index for efficient schedule queries
CREATE INDEX idx_commitments_event_time ON entities_commitments(event_time)
  WHERE event_time IS NOT NULL;

-- Index for calendar sync status
CREATE INDEX idx_commitments_synced ON entities_commitments(synced_to_calendar)
  WHERE synced_to_calendar = TRUE;
```

**Field purposes:**
| Field | Type | Purpose |
|-------|------|---------|
| `event_time` | TIMESTAMP WITH TIME ZONE | Specific datetime (null = undated commitment) |
| `duration_minutes` | INTEGER | Optional duration (null = point-in-time or unknown) |
| `location` | TEXT | Optional context for where |
| `caldav_uid` | TEXT | Unique ID for CalDAV event (for updates/deletes) |
| `synced_to_calendar` | BOOLEAN | Tracks explicit "add to calendar" requests |

---

## 2. CalDAV Server Setup (Radicale)

### Why Radicale
- Single Python file, minimal dependencies
- File-based or PostgreSQL storage
- Supports CalDAV (calendars) and CardDAV (contacts)
- Works with iOS, Android, Thunderbird, any standards-compliant client
- Self-hosted, zero external dependencies

### Installation

```bash
# Install Radicale
pip install radicale

# Or with PostgreSQL storage support
pip install radicale[postgresql]
```

### Configuration (`~/.config/radicale/config`)

```ini
[server]
hosts = 127.0.0.1:5232

[auth]
type = htpasswd
htpasswd_filename = /home/ridgetop/.config/radicale/users
htpasswd_encryption = bcrypt

[storage]
filesystem_folder = /home/ridgetop/.local/share/radicale/collections

[rights]
type = owner_only

[logging]
level = info
```

### Create User

```bash
# Create htpasswd file
htpasswd -B -c /home/ridgetop/.config/radicale/users ridgetop
```

### Systemd Service (`/etc/systemd/system/radicale.service`)

```ini
[Unit]
Description=Radicale CalDAV Server
After=network.target

[Service]
Type=simple
User=ridgetop
ExecStart=/usr/local/bin/radicale
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### iOS/Android Connection
- Server: `https://your-server:5232` (or via reverse proxy)
- Username: ridgetop
- Password: (set during htpasswd creation)
- Calendar path: `/ridgetop/keymaker/` (created automatically)

---

## 3. CalDAV Integration in Keymaker

### New Service: `services/calendar.ts`

```typescript
interface CalendarEvent {
  uid: string;
  summary: string;
  dtstart: Date;
  dtend?: Date;
  location?: string;
  description?: string;
}

interface CalendarService {
  // Create event in Radicale, return UID
  createEvent(event: CalendarEvent): Promise<string>;

  // Update existing event
  updateEvent(uid: string, event: Partial<CalendarEvent>): Promise<void>;

  // Delete event from Radicale
  deleteEvent(uid: string): Promise<void>;
}
```

### iCalendar Format (RFC 5545)

Events pushed to Radicale use standard iCalendar format:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Keymaker//Calendar//EN
BEGIN:VEVENT
UID:keymaker-commitment-{id}@localhost
DTSTAMP:20251128T150000Z
DTSTART:20251205T150000Z
DTEND:20251205T160000Z
SUMMARY:Appointment with Xyz Inc
LOCATION:Office
DESCRIPTION:Created from keymaker observation
END:VEVENT
END:VCALENDAR
```

### Sync Logic

```typescript
async function syncCommitmentToCalendar(commitmentId: number): Promise<void> {
  const commitment = await getCommitment(commitmentId);

  if (!commitment.synced_to_calendar || !commitment.event_time) {
    return; // Not marked for sync or no datetime
  }

  const event: CalendarEvent = {
    uid: `keymaker-commitment-${commitmentId}@localhost`,
    summary: commitment.description,
    dtstart: commitment.event_time,
    dtend: commitment.duration_minutes
      ? addMinutes(commitment.event_time, commitment.duration_minutes)
      : addMinutes(commitment.event_time, 60), // Default 1 hour
    location: commitment.location,
    description: `Commitment to: ${commitment.committed_to || 'self'}`
  };

  if (commitment.caldav_uid) {
    await calendarService.updateEvent(commitment.caldav_uid, event);
  } else {
    const uid = await calendarService.createEvent(event);
    await updateCommitmentCalDAVUid(commitmentId, uid);
  }
}
```

---

## 4. Intent Detection & Extraction

**Enhance entity extraction to detect:**

### Calendar Intent Phrases
- "add to calendar", "put on my calendar", "schedule this"
- "calendar this", "add to my schedule"
- Explicit: "please add that to my calendar"

### Datetime Extraction
| Input | Parsed |
|-------|--------|
| "tomorrow at 3pm" | Relative → absolute timestamp |
| "December 5th at 3" | Absolute date + time |
| "next Tuesday 10am" | Relative day + time |
| "in 2 hours" | Relative duration from now |

### Duration Extraction
| Input | Parsed |
|-------|--------|
| "for 1 hour" | 60 minutes |
| "30 minute meeting" | 30 minutes |
| "all day" | 1440 minutes (flag as all-day event) |
| (unspecified) | Default: 60 minutes |

### Location Extraction
- "at the office" → "office"
- "at 123 Main St" → "123 Main St"
- "on Zoom" → "Zoom"

### Extraction Output Example

```json
{
  "description": "Appointment with Xyz Inc",
  "event_time": "2025-12-05T15:00:00-05:00",
  "duration_minutes": 60,
  "location": null,
  "committed_to": "Xyz Inc",
  "add_to_calendar": true
}
```

---

## 5. Formatted Schedule Display

### New Endpoint: `GET /api/schedule`

**Query Parameters:**
- `days` - How many days ahead to show (default: 7)
- `include_undated` - Include undated commitments (default: true)

**Response Structure:**

```json
{
  "generated_at": "2025-11-28T10:00:00Z",
  "today": [
    {
      "id": 42,
      "time": "3:00 PM",
      "description": "Appointment with Xyz Inc",
      "location": null,
      "duration_minutes": 60,
      "synced": true
    }
  ],
  "tomorrow": [],
  "this_week": [
    {
      "id": 45,
      "date": "Thu Dec 7",
      "time": "10:00 AM",
      "description": "Team sync",
      "location": "Zoom",
      "duration_minutes": 30,
      "synced": true
    }
  ],
  "later": [
    {
      "id": 48,
      "date": "Dec 15",
      "time": "2:00 PM",
      "description": "Quarterly review",
      "location": null,
      "duration_minutes": 60,
      "synced": false
    }
  ],
  "undated": [
    {
      "id": 50,
      "description": "Finish project proposal",
      "committed_to": "Jake",
      "status": "active"
    },
    {
      "id": 51,
      "description": "Review contracts",
      "committed_to": null,
      "status": "active"
    }
  ]
}
```

**Query Logic:**
```sql
-- Dated commitments
SELECT * FROM entities_commitments
WHERE event_time IS NOT NULL
  AND status != 'completed'
ORDER BY event_time ASC;

-- Undated commitments
SELECT * FROM entities_commitments
WHERE event_time IS NULL
  AND status != 'completed'
ORDER BY created_at DESC;
```

---

## 6. API Changes

### Modified Endpoints

| Endpoint | Change |
|----------|--------|
| `POST /api/observe` | Extraction detects calendar intent, creates commitment with datetime, triggers CalDAV sync if requested |
| `GET /api/entities/commitments` | Include new fields (event_time, duration_minutes, location, synced_to_calendar) |
| `GET /api/surface` | Include today's scheduled events in urgent items |

### New Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/schedule` | GET | Formatted schedule display |
| `/api/calendar/sync/:commitmentId` | POST | Manually trigger CalDAV sync for existing commitment |
| `/api/calendar/unsync/:commitmentId` | DELETE | Remove from CalDAV (keeps in keymaker) |
| `/api/calendar/status` | GET | Check Radicale connection status |

---

## 7. Update/Delete Handling

### When Commitment is Updated in Keymaker
```typescript
// In commitment update handler
if (commitment.synced_to_calendar && commitment.caldav_uid) {
  await calendarService.updateEvent(commitment.caldav_uid, {
    summary: commitment.description,
    dtstart: commitment.event_time,
    dtend: calculateEndTime(commitment),
    location: commitment.location
  });
}
```

### When Commitment is Completed/Deleted
```typescript
// In commitment complete/delete handler
if (commitment.synced_to_calendar && commitment.caldav_uid) {
  await calendarService.deleteEvent(commitment.caldav_uid);
  // Or: mark as completed in calendar instead of deleting
}
```

### Sync Failure Handling
- Log error but don't block keymaker operation
- Mark `sync_failed_at` timestamp for retry
- Background job retries failed syncs every 5 minutes

---

## 8. Implementation Phases

### Phase 1: Schema + Display (Keymaker-only) ✅ COMPLETE
- [x] Add database columns via migration
- [x] Build `/api/schedule` endpoint
- [x] Update extraction to parse datetimes
- [x] Test formatted schedule output
- **Completed**: Instance #51 (2025-11-28)

### Phase 2: Radicale Setup ✅ COMPLETE
- [x] Install and configure Radicale (pipx)
- [x] Set up user systemd service
- [x] Configure htpasswd authentication (bcrypt)
- [x] Create keymaker calendar collection
- [ ] Test with iOS/Android calendar app (pending VPS reverse proxy)
- [ ] Set up reverse proxy (pending - needed for remote access)
- **Completed (local)**: Instance #52 (2025-11-28)
- **Documentation**: `docs/radicale-setup.md`

### Phase 3: CalDAV Integration ✅ COMPLETE
- [x] Implement `services/calendar.ts`
- [x] Add calendar intent detection to extraction (Phase 1)
- [x] Implement create/update/delete sync
- [x] Add `synced_to_calendar` flag handling
- [x] Add `/api/calendar/*` endpoints
- [x] Hook entity extraction into /api/observe for auto-sync
- **Completed**: Instance #52 (2025-11-28)
- **Tested**: Events sync to Radicale successfully

### Phase 4: Surface Integration
- [ ] Integrate scheduled events into `/api/surface`
- [ ] Add "upcoming today" to surface insights
- [ ] Temporal context in observations ("you had a meeting with X yesterday")

---

## 9. Dependencies

### Keymaker
- `ical-generator` or manual iCalendar string building
- `node-fetch` for CalDAV HTTP requests (or native fetch)
- Date parsing library (already have or use native)

### Infrastructure
- Radicale (Python): `pip install radicale`
- Optional: nginx reverse proxy for HTTPS

---

## 10. Future Considerations (Not in scope)

- Recurring events (RRULE in iCalendar)
- Calendar invites / attendees
- Two-way sync (pull from Radicale → keymaker)
- Multiple calendar support
- Reminders/notifications from keymaker directly
- CardDAV contact sync

---

## 11. Privacy Comparison

| Approach | Data Location | Third-Party Access |
|----------|--------------|-------------------|
| Google Calendar | Google servers | Google has full access |
| Apple Calendar | iCloud servers | Apple has full access |
| **CalDAV (Radicale)** | **Your VPS** | **None** |

**With this approach:**
- Event data never leaves your infrastructure
- Calendar apps connect directly to your server
- You can still use native iOS/Android calendar UX
- Full control over data retention and access

---

## Summary

This plan extends keymaker's existing commitment tracking to support:

1. **Time-specific events** via new database columns
2. **Formatted schedule display** via `/api/schedule` endpoint
3. **Privacy-preserving calendar sync** via self-hosted Radicale
4. **Native calendar app access** via standard CalDAV protocol
5. **One-way sync** with keymaker as source of truth

The user explicitly triggers calendar sync with "add to calendar" - nothing is synced automatically. Keymaker remains the authoritative source; Radicale is just a viewing/notification layer.
