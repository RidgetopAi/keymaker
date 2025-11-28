// Keymaker API Server - Version: 2024-11-26
// Last deployment test: Instance #39 - Fixed git deployment workflow
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, config, ENV, embed, generate } from '../cli.js';
import { 
  digestObservation, 
  getLivingSummary, 
  getAllSummaries, 
  rebuildCategory, 
  rebuildAll,
  DigestCategory,
  ALL_CATEGORIES 
} from '../services/digest.js';
import {
  listSnapshots,
  getFullMonthSnapshot,
  compareSnapshots,
  parseMonthString,
  generateTemporalReflection
} from '../services/snapshots.js';
import { getLastDigest, getConsolidationHistory } from '../services/consolidation.js';
import {
  extractAndStoreEntities,
  findSimilarPeople,
  findSimilarProjects
} from '../services/extraction/index.js';
import { transcribeAudio } from '../services/extraction/groq-client.js';
import {
  getOrCreateSession,
  processMessage,
  pruneOldSessions
} from '../services/chat/index.js';
import {
  getCalendarStatus,
  syncCommitmentToCalendar,
  unsyncCommitmentFromCalendar
} from '../services/calendar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

// Simple auth token (set via environment)
const AUTH_TOKEN = process.env.KEYMAKER_TOKEN;

app.use(cors());
app.use(express.json());
// Raw body parser for audio uploads (speech-to-text)
app.use('/api/transcribe', express.raw({
  type: ['audio/*', 'application/octet-stream'],
  limit: '25mb' // Groq's max file size
}));
app.use(express.static(path.join(__dirname, '../../public')));

// Optional authentication
if (AUTH_TOKEN) {
  app.use('/api', (req, res, next) => {
    const token = req.headers['x-keymaker-token'];
    if (token !== AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: ENV,
    database: config.database
  });
});

// Store observation - OPTIMIZED for VPS performance
// Architecture: Fast response, async digestion
app.post('/api/observe', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Content required' });
    }

    // Normalize content for deduplication (trim whitespace)
    const normalizedContent = content.trim();
    
    // DEDUPLICATION: Check for identical content in last 5 minutes
    const recentDupe = await pool.query(
      `SELECT id, created_at FROM observations 
       WHERE content = $1 
         AND created_at > NOW() - INTERVAL '5 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [normalizedContent]
    );
    
    if (recentDupe.rows.length > 0) {
      // Return success but indicate it was deduplicated
      return res.json({
        success: true,
        id: recentDupe.rows[0].id,
        created_at: recentDupe.rows[0].created_at,
        deduplicated: true,
        message: 'Observation already saved recently'
      });
    }

    // Generate embedding (fast: ~0.5s)
    const embedding = await embed(content);
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await pool.query(
      `INSERT INTO observations (content, embedding)
       VALUES ($1, $2::vector)
       RETURNING id, created_at`,
      [normalizedContent, embeddingStr]
    );

    const id = result.rows[0].id;
    const createdAt = new Date(result.rows[0].created_at);

    // RESPOND IMMEDIATELY - don't wait for digestion
    res.json({
      success: true,
      id,
      created_at: createdAt,
      digesting: true,
      message: 'Saved! Digesting in background...'
    });

    // ASYNC DIGESTION: Process after response sent
    // This runs in the background, user doesn't wait
    setImmediate(async () => {
      try {
        const categories = await digestObservation(pool, id, normalizedContent, createdAt);
        console.log(`Background digest complete for ${id}: ${categories.join(', ') || 'none'}`);
      } catch (digestErr) {
        console.error(`Background digest failed for ${id}:`, digestErr);
      }
    });

  } catch (err) {
    console.error('Observe error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to store observation' });
  }
});

// Query observations
app.post('/api/query', async (req, res) => {
  try {
    const { question, limit = 5 } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'Question required' });
    }

    const embedding = await embed(question);
    const embeddingStr = `[${embedding.join(',')}]`;

    // Extract keywords for hybrid search
    const keywords = question.toLowerCase()
      .split(/\W+/)
      .filter((w: string) => w.length >= 3 && !['the', 'and', 'how', 'what', 'who', 'when', 'where', 'why', 'was', 'has', 'are', 'for', 'with'].includes(w));

    // Detect temporal queries
    const temporalPatterns = ['this week', 'today', 'tomorrow', 'yesterday', 'recently', 'lately', 'now', 'current', 'upcoming'];
    const isTemporalQuery = temporalPatterns.some(p => question.toLowerCase().includes(p));

    // Hybrid search: semantic + keyword + temporal
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
          ? keywords.map((_: string, i: number) => `LOWER(content) LIKE '%' || $${i + 2} || '%'`).join(' OR ')
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

    // Sort by combined score and apply limit
    const sorted = result.rows
      .sort((a: any, b: any) => b.similarity - a.similarity)
      .slice(0, limit)
      .filter((r: any) => r.similarity > 0.20);

    if (sorted.length === 0) {
      return res.json({
        answer: 'No observations found. Add some first!',
        observations: []
      });
    }

    const llmContext = sorted
      .map((row: any, i: number) => `${i + 1}. ${row.content}`)
      .join('\n');

    const prompt = `You are helping Brian recall information from his personal observations. Answer the question based only on these observations.

Observations:
${llmContext}

Question: ${question}

Answer concisely based only on what's in the observations. If they don't contain enough information, say so.

Answer:`;

    const answer = await generate(prompt);

    res.json({
      answer,
      observations: sorted.map((row: any) => ({
        content: row.content,
        similarity: row.similarity,
        created_at: row.created_at
      }))
    });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Query failed' });
  }
});

// List observations
app.get('/api/list', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;

    const result = await pool.query(
      `SELECT id, content, created_at
       FROM observations
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json({ observations: result.rows });
  } catch (err) {
    console.error('List error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list observations' });
  }
});

