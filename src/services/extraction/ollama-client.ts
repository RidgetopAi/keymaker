/**
 * Ollama client for local LLM inference and embeddings
 *
 * Implements LLMProvider for generation and EmbeddingProvider for embeddings.
 * Ollama is always used for embeddings (free, local).
 */

import { OllamaConfig } from './types.js';
import { LLMProvider, EmbeddingProvider, GenerateOptions } from './llm-provider.js';

export class OllamaClient implements LLMProvider, EmbeddingProvider {
  name = 'ollama';
  private baseUrl: string;
  private model: string;
  private embeddingModel: string;
  private config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.baseUrl = `http://${config.host}:${config.port}`;
    this.model = config.model;
    this.embeddingModel = config.embedding_model;
    this.config = config;
  }

  /**
   * Generate completion from Ollama
   */
  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        keep_alive: this.config.keep_alive,
        options: {
          temperature: options?.temperature ?? 0.1,
          num_predict: options?.max_tokens ?? 2048,
          num_thread: this.config.num_thread,
          num_ctx: this.config.num_ctx,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama generate failed: ${response.statusText}`);
    }

    const data = await response.json() as { response: string };
    return data.response;
  }

  /**
   * Generate embeddings (768 dimensions for nomic-embed-text)
   */
  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.embeddingModel,
        prompt: text,
        keep_alive: this.config.keep_alive,
        options: {
           num_thread: this.config.num_thread,
        }
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.statusText}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  /**
   * Check if Ollama is available and models are loaded
   */
  async healthCheck(): Promise<{ healthy: boolean; info?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        return { healthy: false, info: `API returned ${response.status}` };
      }
      const data = await response.json() as { models?: Array<{ name: string }> };
      const models = data.models?.map((m) => m.name) ?? [];
      return { healthy: true, info: `Models: ${models.join(', ')}` };
    } catch (err) {
      return { healthy: false, info: (err as Error).message };
    }
  }
}

function getConfigFromEnv(): OllamaConfig {
  let host = 'localhost';
  let port = 11434;
  
  if (process.env.OLLAMA_BASE_URL) {
    try {
      const url = new URL(process.env.OLLAMA_BASE_URL);
      host = url.hostname;
      port = parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80);
    } catch (e) {
      // ignore invalid url
    }
  } else {
    if (process.env.OLLAMA_HOST) host = process.env.OLLAMA_HOST;
    if (process.env.OLLAMA_PORT) port = parseInt(process.env.OLLAMA_PORT);
  }

  return {
    host,
    port,
    model: 'llama3.2:3b',
    embedding_model: 'nomic-embed-text',
    num_thread: 4,         // Use 4 vCPUs explicitly
    keep_alive: '5m',      // Keep model loaded for 5 minutes
    num_ctx: 4096,         // Allow larger context
  };
}

export const defaultOllamaConfig: OllamaConfig = getConfigFromEnv();
