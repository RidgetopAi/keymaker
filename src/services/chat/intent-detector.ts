/**
 * Intent Detection Service
 * Instance #49: Classifies user input to route appropriately
 *
 * Intents:
 * - query: User is asking a question ("what's left?", "who is X?")
 * - observation: User is recording something new ("met with John today")
 * - update: User is marking something complete/changed ("finished the gas bill")
 * - clarification: System needs more info (ambiguous input)
 */

import { generate } from '../extraction/provider-factory.js';

export type ChatIntent = 'query' | 'observation' | 'update' | 'clarification';

export interface IntentResult {
  intent: ChatIntent;
  confidence: number;
  details: {
    // For observations
    observationText?: string;
    // For updates
    updateTarget?: string; // What's being updated (e.g., "gas bill")
    updateStatus?: string; // New status (e.g., "completed", "paid")
    // For queries
    queryType?: string; // "commitments", "people", "general"
    queryText?: string;
    // For clarification
    clarificationQuestion?: string;
  };
}

const INTENT_PROMPT = `You are an intent classifier for a personal memory assistant. Analyze the user's message and determine what they want to do.

INTENTS:
1. "query" - User is asking a question or requesting information
   Examples: "what do I have left to do?", "who is Sarah?", "what did I decide about X?"

2. "observation" - User is recording a new fact, event, or thought
   Examples: "met with John today about the project", "feeling stressed about deadlines", "decided to use React"

3. "update" - User is marking something as complete, changed, or updating existing information
   Examples: "finished the gas bill", "paid rent", "done with the VPS setup", "completed X Y and Z"
   Key indicators: "finished", "done", "completed", "paid", past tense verbs for tasks

4. "clarification" - The input is ambiguous and you need more information
   Example: Single word with no context, unclear reference

RECENT CONVERSATION (for context):
{recentMessages}

USER MESSAGE: {userMessage}

Respond with JSON only:
{
  "intent": "query" | "observation" | "update" | "clarification",
  "confidence": 0.0-1.0,
  "details": {
    // Include relevant fields based on intent:
    // For query: "queryType" (commitments/people/projects/general), "queryText"
    // For observation: "observationText" (cleaned/normalized observation)
    // For update: "updateTarget" (what's being updated), "updateStatus" (completed/paid/cancelled/etc)
    // For clarification: "clarificationQuestion" (what to ask user)
  },
  "reasoning": "brief explanation"
}`;

export async function detectIntent(
  userMessage: string,
  recentMessages: Array<{ role: string; content: string }> = []
): Promise<IntentResult> {
  // Format recent messages for context
  const recentContext = recentMessages.length > 0
    ? recentMessages.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n')
    : 'No recent messages';

  const prompt = INTENT_PROMPT
    .replace('{recentMessages}', recentContext)
    .replace('{userMessage}', userMessage);

  try {
    const response = await generate(prompt, { temperature: 0.1 });

    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Intent detection: No JSON in response:', response);
      return fallbackIntent(userMessage);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      intent: parsed.intent || 'clarification',
      confidence: parsed.confidence || 0.5,
      details: parsed.details || {}
    };
  } catch (error) {
    console.error('Intent detection error:', error);
    return fallbackIntent(userMessage);
  }
}

/**
 * Simple heuristic fallback if LLM fails
 */
function fallbackIntent(message: string): IntentResult {
  const lower = message.toLowerCase().trim();

  // Query indicators
  if (lower.startsWith('what') || lower.startsWith('who') || lower.startsWith('how') ||
      lower.startsWith('when') || lower.startsWith('where') || lower.startsWith('why') ||
      lower.includes('?')) {
    return {
      intent: 'query',
      confidence: 0.6,
      details: { queryType: 'general', queryText: message }
    };
  }

  // Update indicators
  const updateWords = ['finished', 'done', 'completed', 'paid', 'cancelled', 'canceled'];
  if (updateWords.some(w => lower.includes(w))) {
    return {
      intent: 'update',
      confidence: 0.6,
      details: { updateTarget: message, updateStatus: 'completed' }
    };
  }

  // Default to observation
  return {
    intent: 'observation',
    confidence: 0.5,
    details: { observationText: message }
  };
}