// Cache for surface insights (TTL-based to avoid 90s LLM calls)
interface SurfaceCache {
  insights: string;
  total: number;
  generatedAt: Date;
}
let surfaceCache: SurfaceCache | null = null;
const SURFACE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Surface insights (using living summaries - much faster!)
app.get('/api/surface', async (req, res) => {
  try {
    // Check cache first (skip with ?fresh=true)
    const forceRefresh = req.query.fresh === 'true';
    if (!forceRefresh && surfaceCache && 
        (Date.now() - surfaceCache.generatedAt.getTime()) < SURFACE_CACHE_TTL_MS) {
      return res.json({ 
        insights: surfaceCache.insights, 
        total: surfaceCache.total,
        usedLivingSummaries: true,
        cached: true,
        cachedAt: surfaceCache.generatedAt.toISOString()
      });
    }

    // Try living summaries first (Instance #26's breakthrough)
    let summaries: Record<DigestCategory, string>;
    try {
      summaries = await getAllSummaries(pool);
    } catch {
      // Fall back to old behavior if distilled_state doesn't exist
      return await surfaceFallback(req, res);
    }

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

    const prompt = `You are Keymaker, Brian's personal memory assistant. Based on this current understanding of Brian's life, surface what's important right now.

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

2. CONNECTIONS TO NOTICE
   - Patterns across different areas
   - Relationships between projects, people, and commitments

3. WELLBEING CHECK
   - How is Brian doing based on recent mood?
   - Any concerning patterns?

Be concise. Only surface genuinely important insights. If nothing urgent, say so.

Insights:`;

    const insights = await generate(prompt);
    
    // Get total observation count
    const stats = await pool.query('SELECT COUNT(*) as total FROM observations');
    const total = parseInt(stats.rows[0].total);
    
    // Cache the result
    surfaceCache = {
      insights,
      total,
      generatedAt: new Date()
    };
    
    res.json({ 
      insights, 
      total,
      usedLivingSummaries: true 
    });
  } catch (err) {
    console.error('Surface error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Surface failed' });
  }
});

