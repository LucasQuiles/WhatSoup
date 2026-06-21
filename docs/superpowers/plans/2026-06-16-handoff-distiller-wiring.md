# Handoff Distiller Wiring Implementation Plan

**Status:** completed - landed via PRs #939/#941/#942 on 2026-06-16; retained as historical implementation evidence.

> **✅ COMPLETE (2026-06-16):** All tasks landed + merged via PRs #939/#941/#942 (verified wired, flag-default-OFF, byte-identical when off). This plan is retained as a historical record; do not re-execute. Residual follow-ups: `tool-activity-blocked` template id (documented in `docs/runbooks/error-response-workflows.md`); two intentionally-defensive orphan exports (`deleteHandoffArtifact`, `assertSeamRoutingConsistency`).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the four merged-but-unwired handoff cores so a stand-in (fallback) agent session is seeded with a distilled summary of the prior conversation, fully flag-gated (off = byte-identical to today).

**Architecture:** A background, unref'd, debounced per-conversation loop (`handoff-distill-runner`) calls the existing pure `runHandoffDistill` with a config-driven cheap-model summarizer (`handoff-summarizer`, redaction-before-distill) to persist `agent_handoff_artifacts`. On a fallback session spawn, `buildSystemPrompt` injects the artifact's summary (seam routing locked to `system` for all providers by experiment ①). Cost/breaker safety is the already-built `handoff-distill-gate`.

**Tech Stack:** TypeScript ESM, Node 24.15.0 (`--experimental-strip-types`, no build), node:sqlite via `src/core/database.ts`, Zod, Pino, vitest `--pool=forks`. Branch: `feat/handoff-distiller-wiring`.

**Reference:** spec `docs/specs/2026-06-16-handoff-distiller-wiring-design.md`; experiment `docs/experiments/handoff-seam-results.md`.

---

## Verified core contracts (do not redefine — import)

- `handoff-distill-gate.ts`: `evaluateDistillGate({state,config,now,globalInFlight}) → DistillDecision{allow,reason,nextState}`; `recordDistillSuccess(state,tokensUsed,now,config)`, `recordDistillFailure(state,now,config)`, `initialDistillState(now)`; types `DistillState`, `DistillBudgetConfig`, `DistillDenyReason`, `BreakerState`.
- `handoff-distiller.ts`: `runHandoffDistill(deps: RunHandoffDistillDeps) → Promise<RunHandoffDistillResult{ran,denied,failed,nextState}>`; `DistillOutcome{summary,seededArtifacts?,tokensUsed}`. Deps include `distill: () => Promise<DistillOutcome>`, `persist: (HandoffArtifact)=>void`, `onDegraded?: (reason)=>void`, `state`, `config`, `now`, `globalInFlight`, `conversationKey`, `sourceProvider`, `sourceModel`, `tokenBaseline`.
- `handoff-prelude.ts`: `buildHandoffPrelude(args: BuildHandoffPreludeArgs) → HandoffPrelude{systemBlock,firstTurnBlock}`; types `HandoffArtifact`, `HandoffMessage`.
- `handoff-artifact.ts`: `ensureHandoffArtifactSchema(db)`, `upsertHandoffArtifact(db,artifact)`, `getHandoffArtifact(db,key)`, `deleteHandoffArtifact(db,key)`.
- Integration seams: `session.ts:562 buildSystemPrompt()` (SessionManager has `this.db`, `this.chatJid`); `session-db.ts:205 getSessionTokenSnapshot(db,rowId)`, `markSessionCompacted(db,rowId)`; `messages.ts:167 getRecentMessages(db,key,limit)`; `runtime.ts` timer idiom `setTimeout(fn,ms).unref?.()`; `provider-key-service.ts` (`PROVIDER_KEY_ENV`), `credential-verify.ts` (endpoint map).

## File Structure

