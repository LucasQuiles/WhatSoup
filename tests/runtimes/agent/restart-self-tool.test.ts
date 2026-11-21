import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

import { emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import {
  buildRestartSelfTool,
  deliverOwedReplyBeforeRestart,
  triggerSelfRestart,
  _resetSelfRestartGuard,
  OWED_REPLY_FLUSH_GRACE_MS,
  type IntentionalRestartMarker,
  type OwedReplyDelivery,
  type RestartSelfToolDeps,
  type SelfRestartRefusal,
  type TriggerSelfRestartOptions,
} from '../../../src/runtimes/agent/self-restart.ts';
import { OutboundQueue, SALVAGED_REPLY_NOTICE, type IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { WhatSoupError } from '../../../src/errors.ts';

function deps(overrides: Partial<RestartSelfToolDeps> = {}): {
  deps: RestartSelfToolDeps;
  trigger: ReturnType<typeof vi.fn>;
  sendAck: ReturnType<typeof vi.fn>;
  deliverOwedReply: ReturnType<typeof vi.fn>;
  serviceManager: { restartSelf: ReturnType<typeof vi.fn> };
} {
  const trigger = vi.fn(async (_opts: TriggerSelfRestartOptions) => ({ ok: true, markerPath: '/d/m' }));
  const sendAck = vi.fn(async (_chatJid: string, _text: string) => {});
  const deliverOwedReply = vi.fn(async (): Promise<OwedReplyDelivery> => ({ delivered: true }));
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

const SESSION: SessionContext = { tier: 'global' };

interface RestartSelfResult {
  ok: boolean;
  restarting: boolean;
  cause?: string;
  text: string;
}

/** Queue double for the owed-reply flush: only the members deliverOwedReplyBeforeRestart uses. */
function flushQueue(flush: () => Promise<void>): IOutboundQueue {
  return {
    targetChatJid: '15550100111@s.whatsapp.net',
    commitStreamingText: vi.fn(),
    abortTurn: vi.fn(),
    flush: vi.fn(flush),
    getSendFailureCount: vi.fn(() => 0),
  } as unknown as IOutboundQueue;
}

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
      // The module mock keeps its calls across tests; each test sees only its own alerts.
      vi.mocked(emitAlertChecked).mockClear();
    });

    afterEach(() => {
      rmSync(dataRoot, { recursive: true, force: true });
      _resetSelfRestartGuard();
    });

    // #3829: a DM addressed by its @lid JID got no "back online" notice.
    it('acks an @lid DM and keeps it in the marker for the back-online notice', async () => {
      const lidJid = '111111100000001@lid';
      const { deps: d, sendAck, serviceManager } = deps({
        instanceName: 'bot-a',
        dataRoot,
        resolveChatJid: () => lidJid,
        trigger: triggerSelfRestart,
      });

      const result = await buildRestartSelfTool(d).handler({ reason: 'load merged main' }, SESSION);

      expect(result).toMatchObject({ ok: true, restarting: true });
      expect(sendAck).toHaveBeenCalledTimes(1);
      expect(sendAck.mock.calls[0][0]).toBe(lidJid);
      expect(serviceManager.restartSelf).toHaveBeenCalledWith('bot-a');
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
        deliverOwedReply: vi.fn(async (): Promise<OwedReplyDelivery> => { order.push('owed'); return { delivered: true }; }),
        sendAck: vi.fn(async () => { order.push('ack'); }),
        serviceManager: { restartSelf: vi.fn(async () => { order.push('restartSelf'); }) },
      });

      await buildRestartSelfTool(d).handler({ reason: 'r' }, SESSION);

      expect(order).toEqual(['owed', 'ack', 'restartSelf']);
    });

    // restart_self refuses every job that the manager's restartSelf would refuse
    // before anything is sent, written, alerted or stopped. kickstart -k would
    // stop a release-pinned launchd job before the launcher's boot checks run.
    // The other causes would otherwise reach restartSelf's refusal only after the
    // owed reply, the turn abort, the ack, the marker and the alert.
    const NOT_RESTARTED = 'so the service was not restarted for: load merged main.';
    const refusals: Array<[string, SelfRestartRefusal, string]> = [
      ['a validated release-pinned plist', 'release_pinned',
        `Restart not started: this job is release-pinned, ${NOT_RESTARTED} Restart a release-pinned job through the release procedure.`],
      ['an unreadable plist', 'plist_unreadable',
        `Restart not started: the service manager would refuse to restart this job (plist_unreadable), ${NOT_RESTARTED}`],
      // The manager answers plist_not_owned for an unowned plist and for a direct
      // release-launcher plist whose release cannot be validated.
      ['a plist the manager does not own, such as an unvalidated release pin', 'plist_not_owned',
        `Restart not started: the service manager would refuse to restart this job (plist_not_owned), ${NOT_RESTARTED}`],
      ['an absent plist', 'plist_absent',
        `Restart not started: the service manager would refuse to restart this job (plist_absent), ${NOT_RESTARTED}`],
    ];

    for (const [plist, cause, text] of refusals) {
      it(`refuses ${plist} before the owed reply, the turn abort, the ack, the marker, the alert and restartSelf`, async () => {
        const restartSelf = vi.fn(async (_name: string) => {});
        const selfRestartRefusal = vi.fn((_name: string): SelfRestartRefusal | null => cause);
        const queue = flushQueue(async () => {});
        const { deps: d, sendAck } = deps({
          instanceName: 'bot-a',
          dataRoot,
          trigger: triggerSelfRestart,
          deliverOwedReply: () => deliverOwedReplyBeforeRestart(queue),
          serviceManager: { restartSelf, selfRestartRefusal },
        });

        const result = await buildRestartSelfTool(d).handler({ reason: 'load merged main', code: 'redeploy' }, SESSION);

        expect(selfRestartRefusal).toHaveBeenCalledWith('bot-a');
        expect(result).toEqual({ ok: false, restarting: false, reason: 'load merged main', code: 'redeploy', cause, text });
        expect(queue.commitStreamingText).not.toHaveBeenCalled();
        expect(queue.flush).not.toHaveBeenCalled();
        expect(queue.abortTurn).not.toHaveBeenCalled();
        expect(sendAck).not.toHaveBeenCalled();
        expect(existsSync(join(dataRoot, 'intentional-restart.marker'))).toBe(false);
        expect(emitAlertChecked).not.toHaveBeenCalled();
        expect(restartSelf).not.toHaveBeenCalled();
      });
    }

    it('keeps the owed reply, ack, marker, alert and restartSelf order for a job the manager would restart', async () => {
      const order: string[] = [];
      const marker = join(dataRoot, 'intentional-restart.marker');
      const { deps: d } = deps({
        dataRoot,
        trigger: triggerSelfRestart,
        deliverOwedReply: vi.fn(async (): Promise<OwedReplyDelivery> => { order.push('owed'); return { delivered: true }; }),
        // A marker written before the acknowledgement shows up here.
        sendAck: vi.fn(async () => { order.push(existsSync(marker) ? 'marker before ack' : 'ack'); }),
        serviceManager: {
          selfRestartRefusal: vi.fn((): SelfRestartRefusal | null => { order.push('refusal check'); return null; }),
          restartSelf: vi.fn(async () => {
            order.push(existsSync(marker) ? 'marker' : 'no marker');
            order.push('restartSelf');
          }),
        },
      });

      const result = await buildRestartSelfTool(d).handler({ reason: 'r' }, SESSION);

      expect(result).toMatchObject({ ok: true, restarting: true });
      expect(order).toEqual(['refusal check', 'owed', 'ack', 'marker', 'restartSelf']);
      // Positive control for the refusal tests: the mock does record the real trigger's alert.
      expect(emitAlertChecked).toHaveBeenCalledWith(
        expect.any(String), 'self_restart_requested', expect.any(String), expect.any(String), 'info',
      );
    });

    // #3829: an unconfirmed owed reply must stop the restart — no ack, no
    // marker, no restartSelf — so the shutdown cannot destroy or orphan it.
    function expectRestartNotStarted(
      result: unknown,
      sendAck: ReturnType<typeof vi.fn>,
      restartSelf: ReturnType<typeof vi.fn>,
      cause: string,
    ): void {
      const r = result as RestartSelfResult;
      expect(r).toMatchObject({ ok: false, restarting: false, cause });
      expect(r.text).toContain('Restart not started');
      expect(r.text).toContain('could not be confirmed sent');
      expect(sendAck).not.toHaveBeenCalled();
      expect(restartSelf).not.toHaveBeenCalled();
      expect(existsSync(join(dataRoot, 'intentional-restart.marker'))).toBe(false);
    }

    it('does not restart when delivering the owed text throws', async () => {
      const { deps: d, sendAck, serviceManager } = deps({
        dataRoot,
        trigger: triggerSelfRestart,
        deliverOwedReply: vi.fn(async () => { throw new Error('queue poisoned'); }),
      });

      const result = await buildRestartSelfTool(d).handler({ reason: 'r' }, SESSION);

      expectRestartNotStarted(result, sendAck, serviceManager.restartSelf, 'flush_rejected');
    });

    it('does not restart when the owed-reply flush is still pending at the 10 s grace limit', async () => {
      vi.useFakeTimers();
      try {
        const queue = flushQueue(() => new Promise<void>(() => { /* never settles */ }));
        const { deps: d, sendAck, serviceManager } = deps({
          dataRoot,
          trigger: triggerSelfRestart,
          deliverOwedReply: () => deliverOwedReplyBeforeRestart(queue),
        });

        const pending = buildRestartSelfTool(d).handler({ reason: 'r' }, SESSION);
        await vi.advanceTimersByTimeAsync(OWED_REPLY_FLUSH_GRACE_MS);
        const result = await pending;

        expect(OWED_REPLY_FLUSH_GRACE_MS).toBe(10_000);
        expect(queue.flush).toHaveBeenCalledTimes(1);
        expectRestartNotStarted(result, sendAck, serviceManager.restartSelf, 'timeout');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not restart when the owed-reply flush rejects (poisoned queue)', async () => {
      const queue = flushQueue(async () => { throw new Error('drain queue failed — queue poisoned'); });
      const { deps: d, sendAck, serviceManager } = deps({
        dataRoot,
        trigger: triggerSelfRestart,
        deliverOwedReply: () => deliverOwedReplyBeforeRestart(queue),
      });

      const result = await buildRestartSelfTool(d).handler({ reason: 'r' }, SESSION);

      expectRestartNotStarted(result, sendAck, serviceManager.restartSelf, 'flush_rejected');
    });

    it('does not restart when the owed send fails terminally, sends it once and keeps its failure disposition', async () => {
      const owedText = 'On it, restarting.';
      const sent: string[] = [];
      const messenger: Messenger = {
        // A governor shed is a terminal, never-submitted failure: the queue stops
        // after one attempt and flush() still resolves.
        sendMessage: vi.fn(async (_jid: string, text: string) => {
          sent.push(text);
          throw new WhatSoupError('outbound governor shed', 'OUTBOUND_GOVERNOR_SHED');
        }),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
        setTyping: vi.fn(async () => {}),
      };
      const durability = {
        createOutboundOp: vi.fn(() => 1),
        markSending: vi.fn(),
        markSubmitted: vi.fn(),
        markMaybeSent: vi.fn(),
        markFailedPermanent: vi.fn(),
        markDeferred: vi.fn(),
        markTerminal: vi.fn(),
      };
      const queue = new OutboundQueue(messenger, '15550100111@s.whatsapp.net');
      queue.setDurability(durability as unknown as DurabilityEngine);
      // As in the runtime: every admitted turn begins turn evidence first.
      queue.beginTurnEvidence('turn-1');
      queue.enqueueStreamingText(owedText, 'answer');

      const { deps: d, sendAck, serviceManager } = deps({
        dataRoot,
        trigger: triggerSelfRestart,
        deliverOwedReply: () => deliverOwedReplyBeforeRestart(queue),
      });

      const result = await buildRestartSelfTool(d).handler({ reason: 'r' }, SESSION);

      expectRestartNotStarted(result, sendAck, serviceManager.restartSelf, 'send_failed');
      expect(sent.filter((text) => text === owedText)).toHaveLength(1);
      expect(queue.getSendFailureCount()).toBe(1);
      expect(durability.createOutboundOp).toHaveBeenCalledTimes(1);
      expect(durability.markSubmitted).not.toHaveBeenCalled();
      expect(durability.markFailedPermanent).toHaveBeenCalledTimes(1);
      expect(durability.markFailedPermanent).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          failure_code: 'outbound.governor_shed',
          mutation_state: 'not_started',
          provider_submission_count: 0,
        }),
      );
      expect(durability.markTerminal).not.toHaveBeenCalled();
    });

    it('still restarts when the owed-reply flush settles just under the 10 s grace limit', async () => {
      vi.useFakeTimers();
      try {
        const order: string[] = [];
        let settleFlush!: () => void;
        let flushCalls = 0;
        // Only the first flush, which carries the owed text, waits; a later
        // flush after the turn abort has nothing left to send.
        const queue = flushQueue(() => (++flushCalls === 1
          ? new Promise<void>((resolve) => {
              settleFlush = () => { order.push('owed'); resolve(); };
            })
          : Promise.resolve()));
        const { deps: d } = deps({
          dataRoot,
          trigger: triggerSelfRestart,
          deliverOwedReply: () => deliverOwedReplyBeforeRestart(queue),
          sendAck: vi.fn(async () => { order.push('ack'); }),
          serviceManager: { restartSelf: vi.fn(async () => { order.push('restartSelf'); }) },
        });

        const pending = buildRestartSelfTool(d).handler({ reason: 'r' }, SESSION);
        // Advance the fake clock to 1 ms before the grace timer fires, then settle the flush.
        await vi.advanceTimersByTimeAsync(OWED_REPLY_FLUSH_GRACE_MS - 1);
        expect(queue.flush).toHaveBeenCalledTimes(1);
        settleFlush();
        const result = await pending;

        expect(result).toMatchObject({ ok: true, restarting: true });
        expect(order).toEqual(['owed', 'ack', 'restartSelf']);
        expect(existsSync(join(dataRoot, 'intentional-restart.marker'))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
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
      queue.beginTurnEvidence('turn-1');
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
      // The turn's evidence makes the queue defer the streamed answer to the turn end.
      queue.beginTurnEvidence('turn-1');
      queue.enqueueStreamingText('On it, restarting.', 'answer');

      expect(await deliverOwedReplyBeforeRestart(queue)).toEqual({ delivered: true });

      expect(sent).toEqual(['On it, restarting.']);
    });
  });
});
