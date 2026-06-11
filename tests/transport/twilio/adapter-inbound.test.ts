// tests/transport/twilio/adapter-inbound.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeChannelId } from '../../../src/core/transport-refs.ts';
import { TwilioSmsAdapter } from '../../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';
import type { TwilioSmsConfig } from '../../../src/transport/twilio/types.ts';
import { makeTwilioConfig } from './helpers.ts';
import type { InboundMessage } from '../../../src/transport/contract/events.ts';
import {
  AuthRequiredError,
} from '../../../src/transport/contract/errors.ts';

afterEach(() => {
  vi.useRealTimers();
});

const makeConfig = (overrides?: Partial<TwilioSmsConfig>): TwilioSmsConfig =>
  makeTwilioConfig({ pollIntervalMs: 1000, ...overrides });

describe('TwilioSmsAdapter inbound poll — full InboundMessage contract', () => {
  it('maps an injected record to a complete InboundMessage, asserting every contract field', async () => {
    // Start fake time at epoch so the lookback window (epoch - 1s = -1000ms)
    // includes any record with sentAt >= new Date(-1000), i.e. the epoch itself.
    vi.useFakeTimers({ now: 0 });
    const channel = makeChannelId('sms', 'ml-bot');
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const msgs: InboundMessage[] = [];
    adapter.on('message', (m) => msgs.push(m));

    await adapter.connect();

    // sentAt = epoch; cursor = epoch - 1000ms = -1000ms, so sentAt >= cursor
    const sentAt = new Date(0);
    port.injectInbound({ sid: 'SMabc001', from: '+15551230000', to: '+15559990000', body: 'hello world', sentAt });

    await vi.advanceTimersByTimeAsync(1000);

    expect(msgs).toHaveLength(1);
    const m = msgs[0];

    // ref: MessageRef
    expect(m.ref.channel).toBe(channel);
    expect(m.ref.conversation).toBe('+15551230000');
    expect(m.ref.id).toBe('SMabc001');

    // conversation: ConversationRef
    expect(m.conversation.channel).toBe(channel);
    expect(m.conversation.id).toBe('+15551230000');

    // sender: ParticipantRef
    expect(m.sender.channel).toBe(channel);
    expect(m.sender.id).toBe('+15551230000');

    // scalar fields
    expect(m.fromMe).toBe(false);
    expect(m.text).toBe('hello world');
    expect(m.attachments).toEqual([]);

    // timestamp / transportTimestamp = sentAt
    expect(m.timestamp).toEqual(sentAt);
    expect(m.transportTimestamp).toEqual(sentAt);

    // inboundEventKey: stable per SID — equals the SID itself
    expect(m.inboundEventKey).toBe('SMabc001');

    // ingestSeq: positive integer (first message from this adapter instance)
    expect(typeof m.ingestSeq).toBe('number');
    expect(m.ingestSeq).toBeGreaterThan(0);

    await adapter.disconnect();
  });

  it('ingestSeq is monotonically increasing across two records in one tick', async () => {
    vi.useFakeTimers({ now: 0 });
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const msgs: InboundMessage[] = [];
    adapter.on('message', (m) => msgs.push(m));

    await adapter.connect();

    // Both sentAt values are within the lookback window (epoch - 1s)
    const t1 = new Date(0);        // epoch
    const t2 = new Date(500);      // 500ms after epoch
    port.injectInbound({ sid: 'SM001', from: '+15551230001', to: '+15559990000', body: 'first', sentAt: t1 });
    port.injectInbound({ sid: 'SM002', from: '+15551230002', to: '+15559990000', body: 'second', sentAt: t2 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].ingestSeq).toBeLessThan(msgs[1].ingestSeq);

    await adapter.disconnect();
  });

  it('ascending sentAt order is preserved in emission order', async () => {
    vi.useFakeTimers({ now: 0 });
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const texts: string[] = [];
    adapter.on('message', (m) => texts.push(m.text ?? ''));

    await adapter.connect();

    // Inject in reversed sentAt order — port sorts ascending before returning
    const t1 = new Date(100);  // earlier
    const t2 = new Date(200);  // later
    port.injectInbound({ sid: 'SM_late', from: '+15551230000', to: '+15559990000', body: 'later', sentAt: t2 });
    port.injectInbound({ sid: 'SM_early', from: '+15551230000', to: '+15559990000', body: 'earlier', sentAt: t1 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(texts).toEqual(['earlier', 'later']);

    await adapter.disconnect();
  });
});

describe('TwilioSmsAdapter inbound poll — dedupe', () => {
  it('same SID across two ticks emits exactly once', async () => {
    vi.useFakeTimers();
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const got: string[] = [];
    adapter.on('message', (m) => { if (m.text) got.push(m.text); });

    await adapter.connect();

    // sentAt = Date.now() at fake-timer time, which is within the lookback window
    port.injectInbound({ sid: 'SMa', from: '+15551230000', to: '+15559990000', body: 'one', sentAt: new Date() });

    await vi.advanceTimersByTimeAsync(1000); // tick 1 — emits
    await vi.advanceTimersByTimeAsync(1000); // tick 2 — same SID, must NOT re-emit

    await adapter.disconnect();
    expect(got).toEqual(['one']);
  });

  it('boundary-equal record (sentAt === cursor) is not double-emitted thanks to dedupe', async () => {
    vi.useFakeTimers({ now: 0 });
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const msgs: InboundMessage[] = [];
    adapter.on('message', (m) => msgs.push(m));

    await adapter.connect();
    // After connect, cursor = new Date(0 - 1000) = new Date(-1000)
    // Inject sentAt = epoch (new Date(0)) which is >= cursor
    // Port uses inclusive filter (sentAt >= since) so it will be returned on every tick.
    // After first tick, cursor advances to new Date(0) (the max sentAt seen).
    // On subsequent ticks, the same record (sentAt = new Date(0)) is still returned
    // because sentAt >= cursor (inclusive), but SID dedupe must prevent re-emission.
    const sentAt = new Date(0);
    port.injectInbound({ sid: 'SMboundary', from: '+15551230000', to: '+15559990000', body: 'boundary', sentAt });

    await vi.advanceTimersByTimeAsync(1000); // tick 1 — cursor = new Date(-1000), record included, emits, cursor advances to new Date(0)
    await vi.advanceTimersByTimeAsync(1000); // tick 2 — cursor = new Date(0), record still returned (inclusive), deduped
    await vi.advanceTimersByTimeAsync(1000); // tick 3 — same, deduped

    await adapter.disconnect();
    expect(msgs.filter((m) => m.ref.id === 'SMboundary')).toHaveLength(1);
  });

  it('dedupe set stays bounded: evicted SID re-emits on next tick', async () => {
    // now=1_000_000 → connect() lookback cursor = 999_000; all injected
    // records (sentAt >= 1_001_000) are inside the window.
    vi.useFakeTimers({ now: 1_000_000 });
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const emittedSids: string[] = [];
    adapter.on('message', (m) => emittedSids.push(m.ref.id));

    await adapter.connect();

    // The adapter fetches at most 500 records per tick, so drive CAP+1 unique
    // records through in three timestamp-advancing waves (the cursor advances
    // to max sentAt each tick, pulling the next wave into the page).
    const CAP = 1000;
    const t = (i: number) => new Date(1_000_000 + i * 1000);
    for (let i = 1; i <= 500; i++) {
      port.injectInbound({ sid: `SM_cap_${i}`, from: '+15551230000', to: '+15559990000', body: `m${i}`, sentAt: t(i) });
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(emittedSids).toHaveLength(500);

    for (let i = 501; i <= 1000; i++) {
      port.injectInbound({ sid: `SM_cap_${i}`, from: '+15551230000', to: '+15559990000', body: `m${i}`, sentAt: t(i) });
    }
    // The inclusive cursor boundary means the previous max-sentAt record
    // occupies one page slot per tick, so this wave drains in two ticks.
    await vi.advanceTimersByTimeAsync(1000);
    expect(emittedSids).toHaveLength(CAP - 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(emittedSids).toHaveLength(CAP);

    // The CAP+1th unique record pushes the seen set over the bound; the
    // oldest entry (SM_cap_1) is evicted post-batch.
    port.injectInbound({ sid: `SM_cap_${CAP + 1}`, from: '+15551230000', to: '+15559990000', body: 'overflow', sentAt: t(CAP + 1) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(emittedSids).toHaveLength(CAP + 1);

    // Proof of eviction: a record re-arriving with the EVICTED sid re-emits…
    port.injectInbound({ sid: 'SM_cap_1', from: '+15551230000', to: '+15559990000', body: 'replay-evicted', sentAt: t(CAP + 2) });
    // …while a record with a still-seen sid stays deduped.
    port.injectInbound({ sid: 'SM_cap_900', from: '+15551230000', to: '+15559990000', body: 'replay-seen', sentAt: t(CAP + 3) });
    await vi.advanceTimersByTimeAsync(1000);

    const tail = emittedSids.slice(CAP + 1);
    expect(tail).toEqual(['SM_cap_1']);

    await adapter.disconnect();
  });
});

describe('TwilioSmsAdapter inbound poll — error handling', () => {
  it('transient list failure emits typed error via on("error"), poll continues and recovers', async () => {
    vi.useFakeTimers();
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const errors: Error[] = [];
    const msgs: string[] = [];
    adapter.on('error', (e) => errors.push(e));
    adapter.on('message', (m) => { if (m.text) msgs.push(m.text); });

    await adapter.connect();

    // Arm a transient failure for the first tick
    port.failNextList(Object.assign(new Error('connection reset'), { status: 500 }));

    await vi.advanceTimersByTimeAsync(1000); // tick 1 — fails, emits error
    expect(errors).toHaveLength(1);
    expect(msgs).toHaveLength(0);
    expect(adapter.state().state).toBe('connected'); // still connected — not stopped

    // Tick 2: inject a record at current fake time (within lookback); poll recovers
    port.injectInbound({ sid: 'SM_recover', from: '+15551230000', to: '+15559990000', body: 'after recovery', sentAt: new Date() });
    await vi.advanceTimersByTimeAsync(1000); // tick 2 — succeeds
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toBe('after recovery');

    await adapter.disconnect();
  });

  it('auth failure during poll emits AuthRequiredError, stops loop, transitions to auth_required', async () => {
    vi.useFakeTimers();
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const errors: Error[] = [];
    adapter.on('error', (e) => errors.push(e));

    await adapter.connect();

    let listCallCount = 0;
    const origList = port.listInboundSince.bind(port);
    port.listInboundSince = async (since: Date, pageSize?: number) => {
      listCallCount++;
      return origList(since, pageSize);
    };

    // Arm auth failure on first tick
    port.failNextList(Object.assign(new Error('401 unauthorized'), { status: 401, code: 20003 }));

    await vi.advanceTimersByTimeAsync(1000); // tick 1 — auth failure

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AuthRequiredError);
    expect(adapter.state().state).toBe('auth_required');

    const callsAfterAuthFail = listCallCount;

    // Subsequent ticks must NOT call the port — loop is stopped
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listCallCount).toBe(callsAfterAuthFail);

    await adapter.disconnect();
  });
});

describe('TwilioSmsAdapter inbound poll — lifecycle', () => {
  it('disconnect clears the interval — no further port calls after disconnect', async () => {
    vi.useFakeTimers();
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    await adapter.connect();
    await adapter.disconnect();

    let listCallCount = 0;
    port.listInboundSince = async (_since: Date, _pageSize?: number) => {
      listCallCount++;
      return [];
    };

    // Advance well past multiple intervals — no port calls should happen
    await vi.advanceTimersByTimeAsync(5000);
    expect(listCallCount).toBe(0);
  });

  it('in-flight pollOnce does not emit after disconnect (disposed guard)', async () => {
    vi.useFakeTimers();
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const msgs: InboundMessage[] = [];
    adapter.on('message', (m) => msgs.push(m));

    await adapter.connect();

    // Inject a record at current fake time (within lookback window)
    port.injectInbound({ sid: 'SM_inflight', from: '+15551230000', to: '+15559990000', body: 'inflight', sentAt: new Date() });

    // Disconnect before any timer fires
    await adapter.disconnect();

    // Now advance — timer is cleared so pollOnce should never run
    await vi.advanceTimersByTimeAsync(2000);
    expect(msgs).toHaveLength(0);
  });

  it('pollIntervalMs 0: no polling started, no port list calls on connect', async () => {
    const port = new MockTwilioSmsPort();
    let listCallCount = 0;
    port.listInboundSince = async () => {
      listCallCount++;
      return [];
    };
    const adapter = new TwilioSmsAdapter(makeConfig({ pollIntervalMs: 0 }), port);
    await adapter.connect();
    expect(listCallCount).toBe(0);
    await adapter.disconnect();
    expect(listCallCount).toBe(0);
  });
});

describe('TwilioSmsAdapter inbound poll — robustness', () => {
  it('a throwing message listener does not break the batch, other listeners, or polling', async () => {
    vi.useFakeTimers();
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig({ pollIntervalMs: 5000 }), port);

    const received: string[] = [];
    adapter.on('message', () => {
      throw new Error('listener bug');
    });
    adapter.on('message', (m) => received.push(m.inboundEventKey));

    await adapter.connect();
    port.injectInbound({ sid: 'SM_rb1', from: '+1', to: '+2', body: 'a', sentAt: new Date() });
    port.injectInbound({ sid: 'SM_rb2', from: '+1', to: '+2', body: 'b', sentAt: new Date() });
    await vi.advanceTimersByTimeAsync(5000);

    // Both records emitted to the healthy listener despite the throwing one
    expect(received).toEqual(['SM_rb1', 'SM_rb2']);

    // Polling continues on the next tick
    port.injectInbound({ sid: 'SM_rb3', from: '+1', to: '+2', body: 'c', sentAt: new Date() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(received).toEqual(['SM_rb1', 'SM_rb2', 'SM_rb3']);
    await adapter.disconnect();
  });

  it('overlapping ticks do not overlap polls (reentrancy guard)', async () => {
    vi.useFakeTimers();
    const port = new MockTwilioSmsPort();
    let listCalls = 0;
    const gate: { release: (() => void) | null } = { release: null };
    port.listInboundSince = async () => {
      listCalls++;
      // Hang until the test releases — simulates a poll slower than the interval
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return [];
    };

    const adapter = new TwilioSmsAdapter(makeConfig({ pollIntervalMs: 5000 }), port);
    await adapter.connect();

    // Three intervals elapse while the first poll is still in flight
    await vi.advanceTimersByTimeAsync(15000);
    expect(listCalls).toBe(1);

    // Release the hung poll; the next tick may poll again
    gate.release?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(listCalls).toBe(2);
    gate.release?.();
    await adapter.disconnect();
  });
});

describe('TwilioSmsAdapter inbound poll — outbound echo (fromMe: true)', () => {
  it('outbound record → InboundMessage with fromMe: true, conversation = peer (record.to), sender = our number', async () => {
    vi.useFakeTimers({ now: 0 });
    const channel = makeChannelId('sms', 'ml-bot');
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const msgs: InboundMessage[] = [];
    adapter.on('message', (m) => msgs.push(m));

    await adapter.connect();

    // Inject an outbound record (bot sent a message to a peer)
    const sentAt = new Date(0);
    port.injectInbound({
      sid: 'SMout001',
      from: '+15559990000',   // our number (sender)
      to: '+15551230000',     // remote peer (recipient)
      body: 'bot reply',
      sentAt,
      fromMe: true,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(msgs).toHaveLength(1);
    const m = msgs[0];

    // conversation must key on the PEER so inbound and outbound share a thread
    expect(m.conversation.id).toBe('+15551230000');
    expect(m.ref.conversation).toBe('+15551230000');

    // sender is us (our phone number)
    expect(m.sender.id).toBe('+15559990000');

    // fromMe must be true
    expect(m.fromMe).toBe(true);

    expect(m.ref.channel).toBe(channel);
    expect(m.ref.id).toBe('SMout001');
    expect(m.text).toBe('bot reply');
    expect(m.inboundEventKey).toBe('SMout001');

    await adapter.disconnect();
  });

  it('inbound record still produces conversation = record.from, sender = record.from, fromMe: false', async () => {
    vi.useFakeTimers({ now: 0 });
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const msgs: InboundMessage[] = [];
    adapter.on('message', (m) => msgs.push(m));

    await adapter.connect();

    const sentAt = new Date(0);
    port.injectInbound({
      sid: 'SMi001',
      from: '+15551230000',   // remote peer (sender)
      to: '+15559990000',     // our number (recipient)
      body: 'user msg',
      sentAt,
      fromMe: false,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(msgs).toHaveLength(1);
    const m = msgs[0];

    expect(m.conversation.id).toBe('+15551230000');
    expect(m.sender.id).toBe('+15551230000');
    expect(m.fromMe).toBe(false);

    await adapter.disconnect();
  });

  it('echo flow: sendText returns sid X, then a fromMe record with sid X arrives → emitted exactly once with fromMe: true', async () => {
    vi.useFakeTimers({ now: 0 });
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const convRef = { channel: makeChannelId('sms', 'ml-bot'), id: '+15551230000' };

    const msgs: InboundMessage[] = [];
    adapter.on('message', (m) => msgs.push(m));

    await adapter.connect();

    // Send a message — mock port assigns SM000001
    const msgRef = await adapter.sendText(convRef, 'hello');
    const sid = msgRef.id; // 'SM000001'

    // Now the outbound echo arrives in the next poll
    port.injectInbound({
      sid,
      from: '+15559990000',
      to: '+15551230000',
      body: 'hello',
      sentAt: new Date(0),
      fromMe: true,
    });

    await vi.advanceTimersByTimeAsync(1000); // tick 1 — emits fromMe record
    await vi.advanceTimersByTimeAsync(1000); // tick 2 — SID in seen set, must NOT re-emit

    // Exactly once
    expect(msgs.filter((m) => m.ref.id === sid)).toHaveLength(1);
    expect(msgs[0].fromMe).toBe(true);

    await adapter.disconnect();
  });
});

describe('TwilioSmsAdapter handleInboundRecord (webhook push seam)', () => {
  it('emits exactly once for a record pushed twice (shared SID dedupe with polling)', async () => {
    vi.useFakeTimers({ now: 0 });
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig({ pollIntervalMs: 0 }), port);
    const got: InboundMessage[] = [];
    adapter.on('message', (m) => got.push(m));
    await adapter.connect();

    const rec = { sid: 'SMwh1', from: '+15551230001', to: '+15559990000', body: 'via webhook', sentAt: new Date(5), fromMe: false };
    adapter.handleInboundRecord(rec);
    adapter.handleInboundRecord(rec);
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('via webhook');
    await adapter.disconnect();
  });
});