- **Create** `src/runtimes/agent/handoff-seam-routing.ts` — per-provider seam SSOT + boot guard.
- **Create** `src/runtimes/agent/handoff-summarizer.ts` — config-driven cheap-model summarizer producing the `distill` closure; redaction-before-call.
- **Create** `src/runtimes/agent/handoff-distill-runner.ts` — background debounced unref'd loop + global semaphore; wires summarizer→`runHandoffDistill`→`upsertHandoffArtifact`.
- **Modify** `src/runtimes/agent/session.ts` — optional handoff system-block source in `buildSystemPrompt`.
- **Modify** `src/runtimes/agent/runtime.ts` — flags, `ensureHandoffArtifactSchema` in `start()`, runner lifecycle, degradation alert.
- **Modify** `docs/runbooks/error-response-workflows.md` — move distiller from "built but not wired" to live (PR co-update rule).
- **Tests:** `tests/runtimes/agent/handoff-seam-routing.test.ts`, `handoff-summarizer.test.ts`, `handoff-distill-runner.test.ts`; extend `tests/runtimes/agent/session-prompt-composition.test.ts`.

---

## Task 1: Seam routing SSOT + boot guard

**Files:**
- Create: `src/runtimes/agent/handoff-seam-routing.ts`
- Test: `tests/runtimes/agent/handoff-seam-routing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { AGENT_PROVIDERS } from '../../../src/runtimes/agent/providers/types.ts';
import { seamForProvider, assertSeamRoutingConsistency, HANDOFF_SEAM_ROUTING } from '../../../src/runtimes/agent/handoff-seam-routing.ts';

describe('handoff-seam-routing', () => {
  it('routes every known provider (exhaustive)', () => {
    for (const p of AGENT_PROVIDERS) {
      expect(['system', 'first-turn']).toContain(seamForProvider(p));
    }
  });
  it('routes the experiment-validated cheap path to system', () => {
    expect(seamForProvider('opencode-cli')).toBe('system');
  });
  it('boot guard passes for the shipped table', () => {
    expect(() => assertSeamRoutingConsistency()).not.toThrow();
  });
  it('boot guard throws if a provider is unmapped', () => {
    const partial = { ...HANDOFF_SEAM_ROUTING } as Record<string, 'system' | 'first-turn'>;
    delete partial['opencode-cli'];
    expect(() => assertSeamRoutingConsistency(partial)).toThrow(/opencode-cli/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtimes/agent/handoff-seam-routing.test.ts --pool=forks`
Expected: FAIL (module not found). First confirm `AGENT_PROVIDERS` exists in `providers/types.ts`; if it is a TS union type only, add an exported `const AGENT_PROVIDERS = [...] as const` there in this step and key the type off it (`type AgentProvider = typeof AGENT_PROVIDERS[number]`).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtimes/agent/handoff-seam-routing.ts
import { AGENT_PROVIDERS, type AgentProvider } from './providers/types.ts';

export type HandoffSeam = 'system' | 'first-turn';

// Experiment ① (docs/experiments/handoff-seam-results.md, 2026-06-16): all tested
// models honored system-prompt injection (deepseek/glm/minimax 3/3 both arms). Default
// every provider to 'system'; pin a provider to 'first-turn' only with evidence it
// ignores system context.
export const HANDOFF_SEAM_ROUTING: Record<AgentProvider, HandoffSeam> = Object.fromEntries(
  AGENT_PROVIDERS.map((p) => [p, 'system' as HandoffSeam]),
) as Record<AgentProvider, HandoffSeam>;

export function seamForProvider(provider: AgentProvider): HandoffSeam {
  return HANDOFF_SEAM_ROUTING[provider] ?? 'first-turn'; // safe default: never lose context
}

