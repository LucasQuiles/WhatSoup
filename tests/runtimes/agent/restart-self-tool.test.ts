import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import {
  buildRestartSelfTool,
  deliverOwedReplyBeforeRestart,
  triggerSelfRestart,
  _resetSelfRestartGuard,
  type IntentionalRestartMarker,
  type RestartSelfToolDeps,
  type TriggerSelfRestartOptions,
} from '../../../src/runtimes/agent/self-restart.ts';
import { OutboundQueue, SALVAGED_REPLY_NOTICE } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

function deps(overrides: Partial<RestartSelfToolDeps> = {}): {
  deps: RestartSelfToolDeps;
  trigger: ReturnType<typeof vi.fn>;
  sendAck: ReturnType<typeof vi.fn>;
  deliverOwedReply: ReturnType<typeof vi.fn>;
  serviceManager: { restartSelf: ReturnType<typeof vi.fn> };
} {
  const trigger = vi.fn(async (_opts: TriggerSelfRestartOptions) => ({ ok: true, markerPath: '/d/m' }));
  const sendAck = vi.fn(async (_chatJid: string, _text: string) => {});
  const deliverOwedReply = vi.fn(async () => {});
  const serviceManager = { restartSelf: vi.fn(async (_name: string) => {}) };
  const base: RestartSelfToolDeps = {
    instanceName: 'q',
    dataRoot: '/data/q',
    resolveChatJid: () => '1111111000000000@g.us',
    deliverOwedReply,
    sendAck,
    serviceManager,
    trigger,
    assertAdmin: () => {}, // gate covered separately in restart-self-admin-gate.test.ts
    ...overrides,
  };
  return { deps: base, trigger, sendAck, deliverOwedReply, serviceManager };
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

  describe('with the real trigger', () => {
    let dataRoot: string;

    beforeEach(() => {
      dataRoot = mkdtempSync(join(tmpdir(), 'restart-self-tool-'));
      _resetSelfRestartGuard();
    });

    afterEach(() => {
      rmSync(dataRoot, { recursive: true, force: true });
      _resetSelfRestartGuard();
    });

    // #3829: a DM addressed by its @lid JID got no "back online" notice.
    it('acks an @lid DM and keeps it in the marker for the back-online notice', async () => {
      const lidJid = '111111100000001@lid';
      const { deps: d, sendAck, serviceManager } = deps({
        dataRoot,
        resolveChatJid: () => lidJid,
        trigger: triggerSelfRestart,
      });

      const result = await buildRestartSelfTool(d).handler({ reason: 'load merged main' }, SESSION);

      expect(result).toMatchObject({ ok: true, restarting: true });
      expect(sendAck).toHaveBeenCalledTimes(1);
      expect(sendAck.mock.calls[0][0]).toBe(lidJid);
      expect(serviceManager.restartSelf).toHaveBeenCalledWith('q');
      const marker = JSON.parse(
        readFileSync(join(dataRoot, 'intentional-restart.marker'), 'utf-8'),
      ) as IntentionalRestartMarker;
      expect(marker.chatJid).toBe(lidJid);
    });

    it('stays a no-op on a repeat call in the same process', async () => {
      const { deps: d, serviceManager } = deps({ dataRoot, trigger: triggerSelfRestart });
      const tool = buildRestartSelfTool(d);

      const first = await tool.handler({ reason: 'first' }, SESSION);
      const second = await tool.handler({ reason: 'second' }, SESSION);

      expect(first).toMatchObject({ ok: true, restarting: true });
      expect(second).toMatchObject({ ok: false, restarting: false });
      expect(serviceManager.restartSelf).toHaveBeenCalledTimes(1);
    });

    it('delivers owed text before the ack and before restartSelf', async () => {
      const order: string[] = [];
      const { deps: d } = deps({
        dataRoot,
        trigger: triggerSelfRestart,
        deliverOwedReply: vi.fn(async () => { order.push('owed'); }),
        sendAck: vi.fn(async () => { order.push('ack'); }),
        serviceManager: { restartSelf: vi.fn(async () => { order.push('restartSelf'); }) },
      });

      await buildRestartSelfTool(d).handler({ reason: 'r' }, SESSION);

      expect(order).toEqual(['owed', 'ack', 'restartSelf']);
    });

    it('still restarts when delivering the owed text fails', async () => {
      const { deps: d, serviceManager } = deps({
        dataRoot,
        trigger: triggerSelfRestart,
        deliverOwedReply: vi.fn(async () => { throw new Error('queue poisoned'); }),
      });

      const result = await buildRestartSelfTool(d).handler({ reason: 'r' }, SESSION);

      expect(result).toMatchObject({ ok: true, restarting: true });
      expect(serviceManager.restartSelf).toHaveBeenCalledTimes(1);
    });

    // #3829 (21:22Z case): minimal mode deferred the model's pre-tool text at the
    // restart_self tool boundary, and the shutdown abort destroyed it unsent.
    it('sends the deferred pre-tool text through the salvage path before restartSelf', async () => {
      const order: string[] = [];
      const sent: string[] = [];
      const messenger: Messenger = {
        sendMessage: vi.fn(async (_jid: string, text: string) => {
          order.push('send');
          sent.push(text);
          return { waMessageId: null };
        }),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
        setTyping: vi.fn(async () => {}),
      };
      const queue = new OutboundQueue(messenger, '15550100111@s.whatsapp.net');
      queue.setToolUpdateMode('minimal');
      queue.enqueueStreamingText('Restarting now to load the fix.', 'answer');
      queue.discardPreToolAssistantText();
      expect(sent).toEqual([]);

      const { deps: d } = deps({
        dataRoot,
        trigger: triggerSelfRestart,
        deliverOwedReply: () => deliverOwedReplyBeforeRestart(queue),
        serviceManager: { restartSelf: vi.fn(async () => { order.push('restartSelf'); }) },
      });

      await buildRestartSelfTool(d).handler({ reason: 'r' }, SESSION);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(SALVAGED_REPLY_NOTICE);
      expect(sent[0]).toContain('Restarting now to load the fix.');
      expect(order).toEqual(['send', 'restartSelf']);
    });

    it('sends buffered streaming text as a normal message before restartSelf', async () => {
      const sent: string[] = [];
      const messenger: Messenger = {
        sendMessage: vi.fn(async (_jid: string, text: string) => {
          sent.push(text);
          return { waMessageId: null };
        }),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
        setTyping: vi.fn(async () => {}),
      };
      const queue = new OutboundQueue(messenger, '15550100111@s.whatsapp.net');
      queue.enqueueStreamingText('On it, restarting.', 'answer');

      await deliverOwedReplyBeforeRestart(queue);

      expect(sent).toEqual(['On it, restarting.']);
    });
  });
});
