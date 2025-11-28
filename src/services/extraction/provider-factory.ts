/**
 * Provider Factory
 *
 * Creates the appropriate LLM provider based on configuration.
 * Strategy: Groq for generation (fast), Ollama for embeddings (free).
 */

import { LLMProvider, EmbeddingProvider, getLLMConfig, LLMConfig } from './llm-provider.js';
import { OllamaClient } from './ollama-client.js';
import { GroqClient } from './groq-client.js';

let cachedConfig: LLMConfig | null = null;
let cachedLLMProvider: LLMProvider | null = null;
let cachedEmbeddingProvider: EmbeddingProvider | null = null;

/**
 * Get the LLM provider for text generation
 * Returns Groq if configured, otherwise Ollama
 */
export function getLLMProvider(): LLMProvider {
  if (cachedLLMProvider) {
    return cachedLLMProvider;
  }

  const config = getConfig();

  if (config.provider === 'groq' && config.groq?.apiKey) {
    console.log(`[LLM] Using Groq (${config.groq.model}) for generation`);
    cachedLLMProvider = new GroqClient({
      apiKey: config.groq.apiKey,
      model: config.groq.model,
    });
  } else {
    console.log(`[LLM] Using Ollama (${config.ollama.model}) for generation`);
    cachedLLMProvider = new OllamaClient(config.ollama);
  }

  return cachedLLMProvider;
}

/**
 * Get the embedding provider (always Ollama - it's free and local)
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (cachedEmbeddingProvider) {
    return cachedEmbeddingProvider;
  }

  const config = getConfig();
  console.log(`[LLM] Using Ollama (${config.ollama.embedding_model}) for embeddings`);
  cachedEmbeddingProvider = new OllamaClient(config.ollama);

  return cachedEmbeddingProvider;
}

/**
 * Get the current LLM configuration
 */
export function getConfig(): LLMConfig {
  if (!cachedConfig) {
    cachedConfig = getLLMConfig();
  }
  return cachedConfig;
}

/**
 * Reset cached providers (useful for testing or config changes)
 */
export function resetProviders(): void {
  cachedConfig = null;
  cachedLLMProvider = null;
  cachedEmbeddingProvider = null;
}

/**
 * Convenience function to generate text with the configured provider
 */
export async function generate(prompt: string, options?: { temperature?: number; max_tokens?: number }): Promise<string> {
  const provider = getLLMProvider();
  return provider.generate(prompt, options);
}

/**
 * Convenience function to generate embeddings (always uses Ollama)
 */
export async function embed(text: string): Promise<number[]> {
  const provider = getEmbeddingProvider();
  return provider.embed(text);
}

/**
 * Health check for both providers
 */
export async function healthCheck(): Promise<{
  generation: { provider: string; healthy: boolean; info?: string };
  embedding: { provider: string; healthy: boolean; info?: string };
}> {
  const llm = getLLMProvider();
  const emb = getEmbeddingProvider();

  const [genHealth, embHealth] = await Promise.all([
    llm.healthCheck(),
    emb.healthCheck(),
  ]);

  return {
    generation: { provider: llm.name, ...genHealth },
    embedding: { provider: emb.name, ...embHealth },
  };
}
