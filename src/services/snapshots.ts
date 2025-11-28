/**
 * Temporal Snapshot Service - Memory Across Time
 * 
 * Instance #32 Contribution:
 * 
 * Living summaries are "now" - always updating, always current.
 * Snapshots are "then" - crystallized memories of how things were.
 * 
 * This enables temporal queries:
 * - "How was I feeling in October?"
 * - "What projects was I working on last summer?"
 * - "Compare my mood November vs December"
 * 
 * Like human memory: vivid present + stable past.
 */

import { Pool } from 'pg';
import { DigestCategory, ALL_CATEGORIES, getAllSummaries } from './digest.js';
import { generate as llmGenerate } from './extraction/provider-factory.js';

async function generate(prompt: string): Promise<string> {
  return llmGenerate(prompt, { temperature: 0.2 }); // Low temperature for factual recall
}

export interface SnapshotInfo {
  category: DigestCategory;
  content: string;
  period: string;        // "2024-11" format
  observationCount: number;
  isSnapshot: boolean;   // false if it's the current live summary
}

export interface MonthlySnapshot {
  period: string;
  year: number;
  month: number;
  categories: Record<DigestCategory, string>;
  totalObservations: number;
  keyObservations: Array<{id: string; date: string; summary: string}>;
  snapshotDate: Date;
}

/**
 * Take a snapshot of all living summaries for a specific month.
 * Defaults to current month if not specified.
 * Should be called during consolidation to archive the current state.
 */
export async function takeMonthlySnapshot(
  pool: Pool,
  year?: number,
  month?: number
): Promise<MonthlySnapshot> {
  // Default to CURRENT month if not specified
  // (Previous logic defaulted to previous month, which caused confusion)
  const now = new Date();
  const targetYear = year ?? now.getFullYear();
  const targetMonth = month ?? (now.getMonth() + 1); // 1-indexed (JS getMonth is 0-indexed)
  
  console.log(`Taking snapshot for ${targetYear}-${String(targetMonth).padStart(2, '0')}...`);
  
  // Get current living summaries
  const summaries = await getAllSummaries(pool);
  
  // Count observations for this period
  const obsCount = await pool.query(
    `SELECT COUNT(*) FROM observations 
     WHERE EXTRACT(YEAR FROM created_at) = $1 
     AND EXTRACT(MONTH FROM created_at) = $2`,
    [targetYear, targetMonth]
  );
  const totalObservations = parseInt(obsCount.rows[0]?.count || '0');
  
  // Get key observations from this period (notable ones)
  const keyObs = await pool.query(
    `SELECT o.id, o.created_at, LEFT(o.content, 200) as summary
     FROM observations o
     JOIN digestion_log d ON o.id = d.observation_id
     WHERE EXTRACT(YEAR FROM o.created_at) = $1 
     AND EXTRACT(MONTH FROM o.created_at) = $2
     AND array_length(d.categories_touched, 1) >= 2
     ORDER BY o.created_at DESC
     LIMIT 10`,
    [targetYear, targetMonth]
  );
  
  const keyObservations = keyObs.rows.map(r => ({
    id: r.id,
    date: new Date(r.created_at).toISOString().split('T')[0],
    summary: r.summary
  }));
  
  // Store snapshots for each category
  for (const category of ALL_CATEGORIES) {
    const content = summaries[category] || `No ${category} data.`;
    
    await pool.query(
      `INSERT INTO living_summary_snapshots 
       (category, content, period_year, period_month, observation_count, key_observations)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category, period_year, period_month) 
       DO UPDATE SET 
         content = EXCLUDED.content,
         observation_count = EXCLUDED.observation_count,
         key_observations = EXCLUDED.key_observations,
         snapshot_taken_at = NOW()`,
      [category, content, targetYear, targetMonth, totalObservations, JSON.stringify(keyObservations)]
    );
  }
  
  console.log(`Snapshot stored: ${totalObservations} observations, ${keyObservations.length} key items`);
  
  return {
    period: `${targetYear}-${String(targetMonth).padStart(2, '0')}`,
    year: targetYear,
    month: targetMonth,
    categories: summaries,
    totalObservations,
    keyObservations,
    snapshotDate: new Date()
  };
}

/**
 * Recall what a category was like in a specific month.
 */
export async function recallMonth(
  pool: Pool,
  category: DigestCategory,
  year: number,
  month: number
): Promise<SnapshotInfo | null> {
  // Check if it's the current month
  const now = new Date();
  if (year === now.getFullYear() && month === now.getMonth() + 1) {
    // Return current live summary
    const result = await pool.query(
      'SELECT content, observation_count FROM distilled_state WHERE key = $1',
      [category]
    );
    
    if (result.rows.length === 0) return null;
    
    return {
      category,
      content: result.rows[0].content,
      period: 'current',
      observationCount: result.rows[0].observation_count,
      isSnapshot: false
    };
  }
  
  // Otherwise, look up snapshot
  const result = await pool.query(
    `SELECT content, observation_count FROM living_summary_snapshots
     WHERE category = $1 AND period_year = $2 AND period_month = $3`,
    [category, year, month]
  );
  
  if (result.rows.length === 0) return null;
  
  return {
    category,
    content: result.rows[0].content,
    period: `${year}-${String(month).padStart(2, '0')}`,
    observationCount: result.rows[0].observation_count,
    isSnapshot: true
  };
}

