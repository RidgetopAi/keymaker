# Keymaker Codebase Review - Comprehensive Documentation

**Review Date:** December 2024  
**Reviewer:** AI Code Analysis  
**Codebase Version:** Production (deployed to hetzner-vps:/opt/keymaker)

---

## Executive Summary

Keymaker is a **Personal Memory System** that stores observations about Brian's life, automatically extracts structured knowledge, and provides intelligent recall through living summaries. The core architectural innovation is **write-time digestion** — instead of re-analyzing all observations on every query, Keymaker maintains six evolving "living summaries" that are updated immediately when observations are added.

### Key Architecture Highlights

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Node.js 18+ / TypeScript | Fast, async processing |
| Database | PostgreSQL + pgvector | Vector search + relational |
| LLM (generation) | **Groq API (llama-3.3-70b-versatile)** | Fast cloud inference |
| Embeddings | Ollama (nomic-embed-text, 768-dim) | Free, local, zero-cost |
| Speech-to-text | Groq Whisper | Voice observations |
| Calendar | Radicale CalDAV | Time-based events |
| Frontend | Vanilla JS PWA | Mobile-first UI |

---

## 1. Database Schema Deep Dive

### 1.1 Core Tables

#### `observations` — The Raw Input Layer
```sql
CREATE TABLE observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding vector(768),                    -- nomic-embed-text dimension
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  
  -- Processing state
  processing_status VARCHAR(50) DEFAULT 'pending',
  processed_at TIMESTAMP,
  processing_errors TEXT[],
  
  -- Extraction results (populated by entity-extractor)
  extracted_entities JSONB,
  extracted_beliefs JSONB,
  extracted_events JSONB,
  
  -- Consolidation tracking
  staleness_score FLOAT DEFAULT 0,          -- 0=fresh, 1=very stale
  last_consolidated_at TIMESTAMPTZ
);
```

