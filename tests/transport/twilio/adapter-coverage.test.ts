// tests/transport/twilio/adapter-coverage.test.ts
//
// Focused branch-coverage tests for src/transport/twilio/adapter.ts.
//
// Sibling files cover most of the file; the branches this file targets are
// the ones the combined sibling run still flags as uncovered:
//   * placeCall rejects non-E.164 target ids (ConversationNotFoundError)
//   * placeCall catches a port.placeCall failure (mapPortError path)
//   * handleTranscript post-record dedupe eviction (the second copy of the
//     DEDUPE_CAP trim — handleInboundRecord's copy is already covered by
//     adapter-inbound.test.ts' 1000-SID overflow test)
//   * connect()'s repeated-connect pollTimer cleanup (lines 214-217)
//   * inbound seam's disposed/not-connected early-return false branches
//   * mapPortError's truthiness fallbacks (empty message, missing code+status)
//   * constructor's `this.from ?? this.messagingServiceSid` fallback path
//   * pollOnceInner's `if (this.disposed)` true-branch (return-on-disposed)
//
// Harness mirrors tests/transport/twilio/adapter-voice.test.ts.
import { describe, it, expect } from 'vitest';
import { makeChannelId } from '../../../src/core/transport-refs.ts';
import { TwilioSmsAdapter } from '../../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';
import { makeTwilioConfig } from './helpers.ts';
import {
  AuthRequiredError,
  ConversationNotFoundError,
  TransientProviderError,
} from '../../../src/transport/contract/errors.ts';
import type { InboundMessage } from '../../../src/transport/contract/events.ts';

const VOICE_CONFIG = { voice: { enabled: true, voicemailMaxLengthSec: 120 } };