// Fallback for when living summaries aren't available
async function surfaceFallback(req: express.Request, res: express.Response) {
  const all = await pool.query(
    `SELECT content, created_at FROM observations ORDER BY created_at ASC`
  );

  if (all.rows.length === 0) {
    return res.json({ insights: 'No observations yet.', usedLivingSummaries: false });
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

Only surface genuinely important items. For each finding provide what it is, why it matters, and action if any.

If nothing significant, say "All clear - no urgent items detected."

Insights:`;

  const insights = await generate(prompt);
  res.json({ insights, total: all.rows.length, usedLivingSummaries: false });
}

// Get all living summaries
app.get('/api/summaries', async (req, res) => {
  try {
    const summaries = await getAllSummaries(pool);
    
    // Get metadata for each category
    const metadata: Record<string, { updatedAt: Date; observationCount: number }> = {};
    for (const category of ALL_CATEGORIES) {
      const summary = await getLivingSummary(pool, category);
      metadata[category] = {
        updatedAt: summary.updatedAt,
        observationCount: summary.observationCount
      };
    }
    
    res.json({ summaries, metadata });
  } catch (err) {
    console.error('Summaries error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get summaries' });
  }
});

// Get a specific living summary
app.get('/api/summaries/:category', async (req, res) => {
  try {
    const category = req.params.category as DigestCategory;
    
    if (!ALL_CATEGORIES.includes(category)) {
      return res.status(400).json({ 
        error: `Invalid category. Valid: ${ALL_CATEGORIES.join(', ')}` 
      });
    }
    
    const summary = await getLivingSummary(pool, category);
    res.json(summary);
  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get summary' });
  }
});

// Rebuild living summaries
app.post('/api/rebuild', async (req, res) => {
  try {
    const { category } = req.body;
    
    if (category && category !== 'all') {
      if (!ALL_CATEGORIES.includes(category)) {
        return res.status(400).json({ 
          error: `Invalid category. Valid: ${ALL_CATEGORIES.join(', ')}, all` 
        });
      }
      const count = await rebuildCategory(pool, category);
      res.json({ success: true, category, observationsProcessed: count });
    } else {
      await rebuildAll(pool);
      res.json({ success: true, category: 'all' });
    }
  } catch (err) {
    console.error('Rebuild error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Rebuild failed' });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as total,
              MIN(created_at) as earliest,
              MAX(created_at) as latest
       FROM observations`
    );

    const row = result.rows[0];
    res.json({
      total: parseInt(row.total),
      earliest: row.earliest,
      latest: row.latest
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Stats failed' });
  }
});

// =============================================================================
// TIMELINE / SNAPSHOT API (Instance #34)
// =============================================================================

// List available snapshots
app.get('/api/timeline/snapshots', async (req, res) => {
  try {
    const snapshots = await listSnapshots(pool);
    res.json({ snapshots });
  } catch (err) {
    console.error('Snapshots list error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list snapshots' });
  }
});

// Get a specific month's snapshot
app.get('/api/timeline/:period', async (req, res) => {
  try {
    const parsed = parseMonthString(req.params.period);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid period format. Use YYYY-MM or month name.' });
    }
    
    const snapshot = await getFullMonthSnapshot(pool, parsed.year, parsed.month);
    if (!snapshot) {
      return res.status(404).json({ error: 'No snapshot found for this period.' });
    }
    
    res.json({ 
      period: `${parsed.year}-${String(parsed.month).padStart(2, '0')}`,
      year: parsed.year,
      month: parsed.month,
      snapshot 
    });
  } catch (err) {
    console.error('Snapshot fetch error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get snapshot' });
  }
});

