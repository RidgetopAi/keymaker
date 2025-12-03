/**
 * Groq client for fast cloud LLM inference
 *
 * Uses Groq's OpenAI-compatible API for text generation.
 * Embeddings should still use Ollama (Groq doesn't have embedding models).
 */

import { LLMProvider, GenerateOptions } from './llm-provider.js';

interface GroqConfig {
  apiKey: string;
  model: string;
}

interface GroqChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GroqChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class GroqClient implements LLMProvider {
  name = 'groq';
  private apiKey: string;
  private model: string;
  private baseUrl = 'https://api.groq.com/openai/v1';

  constructor(config: GroqConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  /**
   * Generate completion using Groq's chat API
   */
  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    const messages: GroqChatMessage[] = [];

    // Use proper system/user separation when systemPrompt provided
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
      messages.push({ role: 'user', content: prompt });
    } else {
      // Legacy: treat entire prompt as user message
      messages.push({ role: 'user', content: prompt });
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options?.temperature ?? 0.1,
        max_tokens: options?.max_tokens ?? 2048,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error (${response.status}): ${error}`);
    }

    const data = await response.json() as GroqChatResponse;

    if (!data.choices || data.choices.length === 0) {
      throw new Error('Groq returned no choices');
    }

    return data.choices[0].message.content;
  }

  /**
   * Check if Groq API is accessible
   */
  async healthCheck(): Promise<{ healthy: boolean; info?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        return { healthy: false, info: `API returned ${response.status}` };
      }

      return { healthy: true, info: `Using model: ${this.model}` };
    } catch (err) {
      return { healthy: false, info: (err as Error).message };
    }
  }
}

/**
 * Available Groq models (as of Nov 2025)
 */
export const GROQ_MODELS = {
  // Production text models
  'llama-3.3-70b-versatile': { context: 131072, speed: '280 t/s', quality: 'best' },
  'llama-3.1-8b-instant': { context: 131072, speed: '560 t/s', quality: 'fast' },

  // Vision models (preview)
  'meta-llama/llama-4-scout-17b-16e-instruct': { context: 131072, speed: 'fast', quality: 'vision', vision: true },
  'meta-llama/llama-4-maverick-17b-128e-instruct': { context: 131072, speed: 'fast', quality: 'vision+', vision: true },
} as const;

export type GroqModelId = keyof typeof GROQ_MODELS;

/**
 * Whisper speech-to-text models available on Groq
 * Cost: $0.04/hour of audio
 */
export const WHISPER_MODELS = {
  'whisper-large-v3-turbo': { speed: '216x realtime', quality: 'best', languages: 'all' },
  'whisper-large-v3': { speed: 'fast', quality: 'high', languages: 'all' },
  'distil-whisper-large-v3-en': { speed: 'fastest', quality: 'good', languages: 'english-only' },
} as const;

export type WhisperModelId = keyof typeof WHISPER_MODELS;

interface TranscriptionResponse {
  text: string;
}

/**
 * Transcribe audio using Groq's Whisper API
 *
 * @param audioBuffer - Audio data as Buffer
 * @param filename - Original filename (helps API detect format)
 * @param apiKey - Groq API key
 * @param model - Whisper model to use (default: whisper-large-v3-turbo)
 * @param language - Optional language hint (ISO-639-1, e.g., 'en')
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
  apiKey: string,
  model: WhisperModelId = 'whisper-large-v3-turbo',
  language?: string
): Promise<string> {
  const formData = new FormData();

  // Create a Blob from the buffer for FormData
  const blob = new Blob([audioBuffer], { type: getMimeType(filename) });
  formData.append('file', blob, filename);
  formData.append('model', model);
  formData.append('response_format', 'json');

  if (language) {
    formData.append('language', language);
  }

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Groq Whisper API error (${response.status}): ${error}`);
  }

  const data = await response.json() as TranscriptionResponse;
  return data.text;
}

/**
 * Get MIME type from filename extension
 */
function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeTypes: Record<string, string> = {
    'mp3': 'audio/mpeg',
    'mp4': 'audio/mp4',
    'm4a': 'audio/mp4',
    'wav': 'audio/wav',
    'webm': 'audio/webm',
    'ogg': 'audio/ogg',
    'flac': 'audio/flac',
    'mpeg': 'audio/mpeg',
    'mpga': 'audio/mpeg',
  };
  return mimeTypes[ext || ''] || 'audio/webm';
}
