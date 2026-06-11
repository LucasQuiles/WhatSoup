// tests/transport/twilio/adapter-voice.test.ts
import { describe, it, expect } from 'vitest';
import { TwilioSmsAdapter } from '../../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';
import { makeTwilioConfig } from './helpers.ts';
import { isVoiceCallCapable } from '../../../src/transport/contract/voice.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';

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
});