// Compare two months
app.get('/api/timeline/compare/:period1/:period2', async (req, res) => {
  try {
    const p1 = parseMonthString(req.params.period1);
    const p2 = parseMonthString(req.params.period2);
    const category = (req.query.category as DigestCategory) || 'narrative';
    
    if (!p1 || !p2) {
      return res.status(400).json({ error: 'Invalid period format.' });
    }
    
    if (!ALL_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Invalid category. Valid: ${ALL_CATEGORIES.join(', ')}` });
    }
    
    const comparison = await compareSnapshots(pool, category, p1, p2);
    res.json({ 
      period1: `${p1.year}-${String(p1.month).padStart(2, '0')}`,
      period2: `${p2.year}-${String(p2.month).padStart(2, '0')}`,
      category,
      comparison 
    });
  } catch (err) {
    console.error('Compare error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to compare snapshots' });
  }
});

// Get temporal reflection (evolution over time)
app.get('/api/timeline/reflect', async (req, res) => {
  try {
    const months = parseInt(req.query.months as string) || 3;
    const reflection = await generateTemporalReflection(pool, months);
    res.json({ reflection, monthsAnalyzed: months });
  } catch (err) {
    console.error('Reflect error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to generate reflection' });
  }
});

// =============================================================================
// CONSOLIDATION / DIGEST API (Instance #34)
// =============================================================================

// Get the latest weekly digest
app.get('/api/digest', async (req, res) => {
  try {
    const digest = await getLastDigest(pool);
    res.json({ digest: digest || 'No weekly digest yet. Run consolidation first.' });
  } catch (err) {
    console.error('Digest error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get digest' });
  }
});

// Get consolidation history
app.get('/api/digest/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 5;
    const history = await getConsolidationHistory(pool, limit);
    res.json({ history });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get history' });
  }
});

// =============================================================================
// IDENTITY SYNTHESIS API (Instance #34)
// =============================================================================

// Cache for identity (same TTL as surface)
interface IdentityCache {
  identity: string;
  summaries: Record<DigestCategory, string>;
  generatedAt: Date;
}
let identityCache: IdentityCache | null = null;
const IDENTITY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Get a synthesized identity statement from all summaries
app.get('/api/identity', async (req, res) => {
  try {
    // Check cache first (skip with ?fresh=true)
    const forceRefresh = req.query.fresh === 'true';
    if (!forceRefresh && identityCache && 
        (Date.now() - identityCache.generatedAt.getTime()) < IDENTITY_CACHE_TTL_MS) {
      return res.json({ 
        identity: identityCache.identity,
        summaries: identityCache.summaries,
        generatedAt: identityCache.generatedAt.toISOString(),
        cached: true
      });
    }

    const summaries = await getAllSummaries(pool);
    
    // Build a quick identity synthesis
    const prompt = `Based on these living summaries about Brian, write a single paragraph (2-3 sentences) describing who he is right now. Be warm but concise.

CURRENT COMMITMENTS:
${summaries.commitments}

KEY PEOPLE:
${summaries.people}

ACTIVE PROJECTS:
${summaries.projects}

RECENT MOOD:
${summaries.mood}

SELF-NARRATIVE:
${summaries.narrative}

Write a warm, present-tense paragraph about who Brian is right now:`;

    const identity = await generate(prompt);
    
    // Cache the result
    identityCache = {
      identity,
      summaries,
      generatedAt: new Date()
    };
    
    res.json({ 
      identity,
      summaries,
      generatedAt: identityCache.generatedAt.toISOString()
    });
  } catch (err) {
    console.error('Identity error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to generate identity' });
  }
});

// =============================================================================
// SEARCH API (Instance #34) - Temporal & Entity-aware
// =============================================================================

// Search within date range
app.post('/api/search', async (req, res) => {
  try {
    const { query, from, to, firstMentionOnly, limit = 10 } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query required' });
    }
    
    const embedding = await embed(query);
    const embeddingStr = `[${embedding.join(',')}]`;
    
    // Build date filter
    let dateFilter = '';
    const params: (string | number)[] = [embeddingStr];
    let paramIndex = 2;
    
    if (from) {
      const fromParsed = parseMonthString(from);
      if (fromParsed) {
        dateFilter += ` AND created_at >= $${paramIndex}`;
        params.push(`${fromParsed.year}-${String(fromParsed.month).padStart(2, '0')}-01`);
        paramIndex++;
      }
    }
    
    if (to) {
      const toParsed = parseMonthString(to);
      if (toParsed) {
        // End of month
        const endDate = new Date(toParsed.year, toParsed.month, 0);
        dateFilter += ` AND created_at <= $${paramIndex}`;
        params.push(endDate.toISOString().split('T')[0]);
        paramIndex++;
      }
    }
    
    // Search query
    const orderBy = firstMentionOnly ? 'ORDER BY created_at ASC' : 'ORDER BY similarity DESC';
    const queryLimit = firstMentionOnly ? 1 : limit;
    
    params.push(queryLimit);
    
    const result = await pool.query(
      `SELECT id, content, created_at,
              1 - (embedding <=> $1::vector) as similarity
       FROM observations
       WHERE 1 - (embedding <=> $1::vector) > 0.10
       ${dateFilter}
       ${orderBy}
       LIMIT $${paramIndex}`,
      params
    );
    
    res.json({
      query,
      from,
      to,
      firstMentionOnly: !!firstMentionOnly,
      results: result.rows.map(r => ({
        id: r.id,
        content: r.content,
        date: r.created_at,
        similarity: r.similarity
      }))
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Search failed' });
  }
});

// =============================================================================
// ENTITY API (Instance #42)
// =============================================================================

// List all entities
app.get('/api/entities', async (req, res) => {
  try {
    const [people, projects, commitments, beliefs] = await Promise.all([
      pool.query(
        `SELECT id, canonical_name, relationship_type, last_seen, confidence 
         FROM entities_people ORDER BY last_seen DESC NULLS LAST LIMIT 50`
      ),
      pool.query(
        `SELECT id, name, status, description, updated_at 
         FROM entities_projects ORDER BY updated_at DESC LIMIT 50`
      ),
      pool.query(
        `SELECT id, description, status, due_date, committed_at, committed_to
         FROM entities_commitments 
         ORDER BY due_date NULLS LAST, committed_at DESC LIMIT 50`
      ),
      pool.query(
        `SELECT id, statement, belief_type, confidence, is_active, created_at
         FROM beliefs WHERE is_active = TRUE
         ORDER BY confidence DESC, created_at DESC LIMIT 50`
      )
    ]);
    
    res.json({
      people: people.rows,
      projects: projects.rows,
      commitments: commitments.rows,
      beliefs: beliefs.rows
    });
  } catch (err) {
    console.error('Entities error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get entities' });
  }
});

// Individual entity type endpoints for frontend
app.get('/api/entities/people', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, canonical_name, relationship_type, last_seen, confidence 
       FROM entities_people ORDER BY last_seen DESC NULLS LAST LIMIT 50`
    );
    res.json({ people: result.rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get people' });
  }
});

app.get('/api/entities/projects', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, status, description, updated_at 
       FROM entities_projects ORDER BY updated_at DESC LIMIT 50`
    );
    res.json({ projects: result.rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get projects' });
  }
});

app.get('/api/entities/commitments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, description, status, due_date, committed_at, event_time, duration_minutes, location, synced_to_calendar
       FROM entities_commitments
       ORDER BY due_date NULLS LAST, committed_at DESC LIMIT 50`
    );
    res.json({ commitments: result.rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get commitments' });
  }
});

// =============================================================================
// SCHEDULE API (Instance #51) - Calendar-aware commitment display
// =============================================================================

// Get formatted schedule grouped by time periods
app.get('/api/schedule', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const includeUndated = req.query.include_undated !== 'false';

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const weekEnd = new Date(todayStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(todayStart.getTime() + days * 24 * 60 * 60 * 1000);

    // Get all active commitments with event_time or due_date
    const datedResult = await pool.query(
      `SELECT c.id, c.description, c.status, c.due_date, c.event_time,
              c.duration_minutes, c.location, c.synced_to_calendar,
              c.committed_to, p.canonical_name as committed_to_name
       FROM entities_commitments c
       LEFT JOIN entities_people p ON c.committed_to = p.id
       WHERE c.status NOT IN ('completed', 'cancelled')
         AND (c.event_time IS NOT NULL OR c.due_date IS NOT NULL)
         AND COALESCE(c.event_time, c.due_date) <= $1
       ORDER BY COALESCE(c.event_time, c.due_date) ASC`,
      [rangeEnd]
    );

    // Get undated commitments if requested
    let undatedResult = { rows: [] as any[] };
    if (includeUndated) {
      undatedResult = await pool.query(
        `SELECT c.id, c.description, c.status, c.committed_to,
                p.canonical_name as committed_to_name
         FROM entities_commitments c
         LEFT JOIN entities_people p ON c.committed_to = p.id
         WHERE c.status NOT IN ('completed', 'cancelled')
           AND c.event_time IS NULL
           AND c.due_date IS NULL
         ORDER BY c.committed_at DESC
         LIMIT 20`
      );
    }

    // Helper to format time
    const formatTime = (date: Date): string => {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    };

    const formatDate = (date: Date): string => {
      return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    };

    // Categorize events
    const today: any[] = [];
    const tomorrow: any[] = [];
    const thisWeek: any[] = [];
    const later: any[] = [];

    for (const row of datedResult.rows) {
      const eventDate = new Date(row.event_time || row.due_date);
      const item = {
        id: row.id,
        description: row.description,
        time: row.event_time ? formatTime(eventDate) : null,
        date: formatDate(eventDate),
        event_time: row.event_time,
        due_date: row.due_date,
        duration_minutes: row.duration_minutes,
        location: row.location,
        synced: row.synced_to_calendar,
        committed_to: row.committed_to_name,
        status: row.status
      };

      if (eventDate < tomorrowStart) {
        today.push(item);
      } else if (eventDate < new Date(tomorrowStart.getTime() + 24 * 60 * 60 * 1000)) {
        tomorrow.push(item);
      } else if (eventDate < weekEnd) {
        thisWeek.push(item);
      } else {
        later.push(item);
      }
    }

    // Format undated
    const undated = undatedResult.rows.map(row => ({
      id: row.id,
      description: row.description,
      committed_to: row.committed_to_name,
      status: row.status
    }));

    res.json({
      generated_at: now.toISOString(),
      days_ahead: days,
      today,
      tomorrow,
      this_week: thisWeek,
      later,
      undated: includeUndated ? undated : undefined
    });
  } catch (err) {
    console.error('Schedule error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get schedule' });
  }
});

