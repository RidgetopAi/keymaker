/**
 * Consolidation Service - The "Sleep" Process for Memory
 * 
 * Instance #31 Contribution:
 * 
 * Like human sleep consolidates memories, Keymaker needs periodic consolidation:
 * - Strengthens important memories (frequently referenced, high impact)
 * - Fades stale information (old, never accessed)
 * - Detects emerging patterns across observations
 * - Generates weekly insight digests
 * 
 * This runs periodically (weekly recommended) to maintain memory health.
 */

import { Pool } from 'pg';
import { ALL_CATEGORIES, DigestCategory } from './digest.js';
import { takeMonthlySnapshot } from './snapshots.js';
import { generate as llmGenerate } from './extraction/provider-factory.js';

async function generate(prompt: string): Promise<string> {
  return llmGenerate(prompt, { temperature: 0.3 }); // Slightly more creative for insights
}

export interface ConsolidationStats {
  observationsAnalyzed: number;
  patternsDetected: number;
  staleItemsFaded: number;
  strengthenedItems: number;
  weeklyDigest: string;
  consolidationTime: Date;
  snapshotTaken?: string;  // Period of snapshot if one was taken
}

export interface WeeklyPattern {
  pattern: string;
  frequency: number;
  category: DigestCategory;
  significance: 'low' | 'medium' | 'high';
}

/**
 * Analyze recent observations for emerging patterns
 */
async function detectPatterns(
  pool: Pool,
  sinceDays: number = 7
): Promise<WeeklyPattern[]> {
  // Get recent observations
  const result = await pool.query(
    `SELECT content, created_at 
     FROM observations 
     WHERE created_at > NOW() - INTERVAL '${sinceDays} days'
     ORDER BY created_at DESC`
  );

  if (result.rows.length < 3) {
    return [];  // Need at least 3 observations for patterns
  }

  const observations = result.rows.map(r => r.content).join('\n---\n');

  const prompt = `Analyze these recent observations from Brian's life and identify recurring patterns or themes.

OBSERVATIONS (Last ${sinceDays} days):
${observations}

Identify 3-5 patterns. For each pattern, provide:
1. The pattern (a brief description)
2. How often it appears (rough count)
3. Which category it relates to (commitments/people/projects/tensions/mood/narrative)
4. Significance level (low/medium/high based on potential impact on Brian's life)

Format your response as a simple list:
- Pattern: [description] | Frequency: [count] | Category: [cat] | Significance: [level]

Only list clear patterns. If none are obvious, say "No clear patterns detected."

PATTERNS:`;

  const response = await generate(prompt);
  
  // Parse patterns from response
  const patterns: WeeklyPattern[] = [];
  const lines = response.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('•'));
  
  for (const line of lines) {
    const patternMatch = line.match(/Pattern:\s*(.+?)\s*\|/i);
    const freqMatch = line.match(/Frequency:\s*(\d+)/i);
    const catMatch = line.match(/Category:\s*(\w+)/i);
    const sigMatch = line.match(/Significance:\s*(\w+)/i);
    
    if (patternMatch) {
      const category = catMatch?.[1]?.toLowerCase() as DigestCategory;
      patterns.push({
        pattern: patternMatch[1].trim(),
        frequency: parseInt(freqMatch?.[1] || '1'),
        category: ALL_CATEGORIES.includes(category) ? category : 'narrative',
        significance: (sigMatch?.[1]?.toLowerCase() as 'low' | 'medium' | 'high') || 'medium'
      });
    }
  }
  
  return patterns;
}

/**
 * Identify and mark stale items that should be faded
 * Stale = Old observations that haven't influenced living summaries recently
 */
