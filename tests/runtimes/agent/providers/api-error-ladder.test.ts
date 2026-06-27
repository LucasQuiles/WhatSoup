// Parity lock for the HTTP API providers' terminal error ladder.
//
// This test pins the EXACT user-facing `result.text` each provider emits for
// every HTTP failure class (400 / 401 / 429+retry-after / 500 / connection
// throw). It exists to guard the BEAD-020 extraction of the shared error
// branches into `api-provider-shared.ts`: the shared helper must reproduce
// these strings byte-for-byte, and — critically — must NOT collapse the 401
// divergence below:
//   - anthropic-api keeps a dedicated 401 branch  → administrator message
//   - openai-api  has NO 401 branch, so 401 falls through to the generic else
//     → `_Service error (401) - please try again._`
//
// These assertions must pass GREEN against the UNCHANGED source before any
// refactor begins.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

type HttpProvider = OpenAIApiProvider | AnthropicApiProvider;

async function initializeProvider(provider: HttpProvider, events: AgentEvent[] = []): Promise<void> {
  await provider.initialize({
    cwd: '/tmp',
    systemPrompt: 'System prompt',
    instanceName: 'test-instance',
    onEvent: (event) => events.push(event),
    onCrash: vi.fn(),
  });
}

async function sendBasicTurn(provider: HttpProvider): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await initializeProvider(provider, events);
  await provider.sendTurn({
    role: 'user',
    conversationKey: 'chat-key',
    parts: [{ kind: 'text', text: 'hello' }],
  });
  return events;
}

function latestResult(events: AgentEvent[]): Extract<AgentEvent, { type: 'result' }> {
  const result = events
    .filter((event): event is Extract<AgentEvent, { type: 'result' }> => event.type === 'result')
    .at(-1);
  if (!result) throw new Error('missing result event');
  return result;
}

const CONNECTION_ERROR = '_Connection error - please try again._';
const BAD_REQUEST = '_There was an issue with my conversation data. Please try again or send /new to start fresh._';
const RATE_LIMITED = '_Rate limited - please wait a moment and try again._';
const SERVER_UNAVAILABLE = '_Service temporarily unavailable - please try again in a moment._';
// The DIVERGENCE — pinned per provider:
const ANTHROPIC_401 = '_Authentication error - please contact the administrator._';
const OPENAI_401 = '_Service error (401) - please try again._';

describe('API provider terminal error ladder (parity lock)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalOpenAiKey: string | undefined;
  let originalAnthropicKey: string | undefined;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  });

  // ── Shared (non-divergent) branches ───────────────────────────────────────
  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ])('%s maps a 400 to the conversation-data message', async (_name, makeProvider) => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    const events = await sendBasicTurn(makeProvider());
    expect(latestResult(events)).toMatchObject({ type: 'result', text: BAD_REQUEST });
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ])('%s maps a 500 to the service-unavailable message', async (_name, makeProvider) => {
    fetchMock.mockResolvedValueOnce(new Response('upstream down', { status: 500 }));
    const events = await sendBasicTurn(makeProvider());
    expect(latestResult(events)).toMatchObject({ type: 'result', text: SERVER_UNAVAILABLE });
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ])('%s maps a connection throw to the connection-error message', async (_name, makeProvider) => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const events = await sendBasicTurn(makeProvider());
    expect(latestResult(events)).toMatchObject({ type: 'result', text: CONNECTION_ERROR });
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ])('%s retries a 429 with Retry-After then maps the second 429 to the rate-limited message', async (_name, makeProvider) => {
    // Retry-After: 0 → immediate retry on the first 429; the second 429 has
    // rateLimitRetryAttempt=true and so emits the terminal rate-limited text.
    fetchMock
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }));
    const events = await sendBasicTurn(makeProvider());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latestResult(events)).toMatchObject({ type: 'result', text: RATE_LIMITED });
  });

  // ── The 401 DIVERGENCE (must survive the refactor) ─────────────────────────
  it('anthropic-api maps a 401 to the dedicated administrator message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad key', { status: 401 }));
    const events = await sendBasicTurn(new AnthropicApiProvider());
    expect(latestResult(events)).toMatchObject({ type: 'result', text: ANTHROPIC_401 });
  });

  it('openai-api maps a 401 to the generic service-error message (no dedicated 401 branch)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad key', { status: 401 }));
    const events = await sendBasicTurn(new OpenAIApiProvider());
    expect(latestResult(events)).toMatchObject({ type: 'result', text: OPENAI_401 });
  });
});
