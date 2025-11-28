/**
 * Main extraction pipeline
 *
 * Orchestrates the full extraction flow:
 * Observation → Entities → Events → Beliefs → Integration
 */

import { Pool } from 'pg';
import { OllamaClient, defaultOllamaConfig } from './ollama-client';
import { ExtractionResult } from './types';

export class ExtractionPipeline {
  private db: Pool;
  private ollama: OllamaClient;

  constructor(db: Pool, ollamaConfig = defaultOllamaConfig) {
    this.db = db;
    this.ollama = new OllamaClient(ollamaConfig);
  }

  /**
   * Process a raw observation through the full extraction pipeline
   */
  async process(observationId: string): Promise<ExtractionResult> {
    const startTime = Date.now();

    // 1. Fetch the observation
    const observation = await this.fetchObservation(observationId);
    if (!observation) {
      throw new Error(`Observation not found: ${observationId}`);
    }

    // 2. Extract entities
    const entities = await this.extractEntities(observation.raw_content);

    // 3. Extract events
    const events = await this.extractEvents(observation.raw_content);

    // 4. Extract beliefs
    const beliefs = await this.extractBeliefs(observation.raw_content);

    // 5. Resolve entities against existing database
    // TODO: Implement entity resolution

    // 6. Detect contradictions with existing beliefs
    // TODO: Implement contradiction detection

    // 7. Write to database
    // TODO: Implement database integration

    const duration = Date.now() - startTime;

    return {
      observation_id: observationId,
      entities,
      events,
      beliefs,
      extraction_metadata: {
        model: 'llama3.2:3b',
        duration_ms: duration,
        timestamp: new Date().toISOString(),
      },
    };
  }

  private async fetchObservation(id: string): Promise<{ raw_content: string } | null> {
    const result = await this.db.query(
      'SELECT raw_content FROM observations WHERE id = $1',
      [id]
    );
    return result.rows[0] ?? null;
  }

  private async extractEntities(content: string) {
    // TODO: Implement with EntityExtractor
    // Use prompts from Instance #3 design
    return [];
  }

  private async extractEvents(content: string) {
    // TODO: Implement with EventExtractor
    return [];
  }

  private async extractBeliefs(content: string) {
    // TODO: Implement with BeliefExtractor
    return [];
  }
}
