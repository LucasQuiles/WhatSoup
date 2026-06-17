// tests/transport/twilio/webhook-payloads.test.ts
import { describe, it, expect } from 'vitest';
import { parseInboundSmsWebhook, parseTranscriptionCallback } from '../../../src/transport/twilio/webhook-payloads.ts';

describe('parseInboundSmsWebhook', () => {
  it('maps a complete body to an InboundSms-shaped record', () => {
    const receivedAt = new Date('2026-06-11T00:00:00Z');
    const r = parseInboundSmsWebhook({
      MessageSid: 'SM00000000000000000000000000000000',
      From: '+15551230001',
      To: '+15559990000',
      Body: 'hello',
      SmsStatus: 'received',
    }, receivedAt);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record).toMatchObject({
        sid: 'SM00000000000000000000000000000000',
        from: '+15551230001',
        to: '+15559990000',
        body: 'hello',
        fromMe: false,
        status: 'received',
      });
      expect(r.record.sentAt).toBe(receivedAt);
    }
  });

  it('defaults an omitted SMS body to an empty string', () => {
    const r = parseInboundSmsWebhook({
      MessageSid: 'SM00000000000000000000000000000000',
      From: '+15551230001',
      To: '+15559990000',
    }, new Date('2026-06-11T00:00:00Z'));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.body).toBe('');
  });

  it.each([
    ['MessageSid', { From: '+15551230001', To: '+15559990000', Body: 'x' }],
    ['From', { MessageSid: 'SM00000000000000000000000000000000', To: '+15559990000', Body: 'x' }],
    ['To', { MessageSid: 'SM00000000000000000000000000000000', From: '+15551230001', Body: 'x' }],
  ])('rejects a body missing %s with a named reason (no throw)', (field, body) => {
    const r = parseInboundSmsWebhook(body, new Date());

    expect(r).toEqual({ ok: false, reason: `missing ${field}` });
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

  it('maps an omitted transcription text to an empty string', () => {
    const r = parseTranscriptionCallback({
      TranscriptionStatus: 'completed',
      RecordingSid: 'RE00000000000000000000000000000000',
      CallSid: 'CA00000000000000000000000000000000',
      From: '+15551230001',
      To: '+15559990000',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.transcript.text).toBe('');
      expect(r.transcript.recordingUrl).toBeUndefined();
    }
  });

  it('reports failed transcription status as ok:false with reason', () => {
    const r = parseTranscriptionCallback({
      TranscriptionStatus: 'failed',
      RecordingSid: 'RE0',
      CallSid: 'CA0',
      From: '+1',
      To: '+2',
    });
    expect(r).toEqual({ ok: false, reason: 'transcription status failed' });
  });

  it('reports missing transcription status before checking other fields', () => {
    const r = parseTranscriptionCallback({
      RecordingSid: 'RE0',
      CallSid: 'CA0',
      From: '+1',
      To: '+2',
    });

    expect(r).toEqual({ ok: false, reason: 'transcription status missing' });
  });

  it.each([
    ['RecordingSid', { TranscriptionStatus: 'completed', CallSid: 'CA0', From: '+1', To: '+2' }],
    ['CallSid', { TranscriptionStatus: 'completed', RecordingSid: 'RE0', From: '+1', To: '+2' }],
    ['From', { TranscriptionStatus: 'completed', RecordingSid: 'RE0', CallSid: 'CA0', To: '+2' }],
    ['To', { TranscriptionStatus: 'completed', RecordingSid: 'RE0', CallSid: 'CA0', From: '+1' }],
  ])('rejects a completed transcription missing %s with a named reason', (field, body) => {
    const r = parseTranscriptionCallback(body);

    expect(r).toEqual({ ok: false, reason: `missing ${field}` });
  });
});
