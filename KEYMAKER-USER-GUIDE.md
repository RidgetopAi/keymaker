# Keymaker User Guide

## Quick Start

Keymaker is a personal memory system that stores your observations and helps you recall them intelligently using various query modes.

### Installation Requirements

1. **PostgreSQL** with pgvector extension
2. **Ollama** with these models:
   - `nomic-embed-text` (for embeddings)
   - `llama3.2:3b` (for synthesis)
3. **Node.js** 18+ and npm

### Basic Setup

```bash
# Create database (if not exists)
createdb keymaker_dev

# Load schema
psql keymaker_dev < schema/mvk.sql

# Install dependencies
npm install

# Verify Ollama is running
ollama list

# Test the system
npm run keymaker stats
```

---

## Core Commands

### 📝 Store Observations

```bash
npm run keymaker observe "your observation here"
```

Store any thought, meeting note, decision, commitment, or reflection. The system will automatically generate embeddings for semantic search.

**Examples:**
```bash
npm run keymaker observe "Had coffee with Sarah about the Q1 roadmap"
npm run keymaker observe "Decided to delay the feature launch by 2 weeks"
npm run keymaker observe "I work best in the mornings before 10am"
npm run keymaker observe "Promised Marcus I'd review the API design by Friday"
```

### 🔍 Query Your Memory

```bash
npm run keymaker query "your question"
```

Ask questions and get synthesized answers based on relevant observations.

**Examples:**
```bash
npm run keymaker query "Who is Sarah?"
npm run keymaker query "What did I promise this week?"
npm run keymaker query "What am I stressed about?"
npm run keymaker query "How do I work best?"
```

### 📋 List Recent Observations

```bash
npm run keymaker list [count]
```

View your most recent observations. Default shows 10.

**Examples:**
```bash
npm run keymaker list        # Show 10 most recent
npm run keymaker list 20     # Show 20 most recent
```

---

## Advanced Query Modes

### 🤝 Extract Commitments

```bash
npm run keymaker commits
```

Extracts all promises, commitments, and tasks you've mentioned. Shows:
- What was committed to
- Who it was made to
- When it was made
- Status (if inferrable)

### 🧭 Deep Topic Analysis

```bash
npm run keymaker about "topic"
```

Get comprehensive synthesis about any topic, person, or project. More thorough than `query`.

**Examples:**
```bash
npm run keymaker about "Sarah"
npm run keymaker about "the project"
npm run keymaker about "my work patterns"
```

### 👥 People Directory

```bash
npm run keymaker people
```

Extracts all people mentioned across your observations with:
- Their roles and relationships
- What you know about them
- Interactions and commitments

### 🎯 Decision Tracker

```bash
npm run keymaker decisions
```

Lists all decisions found in your observations with:
- What was decided
- Who was involved
- Reasoning and trade-offs
- Outcomes or next steps

### 📅 Timeline Narrative

```bash
npm run keymaker timeline
```

Builds a chronological narrative showing:
- How events unfolded over time
- Cause-and-effect relationships
- Turning points and patterns
- Connections across time

### 📊 Memory Statistics

```bash
npm run keymaker stats
```

Shows:
- Total observations stored
- Date range of observations
- Recent activity (last 7 days)

### 🔮 Proactive Surfacing

```bash
npm run keymaker surface
```

Scans all your observations and proactively surfaces things you should know about:
- **Commitments & Deadlines** - Promises that might be overdue
- **Tensions & Contradictions** - Conflicting statements or intentions
- **Patterns** - Recurring themes or behaviors
- **Connections** - Related observations you might not have noticed

**Recommended use:** Run this each morning to see what needs your attention.

---

## Performance Benchmarking

### Run Performance Tests

```bash
npx tsx scripts/benchmark.ts
```

This will:
- Test query performance at current scale
- Add 50 synthetic observations
- Re-test performance at new scale
- Show storage statistics
- Test different retrieval counts

**Expected Performance:**
- Average query time: 15-25ms
- Scales linearly to thousands of observations
- Storage: ~3KB per observation

---

## Tips for Effective Use

### What to Observe