app.get('/api/entities/beliefs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, statement, belief_type, confidence, created_at
       FROM beliefs WHERE is_active = TRUE
       ORDER BY confidence DESC, created_at DESC LIMIT 50`
    );
    res.json({ beliefs: result.rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get beliefs' });
  }
});

app.get('/api/entities/contradictions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.contradiction_type, c.severity, c.explanation,
              ba.statement as belief_a, bb.statement as belief_b,
              c.resolution_status, c.detected_at
       FROM contradictions c
       JOIN beliefs ba ON c.belief_a_id = ba.id
       JOIN beliefs bb ON c.belief_b_id = bb.id
       WHERE c.resolution_status = 'unresolved'
       ORDER BY 
         CASE c.severity 
           WHEN 'critical' THEN 1 
           WHEN 'major' THEN 2 
           WHEN 'moderate' THEN 3 
           WHEN 'minor' THEN 4 
         END,
         c.detected_at DESC
       LIMIT 20`
    );
    res.json({ contradictions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get contradictions' });
  }
});

// Search for people by semantic similarity
app.get('/api/entities/people/search', async (req, res) => {
  try {
    const query = req.query.q as string;
    const limit = parseInt(req.query.limit as string) || 5;
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter q required' });
    }
    
    const results = await findSimilarPeople(pool, query, limit);
    res.json({ query, results });
  } catch (err) {
    console.error('People search error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to search people' });
  }
});

