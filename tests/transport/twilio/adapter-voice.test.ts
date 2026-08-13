// tests/transport/twilio/adapter-voice.test.ts
import { describe, it, expect } from 'vitest';
import { TwilioSmsAdapter } from '../../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';
import { makeTwilioConfig } from './helpers.ts';
import { isVoiceCallCapable } from '../../../src/transport/contract/voice.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';
import type { InboundMessage } from '../../../src/transport/contract/index.ts';

describe('TwilioSmsAdapter voice capability', () => {
  it('is voice-call capable and delegates placeCall to the port', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(
      makeTwilioConfig({ voice: { enabled: true, voicemailMaxLengthSec: 120 } }), port);
    await adapter.connect();
    expect(isVoiceCallCapable(adapter)).toBe(true);
    const ref = await adapter.placeCall(
      { channel: makeChannelId('sms', 'ml-bot'), id: '+15551230001' });
    expect(ref.id).toMatch(/^CA/);
    expect(port.calls[0]).toMatchObject({ to: '+15551230001', from: '+15559990000' });
  });

  it('placeCall rejects with typed error when voice is disabled', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeTwilioConfig(), port); // voice default off
    await adapter.connect();
    await expect(
      adapter.placeCall({ channel: makeChannelId('sms', 'ml-bot'), id: '+15551230001' }),
    ).rejects.toThrow(/voice is not enabled/);
  });

  it('bare network-style placeCall failure throws SendAmbiguousError (non-retryable) — #2553', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(
      makeTwilioConfig({ voice: { enabled: true, voicemailMaxLengthSec: 120 } }), port);
    await adapter.connect();

    port.failNextCall(new Error('socket hang up'));

    // A call is a provider mutation too: a response-less network failure may
    // have placed it, so a generic retry risks a duplicate ring.
    await expect(
      adapter.placeCall({ channel: makeChannelId('sms', 'ml-bot'), id: '+15551230001' }),
    ).rejects.toMatchObject({
      payload: {
        code: 'transport.send_ambiguous',
        retryable: false,
        providerCode: 'network_no_reply',
      },
    });
  });
});


describe('TwilioSmsAdapter voicemail transcript ingestion', () => {
  it('handleTranscript emits an InboundMessage with voice attachment + transcript text', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(
      makeTwilioConfig({ voice: { enabled: true, voicemailMaxLengthSec: 120 } }), port);
    const got: InboundMessage[] = [];
    adapter.on('message', (m) => got.push(m));
    await adapter.connect();

    adapter.handleTranscript({
      text: 'call me back', recordingSid: 'RE00000000000000000000000000000000',
      recordingUrl: 'https://api.twilio.test/media', callSid: 'CA9',
      from: '+15551230001', to: '+15559990000',
    });
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('call me back');
    expect(got[0].attachments).toEqual([
      { id: 'RE00000000000000000000000000000000', kind: 'voice', mime: 'audio/mpeg' },
    ]);
    expect(got[0].inboundEventKey).toBe('RE00000000000000000000000000000000');
    expect(got[0].fromMe).toBe(false);
    // dedupe by recording sid
    adapter.handleTranscript({ text: 'call me back', recordingSid: 'RE00000000000000000000000000000000', callSid: 'CA9', from: '+15551230001', to: '+15559990000' });
    expect(got).toHaveLength(1);
    await adapter.disconnect();
  });
});

describe('TwilioSmsAdapter blank transcript handling', () => {
  it('a completed transcription with blank text emits text null (degenerate, not response-worthy downstream)', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(
      makeTwilioConfig({ voice: { enabled: true, voicemailMaxLengthSec: 120 } }), port);
    const got: InboundMessage[] = [];
    adapter.on('message', (m) => got.push(m));
    await adapter.connect();
    adapter.handleTranscript({
      text: '   ', recordingSid: 'RE00000000000000000000000000000009',
      callSid: 'CA9', from: '+15551230001', to: '+15559990000',
    });
    expect(got).toHaveLength(1);
    expect(got[0].text).toBeNull();
    expect(got[0].attachments[0].kind).toBe('voice');
    await adapter.disconnect();
  });
});
