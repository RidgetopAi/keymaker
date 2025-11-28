/**
 * Chat Service
 * Instance #49: Orchestrates conversational interface
 *
 * Handles the full chat flow:
 * 1. Receive user message
 * 2. Detect intent
 * 3. Route to appropriate handler (query/observe/update)
 * 4. Generate response
 * 5. Store messages in session
 */

import { Pool } from 'pg';
import { detectIntent, ChatIntent, IntentResult } from './intent-detector.js';
import { generate } from '../extraction/provider-factory.js';
import { getAllSummaries } from '../digest.js';
import { embed } from '../../cli.js';

interface SearchResult {
  id: string;
  content: string;
  created_at: Date;
  similarity: number;
}

/**
 * Semantic search for relevant observations
 */
async function semanticSearch(pool: Pool, query: string, limit: number = 5): Promise<SearchResult[]> {
  const embedding = await embed(query);
  const embeddingStr = `[${embedding.join(',')}]`;

  const result = await pool.query(
    `SELECT id, content, created_at, 1 - (embedding <=> $1::vector) as similarity
     FROM observations
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [embeddingStr, limit]
  );

  return result.rows;
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  intent?: ChatIntent;
  intentConfidence?: number;
  actionTaken?: Record<string, unknown>;
  createdAt?: Date;
}

export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  createdAt: Date;
  lastActivity: Date;
}

/**
 * Get or create a chat session
 */
export async function getOrCreateSession(pool: Pool, sessionId?: string): Promise<ChatSession> {
  if (sessionId) {
    // Try to get existing session
    const result = await pool.query(
      `SELECT id, created_at, last_activity FROM chat_sessions WHERE id = $1`,
      [sessionId]
    );

    if (result.rows.length > 0) {
      const session = result.rows[0];
      const messages = await getSessionMessages(pool, session.id);
      return {
        id: session.id,
        messages,
        createdAt: session.created_at,
        lastActivity: session.last_activity
      };
    }
  }

  // Create new session
  const result = await pool.query(
    `INSERT INTO chat_sessions DEFAULT VALUES RETURNING id, created_at, last_activity`
  );
  const session = result.rows[0];

  return {
    id: session.id,
    messages: [],
    createdAt: session.created_at,
    lastActivity: session.last_activity
  };
}

/**
 * Get messages for a session
 */
async function getSessionMessages(pool: Pool, sessionId: string): Promise<ChatMessage[]> {
  const result = await pool.query(
    `SELECT id, role, content, intent, intent_confidence, action_taken, created_at
     FROM chat_messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );

  return result.rows.map(row => ({
    id: row.id,
    role: row.role,
    content: row.content,
    intent: row.intent,
    intentConfidence: row.intent_confidence,
    actionTaken: row.action_taken,
    createdAt: row.created_at
  }));
}

/**
 * Store a message in the session
 */
async function storeMessage(
  pool: Pool,
  sessionId: string,
  message: ChatMessage
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO chat_messages (session_id, role, content, intent, intent_confidence, action_taken)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      sessionId,
      message.role,
      message.content,
      message.intent || null,
      message.intentConfidence || null,
      message.actionTaken ? JSON.stringify(message.actionTaken) : null
    ]
  );
  return result.rows[0].id;
}

/**
 * Process a user message and generate response
 */
export async function processMessage(
  pool: Pool,
  sessionId: string,
  userMessage: string
): Promise<{ response: string; intent: IntentResult; actionTaken?: Record<string, unknown> }> {
  // Get recent messages for context
  const recentMessages = await getSessionMessages(pool, sessionId);
  const recentForContext = recentMessages.slice(-6).map(m => ({
    role: m.role,
    content: m.content
  }));

  // Store user message first
  await storeMessage(pool, sessionId, {
    role: 'user',
    content: userMessage
  });

  // Detect intent
  const intent = await detectIntent(userMessage, recentForContext);
  console.log(`[Chat] Intent: ${intent.intent} (${intent.confidence.toFixed(2)})`);

  let response: string;
  let actionTaken: Record<string, unknown> | undefined;

  // Route based on intent
  switch (intent.intent) {
    case 'query':
      response = await handleQuery(pool, userMessage, intent, recentForContext);
      actionTaken = { type: 'query', queryType: intent.details.queryType };
      break;

    case 'observation':
      const obsResult = await handleObservation(pool, userMessage, intent);
      response = obsResult.response;
      actionTaken = obsResult.action;
      break;

    case 'update':
      const updateResult = await handleUpdate(pool, userMessage, intent);
      response = updateResult.response;
      actionTaken = updateResult.action;
      break;

    case 'clarification':
      response = intent.details.clarificationQuestion ||
        "I'm not sure what you mean. Could you rephrase that? Are you asking a question, recording something new, or updating a task?";
      actionTaken = { type: 'clarification' };
      break;

    default:
      response = "I'm not sure how to help with that. Try asking a question or telling me something to remember.";
      actionTaken = { type: 'unknown' };
  }

  // Store assistant response
  await storeMessage(pool, sessionId, {
    role: 'assistant',
    content: response,
    intent: intent.intent,
    intentConfidence: intent.confidence,
    actionTaken
  });

  return { response, intent, actionTaken };
}

