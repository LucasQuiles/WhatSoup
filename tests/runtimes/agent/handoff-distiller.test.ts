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
    persist: (a) => { persisted.push(a); },
    onDegraded: (r) => { degraded.push(r); },
    persisted,
    degraded,
    ...over,
    distill: async (reserve) => {
      reserve(1_000);
      return over.distill ? over.distill(reserve) : { summary: 'a summary', tokensUsed: 500 };
    },
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

  it('folds a non-Error distill throw via String(err)', async () => {
    const d = deps({ distill: async () => { throw 'string-only blowup'; } });
    const r = await runHandoffDistill(d);
    expect(r).toMatchObject({ ran: false, denied: null, failed: true });
    expect(d.degraded[0]).toContain('string-only blowup');
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

  it('rejects invalid spend before persistence and folds it as a failed attempt', async () => {
    const d = deps({ distill: async () => ({ summary: 'must not persist', tokensUsed: NaN }) });
    const result = await runHandoffDistill(d);
    expect(result).toMatchObject({ ran: false, failed: true });
    expect(d.persisted).toHaveLength(0);
    expect(result.nextState.tokensThisWindow).toBe(1_000);
    expect(result.nextState.callsThisWindow).toBe(1);
    expect(d.degraded[0]).toMatch(/token usage/);
  });

  it('retains valid provider spend when persistence fails without double-counting the call', async () => {
    const d = deps({
      state: { ...initialDistillState(NOW), consecutiveFailures: 1 },
      persist: () => { throw new Error('storage unavailable'); },
    });
    const result = await runHandoffDistill(d);
    expect(result).toMatchObject({ ran: false, failed: true });
    expect(d.persisted).toHaveLength(0);
    expect(result.nextState).toMatchObject({ tokensThisWindow: 500, callsThisWindow: 1,
      consecutiveFailures: 2, breaker: 'open' });
    expect(d.degraded[0]).toContain('storage unavailable');
  });

});

describe('runHandoffDistill failure warn line', () => {
  // Built from parts so no credential-shaped literal sits in the source.
  const token = ['sk', 'test', 'abcdefghijklmnopqrstuvwx'].join('-');
  const bearerValue = ['abcdefghij', 'klmnop0123'].join('');

  function warnLines(warn: ReturnType<typeof vi.fn>): Array<[Record<string, unknown>, string]> {
    return warn.mock.calls as Array<[Record<string, unknown>, string]>;
  }

  it('logs one sanitized warn line per failure, with no path or secret in it', async () => {
    const warn = vi.fn();
    const d = deps({
      conversationKey: 'conversation-key-a',
      log: { warn },
      distill: async () => {
        throw new Error(
          `upstream refused Bearer ${bearerValue} reading /srv/app-a/state/session.json with ${token} ${'x'.repeat(400)}`,
        );
      },
    } as Partial<RunHandoffDistillDeps>);

    const result = await runHandoffDistill(d);

    expect(result).toMatchObject({ ran: false, failed: true });
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warnLines(warn)[0]!;
    expect(fields).toMatchObject({ event: 'handoff_distill_failed', reasonClass: 'provider' });
    expect(typeof fields.conversationKeyHash).toBe('string');
    expect(typeof fields.reason).toBe('string');
    expect((fields.reason as string).length).toBeLessThanOrEqual(160);
    const line = JSON.stringify([fields, message]);
    expect(line).not.toContain('conversation-key-a');
    expect(line).not.toContain('/srv/');
    expect(line).not.toContain('app-a');
    expect(line).not.toContain(token);
    expect(line).not.toContain(bearerValue);
  });

  it('classes a persistence failure as persist in its one warn line', async () => {
    const warn = vi.fn();
    const d = deps({
      log: { warn },
      persist: () => { throw new Error('storage unavailable'); },
    } as Partial<RunHandoffDistillDeps>);

    await runHandoffDistill(d);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnLines(warn)[0]![0]).toMatchObject({ event: 'handoff_distill_failed', reasonClass: 'persist' });
  });

  it('logs no warn line when the distill succeeds or the gate denies it', async () => {
    const warn = vi.fn();
    await runHandoffDistill(deps({ log: { warn } } as Partial<RunHandoffDistillDeps>));
    await runHandoffDistill(deps({ log: { warn }, globalInFlight: 5 } as Partial<RunHandoffDistillDeps>));
    expect(warn).not.toHaveBeenCalled();
  });
});
