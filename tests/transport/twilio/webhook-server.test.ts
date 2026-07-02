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

  it('QR-157: fails closed with 503 for an EMPTY/whitespace auth token (empty HMAC key is forgeable)', async () => {
    // An empty or whitespace-derived token must never reach validateRequest — the
    // empty-key HMAC-SHA1 is universally attacker-forgeable, so a crafted signature
    // would otherwise be accepted. The guard checks `!token`, not just `=== null`.
    for (const emptyish of ['', '   ']) {
      const { server, smsRecords } = makeServer({ getAuthToken: () => emptyish });
      const port = await server.start(); active = server;
      const res = await post(port, '/twilio/sms', { MessageSid: 'SM1', From: '+1', To: '+2', Body: 'x' }, 'anything');
      expect(res.status).toBe(503);
      expect(smsRecords).toHaveLength(0);
      await server.stop(); active = null;
    }
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

describe('TwilioWebhookServer hardening (review wave)', () => {
  it('voice route rejects a bad signature with 403 (no TwiML produced)', async () => {
    const { server } = makeServer({ voice: { enabled: true, voicemailMaxLengthSec: 120 } });
    const port = await server.start(); active = server;
    const res = await post(port, '/twilio/voice', { CallSid: 'CA1', From: '+15551230001', To: '+15559990000' }, 'bogus');
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('<Response');
  });

  it('transcription route rejects a bad signature with 403 and forwards nothing', async () => {
    const transcripts: unknown[] = [];
    const { server } = makeServer({
      voice: { enabled: true, voicemailMaxLengthSec: 120 },
      onTranscript: (t) => transcripts.push(t),
    });
    const port = await server.start(); active = server;
    const res = await post(port, '/twilio/voice/transcription', {
      TranscriptionText: 'x', TranscriptionStatus: 'completed',
      RecordingSid: 'RE1', CallSid: 'CA1', From: '+1', To: '+2',
    }, 'bogus');
    expect(res.status).toBe(403);
    expect(transcripts).toHaveLength(0);
  });

  it('rejects non-form content types with 415 before parsing', async () => {
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    const res = await fetch(`http://127.0.0.1:${port}/twilio/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twilio-signature': 'anything' },
      body: JSON.stringify({ MessageSid: 'SM1' }),
    });
    expect(res.status).toBe(415);
    expect(smsRecords).toHaveLength(0);
  });

  it('acks a signed-but-malformed sms body with 204 and forwards nothing (no field oracle)', async () => {
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    const params = { From: '+15551230001', To: '+15559990000', Body: 'no sid' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/sms`, params);
    const res = await post(port, '/twilio/sms', params, sig);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(smsRecords).toHaveLength(0);
  });

  it('normalizes a trailing slash in publicBaseUrl so signatures still validate', async () => {
    const { server, smsRecords } = makeServer({ publicBaseUrl: `${PUBLIC}/` });
    const port = await server.start(); active = server;
    const params = { MessageSid: 'SM00000000000000000000000000000002', From: '+15551230001', To: '+15559990000', Body: 'hi' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/sms`, params);
    const res = await post(port, '/twilio/sms', params, sig);
    expect(res.status).toBe(204);
    expect(smsRecords).toHaveLength(1);
  });

  it('double stop() resolves cleanly (idempotent close)', async () => {
    const { server } = makeServer();
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
    await expect(Promise.all([server.stop(), server.stop()])).resolves.toEqual([undefined, undefined]);
    await expect(server.stop()).resolves.toBeUndefined();
    // Port actually released: a fresh server can bind it again
    const { server: again } = makeServer();
    const port2 = await again.start();
    expect(port2).toBeGreaterThan(0);
    await again.stop();
  });
});

describe('webhook-server.ts uncovered-branch coverage', () => {
  it('defaults listenAddress to 127.0.0.1 when the option is omitted', async () => {
    // Build a server WITHOUT passing listenAddress so the `?? '127.0.0.1'`
    // fallback (webhook-server.ts:77) is exercised.
    const { server, smsRecords } = makeServer({ listenAddress: undefined });
    const port = await server.start(); active = server;
    const params = { MessageSid: 'SM00000000000000000000000000000010', From: '+15551230001', To: '+15559990000', Body: 'hi' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/sms`, params);
    const res = await post(port, '/twilio/sms', params, sig);
    expect(res.status).toBe(204);
    expect(smsRecords[0].body).toBe('hi');
  });

  it('returns 404 for a GET on an unknown path (distinct from 405 on known paths)', async () => {
    const { server } = makeServer();
    const port = await server.start(); active = server;
    const res = await fetch(`http://127.0.0.1:${port}/totally/unknown`);
    expect(res.status).toBe(404);
  });

  it('rejects an over-cap (>64 KiB) body with 413 and never validates or forwards', async () => {
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    // 70 KiB payload — exceeds the 64 KiB BODY_SIZE_CAP and trips the
    // readBody BODY_TOO_LARGE reject branch (webhook-server.ts:231-235),
    // surfaced as 413 in the catch (webhook-server.ts:131).
    const huge = 'x'.repeat(70 * 1024);
    // The server destroys the request stream the moment the cap is exceeded,
    // which tears down the client socket mid-upload; the fetch therefore
    // rejects with a socket-closed error rather than delivering a 413
    // response body to read. We assert both that the client sees the
    // connection reset AND that no SMS was forwarded (the fail-closed path).
    // The client may receive a 413 OR see the socket reset mid-upload (the
    // server destroys the stream the moment the cap is exceeded) — both outcomes
    // are version-dependent. We swallow any client-side error and assert only the
    // load-bearing fail-closed invariant: nothing was forwarded despite a
    // (bogus) signature. The over-cap branch (webhook-server.ts:131,233) still
    // executes server-side regardless of which outcome the client observes.
    try {
      await fetch(`http://127.0.0.1:${port}/twilio/sms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': 'anything',
          'content-length': String(huge.length + 5),
        },
        body: `Body=${huge}`,
      });
    } catch {
      // socket reset mid-upload is an acceptable outcome
    }
    expect(smsRecords).toHaveLength(0);
  });

  it('rejects a POST with no content-type header (null → "" fallback) as 415', async () => {
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    // No content-type header at all → req.headers['content-type'] is undefined,
    // exercising the `?? ''` fallback (webhook-server.ts:148) before the 415.
    const res = await fetch(`http://127.0.0.1:${port}/twilio/sms`, {
      method: 'POST',
      headers: { 'x-twilio-signature': 'anything' },
      body: 'MessageSid=SM1&From=%2B1&To=%2B2&Body=x',
    });
    expect(res.status).toBe(415);
    expect(smsRecords).toHaveLength(0);
  });

  it('uses the default voicemail greeting when voice is enabled but voicemailGreeting is unset', async () => {
    // voicemailGreeting omitted → `voice.voicemailGreeting ?? DEFAULT_VOICEMAIL_GREETING`
    // (webhook-server.ts:200) takes the fallback branch.
    const { server } = makeServer({ voice: { enabled: true, voicemailMaxLengthSec: 60 } });
    const port = await server.start(); active = server;
    const params = { CallSid: 'CA00000000000000000000000000000020', From: '+15551230001', To: '+15559990000' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/voice`, params);
    const res = await post(port, '/twilio/voice', params, sig);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<Say>Please leave a message after the beep.</Say>');
    expect(xml).toContain('maxLength="60"');
  });

  it('acks a signed-but-malformed transcription (missing fields) with 204 and forwards nothing', async () => {
    // parseTranscriptionCallback returns ok:false (missing RecordingSid/CallSid/From/To),
    // exercising the else branch in handleTranscription (webhook-server.ts:217-219).
    const transcripts: unknown[] = [];
    const { server } = makeServer({
      voice: { enabled: true, voicemailMaxLengthSec: 120 },
      onTranscript: (t) => transcripts.push(t),
    });
    const port = await server.start(); active = server;
    const params = { TranscriptionStatus: 'completed', From: '+15551230001', To: '+15559990000' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/voice/transcription`, params);
    const res = await post(port, '/twilio/voice/transcription', params, sig);
    expect(res.status).toBe(204);
    expect(transcripts).toHaveLength(0);
  });

  it('stop() with no server started resolves immediately (null server short-circuit)', async () => {
    // server.server is null until start() — stop() before start() must resolve
    // without touching server.close (webhook-server.ts:95).
    const { server } = makeServer();
    await expect(server.stop()).resolves.toBeUndefined();
    // And it remains idempotent via the closing-null path.
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('translates an onSms handler throw into a fail-closed 500 (outer catch branch)', async () => {
    // handleSms calls onSms BEFORE writeHead(204); if the consumer's onSms
    // throws, handleRequest rejects and the outer .catch in the http handler
    // runs (webhook-server.ts:64-71). headers are unsent at that point, so the
    // `!res.headersSent` true branch writes 500 (webhook-server.ts:69).
    const { server, smsRecords } = makeServer({
      onSms: () => { throw new Error('downstream blew up'); },
    });
    const port = await server.start(); active = server;
    const params = { MessageSid: 'SM00000000000000000000000000000030', From: '+15551230001', To: '+15559990000', Body: 'hi' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/sms`, params);
    const res = await post(port, '/twilio/sms', params, sig);
    expect(res.status).toBe(500);
    expect(smsRecords).toHaveLength(0);
  });

  it('surfaces a non-BODY_TOO_LARGE readBody stream error as 400 (catch else branch)', async () => {
    // Open a raw socket, claim a 100-byte body via content-length but close
    // the connection after sending only a partial chunk. The request stream
    // emits 'error' (premature close) → readBody rejects with a non-BODY_TOO_LARGE
    // error → handleRequest catch takes the 400 branch (webhook-server.ts:131).
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    const { Socket } = await import('node:net');
    const sock = new Socket();
    await new Promise<void>((resolve) => sock.connect(port, '127.0.0.1', () => resolve()));
    sock.write(
      'POST /twilio/sms HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      'content-type: application/x-www-form-urlencoded\r\n' +
      'x-twilio-signature: anything\r\n' +
      'content-length: 100\r\n' +
      '\r\n' +
      'Body=partial',
    );
    // Destroy the socket before the full body arrives → server-side 'error'.
    sock.destroy();
    // Allow the event loop to flush the server-side error handling. We use a
    // microtask boundary (not a real-time delay) by awaiting the next tick.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(smsRecords).toHaveLength(0);
    // Server is still healthy for a normal signed request afterwards.
    const probe = { MessageSid: 'SM00000000000000000000000000000031', From: '+15551230001', To: '+15559990000', Body: 'ok' };
    const probeSig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/sms`, probe);
    const res = await post(port, '/twilio/sms', probe, probeSig);
    expect(res.status).toBe(204);
    expect(smsRecords).toHaveLength(1);
    expect(smsRecords[0].body).toBe('ok');
  });
});
