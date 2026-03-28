# Keymaker

**Personal Memory System** — crafts the right context for any situation

Keymaker is an intelligent, context-aware memory assistant that stores observations, extracts structured knowledge, and provides proactive insights. Think of it as a "second brain" that remembers everything you tell it and helps you recall information intelligently.

## Why Keymaker?

Traditional note-taking and personal knowledge tools suffer from the same problem: every query requires re-analyzing your entire history. Keymaker takes a different approach:

```
Traditional:  observe → store → (later) re-analyze ALL observations for every query
Keymaker:     observe → store → DIGEST into living summaries → queries read summaries
```

The result? Queries feel instant because the heavy lifting happens at write-time. It feels like talking to a friend who remembers, not searching a database.

## Features

### Core Capabilities
- **Observation Capture** — Store thoughts, notes, and life moments via text or voice
- **Semantic Search** — Find information by meaning, not just keywords
- **Living Summaries** — Six evolving summaries that stay up-to-date automatically:
  - **Commitments** — Promises, tasks, deadlines
  - **People** — Relationships and recent interactions
  - **Projects** — Active work and goals
  - **Tensions** — Concerns, conflicts, open loops
  - **Mood** — Emotional patterns and energy
  - **Narrative** — Identity, values, personal growth

### Intelligence Layer
- **Entity Extraction** — Automatically identifies people, projects, commitments, and beliefs
- **Contradiction Detection** — Spots conflicting beliefs or statements
- **Proactive Surfacing** — Alerts you to overdue items, patterns, and insights
- **LLM Synthesis** — Answers questions using your personal context

### Temporal Memory
- **Monthly Snapshots** — Freeze summaries to remember "how things were"
- **Time Travel** — Query past states: "How did I feel in October?"
- **Reflection** — Generate narratives about personal evolution over time

### Integrations
- **Voice Input** — Speak observations via Groq Whisper transcription
- **Calendar Sync** — Commitments with times sync to CalDAV (Radicale)
- **Chat Interface** — Natural conversation with intent detection

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 15+ with pgvector extension
- [Ollama](https://ollama.ai) (for local embeddings)
- [Groq API key](https://groq.com) (for fast LLM inference)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/keymaker.git
cd keymaker

# Install dependencies
npm install

# Set up the database
createdb keymaker_dev
psql keymaker_dev < schema/mvk.sql

# Start Ollama and pull the embedding model
ollama serve
ollama pull nomic-embed-text

# Configure environment
cp deploy/.env.template .env
# Edit .env with your GROQ_API_KEY

# Run the CLI
npm run keymaker observe "My first observation"
npm run keymaker query "What did I just say?"

# Or start the web UI
npm run serve
# Open http://localhost:3001
```

## Usage

### CLI Commands

```bash
# Core operations
keymaker observe "Had coffee with Sarah about the Q1 roadmap"
keymaker query "What did Sarah say about the timeline?"
keymaker list 20

# Living summaries (instant reads)
keymaker commits     # Current commitments
keymaker people      # People you know
keymaker projects    # Active projects
keymaker tensions    # Open loops and concerns
keymaker mood        # Recent emotional patterns
keymaker self        # Identity and values

# Entities
keymaker entities    # All extracted entities
keymaker who "John"  # Semantic person search

# Temporal features
keymaker snapshot november   # Take a monthly snapshot
keymaker recall oct mood     # Remember past state
keymaker compare oct nov narrative  # Compare periods
keymaker reflect 6           # 6-month reflection

# Proactive features
keymaker surface     # Get surfaced insights
keymaker consolidate # Weekly memory consolidation
```

### Web UI

The mobile-first web interface provides:
- **Now** — Identity card, weekly digest, quick capture
- **Chat** — Conversational interface with voice input
- **Timeline** — Browse monthly snapshots
- **Entities** — Explore people, projects, commitments
- **Search** — Semantic search with time filters

### API

40+ REST endpoints for programmatic access:

```bash
# Store an observation
curl -X POST http://localhost:3001/api/observe \
  -H "Content-Type: application/json" \
  -d '{"content": "Meeting with the team about roadmap"}'

# Query with synthesis
curl -X POST http://localhost:3001/api/query \
  -H "Content-Type: application/json" \
  -d '{"question": "What are my current priorities?"}'

# Get living summaries
curl http://localhost:3001/api/summaries

# Get schedule
curl http://localhost:3001/api/schedule?days=7
```

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Observations   │────▶│   Digestion  │────▶│ Living Summaries│
│  (raw input)    │     │   Service    │     │  (6 categories) │
└─────────────────┘     └──────────────┘     └─────────────────┘
        │                                            │
        │               ┌──────────────┐             │
        └──────────────▶│   Entity     │             │
                        │  Extraction  │             │
                        └──────────────┘             │
                               │                     │
                        ┌──────▼──────┐      ┌───────▼───────┐
                        │  Entities   │      │    Queries    │
                        │ People,     │      │ (instant via  │
                        │ Projects,   │      │  summaries)   │
                        │ Commitments │      └───────────────┘
                        └─────────────┘
```

### Key Design Decisions

1. **Write-time processing** — Observations are digested immediately, making reads instant
2. **Dual LLM providers** — Groq for fast generation, Ollama for free local embeddings
3. **Entity resolution** — Fuzzy matching prevents duplicate people/projects
4. **One-way calendar sync** — Keymaker is source of truth, calendar is notification layer
5. **Background processing** — User gets immediate feedback while extraction runs async

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 18+ with TypeScript |
| API | Express.js |
| Database | PostgreSQL + pgvector |
| LLM (generation) | Groq API (llama-3.3-70b) |
| Embeddings | Ollama (nomic-embed-text, 768-dim) |
| Speech-to-text | Groq Whisper |
| Calendar | Radicale CalDAV |
| Frontend | Vanilla JavaScript, mobile-first PWA |

## Configuration

```bash
# Required
DATABASE_URL=postgresql://user@localhost:5432/keymaker_production
GROQ_API_KEY=gsk_...

# Optional
KEYMAKER_TOKEN=your-api-token  # Enable authentication
OLLAMA_URL=http://localhost:11434

# Calendar (optional)
CALDAV_URL=http://127.0.0.1:5232
CALDAV_USER=your-username
CALDAV_PASS=your-password
CALDAV_CALENDAR=/user/keymaker/
```

## Production Deployment

See [deploy/DEPLOY.md](deploy/DEPLOY.md) for VPS deployment with:
- systemd service configuration
- Nginx reverse proxy with SSL
- PostgreSQL setup
- Radicale CalDAV server

## Project Structure

```
keymaker/
├── src/
│   ├── api/server.ts          # Express REST API (40+ endpoints)
│   ├── cli.ts                 # Command-line interface
│   └── services/
│       ├── digest.ts          # Living summaries engine
│       ├── consolidation.ts   # Memory consolidation
│       ├── snapshots.ts       # Temporal snapshots
│       ├── calendar.ts        # CalDAV integration
│       ├── chat/              # Chat interface + intent detection
│       └── extraction/        # Entity extraction pipeline
├── schema/                    # PostgreSQL schema + migrations
├── public/                    # Mobile-first web UI (PWA)
├── deploy/                    # Deployment configs
└── docs/                      # Additional documentation
```

## Data Privacy

- All observations stored locally in your PostgreSQL database
- Embeddings generated locally via Ollama (zero cost, no data leaves your machine)
- Only LLM synthesis prompts go to Groq API — observation content stays local
- Optional token-based API authentication
- You control your data completely

## License

MIT

---

*Keymaker: Because your memories deserve better than flat files and keyword search.*
