import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAnthropicApiModelIdsWithStatus } from '../../src/lib/model-advisor.ts';

const MAX_BYTES = 1024 * 1024;
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

describe('model catalogue HTTP boundaries', () => {
  it('does not follow a redirect or forward the API key to its target', async () => {
    const targets: string[] = [];
    const server = createServer((request, response) => {
      if (request.url === '/models') {
        response.writeHead(302, { location: '/redirected' });
        response.end();
      } else {
        targets.push(String(request.headers['x-api-key']));
        response.end(JSON.stringify({ data: [{ id: 'redirected-model' }] }));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing fixture address');
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => realFetch(`http://127.0.0.1:${address.port}/models`, init));

    expect(await fetchAnthropicApiModelIdsWithStatus({ resolveKey: () => 'fixture-key' }))
      .toEqual({ status: 'failed', category: 'lookup-failed' });
    expect(targets).toEqual([]);
  });

  it.each(['x', '😀'])('cancels an oversized streamed response measured in bytes (%s)', async (character) => {
    const cancel = vi.fn();
    const chunks = [
      new TextEncoder().encode('{"data":[{"id":"model"}],"padding":"'),
      new TextEncoder().encode(character.repeat(Math.floor(MAX_BYTES / character.length) + 1)),
      new TextEncoder().encode('"}'),
    ];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));

    expect(await fetchAnthropicApiModelIdsWithStatus({ resolveKey: () => 'fixture-key' }))
      .toEqual({ status: 'failed', category: 'lookup-failed' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('accepts valid JSON exactly at the byte limit', async () => {
    const json = JSON.stringify({ data: [{ id: 'bounded-model' }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(json.padEnd(MAX_BYTES, ' '))));
    expect(await fetchAnthropicApiModelIdsWithStatus({ resolveKey: () => 'fixture-key' }))
      .toEqual({ status: 'ok', ids: ['bounded-model'] });
  });
});
