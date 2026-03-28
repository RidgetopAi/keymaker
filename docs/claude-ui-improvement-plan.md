# Keymaker Mobile UI Redesign Plan

**Created:** 2024-12-02
**Status:** Awaiting direction from Brian

---

## Current State Assessment

### What's Working
- Solid mobile-first foundation with safe-area handling
- Good touch targets, PWA support, voice input
- Clean data architecture with living summaries
- Five-view navigation is logical

### What's Making It Feel "Bad, Boring & Clunky"

| Issue | Evidence |
|-------|----------|
| **Visual monotony** | Same `#16213e`/`#0f0f23` cards everywhere, no visual hierarchy |
| **Dense information** | Everything equally weighted, no breathing room |
| **Generic dark theme** | System font + flat cards = every other app |
| **Clunky interactions** | No gesture support, abrupt transitions, basic modals |
| **No personality** | A memory system should feel *personal*, not corporate |

---

## Design Direction: "Calm Intelligence"

Your memory system deserves to feel like a trusted companion, not a database UI. The redesign concept: **warm, spatial depth with intentional restraint**.

### Visual Language
- **Depth through subtle gradients & shadows** — layers that feel 3D
- **Warm accent palette** — move from cold blue to amber/coral warmth
- **Generous whitespace** — less density, more focus
- **Micro-interactions** — feedback that feels alive
- **Typography with character** — one distinctive font for identity

---

## Phase 1: Foundation Refresh

### 1.1 Color System Overhaul

```
Current             →  Proposed
#0f0f23 (black)     →  #0a0a12 (deeper void)
#1a1a2e (bg)        →  #12121f (richer black)
#4a9eff (accent)    →  #f59e0b (warm amber) + #ec4899 (pink for emphasis)
#333 (borders)      →  Remove most borders, use shadow/gradient instead
```

### 1.2 Typography Upgrade
- Add one distinctive font: **Inter** (clean) or **Space Grotesk** (character)
- Identity card: Larger, serif font for quotes/synthesis
- Reduce font-size variations from 10+ to 4 clear levels

### 1.3 Spacing System
- Double current padding in most places
- Cards: 1.5rem → 2rem padding
- List items: Add 1rem gap minimum
- Sections: Clear 2rem vertical separation

---

## Phase 2: Component Redesign

### 2.1 Now View Transformation

**Current:**
```
┌─────────────────────┐
│ Identity Card       │  ← Generic gradient
├─────────────────────┤
│ [cat][cat][cat]     │  ← Dense 2-column grid
│ [cat][cat][cat]     │
├─────────────────────┤
│ Weekly Digest       │  ← Same card style
├─────────────────────┤
│ Needs Attention     │  ← Flat list
└─────────────────────┘
```

**Proposed:**
```
┌─────────────────────┐
│                     │
│  "You are..."       │  ← Full-width, subtle glow
│   (serif, larger)   │     ambient background animation
│                     │
└─────────────────────┘

   Commitments ─────────────
      (horizontal scroll with depth cards)

   People ──────────────────
      (avatar circles, not lists)

   ┌───────────────────────┐
   │ ⚠️ 2 things need you  │  ← Only if relevant
   └───────────────────────┘
```

### 2.2 Bottom Navigation Redesign
- Replace emoji icons with minimal SVG icons
- Active state: Pill background, not just color change
- Add subtle bounce/scale on tap
- Consider floating pill style (detached from edges)

### 2.3 Modal → Bottom Sheet with Gestures
- Drag handle at top
- Swipe down to dismiss
- Snap points (40% / 80% / full)
- Blur background instead of dark overlay

### 2.4 Chat View Refinement
- Message bubbles with more personality (rounded, with tail)
- Typing indicator as animated dots, not text
- Voice button: Prominent, circular, glowing when active
- Input area: Floating above keyboard, rounded pill style

---

## Phase 3: Interaction Polish

### 3.1 Micro-animations
- Cards: Scale 0.98 on press, spring back
- View transitions: Crossfade with slight slide
- Loading states: Skeleton screens, not spinners
- Success feedback: Subtle haptic pulse + green flash

### 3.2 Gesture Support
- Swipe between main views (optional, nav still works)
- Pull-to-refresh on timeline and entities
- Long-press on observations for quick actions
- Swipe-to-archive on commitments

### 3.3 Contextual Theming
- Mood category affects subtle background hue
- Time of day influences warmth (cooler at night)
- "Tension" items have subtle red ambient glow

---

## Phase 4: Personality Layer

### 4.1 Identity Card as Hero
- Larger, takes 40% of viewport
- Gentle particle/grain animation in background
- Serif font for the synthesized identity text
- Subtle glow emanating from edges

### 4.2 Living Summaries as Spatial Cards
- Each category gets a distinct subtle gradient
- Depth via layered shadows (3 levels)
- Icons that feel hand-drawn or personal
- Horizontal scroll creates depth parallax

### 4.3 Timeline as Actual Timeline
- Visual timeline with vertical spine
- Month dots along the line, current = glowing
- Tap reveals expansion inline, not modal
- Past months have faded/sepia treatment

---

## Implementation Approach

### Option A: Enhance Current Vanilla JS
- Keep architecture, refactor CSS into custom properties
- Add CSS animations, update styles
- Minimal JavaScript changes
- **Fastest to implement**

### Option B: Introduce Minimal Framework
- Adopt **Svelte** (compiles to vanilla, tiny runtime)
- Enables reactive animations, easier gestures
- Better component organization
- Moderate effort, better maintainability

**Recommendation:** Option A for speed, since you're building the 3D version anyway. This gives you a dramatically improved interim UI without architectural changes.

---

## Priority Order

1. **Color + Typography** — Immediate visual lift
2. **Now View layout** — Most-used screen
3. **Navigation redesign** — Changes app feel
4. **Bottom sheet gestures** — Feels modern
5. **Chat refinements** — Second most-used
6. **Micro-animations** — Polish layer, ongoing

---

## Decisions Needed

Before implementation, confirm:

1. **Color preference**: Warm amber/coral direction, or different vibe?
2. **Typography**: Add a web font, or stay with system fonts?
3. **Scope**: Full redesign vs. just the most impactful changes?
4. **Timeline view**: Keep horizontal month strip, or go vertical timeline?

---

## Notes

*Brian is learning Three.js, WebGL, and Blender for a highly interactive future UI. This plan is for an improved interim mobile experience.*