// Search for projects by semantic similarity
app.get('/api/entities/projects/search', async (req, res) => {
  try {
    const query = req.query.q as string;
    const limit = parseInt(req.query.limit as string) || 5;
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter q required' });
    }
    
    const results = await findSimilarProjects(pool, query, limit);
    res.json({ query, results });
  } catch (err) {
    console.error('Projects search error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to search projects' });
  }
});

// Extract entities from a specific observation
app.post('/api/entities/extract/:observationId', async (req, res) => {
  try {
    const { observationId } = req.params;
    
    // Get the observation content
    const obs = await pool.query(
      `SELECT id, content FROM observations WHERE id = $1`,
      [observationId]
    );
    
    if (obs.rows.length === 0) {
      return res.status(404).json({ error: 'Observation not found' });
    }
    
    const result = await extractAndStoreEntities(pool, observationId, obs.rows[0].content);
    res.json({
      success: true,
      observationId,
      ...result
    });
  } catch (err) {
    console.error('Extract error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Extraction failed' });
  }
});

// Backfill extraction for all observations
app.post('/api/entities/extract-all', async (req, res) => {
  try {
    const unprocessed = await pool.query(
      `SELECT id, content FROM observations 
       WHERE extracted_entities IS NULL OR extracted_entities = '{}'::jsonb
       ORDER BY created_at ASC`
    );
    
    if (unprocessed.rows.length === 0) {
      return res.json({ 
        success: true, 
        message: 'All observations already processed',
        processed: 0 
      });
    }
    
    // Process in background, return immediately
    res.json({
      success: true,
      message: `Started backfill for ${unprocessed.rows.length} observations`,
      pending: unprocessed.rows.length
    });
    
    // Background processing
    setImmediate(async () => {
      let processed = 0;
      for (const obs of unprocessed.rows) {
        try {
          await extractAndStoreEntities(pool, obs.id, obs.content);
          processed++;
          console.log(`Extracted ${processed}/${unprocessed.rows.length}: ${obs.id}`);
        } catch (err) {
          console.error(`Extraction failed for ${obs.id}:`, err);
        }
      }
      console.log(`Backfill complete: ${processed}/${unprocessed.rows.length}`);
    });
  } catch (err) {
    console.error('Extract-all error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backfill failed' });
  }
});

