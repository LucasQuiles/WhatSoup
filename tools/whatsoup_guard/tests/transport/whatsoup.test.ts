import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WhatSoupSink } from '../../src/transport/whatsoup.ts';

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
  responses = [{ status: 200, body: '{"ok":true}' }];
  server = createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

describe('WhatSoupSink', () => {
  it('posts the alert body to /send with bearer auth and conversation key', async () => {
    const sink = new WhatSoupSink({
      baseUrl,
      conversationKey: 'conversation-alpha',
      token: 'test-token',
    });

    const result = await sink.deliver({ body: 'hello operator' });

    expect(result).toEqual({ ok: true, channel: 'whatsoup' });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toBeDefined();
    if (!request) throw new Error('expected one request');
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/send');
    expect(request.headers.authorization).toBe('Bearer test-token');
    expect(request.headers['content-type']).toContain('application/json');
    expect(JSON.parse(request.body)).toEqual({
      conversation_key: 'conversation-alpha',
      text: 'hello operator',
    });
  });

  it('includes delivery_jid only when configured', async () => {
    const withoutDeliveryJid = new WhatSoupSink({
      baseUrl,
      conversationKey: 'conversation-alpha',
      token: 'test-token',
    });

    await withoutDeliveryJid.deliver({ body: 'first' });

    const withDeliveryJid = new WhatSoupSink({
      baseUrl,
      conversationKey: 'conversation-alpha',
      deliveryJid: 'recipient@s.whatsapp.net',
      token: 'test-token',
    });

    await withDeliveryJid.deliver({ body: 'second' });

    const first = requests[0];
    const second = requests[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error('expected two requests');
    expect(JSON.parse(first.body)).not.toHaveProperty('delivery_jid');
    expect(JSON.parse(second.body)).toMatchObject({
      delivery_jid: 'recipient@s.whatsapp.net',
    });
  });

  it('treats malformed JSON on HTTP 200 as delivered without requiring a message id', async () => {
    responses = [{ status: 200, body: 'not-json' }];
    const sink = new WhatSoupSink({ baseUrl, conversationKey: 'conversation-alpha', token: 'test-token' });

    const result = await sink.deliver({ body: 'hello' });

    expect(result).toEqual({ ok: true, channel: 'whatsoup' });
    expect(requests).toHaveLength(1);
  });

  it.each([401, 403])('does not retry %i authorization failures', async (status) => {
    responses = [
      { status, body: '{"error":"unauthorized"}' },
      { status: 200, body: '{"ok":true}' },
    ];
    const sink = new WhatSoupSink({
      baseUrl,
      conversationKey: 'conversation-alpha',
      token: 'sensitive-token',
      retry: [1, 1],
    });

    const result = await sink.deliver({ body: 'hello' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain(`http ${status}`);
    expect(result.error).not.toContain('sensitive-token');
    expect(requests).toHaveLength(1);
  });

  it('retries server failures with bounded retry count', async () => {
    responses = [
      { status: 503, body: 'unavailable' },
      { status: 502, body: 'bad gateway' },
      { status: 200, body: '{"ok":true}' },
      { status: 200, body: '{"ok":true}' },
    ];
    const sink = new WhatSoupSink({
      baseUrl,
      conversationKey: 'conversation-alpha',
      token: 'test-token',
      retry: [1, 1],
    });

    const result = await sink.deliver({ body: 'hello' });

    expect(result).toEqual({ ok: true, channel: 'whatsoup' });
    expect(requests).toHaveLength(3);
  });

  it('uses retry_other for non-critical alerts', async () => {
    responses = [
      { status: 503, body: 'unavailable' },
      { status: 200, body: '{"ok":true}' },
    ];
    const sink = new WhatSoupSink({
      baseUrl,
      conversationKey: 'conversation-alpha',
      token: 'test-token',
      retryCrit: [],
      retryOther: [0],
    });

    const result = await sink.deliver({ body: 'hello', severity: 'high' });

    expect(result).toEqual({ ok: true, channel: 'whatsoup' });
    expect(requests).toHaveLength(2);
  });

  it('uses retry_crit for critical alerts', async () => {
    responses = [
      { status: 503, body: 'unavailable' },
      { status: 200, body: '{"ok":true}' },
    ];
    const sink = new WhatSoupSink({
      baseUrl,
      conversationKey: 'conversation-alpha',
      token: 'test-token',
      retryCrit: [0],
      retryOther: [],
    });

    const result = await sink.deliver({ body: 'hello', severity: 'crit' });

    expect(result).toEqual({ ok: true, channel: 'whatsoup' });
    expect(requests).toHaveLength(2);
  });

  it('returns failure with final status after retry exhaustion', async () => {
    responses = [
      { status: 500, body: 'first failure' },
      { status: 503, body: 'second failure' },
      { status: 503, body: 'extra response should not be used' },
    ];
    const sink = new WhatSoupSink({
      baseUrl,
      conversationKey: 'conversation-alpha',
      token: 'sensitive-token',
      retry: [1],
    });

    const result = await sink.deliver({ body: 'hello' });

    expect(result.ok).toBe(false);
    expect(result.channel).toBe('whatsoup');
    expect(result.error).toContain('http 503');
    expect(result.error).toContain('after 2 attempts');
    expect(result.error).not.toContain('sensitive-token');
    expect(requests).toHaveLength(2);
  });

  it('returns failure when the request times out', async () => {
    responses = [{ status: 200, body: '{"ok":true}', delayMs: 100 }];
    const sink = new WhatSoupSink({
      baseUrl,
      conversationKey: 'conversation-alpha',
      token: 'sensitive-token',
      timeoutMs: 25,
    });

    const result = await sink.deliver({ body: 'hello' });

    expect(result.ok).toBe(false);
    expect(result.channel).toBe('whatsoup');
    expect(result.error).toMatch(/timeout|abort/i);
    expect(result.error).not.toContain('sensitive-token');
    expect(requests).toHaveLength(1);
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
      res.setHeader('content-type', 'application/json');
      res.end(response.body ?? '');
    }, response.delayMs ?? 0);
  });
}
