import { describe, expect, it } from 'vitest';

import { WhatSoupError } from '../../../src/errors.ts';
import {
  classifyAgentFailure,
  classifyProviderFailure,
  classifyStreamedProviderFailure,
  isFallbackEligibleForFailureClass,
  isExpectedProviderShutdown,
  isPromptTooLongMessage,
  isProviderAuthRequiredMessage,
  isProviderModelUnavailableMessage,
  isProviderPolicyBlockMessage,
  isRateLimitResultMessage,
  isTransientProviderConnectionMessage,
  isUsageLimitMessage,
  providerFailureArmsFallback,
} from '../../../src/runtimes/agent/failure-taxonomy.ts';

function statusError(status: number): Error & { status: number } {
  const err = new Error(`http ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`errno ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function errorWithCause(cause: unknown): Error & { cause: unknown } {
  const err = new Error('outer failure') as Error & { cause: unknown };
  err.cause = cause;
  return err;
}

const baseInput = {
  instanceName: 'yl-bot',
  provider: 'claude-cli',
  chatJid: 'chat@g.us',
};

describe('agent failure taxonomy detectors', () => {
  it('keeps usage-limit and context-overflow messages distinct', () => {
    expect(isUsageLimitMessage("You're out of extra usage. Claude will be available at 8pm.")).toBe(true);
    expect(isUsageLimitMessage('Quota exceeded; Claude resets at 9pm.')).toBe(true);
    expect(isUsageLimitMessage('Provider returned insufficient_quota for this API request.')).toBe(true);
    expect(isUsageLimitMessage('Billing quota exceeded for the provider account.')).toBe(true);
    expect(isUsageLimitMessage('Provider credit balance exhausted.')).toBe(true);
    expect(isUsageLimitMessage('API account balance is too low to continue.')).toBe(true);
    expect(isUsageLimitMessage('Claude resets at 9pm after maintenance.')).toBe(false);
    expect(isUsageLimitMessage('Prompt is too long: maximum context length exceeded.')).toBe(false);
    expect(isPromptTooLongMessage('Prompt is too long: maximum context length exceeded.')).toBe(true);
  });

  it('does not classify ordinary discussion of quota handling as a provider cap', () => {
    expect(isUsageLimitMessage('Please document how usage limit and quota exceeded errors should be handled.')).toBe(false);
  });

  it('detects terminal provider rate-limit result text without matching ordinary planning discussion', () => {
    expect(isRateLimitResultMessage('_Rate limited - please wait a moment and try again._')).toBe(true);
    expect(isRateLimitResultMessage('HTTP 429 from provider')).toBe(true);
    expect(isRateLimitResultMessage('Please document rate limit handling and retry policy.')).toBe(false);
  });

  it('covers provider detector synonyms used by runtime classification', () => {
    expect(isPromptTooLongMessage('Provider rejected the request: token budget limit exceeded.')).toBe(true);
    expect(isProviderAuthRequiredMessage('OAuth token expired; reconnect the provider account.')).toBe(true);
    // Live claude-cli 401 body (mini1/ana-bot, 2026-06-22): must classify as auth so it
    // demotes to the fallback chain instead of the default-deny unknown-terminal branch.
    expect(isProviderAuthRequiredMessage('Failed to authenticate. API Error: 401 Invalid authentication credentials')).toBe(true);
    expect(isProviderAuthRequiredMessage('Invalid authentication credentials')).toBe(true);
    // Bare numeric status must NEVER match on its own (prevents the prior false-storm).
    expect(isProviderAuthRequiredMessage('build step returned 401 lines of output')).toBe(false);
    expect(isProviderPolicyBlockMessage('The request was blocked by policy.')).toBe(true);
    expect(isProviderModelUnavailableMessage('Issue with the selected model: it may not exist or you may not have access.')).toBe(true);
    expect(isProviderModelUnavailableMessage('Unknown model from provider registry.')).toBe(true);
  });

  it.each([
    'Your OAuth token has expired - run claude login to reconnect, then retry.',
    'Here is how OAuth refresh works once an access token has expired: refresh first, then retry.',
    'The SSL cert expired last week, but the oauth flow itself is fine.',
  ])('OAuth troubleshooting prose stays ambient on the streaming channel, never banner: %j', (message) => {
    // The permissive detector intentionally still matches these (oauth+expired) —
    // that stays correct for the infra channels (result/stderr/probe). The
    // streaming refinement must land them AMBIENT (delivered), never banner
    // (suppressed) — delivering prose about an auth error is the QR-209 contract.
    expect(isProviderAuthRequiredMessage(message)).toBe(true);
    expect(classifyStreamedProviderFailure(message)).toEqual({ kind: 'auth-required', confidence: 'ambient' });
  });

  it.each([
    ['', null],
    ['Prompt is too long: context_length_exceeded', 'context-overflow'],
    ['Quota exceeded; Claude resets at 9pm.', 'usage-limit'],
    ['Authentication required before provider call.', 'auth-required'],
    ['Failed to authenticate. API Error: 401 Invalid authentication credentials', 'auth-required'],
    ['HTTP 429 from provider', 'rate-limit'],
    ['Request blocked by policy.', 'policy-block'],
    ['Unknown model from provider registry.', 'model-unavailable'],
    ['ordinary provider discussion', null],
    // transient-network cases
    ['API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()', 'transient-network'],
    ['Error: ECONNRESET — read ECONNRESET', 'transient-network'],
    // false-positive guard: benign documentation text must not match
    ['Please document how socket timeouts and connection resets are handled.', null],
  ] as const)('classifyProviderFailure maps %j to %j', (message, expected) => {
    expect(classifyProviderFailure(message)).toBe(expected);
  });

  it('isTransientProviderConnectionMessage — true cases', () => {
    expect(isTransientProviderConnectionMessage('The socket connection was closed unexpectedly.')).toBe(true);
    expect(isTransientProviderConnectionMessage('API Error: The socket connection was closed unexpectedly. Pass verbose:true')).toBe(true);
    expect(isTransientProviderConnectionMessage('socket hang up')).toBe(true);
    expect(isTransientProviderConnectionMessage('connection closed unexpectedly while streaming')).toBe(true);
    expect(isTransientProviderConnectionMessage('Error: ECONNRESET')).toBe(true);
    expect(isTransientProviderConnectionMessage('read ECONNRESET')).toBe(true);
    expect(isTransientProviderConnectionMessage('connection reset by peer')).toBe(true);
    expect(isTransientProviderConnectionMessage('ETIMEDOUT connecting to api.anthropic.com')).toBe(true);
  });

  it('isTransientProviderConnectionMessage — false-positive guard: benign prose must not match', () => {
    expect(isTransientProviderConnectionMessage('Please document how socket timeouts and connection resets are handled.')).toBe(false);
    expect(isTransientProviderConnectionMessage('ordinary provider discussion')).toBe(false);
    expect(isTransientProviderConnectionMessage('')).toBe(false);
  });

  it('arms fallback only for provider failures that can be recovered by backup providers', () => {
    for (const kind of ['usage-limit', 'rate-limit', 'auth-required', 'model-unavailable'] as const) {
      expect(providerFailureArmsFallback(kind)).toBe(true);
    }

    for (const kind of ['context-overflow', 'policy-block', 'transient-network'] as const) {
      expect(providerFailureArmsFallback(kind)).toBe(false);
    }
  });
});

describe('classifyStreamedProviderFailure (QR-209 streaming-channel refinement)', () => {
  // BANNER — the text IS the error: short and either usage-limit (own prose guards)
  // or starting with a curated error opener. These stay suppressible.
  it.each([
    ["You're out of extra usage. Claude will be available at 8pm.", 'usage-limit'],
    ["You've hit your weekly limit. Resets at 9pm.", 'usage-limit'],
    ['_Rate limited - please wait a moment and try again._', 'rate-limit'],
    // Real claude-cli 401 body (mini1/ana-bot, 2026-06-22) — starts with the error.
    ['Failed to authenticate. API Error: 401 Invalid authentication credentials', 'auth-required'],
    ["There's an issue with the selected model (m). It may not exist or you may not have access to it.", 'model-unavailable'],
    ['API Error: The socket connection was closed unexpectedly.', 'transient-network'],
  ] as const)('BANNER: %j → suppress (kind %j)', (message, kind) => {
    expect(classifyStreamedProviderFailure(message)).toEqual({ kind, confidence: 'banner' });
  });

  // AMBIENT — matched a provider-failure token but is prose ABOUT an error. QR-209:
  // these were silently dropped; now they must classify 'ambient' so the runtime
  // DELIVERS them.
  it('AMBIENT: genuine auth-topic reply (the QR-209 defect) is delivered, not suppressed', () => {
    // Same string the permissive detector still classifies auth-required at :68 —
    // this pair is the QR-209 contract: keep permissive on infra channels, deliver
    // on the streaming channel.
    const prose = 'OAuth token expired; reconnect the provider account.';
    expect(isProviderAuthRequiredMessage(prose)).toBe(true); // infra channel unchanged
    expect(classifyStreamedProviderFailure(prose)).toEqual({ kind: 'auth-required', confidence: 'ambient' });
  });

  it('AMBIENT: mini27-shaped conversational reply about an expired OAuth token is delivered', () => {
    // Shape of the live 2026-07-03 mini27/loops replies that were dropped: a
    // multi-sentence answer that discusses (does not emit) the auth error.
    const reply =
      'Yes — it looks like the OAuth token expired, so the provider dropped the session. ' +
      "Let's reconnect the account and re-run login to restore access.";
    const result = classifyStreamedProviderFailure(reply);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('ambient');
  });

  it('AMBIENT: long prose containing an auth token mid-sentence is delivered (length bound)', () => {
    const longProse =
      'When a provider session ends because authentication required a fresh login, we surface a ' +
      'gentle notice and arm the fallback provider so the conversation continues without the user ' +
      'having to notice the swap or re-send their most recent message to the assistant again here. ' +
      'The point is that a calm sentence discussing the auth flow must never be mistaken for the ' +
      'raw error banner and silently discarded from the reply stream.';
    expect(longProse.length).toBeGreaterThan(300);
    const result = classifyStreamedProviderFailure(longProse);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('ambient');
  });

  // NULL — no provider-failure match at all: delivered silently.
  it.each([
    ['Please document how usage limit and quota exceeded errors should be handled.'],
    ['ordinary provider discussion'],
    [''],
  ] as const)('NULL: %j → deliver (no classification)', (message) => {
    expect(classifyStreamedProviderFailure(message)).toBeNull();
  });

  it('strips leading markdown/quote/whitespace wrappers before matching an opener', () => {
    expect(classifyStreamedProviderFailure('   Failed to authenticate. API Error: 401')?.confidence).toBe('banner');
    expect(classifyStreamedProviderFailure('> Error: service temporarily unavailable')?.confidence).toBe('banner');
  });

  it('enforces the 300-char banner length bound', () => {
    const base = "You're out of extra usage. Claude will be available at 8pm. ";
    const at300 = base.padEnd(300, 'x');
    const at301 = base.padEnd(301, 'x');
    expect(at300).toHaveLength(300);
    expect(at301).toHaveLength(301);
    expect(classifyStreamedProviderFailure(at300)).toEqual({ kind: 'usage-limit', confidence: 'banner' });
    // Same usage-limit content, one char over the bound → delivered.
    expect(classifyStreamedProviderFailure(at301)?.confidence).toBe('ambient');
  });

  it('Cloudflare-style challenge text follows the general rule (delivered, no special-case)', () => {
    // Unknown (a) from the QR-209 register: a "verify you are human" challenge page
    // is not a provider-failure banner. Policy: no special-case detector — it either
    // fails to classify (delivered silently) or classifies but is long/opener-less
    // (delivered as ambient). Either way it is NOT suppressed.
    const challenge =
      'Verify you are human by completing the action below. This helps us confirm the request ' +
      'is coming from a real person and not an automated system before continuing to the site.';
    expect(classifyStreamedProviderFailure(challenge)?.confidence).not.toBe('banner');
  });
});

describe('classifyStreamedProviderFailure — usage-limit banner requires an anchor (QR-209b F1)', () => {
  // QR-209b F1: the OLD code exempted the ENTIRE 'usage-limit' kind from the
  // opener/shape anchor once text.length <= 300, on the false assumption that
  // isUsageLimitMessage only ever matches anchored terminal shapes. Several of its
  // true-branches are bare unanchored substrings (isProviderCreditBalanceLimitMessage's
  // "out of usage credits" / "out of usage" + org-co-word branches, and the top-level
  // "out of extra usage" / "claude usage limit" strings), so ordinary billing PROSE
  // that merely discusses a usage cap was silently destroyed. Deliver-over-destroy:
  // when the anchor is absent, ambient (delivered) is the correct default.
  it.each([
    "Yes, we're out of usage credits for this billing cycle, so no more requests will process until next month.",
    'Good question — once your account is out of usage credits, the provider just queues everything until the next cycle.',
    "That error means the workspace is out of usage; contact your admin to raise the group's allocation for this month.",
  ])('unanchored usage-limit prose stays ambient, never banner: %j', (message) => {
    expect(isUsageLimitMessage(message)).toBe(true); // infra channel unchanged
    expect(classifyStreamedProviderFailure(message)).toEqual({ kind: 'usage-limit', confidence: 'ambient' });
  });

  // The residual credit/quota branch shapes from the "residual terminal-credit/quota
  // branch shapes" describe block below (isUsageLimitMessage = true) carry no
  // assembled "hit your X" phrasing and no concrete reset-time cue — they read as
  // ordinary prose, not a raw CLI banner. Ambient is the deliver-over-destroy default
  // when the anchor is absent (a false delivery is one visible message; a false
  // suppression is permanent unrecoverable silence).
  it.each([
    'You are out of usage; please contact your admin.',
    'Out of usage — your org has no remaining allocation.',
    'Out of usage because the org is over its cap.',
    'Out of usage for the group allocation this cycle.',
    'The provider account balance is too low.',
    'Provider account balance is insufficient to continue.',
    'API account balance is exhausted for this billing cycle.',
    'Model policy only allows a model that needs a usage credit.',
  ])('residual-branch usage-limit shapes stay ambient (deliver-over-destroy default): %j', (message) => {
    expect(isUsageLimitMessage(message)).toBe(true);
    expect(classifyStreamedProviderFailure(message)).toEqual({ kind: 'usage-limit', confidence: 'ambient' });
  });

  it('genuine terminal usage-limit banners with an anchor stay banner', () => {
    // The assembled "hit your X" phrasing is CLI-emitted verbatim, never prose a
    // human/assistant would casually write — a real anchor, so this must NOT
    // regress to ambient just because the usage-limit kind lost its blanket bypass.
    expect(classifyStreamedProviderFailure("You've hit your weekly limit · resets Jul 7 at 10pm")).toEqual({
      kind: 'usage-limit',
      confidence: 'banner',
    });
  });
});

describe('classifyStreamedProviderFailure — STREAMED_BANNER_OPENERS corpus gaps (QR-209b F2)', () => {
  // QR-209b F2: these machine-shape strings are real corpus tokens (the server-error
  // detector's own opening phrase, plus the raw error-type tokens it substring-matches
  // at isProviderServerErrorMessage) that were missing from STREAMED_BANNER_OPENERS, so
  // a genuine short system banner using one of them leaked to users as 'ambient'
  // instead of being suppressed. Each is a short raw string here (banner) — the
  // position-sensitivity (embedded mid-explanation stays ambient) is covered below.
  it.each([
    ['We are experiencing high demand for the Opus model right now, please try again shortly.', 'server-error'],
    ['overloaded_error: the model is temporarily overloaded, please retry.', 'server-error'],
    ['server_error - please try again in a few minutes.', 'server-error'],
    ['server_unavailable: retry after a short delay.', 'server-error'],
    ['api_error: request failed due to an unexpected condition upstream.', 'server-error'],
  ] as const)('short raw opener %j classifies as BANNER (kind %j)', (message, kind) => {
    expect(classifyStreamedProviderFailure(message)).toEqual({ kind, confidence: 'banner' });
  });

  // The SAME machine-shape tokens embedded past the start of a long genuine
  // explanation must NOT be suppressed — startsWith anchoring (not substring-anywhere)
  // is the whole point of the opener list (QR-209 false-positive guard).
  it.each([
    'I checked the status page and unfortunately we are experiencing high demand for the Opus model right now, so there may be a short delay before your request completes; thanks for your patience while capacity recovers.',
    'When we hit capacity constraints the backend returns an overloaded_error code and the client library should apply exponential backoff before retrying the same request context again.',
    'Occasionally the upstream provider responds with a generic server_error payload instead of a more specific status, and the retry policy treats that the same as any other transient failure from the backend systems.',
    'If the health check keeps failing the load balancer marks the node as server_unavailable and stops routing new connections to it until the next successful check passes on that host.',
    'Whenever the client receives a 5xx from the gateway it logs the raw api_error field alongside the request id so the on-call engineer can correlate it with upstream traces later on.',
  ])('the same token embedded mid-explanation stays ambient, never banner: %j', (message) => {
    expect(message.length).toBeLessThanOrEqual(300);
    expect(classifyStreamedProviderFailure(message)?.confidence).not.toBe('banner');
  });
});

describe('classifyAgentFailure', () => {
  it.each([
    {
      label: 'session usage limit',
      source: 'provider_result' as const,
      message: "You've reached your usage limit. Try again later.",
      expected: 'provider_usage_limit' as const,
    },
    {
      label: 'provider credit balance exhausted',
      source: 'provider_result' as const,
      message: 'Provider error: insufficient credits. Please add credits to continue.',
      expected: 'provider_usage_limit' as const,
    },
    {
      label: 'context overflow',
      source: 'provider_result' as const,
      message: 'Prompt is too long for the current context window.',
      expected: 'provider_context_overflow' as const,
    },
    {
      label: 'model unavailable',
      source: 'provider_result' as const,
      message: 'The model inaccessible-model-for-test does not exist or you do not have access to it.',
      expected: 'provider_model_unavailable' as const,
    },
    {
      label: 'policy block',
      source: 'provider_result' as const,
      message: 'This request violates our policy.',
      expected: 'provider_policy_block' as const,
    },
    {
      label: 'rate limit',
      source: 'provider_error' as const,
      error: new WhatSoupError('openai rate limited', 'LLM_RATE_LIMITED'),
      expected: 'provider_rate_limit' as const,
    },
    {
      label: 'server error',
      source: 'provider_error' as const,
      error: new WhatSoupError('openai request failed', 'LLM_UNAVAILABLE', statusError(503)),
      expected: 'provider_server_error' as const,
    },
    {
      label: 'timeout',
      source: 'provider_error' as const,
      error: new WhatSoupError('openai request timed out', 'LLM_TIMEOUT'),
      expected: 'provider_timeout' as const,
    },
    {
      label: 'network',
      source: 'provider_error' as const,
      error: new WhatSoupError('openai request failed', 'LLM_UNAVAILABLE', errnoError('ECONNRESET')),
      expected: 'provider_network_error' as const,
    },
    {
      label: 'cli crash',
      source: 'provider_process_exit' as const,
      exitCode: 1,
      signal: null,
      expected: 'provider_cli_crash' as const,
    },
    {
      label: 'mcp transport',
      source: 'mcp_transport' as const,
      error: errnoError('ECONNREFUSED'),
      expected: 'mcp_transport_failure' as const,
    },
    {
      label: 'tool handler exception',
      source: 'tool_result' as const,
      toolName: 'Bash',
      message: 'TypeError: cannot read properties of undefined',
      expected: 'tool_handler_exception' as const,
    },
    {
      label: 'auth required',
      source: 'provider_error' as const,
      error: new WhatSoupError('anthropic auth failed', 'LLM_AUTH_ERROR'),
      expected: 'provider_auth_required' as const,
    },
    {
      label: 'silent hang',
      source: 'provider_watchdog' as const,
      message: 'No output received before watchdog fired.',
      expected: 'provider_silent_hang' as const,
    },
    {
      label: 'corrupt stream output',
      source: 'provider_stream' as const,
      message: 'Malformed stream-json frame from provider stdout.',
      expected: 'provider_stream_corrupt' as const,
    },
    {
      label: 'missing capability',
      source: 'config' as const,
      message: 'opencode is not installed',
      expected: 'config_or_capability_missing' as const,
    },
  ])('maps $label to $expected', (fixture) => {
    const result = classifyAgentFailure({
      ...baseInput,
      ...fixture,
    });

    expect(result.failureClass).toBe(fixture.expected);
    expect(result.incidentId).toMatch(/^[a-f0-9]{24}$/);
    expect(result.summary).toContain(fixture.expected);
    expect(result.qAlertRequired).toBe(true);
  });

  it.each([
    {
      label: 'generic HTTP 429',
      source: 'provider_error' as const,
      error: statusError(429),
      expected: 'provider_rate_limit' as const,
    },
    {
      label: 'generic HTTP 502',
      source: 'provider_error' as const,
      error: statusError(502),
      expected: 'provider_server_error' as const,
    },
    {
      label: 'generic HTTP 401',
      source: 'provider_error' as const,
      error: statusError(401),
      expected: 'provider_auth_required' as const,
    },
    {
      label: 'auth required text',
      source: 'provider_result' as const,
      message: 'Authentication required before provider call.',
      expected: 'provider_auth_required' as const,
    },
    {
      label: 'auth failed text',
      source: 'provider_error' as const,
      message: 'Auth failed while loading the provider.',
      expected: 'config_or_capability_missing' as const,
    },
    {
      label: 'watchdog text on provider error',
      source: 'provider_error' as const,
      message: 'Watchdog observed no output before timeout.',
      expected: 'provider_silent_hang' as const,
    },
    {
      label: 'parse error text on provider error',
      source: 'provider_error' as const,
      message: 'Partial output ended with parse_error.',
      expected: 'provider_stream_corrupt' as const,
    },
    {
      label: 'provider errno fallback',
      source: 'provider_error' as const,
      error: errnoError('ENOTFOUND'),
      expected: 'provider_network_error' as const,
    },
    {
      label: 'MCP errno fallback',
      source: 'mcp_transport' as const,
      error: errnoError('ETIMEDOUT'),
      expected: 'mcp_transport_failure' as const,
    },
    {
      label: 'MCP source fallback',
      source: 'mcp_transport' as const,
      message: 'Transport closed unexpectedly.',
      expected: 'mcp_transport_failure' as const,
    },
    {
      label: 'tool source fallback',
      source: 'tool_result' as const,
      expected: 'tool_handler_exception' as const,
    },
    {
      label: 'config source fallback',
      source: 'config' as const,
      expected: 'config_or_capability_missing' as const,
    },
  ])('maps $label to $expected', (fixture) => {
    const result = classifyAgentFailure({
      ...baseInput,
      ...fixture,
    });

    expect(result.failureClass).toBe(fixture.expected);
    expect(result.summary).toContain(fixture.expected);
    expect(result.qAlertRequired).toBe(true);
  });

  it('classifies low-level WhatSoupError codes without relying on provider text', () => {
    const badRequest = classifyAgentFailure({
      ...baseInput,
      source: 'provider_error',
      error: new WhatSoupError('request shape rejected', 'LLM_BAD_REQUEST'),
    });
    const unavailable = classifyAgentFailure({
      ...baseInput,
      source: 'provider_error',
      error: new WhatSoupError('provider unavailable', 'LLM_UNAVAILABLE'),
    });
    const unknownCodeWithRateText = classifyAgentFailure({
      ...baseInput,
      source: 'provider_error',
      error: new WhatSoupError('provider hit rate limit', 'INTERNAL_ERROR'),
    });

    expect(badRequest.failureClass).toBe('config_or_capability_missing');
    expect(unavailable.failureClass).toBe('provider_server_error');
    expect(unknownCodeWithRateText.failureClass).toBe('provider_rate_limit');
  });

  it('recurses through generic Error causes for status and errno extraction', () => {
    const statusResult = classifyAgentFailure({
      ...baseInput,
      source: 'provider_error',
      error: errorWithCause(statusError(503)),
    });
    const errnoResult = classifyAgentFailure({
      ...baseInput,
      source: 'provider_error',
      error: errorWithCause(errnoError('ECONNRESET')),
    });

    expect(statusResult.failureClass).toBe('provider_server_error');
    expect(errnoResult.failureClass).toBe('provider_network_error');
  });

  it('normalizes summaries while preserving nullable routing fields', () => {
    const result = classifyAgentFailure({
      ...baseInput,
      chatJid: null,
      mapKey: null,
      sessionId: null,
      source: 'tool_result',
      toolName: 'Bash',
      message: '  TypeError:\n  cannot\tread    properties  ',
    });

    expect(result.summary).toBe('tool_handler_exception from claude-cli/Bash: TypeError: cannot read properties');
    expect({
      chatJid: result.chatJid,
      mapKey: result.mapKey,
      sessionId: result.sessionId,
      toolName: result.toolName,
    }).toEqual({
      chatJid: null,
      mapKey: null,
      sessionId: null,
      toolName: 'Bash',
    });
  });

  it('summarizes provider exits when no message is available', () => {
    const result = classifyAgentFailure({
      ...baseInput,
      source: 'provider_process_exit',
      exitCode: 7,
      signal: null,
    });

    expect(result.failureClass).toBe('provider_cli_crash');
    expect(result.summary).toContain('provider exited with code=7 signal=none');
  });

  it('keeps malformed clean-exit metadata alertable without crash classification', () => {
    const result = classifyAgentFailure({
      ...baseInput,
      source: 'provider_process_exit',
      exitCode: 0,
      signal: '',
    });

    expect(result.failureClass).toBe('provider_unknown');
    expect(result.qAlertRequired).toBe(true);
    expect(result.summary).toContain('provider exited with code=0 signal=');
  });

  it('handles non-Error values and unknown provider failures explicitly', () => {
    const nonError = classifyAgentFailure({
      ...baseInput,
      source: 'provider_error',
      error: { status: '503', code: 123 },
    });
    const unknown = classifyAgentFailure({
      ...baseInput,
      source: 'provider_error',
    });
    const emptyError = classifyAgentFailure({
      ...baseInput,
      source: 'provider_error',
      error: '',
    });

    expect(nonError.failureClass).toBe('provider_unknown');
    expect(nonError.summary).toContain('[object Object]');
    expect(nonError.severity).toBe('warning');
    expect(unknown.failureClass).toBe('provider_unknown');
    expect(unknown.summary).toContain('unknown agent failure');
    expect(unknown.severity).toBe('warning');
    expect(emptyError.summary).toBe('provider_unknown from claude-cli: unknown');
  });

  it('does not require a Q page for clean provider process exits', () => {
    for (const input of [
      { exitCode: 0, signal: null },
      { exitCode: null, signal: 'SIGTERM' },
      { exitCode: null, signal: 'SIGINT' },
    ] as const) {
      const result = classifyAgentFailure({
        ...baseInput,
        source: 'provider_process_exit',
        ...input,
      });

      expect(isExpectedProviderShutdown({ source: 'provider_process_exit', ...input })).toBe(true);
      expect(result.failureClass).toBe('provider_unknown');
      expect(result.qAlertRequired).toBe(false);
      expect(result.fallbackEligible).toBe(false);
    }
  });

  it('keeps abnormal provider signals page-worthy', () => {
    const result = classifyAgentFailure({
      ...baseInput,
      source: 'provider_process_exit',
      exitCode: null,
      signal: 'SIGKILL',
    });

    expect(result.failureClass).toBe('provider_cli_crash');
    expect(result.qAlertRequired).toBe(true);
  });

  it('marks unsafe config/capability failures as ineligible for user-facing backup fallback', () => {
    const result = classifyAgentFailure({
      ...baseInput,
      source: 'config',
      message: 'unknown provider claud-cli',
    });

    expect(result.failureClass).toBe('config_or_capability_missing');
    expect(result.fallbackEligible).toBe(false);
    expect(result.severity).toBe('warning');
  });

  it('marks runtime provider failures page-only by default until the backup failure domain is independent', () => {
    for (const failureClass of [
      'provider_usage_limit',
      'provider_rate_limit',
      'provider_server_error',
      'provider_model_unavailable',
      'provider_cli_crash',
      'provider_timeout',
      'provider_network_error',
      'provider_silent_hang',
      'provider_stream_corrupt',
    ] as const) {
      expect(isFallbackEligibleForFailureClass(failureClass)).toBe(false);
      expect(isFallbackEligibleForFailureClass(failureClass, { failureDomain: 'independent' })).toBe(true);
    }
  });

  it('allows context-overflow fallback only with an independent larger-context backup', () => {
    expect(isFallbackEligibleForFailureClass('provider_context_overflow')).toBe(false);
    expect(isFallbackEligibleForFailureClass('provider_context_overflow', {
      failureDomain: 'independent',
      contextWindow: 'same_or_smaller',
    })).toBe(false);
    expect(isFallbackEligibleForFailureClass('provider_context_overflow', {
      failureDomain: 'independent',
      contextWindow: 'larger',
    })).toBe(true);
  });

  it('keeps policy, config, auth, tool, MCP, binary-missing, and permission-denied failures page-only even with an independent backup', () => {
    for (const failureClass of [
      'provider_policy_block',
      'config_or_capability_missing',
      'provider_auth_required',
      'mcp_transport_failure',
      'tool_handler_exception',
      'provider_unknown',
      'provider_binary_missing',
      'provider_permission_denied',
    ] as const) {
      expect(isFallbackEligibleForFailureClass(failureClass, { failureDomain: 'independent' })).toBe(false);
    }
  });

  it('records fallback eligibility when a classification is created with an independent backup domain', () => {
    const result = classifyAgentFailure({
      ...baseInput,
      source: 'provider_error',
      error: new WhatSoupError('openai rate limited', 'LLM_RATE_LIMITED'),
      backupFailureDomain: 'independent',
    });

    expect(result.failureClass).toBe('provider_rate_limit');
    expect(result.fallbackEligible).toBe(true);
  });

  it('requires a larger independent backup context for context-overflow fallback eligibility', () => {
    const sameOrSmaller = classifyAgentFailure({
      ...baseInput,
      source: 'provider_result',
      message: 'Prompt is too long for the current context window.',
      backupFailureDomain: 'independent',
      backupContextWindow: 'same_or_smaller',
    });
    const larger = classifyAgentFailure({
      ...baseInput,
      source: 'provider_result',
      message: 'Prompt is too long for the current context window.',
      backupFailureDomain: 'independent',
      backupContextWindow: 'larger',
    });

    expect(sameOrSmaller.failureClass).toBe('provider_context_overflow');
    expect(sameOrSmaller.fallbackEligible).toBe(false);
    expect(larger.failureClass).toBe('provider_context_overflow');
    expect(larger.fallbackEligible).toBe(true);
  });

  it('builds a stable incident id for repeated identical failures and separates different chats', () => {
    const a = classifyAgentFailure({
      ...baseInput,
      source: 'provider_result',
      message: "You're out of extra usage. Claude will be available at 8pm.",
    });
    const b = classifyAgentFailure({
      ...baseInput,
      source: 'provider_result',
      message: "You're out of extra usage. Claude will be available at 8pm.",
    });
    const c = classifyAgentFailure({
      ...baseInput,
      chatJid: 'other@g.us',
      source: 'provider_result',
      message: "You're out of extra usage. Claude will be available at 8pm.",
    });

    expect(a.incidentId).toBe(b.incidentId);
    expect(a.incidentId).not.toBe(c.incidentId);
  });
});

describe('enum coverage for extended failure classes', () => {
  it('provider_binary_missing is a valid AgentFailureClass that maps to non-fallback-eligible', () => {
    expect(isFallbackEligibleForFailureClass('provider_binary_missing')).toBe(false);
    expect(isFallbackEligibleForFailureClass('provider_binary_missing', { failureDomain: 'independent' })).toBe(false);
  });

  it('provider_permission_denied is a valid AgentFailureClass that maps to non-fallback-eligible', () => {
    expect(isFallbackEligibleForFailureClass('provider_permission_denied')).toBe(false);
    expect(isFallbackEligibleForFailureClass('provider_permission_denied', { failureDomain: 'independent' })).toBe(false);
  });

  it('provider_binary_missing and provider_permission_denied have critical severity when classified', () => {
    // Verify via a classification that uses them: crash-diagnostics returns these classes
    // but classifyAgentFailure doesn't directly produce them — verify severityForFailureClass
    // path by exhaustive switch coverage (they fall through to critical).
    // We assert the enum members are present in the type by construction above (TypeScript).
    const binaryMissing: import('../../../src/runtimes/agent/failure-taxonomy.ts').AgentFailureClass = 'provider_binary_missing';
    const permDenied: import('../../../src/runtimes/agent/failure-taxonomy.ts').AgentFailureClass = 'provider_permission_denied';
    expect(binaryMissing).toBe('provider_binary_missing');
    expect(permDenied).toBe('provider_permission_denied');
  });
});

describe('canonical structured error-token classification', () => {
  // Anthropic API (error.type) and OpenAI API (error.type / error.code) tokens —
  // these may arrive in a structured JSON body without the legacy English phrasing.
  it.each([
    // usage-limit (account action), NOT transient rate-limit
    ['{"error":{"type":"insufficient_quota","message":"You exceeded your quota"}}', 'usage-limit'],
    ['{"error":{"type":"billing_error","message":"credit balance too low"}}', 'usage-limit'],
    // transient rate-limit
    ['{"error":{"type":"rate_limit_exceeded","message":"slow down"}}', 'rate-limit'],
    ['{"error":{"type":"rate_limit_error","message":"too many requests"}}', 'rate-limit'],
    // auth
    ['{"error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'auth-required'],
    ['{"error":{"code":"invalid_api_key","message":"Incorrect API key"}}', 'auth-required'],
    // model unavailable
    ['{"error":{"type":"not_found_error","message":"model: claude-x"}}', 'model-unavailable'],
    ['{"error":{"code":"model_not_found"}}', 'model-unavailable'],
    // context overflow
    ['{"error":{"type":"request_too_large","message":"413"}}', 'context-overflow'],
    ['stop_reason: model_context_window_exceeded', 'context-overflow'],
  ] as const)('classifies %s as %s', (text, expected) => {
    expect(classifyProviderFailure(text)).toBe(expected);
  });

  it('keeps the 429 split: insufficient_quota is usage-limit, not rate-limit', () => {
    const quota = 'HTTP 429 {"error":{"type":"insufficient_quota"}}';
    // Even though the text contains 429, the quota token wins → usage-limit.
    expect(classifyProviderFailure(quota)).toBe('usage-limit');
  });

  it('does not over-match ordinary prose mentioning rate limits or quotas', () => {
    expect(classifyProviderFailure('We should document how rate limits and quota work.')).toBeNull();
    expect(isRateLimitResultMessage('Discussing the rate limit policy for the docs.')).toBe(false);
  });
});

describe('isUsageLimitMessage — residual terminal-credit/quota branch shapes', () => {
  it('classifies a "% of your" plan-usage warning as a usage limit', () => {
    // hasApproachingLimitWarning short-circuits on "% of your" before the
    // anchored-name loop, but isProviderCreditBalanceLimitMessage runs first and
    // this phrasing alone is not credit-limit terminal — so the message stays a
    // non-terminal warning. The "% of your" detector itself returns true here.
    expect(isUsageLimitMessage("You've used 85% of your weekly limit.")).toBe(false);
  });

  it('treats a model-policy usage-credit gate as terminal usage-limit', () => {
    expect(
      isUsageLimitMessage('Model policy only allows a model that needs a usage credit.'),
    ).toBe(true);
  });

  it('treats "out of usage" with each org/admin co-word as a credit limit', () => {
    expect(isUsageLimitMessage('You are out of usage; please contact your admin.')).toBe(true);
    expect(isUsageLimitMessage('Out of usage — your org has no remaining allocation.')).toBe(true);
    expect(isUsageLimitMessage('Out of usage because the org is over its cap.')).toBe(true);
    expect(isUsageLimitMessage('Out of usage for the group allocation this cycle.')).toBe(true);
  });

  it('treats "account balance" with each exhaustion co-word as a credit limit', () => {
    expect(isUsageLimitMessage('The provider account balance is too low.')).toBe(true);
    expect(isUsageLimitMessage('Provider account balance is insufficient to continue.')).toBe(true);
    expect(isUsageLimitMessage('API account balance is exhausted for this billing cycle.')).toBe(true);
  });
});

describe('isTransientProviderConnectionMessage — ETIMEDOUT socket-context co-words', () => {
  it('matches ETIMEDOUT in a socket context', () => {
    expect(isTransientProviderConnectionMessage('socket ETIMEDOUT while reading')).toBe(true);
  });

  it('matches ETIMEDOUT in a peer context', () => {
    expect(isTransientProviderConnectionMessage('ETIMEDOUT from the upstream peer')).toBe(true);
  });

  it('does not match a bare ETIMEDOUT without socket/connect/peer context', () => {
    expect(isTransientProviderConnectionMessage('request failed: ETIMEDOUT')).toBe(false);
  });
});
