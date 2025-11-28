/**
 * Type definitions for the extraction service
 */

export interface ExtractedEntity {
  type: 'person' | 'project' | 'commitment' | 'concept';
  name: string;
  aliases?: string[];
  metadata: Record<string, unknown>;
  confidence: number;
}

export interface ExtractedPerson extends ExtractedEntity {
  type: 'person';
  relationship_to_brian?: string;
  trust_level?: number;
}

export interface ExtractedProject extends ExtractedEntity {
  type: 'project';
  status?: 'active' | 'paused' | 'completed' | 'abandoned' | 'unknown';
  goal?: string;
}

export interface ExtractedCommitment extends ExtractedEntity {
  type: 'commitment';
  description: string;
  due_date?: string;
  event_time?: string;
  duration_minutes?: number;
  location?: string;
  add_to_calendar?: boolean;
  committed_to?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'abandoned';
}

export interface ExtractedConcept extends ExtractedEntity {
  type: 'concept';
  concept_type: 'preference' | 'belief' | 'constraint' | 'principle';
}

export interface ExtractedEvent {
  type: string;
  summary: string;
  occurred_at?: string;
  participants: string[];
  outcome?: string;
  followup_required: boolean;
  confidence: number;
}

export interface ExtractedBelief {
  subject: string;
  statement: string;
  belief_type: 'fact' | 'preference' | 'constraint' | 'intention' | 'state';
  confidence: number;
  is_temporary: boolean;
  source_entity?: string;
}

export interface ExtractionResult {
  observation_id: string;
  entities: ExtractedEntity[];
  events: ExtractedEvent[];
  beliefs: ExtractedBelief[];
  extraction_metadata: {
    model: string;
    duration_ms: number;
    timestamp: string;
  };
}

export interface EntityResolutionResult {
  matched_id: string | null;
  confidence: number;
  match_type: 'exact' | 'fuzzy' | 'semantic' | 'new';
  needs_review: boolean;
}

export interface OllamaConfig {
  host: string;
  port: number;
  model: string;
  embedding_model: string;
  num_thread?: number;
  keep_alive?: string | number;
  num_ctx?: number;
}