// =============================================================================
// CHAT API (Instance #49) - Conversational Interface
// =============================================================================

// Start or resume a chat session
app.post('/api/chat/session', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await getOrCreateSession(pool, sessionId);
    res.json({
      sessionId: session.id,
      messages: session.messages,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity
    });
  } catch (err) {
    console.error('Chat session error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Session failed' });
  }
});

// Send a message in a chat session
app.post('/api/chat/message', async (req, res) => {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message required' });
    }

    const result = await processMessage(pool, sessionId, message);

    res.json({
      response: result.response,
      intent: result.intent.intent,
      confidence: result.intent.confidence,
      actionTaken: result.actionTaken
    });
  } catch (err) {
    console.error('Chat message error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Message failed' });
  }
});

// Get chat history for a session
app.get('/api/chat/session/:sessionId', async (req, res) => {
  try {
    const session = await getOrCreateSession(pool, req.params.sessionId);
    res.json({
      sessionId: session.id,
      messages: session.messages,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity
    });
  } catch (err) {
    console.error('Chat history error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'History failed' });
  }
});

// Manually prune old sessions (also runs via cron)
app.post('/api/chat/prune', async (req, res) => {
  try {
    const deleted = await pruneOldSessions(pool);
    res.json({ success: true, deletedSessions: deleted });
  } catch (err) {
    console.error('Chat prune error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Prune failed' });
  }
});

