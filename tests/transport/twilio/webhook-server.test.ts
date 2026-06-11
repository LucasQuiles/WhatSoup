// tests/transport/twilio/webhook-server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks.js';
import { TwilioWebhookServer } from '../../../src/transport/twilio/webhook-server.ts';
import type { InboundSms } from '../../../src/transport/twilio/port.ts';

const TOKEN = 'test-webhook-token-0000';
const PUBLIC = 'https://example.test';

function makeServer(over: Partial<ConstructorParameters<typeof TwilioWebhookServer>[0]> = {}) {
  const smsRecords: InboundSms[] = [];
  const server = new TwilioWebhookServer({
    getAuthToken: () => TOKEN,
    publicBaseUrl: PUBLIC,
    listenPort: 0, // ephemeral
    listenAddress: '127.0.0.1',
    voice: { enabled: false, voicemailMaxLengthSec: 120 },
    onSms: (r) => smsRecords.push(r),
    onTranscript: () => {},
    ...over,
  });
  return { server, smsRecords };
}

async function post(port: number, path: string, params: Record<string, string>, sig?: string) {
  const body = new URLSearchParams(params).toString();
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(sig !== undefined ? { 'x-twilio-signature': sig } : {}),
    },
    body,
  });
}

let active: { stop(): Promise<void> } | null = null;
afterEach(async () => { await active?.stop(); active = null; });

describe('TwilioWebhookServer signature gate', () => {
  it('accepts a correctly signed inbound SMS and forwards it to onSms', async () => {
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    const params = { MessageSid: 'SM00000000000000000000000000000000', From: '+15551230001', To: '+15559990000', Body: 'hi' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/sms`, params);
    const res = await post(port, '/twilio/sms', params, sig);
    expect(res.status).toBe(204);
    expect(smsRecords).toHaveLength(1);
    expect(smsRecords[0].body).toBe('hi');
  });

  it('rejects a bad signature with 403 and forwards nothing', async () => {
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    const res = await post(port, '/twilio/sms', { MessageSid: 'SM1', From: '+1', To: '+2', Body: 'x' }, 'bogus');
    expect(res.status).toBe(403);
    expect(smsRecords).toHaveLength(0);
  });

  it('rejects a missing signature header with 403 (fail closed)', async () => {
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    const res = await post(port, '/twilio/sms', { MessageSid: 'SM1', From: '+1', To: '+2', Body: 'x' });
    expect(res.status).toBe(403);
    expect(smsRecords).toHaveLength(0);
  });

  it('fails closed with 503 when the auth token is unavailable', async () => {
    const { server, smsRecords } = makeServer({ getAuthToken: () => null });
    const port = await server.start(); active = server;
    const res = await post(port, '/twilio/sms', { MessageSid: 'SM1', From: '+1', To: '+2', Body: 'x' }, 'anything');
    expect(res.status).toBe(503);
    expect(smsRecords).toHaveLength(0);
  });

  it('returns 404 for unknown paths and 405 for GET on known paths', async () => {
    const { server } = makeServer();
    const port = await server.start(); active = server;
    expect((await post(port, '/nope', {})).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/twilio/sms`)).status).toBe(405);
  });
});

describe('TwilioWebhookServer voice routes', () => {
  it('answers an inbound call with say+record TwiML when voice is enabled', async () => {
    const { server } = makeServer({ voice: { enabled: true, voicemailMaxLengthSec: 90, voicemailGreeting: 'Leave a message.' } });
    const port = await server.start(); active = server;
    const params = { CallSid: 'CA00000000000000000000000000000000', From: '+15551230001', To: '+15559990000' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/voice`, params);
    const res = await post(port, '/twilio/voice', params, sig);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    const xml = await res.text();
    expect(xml).toContain('<Say>Leave a message.</Say>');
    expect(xml).toContain('transcribeCallback="https://example.test/twilio/voice/transcription"');
    expect(xml).toContain('maxLength="90"');
  });

  it('rejects an inbound call with TwiML <Reject> when voice is disabled', async () => {
    const { server } = makeServer(); // voice disabled
    const port = await server.start(); active = server;
    const params = { CallSid: 'CA1', From: '+15551230001', To: '+15559990000' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/voice`, params);
    const res = await post(port, '/twilio/voice', params, sig);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Reject');
  });

  it('forwards a completed transcription to onTranscript', async () => {
    const transcripts: unknown[] = [];
    const { server } = makeServer({
      voice: { enabled: true, voicemailMaxLengthSec: 120 },
      onTranscript: (t) => transcripts.push(t),
    });
    const port = await server.start(); active = server;
    const params = {
      TranscriptionText: 'call me back', TranscriptionStatus: 'completed',
      RecordingSid: 'RE00000000000000000000000000000000',
      RecordingUrl: 'https://api.twilio.test/media', CallSid: 'CA2',
      From: '+15551230001', To: '+15559990000',
    };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/voice/transcription`, params);
    const res = await post(port, '/twilio/voice/transcription', params, sig);
    expect(res.status).toBe(204);
    expect(transcripts).toHaveLength(1);
  });

  it('acknowledges failed transcription with 204 but forwards nothing', async () => {
    const transcripts: unknown[] = [];
    const { server } = makeServer({ voice: { enabled: true, voicemailMaxLengthSec: 120 }, onTranscript: (t) => transcripts.push(t) });
    const port = await server.start(); active = server;
    const params = { TranscriptionStatus: 'failed', RecordingSid: 'RE1', CallSid: 'CA3', From: '+1', To: '+2' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/voice/transcription`, params);
    const res = await post(port, '/twilio/voice/transcription', params, sig);
    expect(res.status).toBe(204);
    expect(transcripts).toHaveLength(0);
  });
});