describe('adapter.ts uncovered-branch coverage', () => {
  describe('placeCall — non-E.164 destination', () => {
    it('rejects with ConversationNotFoundError BEFORE the port receives a call (empty id)', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);
      await adapter.connect();

      await expect(
        adapter.placeCall({ channel: makeChannelId('sms', 'ml-bot'), id: '' }),
      ).rejects.toBeInstanceOf(ConversationNotFoundError);

      expect(port.calls).toHaveLength(0);
    });

    it('rejects with ConversationNotFoundError for an id missing the leading +', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);
      await adapter.connect();

      await expect(
        adapter.placeCall({ channel: makeChannelId('sms', 'ml-bot'), id: '15551230001' }),
      ).rejects.toBeInstanceOf(ConversationNotFoundError);

      expect(port.calls).toHaveLength(0);
    });

    it('rejects with ConversationNotFoundError for a WhatsApp-style jid-shaped id', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);
      await adapter.connect();

      // Voice calls go to a phone number, not a WhatsApp jid — must reject.
      await expect(
        adapter.placeCall({
          channel: makeChannelId('sms', 'ml-bot'),
          id: '15551230001@s.whatsapp.net',
        }),
      ).rejects.toBeInstanceOf(ConversationNotFoundError);

      expect(port.calls).toHaveLength(0);
    });

    it('ConversationNotFoundError carries scope=conversation on a non-E.164 id', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);
      await adapter.connect();

      const err = await adapter
        .placeCall({ channel: makeChannelId('sms', 'ml-bot'), id: 'not-a-number' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConversationNotFoundError);
      const payload = (err as ConversationNotFoundError).payload;
      expect(payload.scope).toBe('conversation');
      expect(payload.operation).toBe('placeCall');
      expect(payload.channelId).toBe(makeChannelId('sms', 'ml-bot'));
      expect(payload.code).toBe('transport.conversation_not_found');
    });
  });

  describe('placeCall — port failure path', () => {
    it('maps a 5xx port error to TransientProviderError', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);
      await adapter.connect();

      port.failNextCall(Object.assign(new Error('upstream fault'), { status: 503 }));

      await expect(
        adapter.placeCall({ channel: makeChannelId('sms', 'ml-bot'), id: '+15551230001' }),
      ).rejects.toBeInstanceOf(TransientProviderError);

      expect(port.calls).toHaveLength(0);
    });

    it('TransientProviderError from placeCall carries scope=request and operation=placeCall', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);
      await adapter.connect();

      port.failNextCall(Object.assign(new Error('connection reset'), { status: 500 }));

      const err = await adapter
        .placeCall({ channel: makeChannelId('sms', 'ml-bot'), id: '+15551230001' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TransientProviderError);
      const payload = (err as TransientProviderError).payload;
      expect(payload.scope).toBe('request');
      expect(payload.operation).toBe('placeCall');
      expect(payload.channelId).toBe(makeChannelId('sms', 'ml-bot'));
      expect(payload.retryable).toBe(true);
    });

    it('maps a port error with no status and no code to SendAmbiguousError (#2553)', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);
      await adapter.connect();

      // Bare network-style error on a mutation: no `status`, no `code`, no
      // API reply — the call may have been placed, so the outcome is the
      // non-retryable ambiguous class.
      port.failNextCall(new Error('socket hang up'));

      await expect(
        adapter.placeCall({ channel: makeChannelId('sms', 'ml-bot'), id: '+15551230001' }),
      ).rejects.toMatchObject({
        payload: { code: 'transport.send_ambiguous', retryable: false },
      });
    });
  });

  describe('connect — repeated-connect pollTimer cleanup', () => {
    it('a second connect() with an armed poll timer clears the previous interval', async () => {
      const port = new MockTwilioSmsPort();
      // inboundMode: 'poll' (default) and pollIntervalMs > 0 → connect()
      // arms a setInterval and stores the handle in pollTimer.
      const adapter = new TwilioSmsAdapter(
        makeTwilioConfig({ pollIntervalMs: 1000 }),
        port,
      );

      // First connect: pollTimer becomes non-null.
      await adapter.connect();
      expect(adapter.state().state).toBe('connected');

      // Second connect (without an intervening disconnect) must clear the
      // existing poll timer and re-arm the polling pipeline. The cleared
      // branch is at lines 214-217; both clearInterval and the null-reset
      // are the uncovered lines 215-216.
      await expect(adapter.connect()).resolves.toBeUndefined();
      expect(adapter.state().state).toBe('connected');

      await adapter.disconnect();
    });
  });

  describe('pollOnce — auth failure with pollTimer null (no-armed-timer branch)', () => {
    it('manual pollOnce with pollIntervalMs=0 produces an auth error and skips the null-timer clear', async () => {
      const port = new MockTwilioSmsPort();
      // pollIntervalMs: 0 → connect() does NOT arm a setInterval, so
      // pollTimer stays null. Manually driving pollOnce() exercises the
      // inner `if (this.pollTimer !== null)` false branch (line 429).
      const adapter = new TwilioSmsAdapter(
        makeTwilioConfig({ pollIntervalMs: 0 }),
        port,
      );

      const errors: unknown[] = [];
      adapter.on('error', (e) => errors.push(e));

      await adapter.connect();
      expect(adapter.state().state).toBe('connected');

      port.failNextList(Object.assign(new Error('401 unauthorized'), { status: 401, code: 20003 }));

      await adapter.pollOnce();

      // The mapped error is still emitted, and state still transitions to
      // auth_required even when there was no timer to clear.
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(AuthRequiredError);
      expect(adapter.state().state).toBe('auth_required');

      await adapter.disconnect();
    });
  });

  describe('pollOnce — guard branches', () => {
    it('pollOnce is a no-op when state is not connected (pre-connect early return)', async () => {
      const port = new MockTwilioSmsPort();
      let listCalls = 0;
      port.listInboundSince = async () => { listCalls++; return []; };
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(), port);

      // Pre-connect: state is 'disconnected', so pollOnce returns at line 407
      // without calling the port.
      await adapter.pollOnce();
      expect(listCalls).toBe(0);

      await adapter.connect();
      await adapter.disconnect();

      // Post-disconnect: state is 'disconnected' again, same early return.
      await adapter.pollOnce();
      expect(listCalls).toBe(0);
    });
  });

  describe('inbound seam — disposed/not-connected early-return false branches', () => {
    it('handleInboundRecord returns false when called before connect (not connected)', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig({ pollIntervalMs: 0 }), port);

      // Pre-connect: state is 'disconnected', so the guard at line 467 returns
      // false without touching the seen set or emitting.
      const rec = {
        sid: 'SMpre', from: '+15551230000', to: '+15559990000',
        body: 'pre-connect', sentAt: new Date(0), fromMe: false,
      };
      const emitted = adapter.handleInboundRecord(rec);
      expect(emitted).toBe(false);
    });

    it('handleTranscript returns false when called before connect (not connected)', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);

      // Pre-connect: state is 'disconnected', so the guard at line 487 returns
      // false without touching the seen set or emitting.
      const emitted = adapter.handleTranscript({
        text: 'pre-connect',
        recordingSid: 'RE0000000000000000000000000000099',
        callSid: 'CApre',
        from: '+15551230001',
        to: '+15559990000',
      });
      expect(emitted).toBe(false);
    });

    it('handleInboundRecord returns false when called after disconnect (disposed)', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig({ pollIntervalMs: 0 }), port);

      await adapter.connect();
      await adapter.disconnect();

      // Post-disconnect: disposed=true, so the guard at line 467 returns false.
      const rec = {
        sid: 'SMpost', from: '+15551230000', to: '+15559990000',
        body: 'post-disconnect', sentAt: new Date(0), fromMe: false,
      };
      const emitted = adapter.handleInboundRecord(rec);
      expect(emitted).toBe(false);
    });

    it('handleTranscript returns false when called after disconnect (disposed)', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);

      await adapter.connect();
      await adapter.disconnect();

      // Post-disconnect: disposed=true, so the guard at line 487 returns false.
      const emitted = adapter.handleTranscript({
        text: 'post-disconnect',
        recordingSid: 'RE0000000000000000000000000000088',
        callSid: 'CApost',
        from: '+15551230001',
        to: '+15559990000',
      });
      expect(emitted).toBe(false);
    });
  });

  describe('handleTranscript — post-record dedupe eviction', () => {
    it('emits 1001 unique transcripts in order, evicts the oldest once seen exceeds the cap, and re-emits the evicted sid', async () => {
      const port = new MockTwilioSmsPort();
      // pollIntervalMs: 0 — connect() must still transition state to
      // 'connected' so handleTranscript's health guard passes, but no timer
      // is armed.
      const adapter = new TwilioSmsAdapter(
        makeTwilioConfig({ ...VOICE_CONFIG, pollIntervalMs: 0 }),
        port,
      );
      const got: InboundMessage[] = [];
      adapter.on('message', (m) => got.push(m));

      await adapter.connect();

      const DEDUPE_CAP = 1000;

      // Push CAP+1 unique transcripts. Each unique recordingSid is added to
      // the seen set; after the CAP+1th insertion, the trim loop deletes the
      // oldest entry (the line 506 branch).
      for (let i = 1; i <= DEDUPE_CAP + 1; i++) {
        const emitted = adapter.handleTranscript({
          text: `vm-${i}`,
          recordingSid: `RE${String(i).padStart(32, '0')}`,
          callSid: `CA_overflow_${i}`,
          from: '+15551230001',
          to: '+15559990000',
        });
        expect(emitted).toBe(true);
      }

      // All CAP+1 unique transcripts must have been emitted exactly once.
      expect(got).toHaveLength(DEDUPE_CAP + 1);

      // Re-arrival of the EVICTED (oldest) recording sid must re-emit —
      // proves the seen-set actually lost that entry via the trim branch.
      const reEmitted = adapter.handleTranscript({
        text: 'replay-evicted',
        recordingSid: 'RE0000000000000000000000000000001',
        callSid: 'CA_replay',
        from: '+15551230001',
        to: '+15559990000',
      });
      expect(reEmitted).toBe(true);
      expect(got).toHaveLength(DEDUPE_CAP + 2);
      expect(got[got.length - 1].text).toBe('replay-evicted');

      // Re-arrival of a STILL-SEEN recording sid must NOT re-emit — proves
      // the trim only removed the one oldest entry, not the whole set.
      const stillSeenSid = `RE${String(DEDUPE_CAP).padStart(32, '0')}`;
      const deduped = adapter.handleTranscript({
        text: 'replay-still-seen',
        recordingSid: stillSeenSid,
        callSid: 'CA_replay2',
        from: '+15551230001',
        to: '+15559990000',
      });
      expect(deduped).toBe(false);
      expect(got).toHaveLength(DEDUPE_CAP + 2);

      await adapter.disconnect();
    });
  });

  describe('constructor — selfRef identity when phoneNumber is absent', () => {
    it('falls back to messagingServiceSid when phoneNumber is undefined', async () => {
      const port = new MockTwilioSmsPort();
      // No phoneNumber; messagingServiceSid set → self.id must equal the MSS.
      const adapter = new TwilioSmsAdapter(
        makeTwilioConfig({
          phoneNumber: undefined,
          messagingServiceSid: 'MGabcdef1234567890abcdef1234567890',
        }),
        port,
      );
      const self = adapter.selfRef();
      expect(self.id).toBe('MGabcdef1234567890abcdef1234567890');
      expect(self.channel).toBe(makeChannelId('sms', 'ml-bot'));
    });

    it('sendText uses messagingServiceSid (not a `from`) when phoneNumber is absent', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(
        makeTwilioConfig({
          phoneNumber: undefined,
          messagingServiceSid: 'MGabcdef1234567890abcdef1234567890',
        }),
        port,
      );
      await adapter.connect();

      const channel = makeChannelId('sms', 'ml-bot');
      await adapter.sendText({ channel, id: '+15551230000' }, 'hi');

      expect(port.sent).toHaveLength(1);
      expect(port.sent[0].from).toBeUndefined();
      expect(port.sent[0].messagingServiceSid).toBe('MGabcdef1234567890abcdef1234567890');
    });
  });

  describe('mapPortError — truthiness fallback paths', () => {
    it('falls through to String(err) when error.message is not a non-empty string', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);
      await adapter.connect();

      // Bare object with an empty string `message` (falsy after the truthy
      // `typeof === 'string'` check) — exercises the `String(err)` fallback.
      port.failNextSend({ message: '' } as unknown as Error);

      const err = await adapter
        .sendText({ channel: makeChannelId('sms', 'ml-bot'), id: '+15551230000' }, 'hi')
        .catch((e: unknown) => e);

      expect(err).toBeDefined();
      // The PermanentProviderError message contains the stringified err.
      expect((err as Error).message).toContain('[object Object]');
    });

    it('PermanentProviderError message format on a 4xx with no Twilio code', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);
      await adapter.connect();

      // 404 (non-429, non-5xx, no `code`) → enters the permanent branch.
      // The `code ?? status ?? ''` chain resolves to String(404) — not the
      // '' fallthrough (which is unreachable on the permanent path because
      // having neither code nor status would have classified the error as
      // transient). We verify the message prefix instead.
      port.failNextSend(Object.assign(new Error('not found'), { status: 404 }));

      const err = await adapter
        .sendText({ channel: makeChannelId('sms', 'ml-bot'), id: '+15551230000' }, 'hi')
        .catch((e: unknown) => e);

      expect(err).toBeDefined();
      expect((err as Error).message).toContain('Twilio provider error');
    });

    it('RateLimitedError providerCode is empty string when error has no code and no status', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(makeTwilioConfig(VOICE_CONFIG), port);
      await adapter.connect();

      // 429 but with NO `code` and NO `status` — the second/third operand of
      // the `code ?? status ?? ''` chain resolve to ''.
      // isTwilioRateLimit only matches when err.status === 429, so we MUST
      // set status: 429 to enter this branch. We just don't set `code`.
      port.failNextSend(Object.assign(new Error('rate limit'), { status: 429 }));

      const err = await adapter
        .sendText({ channel: makeChannelId('sms', 'ml-bot'), id: '+15551230000' }, 'hi')
        .catch((e: unknown) => e);

      expect(err).toBeDefined();
      expect((err as Error).message).toContain('Twilio rate limit');
    });
  });

  describe('pollOnceInner — early-return on disposed', () => {
    it('returns silently when listInboundSince throws after disconnect() has set disposed', async () => {
      const port = new MockTwilioSmsPort();
      const adapter = new TwilioSmsAdapter(
        makeTwilioConfig({ pollIntervalMs: 1000 }),
        port,
      );

      const errors: unknown[] = [];
      adapter.on('error', (e) => errors.push(e));

      // Gate the port so we can dispose mid-poll.
      const gate: { release: (() => void) | null } = { release: null };
      port.listInboundSince = async () => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        // Throw AFTER the gate is released; by this time disposed is true.
        throw Object.assign(new Error('late failure'), { status: 500 });
      };

      await adapter.connect();

      // Kick off pollOnce (does not await — it's async-detached).
      const inFlight = adapter.pollOnce();
      // Yield so the poll reaches the `await port.listInboundSince` await.
      await Promise.resolve();
      // Disconnect → sets disposed=true → pollTimer cleared.
      await adapter.disconnect();

      // Release the gate — listInboundSince resolves to its throw, the
      // adapter enters the catch, and the `if (this.disposed) return` true
      // branch fires.
      gate.release?.();

      await inFlight;

      // No error was emitted (we returned before `safeEmit(error)`).
      expect(errors).toHaveLength(0);
      // State should still be 'disconnected' (auth_required branch did NOT run).
      expect(adapter.state().state).toBe('disconnected');
    });
  });
});