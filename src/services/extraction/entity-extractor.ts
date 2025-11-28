/**
 * Entity Extractor - Extract structured entities from observations at write-time
 *
 * Instance #30 Contribution:
 * This bridges the gap between living summaries (working well) and structured entities
 * (needed for targeted queries like "what about Sarah?" or "show me old commitments")
 *
 * Instance #48 Contribution:
 * Refactored to use provider factory - supports Groq for fast generation, Ollama for embeddings.
 *
 * Runs AFTER digestion, so both systems get updated per observation.
 */

import { Pool } from 'pg';
import { ExtractedPerson, ExtractedProject, ExtractedCommitment, ExtractedBelief } from './types.js';
import { generate, embed } from './provider-factory.js';
import { syncCommitmentToCalendar } from '../calendar.js';
import { verifyAndCorrectEventDate } from './date-verification.js';

/**
 * Get formatted current date/time string for extraction prompts
 * This gives the LLM temporal context for interpreting relative dates
 */
function getCurrentDateContext(): string {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: 'America/New_York'
  };
  return now.toLocaleString('en-US', options);
}

/**
 * Validate extracted date is reasonable (not in past, not too far in future)
 * Returns null if date is invalid/unreasonable, otherwise returns the date
 */
function validateExtractedDate(dateStr: string | undefined): string | null {
  if (!dateStr) return null;

  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    // Allow events from yesterday (in case of timezone differences) to 1 year out
    if (date < oneDayAgo) {
      console.warn(`[Calendar] Date validation: ${dateStr} is in the past, rejecting`);
      return null;
    }
    if (date > oneYearFromNow) {
      console.warn(`[Calendar] Date validation: ${dateStr} is more than 1 year out, rejecting`);
      return null;
    }

    return dateStr;
  } catch {
    return null;
  }
}

interface ContradictionCheck {
  contradicts: boolean;
  type?: string;
  severity?: 'minor' | 'moderate' | 'major' | 'critical';
  explanation?: string;
}

/**
 * Use LLM to determine if two semantically similar beliefs actually contradict
 */
async function checkContradictionWithLLM(beliefA: string, beliefB: string): Promise<ContradictionCheck> {
  const prompt = `You are analyzing two beliefs to determine if they contradict each other.

Belief A: "${beliefA}"
Belief B: "${beliefB}"

Analyze whether these beliefs contradict. Consider:
- Direct logical contradiction (A says X, B says not-X)
- Temporal contradiction (A was true before, B changes it)
- Value/preference contradiction (conflicting priorities)
- Behavioral contradiction (incompatible actions/habits)

Respond in JSON format only:
{
  "contradicts": true/false,
  "type": "direct" | "temporal" | "value" | "behavioral" | null,
  "severity": "minor" | "moderate" | "major" | "critical",
  "explanation": "brief explanation if contradicts"
}`;

  try {
    const response = await generate(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as ContradictionCheck;
    }
  } catch {
    // If LLM check fails, fall back to no contradiction
  }
  
  return { contradicts: false };
}

/**
 * Extract people mentioned in an observation
 */
async function extractPeople(content: string): Promise<ExtractedPerson[]> {
  const prompt = `Extract all people mentioned in this observation. Return valid JSON only.

Observation: "${content}"

Return a JSON array of people. For each person include:
- name: their full name or how they're referred to
- relationship_to_brian: their role/relationship (colleague, friend, family, client, etc.)
- context: any relevant context about this person from the observation
- confidence: 0.0-1.0 how confident you are this is a real person

If no people are mentioned, return: []

JSON array only, no explanation:`;

  try {
    const response = await generate(prompt);
    // Extract JSON from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      name: string;
      relationship_to_brian?: string;
      context?: string;
      confidence?: number;
    }>;
    
    return parsed.map(p => ({
      type: 'person' as const,
      name: p.name,
      relationship_to_brian: p.relationship_to_brian,
      metadata: { context: p.context },
      confidence: p.confidence ?? 0.7
    }));
  } catch {
    return [];
  }
}

/**
 * Extract projects mentioned in an observation
 */
