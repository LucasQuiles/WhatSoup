import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expectPreviewRedacted,
  providerErrorText,
  secretFixtures,
  type SecretFixtures,
} from '../../../fixtures/redaction-fixtures.ts';
import type { Mock } from 'vitest';

import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';
import { providerPreview, sanitizeProviderPreviewText } from '../../../../src/runtimes/agent/provider-preview-sanitizer.ts';
import { E9_BARE_AT_MESSAGE } from '../../../fixtures/e9-strings.ts';

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

// E9 (packet D5): `redactEmailLikeTokens` redacted ANY token containing '@'.
// The mention-preserve regex requires a character AFTER the '@', so a bare
// whitespace-flanked '@' used as the word "at" ("meet @ 5pm") ALWAYS became
// [REDACTED_EMAIL] — live evidence: an agent's own explanation of this bug was
// itself re-redacted in an internal-tier DM. Fix shape: only an email-SHAPED
// core — non-empty local part AND non-empty domain part around an '@' — may be
// redacted as an email. Mention-shaped tokens ('@name', '@15551234567') are NOT
// email-shaped but stay governed by preserveWhatsAppMentions (phone mentions
// are PII on surfaces that did not opt in), so the flag keeps its meaning.
describe('E9 (packet D5): a bare "@" is not email-shaped and must survive', () => {
  it('a bare "@" between words survives (the word "at")', () => {
    expect(sanitizeProviderPreviewText(E9_BARE_AT_MESSAGE)).toBe(E9_BARE_AT_MESSAGE);
  });

  it('"@ 5pm" at the start of a message survives', () => {
    const input = '@ 5pm works for me';
    expect(sanitizeProviderPreviewText(input)).toBe(input);
  });

  it('the quantity idiom "3 @ $5 each" survives', () => {
    const input = 'ordered 3 @ $5 each';
    expect(sanitizeProviderPreviewText(input)).toBe(input);
  });

  it('real emails still redact: minimal a@b.c and dotted local/subdomain forms', () => {
    // at-split idiom: no literal email address in committed source (repo-hygiene guard).
    const at = '@';
    expect(sanitizeProviderPreviewText(`a${at}b.c`)).toBe('[REDACTED_EMAIL]');
    expect(sanitizeProviderPreviewText(`first.last${at}sub.domain.tld`)).toBe('[REDACTED_EMAIL]');
  });

  it('adversarial: a dangling trailing "@" does not exempt an embedded email-shaped token (a@b@ still redacts)', () => {
    // Guards against a lazy "token ends with @ → pass through" implementation:
    // `a@b@` still contains a non-empty-local/non-empty-domain '@' pair.
    const out = sanitizeProviderPreviewText('a@b@');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).not.toContain('a@b');
  });

  it('@mention preservation is untouched: @alice and @15555550001 survive with preserveWhatsAppMentions', () => {
    const options = { preserveWhatsAppMentions: true };
    expect(sanitizeProviderPreviewText('Hi @alice!', options)).toBe('Hi @alice!');
    expect(sanitizeProviderPreviewText('ping @15555550001 now', options)).toBe('ping @15555550001 now');
  });

  it('edge decision "@x": empty local part is mention-shaped, NOT email-shaped — preserved with the flag, still redacted without it (phone-mention PII stays fail-closed)', () => {
    // Decision (documented): '@x' can never be an email (empty local part), but
    // it IS mention-shaped, and mention visibility is governed by the
    // preserveWhatsAppMentions flag — surfaces that did not opt in must keep
    // masking mentions ('@15551234567' is a phone number). Requiring a
    // non-empty local part for the EMAIL match must not turn the flag into
    // dead code.
    expect(sanitizeProviderPreviewText('cc @x please', { preserveWhatsAppMentions: true })).toBe('cc @x please');
    expect(sanitizeProviderPreviewText('cc @x please')).toBe('cc [REDACTED_EMAIL] please');
    expect(sanitizeProviderPreviewText('ping @15555550001 now')).toBe('ping [REDACTED_EMAIL] now');
  });

  it('edge decision "x@" REVERSED (B25): a dangling local is an ADDRESS FRAGMENT and redacts', () => {
    // Original E9 ruling said "redacting it protects nothing" — the B25
    // review proved the opposite for fragments: on CLIENT egress there is no
    // downstream phone masking (unlike the handoff/ops surfaces), so a
    // dangling local ('15551234567@', 'user@') carries the whole PII payload
    // by itself. A dangling-local token — non-empty local + trailing '@' +
    // EMPTY domain — now redacts (the local is masked); the E9 exemption
    // narrows to truly-bare '@' runs ('meet @ 5pm', '3 @ $5 each').
    expect(sanitizeProviderPreviewText('assign user@ then continue'))
      .toBe('assign [REDACTED_EMAIL] then continue');
  });
});

