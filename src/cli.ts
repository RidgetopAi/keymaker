#!/usr/bin/env npx tsx

// Load environment variables from .env file
import 'dotenv/config';

import { Pool } from 'pg';
import { 
  digestObservation, 
  getLivingSummary, 
  getAllSummaries, 
  rebuildCategory, 
  rebuildAll,
  DigestCategory,
  ALL_CATEGORIES 
} from './services/digest.js';
import { 
  extractAndStoreEntities,
  findSimilarPeople,
  findSimilarProjects 
} from './services/extraction/index.js';
import {
  runConsolidation,
  getLastDigest,
  getConsolidationHistory
} from './services/consolidation.js';
import {
  takeMonthlySnapshot,
  recallMonth,
  getFullMonthSnapshot,
  listSnapshots,
  compareSnapshots,
  generateTemporalReflection,
  parseMonthString
} from './services/snapshots.js';

import { generate as llmGenerate, embed as llmEmbed, healthCheck as llmHealthCheck } from './services/extraction/provider-factory.js';

// Environment-based configuration
const ENV = process.env.KEYMAKER_ENV || 'production';
const config = {
  production: {
    database: 'keymaker_production',
    name: 'Production'
  },
  development: {
    database: 'keymaker_dev',
    name: 'Development'
  }
}[ENV] || { database: 'keymaker_dev', name: 'Development' };

// Use DATABASE_URL if provided (for VPS), otherwise use local socket auth
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      host: 'localhost',
      port: 5432,
      database: config.database,
    });

// Export for API server
export { pool, config, ENV, embed, generate };

async function embed(text: string): Promise<number[]> {
  return llmEmbed(text);
}

async function generate(prompt: string): Promise<string> {
  return llmGenerate(prompt);
}

async function observe(text: string): Promise<void> {
  console.log('Storing observation...');

  const embedding = await embed(text);
  const embeddingStr = `[${embedding.join(',')}]`;

  const result = await pool.query(
    `INSERT INTO observations (content, embedding)
     VALUES ($1, $2::vector)
     RETURNING id, created_at`,
    [text, embeddingStr]
  );

  const id = result.rows[0].id;
  const createdAt = new Date(result.rows[0].created_at);
  
  console.log(`Stored observation ${id}`);
  console.log(`Created at: ${createdAt.toLocaleString()}`);
  
  // Digest into living summaries (the key architectural shift!)
  try {
    console.log('\nDigesting into memory...');
    const categories = await digestObservation(pool, id, text, createdAt);
    if (categories.length > 0) {
      console.log(`✓ Updated: ${categories.join(', ')}`);
    } else {
      console.log('✓ Stored (no categories updated)');
    }
  } catch (err) {
    // Don't fail the observe if digestion fails - the observation is already stored
    console.log('Note: Digestion skipped (run "keymaker rebuild" to catch up)');
    if (process.env.DEBUG) {
      console.error('Digestion error:', err);
    }
  }
  
  // Entity extraction (structured entities for targeted queries)
  // With Groq, extraction is fast enough to run automatically on every observe
  // Set KEYMAKER_SKIP_EXTRACT=1 to disable if needed
  if (process.env.KEYMAKER_SKIP_EXTRACT !== '1') {
    try {
      console.log('Extracting entities...');
      const result = await extractAndStoreEntities(pool, id, text);
      const counts = [];
      if (result.people.length > 0) counts.push(`${result.people.length} people`);
      if (result.projects.length > 0) counts.push(`${result.projects.length} projects`);
      if (result.commitments.length > 0) counts.push(`${result.commitments.length} commitments`);
      if (result.beliefs.length > 0) counts.push(`${result.beliefs.length} beliefs`);
      if (counts.length > 0) {
        console.log(`✓ Extracted: ${counts.join(', ')} (${result.extraction_time_ms}ms)`);
      } else {
        console.log('✓ No new entities');
      }
    } catch (err) {
      console.log('Note: Entity extraction failed (observation still saved)');
      if (process.env.DEBUG) {
        console.error('Extraction error:', err);
      }
    }
  }
}

/**
 * Parse a date range from args like --from october --to november
 */
function parseDateRange(args: string[]): { from?: Date; to?: Date } {
  const fromIdx = args.indexOf('--from');
  const toIdx = args.indexOf('--to');
  
  let from: Date | undefined;
  let to: Date | undefined;
  
  if (fromIdx !== -1 && args[fromIdx + 1]) {
    const parsed = parseMonthString(args[fromIdx + 1]);
    if (parsed) {
      from = new Date(parsed.year, parsed.month - 1, 1);
    }
  }
  
  if (toIdx !== -1 && args[toIdx + 1]) {
    const parsed = parseMonthString(args[toIdx + 1]);
    if (parsed) {
      // End of month
      to = new Date(parsed.year, parsed.month, 0, 23, 59, 59);
    }
  }
  
  return { from, to };
}

/**
 * Temporal range search - search within a specific time period
 */
