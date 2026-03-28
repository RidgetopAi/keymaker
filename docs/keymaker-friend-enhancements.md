# Keymaker: From Robot to Friend

*Research notes from Instance #54 - November 30, 2025*

## The Problem

Keymaker currently feels like a robot:
- Waits to be asked
- Responses are informational, not relational
- No personality or warmth
- No back-and-forth dialogue
- Doesn't feel like a friend

**Goal**: A true partner/sidekick that opens doors. Not sycophantic, but warm. Has opinions. Pushes back sometimes.

---

## What We Already Have

**The Foundation:**
- Living Summaries (commitments, people, projects, tensions, mood, narrative)
- Entity extraction (people, projects, commitments, beliefs)
- Contradiction detection between beliefs
- Pattern detection during consolidation
- Temporal memory (snapshots, recall)
- Intent detection (query/observation/update/clarification)
- CalDAV calendar sync + voice input

**The Data Being Collected:**
- Who you know and interact with
- What you've committed to
- Your beliefs and when they conflict
- Your mood over time
- Your narrative/identity evolution
- Patterns in your behavior

**Key Insight**: The data is rich. The architecture is sound. What's missing isn't storage - it's how it communicates back.

---

## The Robot vs Friend Spectrum

```
Robot                                              Friend
├── Reactive only                    Proactive check-ins ──┤
├── Neutral tone                     Personality/warmth ──┤
├── Information dump                   Curated insights ──┤
├── No opinion                        Has perspective ──┤
├── Task-focused                  Relationship-focused ──┤
├── Formal                            Natural/casual ──┤
├── Never disagrees              Pushes back sometimes ──┤
```

Keymaker is currently on the left. Moving right doesn't require new data - it requires a new **interpretation and communication layer**.

---

## Features That Could Matter

### 1. Commitment Health (uses existing data)

Already tracking commitments and status. Add:
- Completion rate over time
- Average overdue duration
- Pattern of what you commit to vs. complete

**Robot**: "You have 12 pending commitments."

**Friend**: "Your commitment completion dropped from 80% to 50% this month. You've been overloaded. Want to renegotiate some of these?"

### 2. People Pulse (uses existing people data)

Already tracking people and interactions. Add:
- Interaction frequency patterns
- Relationship drift detection

**Robot**: "Sarah last mentioned 21 days ago."

**Friend**: "You haven't mentioned Sarah in 3 weeks - you two usually talk more. Everything okay there?"

### 3. Decision Journal with Follow-Through

Decisions captured in observations. Add:
- Explicit tagging
- Following up on outcomes
- Learning from patterns

**Friend**: "Remember when you decided to take on that consulting gig? How did that actually work out? I want to remember for next time."

### 4. Value-Action Alignment (uses narrative + observations)

Narrative tracks values/identity. Observations show actions.

**Friend**: "You've said family time is a priority, but you've mentioned work stress 8x more than family this month. Not judging - just noticing. Is that how you want it?"

### 5. Proactive Daily Check-in

**Not**: "You have 3 meetings today."

**Instead**: "Morning. Your plate is full but one thing stands out - you've been putting off the dentist for 2 weeks. Today might be the day to just schedule it. Also, your meeting with John - last time you said you wanted to bring up the timeline. Still want to?"

Curated. Opinionated. Remembers context.

---

## Making It Friend-Like (Not Sycophantic)

### What Friends Do:
- Remember things without being asked
- Have opinions and share them
- Push back when something seems off
- Notice patterns you might miss
- Check in proactively
- Adjust tone based on how you're doing

### What Sycophants Do:
- Always agree
- Always praise
- Never challenge
- Reflect your views back without adding perspective

### Ingredients for Pushback (already have):
- **Contradictions table** - when beliefs conflict
- **Tensions category** - unresolved concerns
- **Patterns from consolidation** - recurring behaviors

**Missing**: Using this data to form opinions and voice them.

---

## Implementation Path

### Layer 1: Personality/Voice (cheapest win)

System prompt layer that gives Keymaker consistent character:
- Warm but direct
- Remembers and references past conversations
- Has preferences and opinions
- Adjusts tone based on mood data

Thin wrapper around existing query synthesis.

### Layer 2: Proactive Triggers

Consolidation service already runs weekly. Add:
- "Things to check in about" output
- Morning briefing generation
- "Haven't heard from you in X days" awareness

Content ready when user opens app - no push notifications needed initially.

### Layer 3: Opinion Formation

New service taking:
- Current context
- Historical patterns
- Stated values (narrative)
- Known tensions/contradictions

Outputs:
- Whether to express an opinion
- What that opinion is
- How to phrase it given current mood

### Layer 4: Dialogue Memory

Chat session exists but short-term. Add:
- Tracking what Keymaker has said/asked
- Follow-up on previous check-ins
- "Last time I asked about X, you said Y - any update?"

---

## Model Requirements

### Works with current model (llama-3.3-70b via Groq):
- Personality/voice layer (system prompts)
- Morning check-ins from structured data
- Commitment health callouts
- Basic warmth and remembering context
- ~70% of the "friend" feel

### Benefits from frontier models:
- When to push back (social calibration)
- How to phrase disagreement (nuance)
- Opinion formation from complex context
- Mood-adjusted tone (subtle register shifts)

### Pure code (no model):
- Commitment completion rate calculation
- People interaction frequency tracking
- Proactive trigger logic
- All data aggregation

### Privacy-Preserving Frontier Option (if needed later):
Abstract patterns before sending:
- "User hasn't mentioned Person_A in 3 weeks" (not real names)
- "Commitment rate dropped to 50%" (not specific commitments)
- Frontier reasons about pattern, local model applies to real data

---

## Priority Features

**High Value, Uses Existing Data:**
1. Morning check-in with curated focus + one "friend" observation
2. Commitment health tracking with gentle callouts
3. Personality layer in responses (warm, opinionated, remembers)
4. Pushback on new commitments when overloaded

**Medium Value, Some New Logic:**
5. People relationship pulse (interaction frequency drift)
6. Decision follow-up loop
7. Value-action alignment check (quarterly?)

**Interesting but Harder:**
8. Mood-adjusted response calibration
9. Proactive notifications (requires thinking about when to interrupt)

---

## The Vision

Not just a personal assistant. A true partner/sidekick that:
- Opens doors you couldn't before
- Knows you well enough to have opinions
- Pushes back when you need it
- Remembers what matters
- Grows with you over time

The data architecture supports this. The question is building the voice and initiative to make it real.

---

## Open Questions

1. **Visual presence**: three.js/blender/webgl direction - does an avatar change the relationship dynamic?
2. **Proactive timing**: When does helpful become annoying?
3. **Pushback calibration**: How strong? How often? Based on stakes?
4. **Privacy stance**: Groq data policy needs review. Honest positioning matters (legal + trust).
5. **Local model ceiling**: How good can we get without frontier? Worth extensive prompt engineering.

---

*"The difference between a database and a friend isn't the data - it's the voice."*
