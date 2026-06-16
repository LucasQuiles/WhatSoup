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
    tokenGrowth: () => 600,
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
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const distillFor = vi.fn(async () => { await gate; return { summary: 's', seededArtifacts: null, tokensUsed: 1 }; });
    const { runner } = harness({ distillFor, config: { ...config, globalConcurrency: 1 } });
    const a = runner.tickConversation('a');
    const b = runner.tickConversation('b');
    release();
    await Promise.all([a, b]);
    expect(distillFor.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
