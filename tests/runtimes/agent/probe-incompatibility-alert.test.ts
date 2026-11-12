/**
 * The `primary_model_probe_incompatible` alert reports a claude CLI that lacks
 * --strict-mcp-config. Only a usable model probe proves that the CLI accepts the
 * option: the model child ran with it and succeeded. A turn success, a probe
 * deferred behind a refresh-ahead child and a timed-out probe prove nothing about
 * the option, so none of them clears the alert.
 *
 * The alert flag follows the checked emit and clear results: a failed raise is
 * retried by the next incompatible probe, and a failed clear leaves the alert
 * open until a later usable probe clears it.
 *
 * Harness as in probe-timeout-retry.test.ts. The checked alert functions return
 * booleans here, because the runtime stores their results as the alert flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../../helpers/logger-mock.ts');
  const runtimeLogger = singletonLoggerMock();
  return {
    default: { ...runtimeLogger, child: () => runtimeLogger },
    createChildLogger: () => runtimeLogger,
    flushLogger: () => Promise.resolve(),
  };
});

vi.mock('../../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/emit-alert.ts')>(),
  emitAlert: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  emitAlertChecked: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { Database } from '../../../src/core/database.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import {
  CLAUDE_CLI_LACKS_STRICT_MCP_CONFIG,
  DEFERRED_REFRESH_IN_FLIGHT,
  type PrimaryModelUsabilityResult,
} from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import { makeRuntimeState, type RuntimeState } from './lib/runtime-terminal-coordinator-harness.ts';

const START = 1_786_000_000_000;
const SOURCE = 'primary_model_probe_incompatible';
const LACKS: PrimaryModelUsabilityResult = {
  status: 'unknown',
  provider: 'claude-cli',
  model: 'm',
  reason: CLAUDE_CLI_LACKS_STRICT_MCP_CONFIG,
};
const USABLE: PrimaryModelUsabilityResult = { status: 'usable', provider: 'claude-cli', model: 'm' };
// The shape runtime.ts records after a successful turn (source 'turn-success').
const TURN_SUCCESS: PrimaryModelUsabilityResult = { status: 'usable', provider: 'claude-cli', model: 'm', reason: 'turn-success' };
const DEFERRED: PrimaryModelUsabilityResult = {
  status: 'unknown',
  provider: 'claude-cli',
  model: 'm',
  reason: DEFERRED_REFRESH_IN_FLIGHT,
};
const TIMEOUT: PrimaryModelUsabilityResult = { status: 'timeout', provider: 'claude-cli', model: 'm', reason: 'probe-timeout' };

type UsabilitySource = 'probe' | 'turn-success';
type IncompatibilityState = RuntimeState & {
  fallback: {
    recordPrimaryModelUsability(
      result: PrimaryModelUsabilityResult,
      trigger: 'startup' | 'manual' | 'periodic',
      source?: UsabilitySource,
    ): void;
  };
};

describe('primary_model_probe_incompatible: only a usable model probe clears the alert', () => {
  let db: Database;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    db = new Database(':memory:');
    db.open();
    // Reset call history and any leftover one-shot results between cases.
    vi.mocked(emitAlertChecked).mockReset().mockReturnValue(true);
    vi.mocked(clearAlertSourceChecked).mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    db.close();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function recorder(): (result: PrimaryModelUsabilityResult, source?: UsabilitySource) => void {
    const { state } = makeRuntimeState<IncompatibilityState>(db);
    return (result, source = 'probe') => state.fallback.recordPrimaryModelUsability(result, 'manual', source);
  }
  // Other alert sources (primary_model_unusable) share these functions and are not counted.
  const raises = (): number => vi.mocked(emitAlertChecked).mock.calls.filter(([, source]) => source === SOURCE).length;
  const clears = (): number => vi.mocked(clearAlertSourceChecked).mock.calls.filter(([, source]) => source === SOURCE).length;

  it('a: a turn success neither clears the alert nor lets the next incompatible probe raise it again', () => {
    const record = recorder();
    record(LACKS);
    record(TURN_SUCCESS, 'turn-success');
    record(LACKS);
    expect(raises()).toBe(1);
    expect(clears()).toBe(0);
  });

  it('b: a probe deferred behind a refresh-ahead child does not clear the alert', () => {
    const record = recorder();
    record(LACKS);
    record(DEFERRED);
    expect(raises()).toBe(1);
    expect(clears()).toBe(0);
  });

  it('c: a timed-out probe does not clear the alert', () => {
    const record = recorder();
    record(LACKS);
    record(TIMEOUT);
    expect(raises()).toBe(1);
    expect(clears()).toBe(0);
  });

  it('d: a usable probe clears the alert once', () => {
    const record = recorder();
    record(LACKS);
    record(USABLE);
    expect(raises()).toBe(1);
    expect(clears()).toBe(1);
  });

  it('e: a raise that was not queued is retried by the next incompatible probe, and only once queued', () => {
    const record = recorder();
    vi.mocked(emitAlertChecked).mockReturnValueOnce(false);
    record(LACKS);
    record(LACKS);
    record(LACKS);
    expect(raises()).toBe(2);
  });

  it('f: a clear that was not queued is retried by the next usable probe', () => {
    const record = recorder();
    record(LACKS);
    vi.mocked(clearAlertSourceChecked).mockReturnValueOnce(false);
    record(USABLE);
    record(USABLE);
    expect(clears()).toBe(2);
  });

  it('g: a clear that was not queued keeps the alert open, so a later incompatible probe does not raise it again', () => {
    const record = recorder();
    record(LACKS);
    vi.mocked(clearAlertSourceChecked).mockReturnValueOnce(false);
    record(USABLE);
    record(LACKS);
    expect(raises()).toBe(1);
  });
});
