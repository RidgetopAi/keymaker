/**
 * Digest Service: The Heart of Keymaker's Memory
 * 
 * This is THE architectural shift that makes Keymaker feel like a friend.
 * 
 * Instead of: observe → store → (later) re-analyze ALL observations for every query
 * Now:        observe → store → DIGEST into living summaries → queries read summaries
 * 
 * The digestion happens at write-time, incrementally updating small "living documents"
 * that represent Keymaker's understanding of Brian's commitments, relationships,
 * projects, tensions, and emotional state.
 */

import { Pool } from 'pg';
import { generate } from './extraction/provider-factory.js';

// Valid categories for living summaries
// Note: 'narrative' is the identity layer - who Brian is, his values, and how he's growing
export type DigestCategory = 'commitments' | 'people' | 'projects' | 'tensions' | 'mood' | 'narrative';
export const ALL_CATEGORIES: DigestCategory[] = ['commitments', 'people', 'projects', 'tensions', 'mood', 'narrative'];

/**
 * Classify which categories an observation touches.
 * This is a cheap, fast LLM call that determines what needs updating.
 */
async function classifyObservation(content: string): Promise<DigestCategory[]> {
  const prompt = `Analyze this personal observation and determine which categories it relates to.

Observation: "${content}"

Categories:
- commitments: promises, tasks, things to do, deadlines, obligations, ALSO anything marked as done/paid/completed/finished, task status updates
- people: mentions of specific people, relationships, interactions
- projects: ongoing work, goals, initiatives, creative endeavors
- tensions: concerns, conflicts, contradictions, unresolved issues, worries
- mood: emotional states, energy levels, feelings, stress, happiness
- narrative: self-reflection, identity statements, values expressed, personal growth, beliefs about self, life philosophy, "I am..." or "I believe..." statements, realizations about who one is becoming

Return ONLY a comma-separated list of relevant categories (e.g., "commitments,people" or "mood,narrative" or "none").
If none apply, return "none".

Categories:`;

  const response = await generate(prompt);
  const normalized = response.toLowerCase().trim();
  
  if (normalized === 'none' || normalized === '') {
    return [];
  }
  
  const mentioned = normalized.split(/[,\s]+/).map(s => s.trim());
  return ALL_CATEGORIES.filter(cat => mentioned.includes(cat));
}

/**
 * Update a single living summary with a new observation.
 * This is the core "memory update" operation.
 */
async function updateLivingSummary(
  pool: Pool,
  category: DigestCategory,
  newObservation: string,
  observationDate: Date
): Promise<void> {
  // Get current state
  const current = await pool.query(
    'SELECT content FROM distilled_state WHERE key = $1',
    [category]
  );
  
  const currentContent = current.rows[0]?.content || `No ${category} tracked yet.`;
  const dateStr = observationDate.toLocaleDateString();
  
  // Category-specific prompts for incremental updates
  const prompts: Record<DigestCategory, string> = {
    commitments: `You maintain Brian's commitment tracker. Here's the current state and a new observation.

CURRENT COMMITMENTS:
${currentContent}

NEW OBSERVATION (${dateStr}):
${newObservation}

Update the commitments summary to incorporate any new, changed, or completed items.
Format: List each commitment with status (pending/completed/overdue if date passed), who it's to (if known), and when.
Keep items that weren't mentioned - they're still active unless explicitly completed.
Be concise. Only track real commitments, not vague intentions.

UPDATED COMMITMENTS:`,

    people: `You maintain Brian's relationship memory. Here's who he knows and a new observation.

CURRENT PEOPLE BRIAN KNOWS:
${currentContent}

NEW OBSERVATION (${dateStr}):
${newObservation}

Update the people summary to incorporate any new people, relationship changes, or recent interactions.
Format: List each person with their role/relationship, last known interaction, and any current context.
Keep people who weren't mentioned - they're still in Brian's life.
Be concise. Focus on who matters and what's current.

UPDATED PEOPLE:`,

    projects: `You maintain Brian's project tracker. Here's what he's working on and a new observation.

CURRENT PROJECTS:
${currentContent}

NEW OBSERVATION (${dateStr}):
${newObservation}

Update the projects summary to incorporate any new projects, progress, or changes.
Format: List each project/goal with current status and recent developments.
Keep projects that weren't mentioned - they're still active unless explicitly done.
Be concise. Focus on what's actively being worked on.

UPDATED PROJECTS:`,

    tensions: `You track Brian's open loops and concerns. Here's the current state and a new observation.

CURRENT TENSIONS/CONCERNS:
${currentContent}

NEW OBSERVATION (${dateStr}):
${newObservation}

Update the tensions summary to incorporate any new concerns, resolved issues, or contradictions.
Format: List each tension/concern with context and whether it's resolved or active.
Remove items that are clearly resolved. Add new worries or conflicts.
Be concise. Focus on what's actually bothering or conflicting.

UPDATED TENSIONS:`,

    mood: `You track Brian's emotional patterns. Here's recent mood data and a new observation.

RECENT MOOD PATTERNS:
${currentContent}

NEW OBSERVATION (${dateStr}):
${newObservation}

Update the mood summary to incorporate any emotional indicators from this observation.
Format: Describe current emotional state, recent trajectory, and contributing factors.
Look for explicit feelings AND implicit mood indicators (energy, stress, enthusiasm).
Be concise. Focus on patterns, not moment-to-moment fluctuations.

UPDATED MOOD:`,

    narrative: `You maintain Brian's self-narrative - his understanding of who he is, what he values, and who he's becoming. This is deeper than mood or projects; it's about identity.

CURRENT SELF-NARRATIVE:
${currentContent}

NEW OBSERVATION (${dateStr}):
${newObservation}

Update the self-narrative to incorporate any identity-relevant insights:
- Values expressed or demonstrated
- Self-realizations ("I realized I'm the kind of person who...")  
- Beliefs about what matters
- Growth patterns or changes in perspective
- Life philosophy or principles
- The story Brian tells about himself

Format: A cohesive narrative paragraph (not a list) that captures who Brian is and is becoming.
Preserve core identity elements. Add new insights. Note meaningful changes in self-understanding.
Write in third person about Brian, capturing his authentic voice and values.

UPDATED SELF-NARRATIVE:`,
  };

  const updatedContent = await generate(prompts[category]);
  
  // Update the living summary
  await pool.query(
    `UPDATE distilled_state 
     SET content = $1, 
         updated_at = NOW(),
         observation_count = observation_count + 1
     WHERE key = $2`,
    [updatedContent.trim(), category]
  );
}

