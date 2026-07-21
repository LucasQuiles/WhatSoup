# Research — the "Hatching" ceremony (OpenClaw + Hermes)

Compiled 2026-07-21. Sources: OpenClaw community docs/decks, Hermes Pets repo skill docs.

## 1. OpenClaw — "hatch" as the onboarding ritual

OpenClaw (formerly Clawdbot/Moltbot) is the closest reference: an open-source agent framework
where **creating an agent is called "hatching"** — Tamagotchi framing for a "digital employee."

**The ritual (3 steps):**
1. **Soul config** — write `soul.md`: the agent's identity, personality, goals, behavioral
   constraints. The soul comes *first*, before any machinery.
2. **Brain** — pick the LLM (Anthropic / OpenAI / local). Model-agnostic; swappable later.
3. **Gateway pair** — connect a messaging channel (Telegram/Slack/custom API).

Then `openclaw hatch` (TUI) or the web dashboard completes the rite; community culture treats the
first boot as an event ("new tomogachi hatching in this Mac mini" — YouTube, Mar 2026).
Onboarding CLI: `openclaw onboard` → hatch via TUI (`openclaw hatch --tui`) or Web UI
(`http://127.0.0.1:18789`).

**What SOUP takes:**
- The **order is the ceremony**: identity → brain → channel. It mirrors our wizard
  (Identity → Config/ModelAuth → Link) almost exactly — the ritual framing is a *presentation
  layer* over the same state machine, not new logic.
- Naming the moment matters: the transition "configured → alive" gets a name (Hatch) and a beat.
- Soul-first ordering is a strong UX idea: persona before plumbing.

**What SOUP avoids:** the Tamagotchi aesthetic itself (toy-like, off-brand vs serious industrial
polish), and any ambient/looping celebration.

## 1.5 OpenClaw's shipped hatch design (A5 deep-dive, `docs/start/onboarding-redesign.md`)

OpenClaw's onboarding redesign (7 phases, phases 1–6 merged as of 2026-07) is the most directly
relevant reference we have — same product shape (multi-channel agent gateway), and the hatch is
its centerpiece. North star: *"sets everything up with announced defaults instead of questions,
hatches their agent as a visible identity moment… magic by default, one consent boundary, no
dead ends."*

**The ceremony as shipped (their fifth phase):**
- A **custodian** (system caretaker presence) creates a **nameless agent**; the agent's bootstrap
  then opens with **self-naming — the agent names itself and picks its own face.**
- Ceremony is **capped at three beats: name → soul line → skills question.** Restraint by design.
- **Same thread, avatar swap** — the identity moment is an in-place avatar transformation, not a
  page transition; after completion the app transitions to the regular UI. The claw mark stays
  reserved for the custodian (identity hierarchy).
- **Avatar ladder** (designed, deferred): model-generated candidates → preset marks → keep logo.
  SOUP analog: custom profile picture → initials avatar → channel glyph.
- **Auto-hatch with announcement, not a blocking button** — the hatch fires on clean post-setup
  verification and is *announced*, never gated behind "are you sure?".
- **"Wake up, my friend!"** — the web UI lands in agent chat with the first message *prefilled*;
  the human's first act is speaking to their new agent, not reading a success screen.
- **Browser-first, terminal as fallback** — never a "terminal or browser?" question; the best
  available surface is chosen automatically.
- **Question zero is the only consent boundary** (Full access vs Ask first); everything else is
  announced-with-undo.
- **Option cards: 2–4 options, exactly one recommended, always skippable** — the same component
  serves onboarding and runtime agent questions (maps directly to our CardSelector primitive).
- Identity persists twice: into `IDENTITY.md`/`SOUL.md` (what the agent reads) and via
  `agents set-identity` (what channels/UI display) — persona is a first-class stored object.

**Design laws worth adopting verbatim:**
1. Announced defaults with easy undo > blocking questions.
2. The agent participates in its own birth (self-naming) — ceremony is a *conversation*, not a
   spinner.
3. Three beats max; every beat skippable; restraint is what makes it feel premium.
4. The first message is prefilled — end the ceremony inside the relationship, not on a recap.
5. Identity hierarchy: one reserved mark for the system, distinct marks for agents.

## 2. Hermes Pets — "hatch-pet" as the animation model

Hermes Pets is an animated desktop-companion runtime; its `hatch-pet` skill generates custom
animated pets. Relevance is the **animation architecture**, not the pets:

- **State-driven sprites:** each pet is a manifest of named states — `idle` (required),
  `run_right/left`, `waving`, `jumping`, `failed`, `waiting`, `running`, `review`,
  `message_react`, `bubble_react`, `blink` — each with fps + loop flag + fallback chain
  (`waving → idle` when missing).
- **QA contract:** contact sheet per state; identity consistency across frames; transparent
  backgrounds; legible small silhouette (16px test); state-specific motion.
- **Package discipline:** validation before import (real PNGs, safe names, required idle).

**What SOUP takes:**
- **A tiny state taxonomy for the "alive" beat**: an agent/line presence glyph with states like
  `sealed (egg/config)`, `cracking (linking)`, `hatched (live)`, `idle`, `react` — each one-shot
  except idle, each with a fallback, each honoring reduced-motion by collapsing to the end state.
- **Fallback-chain discipline**: missing/unsupported states degrade to idle, never to nothing.
- **16px legibility rule** aligns with our existing favicon/icon law.

**What SOUP avoids:** literal mascots (v3 forbidden treatment), sprite pipelines, character art.

## 3. Synthesis — the SOUP Hatch ceremony (updated per owner decisions 2026-07-21)

**Stages (mirrors journey map; console language = "deactivated", not sealed/egg — D3):**
```
deactivated → linking → hatching → live
```

- **Ceremony shape (from OpenClaw):** a short *conversational* rite — the agent self-names
  (with templates as defaults, C6), states a soul line, and asks one skills/setup question.
  Three beats max, each skippable. Ends with the first message prefilled ("Say hello…"), landing
  the user inside the relationship, not on a success screen.
- **Visual carrier:** the identity lockup — channel glyph + agent initials avatar + nameplate.
  The ceremony beat is the avatar/identity transformation in place (one-shot, ≤600ms,
  skippable, reduced-motion → final state; D2-approved feature animation, not an animated
  control).
- **Avatar ladder:** assignable profile picture → initials avatar → channel glyph fallback (B2).
- **Console register stays dry:** "deactivated" / "live" / "Line is live." Playfulness lives in
  the onboarding journey only (A5).
- **Option-card pattern** for channel pick + templates: 2–4 cards, one recommended, always
  skippable (extends CardSelector).

## 4. Open questions for G1/T3 (reduced after owner answers)

1. Glyph treatment at the hatch moment: light-sweep vs shape-resolve — mock both in WS3.2.
2. Does the hatch conversation happen in a dedicated ceremony room (first-run) with the inline
   Fleet beat reserved for N+1 (C5 ✅ both — how the two relate visually)?
3. Self-naming UX: does the agent propose 3 names from the template persona (option-card) with
   free-text override? (rec: yes, mirrors announced-defaults law)
