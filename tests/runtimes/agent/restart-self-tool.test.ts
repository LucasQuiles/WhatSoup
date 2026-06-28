import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRestartSelfTool,
  type RestartSelfToolDeps,
  type TriggerSelfRestartOptions,
} from '../../../src/runtimes/agent/self-restart.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

function deps(overrides: Partial<RestartSelfToolDeps> = {}): {
  deps: RestartSelfToolDeps;
  trigger: ReturnType<typeof vi.fn>;
  sendAck: ReturnType<typeof vi.fn>;
  serviceManager: { restart: ReturnType<typeof vi.fn> };
} {
  const trigger = vi.fn(async (_opts: TriggerSelfRestartOptions) => ({ ok: true, markerPath: '/d/m' }));
  const sendAck = vi.fn(async (_chatJid: string, _text: string) => {});
  const serviceManager = { restart: vi.fn(async (_name: string) => {}) };
  const base: RestartSelfToolDeps = {
    instanceName: 'q',
    dataRoot: '/data/q',
    resolveChatJid: () => '1111111000000000@g.us',
    sendAck,
    serviceManager,
    trigger,
    ...overrides,
  };
  return { deps: base, trigger, sendAck, serviceManager };
}

const SESSION: SessionContext = { tier: 'admin' as SessionContext['tier'] };

describe('restart_self MCP tool', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('declares the tool with the expected metadata', () => {
    const tool = buildRestartSelfTool(deps().deps);
    expect(tool.name).toBe('restart_self');
    expect(tool.scope).toBe('global');
    expect(tool.replayPolicy).toBe('unsafe');
    expect(tool.core).toBe(false);
  });

  it('rejects an empty reason', () => {
    const tool = buildRestartSelfTool(deps().deps);
    const parsed = tool.schema.safeParse({ reason: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing reason', () => {
    const tool = buildRestartSelfTool(deps().deps);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  it('rejects an invalid code', () => {
    const tool = buildRestartSelfTool(deps().deps);
    expect(tool.schema.safeParse({ reason: 'r', code: 'nope' }).success).toBe(false);
  });

  it('sends an ack and triggers a restart with the resolved chat + instance', async () => {
    const { deps: d, trigger, sendAck, serviceManager } = deps();
    const tool = buildRestartSelfTool(d);

    await tool.handler({ reason: 'load merged main', code: 'redeploy' }, SESSION);

    expect(sendAck).toHaveBeenCalledTimes(1);
    const [ackJid, ackText] = sendAck.mock.calls[0];
    expect(ackJid).toBe('1111111000000000@g.us');
    expect(ackText).toContain('load merged main');

    expect(trigger).toHaveBeenCalledTimes(1);
    const opts = trigger.mock.calls[0][0] as TriggerSelfRestartOptions;
    expect(opts.instance).toBe('q');
    expect(opts.dataRoot).toBe('/data/q');
    expect(opts.reason).toBe('load merged main');
    expect(opts.code).toBe('redeploy');
    expect(opts.chatJid).toBe('1111111000000000@g.us');
    expect(opts.requestedBy).toBe('agent');
    // The injected (fleet-owned) restarter is forwarded to the trigger, not
    // constructed inside the tool — keeps the runtimes layer off the fleet layer.
    expect(opts.serviceManager).toBe(serviceManager);
  });

  it('triggers without a chatJid when none can be resolved (no ack)', async () => {
    const { deps: d, trigger, sendAck } = deps({ resolveChatJid: () => undefined });
    const tool = buildRestartSelfTool(d);

    await tool.handler({ reason: 'r' }, SESSION);

    expect(sendAck).not.toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledTimes(1);
    const opts = trigger.mock.calls[0][0] as TriggerSelfRestartOptions;
    expect(opts.chatJid).toBeUndefined();
    expect(opts.reason).toBe('r');
  });
});
