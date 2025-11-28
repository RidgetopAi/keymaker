/**
 * LLM Provider Abstraction
 *
 * Unified interface for text generation across providers (Ollama, Groq, etc.)
 * Embeddings stay with Ollama (free, local) while generation can use cloud providers.
 */

export interface GenerateOptions {
  temperature?: number;
  max_tokens?: number;
}

export interface LLMProvider {
  name: string;
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  healthCheck(): Promise<{ healthy: boolean; info?: string }>;
}

export interface EmbeddingProvider {
  name: string;
  embed(text: string): Promise<number[]>;
  healthCheck(): Promise<{ healthy: boolean; info?: string }>;
}

/**
 * Configuration for the LLM system
 */
export interface LLMConfig {
  provider: 'ollama' | 'groq';
  // Ollama settings (for embeddings, and generation if provider=ollama)
  ollama: {
    host: string;
    port: number;
    model: string;
    embedding_model: string;
    num_thread?: number;
    keep_alive?: string;
    num_ctx?: number;
  };
  // Groq settings (for generation if provider=groq)
  groq?: {
    apiKey: string;
    model: string;
  };
}

/**
 * Get LLM configuration from environment
 */
export function getLLMConfig(): LLMConfig {
  const provider = (process.env.LLM_PROVIDER || 'ollama') as 'ollama' | 'groq';

  // Parse Ollama config
  let ollamaHost = 'localhost';
  let ollamaPort = 11434;

  if (process.env.OLLAMA_BASE_URL) {
    try {
      const url = new URL(process.env.OLLAMA_BASE_URL);
      ollamaHost = url.hostname;
      ollamaPort = parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80);
    } catch {
      // ignore invalid url
    }
  } else {
    if (process.env.OLLAMA_HOST) ollamaHost = process.env.OLLAMA_HOST;
    if (process.env.OLLAMA_PORT) ollamaPort = parseInt(process.env.OLLAMA_PORT);
  }

  return {
    provider,
    ollama: {
      host: ollamaHost,
      port: ollamaPort,
      model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
      embedding_model: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
      num_thread: parseInt(process.env.OLLAMA_THREADS || '4'),
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || '5m',
      num_ctx: parseInt(process.env.OLLAMA_CTX || '4096'),
    },
    groq: process.env.GROQ_API_KEY ? {
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    } : undefined,
  };
}