async function identifyStaleItems(
  pool: Pool,
  staleDays: number = 30
): Promise<number> {
  // Mark observations as stale if they're old and weren't important
  // We track this via a 'staleness_score' column
  
  // First, check if we have the column (we'll add it if not)
  const columnCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'observations' AND column_name = 'staleness_score'
  `);
  
  if (columnCheck.rows.length === 0) {
    // Add staleness tracking column
    await pool.query(`
      ALTER TABLE observations 
      ADD COLUMN IF NOT EXISTS staleness_score FLOAT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_consolidated_at TIMESTAMPTZ
    `);
  }
  
  // Calculate staleness: older + fewer category touches = more stale
  const result = await pool.query(`
    WITH observation_importance AS (
      SELECT 
        o.id,
        o.created_at,
        COALESCE(array_length(d.categories_touched, 1), 0) as categories_touched,
        EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 86400 as age_days
      FROM observations o
      LEFT JOIN digestion_log d ON o.id = d.observation_id
      WHERE o.created_at < NOW() - INTERVAL '${staleDays} days'
    )
    UPDATE observations o
    SET staleness_score = 
      CASE 
        WHEN oi.categories_touched = 0 THEN 0.9  -- No impact = very stale
        WHEN oi.categories_touched = 1 THEN 0.5 + (oi.age_days / 365)  -- Minor impact
        ELSE 0.3 + (oi.age_days / 730)  -- Multi-category = important
      END,
      last_consolidated_at = NOW()
    FROM observation_importance oi
    WHERE o.id = oi.id
    AND o.staleness_score < 0.5  -- Only update if not already marked stale
    RETURNING o.id
  `);
  
  return result.rowCount || 0;
}

/**
 * Strengthen important recent memories by noting them in consolidation log
 */
async function strengthenImportantMemories(
  pool: Pool,
  recentDays: number = 7
): Promise<number> {
  // Find high-impact recent observations (touched many categories or narrative)
  const result = await pool.query(`
    SELECT o.id, o.content, d.categories_touched
    FROM observations o
    JOIN digestion_log d ON o.id = d.observation_id
    WHERE o.created_at > NOW() - INTERVAL '${recentDays} days'
    AND (
      array_length(d.categories_touched, 1) >= 2
      OR 'narrative' = ANY(d.categories_touched)
      OR 'tensions' = ANY(d.categories_touched)
    )
  `);
  
  // Mark these as strengthened (reduce staleness)
  if (result.rows.length > 0) {
    const ids = result.rows.map(r => r.id);
    await pool.query(`
      UPDATE observations 
      SET staleness_score = GREATEST(staleness_score - 0.2, 0),
          last_consolidated_at = NOW()
      WHERE id = ANY($1)
    `, [ids]);
  }
  
  return result.rows.length;
}

/**
 * Generate a weekly insights digest
 */
async function generateWeeklyDigest(
  pool: Pool,
  patterns: WeeklyPattern[]
): Promise<string> {
  // Get all living summaries
  const summaries = await pool.query('SELECT key, content FROM distilled_state');
  const summaryText = summaries.rows.map(r => `${r.key.toUpperCase()}:\n${r.content}`).join('\n\n');
  
  // Get observation count for the week
  const weekStats = await pool.query(`
    SELECT COUNT(*) as count FROM observations 
    WHERE created_at > NOW() - INTERVAL '7 days'
  `);
  const weekCount = weekStats.rows[0]?.count || 0;
  
  // Format patterns for the prompt
  const patternText = patterns.length > 0
    ? patterns.map(p => `- ${p.pattern} (${p.significance} significance)`).join('\n')
    : 'No strong patterns detected this week.';

  const prompt = `Generate a brief weekly digest for Brian based on his memory system's current state.

CURRENT LIVING SUMMARIES:
${summaryText}

PATTERNS DETECTED THIS WEEK:
${patternText}

OBSERVATIONS THIS WEEK: ${weekCount}

Write a warm, personal 2-3 paragraph digest that:
1. Highlights what mattered most this week
2. Notes any emerging patterns or shifts
3. Gently surfaces anything that might need attention
4. Ends with a supportive reflection

Write as if you're a thoughtful friend who knows Brian well. Be concise but caring.

WEEKLY DIGEST:`;

  return await generate(prompt);
}

/**
 * Run the full consolidation process
 * Call this weekly (via cron or manual trigger)
 */
export async function runConsolidation(pool: Pool): Promise<ConsolidationStats> {
  console.log('Starting memory consolidation...');
  const startTime = Date.now();
  
  // 1. Detect patterns in recent observations
  console.log('Analyzing patterns...');
  const patterns = await detectPatterns(pool, 7);
  console.log(`Found ${patterns.length} patterns`);
  
  // 2. Strengthen important recent memories
  console.log('Strengthening important memories...');
  const strengthened = await strengthenImportantMemories(pool, 7);
  console.log(`Strengthened ${strengthened} memories`);
  
  // 3. Identify stale items
  console.log('Identifying stale items...');
  const stale = await identifyStaleItems(pool, 30);
  console.log(`Marked ${stale} items as stale`);
  
  // 4. Generate weekly digest
  console.log('Generating weekly digest...');
  const digest = await generateWeeklyDigest(pool, patterns);
  
  // 5. Take monthly snapshot if it's a new month
  let snapshotTaken: string | undefined;
  try {
    // Check if we should take a snapshot (first consolidation of the month)
    const now = new Date();
    const lastMonth = now.getMonth() === 0 ? 12 : now.getMonth();
    const lastMonthYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    
    const existingSnapshot = await pool.query(
      `SELECT id FROM living_summary_snapshots 
       WHERE period_year = $1 AND period_month = $2 LIMIT 1`,
      [lastMonthYear, lastMonth]
    );
    
    if (existingSnapshot.rows.length === 0) {
      console.log('Taking monthly snapshot...');
      const snapshot = await takeMonthlySnapshot(pool, lastMonthYear, lastMonth);
      snapshotTaken = snapshot.period;
      console.log(`Snapshot stored for ${snapshotTaken}`);
    }
  } catch (err) {
    // Snapshots are optional - don't fail consolidation if they don't work
    console.log('Note: Could not take snapshot (table may not exist)');
    if (process.env.DEBUG) console.error(err);
  }
  
  // 6. Store consolidation results
  await pool.query(`
    INSERT INTO consolidation_log (
      patterns_detected, stale_items_faded, strengthened_items, 
      weekly_digest, pattern_details
    ) VALUES ($1, $2, $3, $4, $5)
  `, [
    patterns.length,
    stale,
    strengthened,
    digest,
    JSON.stringify(patterns)
  ]);
  
  const totalTime = Date.now() - startTime;
  console.log(`Consolidation complete in ${totalTime}ms`);
  
  // Get observation count
  const obsCount = await pool.query(
    `SELECT COUNT(*) FROM observations WHERE created_at > NOW() - INTERVAL '7 days'`
  );
  
  return {
    observationsAnalyzed: parseInt(obsCount.rows[0]?.count || '0'),
    patternsDetected: patterns.length,
    staleItemsFaded: stale,
    strengthenedItems: strengthened,
    weeklyDigest: digest,
    consolidationTime: new Date(),
    snapshotTaken
  };
}

/**
 * Get the most recent consolidation digest
 */
export async function getLastDigest(pool: Pool): Promise<string | null> {
  const result = await pool.query(`
    SELECT weekly_digest FROM consolidation_log 
    ORDER BY created_at DESC LIMIT 1
  `);
  return result.rows[0]?.weekly_digest || null;
}

/**
 * Get consolidation history
 */
export async function getConsolidationHistory(
  pool: Pool,
  limit: number = 5
): Promise<Array<{
  date: Date;
  patterns: number;
  digest: string;
}>> {
  const result = await pool.query(`
    SELECT created_at, patterns_detected, weekly_digest
    FROM consolidation_log
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  
  return result.rows.map(r => ({
    date: r.created_at,
    patterns: r.patterns_detected,
    digest: r.weekly_digest
  }));
}