/** Boot-time exhaustiveness guard — fail fast on a drifted/unmapped provider. */
export function assertSeamRoutingConsistency(
  table: Partial<Record<string, HandoffSeam>> = HANDOFF_SEAM_ROUTING,
): void {
  const missing = AGENT_PROVIDERS.filter((p) => table[p] === undefined);
  if (missing.length > 0) {
    throw new Error(`handoff-seam-routing: providers missing a seam entry: ${missing.join(', ')}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runtimes/agent/handoff-seam-routing.test.ts --pool=forks`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtimes/agent/handoff-seam-routing.ts tests/runtimes/agent/handoff-seam-routing.test.ts src/runtimes/agent/providers/types.ts
git commit -m "feat(agent): add handoff seam-routing SSOT with boot-time exhaustiveness guard"
```

---

## Task 2: Config-driven summarizer (redaction-before-distill)

**Files:**
- Create: `src/runtimes/agent/handoff-summarizer.ts`
- Test: `tests/runtimes/agent/handoff-summarizer.test.ts`

**Design:** `buildHandoffDistill(deps)` returns a `distill: () => Promise<DistillOutcome>` closure for `runHandoffDistill`. Injected `fetchImpl`, `redact`, `loadMessages`, and model config make it testable without network. Redaction is applied to every message line **before** the request body is built. A missing key throws `HandoffSummarizerInertError` (caller treats as inert → verbatim-only, not a breaker failure).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildHandoffDistill, HandoffSummarizerInertError } from '../../../src/runtimes/agent/handoff-summarizer.ts';

const baseDeps = () => ({
  model: 'deepseek-chat',
  apiKey: 'tok-FAKE',
  endpoint: 'https://api.example.test/chat/completions',
  conversationKey: 'c1',
  loadMessages: () => [{ senderName: 'Lucas', isFromMe: false, content: 'my secret is SENSITIVE' }],
  redact: (t: string) => t.replace(/SENSITIVE/g, '[REDACTED]'),
  verbatimN: 10,
});

describe('buildHandoffDistill', () => {
  it('redacts every line before the request leaves the process', async () => {
    let sentBody = '';
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'summary' } }], usage: { total_tokens: 42 } }) } as Response;
    });
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await distill();
    expect(sentBody).not.toContain('SENSITIVE');
    expect(sentBody).toContain('[REDACTED]');
    expect(out).toEqual({ summary: 'summary', seededArtifacts: null, tokensUsed: 42 });
  });

  it('rejects on a non-ok HTTP response (folded as a distill failure)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) as Response);
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/429/);
  });

  it('is inert when no api key is configured', () => {
    expect(() => buildHandoffDistill({ ...baseDeps(), apiKey: '' })).toThrow(HandoffSummarizerInertError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtimes/agent/handoff-summarizer.test.ts --pool=forks`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtimes/agent/handoff-summarizer.ts
import type { DistillOutcome } from './handoff-distiller.ts';
import type { HandoffMessage } from './handoff-prelude.ts';

export class HandoffSummarizerInertError extends Error {}

export interface HandoffDistillConfig {
  model: string;
  apiKey: string;
  endpoint: string;
  conversationKey: string;
  loadMessages: () => HandoffMessage[];
  redact: (text: string) => string;
  verbatimN: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const SUMMARY_SYSTEM = 'Summarize the conversation below into <=120 words of durable context for an assistant resuming this chat. State facts, open tasks, and the user goal. No preamble.';

export function buildHandoffDistill(cfg: HandoffDistillConfig): () => Promise<DistillOutcome> {
  if (!cfg.apiKey) throw new HandoffSummarizerInertError(`handoff summarizer inert: no key for model ${cfg.model}`);
  const doFetch = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 20_000;

  return async (): Promise<DistillOutcome> => {
    const msgs = cfg.loadMessages().slice(-cfg.verbatimN);
    // REDACT before composing the outbound body (third-party data boundary).
    const corpus = msgs
      .map((m) => `${m.isFromMe ? 'Assistant' : (m.senderName?.trim() || 'User')}: ${cfg.redact(m.content?.trim() ?? '')}`)
      .filter((l) => l.split(': ').slice(1).join(': ').trim().length > 0)
      .join('\n');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await doFetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, temperature: 0, max_tokens: 512, stream: false,
          messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: corpus }] }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`handoff summarizer HTTP ${res.status}: ${body.slice(0, 120)}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>; usage?: { total_tokens?: number } };
      const msg = data.choices?.[0]?.message;
      const flat = (c: unknown) => (typeof c === 'string' ? c : '');
      // Reasoning models (glm/minimax) emit into reasoning_content — read both.
      const summary = `${flat(msg?.content)} ${flat(msg?.reasoning_content)}`.trim();
      if (!summary) throw new Error('handoff summarizer returned empty summary');
      return { summary, seededArtifacts: null, tokensUsed: data.usage?.total_tokens ?? 0 };
    } finally {
      clearTimeout(timer);
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runtimes/agent/handoff-summarizer.test.ts --pool=forks`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtimes/agent/handoff-summarizer.ts tests/runtimes/agent/handoff-summarizer.test.ts
git commit -m "feat(agent): add config-driven handoff summarizer with redaction-before-distill"
```

---

## Task 3: Background distill runner (debounced, unref'd, semaphore)

**Files:**
- Create: `src/runtimes/agent/handoff-distill-runner.ts`
- Test: `tests/runtimes/agent/handoff-distill-runner.test.ts`

**Design:** A `HandoffDistillRunner` that, per conversation, decides on token growth whether to distill, holds a process-global in-flight counter (semaphore) passed to `runHandoffDistill`, persists via the injected store, and never runs two distills for one conversation concurrently. The timer is injected as `scheduleTick`/`now` so the loop is testable without wall-clock; the production wiring passes `setTimeout(...).unref()`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { HandoffDistillRunner } from '../../../src/runtimes/agent/handoff-distill-runner.ts';
import { initialDistillState, type DistillBudgetConfig } from '../../../src/runtimes/agent/handoff-distill-gate.ts';

const config: DistillBudgetConfig = { maxTokensPerWindow: 100_000, maxCallsPerWindow: 10, windowMs: 3_600_000, failureThreshold: 3, breakerCooldownMs: 60_000, globalConcurrency: 2 };

function harness(over: Partial<ConstructorParameters<typeof HandoffDistillRunner>[0]> = {}) {
  const persisted: unknown[] = [];
  const runner = new HandoffDistillRunner({
    config,
    now: () => 1000,
    growthThreshold: 500,
    tokenGrowth: () => 600, // past threshold
    distillFor: vi.fn(async () => ({ summary: 's', seededArtifacts: null, tokensUsed: 10 })),
    persist: (a) => persisted.push(a),
    onDegraded: vi.fn(),
    sourceFor: () => ({ provider: 'opencode-cli', model: 'deepseek-chat' }),
    ...over,
  });
  return { runner, persisted };
}

describe('HandoffDistillRunner', () => {
  it('distills a conversation whose tokens grew past threshold and persists one artifact', async () => {
    const { runner, persisted } = harness();
    await runner.tickConversation('c1');
    expect(persisted).toHaveLength(1);
  });

  it('does NOT distill (no model call) when growth is below threshold', async () => {
    const distillFor = vi.fn(async () => ({ summary: 's', seededArtifacts: null, tokensUsed: 1 }));
    const { runner, persisted } = harness({ tokenGrowth: () => 10, distillFor });
    await runner.tickConversation('c1');
    expect(distillFor).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
  });

  it('caps concurrency with the global semaphore (gate denies global-saturated)', async () => {
    const distillFor = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return { summary: 's', seededArtifacts: null, tokensUsed: 1 }; });
    const { runner } = harness({ distillFor, config: { ...config, globalConcurrency: 1 } });
    await Promise.all([runner.tickConversation('a'), runner.tickConversation('b')]);
    expect(distillFor.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtimes/agent/handoff-distill-runner.test.ts --pool=forks`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtimes/agent/handoff-distill-runner.ts
import { runHandoffDistill } from './handoff-distiller.ts';
import { initialDistillState, type DistillBudgetConfig, type DistillState } from './handoff-distill-gate.ts';
import type { DistillOutcome } from './handoff-distiller.ts';
import type { HandoffArtifact } from './handoff-prelude.ts';

export interface HandoffDistillRunnerDeps {
  config: DistillBudgetConfig;
  now: () => number;
  growthThreshold: number;
  tokenGrowth: (conversationKey: string) => number;
  distillFor: (conversationKey: string) => Promise<DistillOutcome>;
  persist: (artifact: HandoffArtifact) => void;
  onDegraded: (conversationKey: string, reason: string) => void;
  sourceFor: (conversationKey: string) => { provider: string; model: string | null };
}

export class HandoffDistillRunner {
  private states = new Map<string, DistillState>();
  private inFlight = new Set<string>();
  private globalInFlight = 0;

  constructor(private readonly deps: HandoffDistillRunnerDeps) {}

  async tickConversation(conversationKey: string): Promise<void> {
    if (this.inFlight.has(conversationKey)) return; // per-conversation serialisation
    if (this.deps.tokenGrowth(conversationKey) < this.deps.growthThreshold) return;

    this.inFlight.add(conversationKey);
    this.globalInFlight += 1;
    try {
      const state = this.states.get(conversationKey) ?? initialDistillState(this.deps.now());
      const source = this.deps.sourceFor(conversationKey);
      const result = await runHandoffDistill({
        state, config: this.deps.config, now: this.deps.now(),
        globalInFlight: this.globalInFlight - 1, // exclude self
        conversationKey, sourceProvider: source.provider, sourceModel: source.model,
        tokenBaseline: this.deps.tokenGrowth(conversationKey),
        distill: () => this.deps.distillFor(conversationKey),
        persist: this.deps.persist,
        onDegraded: (reason) => this.deps.onDegraded(conversationKey, reason),
      });
      this.states.set(conversationKey, result.nextState);
    } finally {
      this.globalInFlight -= 1;
      this.inFlight.delete(conversationKey);
    }
  }
}
```

> Note: the global semaphore is enforced by `evaluateDistillGate`'s `global-saturated` deny when `globalInFlight >= globalConcurrency`. The test's `<= 1` assertion holds because the second concurrent tick sees `globalInFlight - 1 === 1 >= 1` and is denied before calling `distillFor`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runtimes/agent/handoff-distill-runner.test.ts --pool=forks`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtimes/agent/handoff-distill-runner.ts tests/runtimes/agent/handoff-distill-runner.test.ts
git commit -m "feat(agent): add background handoff distill runner with per-conversation + global gating"
```

---

## Task 4: System-prompt injection seam

**Files:**
- Modify: `src/runtimes/agent/session.ts` (`buildSystemPrompt`, ~562; `SessionManagerOptions`)
- Test: `tests/runtimes/agent/session-prompt-composition.test.ts` (extend)

**Design:** Add optional `handoffSystemBlock?: () => string | null` to `SessionManagerOptions`. In `buildSystemPrompt`, after `transportPrelude` and before `configSystemPrompt`, push the block when it returns non-null. The runtime supplies a closure that returns `buildHandoffPrelude(...).systemBlock` only when `WHATSOUP_HANDOFF_CONTEXT` is on, a fresh artifact exists, and `seamForProvider(provider) === 'system'`. With the flag off the closure is absent → byte-identical prompt.

- [ ] **Step 1: Write the failing test** (extend the existing suite)

```ts
it('injects the handoff system block after the transport prelude when provided', () => {
  const mgr = makeSessionManager({ handoffSystemBlock: () => '[Handoff context — prior conversation summary]\nUser is mid-migration.' });
  const prompt = mgr.buildSystemPrompt();
  expect(prompt).toContain('User is mid-migration.');
  expect(prompt.indexOf('personal')).toBeLessThan(prompt.indexOf('User is mid-migration.')); // after transport prelude
});

it('is byte-identical to baseline when no handoff block is supplied', () => {
  const baseline = makeSessionManager({}).buildSystemPrompt();
  const withNullBlock = makeSessionManager({ handoffSystemBlock: () => null }).buildSystemPrompt();
  expect(withNullBlock).toBe(baseline);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtimes/agent/session-prompt-composition.test.ts --pool=forks`
Expected: FAIL (option unknown / block not injected). Adjust `makeSessionManager` helper to pass the new option.

- [ ] **Step 3: Write minimal implementation** (in `session.ts`)

```ts
// In SessionManagerOptions: add
handoffSystemBlock?: () => string | null;
// In constructor: this.handoffSystemBlock = opts.handoffSystemBlock;
// In buildSystemPrompt(), immediately after `const sources = [transportPrelude];`:
const handoffBlock = this.handoffSystemBlock?.();
if (handoffBlock) {
  sources.push(handoffBlock);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runtimes/agent/session-prompt-composition.test.ts --pool=forks`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/runtimes/agent/session.ts tests/runtimes/agent/session-prompt-composition.test.ts
git commit -m "feat(agent): inject optional handoff system block into buildSystemPrompt"
```

---

## Task 5: Runtime wiring + flags + schema + degradation alert

**Files:**
- Modify: `src/runtimes/agent/runtime.ts` (flag helpers near ~164; `ensureHandoffArtifactSchema` in `start()` ~2624; runner construction; `handoffSystemBlock` closure passed to SessionManager; degradation alert)
- Test: `tests/runtimes/agent/provider-fallback.test.ts` (extend — flag-off inert; flag-on injects)

- [ ] **Step 1: Write the failing test**

```ts
it('handoff distiller flags default off → no artifact schema reliance, byte-identical fallback', () => {
  // Build runtime without WHATSOUP_HANDOFF_* env; assert getFallbackState()/emission unchanged.
  // (mirror an existing provider-fallback equivalence test; assert no handoff system block is injected)
});
it('with WHATSOUP_HANDOFF_CONTEXT on and a fresh artifact, the stand-in system prompt carries the summary', () => {
  // upsert a fresh artifact; set the flag; spawn a fallback session; assert buildSystemPrompt contains the summary header
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtimes/agent/provider-fallback.test.ts --pool=forks`
Expected: FAIL (flag/closure not wired).

- [ ] **Step 3: Write minimal implementation** (in `runtime.ts`)

```ts
// Flag helpers (mirror responseRegistryDispatchEnabled())
private handoffDistillerEnabled(): boolean { return process.env.WHATSOUP_HANDOFF_DISTILLER === '1'; }
private handoffContextEnabled(): boolean { return process.env.WHATSOUP_HANDOFF_CONTEXT === '1'; }
private handoffDistillModel(): string | null { return process.env.WHATSOUP_HANDOFF_DISTILL_MODEL?.trim() || null; }

// In start(), beside ensureStandbyNoticeSchema(this.db):
ensureHandoffArtifactSchema(this.db);

// The closure handed to SessionManager (only meaningful when flag on):
private buildHandoffSystemBlock(conversationKey: string, provider: AgentProvider): (() => string | null) | undefined {
  if (!this.handoffContextEnabled()) return undefined;        // flag off → byte-identical
  if (seamForProvider(provider) !== 'system') return undefined; // routed elsewhere
  return () => {
    const artifact = getHandoffArtifact(this.db, conversationKey);
    if (!artifact) return null;
    return buildHandoffPrelude({
      artifact, recentMessages: [], verbatimN: 0, isFirstStandInTurn: true,
      backupContextWindow: 'unknown', now: Date.now(), staleAfterMs: HANDOFF_STALE_MS,
      redact: (t) => sanitizeProviderPreviewText(t),
    }).systemBlock;
  };
}

// Degradation alert when a distill folds to failure (passed as runner.onDegraded):
private onHandoffDegraded(conversationKey: string, reason: string): void {
  this.emitBotErrorAlert({ kind: 'WarmHandoffDegraded', conversationKey, reason: sanitizeProviderPreviewText(reason) });
}
```

> The distiller runner is constructed only when `handoffDistillerEnabled()`; its `distillFor` resolves `handoffDistillModel()` → endpoint+key via `provider-key-service`/`credential-verify`, throwing `HandoffSummarizerInertError` (caught → verbatim-only) when unset. Wire `runner.tickConversation` onto the existing per-conversation message-arrival debounce; the timer uses `setTimeout(...).unref?.()`.

- [ ] **Step 4: Run test to verify it passes + full equivalence**

Run: `npx vitest run tests/runtimes/agent/provider-fallback.test.ts tests/runtimes/agent/fallback-usage-limit-cascade.test.ts --pool=forks`
Expected: PASS (flag-off equivalence intact; flag-on injection works).

- [ ] **Step 5: Commit**

```bash
git add src/runtimes/agent/runtime.ts tests/runtimes/agent/provider-fallback.test.ts
git commit -m "feat(agent): wire handoff distiller runner + system-block injection behind flags"
```

---

## Task 6: Telemetry, /health, and runbook co-update

**Files:**
- Modify: `src/runtimes/agent/runtime.ts` (Pino logs per distill; additive `getFallbackState()` field `handoffDistiller`)
- Modify: `docs/runbooks/error-response-workflows.md` (move distiller to live)
- Modify: `docs/configuration.md` (document the three flags)
- Test: `tests/runtimes/agent/health-snapshot.test.ts` (additive field)

- [ ] **Step 1: Write the failing test**

```ts
it('exposes additive handoffDistiller state in getFallbackState', () => {
  // assert getFallbackState() includes { handoffDistiller: { enabled: boolean, lastOutcome: ... } }
  // update expectedFallbackDetails() helper (toStrictEqual) with the new field
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtimes/agent/health-snapshot.test.ts --pool=forks`
Expected: FAIL (field absent).

- [ ] **Step 3: Add the additive field + structured logs**

```ts
// In getFallbackState() return object, additively:
handoffDistiller: { enabled: this.handoffDistillerEnabled(), contextInjection: this.handoffContextEnabled(), model: this.handoffDistillModel() },
// Per distill, log: this.log.info({ conversationKey, tokensUsed, ran, denied, breaker }, 'handoff_distill');
```

- [ ] **Step 4: Run test + update docs**

Run: `npx vitest run tests/runtimes/agent/health-snapshot.test.ts tests/core/health.test.ts --pool=forks`
Expected: PASS. Then edit `docs/runbooks/error-response-workflows.md` "Built but not yet wired" → move the distiller/prelude bullets into a live "Warm handoff distiller" section describing the flags; add the three flags to `docs/configuration.md`.

- [ ] **Step 5: Commit**

```bash
git add src/runtimes/agent/runtime.ts tests/runtimes/agent/health-snapshot.test.ts docs/runbooks/error-response-workflows.md docs/configuration.md
git commit -m "feat(agent): handoff distiller telemetry + health field; runbook/config co-update"
```

---

## Task 7: Publication-audit registration + full gate

**Files:**
- Modify: `docs/publication-audit.md` (register any new tracked doc; bump counts) — **only if** new docs land under a tracked root. The spec/plan live in gitignored `docs/specs`/`docs/superpowers`; the runbook/config edits are existing rows.

- [ ] **Step 1:** Run `npm run guard:publication:all` (the CI-only `--all` variant local gate skips). If it reports `audit-missing-row`/`audit-tracked-count-mismatch`, add the row + bump `**Total classification rows:**`, the `PRIVATE-ARCHIVE`, and `Total` counts (see `feedback_whatsoup_local_gate_omits_python_coverage`).
- [ ] **Step 2:** Run the CI-equivalent pre-flight under node 24.15.0:
  `npm run typecheck:all && npm run guard:publication:all && npm run coverage:check -- --pool=forks && npm test -- --pool=forks`
  Expected: all green; coverage ≥ ratcheted thresholds (88/80/87 as of #932).
- [ ] **Step 3:** Run `npm run verify:push:branch`. Expected: pass.
- [ ] **Step 4: Commit any audit/doc fixes**

```bash
git add docs/publication-audit.md
git commit -m "docs: register handoff distiller docs in publication audit"
```

---

## Self-Review notes

- **Spec coverage:** ① experiment (done, evidence committed) → routing Task 1; summarizer + redaction Task 2; loop + gate + semaphore Task 3; system-seam Task 4; flags + schema + degradation alert Task 5; telemetry/health/runbook Task 6; CI-gap publication-audit Task 7. First-turn injection is **intentionally omitted** (YAGNI) — experiment locked all providers to `system`; `seamForProvider`'s `'first-turn'` default is the documented extension point if a future provider needs it.
- **Type consistency:** uses verified core signatures (`runHandoffDistill`, `evaluateDistillGate`, `buildHandoffPrelude`, `getHandoffArtifact`); `DistillOutcome`/`HandoffArtifact`/`DistillState` imported, never redefined.
- **Equivalence:** every flag defaults off; Task 4/5 assert byte-identical baseline; existing `provider-fallback`/`fallback-usage-limit-cascade` suites are the gate.
- **Open verification at execution:** confirm `AGENT_PROVIDERS` is an exported runtime array in `providers/types.ts` (Task 1 Step 2); confirm `emitBotErrorAlert`/`sanitizeProviderPreviewText`/`HANDOFF_STALE_MS` names against runtime.ts before Task 5 (do not fabricate — grep first).
