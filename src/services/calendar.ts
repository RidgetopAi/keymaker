/**
 * Calendar Service: CalDAV Integration for Keymaker
 *
 * Instance #52: One-way sync from keymaker commitments to Radicale CalDAV server.
 * Keymaker is the source of truth; CalDAV is a notification/visibility layer.
 *
 * Architecture:
 * - Radicale runs on localhost:5232
 * - Calendar collection: /ridgetop/keymaker/
 * - Events stored as iCalendar (.ics) files
 * - HTTP PUT to create/update, DELETE to remove
 */

// CalDAV configuration from environment
const CALDAV_URL = process.env.CALDAV_URL || 'http://127.0.0.1:5232';
const CALDAV_USER = process.env.CALDAV_USER || 'ridgetop';
const CALDAV_PASS = process.env.CALDAV_PASS || '';
const CALDAV_CALENDAR = process.env.CALDAV_CALENDAR || '/ridgetop/keymaker/';

export interface CalendarEvent {
  uid: string;
  summary: string;
  dtstart: Date;
  dtend?: Date;
  location?: string;
  description?: string;
}

/**
 * Format a Date to iCalendar datetime format (UTC)
 * Format: YYYYMMDDTHHMMSSZ
 */
function formatICalDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Generate iCalendar content for an event (RFC 5545)
 */
function generateICS(event: CalendarEvent): string {
  const now = formatICalDate(new Date());
  const dtstart = formatICalDate(event.dtstart);
  const dtend = event.dtend
    ? formatICalDate(event.dtend)
    : formatICalDate(new Date(event.dtstart.getTime() + 60 * 60 * 1000)); // Default 1 hour

  let ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Keymaker//Calendar//EN
BEGIN:VEVENT
UID:${event.uid}
DTSTAMP:${now}
DTSTART:${dtstart}
DTEND:${dtend}
SUMMARY:${escapeICalText(event.summary)}`;

  if (event.location) {
    ics += `\nLOCATION:${escapeICalText(event.location)}`;
  }

  if (event.description) {
    ics += `\nDESCRIPTION:${escapeICalText(event.description)}`;
  }

  ics += `
END:VEVENT
END:VCALENDAR`;

  return ics;
}

/**
 * Escape text for iCalendar format
 * - Backslash, semicolon, and comma need escaping
 * - Newlines become \n
 */
function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Generate Basic Auth header
 */
function getAuthHeader(): string {
  const credentials = Buffer.from(`${CALDAV_USER}:${CALDAV_PASS}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Check if CalDAV is configured and available
 */
export async function isCalDAVConfigured(): Promise<boolean> {
  if (!CALDAV_PASS) {
    return false;
  }

  try {
    const response = await fetch(`${CALDAV_URL}${CALDAV_CALENDAR}`, {
      method: 'PROPFIND',
      headers: {
        'Authorization': getAuthHeader(),
        'Depth': '0'
      }
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Create or update an event in Radicale
 * Returns the UID of the created/updated event
 */
export async function createEvent(event: CalendarEvent): Promise<string> {
  const icsContent = generateICS(event);
  const eventUrl = `${CALDAV_URL}${CALDAV_CALENDAR}${event.uid}.ics`;

  const response = await fetch(eventUrl, {
    method: 'PUT',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'text/calendar; charset=utf-8'
    },
    body: icsContent
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`CalDAV PUT failed: ${response.status} ${text}`);
  }

  return event.uid;
}

/**
 * Update an existing event
 */
export async function updateEvent(uid: string, event: Partial<CalendarEvent>): Promise<void> {
  // For CalDAV, update is same as create (PUT is idempotent)
  const fullEvent: CalendarEvent = {
    uid,
    summary: event.summary || 'Untitled Event',
    dtstart: event.dtstart || new Date(),
    dtend: event.dtend,
    location: event.location,
    description: event.description
  };

  await createEvent(fullEvent);
}

/**
 * Delete an event from Radicale
 */
export async function deleteEvent(uid: string): Promise<void> {
  const eventUrl = `${CALDAV_URL}${CALDAV_CALENDAR}${uid}.ics`;

  const response = await fetch(eventUrl, {
    method: 'DELETE',
    headers: {
      'Authorization': getAuthHeader()
    }
  });

  // 200 OK or 404 Not Found are both acceptable
  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`CalDAV DELETE failed: ${response.status} ${text}`);
  }
}

/**
 * Generate a CalDAV UID for a commitment
 */
export function generateCommitmentUID(commitmentId: number | string): string {
  return `keymaker-commitment-${commitmentId}@keymaker`;
}

/**
 * Sync a commitment to CalDAV
 * Called when a commitment with synced_to_calendar=true is created or updated
 */
export async function syncCommitmentToCalendar(commitment: {
  id: number | string;
  description: string;
  event_time: Date;
  duration_minutes?: number;
  location?: string;
  committed_to?: string;
}): Promise<string | null> {
  // Check if CalDAV is configured
  if (!CALDAV_PASS) {
    console.log('[Calendar] CalDAV not configured (CALDAV_PASS not set)');
    return null;
  }

  const uid = generateCommitmentUID(commitment.id);

  // Calculate end time
  const durationMs = (commitment.duration_minutes || 60) * 60 * 1000;
  const dtend = new Date(commitment.event_time.getTime() + durationMs);

  const event: CalendarEvent = {
    uid,
    summary: commitment.description,
    dtstart: commitment.event_time,
    dtend,
    location: commitment.location,
    description: commitment.committed_to
      ? `Commitment to: ${commitment.committed_to}`
      : 'Created from keymaker observation'
  };

  try {
    await createEvent(event);
    console.log(`[Calendar] Synced commitment ${commitment.id} to CalDAV`);
    return uid;
  } catch (error) {
    console.error(`[Calendar] Failed to sync commitment ${commitment.id}:`, error);
    throw error;
  }
}

/**
 * Remove a commitment from CalDAV
 * Called when a commitment is completed or deleted
 */
export async function unsyncCommitmentFromCalendar(commitmentId: number | string): Promise<void> {
  if (!CALDAV_PASS) {
    return;
  }

  const uid = generateCommitmentUID(commitmentId);

  try {
    await deleteEvent(uid);
    console.log(`[Calendar] Removed commitment ${commitmentId} from CalDAV`);
  } catch (error) {
    console.error(`[Calendar] Failed to remove commitment ${commitmentId}:`, error);
    // Don't throw - removal failures shouldn't block operations
  }
}

/**
 * Get CalDAV connection status
 */
export async function getCalendarStatus(): Promise<{
  configured: boolean;
  connected: boolean;
  url: string;
  calendar: string;
  error?: string;
}> {
  const status = {
    configured: !!CALDAV_PASS,
    connected: false,
    url: CALDAV_URL,
    calendar: CALDAV_CALENDAR,
    error: undefined as string | undefined
  };

  if (!status.configured) {
    status.error = 'CALDAV_PASS environment variable not set';
    return status;
  }

  try {
    status.connected = await isCalDAVConfigured();
    if (!status.connected) {
      status.error = 'Could not connect to CalDAV server';
    }
  } catch (err) {
    status.error = err instanceof Error ? err.message : 'Unknown error';
  }

  return status;
}
