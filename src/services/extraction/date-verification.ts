/**
 * Date Verification and Correction Module
 *
 * Instance #53: Built to fix LLM date extraction errors
 *
 * The LLM understands INTENT (it's a Saturday, it's the 29th, it's at 3pm)
 * but makes mistakes with date MATH. This module:
 *
 * 1. Parses constraints from user's original input
 * 2. Verifies LLM's extracted date against those constraints
 * 3. Corrects the date using deterministic code if wrong
 */

export interface DateConstraints {
  // Day of week (0 = Sunday, 6 = Saturday)
  dayOfWeek?: number;
  dayOfWeekName?: string;

  // Day of month (1-31)
  dayOfMonth?: number;

  // Month (0 = January, 11 = December)
  month?: number;
  monthName?: string;

  // Year
  year?: number;

  // Relative indicators
  isToday?: boolean;
  isTomorrow?: boolean;
  isThisWeek?: boolean;  // "this Saturday"
  isNextWeek?: boolean;  // "next Saturday"

  // Time
  hour?: number;
  minute?: number;
  isPM?: boolean;
  isAM?: boolean;
}

export interface VerificationResult {
  isValid: boolean;
  originalDate: Date;
  correctedDate: Date;
  corrections: string[];
  confidence: number;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
                     'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * Parse date/time constraints from user's natural language input
 */
export function parseInputConstraints(input: string): DateConstraints {
  const constraints: DateConstraints = {};
  const lowerInput = input.toLowerCase();

  // Day of week: "saturday", "monday", etc.
  const dayOfWeekMatch = lowerInput.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (dayOfWeekMatch) {
    constraints.dayOfWeekName = dayOfWeekMatch[1];
    constraints.dayOfWeek = DAY_NAMES.indexOf(dayOfWeekMatch[1]);
  }

  // "this Saturday" vs "next Saturday"
  const thisNextMatch = lowerInput.match(/\b(this|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (thisNextMatch) {
    if (thisNextMatch[1] === 'this') {
      constraints.isThisWeek = true;
    } else {
      constraints.isNextWeek = true;
    }
  }

  // Day of month: "the 29th", "29th", "on the 15th"
  const dayOfMonthMatch = lowerInput.match(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/);
  if (dayOfMonthMatch) {
    constraints.dayOfMonth = parseInt(dayOfMonthMatch[1], 10);
  }

  // Month name: "november", "in december"
  const monthMatch = lowerInput.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  if (monthMatch) {
    constraints.monthName = monthMatch[1];
    constraints.month = MONTH_NAMES.indexOf(monthMatch[1]);
  }

  // Year: "2025", "2026"
  const yearMatch = lowerInput.match(/\b(202[4-9]|203[0-9])\b/);
  if (yearMatch) {
    constraints.year = parseInt(yearMatch[1], 10);
  }

  // Relative: "today", "tomorrow"
  if (/\btoday\b/.test(lowerInput)) {
    constraints.isToday = true;
  }
  if (/\btomorrow\b/.test(lowerInput)) {
    constraints.isTomorrow = true;
  }

  // Time: "at 3pm", "at 10:30 am", "at 3", "3pm"
  const timeMatch = lowerInput.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/);
  if (timeMatch) {
    constraints.hour = parseInt(timeMatch[1], 10);
    constraints.minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;

    const ampm = timeMatch[3]?.replace(/\./g, '').toLowerCase();
    if (ampm === 'am') {
      constraints.isAM = true;
    } else if (ampm === 'pm') {
      constraints.isPM = true;
    } else if (constraints.hour >= 1 && constraints.hour <= 6) {
      // No AM/PM specified, 1-6 defaults to PM for typical scheduling
      constraints.isPM = true;
    }
  }

  // "noon" = 12pm, "midnight" = 12am
  if (/\bnoon\b/.test(lowerInput)) {
    constraints.hour = 12;
    constraints.minute = 0;
    constraints.isPM = true;
  }
  if (/\bmidnight\b/.test(lowerInput)) {
    constraints.hour = 0;
    constraints.minute = 0;
    constraints.isAM = true;
  }

  return constraints;
}

/**
 * Find the next occurrence of a specific day of week
 */
function findNextDayOfWeek(fromDate: Date, targetDayOfWeek: number, allowToday: boolean = true): Date {
  const result = new Date(fromDate);
  const currentDay = result.getDay();

  let daysToAdd = targetDayOfWeek - currentDay;
  if (daysToAdd < 0 || (daysToAdd === 0 && !allowToday)) {
    daysToAdd += 7;
  }

  result.setDate(result.getDate() + daysToAdd);
  return result;
}

/**
 * Find a date that matches both day-of-week AND day-of-month
 * Searches current month first, then upcoming months
 */
function findDateMatchingBoth(
  anchorDate: Date,
  targetDayOfWeek: number,
  targetDayOfMonth: number
): Date | null {
  // Start with current month
  let checkYear = anchorDate.getFullYear();
  let checkMonth = anchorDate.getMonth();

  // Search up to 12 months ahead
  for (let i = 0; i < 12; i++) {
    // Create date for target day of month in this month
    const candidate = new Date(checkYear, checkMonth, targetDayOfMonth);

    // Check if this day exists in this month (e.g., Feb 30 doesn't exist)
    if (candidate.getMonth() === checkMonth && candidate.getDate() === targetDayOfMonth) {
      // Check if it's the right day of week AND not in the past
      if (candidate.getDay() === targetDayOfWeek && candidate >= anchorDate) {
        return candidate;
      }
    }

    // Move to next month
    checkMonth++;
    if (checkMonth > 11) {
      checkMonth = 0;
      checkYear++;
    }
  }

  return null;
}

/**
 * Main verification and correction function
 */
export function verifyAndCorrectEventDate(
  originalInput: string,
  extractedDate: Date,
  anchorDate: Date = new Date()
): VerificationResult {
  const constraints = parseInputConstraints(originalInput);
  const corrections: string[] = [];
  let correctedDate = new Date(extractedDate);

  console.log('[DateVerify] Input:', originalInput);
  console.log('[DateVerify] Constraints:', JSON.stringify(constraints));
  console.log('[DateVerify] LLM extracted:', extractedDate.toISOString());

  // 1. Check "tomorrow" constraint
  if (constraints.isTomorrow) {
    const expectedTomorrow = new Date(anchorDate);
    expectedTomorrow.setDate(expectedTomorrow.getDate() + 1);

    if (correctedDate.toDateString() !== expectedTomorrow.toDateString()) {
      corrections.push(`"tomorrow" should be ${expectedTomorrow.toDateString()}, not ${correctedDate.toDateString()}`);
      correctedDate = new Date(expectedTomorrow);
      // Preserve time from extracted date
      correctedDate.setHours(extractedDate.getHours(), extractedDate.getMinutes(), 0, 0);
    }
  }

  // 2. Check "today" constraint
  if (constraints.isToday) {
    if (correctedDate.toDateString() !== anchorDate.toDateString()) {
      corrections.push(`"today" should be ${anchorDate.toDateString()}, not ${correctedDate.toDateString()}`);
      correctedDate = new Date(anchorDate);
      correctedDate.setHours(extractedDate.getHours(), extractedDate.getMinutes(), 0, 0);
    }
  }

  // 3. Check day of week + day of month combination
  if (constraints.dayOfWeek !== undefined && constraints.dayOfMonth !== undefined) {
    const extractedDayOfWeek = correctedDate.getDay();
    const extractedDayOfMonth = correctedDate.getDate();

    const dayOfWeekWrong = extractedDayOfWeek !== constraints.dayOfWeek;
    const dayOfMonthWrong = extractedDayOfMonth !== constraints.dayOfMonth;

    if (dayOfWeekWrong || dayOfMonthWrong) {
      // Find a date where BOTH match
      const matchingDate = findDateMatchingBoth(anchorDate, constraints.dayOfWeek, constraints.dayOfMonth);

      if (matchingDate) {
        corrections.push(
          `"${constraints.dayOfWeekName} the ${constraints.dayOfMonth}${getOrdinalSuffix(constraints.dayOfMonth)}" ` +
          `is ${matchingDate.toDateString()}, not ${correctedDate.toDateString()}`
        );
        correctedDate = new Date(matchingDate);
        correctedDate.setHours(extractedDate.getHours(), extractedDate.getMinutes(), 0, 0);
      } else {
        // Can't find matching date - day of week takes priority
        corrections.push(
          `No ${constraints.dayOfWeekName} the ${constraints.dayOfMonth}${getOrdinalSuffix(constraints.dayOfMonth)} found in next 12 months. ` +
          `Using next ${constraints.dayOfWeekName} instead.`
        );
        const nextDay = findNextDayOfWeek(anchorDate, constraints.dayOfWeek);
        correctedDate = new Date(nextDay);
        correctedDate.setHours(extractedDate.getHours(), extractedDate.getMinutes(), 0, 0);
      }
    }
  }
  // 4. Check day of week only (no day of month specified)
  else if (constraints.dayOfWeek !== undefined && constraints.dayOfMonth === undefined) {
    const extractedDayOfWeek = correctedDate.getDay();

    if (extractedDayOfWeek !== constraints.dayOfWeek) {
      let targetDate: Date;

      if (constraints.isNextWeek) {
        // "next Saturday" = the Saturday AFTER this week's Saturday
        const thisDayOfWeek = findNextDayOfWeek(anchorDate, constraints.dayOfWeek, true);
        targetDate = new Date(thisDayOfWeek);
        targetDate.setDate(targetDate.getDate() + 7);
      } else {
        // "this Saturday" or just "Saturday" = upcoming occurrence
        targetDate = findNextDayOfWeek(anchorDate, constraints.dayOfWeek, true);
      }

      corrections.push(
        `"${constraints.isNextWeek ? 'next ' : ''}${constraints.dayOfWeekName}" ` +
        `should be ${targetDate.toDateString()}, not ${correctedDate.toDateString()}`
      );
      correctedDate = new Date(targetDate);
      correctedDate.setHours(extractedDate.getHours(), extractedDate.getMinutes(), 0, 0);
    }
  }
  // 5. Check day of month only (no day of week specified)
  else if (constraints.dayOfMonth !== undefined && constraints.dayOfWeek === undefined) {
    const extractedDayOfMonth = correctedDate.getDate();

    if (extractedDayOfMonth !== constraints.dayOfMonth) {
      // Assume current month if day hasn't passed, otherwise next month
      let targetDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), constraints.dayOfMonth);

      // If day is in the past, move to next month
      if (targetDate < anchorDate) {
        targetDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, constraints.dayOfMonth);
      }

      // Validate the day exists in the target month
      if (targetDate.getDate() === constraints.dayOfMonth) {
        corrections.push(
          `"the ${constraints.dayOfMonth}${getOrdinalSuffix(constraints.dayOfMonth)}" ` +
          `should be ${targetDate.toDateString()}, not ${correctedDate.toDateString()}`
        );
        correctedDate = new Date(targetDate);
        correctedDate.setHours(extractedDate.getHours(), extractedDate.getMinutes(), 0, 0);
      }
    }
  }

  // 6. Check/correct month if specified
  if (constraints.month !== undefined) {
    const extractedMonth = correctedDate.getMonth();

    if (extractedMonth !== constraints.month) {
      // Set to correct month
      let targetYear = correctedDate.getFullYear();

      // If the target month is in the past this year, use next year
      const targetDate = new Date(targetYear, constraints.month, correctedDate.getDate());
      if (targetDate < anchorDate) {
        targetYear++;
      }

      corrections.push(
        `Month should be ${constraints.monthName}, not ${MONTH_NAMES[extractedMonth]}`
      );
      correctedDate.setFullYear(targetYear, constraints.month, correctedDate.getDate());
    }
  }

  // Log results
  if (corrections.length > 0) {
    console.log('[DateVerify] Corrections made:');
    corrections.forEach(c => console.log(`  - ${c}`));
    console.log('[DateVerify] Corrected to:', correctedDate.toISOString());
  } else {
    console.log('[DateVerify] Date verified - no corrections needed');
  }

  return {
    isValid: corrections.length === 0,
    originalDate: extractedDate,
    correctedDate,
    corrections,
    confidence: corrections.length === 0 ? 1.0 : Math.max(0.5, 1.0 - (corrections.length * 0.2))
  };
}

/**
 * Get ordinal suffix for a number (1st, 2nd, 3rd, 4th, etc.)
 */
function getOrdinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Helper to create a date in Eastern timezone
 */
export function createEasternDate(year: number, month: number, day: number, hour: number = 0, minute: number = 0): Date {
  // Create date string in Eastern time
  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;

  // Create date assuming Eastern timezone
  const date = new Date(dateStr);
  return date;
}
