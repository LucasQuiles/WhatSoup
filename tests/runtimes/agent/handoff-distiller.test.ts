import { describe, expect, it, vi } from 'vitest';

import { runHandoffDistill, type RunHandoffDistillDeps } from '../../../src/runtimes/agent/handoff-distiller.ts';
import { initialDistillState, type DistillBudgetConfig, type DistillState } from '../../../src/runtimes/agent/handoff-distill-gate.ts';
import type { HandoffArtifact } from '../../../src/runtimes/agent/handoff-prelude.ts';

const NOW = 1_781_000_000_000;

const CONFIG: DistillBudgetConfig = {
  maxTokensPerWindow: 10_000,
  maxCallsPerWindow: 3,
  windowMs: 60_000,
  failureThreshold: 2,
  breakerCooldownMs: 30_000,
  globalConcurrency: 2,
};

function deps(over: Partial<RunHandoffDistillDeps> = {}): RunHandoffDistillDeps & { persisted: HandoffArtifact[]; degraded: string[] } {
  const persisted: HandoffArtifact[] = [];
  const degraded: string[] = [];
  return {
    state: initialDistillState(NOW),
    config: CONFIG,
    now: NOW,
    globalInFlight: 0,
    conversationKey: 'c1',
    sourceProvider: 'claude-cli',
    sourceModel: 'claude-opus-4-8',
    tokenBaseline: 1000,
    distill: async () => ({ summary: 'a summary', tokensUsed: 500 }),
    persist: (a) => { persisted.push(a); },
    onDegraded: (r) => { degraded.push(r); },
    persisted,
    degraded,
    ...over,
  };
}

describe('runHandoffDistill', () => {
  it('persists an artifact and counts spend on success', async () => {
    const d = deps();
    const r = await runHandoffDistill(d);
    expect(r).toMatchObject({ ran: true, denied: null, failed: false });
    expect(d.persisted).toHaveLength(1);
    expect(d.persisted[0]).toMatchObject({ conversationKey: 'c1', summary: 'a summary', updatedAt: NOW, tokenBaseline: 1000 });
    expect(r.nextState.tokensThisWindow).toBe(500);
    expect(r.nextState.callsThisWindow).toBe(1);
    expect(d.degraded).toHaveLength(0);
  });

  it('does not call the model when the gate denies (budget spent)', async () => {
    const distill = vi.fn(async () => ({ summary: 's', tokensUsed: 1 }));
    const spent: DistillState = { ...initialDistillState(NOW), tokensThisWindow: 10_000 };
    const d = deps({ state: spent, distill });
    const r = await runHandoffDistill(d);
    expect(r).toMatchObject({ ran: false, denied: 'budget-tokens', failed: false });
    expect(distill).not.toHaveBeenCalled();
    expect(d.persisted).toHaveLength(0);
  });

  it('denies on global saturation without calling the model', async () => {
    const distill = vi.fn(async () => ({ summary: 's', tokensUsed: 1 }));
    const d = deps({ globalInFlight: 5, distill });
    const r = await runHandoffDistill(d);
    expect(r.denied).toBe('global-saturated');
    expect(distill).not.toHaveBeenCalled();
  });

  it('folds a thrown distill as a failure: no persist, degradation signalled', async () => {
    const d = deps({ distill: async () => { throw new Error('model exploded'); } });
    const r = await runHandoffDistill(d);
    expect(r).toMatchObject({ ran: false, denied: null, failed: true });
    expect(d.persisted).toHaveLength(0);
    expect(r.nextState.consecutiveFailures).toBe(1);
    expect(d.degraded[0]).toContain('handoff distill failed');
  });

  it('advances the breaker to open after the consecutive-failure threshold', async () => {
    let state = initialDistillState(NOW);
    const failing = async () => { throw new Error('boom'); };
    let r = await runHandoffDistill(deps({ state, distill: failing }));
    state = r.nextState;
    expect(state.breaker).toBe('closed'); // 1 < threshold 2
    r = await runHandoffDistill(deps({ state, distill: failing, now: NOW + 1 }));
    expect(r.nextState.breaker).toBe('open');
  });

  it('carries seededArtifacts through to the persisted artifact', async () => {
    const d = deps({ distill: async () => ({ summary: 's', seededArtifacts: 'open PRs: #1', tokensUsed: 10 }) });
    await runHandoffDistill(d);
    expect(d.persisted[0]?.seededArtifacts).toBe('open PRs: #1');
  });
});