async function extractProjects(content: string): Promise<ExtractedProject[]> {
  const prompt = `Extract all projects, initiatives, or ongoing work mentioned in this observation. Return valid JSON only.

Observation: "${content}"

Return a JSON array of projects. For each project include:
- name: project name or description
- status: active, paused, completed, or unknown
- goal: what the project aims to achieve
- confidence: 0.0-1.0 how confident this is a real project

If no projects are mentioned, return: []

JSON array only, no explanation:`;

  try {
    const response = await generate(prompt);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      name: string;
      status?: string;
      goal?: string;
      confidence?: number;
    }>;
    
    return parsed.map(p => ({
      type: 'project' as const,
      name: p.name,
      status: p.status as ExtractedProject['status'],
      goal: p.goal,
      metadata: {},
      confidence: p.confidence ?? 0.7
    }));
  } catch {
    return [];
  }
}

/**
 * Extract commitments from an observation
 * Instance #51: Enhanced to extract calendar-specific fields (event_time, duration, location, calendar intent)
 * Instance #53: Added current date/time context for accurate relative date parsing
 */
async function extractCommitments(content: string): Promise<ExtractedCommitment[]> {
  const currentDateTime = getCurrentDateContext();

  const prompt = `Extract all commitments, promises, scheduled events, or tasks Brian has made in this observation. Return valid JSON only.

IMPORTANT - Current date/time: ${currentDateTime}
Use this to correctly interpret relative dates like "tomorrow", "this Saturday", "next week", etc.

Observation: "${content}"

Return a JSON array of commitments. For each commitment include:
- description: what was promised/committed/scheduled
- committed_to: who the commitment was made to (if mentioned)
- due_date: deadline date if mentioned, in YYYY-MM-DD format (for tasks without specific time)
- event_time: specific datetime if this is a scheduled event, in ISO 8601 format with timezone offset (e.g., "2025-11-29T15:00:00-05:00")
- duration_minutes: how long the event lasts (e.g., 30, 60, 90). Default to 60 if a meeting but duration not specified.
- location: where it takes place (e.g., "Office", "Zoom", "123 Main St", null if not mentioned)
- add_to_calendar: true if Brian explicitly said "add to calendar", "put on my calendar", "schedule this", etc.
- status: pending, in_progress, completed, or unknown
- confidence: 0.0-1.0 how confident this is a real commitment

CRITICAL: Date parsing rules (assume Eastern Time):
- "tomorrow" = the day after ${currentDateTime.split(',')[0]}
- "this Saturday" = the upcoming Saturday from today
- "next Saturday" = the Saturday AFTER this upcoming Saturday
- "the 29th" = the 29th of the CURRENT month (November 2025), unless context clearly indicates otherwise
- "Saturday the 29th" = November 29, 2025 (this Saturday)
- "Monday at 3pm" = the upcoming Monday at 3:00 PM Eastern

Time parsing examples:
- "tomorrow at 3pm" -> if today is Friday Nov 28, event_time: "2025-11-29T15:00:00-05:00"
- "this Saturday" -> if today is Friday Nov 28, event_time: "2025-11-29T..." (Saturday Nov 29)
- "next Tuesday 10am" -> "2025-12-02T10:00:00-05:00" (Tuesday Dec 2)
- "the 29th at 2pm" -> "2025-11-29T14:00:00-05:00" (November 29)
- "for 30 minutes" -> duration_minutes: 30
- "1 hour meeting" -> duration_minutes: 60

If no commitments are mentioned, return: []

JSON array only, no explanation:`;

  try {
    const response = await generate(prompt);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      description: string;
      committed_to?: string;
      due_date?: string;
      event_time?: string;
      duration_minutes?: number;
      location?: string;
      add_to_calendar?: boolean;
      status?: string;
      confidence?: number;
    }>;

    return parsed.map(c => {
      // Step 1: Basic validation - reject dates that are unreasonable
      let finalEventTime = validateExtractedDate(c.event_time);
      if (c.event_time && !finalEventTime) {
        console.log(`[Extraction] Rejected invalid event_time: ${c.event_time} for "${c.description}"`);
      }

      // Step 2: Verify and correct date against user's original input
      // This catches LLM errors like "Saturday the 29th" → wrong day
      if (finalEventTime) {
        const verification = verifyAndCorrectEventDate(
          content,                    // Original user input
          new Date(finalEventTime),   // LLM's extracted date
          new Date()                  // Current anchor date
        );

        if (!verification.isValid) {
          console.log(`[Extraction] Date corrected for "${c.description}":`);
          verification.corrections.forEach(corr => console.log(`  - ${corr}`));
          finalEventTime = verification.correctedDate.toISOString();
        }
      }

      return {
        type: 'commitment' as const,
        name: c.description.slice(0, 100), // Short name for display
        description: c.description,
        committed_to: c.committed_to,
        due_date: c.due_date,
        event_time: finalEventTime || undefined,
        duration_minutes: c.duration_minutes,
        location: c.location,
        add_to_calendar: c.add_to_calendar,
        status: c.status as ExtractedCommitment['status'],
        metadata: {},
        confidence: c.confidence ?? 0.7
      };
    });
  } catch {
    return [];
  }
}