/**
 * Digest a single observation into living summaries.
 * Called automatically after each observe().
 */
export async function digestObservation(
  pool: Pool,
  observationId: string,
  content: string,
  createdAt: Date
): Promise<DigestCategory[]> {
  // Check if already digested
  const existing = await pool.query(
    'SELECT id FROM digestion_log WHERE observation_id = $1',
    [observationId]
  );
  
  if (existing.rows.length > 0) {
    console.log('Observation already digested, skipping');
    return [];
  }
  
  // Classify what this observation touches
  const categories = await classifyObservation(content);
  
  if (categories.length === 0) {
    console.log('Observation doesn\'t touch any tracked categories');
    // Still log it as digested (with no categories)
    await pool.query(
      'INSERT INTO digestion_log (observation_id, categories_touched) VALUES ($1, $2)',
      [observationId, []]
    );
    return [];
  }
  
  console.log(`Digesting into: ${categories.join(', ')}`);
  
  // Update each relevant living summary
  for (const category of categories) {
    await updateLivingSummary(pool, category, content, createdAt);
  }
  
  // Log the digestion
  await pool.query(
    'INSERT INTO digestion_log (observation_id, categories_touched) VALUES ($1, $2)',
    [observationId, categories]
  );
  
  return categories;
}

/**
 * Rebuild a living summary from scratch by re-digesting all observations.
 * Use this when prompts change or summaries drift.
 */
export async function rebuildCategory(
  pool: Pool,
  category: DigestCategory
): Promise<number> {
  console.log(`Rebuilding ${category} from all observations...`);
  
  // Reset the living summary
  await pool.query(
    `UPDATE distilled_state 
     SET content = $1, observation_count = 0, updated_at = NOW()
     WHERE key = $2`,
    [`No ${category} tracked yet.`, category]
  );
  
  // Get all observations in chronological order
  const observations = await pool.query(
    'SELECT id, content, created_at FROM observations ORDER BY created_at ASC'
  );
  
  let count = 0;
  for (const obs of observations.rows) {
    // Check if this observation touches this category
    const categories = await classifyObservation(obs.content);
    if (categories.includes(category)) {
      await updateLivingSummary(pool, category, obs.content, new Date(obs.created_at));
      count++;
    }
  }
  
  console.log(`Rebuilt ${category} from ${count} observations`);
  return count;
}

/**
 * Rebuild all living summaries from scratch.
 */
export async function rebuildAll(pool: Pool): Promise<void> {
  console.log('Rebuilding all living summaries...');
  
  // Clear digestion log
  await pool.query('DELETE FROM digestion_log');
  
  // Reset all summaries
  for (const category of ALL_CATEGORIES) {
    await pool.query(
      `UPDATE distilled_state 
       SET content = $1, observation_count = 0, updated_at = NOW()
       WHERE key = $2`,
      [`No ${category} tracked yet.`, category]
    );
  }
  
  // Get all observations
  const observations = await pool.query(
    'SELECT id, content, created_at FROM observations ORDER BY created_at ASC'
  );
  
  console.log(`Processing ${observations.rows.length} observations...`);
  
  for (const obs of observations.rows) {
    await digestObservation(pool, obs.id, obs.content, new Date(obs.created_at));
  }
  
  console.log('Rebuild complete!');
}

/**
 * Get a living summary for reading.
 */
export async function getLivingSummary(
  pool: Pool,
  category: DigestCategory
): Promise<{ content: string; updatedAt: Date; observationCount: number }> {
  const result = await pool.query(
    'SELECT content, updated_at, observation_count FROM distilled_state WHERE key = $1',
    [category]
  );
  
  if (result.rows.length === 0) {
    return {
      content: `No ${category} tracked yet.`,
      updatedAt: new Date(),
      observationCount: 0
    };
  }
  
  return {
    content: result.rows[0].content,
    updatedAt: new Date(result.rows[0].updated_at),
    observationCount: result.rows[0].observation_count
  };
}

/**
 * Get all living summaries for the surface command.
 */
export async function getAllSummaries(pool: Pool): Promise<Record<DigestCategory, string>> {
  const result = await pool.query(
    'SELECT key, content FROM distilled_state'
  );
  
  const summaries: Record<string, string> = {};
  for (const row of result.rows) {
    summaries[row.key] = row.content;
  }
  
  return summaries as Record<DigestCategory, string>;
}
