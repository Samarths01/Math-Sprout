# Math Sprout — Design first principles (one-pager)

**Status:** Living · **Owner:** Interface · **Product:** Math Sprout (Prod 2)  
**Audience:** Product, Design, Eng, ML — ship and critique against these, not vibes.  
**Sources:** Opportunity memo (ADOPTED) · Architecture · ML approach · IA/lo-fi (ADOPTED)

---

## Thesis

Math Sprout is a **motivation + mastery loop** for kids (~grade 2+, ability-banded). Delight is earned only when real learning happens. Practice is home; fuel (flame, XP, BuildGoal) is a side effect — never a second destination.

---

## Eight principles

### 1. Delight follows real learning
Celebration, XP, flame heat, and BuildGoal pieces mint only on **QualifyingEvents** (server rules). Never on volume, time-on-app, soft engagement, or Review-only paths that fail evidence gates.

### 2. Practice is home
The attempt loop is the primary surface. Companion, streak/flame, XP, and BuildGoal are **glance-only side effects** on home. Never invent a second destination that steals the Practice CTA.

### 3. Kid cognition wins in three questions
Every screen should answer fast:
1. What am I practicing?
2. Am I getting better at it?
3. What happens next?

### 4. Parent trust is one breath
Three beats only, from **server-committed** aggregates:
1. Did practice happen (minutes / practiced today)
2. On what (concept name)
3. Honest band — Still learning / Getting it / Got it

No %, no attempt-history deep links, no “AI thinks…”. **Got it** copy = fluency evidence only — never transfer / “can do any form of this.”

### 5. Feedback is diagnostic, not vanity
After an attempt, four beats:
1. What went well (specific, short)
2. **oneFocus** — single diagnostic tip from item/misconception metadata (server-assembled; client renders as-is)
3. Try next
4. Concept chip — only when soft-state allows; else soft “still learning *concept*”

Never shame, peer compare, raw model scores, or vanity praise as beat 2.

### 6. Uncertainty stays soft
Client receives soft-state only (`bandLabel` · `showConceptChip` · `celebrationTier`) — never raw confidence or model prose. **State chrome beats progress narrative:** pause-hold, revoke, and sync/capacity cap are first-class; do not invent a progress story that contradicts them. Cap exhaustion = sync/capacity copy — never “Practice paused” (capacity ≠ consent).

### 7. Warm recovery, zero shame
Flame/ember cools without streak-shame copy. Review = quiet confidence rebuild: reduced XP toast only — no LevelUp / Badge / BuildGoal piece chrome from Review.

### 8. Web-first, kid-safe framing
Responsive web; no AI-tutor chat spine in v1; no native-app chrome as the product spine. Fuel fire only on honest mastery events, not volume.

---

## Quick anti-patterns (kill on sight)

| Do | Don’t |
| --- | --- |
| QE-gated fuel | Volume / time XP |
| Practice CTA primary | Companion/shop as home |
| Soft band labels | %, “AI thinks…” |
| Diagnostic oneFocus | Vanity encouragement |
| State chrome > narrative | Fake progress while paused/capped |
| Warm flame recovery | “You broke your streak” |
| Parent three beats | XP vanity dump / attempt surveillance |

---

## Slice alignment (non-exhaustive)

- **Offline / pause:** visible hold (parent waiting + quiet resume) — shippable; drop-on-pause is fallback only if hold cannot ship.
- **Queue/attempt cap:** same calm waiting *pattern*, sync/capacity copy — never “Practice paused.”
- **Slice 7 fuel:** flame + accrue XP + BuildGoal piece on QE only; glance-only on home; companion react deferred if it risks a second destination.

---

## Ownership

- **Interface** owns this one-pager and IA/lo-fi frames.  
- Supersede in place; don’t erase. Cross-link Opportunity / Architecture / ML when locks move.  
- Notion mirror: stage artifacts hub → Interface living docs.

*Last written: 2026-09-23 (Interface).*