async function searchRange(
  question: string, 
  from?: Date, 
  to?: Date, 
  limit: number = 10
): Promise<void> {
  const dateRange = from || to 
    ? `${from ? from.toLocaleDateString() : 'start'} to ${to ? to.toLocaleDateString() : 'now'}`
    : 'all time';
  console.log(`Searching observations (${dateRange})...\n`);

  const embedding = await embed(question);
  const embeddingStr = `[${embedding.join(',')}]`;

  // Build temporal filter
  const params: (string | Date)[] = [embeddingStr];
  let dateFilter = '';
  if (from) {
    params.push(from.toISOString());
    dateFilter += ` AND created_at >= $${params.length}::timestamptz`;
  }
  if (to) {
    params.push(to.toISOString());
    dateFilter += ` AND created_at <= $${params.length}::timestamptz`;
  }

  const result = await pool.query(
    `SELECT id, content, created_at,
            1 - (embedding <=> $1::vector) as similarity
     FROM observations
     WHERE 1 - (embedding <=> $1::vector) > 0.10 ${dateFilter}
     ORDER BY similarity DESC
     LIMIT ${limit}`,
    params
  );

  if (result.rows.length === 0) {
    console.log(`No observations found in ${dateRange} matching "${question}"`);
    return;
  }

  console.log(`=== Found ${result.rows.length} observations ===\n`);
  
  for (const row of result.rows) {
    const date = new Date(row.created_at);
    const dateStr = date.toLocaleDateString('en-US', { 
      month: 'short', day: 'numeric', year: 'numeric' 
    });
    const simPercent = (row.similarity * 100).toFixed(1);
    console.log(`[${dateStr}] (${simPercent}% match)`);
    console.log(`  ${row.content.slice(0, 200)}${row.content.length > 200 ? '...' : ''}`);
    console.log('');
  }
}

/**
 * Find first mention of something - "When did I first mention X?"
 */
async function findFirstMention(query: string): Promise<void> {
  console.log(`Finding first mention of "${query}"...\n`);

  const embedding = await embed(query);
  const embeddingStr = `[${embedding.join(',')}]`;

  // Find all matches sorted by date ascending (oldest first)
  const result = await pool.query(
    `SELECT id, content, created_at,
            1 - (embedding <=> $1::vector) as similarity
     FROM observations
     WHERE 1 - (embedding <=> $1::vector) > 0.25
     ORDER BY created_at ASC
     LIMIT 5`,
    [embeddingStr]
  );

  if (result.rows.length === 0) {
    console.log(`No observations found mentioning "${query}"`);
    return;
  }

  const first = result.rows[0];
  const firstDate = new Date(first.created_at);
  
  console.log('=== First Mention ===\n');
  console.log(`Date: ${firstDate.toLocaleDateString('en-US', { 
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  })}`);
  console.log(`Match: ${(first.similarity * 100).toFixed(1)}%`);
  console.log(`\n"${first.content}"\n`);

  if (result.rows.length > 1) {
    console.log('=== Also Mentioned ===\n');
    for (let i = 1; i < result.rows.length; i++) {
      const row = result.rows[i];
      const date = new Date(row.created_at);
      console.log(`[${date.toLocaleDateString()}] ${row.content.slice(0, 100)}...`);
    }
  }
}

async function query(question: string, limit: number = 5): Promise<void> {
  console.log('Searching for relevant observations...\n');

  const embedding = await embed(question);
  const embeddingStr = `[${embedding.join(',')}]`;

  // Extract keywords for hybrid search (words 3+ chars, lowercase)
  const keywords = question.toLowerCase()
    .split(/\W+/)
    .filter(w => w.length >= 3 && !['the', 'and', 'how', 'what', 'who', 'when', 'where', 'why', 'was', 'has', 'are', 'for', 'with'].includes(w));

  // Detect temporal queries (this week, today, recently, etc.)
  const temporalPatterns = ['this week', 'today', 'tomorrow', 'yesterday', 'recently', 'lately', 'now', 'current', 'upcoming'];
  const isTemporalQuery = temporalPatterns.some(p => question.toLowerCase().includes(p));

  // Hybrid search: semantic + keyword + temporal matching
  const result = await pool.query(
    `WITH semantic AS (
      SELECT id, content, created_at,
             1 - (embedding <=> $1::vector) as semantic_score
      FROM observations
      WHERE 1 - (embedding <=> $1::vector) > 0.15
    ),
    keyword AS (
      SELECT id, content, created_at,
             0.0 as semantic_score
      FROM observations
      WHERE ${keywords.length > 0
        ? keywords.map((_, i) => `LOWER(content) LIKE '%' || $${i + 2} || '%'`).join(' OR ')
        : 'FALSE'}
    ),
    temporal AS (
      SELECT id, content, created_at,
             0.0 as semantic_score
      FROM observations
      WHERE ${isTemporalQuery ? `created_at > NOW() - INTERVAL '7 days'` : 'FALSE'}
    ),
    combined AS (
      SELECT COALESCE(s.id, k.id, t.id) as id,
             COALESCE(s.content, k.content, t.content) as content,
             COALESCE(s.created_at, k.created_at, t.created_at) as created_at,
             COALESCE(s.semantic_score, 0) as semantic_score,
             CASE WHEN k.id IS NOT NULL THEN 0.15 ELSE 0 END as keyword_bonus,
             CASE WHEN t.id IS NOT NULL THEN 0.20 ELSE 0 END as temporal_bonus
      FROM semantic s
      FULL OUTER JOIN keyword k ON s.id = k.id
      FULL OUTER JOIN temporal t ON COALESCE(s.id, k.id) = t.id
    )
    SELECT DISTINCT ON (id) content,
           semantic_score + keyword_bonus + temporal_bonus as similarity,
           created_at
    FROM combined
    ORDER BY id, similarity DESC`,
    [embeddingStr, ...keywords]
  );

  // Re-sort by combined score and apply limit
  const sorted = result.rows
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .filter(r => r.similarity > 0.20);

  if (sorted.length === 0) {
    console.log('No observations found. Add some with: keymaker observe "your text"');
    return;
  }

  // Build context for display (with metadata)
  const displayContext = sorted
    .map((row, i) => `[${i + 1}] (${(row.similarity * 100).toFixed(1)}% match, ${new Date(row.created_at).toLocaleDateString()})\n${row.content}`)
    .join('\n\n');

  // Build context for LLM (content only)
  const llmContext = sorted
    .map((row, i) => `${i + 1}. ${row.content}`)
    .join('\n');

  console.log('=== Retrieved Observations ===\n');
  console.log(displayContext);
  console.log('\n=== Synthesized Answer ===\n');

  // Synthesize answer using LLM
  const prompt = `You are helping Brian recall information from his personal observations. Answer the question based only on these observations.

Observations:
${llmContext}

Question: ${question}

Answer concisely based only on what's in the observations. If they don't contain enough information, say so.

Answer:`;

  const answer = await generate(prompt);
  console.log(answer);
}