/**
 * Extract facts/beliefs about Brian from an observation
 */
async function extractBeliefs(content: string): Promise<ExtractedBelief[]> {
  const prompt = `Extract any facts, preferences, or beliefs about Brian from this observation. Return valid JSON only.

Observation: "${content}"

Return a JSON array. For each belief include:
- subject: what/who this belief is about
- statement: the belief/fact/preference
- belief_type: fact, preference, constraint, intention, or state
- is_temporary: true if this is a temporary state, false if enduring
- confidence: 0.0-1.0 confidence level

If no beliefs can be extracted, return: []

JSON array only, no explanation:`;

  try {
    const response = await generate(prompt);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      subject: string;
      statement: string;
      belief_type?: string;
      is_temporary?: boolean;
      confidence?: number;
    }>;
    
    return parsed.map(b => ({
      subject: b.subject,
      statement: b.statement,
      belief_type: (b.belief_type as ExtractedBelief['belief_type']) || 'fact',
      is_temporary: b.is_temporary ?? false,
      confidence: b.confidence ?? 0.7
    }));
  } catch {
    return [];
  }
}

/**
 * Find existing entity by name (fuzzy match)
 */
async function findExistingPerson(pool: Pool, name: string): Promise<string | null> {
  try {
    const result = await pool.query(
      `SELECT id FROM entities_people 
       WHERE LOWER(canonical_name) = LOWER($1)
          OR $1 = ANY(SELECT LOWER(unnest(aliases)))
       LIMIT 1`,
      [name]
    );
    return result.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function findExistingProject(pool: Pool, name: string): Promise<string | null> {
  try {
    const result = await pool.query(
      `SELECT id FROM entities_projects 
       WHERE LOWER(name) = LOWER($1)
          OR LOWER(code_name) = LOWER($1)
       LIMIT 1`,
      [name]
    );
    return result.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Store or update a person entity
 */
async function storePerson(
  pool: Pool, 
  person: ExtractedPerson, 
  observationId: string
): Promise<string> {
  const existingId = await findExistingPerson(pool, person.name);
  
  if (existingId) {
    // Update last_seen
    await pool.query(
      `UPDATE entities_people SET last_seen = NOW(), updated_at = NOW() WHERE id = $1`,
      [existingId]
    );
    return existingId;
  }
  
  // Generate embedding for the person context
  const contextText = `${person.name} - ${person.relationship_to_brian || 'unknown relationship'} - ${person.metadata?.context || ''}`;
  const embedding = await embed(contextText);
  const embeddingStr = `[${embedding.join(',')}]`;
  
  const result = await pool.query(
    `INSERT INTO entities_people (
      canonical_name, relationship_type, context_summary, 
      confidence, source_type, embedding
    ) VALUES ($1, $2, $3, $4, 'observation', $5::vector)
    RETURNING id`,
    [
      person.name,
      person.relationship_to_brian,
      person.metadata?.context as string,
      person.confidence,
      embeddingStr
    ]
  );
  
  return result.rows[0].id;
}

/**
 * Store or update a project entity
 */
async function storeProject(
  pool: Pool, 
  project: ExtractedProject, 
  observationId: string
): Promise<string> {
  const existingId = await findExistingProject(pool, project.name);
  
  if (existingId) {
    // Update status if we have new info
    if (project.status) {
      await pool.query(
        `UPDATE entities_projects SET status = $1, updated_at = NOW() WHERE id = $2`,
        [project.status, existingId]
      );
    }
    return existingId;
  }
  
  // Generate embedding
  const contextText = `${project.name} - ${project.goal || 'no goal specified'}`;
  const embedding = await embed(contextText);
  const embeddingStr = `[${embedding.join(',')}]`;
  
  const result = await pool.query(
    `INSERT INTO entities_projects (
      name, status, description, confidence, embedding
    ) VALUES ($1, $2, $3, $4, $5::vector)
    RETURNING id`,
    [
      project.name,
      project.status || 'active',
      project.goal,
      project.confidence,
      embeddingStr
    ]
  );
  
  return result.rows[0].id;
}

/**
 * Store a commitment
 * Instance #51: Enhanced to store calendar fields (event_time, duration, location, sync flag)
 * Instance #52: Added CalDAV sync when add_to_calendar is true
 */
async function storeCommitment(
  pool: Pool,
  commitment: ExtractedCommitment,
  observationId: string,
  personId?: string,
  projectId?: string
): Promise<string> {
  // Generate embedding
  const embedding = await embed(commitment.description);
  const embeddingStr = `[${embedding.join(',')}]`;

  // Determine commitment type based on whether it has a specific time
  const commitmentType = commitment.event_time ? 'meeting' : 'deliverable';

  const result = await pool.query(
    `INSERT INTO entities_commitments (
      description, commitment_type, committed_at, due_date, status,
      committed_to, project_id, source_context, source_confidence, embedding,
      event_time, duration_minutes, location, synced_to_calendar
    ) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9::vector, $10, $11, $12, $13)
    RETURNING id`,
    [
      commitment.description,
      commitmentType,
      commitment.due_date ? new Date(commitment.due_date) : null,
      commitment.status || 'pending',
      personId,
      projectId,
      `Extracted from observation ${observationId}`,
      commitment.confidence,
      embeddingStr,
      commitment.event_time ? new Date(commitment.event_time) : null,
      commitment.duration_minutes || null,
      commitment.location || null,
      commitment.add_to_calendar || false
    ]
  );

  const commitmentId = result.rows[0].id;

  // Sync to CalDAV if add_to_calendar is true and event_time is set
  if (commitment.add_to_calendar && commitment.event_time) {
    try {
      await syncCommitmentToCalendar({
        id: commitmentId,
        description: commitment.description,
        event_time: new Date(commitment.event_time),
        duration_minutes: commitment.duration_minutes,
        location: commitment.location,
        committed_to: commitment.committed_to
      });

      // Update caldav_uid in database
      const uid = `keymaker-commitment-${commitmentId}@keymaker`;
      await pool.query(
        `UPDATE entities_commitments SET caldav_uid = $1 WHERE id = $2`,
        [uid, commitmentId]
      );
    } catch (error) {
      // Log but don't fail - calendar sync is non-critical
      console.error(`[Calendar] Failed to sync commitment ${commitmentId}:`, error);
    }
  }

  return commitmentId;
}

/**
 * Store a belief in the beliefs table
 * Instance #42 contribution: Implement belief storage for contradiction tracking
 */
async function storeBelief(
  pool: Pool,
  belief: ExtractedBelief,
  observationId: string
): Promise<string> {
  // Skip beliefs with empty/undefined statements
  if (!belief.statement || typeof belief.statement !== 'string' || belief.statement.trim() === '') {
    throw new Error('Invalid belief: empty statement');
  }
  
  // Check for existing similar belief first
  const existing = await pool.query(
    `SELECT id FROM beliefs WHERE LOWER(statement) = LOWER($1) AND is_active = TRUE LIMIT 1`,
    [belief.statement.trim()]
  );
  
  if (existing.rows[0]) {
    // Update confidence if higher
    await pool.query(
      `UPDATE beliefs SET 
        confidence = GREATEST(confidence, $1),
        updated_at = NOW()
       WHERE id = $2`,
      [belief.confidence, existing.rows[0].id]
    );
    return existing.rows[0].id;
  }
  
  // Generate embedding for the belief statement
  const embedding = await embed(`${belief.subject}: ${belief.statement}`);
  const embeddingStr = `[${embedding.join(',')}]`;
  
  // Map ExtractedBelief type to database belief_type
  const beliefType = belief.belief_type === 'intention' ? 'goal' : 
                     belief.belief_type === 'state' ? 'behavior' : 
                     belief.belief_type;
  
  const result = await pool.query(
    `INSERT INTO beliefs (
      statement, belief_type, confidence, source_type, source_context, source_id,
      valid_until, embedding
    ) VALUES ($1, $2, $3, 'observation', $4, $5, $6, $7::vector)
    RETURNING id`,
    [
      belief.statement.trim(),
      beliefType,
      belief.confidence,
      `Subject: ${belief.subject}`,
      observationId,
      belief.is_temporary ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null, // 1 week for temporary
      embeddingStr
    ]
  );
  
  const newBeliefId = result.rows[0].id;
  
  // Detect contradictions with existing beliefs using semantic similarity
  await detectAndStoreContradictions(pool, newBeliefId);
  
  return newBeliefId;
}

/**
 * Detect contradictions between a new belief and existing beliefs
 * Uses embedding similarity to find potential conflicts
 */
async function detectAndStoreContradictions(pool: Pool, newBeliefId: string): Promise<void> {
  try {
    // Find similar beliefs that might contradict
    const similar = await pool.query(
      `SELECT b.id, b.statement, b.confidence,
              1 - (b.embedding <=> nb.embedding) as similarity
       FROM beliefs b, beliefs nb
       WHERE nb.id = $1
       AND b.id != $1
       AND b.is_active = TRUE
       AND b.embedding IS NOT NULL
       AND nb.embedding IS NOT NULL
       AND (b.embedding <=> nb.embedding) < 0.3  -- High similarity (low distance)
       ORDER BY (b.embedding <=> nb.embedding) ASC
       LIMIT 5`,
      [newBeliefId]
    );
    
    for (const similar_belief of similar.rows) {
      // Get the new belief text for LLM analysis
      const newBelief = await pool.query(
        `SELECT statement FROM beliefs WHERE id = $1`,
        [newBeliefId]
      );
      
      // Use LLM to determine if they actually contradict
      const isContradiction = await checkContradictionWithLLM(
        newBelief.rows[0].statement,
        similar_belief.statement
      );
      
      if (isContradiction.contradicts) {
        // Order IDs to satisfy unique constraint (belief_a_id < belief_b_id)
        const [beliefA, beliefB] = newBeliefId < similar_belief.id 
          ? [newBeliefId, similar_belief.id]
          : [similar_belief.id, newBeliefId];
        
        await pool.query(
          `INSERT INTO contradictions (
            belief_a_id, belief_b_id, contradiction_type, severity,
            detection_method, detection_confidence, explanation
          ) VALUES ($1, $2, $3, $4, 'semantic_embedding', $5, $6)
          ON CONFLICT (belief_a_id, belief_b_id) DO NOTHING`,
          [
            beliefA,
            beliefB,
            isContradiction.type || 'semantic_opposition',
            isContradiction.severity || 'moderate',
            similar_belief.similarity,
            isContradiction.explanation || 'Detected via semantic similarity'
          ]
        );
      }
    }
  } catch (err) {
    // Don't fail belief storage if contradiction detection fails
    console.warn('Contradiction detection failed:', (err as Error).message);
  }
}

export interface EntityExtractionResult {
  people: { id: string; name: string; isNew: boolean }[];
  projects: { id: string; name: string; isNew: boolean }[];
  commitments: { id: string; description: string }[];
  beliefs: { id: string; statement: string; isNew: boolean }[];
  extraction_time_ms: number;
}

/**
 * Main extraction function - extract and store all entities from an observation
 * Call this AFTER digestion for each observation.
 */
export async function extractAndStoreEntities(
  pool: Pool,
  observationId: string,
  content: string
): Promise<EntityExtractionResult> {
  const startTime = Date.now();
  
  // Check if already extracted
  const existing = await pool.query(
    `SELECT id FROM extraction_jobs 
     WHERE observation_id = $1 AND stage = 'entity_extraction' AND status = 'completed'`,
    [observationId]
  );
  
  if (existing.rows.length > 0) {
    console.log('Entities already extracted for this observation');
    return {
      people: [],
      projects: [],
      commitments: [],
      beliefs: [],
      extraction_time_ms: 0
    };
  }
  
  // Create extraction job
  await pool.query(
    `INSERT INTO extraction_jobs (observation_id, stage, status, started_at)
     VALUES ($1, 'entity_extraction', 'running', NOW())`,
    [observationId]
  );
  
  try {
    // Extract all entity types in parallel
    const [people, projects, commitments, beliefs] = await Promise.all([
      extractPeople(content),
      extractProjects(content),
      extractCommitments(content),
      extractBeliefs(content)
    ]);
    
    // Store people (skip any with invalid names)
    const storedPeople: EntityExtractionResult['people'] = [];
    for (const person of people) {
      if (!person.name || typeof person.name !== 'string' || person.name.trim() === '') {
        continue; // Skip invalid person entries
      }
      const existingId = await findExistingPerson(pool, person.name);
      const id = await storePerson(pool, person, observationId);
      storedPeople.push({ id, name: person.name, isNew: !existingId });
    }
    
    // Store projects (skip any with invalid names)
    const storedProjects: EntityExtractionResult['projects'] = [];
    for (const project of projects) {
      if (!project.name || typeof project.name !== 'string' || project.name.trim() === '') {
        continue; // Skip invalid project entries
      }
      const existingId = await findExistingProject(pool, project.name);
      const id = await storeProject(pool, project, observationId);
      storedProjects.push({ id, name: project.name, isNew: !existingId });
    }
    
    // Store commitments (try to link to people/projects)
    const storedCommitments: EntityExtractionResult['commitments'] = [];
    for (const commitment of commitments) {
      // Try to find related person
      let personId: string | undefined;
      if (commitment.committed_to) {
        personId = await findExistingPerson(pool, commitment.committed_to) || undefined;
      }
      
      const id = await storeCommitment(pool, commitment, observationId, personId);
      storedCommitments.push({ id, description: commitment.description });
    }
    
    // Store beliefs - Instance #42 contribution
    const storedBeliefs: EntityExtractionResult['beliefs'] = [];
    for (const belief of beliefs) {
      try {
        const id = await storeBelief(pool, belief, observationId);
        storedBeliefs.push({ id, statement: belief.statement, isNew: true });
      } catch (err) {
        console.warn(`Failed to store belief: ${belief.statement}`, (err as Error).message);
      }
    }
    
    const extractionTime = Date.now() - startTime;
    
    // Mark job complete
    await pool.query(
      `UPDATE extraction_jobs 
       SET status = 'completed', completed_at = NOW(),
           entities_found = $1, beliefs_found = $2
       WHERE observation_id = $3 AND stage = 'entity_extraction'`,
      [storedPeople.length + storedProjects.length + storedCommitments.length, storedBeliefs.length, observationId]
    );
    
    // Update observation with extracted data
    await pool.query(
      `UPDATE observations 
       SET extracted_entities = $1, extracted_beliefs = $2, 
           processing_status = 'processed', processed_at = NOW()
       WHERE id = $3`,
      [
        JSON.stringify({
          people: storedPeople,
          projects: storedProjects,
          commitments: storedCommitments
        }),
        JSON.stringify(storedBeliefs),
        observationId
      ]
    );
    
    return {
      people: storedPeople,
      projects: storedProjects,
      commitments: storedCommitments,
      beliefs: storedBeliefs,
      extraction_time_ms: extractionTime
    };
  } catch (err) {
    // Mark job failed
    await pool.query(
      `UPDATE extraction_jobs 
       SET status = 'failed', error_message = $1
       WHERE observation_id = $2 AND stage = 'entity_extraction'`,
      [(err as Error).message, observationId]
    );
    throw err;
  }
}

/**
 * Query entities by semantic similarity
 */
export async function findSimilarPeople(
  pool: Pool,
  query: string,
  limit: number = 5
): Promise<Array<{ id: string; name: string; similarity: number; relationship?: string }>> {
  const embedding = await embed(query);
  const embeddingStr = `[${embedding.join(',')}]`;
  
  const result = await pool.query(
    `SELECT id, canonical_name, relationship_type,
            1 - (embedding <=> $1::vector) as similarity
     FROM entities_people
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [embeddingStr, limit]
  );
  
  return result.rows.map(r => ({
    id: r.id,
    name: r.canonical_name,
    similarity: r.similarity,
    relationship: r.relationship_type
  }));
}

/**
 * Query projects by semantic similarity
 */
export async function findSimilarProjects(
  pool: Pool,
  query: string,
  limit: number = 5
): Promise<Array<{ id: string; name: string; similarity: number; status?: string }>> {
  const embedding = await embed(query);
  const embeddingStr = `[${embedding.join(',')}]`;
  
  const result = await pool.query(
    `SELECT id, name, status,
            1 - (embedding <=> $1::vector) as similarity
     FROM entities_projects
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [embeddingStr, limit]
  );
  
  return result.rows.map(r => ({
    id: r.id,
    name: r.name,
    similarity: r.similarity,
    status: r.status
  }));
}
