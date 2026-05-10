import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NtfySink } from '../../src/transport/meta-alert/ntfy.ts';
import { PushoverSink } from '../../src/transport/meta-alert/pushover.ts';
import { WebhookSink } from '../../src/transport/meta-alert/webhook.ts';

interface RecordedRequest {
  body: string;
  headers: IncomingMessage['headers'];
  method: string | undefined;
  url: string | undefined;
}

interface QueuedResponse {
  body?: string;
  delayMs?: number;
  status: number;
}

let server: Server;
let baseUrl = '';
let requests: RecordedRequest[] = [];
let responses: QueuedResponse[] = [];

beforeEach(async () => {
  requests = [];
  responses = [{ status: 200, body: 'ok' }];
  server = createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await closeServer();
});

describe('meta-alert adapters', () => {
  it('NtfySink posts body text to a normalized topic URL without auth when token is absent', async () => {
    const sink = new NtfySink({ baseUrl: `${baseUrl}/`, topic: 'guard-topic' });

    const result = await sink.deliver({ body: 'hello operator' });

    expect(result).toEqual({ ok: true, channel: 'meta-ntfy' });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toBeDefined();
    if (!request) throw new Error('expected one request');
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/guard-topic');
    expect(request.headers['content-type']).toContain('text/plain');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).toBe('hello operator');
  });

  it('NtfySink includes bearer authorization only when token is configured', async () => {
    const sink = new NtfySink({ baseUrl, topic: 'guard-topic', token: 'ntfy-token' });

    const result = await sink.deliver({ body: 'hello' });

    expect(result).toEqual({ ok: true, channel: 'meta-ntfy' });
    expect(requests[0]?.headers.authorization).toBe('Bearer ntfy-token');
  });

  it('PushoverSink posts form-encoded token, user, title, and message fields', async () => {
    const sink = new PushoverSink({
      apiUrl: `${baseUrl}/1/messages.json`,
      token: 'push-token',
      user: 'push-user',
      title: 'guard title',
    });

    const result = await sink.deliver({ body: 'hi from guard' });

    expect(result).toEqual({ ok: true, channel: 'meta-pushover' });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toBeDefined();
    if (!request) throw new Error('expected one request');
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/1/messages.json');
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(new URLSearchParams(request.body)).toEqual(
      new URLSearchParams({
        token: 'push-token',
        user: 'push-user',
        title: 'guard title',
        message: 'hi from guard',
      }),
    );
  });

  it('WebhookSink posts a JSON body without auth when bearer is absent', async () => {
    const sink = new WebhookSink({ url: `${baseUrl}/hook` });

    const result = await sink.deliver({ body: 'payload text' });

    expect(result).toEqual({ ok: true, channel: 'meta-webhook' });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toBeDefined();
    if (!request) throw new Error('expected one request');
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/hook');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['content-type']).toContain('application/json');
    expect(JSON.parse(request.body)).toEqual({ body: 'payload text' });
  });

  it('WebhookSink includes bearer authorization only when bearer is configured', async () => {
    const sink = new WebhookSink({ url: `${baseUrl}/hook`, bearer: 'webhook-token' });

    const result = await sink.deliver({ body: 'payload text' });

    expect(result).toEqual({ ok: true, channel: 'meta-webhook' });
    expect(requests[0]?.headers.authorization).toBe('Bearer webhook-token');
  });

  it.each([
    ['meta-ntfy', () => new NtfySink({ baseUrl, topic: 'guard-topic', token: 'ntfy-secret' })],
    [
      'meta-pushover',
      () => new PushoverSink({ apiUrl: `${baseUrl}/1/messages.json`, token: 'push-secret', user: 'push-user' }),
    ],
    ['meta-webhook', () => new WebhookSink({ url: `${baseUrl}/hook`, bearer: 'webhook-secret' })],
  ])('%s returns a redacted failure for non-2xx responses', async (channel, createSink) => {
    responses = [{ status: 503, body: 'unavailable' }];

    const result = await createSink().deliver({ body: 'hello' });

    expect(result.ok).toBe(false);
    expect(result.channel).toBe(channel);
    expect(result.error).toContain('http 503');
    expect(result.error).not.toMatch(/ntfy-secret|push-secret|webhook-secret/u);
    expect(requests).toHaveLength(1);
  });

  it.each([
    [
      'meta-ntfy',
      (url: string) => new NtfySink({ baseUrl: url, topic: 'guard-topic', token: 'ntfy-secret' }),
      'ntfy-secret',
    ],
    [
      'meta-pushover',
      (url: string) => new PushoverSink({ apiUrl: `${url}/1/messages.json`, token: 'push-secret', user: 'push-user' }),
      'push-secret',
    ],
    [
      'meta-webhook',
      (url: string) => new WebhookSink({ url: `${url}/hook`, bearer: 'webhook-secret' }),
      'webhook-secret',
    ],
  ])('%s returns a redacted failure when the request cannot connect', async (channel, createSink, secret) => {
    const closedBaseUrl = baseUrl;
    await closeServer();

    const result = await createSink(closedBaseUrl).deliver({ body: 'hello' });

    expect(result.ok).toBe(false);
    expect(result.channel).toBe(channel);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(secret);
  });

  it.each([
    ['meta-ntfy', () => new NtfySink({ baseUrl, topic: 'guard-topic', timeoutMs: 5 })],
    [
      'meta-pushover',
      () => new PushoverSink({ apiUrl: `${baseUrl}/1/messages.json`, token: 'push-token', user: 'push-user', timeoutMs: 5 }),
    ],
    ['meta-webhook', () => new WebhookSink({ url: `${baseUrl}/hook`, timeoutMs: 5 })],
  ])('%s returns a timeout failure with channel context', async (channel, createSink) => {
    responses = [{ status: 200, body: 'ok', delayMs: 50 }];

    const result = await createSink().deliver({ body: 'hello' });

    expect(result.ok).toBe(false);
    expect(result.channel).toBe(channel);
    expect(result.error).toContain('timeout');
  });

  it.each([
    ['NtfySink', () => new NtfySink({ baseUrl, topic: 'guard-topic', token: '' })],
    ['PushoverSink token', () => new PushoverSink({ apiUrl: `${baseUrl}/1/messages.json`, token: '', user: 'push-user' })],
    ['PushoverSink user', () => new PushoverSink({ apiUrl: `${baseUrl}/1/messages.json`, token: 'push-token', user: '' })],
    ['WebhookSink', () => new WebhookSink({ url: `${baseUrl}/hook`, bearer: '' })],
  ])('%s fails before dispatch when a configured secret value is blank', async (_label, createSink) => {
    const result = await createSink().deliver({ body: 'hello' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing');
    expect(requests).toHaveLength(0);
  });
});

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    requests.push({ body, headers: req.headers, method: req.method, url: req.url });
    const response = responses.shift() ?? { status: 500, body: 'no queued response' };
    setTimeout(() => {
      res.statusCode = response.status;
      res.end(response.body ?? '');
    }, response.delayMs ?? 0);
  });
}

async function closeServer(): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
