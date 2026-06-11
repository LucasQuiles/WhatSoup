// tests/transport/twilio/webhook-payloads.test.ts
import { describe, it, expect } from 'vitest';
import { parseInboundSmsWebhook, parseTranscriptionCallback } from '../../../src/transport/twilio/webhook-payloads.ts';

describe('parseInboundSmsWebhook', () => {
  it('maps a complete body to an InboundSms-shaped record', () => {
    const r = parseInboundSmsWebhook({
      MessageSid: 'SM00000000000000000000000000000000',
      From: '+15551230001', To: '+15559990000', Body: 'hello',
    }, new Date('2026-06-11T00:00:00Z'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record).toMatchObject({
        sid: 'SM00000000000000000000000000000000',
        from: '+15551230001', to: '+15559990000', body: 'hello', fromMe: false,
      });
    }
  });
  it('rejects a body missing MessageSid with a named reason (no throw)', () => {
    const r = parseInboundSmsWebhook({ From: '+15551230001', To: '+15559990000', Body: 'x' }, new Date());
    expect(r).toEqual({ ok: false, reason: 'missing MessageSid' });
  });
});

describe('parseTranscriptionCallback', () => {
  it('maps a completed transcription', () => {
    const r = parseTranscriptionCallback({
      TranscriptionText: 'call me back', TranscriptionStatus: 'completed',
      RecordingSid: 'RE00000000000000000000000000000000',
      RecordingUrl: 'https://api.twilio.com/recording-media',
      CallSid: 'CA00000000000000000000000000000000',
      From: '+15551230001', To: '+15559990000',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.transcript.text).toBe('call me back');
  });
  it('reports failed transcription status as ok:false with reason', () => {
    const r = parseTranscriptionCallback({ TranscriptionStatus: 'failed', RecordingSid: 'RE0', CallSid: 'CA0', From: '+1', To: '+2' });
    expect(r).toEqual({ ok: false, reason: 'transcription status failed' });
  });
});
