import { afterEach, describe, expect, it, vi } from 'vitest';

const { createChildLogger } = vi.hoisted(() => ({
  createChildLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('../../../src/logger.ts', () => ({ createChildLogger }));

import { classifyToolError } from '../../../src/runtimes/agent/tool-update.ts';
import type { AlertEmissionResult } from '../../../src/lib/emit-alert.ts';
import {
  maybeEmitToolFailureAlert,
  TOOL_FAILURE_ALERT_DEDUP_MS,
  type ToolFailureAlertArgs,
  type ToolFailureAlertDeps,
} from '../../../src/runtimes/agent/tool-failure-alert.ts';

// Real classifier so the category/detail match what the runtime call site produces.
const ACTIONABLE_CONTENT = 'API Error 429: rate limit exceeded';
const BENIGN_CONTENT = 'grep: no matches found for pattern';
const DURABLY_QUEUED: AlertEmissionResult = {
  ok: true,
  channel: 'outbox',
  status: 'durably_queued',
  outbox: { eventId: 'fixture-event', path: '/tmp/fixture-event.json' },
};

function args(overrides: Partial<ToolFailureAlertArgs> = {}): ToolFailureAlertArgs {
  const toolName = overrides.toolName ?? 'Bash';
  const content = overrides.content ?? ACTIONABLE_CONTENT;
  return {
    chatJid: '15551230000@s.whatsapp.net',
    toolId: 'tool-1',
    toolName,
    content,
    classification: classifyToolError(toolName, content),
    toolScopeKey: 'scope#1',
    ...overrides,
  };
}

/** Evict-oldest cap matching the runtime's capDedupeMap contract. */
function makeCap(max: number): (map: Map<string, unknown>) => void {
  return (map) => {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
}

function makeDeps(overrides: Partial<ToolFailureAlertDeps> = {}): ToolFailureAlertDeps & { emitAlert: ReturnType<typeof vi.fn> } {
  return {
    instanceName: 'testinst',
    sessionScope: 'single',
    cwd: '/tmp/x',
    toolFailureAlertsEnabled: true,
    resolveProvider: () => 'claude-cli',
    recentToolFailureAlerts: new Map<string, number>(),
    capDedupeMap: makeCap(1_000),
    emitAlert: vi.fn(() => DURABLY_QUEUED),
    now: () => 1_000,
    ...overrides,
  } as ToolFailureAlertDeps & { emitAlert: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('maybeEmitToolFailureAlert', () => {
  it('preserves the agent-runtime component identity after extraction', () => {
    expect(createChildLogger).toHaveBeenCalledWith('agent-runtime');
  });

  it('emits one warning alert with the expected source, title, severity, and evidence', () => {
    const deps = makeDeps();
    maybeEmitToolFailureAlert(args(), deps);

    expect(deps.emitAlert).toHaveBeenCalledTimes(1);
    const [instance, source, title, evidence, severity] = deps.emitAlert.mock.calls[0]!;
    expect(instance).toBe('testinst');
    expect(source).toBe('runtime-tool-error:claude-cli:Bash');
    expect(title).toBe('Agent tool failure: Bash');
    expect(severity).toBe('warning');
    expect(evidence).toContain('runtime_source=src/runtimes/agent/runtime.ts:tool_result');
    expect(evidence).toContain('instance=testinst');
    expect(evidence).toContain('provider=claude-cli');
    expect(evidence).toContain('session_scope=single');
    // Only the durably accepted write consumes the dedup window.
    expect(deps.recentToolFailureAlerts.size).toBe(1);
  });

  it('suppresses a benign (non-actionable) execution error', () => {
    const deps = makeDeps();
    maybeEmitToolFailureAlert(args({ content: BENIGN_CONTENT }), deps);
    expect(deps.emitAlert).not.toHaveBeenCalled();
    expect(deps.recentToolFailureAlerts.size).toBe(0);
  });

  it('never pages a cancelled tool result', () => {
    const deps = makeDeps();
    // A cancelled classification, even with actionable-looking content, must not page.
    const classification = { ...classifyToolError('Grep', ACTIONABLE_CONTENT), category: 'cancelled' as const };
    maybeEmitToolFailureAlert(args({ toolName: 'Grep', classification }), deps);
    expect(deps.emitAlert).not.toHaveBeenCalled();
  });

  it('dedups an identical failure within the window (emits once)', () => {
    const deps = makeDeps();
    maybeEmitToolFailureAlert(args(), deps);
    maybeEmitToolFailureAlert(args(), deps);
    expect(deps.emitAlert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rejected', { ok: false, channel: 'none', status: 'failed', outboxError: 'ENOSPC' }],
    ['capture-only', { ok: true, channel: 'sink', status: 'captured' }],
    ['legacy-unconfirmed', { ok: true, channel: 'legacy', status: 'legacy_accepted_unconfirmed' }],
    ['missing result', undefined],
    ['inconsistent acceptance', { ok: false, channel: 'outbox', status: 'durably_queued' }],
  ])('retains retry eligibility after %s emission', (_label, result) => {
    const deps = makeDeps({ emitAlert: vi.fn().mockReturnValueOnce(result).mockReturnValue(DURABLY_QUEUED) });
    const failure = args({ content: 'ENOSPC: no space left on device' });

    maybeEmitToolFailureAlert(failure, deps);
    expect(deps.recentToolFailureAlerts.size).toBe(0);
    maybeEmitToolFailureAlert(failure, deps);
    maybeEmitToolFailureAlert(failure, deps);

    expect(deps.emitAlert).toHaveBeenCalledTimes(2);
    expect(deps.recentToolFailureAlerts.size).toBe(1);
  });

  it('does not evict accepted fingerprints while emission keeps failing', () => {
    const capDedupeMap = vi.fn(makeCap(1));
    const deps = makeDeps({ capDedupeMap });
    maybeEmitToolFailureAlert(args(), deps);
    deps.emitAlert.mockReturnValue({ ok: false, channel: 'none', status: 'failed' });
    const failing = args({ content: 'ENOSPC: no space left on device' });
    maybeEmitToolFailureAlert(failing, deps);
    maybeEmitToolFailureAlert(failing, deps);
    maybeEmitToolFailureAlert(args(), deps);

    expect(deps.emitAlert).toHaveBeenCalledTimes(3);
    expect(capDedupeMap).toHaveBeenCalledTimes(1);
    expect(deps.recentToolFailureAlerts.size).toBe(1);
  });

  it('re-emits once the dedup window has elapsed (window-prune)', () => {
    let clock = 1_000;
    const deps = makeDeps({ now: () => clock });
    maybeEmitToolFailureAlert(args(), deps);
    clock += TOOL_FAILURE_ALERT_DEDUP_MS + 1;
    maybeEmitToolFailureAlert(args(), deps);
    expect(deps.emitAlert).toHaveBeenCalledTimes(2);
  });

  it('bounds the dedup map via capDedupeMap across many distinct failures', () => {
    const deps = makeDeps({ capDedupeMap: makeCap(3) });
    for (let i = 0; i < 6; i++) {
      maybeEmitToolFailureAlert(args({ toolName: `Tool${i}` }), deps);
    }
    expect(deps.emitAlert).toHaveBeenCalledTimes(6);
    expect(deps.recentToolFailureAlerts.size).toBe(3);
  });

  it('is disabled when toolFailureAlertsEnabled is false (config kill-switch via DI)', () => {
    // The env var (BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS) is resolved by
    // config.ts into config.toolFailureAlertsEnabled and threaded through
    // deps — this module no longer reads process.env (#2192 slice 3a).
    const deps = makeDeps({ toolFailureAlertsEnabled: false });
    maybeEmitToolFailureAlert(args(), deps);
    expect(deps.emitAlert).not.toHaveBeenCalled();
  });

  it('swallows an emit failure without throwing into the caller', () => {
    const deps = makeDeps({
      emitAlert: vi.fn(() => { throw new Error('emit boom'); }),
    });
    expect(() => maybeEmitToolFailureAlert(args(), deps)).not.toThrow();
    expect(deps.emitAlert).toHaveBeenCalledTimes(1);
    expect(deps.recentToolFailureAlerts.size).toBe(0);
    deps.emitAlert.mockReturnValue(DURABLY_QUEUED);
    expect(() => maybeEmitToolFailureAlert(args(), deps)).not.toThrow();
    expect(deps.emitAlert).toHaveBeenCalledTimes(2);
  });
});
