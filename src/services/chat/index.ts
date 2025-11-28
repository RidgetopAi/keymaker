/**
 * Chat Service Exports
 * Instance #49
 */

export { detectIntent, type ChatIntent, type IntentResult } from './intent-detector.js';
export {
  getOrCreateSession,
  processMessage,
  pruneOldSessions,
  type ChatMessage,
  type ChatSession
} from './chat-service.js';