// =============================================================================
// SPEECH-TO-TEXT API (Instance #50) - Groq Whisper
// =============================================================================

// Transcribe audio to text using Groq Whisper
app.post('/api/transcribe', async (req, res) => {
  try {
    // Get Groq API key from environment
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
    }

    // Check if we have audio data
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }

    const audioBuffer = req.body;

    // Determine format from content-type header
    const contentType = req.headers['content-type'] || 'audio/webm';
    const formatMap: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/mp4': 'm4a',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/flac': 'flac',
      'application/octet-stream': 'webm', // default for unknown
    };
    const ext = formatMap[contentType] || 'webm';
    const filename = `recording.${ext}`;

    console.log(`Transcribing ${audioBuffer.length} bytes of ${contentType} audio...`);

    const text = await transcribeAudio(audioBuffer, filename, groqApiKey);

    console.log(`Transcription complete: "${text.substring(0, 50)}..."`);

    res.json({
      text,
      audioSize: audioBuffer.length,
      format: ext
    });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Transcription failed' });
  }
});

// ===================
// Calendar Endpoints (Phase 3)
// ===================

/**
 * GET /api/calendar/status
 * Check CalDAV connection status
 */
app.get('/api/calendar/status', async (req, res) => {
  try {
    const status = await getCalendarStatus();
    res.json(status);
  } catch (err) {
    console.error('Calendar status error:', err);
    res.status(500).json({ error: 'Failed to get calendar status' });
  }
});

/**
 * POST /api/calendar/sync/:commitmentId
 * Manually trigger CalDAV sync for a commitment
 */
app.post('/api/calendar/sync/:commitmentId', async (req, res) => {
  try {
    const { commitmentId } = req.params;

    // Get commitment from database
    const result = await pool.query(
      `SELECT id, description, event_time, duration_minutes, location, committed_to, synced_to_calendar, caldav_uid
       FROM entities_commitments WHERE id = $1`,
      [commitmentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Commitment not found' });
    }

    const commitment = result.rows[0];

    if (!commitment.event_time) {
      return res.status(400).json({ error: 'Commitment has no event_time - cannot sync to calendar' });
    }

    // Sync to CalDAV
    const uid = await syncCommitmentToCalendar({
      id: commitment.id,
      description: commitment.description,
      event_time: commitment.event_time,
      duration_minutes: commitment.duration_minutes,
      location: commitment.location,
      committed_to: commitment.committed_to
    });

    // Update database
    await pool.query(
      `UPDATE entities_commitments SET synced_to_calendar = TRUE, caldav_uid = $1 WHERE id = $2`,
      [uid, commitmentId]
    );

    res.json({
      success: true,
      message: 'Commitment synced to calendar',
      caldav_uid: uid
    });
  } catch (err) {
    console.error('Calendar sync error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Sync failed' });
  }
});

/**
 * DELETE /api/calendar/unsync/:commitmentId
 * Remove a commitment from CalDAV (keeps in keymaker)
 */
app.delete('/api/calendar/unsync/:commitmentId', async (req, res) => {
  try {
    const { commitmentId } = req.params;

    // Get commitment from database
    const result = await pool.query(
      `SELECT id, caldav_uid FROM entities_commitments WHERE id = $1`,
      [commitmentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Commitment not found' });
    }

    const commitment = result.rows[0];

    // Remove from CalDAV
    await unsyncCommitmentFromCalendar(commitmentId);

    // Update database
    await pool.query(
      `UPDATE entities_commitments SET synced_to_calendar = FALSE, caldav_uid = NULL WHERE id = $1`,
      [commitmentId]
    );

    res.json({
      success: true,
      message: 'Commitment removed from calendar'
    });
  } catch (err) {
    console.error('Calendar unsync error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unsync failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Keymaker API running on port ${PORT}`);
  console.log(`Environment: ${ENV} (${config.database})`);
  console.log(`UI available at http://localhost:${PORT}`);
});
