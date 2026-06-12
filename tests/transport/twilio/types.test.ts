// tests/transport/twilio/types.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_TWILIO_SMS } from '../../../src/transport/twilio/types.ts';

describe('twilio config defaults', () => {
  it('defaults to poll inbound with pinned conservative values', () => {
    expect(DEFAULT_TWILIO_SMS.inboundMode).toBe('poll');
    expect(DEFAULT_TWILIO_SMS.pollIntervalMs).toBe(15000);
    expect(DEFAULT_TWILIO_SMS.rateLimit.smsPerMinute).toBe(30);
  });

  it('DEFAULT_TWILIO_SMS is deeply frozen', () => {
    expect(Object.isFrozen(DEFAULT_TWILIO_SMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TWILIO_SMS.rateLimit)).toBe(true);
  });
});

describe('webhook + voice config defaults', () => {
  it('webhook defaults are absent until configured; voice defaults off', () => {
    expect(DEFAULT_TWILIO_SMS.voice).toEqual({ enabled: false, voicemailMaxLengthSec: 120 });
  });
});
