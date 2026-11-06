// Startup readiness -> memory guidance gate, through the REAL Pinecone SDK
// (listIndexes, its retrying fetch and its error middleware) with only the
// network stubbed. SDK 8 errors carry no HTTP status: an exhausted 5xx arrives
// as PineconeMaxRetriesExceededError, a 429 as PineconeUnmappedHttpError, a 401
// as PineconeAuthorizationError. These rows pin that the readiness probe's own
// record of the response status, not the error object, decides whether a
// startup failure is transient (block shown) or definitive (block hidden).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../../src/config.ts', () => ({
  config: {
    pineconeIndex: 'memory',
    pineconeContextTopK: 10,
    pineconeSenderTopK: 5,
    enrichmentDedupThreshold: 0.95,
    memory: { pinecone: { apiKeyEnv: 'PINECONE_API_KEY' } },
  },
}));

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});

vi.mock('../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => null),
}));

import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { getPineconeReadinessObservation } from '../../../src/runtimes/chat/providers/pinecone.ts';
import { memoryGuidanceSystemBlock } from '../../../src/runtimes/agent/memory-guidance.ts';

type FetchStub = () => Promise<Response>;

/** Every attempt gets a fresh response, as the SDK retries 5xx up to three times. */
function respond(status: number, body: unknown = { error: { code: 'STUB', message: 'stubbed response' } }): FetchStub {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** undici's shape for a connection failure: TypeError 'fetch failed', the cause carrying the code. */
function connectionFailure(code?: string): FetchStub {
  return async () => {
    throw new TypeError('fetch failed', code ? { cause: Object.assign(new Error('connect failed'), { code }) } : undefined);
  };
}

const registry = new ToolRegistry();
registry.register({
  name: 'memory_write', description: 'stand-in', scope: 'chat', targetMode: 'injected',
  schema: z.object({ chatJid: z.string() }), handler: async () => ({ ok: true }),
});

async function startupWith(fetchStub: FetchStub) {
  vi.stubGlobal('fetch', vi.fn(fetchStub));
  const readiness = await getPineconeReadinessObservation('memory');
  const block = memoryGuidanceSystemBlock({
    readiness,
    registry,
    session: { tier: 'chat-scoped', conversationKey: 'chat' },
    instanceName: 'bot',
    memoryIndex: 'memory',
    allowedMcpTools: undefined,
  });
  return { state: readiness.state, failureCode: readiness.failureCode, guidance: block ? 'present' : 'absent' };
}

describe('memory guidance after a real SDK startup probe', () => {
  beforeEach(() => {
    process.env.PINECONE_API_KEY = 'pcsk-test';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PINECONE_API_KEY;
  });

  const rows: Array<[string, FetchStub, Record<string, string>]> = [
    ['200 with the index listed', respond(200, { indexes: [{ name: 'memory', host: 'memory-abc1234.svc.pinecone.io' }] }),
      { state: 'ready', guidance: 'present' }],
    ['500 after the SDK retries', respond(500), { failureCode: 'provider_unavailable', guidance: 'present' }],
    ['503 after the SDK retries', respond(503), { failureCode: 'provider_unavailable', guidance: 'present' }],
    ['429', respond(429), { failureCode: 'rate_limited', guidance: 'present' }],
    ['408', respond(408), { failureCode: 'timeout', guidance: 'present' }],
    ['401', respond(401), { state: 'auth_failed', failureCode: 'auth_failed', guidance: 'absent' }],
    ['403', respond(403), { state: 'auth_failed', failureCode: 'auth_failed', guidance: 'absent' }],
    ['404 (other 4xx)', respond(404), { failureCode: 'invalid_request', guidance: 'absent' }],
    ['ECONNREFUSED', connectionFailure('ECONNREFUSED'), { failureCode: 'network_error', guidance: 'present' }],
    ['UND_ERR_CONNECT_TIMEOUT', connectionFailure('UND_ERR_CONNECT_TIMEOUT'), { failureCode: 'network_error', guidance: 'present' }],
    ['UND_ERR_SOCKET', connectionFailure('UND_ERR_SOCKET'), { failureCode: 'network_error', guidance: 'present' }],
    ['EHOSTUNREACH', connectionFailure('EHOSTUNREACH'), { failureCode: 'network_error', guidance: 'present' }],
    ['ENETUNREACH', connectionFailure('ENETUNREACH'), { failureCode: 'network_error', guidance: 'present' }],
    ['bare fetch failed (no code, no status)', connectionFailure(), { failureCode: 'network_error', guidance: 'present' }],
    // Not wrapped as 'fetch failed', so only the shared network code list classifies it.
    ['socket closed mid-response (terminated, UND_ERR_SOCKET)', async () => {
      throw new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    }, { failureCode: 'network_error', guidance: 'present' }],
  ];

  for (const [label, fetchStub, expected] of rows) {
    it(`${label} -> block ${expected.guidance}`, async () => {
      expect(await startupWith(fetchStub)).toMatchObject(expected);
    });
  }
});