✅ **Good observations:**
- Specific events: "Met with Sarah about API design, she suggested REST over GraphQL"
- Commitments: "Promised to deliver the report by Friday 3pm"
- Decisions: "Decided to use PostgreSQL instead of MongoDB for better consistency"
- Patterns: "I'm most creative in the early morning"
- Reflections: "The presentation went well, but I need to prepare demos earlier"

❌ **Less useful observations:**
- Too vague: "Had a meeting"
- No context: "Sarah said something important"
- Pure tasks: "TODO: write code" (use a task manager instead)

### Query Strategies

1. **Start broad, then narrow:**
   ```bash
   npm run keymaker about "the project"  # Get overview
   npm run keymaker query "What are the technical decisions?"  # Specific aspect
   ```

2. **Use different modes for different needs:**
   - `query` for quick questions
   - `about` for comprehensive summaries
   - `commits` for tracking promises
   - `timeline` for understanding evolution

3. **Be specific in queries:**
   - ✅ "What did Sarah say about the timeline?"
   - ❌ "What about Sarah?"

### Privacy and Security

- All data is stored locally in your PostgreSQL database
- Embeddings are generated locally via Ollama
- No data is sent to cloud services
- Backup your database regularly: `pg_dump keymaker_dev > backup.sql`

---

## Troubleshooting

### "Embedding failed: Service Unavailable"
Ollama is not running. Start it with:
```bash
ollama serve
```

### "No observations found"
The database is empty. Add some observations:
```bash
npm run keymaker observe "Your first observation"
```

### Slow query performance
If queries exceed 100ms with many observations:
1. Check if Ollama is running locally (not in Docker)
2. Consider creating an index (see schema/mvk.sql)
3. Reduce retrieval limit in queries

### Database connection errors
Check PostgreSQL is running:
```bash
psql -d keymaker_dev -c "SELECT 1"
```

---

## Architecture Overview

```
┌─────────────────┐
│  User Input     │
└────────┬────────┘
         │
    ┌────▼────┐
    │ Observe │ ──► Text + Timestamp
    └────┬────┘
         │
    ┌────▼────┐
    │  Embed  │ ──► 768-dimension vector (nomic-embed-text)
    └────┬────┘
         │
    ┌────▼────────┐
    │  PostgreSQL │ ──► Stored with pgvector
    └─────────────┘
         │
    ┌────▼────┐
    │  Query  │ ──► Semantic similarity search
    └────┬────┘
         │
    ┌────▼──────┐
    │ Synthesize │ ──► LLM generates answer (llama3.2:3b)
    └───────────┘
```

### Query Modes = Different Prompts

All query modes use the same storage but different LLM prompts:
- **query**: "Answer this question based on observations"
- **about**: "Provide comprehensive summary about this topic"
- **surface**: "Proactively surface commitments, tensions, patterns"
- **commits**: "Extract all commitments and promises"
- **people**: "List all people mentioned"
- **decisions**: "Extract all decisions made"
- **timeline**: "Create chronological narrative"

---

## Future Capabilities

These features are designed but not yet implemented:

### Memory Management (Priority 1)
- `delete <id>` - Remove specific observation
- `forget "topic"` - Soft delete related observations
- `update <id>` - Edit observation content

### Time Filtering (Priority 2)
- `recent 24h` - Last 24 hours
- `today` - Today's observations
- `range <start> <end>` - Date range queries

### Extended Proactive Features (Priority 3)
- `overdue` - Focus specifically on overdue commitments
- `patterns` - Deep analysis of recurring behaviors
- `contradictions` - Explicit contradiction detection

---

## Contributing

When adding new features:

1. **New Query Modes**: Add to `src/cli.ts` following the pattern:
   ```typescript
   async function newMode(): Promise<void> {
     // Get observations
     // Build context
     // Craft specific prompt
     // Generate and display
   }
   ```

2. **Update Documentation**:
   - Add command to this guide
   - Update help text in `cli.ts`
   - Add example usage

3. **Test Performance**: Run benchmark after changes:
   ```bash
   npx tsx scripts/benchmark.ts
   ```

---

## Support

For issues or questions about Keymaker:
1. Check the troubleshooting section above
2. Review recent handoffs in Mandrel: `context_search("keymaker-handoff")`
3. See the experiment documentation in CLAUDE.md

---

*Last updated: 2025-11-23 by Instance #11 (Sonnet 4.5) - Added surface command*