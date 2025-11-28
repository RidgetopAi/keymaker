/**
 * Entity Resolution Service
 *
 * Three-stage algorithm from Instance #3:
 * 1. Exact name match (confidence 0.99)
 * 2. Fuzzy match via pg_trgm (similarity > 0.8)
 * 3. Semantic similarity on embeddings (> 0.7)
 */

import { Pool } from 'pg';
import { OllamaClient } from './ollama-client';
import { EntityResolutionResult, ExtractedEntity } from './types';

export class EntityResolver {
  private db: Pool;
  private ollama: OllamaClient;

  constructor(db: Pool, ollama: OllamaClient) {
    this.db = db;
    this.ollama = ollama;
  }

  /**
   * Resolve an extracted entity against the database
   */
  async resolve(entity: ExtractedEntity): Promise<EntityResolutionResult> {
    const tableName = this.getTableName(entity.type);

    // Stage 1: Exact match
    const exactMatch = await this.exactMatch(tableName, entity.name);
    if (exactMatch) {
      return {
        matched_id: exactMatch,
        confidence: 0.99,
        match_type: 'exact',
        needs_review: false,
      };
    }

    // Stage 2: Fuzzy match (pg_trgm)
    const fuzzyMatch = await this.fuzzyMatch(tableName, entity.name);
    if (fuzzyMatch && fuzzyMatch.similarity > 0.8) {
      return {
        matched_id: fuzzyMatch.id,
        confidence: fuzzyMatch.similarity,
        match_type: 'fuzzy',
        needs_review: false,
      };
    }

    // Stage 3: Semantic similarity
    const embedding = await this.ollama.embed(entity.name);
    const semanticMatch = await this.semanticMatch(tableName, embedding);

    if (semanticMatch && semanticMatch.similarity > 0.7) {
      return {
        matched_id: semanticMatch.id,
        confidence: semanticMatch.similarity,
        match_type: 'semantic',
        needs_review: semanticMatch.similarity < 0.8,
      };
    }

    // No match found - needs review if in ambiguous range
    const needsReview = !!(fuzzyMatch && fuzzyMatch.similarity > 0.5);

    return {
      matched_id: null,
      confidence: fuzzyMatch?.similarity ?? 0,
      match_type: 'new',
      needs_review: needsReview,
    };
  }

  private getTableName(type: string): string {
    const mapping: Record<string, string> = {
      person: 'entities_people',
      project: 'entities_projects',
      commitment: 'entities_commitments',
      concept: 'entities_concepts',
    };
    return mapping[type] ?? 'entities_concepts';
  }

  private async exactMatch(table: string, name: string): Promise<string | null> {
    const nameColumn = table === 'entities_people' ? 'canonical_name' : 'name';
    const result = await this.db.query(
      `SELECT id FROM ${table} WHERE LOWER(${nameColumn}) = LOWER($1) LIMIT 1`,
      [name]
    );
    return result.rows[0]?.id ?? null;
  }

  private async fuzzyMatch(
    table: string,
    name: string
  ): Promise<{ id: string; similarity: number } | null> {
    const nameColumn = table === 'entities_people' ? 'canonical_name' : 'name';
    const result = await this.db.query(
      `SELECT id, similarity(${nameColumn}, $1) as sim
       FROM ${table}
       WHERE similarity(${nameColumn}, $1) > 0.3
       ORDER BY sim DESC
       LIMIT 1`,
      [name]
    );
    if (result.rows[0]) {
      return { id: result.rows[0].id, similarity: result.rows[0].sim };
    }
    return null;
  }

  private async semanticMatch(
    table: string,
    embedding: number[]
  ): Promise<{ id: string; similarity: number } | null> {
    const result = await this.db.query(
      `SELECT id, 1 - (embedding <=> $1::vector) as similarity
       FROM ${table}
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [JSON.stringify(embedding)]
    );
    if (result.rows[0]) {
      return { id: result.rows[0].id, similarity: result.rows[0].similarity };
    }
    return null;
  }
}
