# Handoff Distiller Wiring — Design

**Status:** LANDED — merged via PRs #939 (wiring), #941 (env-knobs + PII), #942 (templates SSOT); all flag-gated default-OFF. · **Date:** 2026-06-16 · **Branch:** `feat/handoff-distiller-wiring` (merged + deleted)

## Context

The cross-harness context-handoff cores are built, unit-tested, and merged (#931) but
**not wired** — `runtime.ts` has zero references to `runHandoffDistill` /
`buildHandoffPrelude`, and the runbook documents them as "Built but not yet wired"
(`docs/runbooks/error-response-workflows.md`). The verbatim-last-N path already ships
(`sendTurnToSession` injects `[Recent chat context]`). What remains is the
**LLM-distilled summary path** and the **system-prompt injection seam**.

This design wires those, governed by two settled decisions:

1. **Dedicated cheap API summarizer** — the distiller calls a configured cheap model
   (deepseek / minimax / glm, via the existing `~/.config/secrets/*.env` keys, directly
   or via opencode), **decoupled** from the conversation's live provider. Uniform across
   all provider types (CLI subprocess providers have no cheap in-process call); cost and
   latency never touch the live harness.
2. **Experiment-first** — before locking where the summary is injected (system prompt vs
   first turn), a standalone harness empirically measures whether each provider honors
   system-prompt context on a fresh stand-in session.

**Model-agnostic invariant:** the distiller never hardcodes a harness model; the summarizer
model is config-driven and the conversation's own provider is irrelevant to it.

**Data-exposure invariant:** conversation content crosses to a third-party cheap model, so
**redaction-before-distill is mandatory** — same discipline as the `ocw` "never stage
secrets" rule and the existing cross-provider injection redaction.

## Sequencing

① seam experiment → ② lock per-provider routing → ③ distiller loop + summarizer →
④ injection seam. Each step is independently shippable and flag-gated; nothing alters the
live turn path until its flag is on (default off = byte-identical to today).

---

## ① Seam experiment harness

**File:** `scripts/experiments/handoff-seam-probe.ts` (standalone; never imported by the
live turn path). **Built and runnable.**

**Scope (decided):** test the three **cheap models** — deepseek-chat, MiniMax-M2.7,
glm-5.2 — via their direct OpenAI-compatible APIs (keys from `~/.config/secrets/*.env`).
These are the models that will power the summarizer and the realistic low-cost stand-in
(opencode) harness. The paid `claude-cli` / `codex-cli` harnesses are **excluded** (no
paid-quota spend) unless explicitly requested; `gemini-cli` is not installed → skipped.

For each model, two arms with a unique per-run synthetic sentinel
(`access code is HANDOFF-<nonce>`):

- **Arm A (system)** — sentinel in the **system role**, probe in the user role;
  **Arm B (first-turn)** — sentinel + probe both in the **user role**.
- Probe: "What is the access code?" Score = exact-nonce recall.
- Per-call abort deadline (45s); each arm run 3× (majority vote) to damp nondeterminism.
- Models run in **parallel**; arms within a model sequential.

**Decision rule per model:** `sysRate ≥ 0.5` AND `sysRate ≥ userRate − 0.34` → seam
`system` (system-prompt injection honored); else → `first-turn`. `inconclusive` when the
system arm produced no verdicts; `skipped` when no key.

**Output:** `docs/experiments/handoff-seam-results.md` — per-model recall matrix + per-call
outcomes. This **drives** the routing constant in ②. No live-path code depends on the harness.

**Failure modes:** missing key → `no-key` outcome → `skipped`; HTTP error → `error` outcome;
abort → `timeout` outcome; malformed body → `missed`. The harness degrades, never throws.

---

## ② Per-provider routing constant

**Experiment ① result (2026-06-16):** all three cheap models honor system-prompt
injection — deepseek-chat 3/3 system & 3/3 first-turn; glm-5.2 3/3 & 3/3;
MiniMax-M2.7 3/3 & 3/3. → seam **`system`** for the cheap-model / opencode path.
(First run gave a false `first-turn` for glm/minimax: empty `message.content` because
those are reasoning models that emit into `reasoning_content` and a 64-token cap
truncated the answer. Fixed by reading `reasoning_content` + raising `max_tokens`;
masked-signal lesson recorded.) **Scope caveat:** this validates *model* honoring via
direct API; that the opencode *harness* faithfully propagates WhatSoup's system prompt
is a separate, smaller integration check covered by ④'s test, not by ①.

**File:** `src/runtimes/agent/handoff-seam-routing.ts` (SSOT).

```ts
export type HandoffSeam = 'system' | 'first-turn';
// Populated from ① results. Default 'system' (panel recommendation —
// the only carrier surviving a fresh non-shareable session); a provider the
// experiment shows ignores system context is pinned to 'first-turn'.
export const HANDOFF_SEAM_ROUTING: Record<AgentProvider, HandoffSeam> = { /* from ① */ };
export function seamForProvider(p: AgentProvider): HandoffSeam { ... }
```

`assertSeamRoutingConsistency()` is retained as a test-time and defensive guard over
the SSOT. It is not wired into production boot today; runtime lookup uses
`seamForProvider()` with a safe `'first-turn'` default, so provider drift preserves
handoff context instead of failing boot. If production fail-fast is later required,
wire the assertion in the runtime boot path and update this spec/runbook in the same
change.

---

## ③ Distiller loop + dedicated summarizer

### Summarizer — `src/runtimes/agent/handoff-summarizer.ts`

A narrow async client implementing the injected `distill: () => Promise<DistillOutcome>`
contract that `runHandoffDistill` already expects. Steps:

1. Read recent messages (`getRecentMessages(db, conversationKey, N)`).
2. **Redact** every line through the conversational-content sanitizer (extend
   `sanitizeProviderPreviewText`) — secret shapes / PII stripped **before** the third-party call.
3. Call the configured cheap model (`WHATSOUP_HANDOFF_DISTILL_MODEL`, key from
   `~/.config/secrets/{deepseek,minimax,zai}.env`) with a fixed summarization prompt
   (per-call nonce-delimited fence around corpus text — retrieval-injection defense).
4. Return `{ summary, seededArtifacts, tokensUsed }`. Any API error rejects → folded by
   `runHandoffDistill` as a failure (breaker advances, `onDegraded` alert, no partial persist).

No-key / no-model configured → summarizer is inert; the system degrades to verbatim-only.

### Loop driver — `src/runtimes/agent/handoff-distill-runner.ts`

Per-active-conversation **unref'd debounced** timer mirroring the
`PROVIDER_FALLBACK_PRIMARY_RECHECK_MS` pattern (`setTimeout(...).unref?.()`,
`clearTimeout` on shutdown). On tick, for each active conversation:

- Token-growth gate: `getSessionTokenSnapshot` → `inputGrowth = total − lastCompact`;
  distill only when growth ≥ threshold (reuse the compaction signal; `markSessionCompacted`
  resets the baseline after a successful distill).
- Consult `runHandoffDistill` (gate-first: cost budget + circuit breaker + **global
  concurrency semaphore** `globalInFlight` across all distiller workers).
- Persist via `handoff-artifact.ts` upsert (`BEGIN IMMEDIATE`).
- Debounce on message arrival; never run two distills for one conversation concurrently.

The loop **never blocks a turn** — a tripped breaker, budget exhaustion, or summarizer
failure simply leaves the artifact stale and the handoff degrades to verbatim-only.

---

## ④ Injection seam

`SessionManager` already holds `this.db` and `this.chatJid`. In `buildSystemPrompt()`
(`session.ts:562`), insert one optional source **after `transportPrelude`, before
`configSystemPrompt`**:

- Gated on `WHATSOUP_HANDOFF_CONTEXT` **and** a fresh artifact exists **and**
  `seamForProvider(provider) === 'system'`.
- Build via `buildHandoffPrelude(...)`; push `systemBlock` into `sources[]`. The existing
  never-empty-prompt guard (`session.ts:593`) and exact-line dedup are preserved.

For `seamForProvider(provider) === 'first-turn'`, the summary rides the first stand-in
turn instead (extend the existing verbatim first-turn path in `replayTurnOnFallback`).

**Staleness guard:** artifact older than TTL (~120s) at handoff → `withTimeout(~2s)`
on-demand re-summarize, else degrade to verbatim-only (verbatim always covers the gap).
**Cost-compression:** first stand-in turn = verbatim + summary; summary-only thereafter;
for `backupContextWindow==='same_or_smaller'` prefer summary-only even on turn one.

---

## Cross-cutting

**Flags (all default off):** `WHATSOUP_HANDOFF_DISTILLER` (loop on),
`WHATSOUP_HANDOFF_CONTEXT` (injection on), `WHATSOUP_HANDOFF_DISTILL_MODEL` (which model).
Distiller stays inert until ≥1 successful artifact exists per conversation; hard cap forces
verbatim-only if no fresh artifact within N minutes.

**Summarizer model policy (SSOT, operator's choice — no hardcoded default).**
`WHATSOUP_HANDOFF_DISTILL_MODEL` has **no built-in default**: unset ⇒ the distiller is
inert and the handoff degrades to verbatim-only (never a silent fallback to some model the
operator didn't choose). Validated options: `deepseek-chat` (cheap, non-reasoning, clean
output, system-seam honored per ①) for cost-sensitive background distillation; an
opus-tier model when "most capable" output is wanted. The model id maps to its endpoint +
key via the existing `provider-key-service` / `credential-verify` registry; an unconfigured
key ⇒ inert (verbatim-only), surfaced as a degradation alert, never a crash.

**Observability / telemetry:** structured Pino log per distill (conversation, tokensUsed,
allow/deny reason, breaker state, latency); spend tracked in `agent_handoff_spend`
(per-window tokens/cost/calls) reusing the `recordTurnCostUsd` seam; surface distiller
health in `/health` (additive, read-only). **No silent degradation** — distiller failure /
breaker-trip / stale-at-handoff emits a redacted `WarmHandoffFailure`/`WarmHandoffDegraded`
event to `bot-errors-outbox.ts`.

**Durability / resilience:** artifact + spend writes `BEGIN IMMEDIATE`; gate state
persisted so a restart resumes mid-window; the handoff read is a point-in-time snapshot;
breaker survives restart.

**Happy path:** active conversation grows → background distill → fresh artifact → fallback
fires → stand-in spawns with summary (system or first-turn per routing) + verbatim →
continues with context. **Unhappy paths:** no key → verbatim-only; breaker open →
verbatim-only + alert; stale artifact → on-demand re-summarize or verbatim-only; summarizer
timeout → degrade + alert; provider ignores system context (per ①) → routed to first-turn.

## Testing

- `handoff-seam-probe` — harness self-test (deadline kill, timeout-as-outcome, skip on
  missing binary) with a fake provider runner.
- `handoff-summarizer.test.ts` — redaction applied before the call (assert no secret shape
  reaches the client); API error → reject → folded as failure; no-key → inert.
- `handoff-distill-runner.test.ts` — token-growth trigger; debounce; `timer.unref` asserted;
  gate-deny path calls no model; global semaphore caps concurrency.
- `handoff-seam-routing.test.ts` — exhaustiveness (every provider routed); boot assertion.
- `session-prompt-composition.test.ts` (extend) — system-seam injection position;
  first-turn routing; staleness re-summarize; never-empty guard; flag-off = byte-identical.
- Real SQLite, `--pool=forks`. Equivalence: with all flags off, the emission sequence is
  identical to today.

## Out of scope

Per-conversation distill-model auto-selection; multi-model summary ensembling; UI surfacing
of handoff state beyond `/health`.