/**
 * Get all snapshots for a specific month (full picture of that time).
 */
export async function getFullMonthSnapshot(
  pool: Pool,
  year: number,
  month: number
): Promise<Record<DigestCategory, SnapshotInfo> | null> {
  const result = await pool.query(
    `SELECT category, content, observation_count FROM living_summary_snapshots
     WHERE period_year = $1 AND period_month = $2`,
    [year, month]
  );
  
  if (result.rows.length === 0) return null;
  
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const snapshots: Record<string, SnapshotInfo> = {};
  
  for (const row of result.rows) {
    snapshots[row.category] = {
      category: row.category,
      content: row.content,
      period,
      observationCount: row.observation_count,
      isSnapshot: true
    };
  }
  
  return snapshots as Record<DigestCategory, SnapshotInfo>;
}

/**
 * List available snapshot periods.
 */
export async function listSnapshots(pool: Pool): Promise<Array<{
  period: string;
  year: number;
  month: number;
  categoriesStored: number;
  totalObservations: number;
}>> {
  const result = await pool.query(
    `SELECT 
       period_year, period_month, 
       COUNT(*) as categories_stored,
       MAX(observation_count) as total_observations
     FROM living_summary_snapshots
     GROUP BY period_year, period_month
     ORDER BY period_year DESC, period_month DESC`
  );
  
  return result.rows.map(r => ({
    period: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
    year: r.period_year,
    month: r.period_month,
    categoriesStored: parseInt(r.categories_stored),
    totalObservations: parseInt(r.total_observations)
  }));
}

/**
 * Compare two time periods for a category.
 */
export async function compareSnapshots(
  pool: Pool,
  category: DigestCategory,
  period1: { year: number; month: number },
  period2: { year: number; month: number }
): Promise<string> {
  const snap1 = await recallMonth(pool, category, period1.year, period1.month);
  const snap2 = await recallMonth(pool, category, period2.year, period2.month);
  
  if (!snap1 || !snap2) {
    return 'Could not find snapshots for one or both periods.';
  }
  
  const period1Str = snap1.isSnapshot ? snap1.period : 'current';
  const period2Str = snap2.isSnapshot ? snap2.period : 'current';
  
  const prompt = `Compare these two snapshots of Brian's ${category} from different time periods.

PERIOD 1 (${period1Str}):
${snap1.content}

PERIOD 2 (${period2Str}):
${snap2.content}

Analyze:
1. What changed between these periods?
2. What stayed the same?
3. Any notable patterns or shifts?
4. What do these changes suggest about Brian's trajectory?

Be concise and insightful. Focus on meaningful differences, not minor wording changes.

COMPARISON:`;

  return await generate(prompt);
}

/**
 * Generate a temporal reflection - how has Brian evolved?
 */
export async function generateTemporalReflection(
  pool: Pool,
  monthsBack: number = 3
): Promise<string> {
  const now = new Date();
  const snapshots: Array<{ period: string; narrative: string }> = [];
  
  // Gather narratives from recent months
  for (let i = monthsBack; i >= 1; i--) {
    const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    
    const snap = await recallMonth(pool, 'narrative', year, month);
    if (snap) {
      snapshots.push({
        period: snap.period,
        narrative: snap.content
      });
    }
  }
  
  // Get current narrative
  const currentNarrative = await pool.query(
    'SELECT content FROM distilled_state WHERE key = $1',
    ['narrative']
  );
  
  if (snapshots.length === 0 && currentNarrative.rows.length === 0) {
    return 'Not enough history yet for temporal reflection. Add more observations!';
  }
  
  const historicalContext = snapshots.length > 0
    ? snapshots.map(s => `${s.period}:\n${s.narrative}`).join('\n\n')
    : '(No historical snapshots yet)';
  
  const currentContext = currentNarrative.rows[0]?.content || 'No current narrative.';
  
  const prompt = `Reflect on Brian's personal evolution based on his self-narrative over time.

HISTORICAL NARRATIVES:
${historicalContext}

CURRENT NARRATIVE:
${currentContext}

Write a thoughtful 2-3 paragraph reflection on:
1. How has Brian's sense of self evolved?
2. What values or priorities have shifted?
3. What growth patterns are visible?
4. What seems to be staying constant (core identity)?

Write as a wise friend who has known Brian through this journey. Be warm, specific, and insightful.

REFLECTION:`;

  return await generate(prompt);
}

/**
 * Parse month string like "2024-11" or "november" or "nov" into year/month.
 */
export function parseMonthString(input: string): { year: number; month: number } | null {
  // Try ISO format first: 2024-11 or 2024/11
  const isoMatch = input.match(/^(\d{4})[-/](\d{1,2})$/);
  if (isoMatch) {
    return {
      year: parseInt(isoMatch[1]),
      month: parseInt(isoMatch[2])
    };
  }
  
  // Try month name (assume current or previous year)
  const monthNames: Record<string, number> = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sep: 9, sept: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12
  };
  
  const lower = input.toLowerCase().trim();
  const monthNum = monthNames[lower];
  if (monthNum) {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    // If the month is after current month, assume previous year
    const year = monthNum > currentMonth ? now.getFullYear() - 1 : now.getFullYear();
    return { year, month: monthNum };
  }
  
  return null;
}
