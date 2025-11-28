/**
 * Keymaker Extraction Service
 *
 * Converts raw observations into structured entities, beliefs, and events.
 * Supports multiple LLM providers: Ollama (local) and Groq (cloud).
 *
 * Instance #4 - Initial scaffold
 * Instance #30 - Implemented entity extractor with observe-time extraction
 * Instance #48 - Added Groq provider support with abstraction layer
 */

// Provider abstraction
export { getLLMProvider, getEmbeddingProvider, generate, embed, healthCheck, resetProviders, getConfig } from './provider-factory.js';
export { GroqClient, GROQ_MODELS, type GroqModelId } from './groq-client.js';
export { OllamaClient } from './ollama-client.js';
export type { LLMProvider, EmbeddingProvider, LLMConfig, GenerateOptions } from './llm-provider.js';

// Extraction pipeline
export { ExtractionPipeline } from './pipeline.js';
export {
  extractAndStoreEntities,
  findSimilarPeople,
  findSimilarProjects,
  type EntityExtractionResult
} from './entity-extractor.js';
export { EntityResolver } from './resolution.js';

// Types
export type { ExtractionResult, ExtractedEntity, ExtractedEvent, ExtractedBelief, OllamaConfig } from './types.js';