async function list(limit: number = 10): Promise<void> {
  const result = await pool.query(
    `SELECT id, content, created_at
     FROM observations
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );

  if (result.rows.length === 0) {
    console.log('No observations yet. Add some with: keymaker observe "your text"');
    return;
  }

  console.log(`=== Recent Observations (${result.rows.length}) ===\n`);
  for (const row of result.rows) {
    const date = new Date(row.created_at).toLocaleString();
    console.log(`[${date}]`);
    console.log(row.content);
    console.log('');
  }
}

async function commits(): Promise<void> {
  console.log('Reading commitments from memory...\n');

  try {
    // Read from living summary (fast! no LLM call needed)
    const summary = await getLivingSummary(pool, 'commitments');
    
    console.log('=== Current Commitments ===\n');
    console.log(summary.content);
    console.log(`\n(Updated: ${summary.updatedAt.toLocaleString()}, from ${summary.observationCount} observations)`);
    
    // Check for any recent observations that might not be digested yet
    const recent = await pool.query(
      `SELECT COUNT(*) as count FROM observations 
       WHERE created_at > $1`,
      [summary.updatedAt]
    );
    
    if (parseInt(recent.rows[0].count) > 0) {
      console.log(`\nNote: ${recent.rows[0].count} new observation(s) since last digest. Run "keymaker rebuild commitments" to update.`);
    }
  } catch (err) {
    // Fallback to old behavior if distilled_state doesn't exist yet
    console.log('Living summaries not initialized. Falling back to full analysis...\n');
    await commitsFallback();
  }
}

// Fallback for when distilled_state table doesn't exist
async function commitsFallback(): Promise<void> {
  const result = await pool.query(
    `SELECT content, created_at FROM observations ORDER BY created_at DESC`
  );

  if (result.rows.length === 0) {
    console.log('No observations yet. Add some with: keymaker observe "your text"');
    return;
  }

  const context = result.rows
    .map((row, i) => `[${new Date(row.created_at).toLocaleDateString()}] ${row.content}`)
    .join('\n');

  const prompt = `Analyze these personal observations and extract any commitments, promises, or tasks Brian has made.

Observations:
${context}

For each commitment found, provide:
- What was committed to
- Who it was made to (if mentioned)
- When it was made
- Status (if you can infer: pending, completed, or overdue)

If no commitments are found, say "No commitments found."

Format your response as a clear list. Be specific and only extract what's actually mentioned.

Commitments:`;

  const answer = await generate(prompt);
  console.log('=== Extracted Commitments ===\n');
  console.log(answer);
}

async function stats(): Promise<void> {
  // Get observation stats
  const countResult = await pool.query(
    `SELECT COUNT(*) as total,
            MIN(created_at) as earliest,
            MAX(created_at) as latest
     FROM observations`
  );

  const row = countResult.rows[0];
  const total = parseInt(row.total);

  if (total === 0) {
    console.log('No observations stored yet.');
    return;
  }

  console.log('=== Keymaker Memory Stats ===\n');
  console.log(`Total observations: ${total}`);
  console.log(`Earliest: ${new Date(row.earliest).toLocaleString()}`);
  console.log(`Latest: ${new Date(row.latest).toLocaleString()}`);

  // Get observations per day (last 7 days)
  const dailyResult = await pool.query(
    `SELECT DATE(created_at) as day, COUNT(*) as count
     FROM observations
     WHERE created_at > NOW() - INTERVAL '7 days'
     GROUP BY DATE(created_at)
     ORDER BY day DESC`
  );

  if (dailyResult.rows.length > 0) {
    console.log('\nLast 7 days:');
    for (const dayRow of dailyResult.rows) {
      console.log(`  ${new Date(dayRow.day).toLocaleDateString()}: ${dayRow.count} observations`);
    }
  }
}

async function about(topic: string): Promise<void> {
  console.log(`Finding everything about: ${topic}\n`);

  const embedding = await embed(topic);
  const embeddingStr = `[${embedding.join(',')}]`;

  // Get more results for topic synthesis (top 10)
  const result = await pool.query(
    `SELECT content, 1 - (embedding <=> $1::vector) as similarity, created_at
     FROM observations
     WHERE 1 - (embedding <=> $1::vector) > 0.25
     ORDER BY embedding <=> $1::vector
     LIMIT 10`,
    [embeddingStr]
  );

  if (result.rows.length === 0) {
    console.log(`No observations found about "${topic}".`);
    return;
  }

  // Build context for LLM
  const context = result.rows
    .map((row, i) => `[${new Date(row.created_at).toLocaleDateString()}] ${row.content}`)
    .join('\n');

  const prompt = `Based on these observations, provide a comprehensive summary about "${topic}".

Observations:
${context}

Synthesize everything Brian knows about this topic. Include:
- Key facts
- Relationships or connections
- Timeline of events (if relevant)
- Any patterns or insights

Summary:`;

  const answer = await generate(prompt);
  console.log(`=== About: ${topic} ===\n`);
  console.log(answer);
}

async function people(): Promise<void> {
  console.log('Reading people from memory...\n');

  try {
    // Read from living summary (fast!)
    const summary = await getLivingSummary(pool, 'people');
    
    console.log('=== People Brian Knows ===\n');
    console.log(summary.content);
    console.log(`\n(Updated: ${summary.updatedAt.toLocaleString()}, from ${summary.observationCount} observations)`);
  } catch (err) {
    // Fallback to old behavior
    console.log('Living summaries not initialized. Falling back to full analysis...\n');
    await peopleFallback();
  }
}

async function peopleFallback(): Promise<void> {
  const result = await pool.query(
    `SELECT content, created_at FROM observations ORDER BY created_at DESC`
  );

  if (result.rows.length === 0) {
    console.log('No observations yet. Add some with: keymaker observe "your text"');
    return;
  }

  const context = result.rows
    .map(row => row.content)
    .join('\n');

  const prompt = `Analyze these personal observations and extract all people mentioned.

Observations:
${context}

For each person identified, provide:
- Their name
- Their role or relationship
- What Brian knows about them
- Any interactions or commitments involving them

Format as a structured list. Only include people explicitly mentioned, not organizations or abstract entities.

People:`;

  const answer = await generate(prompt);
  console.log('=== People in Memory ===\n');
  console.log(answer);
}

async function decisions(): Promise<void> {
  console.log('Extracting all decisions from observations...\n');

  // Get all observations
  const result = await pool.query(
    `SELECT content, created_at FROM observations ORDER BY created_at DESC`
  );

  if (result.rows.length === 0) {
    console.log('No observations yet. Add some with: keymaker observe "your text"');
    return;
  }

  // Build context for LLM
  const context = result.rows
    .map((row, i) => `[${new Date(row.created_at).toLocaleDateString()}] ${row.content}`)
    .join('\n');

  const prompt = `Analyze these personal observations and extract all decisions made.

Observations:
${context}

For each decision found, provide:
- What was decided
- Who was involved in the decision
- The reasoning or factors considered
- Any trade-offs mentioned
- The outcome or next steps

Only extract explicit decisions, not general intentions or preferences.

Decisions:`;

  const answer = await generate(prompt);
  console.log('=== Decisions Tracked ===\n');
  console.log(answer);
}

async function timeline(): Promise<void> {
  console.log('Building chronological narrative...\n');

  // Get all observations ordered by time
  const result = await pool.query(
    `SELECT content, created_at FROM observations ORDER BY created_at ASC`
  );

  if (result.rows.length === 0) {
    console.log('No observations yet. Add some with: keymaker observe "your text"');
    return;
  }

  // Build context for LLM
  const context = result.rows
    .map((row, i) => {
      const date = new Date(row.created_at);
      const timeStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
      return `[${timeStr}]\n${row.content}`;
    })
    .join('\n\n');

  const prompt = `Create a chronological narrative from these observations, showing how things evolved over time.

Observations (in chronological order):
${context}

Create a cohesive narrative that:
- Shows the progression of events and thoughts
- Highlights cause-and-effect relationships
- Identifies turning points or significant moments
- Connects related events across time
- Notes any patterns or cycles

Narrative:`;

  const answer = await generate(prompt);
  console.log('=== Timeline Narrative ===\n');
  console.log(answer);
}

async function mood(): Promise<void> {
  console.log('Analyzing emotional state and mood patterns...\n');

  // Get recent observations (prioritize recency for emotional state)
  const recent = await pool.query(
    `SELECT content, created_at
     FROM observations
     ORDER BY created_at DESC
     LIMIT 20`
  );

  if (recent.rows.length === 0) {
    console.log('No observations yet. Add some with: keymaker observe "your text"');
    return;
  }

  // Build context with dates
  const context = recent.rows
    .map(row => {
      const date = new Date(row.created_at);
      const timeAgo = getTimeAgo(date);
      return `[${timeAgo}] ${row.content}`;
    })
    .join('\n');

  const prompt = `Based on these observations, describe Brian's current emotional state and recent mood patterns:

${context}

Focus on:
1. Most recent emotional indicators (prioritize newest observations)
2. Any mood patterns or trends over time
3. Potential stressors or positive factors
4. Overall emotional trajectory
5. Energy levels and motivation indicators

Look for explicit emotional words (feeling, mood, stressed, happy, sad, excited, tired, energized, frustrated, etc.) as well as implicit indicators in activities and interactions.

Be specific about what observations inform your assessment. If emotional state is unclear from observations, say so.

Assessment:`;

  const response = await generate(prompt);
  console.log('=== Brian\'s Emotional State ===\n');
  console.log(response);
}

// Helper function to format time ago
function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return 'just now';
}

async function surface(): Promise<void> {
  console.log('Surfacing insights from memory...\n');

  try {
    // Read all living summaries (fast! pre-digested)
    const summaries = await getAllSummaries(pool);
    
    // Get very recent observations for freshness (last 3 days only)
    const recent = await pool.query(
      `SELECT content, created_at FROM observations
       WHERE created_at > NOW() - INTERVAL '3 days'
       ORDER BY created_at DESC
       LIMIT 10`
    );
    
    const recentContext = recent.rows.length > 0
      ? recent.rows.map(row => `[${new Date(row.created_at).toLocaleDateString()}] ${row.content}`).join('\n')
      : '(No observations in last 3 days)';

    // Now synthesize insights from the pre-digested state (much smaller context!)
    const prompt = `You are Keymaker, Brian's personal memory assistant. Based on this current understanding of Brian's life, surface what's important right now.

WHO BRIAN IS (IDENTITY):
${summaries.narrative || 'No self-narrative yet.'}

CURRENT COMMITMENTS:
${summaries.commitments}

CURRENT PEOPLE:
${summaries.people}

ACTIVE PROJECTS:
${summaries.projects}

TENSIONS/CONCERNS:
${summaries.tensions}

RECENT MOOD:
${summaries.mood}

VERY RECENT OBSERVATIONS (last 3 days):
${recentContext}

Based on this synthesized view, identify:

1. URGENT ITEMS
   - Overdue or approaching commitments
   - Things that need immediate attention

2. ALIGNMENT CHECK
   - Are current activities aligned with Brian's values and identity?
   - Any tension between who he is and what he's doing?

3. CONNECTIONS TO NOTICE
   - Patterns across different areas
   - Relationships between projects, people, and commitments

4. WELLBEING CHECK
   - How is Brian doing based on recent mood?
   - Any concerning patterns?

Be concise. Only surface genuinely important insights. If nothing urgent, say so.

Insights:`;

    const insights = await generate(prompt);
    console.log('=== Surfaced Insights ===\n');
    console.log(insights);
  } catch (err) {
    // Fallback to old behavior
    console.log('Living summaries not initialized. Falling back to full analysis...\n');
    await surfaceFallback();
  }
}

async function surfaceFallback(): Promise<void> {
  const all = await pool.query(
    `SELECT content, created_at FROM observations ORDER BY created_at ASC`
  );

  if (all.rows.length === 0) {
    console.log('No observations yet. Add some with: keymaker observe "your text"');
    return;
  }

  const recent = await pool.query(
    `SELECT content, created_at FROM observations
     WHERE created_at > NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC`
  );

  const allContext = all.rows
    .map(row => `[${new Date(row.created_at).toLocaleDateString()}] ${row.content}`)
    .join('\n');

  const recentContext = recent.rows.length > 0
    ? recent.rows.map(row => `[${new Date(row.created_at).toLocaleDateString()}] ${row.content}`).join('\n')
    : '(No observations in last 7 days)';

  const prompt = `You are Keymaker, Brian's personal memory assistant. Analyze these observations and surface important things Brian should be aware of.

ALL OBSERVATIONS (${all.rows.length} total):
${allContext}

RECENT (last 7 days):
${recentContext}

Identify and prioritize:

1. COMMITMENTS & DEADLINES
2. TENSIONS OR CONTRADICTIONS
3. PATTERNS WORTH NOTING
4. CONNECTIONS TO NOTICE

Only surface genuinely important items. If nothing significant, say "All clear - no urgent items detected."

Insights:`;

  const insights = await generate(prompt);
  console.log('=== Surfaced Insights ===\n');
  console.log(insights);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'observe':
        if (!args[1]) {
          console.error('Usage: keymaker observe "your observation"');
          process.exit(1);
        }
        await observe(args.slice(1).join(' '));
        break;

      case 'query':
        if (!args[1]) {
          console.error('Usage: keymaker query "your question"');
          process.exit(1);
        }
        await query(args.slice(1).join(' '));
        break;

      case 'search':
        // Temporal range search
        if (!args[1]) {
          console.error('Usage: keymaker search "query" [--from month] [--to month]');
          console.error('Examples:');
          console.error('  keymaker search "pivot" --from october --to november');
          console.error('  keymaker search "meetings" --from 2024-09');
          process.exit(1);
        }
        try {
          // Extract the query (everything before --from or --to)
          const fromIdx = args.indexOf('--from');
          const toIdx = args.indexOf('--to');
          const endIdx = Math.min(
            fromIdx !== -1 ? fromIdx : args.length,
            toIdx !== -1 ? toIdx : args.length
          );
          const searchQuery = args.slice(1, endIdx).join(' ');
          const { from, to } = parseDateRange(args);
          await searchRange(searchQuery, from, to);
        } catch (err) {
          console.error('Search failed:', err instanceof Error ? err.message : err);
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'first':
        // Find first mention of something
        if (!args[1]) {
          console.error('Usage: keymaker first "topic"');
          console.error('Find when you first mentioned something');
          console.error('Examples:');
          console.error('  keymaker first "the pivot"');
          console.error('  keymaker first "Sarah"');
          process.exit(1);
        }
        try {
          await findFirstMention(args.slice(1).join(' '));
        } catch (err) {
          console.error('Search failed:', err instanceof Error ? err.message : err);
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'list':
        await list(parseInt(args[1]) || 10);
        break;

      case 'commits':
        await commits();
        break;

      case 'stats':
        await stats();
        break;

      case 'about':
        if (!args[1]) {
          console.error('Usage: keymaker about "topic"');
          process.exit(1);
        }
        await about(args.slice(1).join(' '));
        break;

      case 'people':
        await people();
        break;

      case 'decisions':
        await decisions();
        break;

      case 'timeline':
        await timeline();
        break;

      case 'mood':
        await mood();
        break;

      case 'surface':
        await surface();
        break;

      case 'rebuild':
        // Rebuild living summaries from all observations
        const category = args[1] as DigestCategory | 'all' | undefined;
        if (category && category !== 'all' && !ALL_CATEGORIES.includes(category as DigestCategory)) {
          console.error(`Unknown category: ${category}`);
          console.error(`Valid categories: ${ALL_CATEGORIES.join(', ')}, all`);
          process.exit(1);
        }
        if (!category || category === 'all') {
          await rebuildAll(pool);
        } else {
          await rebuildCategory(pool, category as DigestCategory);
        }
        break;

      case 'projects':
        // Show current projects from living summary
        console.log('Reading projects from memory...\n');
        try {
          const projectSummary = await getLivingSummary(pool, 'projects');
          console.log('=== Active Projects ===\n');
          console.log(projectSummary.content);
          console.log(`\n(Updated: ${projectSummary.updatedAt.toLocaleString()}, from ${projectSummary.observationCount} observations)`);
        } catch (err) {
          console.log('Living summaries not initialized. Run: keymaker rebuild');
        }
        break;

      case 'tensions':
        // Show current tensions from living summary
        console.log('Reading tensions from memory...\n');
        try {
          const tensionSummary = await getLivingSummary(pool, 'tensions');
          console.log('=== Current Tensions & Concerns ===\n');
          console.log(tensionSummary.content);
          console.log(`\n(Updated: ${tensionSummary.updatedAt.toLocaleString()}, from ${tensionSummary.observationCount} observations)`);
        } catch (err) {
          console.log('Living summaries not initialized. Run: keymaker rebuild');
        }
        break;

      case 'self':
      case 'narrative':
      case 'identity':
        // Show the self-narrative - who Brian is
        console.log('Reading self-narrative from memory...\n');
        try {
          const narrativeSummary = await getLivingSummary(pool, 'narrative');
          console.log('=== Who Brian Is ===\n');
          console.log(narrativeSummary.content);
          console.log(`\n(Updated: ${narrativeSummary.updatedAt.toLocaleString()}, from ${narrativeSummary.observationCount} observations)`);
        } catch (err) {
          console.log('Living summaries not initialized. Run: keymaker rebuild');
        }
        break;

      case 'who':
        // Semantic search for people
        if (!args[1]) {
          console.error('Usage: keymaker who "person name or description"');
          process.exit(1);
        }
        console.log(`Searching for people matching: ${args.slice(1).join(' ')}\n`);
        try {
          const matchingPeople = await findSimilarPeople(pool, args.slice(1).join(' '), 5);
          if (matchingPeople.length === 0) {
            console.log('No people found yet. Add observations to populate entities.');
          } else {
            console.log('=== Matching People ===\n');
            for (const person of matchingPeople) {
              const match = (person.similarity * 100).toFixed(1);
              console.log(`${person.name} (${match}% match)`);
              if (person.relationship) console.log(`  Role: ${person.relationship}`);
              console.log('');
            }
          }
        } catch (err) {
          console.log('Entity tables not initialized. Run entity extraction first.');
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'consolidate':
      case 'sleep':
        // Run memory consolidation ("sleep" process)
        console.log('Running memory consolidation...\n');
        try {
          const stats = await runConsolidation(pool);
          console.log('=== Consolidation Complete ===\n');
          console.log(`Observations analyzed: ${stats.observationsAnalyzed}`);
          console.log(`Patterns detected: ${stats.patternsDetected}`);
          console.log(`Memories strengthened: ${stats.strengthenedItems}`);
          console.log(`Stale items faded: ${stats.staleItemsFaded}`);
          console.log('\n=== Weekly Digest ===\n');
          console.log(stats.weeklyDigest);
        } catch (err) {
          console.error('Consolidation failed:', err instanceof Error ? err.message : err);
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'digest':
        // Show the last weekly digest
        console.log('Fetching last weekly digest...\n');
        try {
          const lastDigest = await getLastDigest(pool);
          if (lastDigest) {
            console.log('=== Most Recent Weekly Digest ===\n');
            console.log(lastDigest);
          } else {
            console.log('No digests yet. Run: keymaker consolidate');
          }
        } catch (err) {
          console.log('Consolidation log not initialized. Run migration 003.');
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'history':
        // Show consolidation history
        console.log('Fetching consolidation history...\n');
        try {
          const history = await getConsolidationHistory(pool, 5);
          if (history.length === 0) {
            console.log('No consolidation history yet. Run: keymaker consolidate');
          } else {
            console.log('=== Consolidation History ===\n');
            for (const entry of history) {
              console.log(`[${entry.date.toLocaleDateString()}] ${entry.patterns} patterns detected`);
              console.log(`  ${entry.digest.slice(0, 150)}...`);
              console.log('');
            }
          }
        } catch (err) {
          console.log('Consolidation log not initialized.');
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'entities':
        // Show all extracted entities
        console.log('Loading extracted entities...\n');
        try {
          const peopleResult = await pool.query(
            `SELECT canonical_name, relationship_type, last_seen, confidence 
             FROM entities_people ORDER BY last_seen DESC LIMIT 20`
          );
          const projectResult = await pool.query(
            `SELECT name, status, updated_at 
             FROM entities_projects ORDER BY updated_at DESC LIMIT 20`
          );
          const commitResult = await pool.query(
            `SELECT description, status, due_date, committed_at 
             FROM entities_commitments WHERE status != 'completed' 
             ORDER BY due_date NULLS LAST, committed_at DESC LIMIT 20`
          );
          
          console.log('=== People ===');
          if (peopleResult.rows.length === 0) {
            console.log('  No people extracted yet. Add observations to populate.\n');
          } else {
            for (const p of peopleResult.rows) {
              console.log(`  ${p.canonical_name}${p.relationship_type ? ` (${p.relationship_type})` : ''}`);
            }
            console.log('');
          }
          
          console.log('=== Projects ===');
          if (projectResult.rows.length === 0) {
            console.log('  No projects extracted yet.\n');
          } else {
            for (const p of projectResult.rows) {
              console.log(`  ${p.name} [${p.status}]`);
            }
            console.log('');
          }
          
          console.log('=== Open Commitments ===');
          if (commitResult.rows.length === 0) {
            console.log('  No open commitments extracted yet.\n');
          } else {
            for (const c of commitResult.rows) {
              const due = c.due_date ? ` (due: ${new Date(c.due_date).toLocaleDateString()})` : '';
              console.log(`  [${c.status}] ${c.description}${due}`);
            }
          }
        } catch (err) {
          console.log('Entity tables not initialized. Schema may need to be applied.');
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'extract-all':
        // Backfill entity extraction for all observations - Instance #42
        console.log('Backfilling entity extraction for all observations...\n');
        try {
          const unprocessed = await pool.query(
            `SELECT id, content FROM observations 
             WHERE extracted_entities IS NULL OR extracted_entities = '{}'::jsonb
             ORDER BY created_at ASC`
          );
          
          if (unprocessed.rows.length === 0) {
            console.log('All observations already have extracted entities.');
            break;
          }
          
          console.log(`Found ${unprocessed.rows.length} observations to process.\n`);
          
          let processed = 0;
          let totalPeople = 0;
          let totalProjects = 0;
          let totalCommitments = 0;
          let totalBeliefs = 0;
          
          for (const obs of unprocessed.rows) {
            try {
              process.stdout.write(`Processing ${processed + 1}/${unprocessed.rows.length}...`);
              const result = await extractAndStoreEntities(pool, obs.id, obs.content);
              totalPeople += result.people.length;
              totalProjects += result.projects.length;
              totalCommitments += result.commitments.length;
              totalBeliefs += result.beliefs.length;
              processed++;
              console.log(` ✓ (${result.people.length}p, ${result.projects.length}pr, ${result.commitments.length}c, ${result.beliefs.length}b)`);
            } catch (err) {
              console.log(` ✗ ${(err as Error).message}`);
            }
          }
          
          console.log('\n=== Extraction Complete ===');
          console.log(`Observations processed: ${processed}/${unprocessed.rows.length}`);
          console.log(`People extracted: ${totalPeople}`);
          console.log(`Projects extracted: ${totalProjects}`);
          console.log(`Commitments extracted: ${totalCommitments}`);
          console.log(`Beliefs extracted: ${totalBeliefs}`);
        } catch (err) {
          console.error('Extraction failed:', err instanceof Error ? err.message : err);
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'snapshot':
        // Take a monthly snapshot
        console.log('Taking snapshot of current living summaries...\n');
        try {
          // Parse optional month argument
          let targetYear: number | undefined;
          let targetMonth: number | undefined;
          if (args[1]) {
            const parsed = parseMonthString(args[1]);
            if (parsed) {
              targetYear = parsed.year;
              targetMonth = parsed.month;
            } else {
              console.error(`Could not parse month: ${args[1]}`);
              console.error('Use format: 2024-11, november, or nov');
              process.exit(1);
            }
          }
          const result = await takeMonthlySnapshot(pool, targetYear, targetMonth);
          console.log('=== Snapshot Complete ===\n');
          console.log(`Period: ${result.period}`);
          console.log(`Observations: ${result.totalObservations}`);
          console.log(`Key observations captured: ${result.keyObservations.length}`);
          console.log(`Categories stored: ${Object.keys(result.categories).length}`);
        } catch (err) {
          console.error('Snapshot failed:', err instanceof Error ? err.message : err);
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'recall':
        // Recall a specific month's snapshot
        if (!args[1]) {
          console.error('Usage: keymaker recall <month> [category]');
          console.error('Examples: keymaker recall october, keymaker recall 2024-11 mood');
          process.exit(1);
        }
        try {
          const parsed = parseMonthString(args[1]);
          if (!parsed) {
            console.error(`Could not parse month: ${args[1]}`);
            process.exit(1);
          }
          
          const categoryArg = args[2] as DigestCategory | undefined;
          if (categoryArg && !ALL_CATEGORIES.includes(categoryArg)) {
            console.error(`Unknown category: ${categoryArg}`);
            console.error(`Valid categories: ${ALL_CATEGORIES.join(', ')}`);
            process.exit(1);
          }
          
          if (categoryArg) {
            // Single category recall
            const snap = await recallMonth(pool, categoryArg, parsed.year, parsed.month);
            if (!snap) {
              console.log(`No snapshot found for ${categoryArg} in ${parsed.year}-${parsed.month}`);
            } else {
              const periodLabel = snap.isSnapshot ? snap.period : 'current';
              console.log(`=== ${categoryArg.toUpperCase()} (${periodLabel}) ===\n`);
              console.log(snap.content);
              console.log(`\n(${snap.observationCount} observations${snap.isSnapshot ? ', snapshot' : ', live'})`);
            }
          } else {
            // Full month recall
            const snaps = await getFullMonthSnapshot(pool, parsed.year, parsed.month);
            if (!snaps) {
              console.log(`No snapshots found for ${parsed.year}-${String(parsed.month).padStart(2, '0')}`);
            } else {
              console.log(`=== Memory Snapshot: ${parsed.year}-${String(parsed.month).padStart(2, '0')} ===\n`);
              for (const cat of ALL_CATEGORIES) {
                if (snaps[cat]) {
                  console.log(`--- ${cat.toUpperCase()} ---`);
                  console.log(snaps[cat].content);
                  console.log('');
                }
              }
            }
          }
        } catch (err) {
          console.log('Snapshots table not initialized. Run migration 004.');
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'snapshots':
        // List available snapshots
        console.log('Fetching available snapshots...\n');
        try {
          const snapshotList = await listSnapshots(pool);
          if (snapshotList.length === 0) {
            console.log('No snapshots yet. Run: keymaker snapshot');
          } else {
            console.log('=== Available Memory Snapshots ===\n');
            for (const s of snapshotList) {
              console.log(`${s.period}: ${s.totalObservations} observations, ${s.categoriesStored} categories`);
            }
          }
        } catch (err) {
          console.log('Snapshots table not initialized. Run migration 004.');
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'compare':
        // Compare two time periods
        if (!args[1] || !args[2]) {
          console.error('Usage: keymaker compare <month1> <month2> [category]');
          console.error('Example: keymaker compare october november mood');
          process.exit(1);
        }
        try {
          const p1 = parseMonthString(args[1]);
          const p2 = parseMonthString(args[2]);
          if (!p1 || !p2) {
            console.error('Could not parse month arguments');
            process.exit(1);
          }
          const cat = (args[3] as DigestCategory) || 'narrative';
          if (!ALL_CATEGORIES.includes(cat)) {
            console.error(`Unknown category: ${cat}`);
            process.exit(1);
          }
          console.log(`Comparing ${cat}: ${args[1]} vs ${args[2]}...\n`);
          const comparison = await compareSnapshots(pool, cat, p1, p2);
          console.log(`=== ${cat.toUpperCase()}: ${args[1]} vs ${args[2]} ===\n`);
          console.log(comparison);
        } catch (err) {
          console.error('Compare failed:', err instanceof Error ? err.message : err);
          if (process.env.DEBUG) console.error(err);
        }
        break;

      case 'reflect':
      case 'evolution':
        // Generate temporal reflection
        console.log('Generating temporal reflection...\n');
        try {
          const monthsBack = parseInt(args[1]) || 3;
          const reflection = await generateTemporalReflection(pool, monthsBack);
          console.log(`=== How Brian Has Evolved (Last ${monthsBack} Months) ===\n`);
          console.log(reflection);
        } catch (err) {
          console.error('Reflection failed:', err instanceof Error ? err.message : err);
          if (process.env.DEBUG) console.error(err);
        }
        break;

      default:
        console.log(`Keymaker - Personal Memory System (with Living Summaries + Entity Extraction)

Core Commands:
  observe "text"   Store an observation (auto-digests into memory)
  query "question" Find relevant observations and synthesize answer
  list [n]         List recent observations (default: 10)
  stats            Show memory statistics

Temporal Search (search within time periods):
  search "query" [--from month] [--to month]  Search observations in a date range
  first "topic"    Find when you first mentioned something

Living Summaries (instant reads from pre-digested memory):
  commits          Your current commitments and promises
  people           People you know and recent interactions
  projects         Active projects and their status
  tensions         Open loops, concerns, and conflicts
  mood             Recent emotional patterns
  self             Who you are - identity, values, growth (aliases: narrative, identity)
  surface          Synthesize insights from all summaries

Entity Commands (structured data - extracted automatically with Groq):
  entities         List all extracted people, projects, and commitments
  who "name"       Semantic search for people by name or description
  extract-all      Backfill entity extraction for all observations

Deep Analysis (slower, uses LLM):
  about "topic"    Comprehensive summary about any topic
  decisions        Extract all decisions from observations
  timeline         Build chronological narrative

Memory Management:
  rebuild [cat]    Rebuild living summaries (all or specific: commits, people, projects, tensions, mood, narrative)
  consolidate      Run memory "sleep" - strengthen, fade, and generate weekly digest (alias: sleep)
  digest           Show the most recent weekly digest
  history          Show consolidation history

Temporal Memory (snapshots of the past):
  snapshot [month] Take a snapshot of current state (default: previous month)
  recall <month>   Recall what life was like in a specific month
  recall <month> <category>  Recall a specific category from a month
  snapshots        List all available memory snapshots
  compare <m1> <m2> [cat]   Compare two time periods
  reflect [months] Show how Brian has evolved over time (default: 3 months)

Examples:
  keymaker observe "Had coffee with Sarah, discussed the pivot"
  keymaker observe "I realized I work best with a clear mission, not just tasks"
  keymaker observe "Meeting with John about Q4 goals - promised deliverable by Friday"
  keymaker query "Who is Sarah?"
  keymaker search "pivot" --from oct --to nov   # Search October-November for "pivot"
  keymaker first "the pivot"                     # When did I first mention the pivot?
  keymaker who "John"
  keymaker entities
  keymaker self
  keymaker surface
  keymaker rebuild all
  keymaker recall october mood    # How was I feeling in October?
  keymaker compare oct nov narrative  # How has my identity shifted?
  keymaker reflect 6              # Show 6 months of evolution
`);
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Only run main when executed directly, not when imported
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