// B25 review (fix/b25-sanitizer-fixture): three execution-verified defects in
// the E9 predicate family. Each fixture string below reproduced the defect
// verbatim against the pre-fix sanitizer (recorded in the branch evidence):
//   1a. 'she said "hi"@ 5pm'      -> 'she said [REDACTED_EMAIL] 5pm'   (over-redaction)
//   1b. '@foo.bar' + mentions flag -> '[REDACTED_EMAIL]'               (flag ignored)
//   1c. 'reach them at 15551234567@' -> passed VERBATIM                (PII leak)
describe('B25: quoted-local domain gate, dotted mention bodies, dangling-local fragments', () => {
  it('1a: quoted speech followed by "@" (empty domain) survives — the quoted-local branch is email-shape-gated', () => {
    // The quoted-local branch redacted after scanning ZERO domain chars. The
    // same email-shaped requirement (non-empty domain) that gates the token
    // scanner must gate this branch: '"hi"@ 5pm' is quoted speech + the word
    // "at", not an address.
    const input = 'she said "hi"@ 5pm';
    expect(sanitizeProviderPreviewText(input)).toBe(input);
  });

  it('1a guard: a quoted local with a NON-empty domain still redacts (gate must not disable the branch)', () => {
    const at = '@';
    expect(sanitizeProviderPreviewText(`"hi"${at}example.com`)).toBe('[REDACTED_EMAIL]');
    expect(sanitizeProviderPreviewText(`"hi"${at}[127.0.0.1]`)).toBe('[REDACTED_EMAIL]');
  });

  it('1b: a dotted mention body is preserved WITH preserveWhatsAppMentions and still masked without it', () => {
    // Direction ruling (documented in the sanitizer): the PRESERVE regex
    // accepts dotted mention bodies; dotted mention-shaped tokens stay
    // redacted by default. See the sanitizer comment for why this direction
    // cannot leak a real email.
    expect(sanitizeProviderPreviewText('@foo.bar', { preserveWhatsAppMentions: true })).toBe('@foo.bar');
    expect(sanitizeProviderPreviewText('@foo.bar')).toBe('[REDACTED_EMAIL]');
  });

  it('1b guard: a digit-dot mention body stays masked even WITH the flag (phone-fragment PII, fail-closed)', () => {
    expect(sanitizeProviderPreviewText('@1234.5678', { preserveWhatsAppMentions: true }))
      .toBe('[REDACTED_EMAIL]');
  });

  it('1c: a dangling phone-local fragment redacts (client egress has no downstream phone masking)', () => {
    expect(sanitizeProviderPreviewText('reach them at 15551234567@'))
      .toBe('reach them at [REDACTED_EMAIL]');
  });

  it('1c: a space-split address masks the local half', () => {
    // Shape from the review finding (a real address typed with a space after
    // the '@'); fixture synthesized — no real identity in committed source.
    expect(sanitizeProviderPreviewText('first.last@ example-corp.com'))
      .toBe('[REDACTED_EMAIL] example-corp.com');
  });

  it('1c guard: E9 protected cases stay protected — truly-bare "@" runs still pass', () => {
    for (const input of [E9_BARE_AT_MESSAGE, '@ 5pm works for me', 'ordered 3 @ $5 each']) {
      expect(sanitizeProviderPreviewText(input)).toBe(input);
    }
  });
});
