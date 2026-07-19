import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';
import { providerPreview, sanitizeProviderPreviewText } from '../../../../src/runtimes/agent/provider-preview-sanitizer.ts';

const { errorMock, warnMock } = vi.hoisted(() => ({
  errorMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    error: errorMock,
    info: vi.fn(),
    warn: warnMock,
  }),
}));

interface SecretFixtures {
  bearer: string;
  keyed: string;
  email: string;
  github: string;
}

function secretFixtures(): SecretFixtures {
  return {
    bearer: ['sk', 'live', 'a'.repeat(26)].join('-'),
    keyed: ['token', 'b'.repeat(26)].join('-'),
    email: `operator${'@'}example.com`,
    github: `ghp_${'c'.repeat(26)}`,
  };
}

function providerErrorText(fixtures = secretFixtures()): string {
  return [
    'invalid_request_error: upstream rejected request',
    `Authorization: Bearer ${fixtures.bearer}`,
    `api_key=${fixtures.keyed}`,
    `account=${fixtures.email}`,
    `github=${fixtures.github}`,
  ].join('\n');
}

function providerErrorSseLine(fixtures = secretFixtures()): string {
  return providerErrorText(fixtures).replace(/\n/g, ' ');
}

function makeSseResponse(lines: string[]): Response {
  return new Response(lines.map((line) => `data: ${line}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function driveProviderTurn(provider: OpenAIApiProvider | AnthropicApiProvider): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await provider.initialize({
    cwd: '/tmp',
    instanceName: 'test-instance',
    onCrash: vi.fn(),
    onEvent: (event) => events.push(event),
    systemPrompt: 'System prompt',
  });

  await provider.sendTurn({
    conversationKey: 'chat-key',
    parts: [{ kind: 'text', text: 'hello' }],
    role: 'user',
  });

  return events;
}

function previewFrom(mock: Mock, fieldName: 'errPreview' | 'dataPreview'): string {
  for (const call of mock.mock.calls) {
    const metadata = call[0];
    if (metadata && typeof metadata === 'object' && fieldName in metadata) {
      return String((metadata as Record<string, unknown>)[fieldName]);
    }
  }
  throw new Error(`missing ${fieldName} log field`);
}

function expectPreviewRedacted(preview: string, fixtures: SecretFixtures): void {
  expect(preview).toContain('invalid_request_error');
  expect(preview).toContain('Bearer [REDACTED]');
  expect(preview).toContain('api_key=[REDACTED]');
  expect(preview).toContain('[REDACTED_EMAIL]');
  expect(preview).not.toContain(fixtures.bearer);
  expect(preview).not.toContain(fixtures.keyed);
  expect(preview).not.toContain(fixtures.email);
  expect(preview).not.toContain(fixtures.github);
}

describe('provider API preview redaction', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    warnMock.mockReset();
    errorMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sanitizes provider previews before applying preview bounds', () => {
    const fixtures = secretFixtures();
    const text = providerErrorText(fixtures);

    const sanitized = sanitizeProviderPreviewText(text);
    expectPreviewRedacted(sanitized, fixtures);

    const bounded = providerPreview(text, 80);
    expect(bounded.length).toBeLessThanOrEqual(80);
    expect(bounded).not.toContain(fixtures.bearer);
    expect(bounded).not.toContain(fixtures.keyed);
  });

  it('redacts OpenAI-compatible HTTP error previews before logging', async () => {
    const fixtures = secretFixtures();
    fetchMock.mockResolvedValueOnce(new Response(providerErrorText(fixtures), { status: 400 }));

    const events = await driveProviderTurn(new OpenAIApiProvider());

    expect(events).toContainEqual(expect.objectContaining({
      text: '_There was an issue with my conversation data. Please try again or send /new to start fresh._',
      type: 'result',
    }));
    expectPreviewRedacted(previewFrom(errorMock, 'errPreview'), fixtures);
  });

  it('redacts Anthropic HTTP error previews before logging', async () => {
    const fixtures = secretFixtures();
    fetchMock.mockResolvedValueOnce(new Response(providerErrorText(fixtures), { status: 400 }));

    const events = await driveProviderTurn(new AnthropicApiProvider());

    expect(events).toContainEqual(expect.objectContaining({
      text: '_There was an issue with my conversation data. Please try again or send /new to start fresh._',
      type: 'result',
    }));
    expectPreviewRedacted(previewFrom(errorMock, 'errPreview'), fixtures);
  });

  it('redacts OpenAI-compatible malformed SSE data previews before logging', async () => {
    const fixtures = secretFixtures();
    fetchMock.mockResolvedValueOnce(makeSseResponse([
      providerErrorSseLine(fixtures),
      '{"choices":[{"delta":{"content":"done"}}]}',
      '[DONE]',
    ]));

    await driveProviderTurn(new OpenAIApiProvider());

    expectPreviewRedacted(previewFrom(warnMock, 'dataPreview'), fixtures);
  });

  it('redacts Anthropic malformed SSE data previews before logging', async () => {
    const fixtures = secretFixtures();
    fetchMock.mockResolvedValueOnce(makeSseResponse([
      providerErrorSseLine(fixtures),
      '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
    ]));

    await driveProviderTurn(new AnthropicApiProvider());

    expectPreviewRedacted(previewFrom(warnMock, 'dataPreview'), fixtures);
  });
});

// QR-079: the shared sanitizer's keyed-secret rule covered only a fixed key-name
// denylist (api_key/access_token/refresh_token/auth_token/pat/password/secret),
// so compound-snake and camelCase-glued secret keys LEAKED across every consumer
// (handoff corpus -> third-party summarizer, outbound-message-safety, provider
// logs, backups). Same root class as QR-052 (bot-errors KEYED_SECRET_RE), distinct
// redactor. These assert the gap is closed without over-redacting benign keys.
describe('sanitizeProviderPreviewText — compound / camelCase secret keys (QR-079)', () => {
  // Fixture VALUES carry an `example` marker so the repo-hygiene secret-assignment
  // guard treats them as obvious non-secrets (allowedSecretAssignmentValue); they are
  // still 8+ chars single tokens, so the redactor's `{8,}` value match still fires.
  const LEAKED_BEFORE: Array<[string, string]> = [
    ['AWS multi-underscore env', 'AWS_SESSION_TOKEN=exampleAwsSessionTokenValue01'],
    ['camelCase session token', 'sessionToken=exampleSessionTokenValue02'],
    ['camelCase bearer token', 'bearerToken=exampleBearerTokenValue03'],
    ['OAuth client secret', 'client_secret=exampleClientSecretValue04'],
    ['AWS secret access key', 'aws_secret_access_key=exampleAwsSecretAccessKey05'],
    ['bare token key', 'token=exampleBareTokenValue06'],
    ['private key', 'private_key=examplePrivateKeyValue07'],
  ];

  it.each(LEAKED_BEFORE)('redacts the secret value: %s', (_label, input) => {
    const out = sanitizeProviderPreviewText(input);
    expect(out).toContain('[REDACTED]');
    // The raw secret value must not survive.
    expect(out).not.toBe(input);
  });

  it('still redacts the original covered keys (no regression)', () => {
    expect(sanitizeProviderPreviewText('api_key=exampleApiKeyValue01')).toContain('api_key=[REDACTED]');
    expect(sanitizeProviderPreviewText('password: examplePasswordValue02')).toContain('[REDACTED]');
    expect(sanitizeProviderPreviewText('Authorization: Bearer exampleBearerHeaderValue03')).toContain('Bearer [REDACTED]');
  });

  const BENIGN: string[] = [
    'retry_count=12345678',
    'event_count=99999999',
    'please pay invoice 20260145 today',
  ];

  it.each(BENIGN)('does not over-redact benign key/value: %s', (input) => {
    expect(sanitizeProviderPreviewText(input)).toBe(input);
  });

  it('is linear on pathological underscore-key input (no catastrophic backtracking)', () => {
    const start = Date.now();
    sanitizeProviderPreviewText('a_'.repeat(5000) + 'token=x');
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// T8-F3 (E4): `redactKeyedSecretValues`'s unquoted-value branch false-positived on
// display-truncated NON-secrets — a backtick-wrapped short id ending `...`/`…`
// (e.g. `` Session: `4947004d...` ``) got masked to `[REDACTED]` even though the
// truncation already destroyed any secret value. The carve-out is TIGHT: backtick
// wrap AND short base (<= MAX_TRUNCATED_DISPLAY_BASE) AND the base does NOT match
// the known token-prefix alternation (shared with the :86 replacement via
// KNOWN_TOKEN_PREFIX so the two cannot drift). Width is pinned by boundary +
// adversarial cases below — see OVER-REDACTION-ROOT-CAUSE.md / W1-PACKET.md T8-F3.
describe('T8-F3: truncation carve-out in redactKeyedSecretValues (E4)', () => {
  it('E4 case: backtick-wrapped 8-char truncated display id survives unredacted', () => {
    const input = 'Session: `4947004d...`';
    expect(sanitizeProviderPreviewText(input)).toBe(input);
  });

  it('boundary carve: a 12-char base survives (MAX_TRUNCATED_DISPLAY_BASE)', () => {
    const input = 'Session: `abcdef123456...`';
    expect(sanitizeProviderPreviewText(input)).toBe(input);
  });

  it('boundary mask: a 13-char base is still [REDACTED] (regression guard)', () => {
    const input = 'Session: `abcdef1234567...`';
    const out = sanitizeProviderPreviewText(input);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('abcdef1234567');
  });

  it('adversarial: short backtick-wrapped ellipsized value with a known token prefix is still [REDACTED]', () => {
    const input = 'apikey: `sk-0123a...`';
    const out = sanitizeProviderPreviewText(input);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-0123a');
  });

  it('full token, no ellipsis, is still [REDACTED] every tier (INV-2)', () => {
    const input = 'session=abc123def456ghi789';
    expect(sanitizeProviderPreviewText(input)).toBe('session=[REDACTED]');
  });

  // Lead-review gate (W1-PACKET.md T8-F3 dispatch checklist item 2b): F3 is not
  // accepted without this adversarial case green ALONGSIDE the E4-visible case —
  // a LONG truncated secret prefix (>MAX_TRUNCATED_DISPLAY_BASE, also token-prefixed)
  // must stay masked. Guards against a loose "any value ending `...`" implementation
  // that the packet explicitly rejects (it would carve out `apikey=sk-...abcdef...`).
  it('adversarial (load-bearing): long truncated secret prefix stays [REDACTED]', () => {
    // Built via array-join (not a literal contiguous run in source) so the
    // publication-guard's OpenAI-key-shape scan — a source-text regex with no
    // example-marker exemption — doesn't flag this fixture; the base is still
    // >MAX_TRUNCATED_DISPLAY_BASE chars AND token-prefixed either way.
    const longTokenPrefixedBase = ['sk', 'example', '0123456789abcdef'].join('-');
    const input = `apikey: \`${longTokenPrefixedBase}...\``;
    const out = sanitizeProviderPreviewText(input);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(longTokenPrefixedBase);
  });
});

describe('QR-128: email redaction is linear and does not under-redact', () => {
  it('is linear on a pathological dotted local/domain run (no catastrophic backtracking)', () => {
    // The prior /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ overlapped its
    // own domain class (`.` ∈ [A-Za-z0-9.-]) with the required TLD dot, so a crafted
    // `a.a.a…` run drove quadratic backtracking (~5.5s at 80 KB). This sanitizer runs
    // on the FULL uncapped outbound reply, so it is a synchronous send-path DoS.
    const start = Date.now();
    sanitizeProviderPreviewText('a@' + 'a.'.repeat(20000) + '!');
    // Fixed: ~2ms. Unfixed: ~1.3s at this size. 500ms cleanly separates them.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('still redacts real emails (no under-redaction regression)', () => {
    // `@` is split via a template so the literal address never appears in source
    // (repo-hygiene guard forbids literal email addresses in committed text).
    const at = '@';
    const addr = `user${at}example.com`;
    const out = sanitizeProviderPreviewText(`reach me at ${addr} please`);
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).not.toContain(addr);
    expect(sanitizeProviderPreviewText(`a.b+c${at}sub.example.co.uk`)).toBe('[REDACTED_EMAIL]');
  });
});