**Key Design Decisions:**
- Observations are **immutable** — never modified after creation
- 768-dimension embeddings match nomic-embed-text (changed from OpenAI's 1536)
- `staleness_score` is updated during weekly consolidation

#### `distilled_state` — The 6 Living Summaries
```sql
CREATE TABLE distilled_state (
  key TEXT PRIMARY KEY,                     -- 'commitments', 'people', etc.
  content TEXT NOT NULL,                    -- The living document
  last_observation_id UUID,
  observation_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seeded categories:
-- 'commitments' - Promises, tasks, deadlines
-- 'people'      - Relationships, recent interactions  
-- 'projects'    - Active work and goals
-- 'tensions'    - Concerns, conflicts, open loops
-- 'mood'        - Emotional patterns and energy
-- 'narrative'   - Identity, values, personal growth
```

**This is THE architectural breakthrough** — queries read from these pre-digested summaries instead of re-analyzing all observations.

### 1.2 Entity Registry Tables

#### `entities_people`
```sql
CREATE TABLE entities_people (
  id UUID PRIMARY KEY,
  canonical_name VARCHAR(255) NOT NULL UNIQUE,
  aliases TEXT[],                           -- ["Sarah", "S.Chen", "Dr. Chen"]
  relationship_type VARCHAR(100),           -- friend, colleague, family
  interaction_frequency VARCHAR(50),        -- daily, weekly, monthly
  trust_level FLOAT DEFAULT 0.5,
  context_summary TEXT,
  embedding vector(768),
  confidence FLOAT DEFAULT 0.5,
  first_seen TIMESTAMP,
  last_seen TIMESTAMP
);
```

#### `entities_projects`
```sql
CREATE TABLE entities_projects (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  code_name VARCHAR(100),
  status VARCHAR(50) DEFAULT 'active',      -- active, paused, completed
  description TEXT,
  goals TEXT[],
  priority VARCHAR(20),                     -- critical, high, medium, low
  embedding vector(768),
  stakeholder_ids UUID[],
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);
```

#### `entities_commitments`
```sql
CREATE TABLE entities_commitments (
  id UUID PRIMARY KEY,
  description TEXT NOT NULL,
  commitment_type VARCHAR(50),              -- 'meeting' or 'deliverable'
  committed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  due_date TIMESTAMP,                       -- For tasks without specific time
  event_time TIMESTAMPTZ,                   -- For calendar events with time
  duration_minutes INTEGER,
  location TEXT,
  status VARCHAR(50) DEFAULT 'open',        -- open, in_progress, completed
  
  -- Calendar integration
  synced_to_calendar BOOLEAN DEFAULT FALSE,
  caldav_uid TEXT,                          -- 'keymaker-commitment-{id}@keymaker'
  
  -- Relationships
  committed_to UUID,                        -- FK to entities_people
  project_id UUID REFERENCES entities_projects(id),
  
  embedding vector(768)
);
```

### 1.3 Belief & Contradiction Tracking

#### `beliefs`
```sql
CREATE TABLE beliefs (
  id UUID PRIMARY KEY,
  statement TEXT NOT NULL,                  -- "Brian prefers morning meetings"
  belief_type VARCHAR(50),                  -- fact, preference, constraint, goal
  confidence FLOAT DEFAULT 0.5,
  source_type VARCHAR(50),                  -- observation, explicit, inferred
  source_id UUID,                           -- Link to observation
  valid_from TIMESTAMP DEFAULT NOW(),
  valid_until TIMESTAMP,                    -- NULL = currently valid
  is_active BOOLEAN DEFAULT TRUE,
  superseded_by UUID REFERENCES beliefs(id),
  embedding vector(768)
);
```

#### `contradictions`
```sql
CREATE TABLE contradictions (
  id UUID PRIMARY KEY,
  belief_a_id UUID REFERENCES beliefs(id),
  belief_b_id UUID REFERENCES beliefs(id),
  contradiction_type VARCHAR(50),           -- direct, temporal, value, behavioral
  severity VARCHAR(20),                     -- minor, moderate, major, critical
  detection_method VARCHAR(50),             -- semantic_embedding, rule_based
  detection_confidence FLOAT,
  explanation TEXT,
  resolution_status VARCHAR(50) DEFAULT 'unresolved',
  dominant_belief_id UUID,
  
  CONSTRAINT unique_belief_pair UNIQUE(belief_a_id, belief_b_id),
  CHECK (belief_a_id < belief_b_id)         -- Prevent duplicate pairs
);
```

### 1.4 Temporal Memory Tables

#### `living_summary_snapshots`
```sql
CREATE TABLE living_summary_snapshots (
  id UUID PRIMARY KEY,
  category TEXT NOT NULL,                   -- Same 6 categories as distilled_state
  content TEXT NOT NULL,
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  observation_count INTEGER,
  key_observations JSONB,                   -- [{id, date, summary}]
  snapshot_taken_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT unique_monthly_snapshot UNIQUE(category, period_year, period_month)
);
```

Enables temporal queries like "How was I feeling in October?" or "Compare Nov vs Dec mood".

#### `consolidation_log`
```sql
CREATE TABLE consolidation_log (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  patterns_detected INTEGER DEFAULT 0,
  stale_items_faded INTEGER DEFAULT 0,
  strengthened_items INTEGER DEFAULT 0,
  weekly_digest TEXT,
  pattern_details JSONB,
  duration_ms INTEGER
);
```

### 1.5 Chat Session Tables

```sql
CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY,
  created_at TIMESTAMP DEFAULT NOW(),
  last_activity TIMESTAMP DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  intent VARCHAR(50),                       -- query, observation, update, clarification
  intent_confidence FLOAT,
  action_taken JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 2. Entity Extraction System

### 2.1 Extraction Pipeline Overview

The entity extraction runs **automatically after digestion** for every observation. It uses Groq's llama-3.3-70b for fast inference.

**Location:** `src/services/extraction/entity-extractor.ts`

### 2.2 What Gets Extracted

| Type | Fields Extracted | Storage Table |
|------|------------------|---------------|
| **People** | name, relationship_to_brian, context, confidence | `entities_people` |
| **Projects** | name, status, goal, confidence | `entities_projects` |
| **Commitments** | description, committed_to, due_date, event_time, duration_minutes, location, add_to_calendar, status | `entities_commitments` |
| **Beliefs** | subject, statement, belief_type, is_temporary, confidence | `beliefs` |

### 2.3 Extraction Prompts (llama-3.3-70b)

#### People Extraction Prompt
```
Extract all people mentioned in this observation. Return valid JSON only.

Observation: "${content}"

Return a JSON array of people. For each person include:
- name: their full name or how they're referred to
- relationship_to_brian: their role/relationship (colleague, friend, family, client, etc.)
- context: any relevant context about this person from the observation
- confidence: 0.0-1.0 how confident you are this is a real person

If no people are mentioned, return: []
JSON array only, no explanation:
```

#### Commitments Extraction Prompt (with date context)
```
Extract all commitments, promises, scheduled events, or tasks Brian has made. Return valid JSON only.

IMPORTANT - Current date/time: ${currentDateTime}
Use this to correctly interpret relative dates like "tomorrow", "this Saturday", etc.

Observation: "${content}"

Return a JSON array of commitments. For each commitment include:
- description: what was promised/committed/scheduled
- committed_to: who the commitment was made to (if mentioned)
- due_date: deadline date if mentioned, in YYYY-MM-DD format
- event_time: specific datetime if scheduled, in ISO 8601 format with timezone
- duration_minutes: how long the event lasts (default to 60 for meetings)
- location: where it takes place
- add_to_calendar: true if Brian explicitly said "add to calendar"
- status: pending, in_progress, completed, or unknown
- confidence: 0.0-1.0

CRITICAL: Date parsing rules (assume Eastern Time):
- "tomorrow" = the day after ${currentDateTime.split(',')[0]}
- "this Saturday" = the upcoming Saturday from today
- "next Saturday" = the Saturday AFTER this upcoming Saturday
...
```

#### Beliefs Extraction Prompt
```
Extract any facts, preferences, or beliefs about Brian from this observation. Return valid JSON only.

Observation: "${content}"

Return a JSON array. For each belief include:
- subject: what/who this belief is about
- statement: the belief/fact/preference
- belief_type: fact, preference, constraint, intention, or state
- is_temporary: true if this is a temporary state, false if enduring
- confidence: 0.0-1.0 confidence level

If no beliefs can be extracted, return: []
```

### 2.4 Entity Resolution

Uses 3-stage algorithm:
1. **Exact match** (confidence 0.99) — case-insensitive name match
2. **Fuzzy match** (pg_trgm, similarity > 0.8) — handles typos, variations
3. **Semantic match** (embedding similarity > 0.7) — conceptual similarity

**Location:** `src/services/extraction/resolution.ts`

### 2.5 Contradiction Detection

When a new belief is stored:
1. Find semantically similar existing beliefs (embedding distance < 0.3)
2. For each similar belief, use LLM to check if they actually contradict
3. Store contradiction with type, severity, explanation

```typescript
const prompt = `Analyze whether these beliefs contradict:
Belief A: "${beliefA}"
Belief B: "${beliefB}"

Respond in JSON:
{
  "contradicts": true/false,
  "type": "direct" | "temporal" | "value" | "behavioral" | null,
  "severity": "minor" | "moderate" | "major" | "critical",
  "explanation": "brief explanation if contradicts"
}`;
```

---

## 3. Digestion System (Living Summaries)

**Location:** `src/services/digest.ts`

### 3.1 The Architectural Shift

```
Traditional:  observe → store → (later) re-analyze ALL observations for every query
Keymaker:     observe → store → DIGEST into living summaries → queries read summaries
```

### 3.2 Classification Prompt

When an observation comes in, first classify which categories it touches:

```
Analyze this personal observation and determine which categories it relates to.

Observation: "${content}"

Categories:
- commitments: promises, tasks, things to do, deadlines, ALSO anything marked done/paid/completed
- people: mentions of specific people, relationships, interactions
- projects: ongoing work, goals, initiatives, creative endeavors
- tensions: concerns, conflicts, contradictions, unresolved issues, worries
- mood: emotional states, energy levels, feelings, stress, happiness
- narrative: self-reflection, identity statements, values, personal growth, "I am..." statements

Return ONLY a comma-separated list of relevant categories (e.g., "commitments,people" or "none").
```

### 3.3 Category Update Prompts

#### Commitments Update
```
You maintain Brian's commitment tracker. Here's the current state and a new observation.

CURRENT COMMITMENTS:
${currentContent}

NEW OBSERVATION (${dateStr}):
${newObservation}

Update the commitments summary to incorporate any new, changed, or completed items.
Format: List each commitment with status (pending/completed/overdue if date passed), who it's to (if known), and when.
Keep items that weren't mentioned - they're still active unless explicitly completed.
Be concise. Only track real commitments, not vague intentions.

UPDATED COMMITMENTS:
```

#### People Update
```
You maintain Brian's relationship memory. Here's who he knows and a new observation.

CURRENT PEOPLE BRIAN KNOWS:
${currentContent}

NEW OBSERVATION (${dateStr}):
${newObservation}

Update the people summary to incorporate any new people, relationship changes, or recent interactions.
Format: List each person with their role/relationship, last known interaction, and any current context.
Keep people who weren't mentioned - they're still in Brian's life.

UPDATED PEOPLE:
```

#### Narrative (Self/Identity) Update
```
You maintain Brian's self-narrative - his understanding of who he is, what he values, and who he's becoming.

CURRENT SELF-NARRATIVE:
${currentContent}

NEW OBSERVATION (${dateStr}):
${newObservation}

Update the self-narrative to incorporate any identity-relevant insights:
- Values expressed or demonstrated
- Self-realizations ("I realized I'm the kind of person who...")  
- Beliefs about what matters
- Growth patterns or changes in perspective
- Life philosophy or principles
- The story Brian tells about himself

Format: A cohesive narrative paragraph (not a list) that captures who Brian is and is becoming.
Write in third person about Brian, capturing his authentic voice and values.

UPDATED SELF-NARRATIVE:
```

---

## 4. Weekly Consolidation ("Sleep" Process)

**Location:** `src/services/consolidation.ts`  
**Scheduled via:** `scripts/weekly-consolidate.sh`

### 4.1 Consolidation Steps

1. **Pattern Detection** — Analyze last 7 days of observations
2. **Memory Strengthening** — Reduce staleness of high-impact memories
3. **Stale Item Identification** — Mark old, low-impact observations as stale
4. **Weekly Digest Generation** — Create personalized weekly summary
5. **Monthly Snapshot** — Archive current state if new month

### 4.2 Pattern Detection Prompt

```
Analyze these recent observations from Brian's life and identify recurring patterns or themes.

OBSERVATIONS (Last 7 days):
${observations}

Identify 3-5 patterns. For each pattern, provide:
1. The pattern (a brief description)
2. How often it appears (rough count)
3. Which category it relates to (commitments/people/projects/tensions/mood/narrative)
4. Significance level (low/medium/high based on potential impact)

Format:
- Pattern: [description] | Frequency: [count] | Category: [cat] | Significance: [level]

Only list clear patterns. If none are obvious, say "No clear patterns detected."
```

### 4.3 Weekly Digest Prompt

```
Generate a brief weekly digest for Brian based on his memory system's current state.

CURRENT LIVING SUMMARIES:
${summaryText}

PATTERNS DETECTED THIS WEEK:
${patternText}

OBSERVATIONS THIS WEEK: ${weekCount}

Write a warm, personal 2-3 paragraph digest that:
1. Highlights what mattered most this week
2. Notes any emerging patterns or shifts
3. Gently surfaces anything that might need attention
4. Ends with a supportive reflection

Write as if you're a thoughtful friend who knows Brian well. Be concise but caring.

WEEKLY DIGEST:
```

### 4.4 Staleness Calculation

```sql
-- Staleness based on age and impact
staleness_score = 
  CASE 
    WHEN categories_touched = 0 THEN 0.9   -- No impact = very stale
    WHEN categories_touched = 1 THEN 0.5 + (age_days / 365)  -- Minor impact
    ELSE 0.3 + (age_days / 730)  -- Multi-category = important
  END
```

---

## 5. Chat System & Intent Detection

**Location:** `src/services/chat/`

### 5.1 Intent Categories

| Intent | Description | Example Triggers |
|--------|-------------|-----------------|
| `query` | User asking a question | "what's left?", "who is X?", starts with what/who/how |
| `observation` | Recording new information | "met with John today", statements about events |
| `update` | Marking something complete/changed | "finished", "done", "paid", "completed" |
| `clarification` | Input is ambiguous | Single word with no context |

### 5.2 Intent Detection Prompt

```
You are an intent classifier for a personal memory assistant.

INTENTS:
1. "query" - User is asking a question or requesting information
2. "observation" - User is recording a new fact, event, or thought
3. "update" - User is marking something as complete, changed, or updating existing information
4. "clarification" - The input is ambiguous and you need more information

RECENT CONVERSATION:
{recentMessages}

USER MESSAGE: {userMessage}

Respond with JSON only:
{
  "intent": "query" | "observation" | "update" | "clarification",
  "confidence": 0.0-1.0,
  "details": { ... },
  "reasoning": "brief explanation"
}
```

### 5.3 Chat Personality

```typescript
const BUDDY_SYSTEM_PROMPT = `You are Brian's memory buddy - a helpful friend who happens to have perfect recall.

Your personality:
- Warm and casual, like talking to a friend
- Brief but genuine - not robotic or corporate
- You care about Brian's life, not just his data
- Use natural language, occasional light humor when appropriate
- Be real with him - if you don't know something, just say so

Keep responses concise. Never sound like a generic AI assistant.`;
```

---

## 6. LLM Provider Architecture

**Location:** `src/services/extraction/`

### 6.1 Provider Strategy

| Task | Provider | Model | Why |
|------|----------|-------|-----|
| Text Generation | Groq | llama-3.3-70b-versatile | 280 tokens/sec, cloud speed |
| Embeddings | Ollama | nomic-embed-text (768-dim) | Free, local, zero API cost |
| Speech-to-text | Groq | whisper-large-v3-turbo | 216x realtime speed |

### 6.2 Configuration (via environment)

```bash
# Required
GROQ_API_KEY=gsk_...

# Optional (defaults shown)
LLM_PROVIDER=groq              # or 'ollama' for local-only
GROQ_MODEL=llama-3.3-70b-versatile
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_HOST=localhost
OLLAMA_PORT=11434
```

### 6.3 Factory Pattern

```typescript
// provider-factory.ts
export function getLLMProvider(): LLMProvider {
  if (config.provider === 'groq' && config.groq?.apiKey) {
    return new GroqClient({ apiKey, model: 'llama-3.3-70b-versatile' });
  }
  return new OllamaClient(config.ollama);
}

export function getEmbeddingProvider(): EmbeddingProvider {
  // Always Ollama — it's free and local
  return new OllamaClient(config.ollama);
}
```

---

## 7. Calendar Integration (CalDAV)

**Location:** `src/services/calendar.ts`

### 7.1 Architecture

- **Server:** Radicale (localhost:5232)
- **Calendar:** `/ridgetop/keymaker/`
- **Sync Direction:** One-way (Keymaker → CalDAV)
- **Trigger:** When `add_to_calendar: true` detected in extraction

### 7.2 Event Format

```typescript
interface CalendarEvent {
  uid: string;                              // keymaker-commitment-{id}@keymaker
  summary: string;
  dtstart: Date;
  dtend?: Date;
  location?: string;
  description?: string;
}
```

### 7.3 Sync Flow

1. User says "Meeting with Sarah tomorrow at 3pm, add to calendar"
2. Extraction detects `add_to_calendar: true`, `event_time: "2024-12-15T15:00:00-05:00"`
3. Commitment stored in `entities_commitments` with `synced_to_calendar = true`
4. ICS file PUT to CalDAV: `http://127.0.0.1:5232/ridgetop/keymaker/{uid}.ics`
5. `caldav_uid` stored in database for future updates/deletes

---

## 8. API Reference

### 8.1 Core Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Health check |
| `/api/observe` | POST | Store new observation |
| `/api/query` | POST | Semantic search + synthesis |
| `/api/list` | GET | List recent observations |
| `/api/surface` | GET | Get synthesized insights |

### 8.2 Living Summaries

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/summaries` | GET | All 6 living summaries |
| `/api/summaries/:category` | GET | Single category |
| `/api/rebuild` | POST | Rebuild summaries from scratch |

### 8.3 Entities

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/entities/people` | GET | List all people |
| `/api/entities/projects` | GET | List all projects |
| `/api/entities/commitments` | GET | Active commitments |
| `/api/entities/beliefs` | GET | Active beliefs |
| `/api/entities/contradictions` | GET | Unresolved contradictions |
| `/api/entities/people/search?q=` | GET | Semantic people search |
| `/api/schedule` | GET | Calendar-formatted commitments |

### 8.4 Temporal

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/temporal/snapshots` | GET | List available snapshots |
| `/api/temporal/month/:period` | GET | Full month snapshot |
| `/api/temporal/recall/:month/:category` | GET | Recall specific category |
| `/api/temporal/compare` | POST | Compare two periods |
| `/api/temporal/reflect` | GET | Generate evolution reflection |

### 8.5 Chat

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/chat/session` | POST | Create/resume session |
| `/api/chat/message` | POST | Send message, get response |
| `/api/chat/session/:id` | GET | Get session history |

---

## 9. CLI Commands

```bash
# Core
keymaker observe "text"       # Store observation
keymaker query "question"     # Search + synthesize
keymaker list [n]            # List recent

# Living Summaries (instant)
keymaker commits             # Current commitments
keymaker people              # People you know
keymaker projects            # Active projects
keymaker tensions            # Open loops
keymaker mood                # Emotional patterns
keymaker self                # Identity/narrative

# Entity Commands
keymaker entities            # All extracted entities
keymaker who "name"          # Semantic people search
keymaker extract-all         # Backfill extraction

# Temporal
keymaker snapshot [month]    # Take monthly snapshot
keymaker recall oct mood     # Recall October mood
keymaker compare oct nov     # Compare periods
keymaker reflect 6           # 6-month evolution

# Memory Management
keymaker rebuild [category]  # Rebuild summaries
keymaker consolidate         # Run weekly consolidation
keymaker digest              # Show last weekly digest
```

---

## 10. Deployment

### 10.1 Locations

| Environment | Location | Purpose |
|-------------|----------|---------|
| Development | `~/projects/keymaker/` | Local dev, git source of truth |
| Production | `hetzner-vps:/opt/keymaker/` | Running service |

### 10.2 Deployment Workflow

```bash
# 1. Make changes locally
# 2. Test
npm run type-check

# 3. Commit
git add .
git commit -m "Instance #N: [description]"

# 4. Push to both remotes
git push origin master      # GitHub (backup)
git push vps master         # VPS (deploy)

# 5. Restart service
ssh hetzner-vps "sudo systemctl restart keymaker"

# 6. Verify
ssh hetzner-vps "sudo journalctl -u keymaker -n 20"
```

### 10.3 Weekly Consolidation Cron

```bash
# /etc/cron.d/keymaker-consolidate
0 3 * * 0 root /opt/keymaker/scripts/weekly-consolidate.sh
```

---

## 11. Data Privacy

- All observations stored locally in your PostgreSQL
- Embeddings generated locally via Ollama (zero cost, no data leaves machine)
- Only LLM synthesis prompts go to Groq API
- Optional token-based API authentication via `KEYMAKER_TOKEN`

---

## 12. Key Files Reference

| File | Purpose |
|------|---------|
| `src/cli.ts` | Command-line interface, main entry point |
| `src/api/server.ts` | Express REST API (40+ endpoints) |
| `src/services/digest.ts` | Living summaries engine |
| `src/services/consolidation.ts` | Weekly memory consolidation |
| `src/services/snapshots.ts` | Temporal snapshot management |
| `src/services/calendar.ts` | CalDAV integration |
| `src/services/extraction/entity-extractor.ts` | Entity extraction pipeline |
| `src/services/extraction/provider-factory.ts` | LLM provider routing |
| `src/services/chat/chat-service.ts` | Conversational interface |
| `src/services/chat/intent-detector.ts` | Intent classification |
| `schema/mvk.sql` | Minimal viable schema |
| `schema/migrations/*.sql` | Schema migrations |

---

*Last updated: December 2024*