/**
 * Handle query intent
 */
async function handleQuery(
  pool: Pool,
  userMessage: string,
  intent: IntentResult,
  recentMessages: Array<{ role: string; content: string }>
): Promise<string> {
  // Get relevant context
  const summaries = await getAllSummaries(pool);
  const searchResults = await semanticSearch(pool, userMessage, 5);

  // Build context
  const relevantObs = searchResults.map(r =>
    `[${new Date(r.created_at).toLocaleDateString()}] ${r.content}`
  ).join('\n');

  const conversationContext = recentMessages.length > 0
    ? recentMessages.map(m => `${m.role}: ${m.content}`).join('\n')
    : '';

  const prompt = `You are Brian's personal memory assistant. Answer his question based on what you know about him.

BRIAN'S CURRENT STATE:
Commitments: ${summaries.commitments || 'None recorded'}
People: ${summaries.people || 'None recorded'}
Projects: ${summaries.projects || 'None recorded'}
Mood: ${summaries.mood || 'Unknown'}

RELEVANT PAST OBSERVATIONS:
${relevantObs || 'No relevant observations found'}

RECENT CONVERSATION:
${conversationContext || 'Start of conversation'}

BRIAN'S QUESTION: ${userMessage}

Respond naturally and conversationally. Be concise but helpful. If you're listing tasks or items, use a clean format.
If you don't have enough information, say so honestly.`;

  return generate(prompt, { temperature: 0.3 });
}

/**
 * Handle observation intent - store new information
 */
async function handleObservation(
  pool: Pool,
  userMessage: string,
  intent: IntentResult
): Promise<{ response: string; action: Record<string, unknown> }> {
  const observationText = intent.details.observationText || userMessage;

  // Insert observation
  const result = await pool.query(
    `INSERT INTO observations (content) VALUES ($1) RETURNING id`,
    [observationText]
  );
  const obsId = result.rows[0].id;

  // Trigger digestion (import dynamically to avoid circular deps)
  const { digestObservation } = await import('../digest.js');
  await digestObservation(pool, obsId, observationText, new Date());

  // Trigger entity extraction
  try {
    const { extractAndStoreEntities } = await import('../extraction/entity-extractor.js');
    await extractAndStoreEntities(pool, obsId, observationText);
  } catch (e) {
    console.log('[Chat] Entity extraction skipped:', e);
  }

  return {
    response: `Got it, I'll remember that.`,
    action: { type: 'observation', observationId: obsId }
  };
}

/**
 * Handle update intent - mark things complete, change status
 */
async function handleUpdate(
  pool: Pool,
  userMessage: string,
  intent: IntentResult
): Promise<{ response: string; action: Record<string, unknown> }> {
  const updateTarget = intent.details.updateTarget || userMessage;
  const updateStatus = intent.details.updateStatus || 'completed';

  // Record this as an observation (the existing system will handle the update via digestion)
  // The digest system's classifier will catch "paid/done/completed" and update commitments
  const result = await pool.query(
    `INSERT INTO observations (content) VALUES ($1) RETURNING id`,
    [userMessage]
  );
  const obsId = result.rows[0].id;

  // Trigger digestion which will update the commitments summary
  const { digestObservation } = await import('../digest.js');
  await digestObservation(pool, obsId, userMessage, new Date());

  // Also try to update entities_commitments if we can find a match
  try {
    const commitmentSearch = await pool.query(
      `SELECT id, description FROM entities_commitments
       WHERE description ILIKE $1
       AND status != 'completed'
       LIMIT 1`,
      [`%${updateTarget}%`]
    );

    if (commitmentSearch.rows.length > 0) {
      const commitment = commitmentSearch.rows[0];
      await pool.query(
        `UPDATE entities_commitments SET status = $1, completed_at = NOW() WHERE id = $2`,
        [updateStatus, commitment.id]
      );

      return {
        response: `Done! I've marked "${commitment.description}" as ${updateStatus}.`,
        action: { type: 'update', commitmentId: commitment.id, status: updateStatus }
      };
    }
  } catch (e) {
    console.log('[Chat] Commitment update lookup failed:', e);
  }

  // Fallback: just confirm the observation was recorded
  return {
    response: `Noted! I've recorded that update.`,
    action: { type: 'update', observationId: obsId, status: updateStatus }
  };
}

/**
 * Prune old chat sessions (called by cron or manually)
 */
export async function pruneOldSessions(pool: Pool): Promise<number> {
  const result = await pool.query(`SELECT prune_old_chat_sessions()`);
  return result.rows[0].prune_old_chat_sessions;
}
