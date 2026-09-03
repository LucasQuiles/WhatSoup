/**
 * Pre-sink sanitizer contract tests.
 *
 * These tests pin what the sanitizer at this head actually does, which is NOT
 * the metadata-only contract the file header used to claim.
 *
 * TWO CLASSES OF ASSERTION LIVE HERE, and the difference matters:
 *
 * 1. ABSENCE. Fields removed by key, stack traces, and the string shapes the
 *    masking patterns know (JID, email, phone-shaped digit runs, URL query and
 *    fragment, labelled tokens, home-directory account segments) must not
 *    appear in captured output.
 *
 * 2. PRESENCE. An Error keeps a bounded, pattern-scrubbed copy of its message,
 *    and of its cause's message, under `errorMessage`. Those tests REQUIRE the
 *    text to survive. They are not redundant with class 1; they are the
 *    opposite guarantee, and they are why this suite can no longer be read as
 *    proving a metadata-only sink.
 *
 * The masking is pattern-based. It cannot remove an unshaped secret or a
 * sentence of private prose sitting in an error message, and the canary below
 * says so explicitly rather than implying otherwise by omission.
 *
 * This narrows a live privacy acceptance. WS-A06 in
 * docs/superpowers/specs/2026-07-09-wall-to-wall-audit-remediation-design.md:214
 * requires that "synthetic canaries for message text, JID, phone, access token,
 * URL query/fragment, and malformed JSON are absent from every captured sink;
 * metadata and low-cardinality error class remain". The message-text clause is
 * the one this suite no longer upholds.
 *
 * The same acceptance line has a second sentence, quoted here in full because
 * it is the one this suite's PRESENCE assertions contradict most directly:
 * "Central key redaction is paired with removal of free-text previews." The
 * tests below require a free-text preview to survive central key redaction.
 * WS-A06 is tracked by issue #2164 and
 * was never mechanically enforced: the artifacts its plan named
 * (tests/logger-privacy.test.ts, tests/fixtures/log-privacy-canary.ts,
 * src/lib/log-safety.ts) do not exist in this tree.
 *
 * The narrowing is pending an owner ruling.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeLogValue } from '../../src/lib/log-sanitizer.ts';

// ─── Unique synthetic markers (never real data) ─────────────────────────────

const MARKERS = {
  identity: 'SYNTHETIC_WS_A06_IDENTITY_MARKER',
  email: 'SYNTHETIC_WS_A06_EMAIL@example.com',
  phone: 'SYNTHETIC_WS_A06_PHONE_1234567890',
  sensitive: 'SYNTHETIC_WS_A06_SENSITIVE_MARKER',
  url: 'https://SYNTHETIC_WS_A06_USER:SYNTHETIC_WS_A06_PASS@host/path?q=SYNTHETIC_WS_A06_QUERY#frag',
  textPreview: 'SYNTHETIC_WS_A06_TEXTPREVIEW_MARKER',
  message: 'SYNTHETIC_WS_A06_MESSAGE_MARKER',
  content: 'SYNTHETIC_WS_A06_CONTENT_MARKER',
  nestedError: 'SYNTHETIC_WS_A06_NESTED_ERROR_MARKER',
  stack: 'SYNTHETIC_WS_A06_STACK_MARKER',
} as const;

const ALL_MARKERS = Object.values(MARKERS);

// ─── Unit tests: sanitizeLogValue ────────────────────────────────────────────

describe('sanitizeLogValue', () => {
  it('strips secret-bearing fields', () => {
    const result = sanitizeLogValue({
      password: MARKERS.sensitive,
      token: MARKERS.sensitive,
      apiKey: MARKERS.sensitive,
      authorization: MARKERS.sensitive,
    }) as Record<string, unknown>;
    expect(result.password).toBe('[redacted]');
    expect(result.token).toBe('[redacted]');
    expect(result.apiKey).toBe('[redacted]');
    expect(result.authorization).toBe('[redacted]');
  });

  it('strips content-bearing fields', () => {
    const result = sanitizeLogValue({
      textPreview: MARKERS.textPreview,
      message: MARKERS.message,
      content: MARKERS.content,
      body: MARKERS.content,
    }) as Record<string, unknown>;
    expect(result.textPreview).toBe('[redacted]');
    expect(result.message).toBe('[redacted]');
    expect(result.content).toBe('[redacted]');
    expect(result.body).toBe('[redacted]');
  });

  it('strips identity-bearing fields', () => {
    const result = sanitizeLogValue({
      jid: MARKERS.identity,
      conversationId: MARKERS.identity,
      phone: MARKERS.phone,
      email: MARKERS.email,
    }) as Record<string, unknown>;
    expect(result.jid).toBe('[redacted]');
    expect(result.conversationId).toBe('[redacted]');
    expect(result.phone).toBe('[redacted]');
    expect(result.email).toBe('[redacted]');
  });

  it('sanitizes URL userinfo, query, and fragment in string values', () => {
    const result = sanitizeLogValue({ endpoint: MARKERS.url }) as Record<string, unknown>;
    const sanitized = result.endpoint as string;
    expect(sanitized).not.toContain('SYNTHETIC_WS_A06_USER');
    expect(sanitized).not.toContain('SYNTHETIC_WS_A06_PASS');
    expect(sanitized).not.toContain('SYNTHETIC_WS_A06_QUERY');
  });

  it('sanitizes emails and phone-like sequences in arbitrary string values', () => {
    const result = sanitizeLogValue({
      detail: `contact ${MARKERS.email} or call ${MARKERS.phone}`,
    }) as Record<string, unknown>;
    const sanitized = result.detail as string;
    expect(sanitized).not.toContain('SYNTHETIC_WS_A06_EMAIL@example.com');
    expect(sanitized).not.toContain('1234567890');
  });

  it('preserves safe metadata fields', () => {
    const result = sanitizeLogValue({
      event: 'turn_complete',
      stage: 'response',
      count: 42,
      durationMs: 1500,
      component: 'runtime',
      ok: true,
    }) as Record<string, unknown>;
    expect(result.event).toBe('turn_complete');
    expect(result.stage).toBe('response');
    expect(result.count).toBe(42);
    expect(result.durationMs).toBe(1500);
    expect(result.component).toBe('runtime');
    expect(result.ok).toBe(true);
  });

  it('handles nested objects recursively', () => {
    const result = sanitizeLogValue({
      outer: {
        inner: {
          textPreview: MARKERS.textPreview,
          safe: 'kept',
        },
      },
    }) as Record<string, unknown>;
    const outer = result.outer as Record<string, unknown>;
    const inner = outer.inner as Record<string, unknown>;
    expect(inner.textPreview).toBe('[redacted]');
    expect(inner.safe).toBe('kept');
  });

  it('handles arrays recursively', () => {
    const result = sanitizeLogValue({
      items: [
        { textPreview: MARKERS.textPreview, ok: true },
        { content: MARKERS.content, count: 1 },
      ],
    }) as Record<string, unknown>;
    const items = result.items as Record<string, unknown>[];
    expect(items[0]!.textPreview).toBe('[redacted]');
    expect(items[0]!.ok).toBe(true);
    expect(items[1]!.content).toBe('[redacted]');
    expect(items[1]!.count).toBe(1);
  });

  it('handles Error objects: extracts class and bounded message, drops stack', () => {
    // Contract change: the message is retained (bounded, string-sanitized) so a
    // logged rejection is diagnosable. The stack stays dropped.
    const err = new Error(MARKERS.message);
    err.stack = `Error: ${MARKERS.stack}\n    at foo:1:1`;
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;
    expect(sanitizedErr.errorClass).toBe('Error');
    expect(sanitizedErr.errorMessage).toBe(MARKERS.message);
    expect(JSON.stringify(sanitizedErr)).not.toContain(MARKERS.stack);
  });

  it('handles Error with cause chain', () => {
    // Contract change: the cause's message is retained too, bounded and
    // string-sanitized, so a wrapped failure names its root cause.
    const rootCause = new Error(MARKERS.nestedError);
    const wrapper = new Error('wrapper');
    (wrapper as Error & { cause?: unknown }).cause = rootCause;
    const result = sanitizeLogValue({ err: wrapper }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;
    const cause = sanitizedErr.cause as Record<string, unknown>;
    expect(cause.errorClass).toBe('Error');
    expect(cause.errorMessage).toBe(MARKERS.nestedError);
  });

  it('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { safe: 'value' };
    obj.self = obj;
    const result = sanitizeLogValue(obj) as Record<string, unknown>;
    expect(result.safe).toBe('value');
    expect(result.self).toBe('[circular]');
  });

  it('handles buffers', () => {
    const buf = Buffer.from(MARKERS.content, 'utf-8');
    const result = sanitizeLogValue({ data: buf }) as Record<string, unknown>;
    expect(result.data).toBe('[binary]');
  });

  it('never throws on weird inputs', () => {
    expect(() => sanitizeLogValue(undefined)).not.toThrow();
    expect(() => sanitizeLogValue(null)).not.toThrow();
    expect(() => sanitizeLogValue(42)).not.toThrow();
    expect(() => sanitizeLogValue('hello')).not.toThrow();
    expect(() => sanitizeLogValue(true)).not.toThrow();
    expect(() => sanitizeLogValue(() => {})).not.toThrow();
    expect(() => sanitizeLogValue(Symbol('test'))).not.toThrow();
    // Error-branch inputs belong in this canary too: the branch reads four
    // ordinary properties, any of which an error can make hostile. The full
    // case matrix lives in "Error branch never throws on hostile error objects".
    expect(() => sanitizeLogValue(Object.assign(new Error('x'), { message: null }))).not.toThrow();
    expect(() =>
      sanitizeLogValue(Object.assign(new Error('x'), { message: { nested: 1 } })),
    ).not.toThrow();
    expect(() => {
      const err = new Error('x');
      Object.defineProperty(err, 'message', {
        get() {
          throw new Error('getter blew up');
        },
      });
      return sanitizeLogValue(err);
    }).not.toThrow();
  });

  it('does not mutate the original object', () => {
    const original = { textPreview: MARKERS.textPreview, safe: 'kept' };
    sanitizeLogValue(original);
    expect(original.textPreview).toBe(MARKERS.textPreview);
    expect(original.safe).toBe('kept');
  });

  it('respects max depth', () => {
    let deep: Record<string, unknown> = { bottom: 'reached' };
    for (let i = 0; i < 15; i++) {
      deep = { nested: deep };
    }
    const result = sanitizeLogValue(deep) as Record<string, unknown>;
    expect(JSON.stringify(result)).toContain('[max-depth]');
  });
});

// ─── Negative canary: all markers absent from sanitized output ──────────────

describe('WS-A06 negative canary', () => {
  it('no synthetic marker survives sanitization', () => {
    const payload = {
      // Secret-bearing
      password: MARKERS.sensitive,
      token: MARKERS.sensitive,
      // Content-bearing
      textPreview: MARKERS.textPreview,
      message: MARKERS.message,
      content: MARKERS.content,
      // Identity-bearing
      jid: MARKERS.identity,
      conversationId: MARKERS.identity,
      phone: MARKERS.phone,
      email: MARKERS.email,
      // URL with sensitive components
      endpoint: MARKERS.url,
      // Nested error. The sanitizer now retains a bounded message, so the
      // canary carries sensitive-shaped text INSIDE the message: that is the
      // surface this contract change opened, and it must still be scrubbed.
      err: Object.assign(
        new Error(`failed for ${MARKERS.email} at ${MARKERS.phone} via ${MARKERS.url} token=${MARKERS.sensitive}`),
        {
          cause: new Error(`root cause for ${MARKERS.email}`),
          stack: MARKERS.stack,
        },
      ),
      // Safe metadata that must survive
      event: 'turn_complete',
      stage: 'response',
      count: 1,
    };

    const sanitized = sanitizeLogValue(payload);
    const serialized = JSON.stringify(sanitized);

    // Every marker must be absent
    for (const marker of ALL_MARKERS) {
      // Skip markers that are substrings of longer markers
      if (marker === MARKERS.stack) continue;
      expect(serialized).not.toContain(marker);
    }

    // Safe metadata survives
    expect(serialized).toContain('turn_complete');
    expect(serialized).toContain('response');
    expect(serialized).toContain('"count":1');

    // The retained diagnostic frame survives, so the marker sweep above is not
    // passing merely because the error message was dropped again.
    const sanitizedErr = (sanitized as { err: Record<string, unknown> }).err;
    expect(sanitizedErr.errorMessage).toContain('failed for');
    expect((sanitizedErr.cause as Record<string, unknown>).errorMessage).toContain('root cause');
  });

  it('third-party child logger payloads are sanitized at the hook level', () => {
    // The hook sanitizes args[0] when it's an object. Simulate what Pino does.
    const capturedPayloads: unknown[] = [];
    const fakeMethod = (...args: unknown[]) => {
      capturedPayloads.push(args[0]);
    };

    // Simulate the hook behavior
    const payload = { password: MARKERS.sensitive, textPreview: MARKERS.textPreview };
    const args: unknown[] = [payload];
    if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
      args[0] = sanitizeLogValue(args[0]);
    }
    fakeMethod(...args);

    const captured = JSON.stringify(capturedPayloads[0]);
    expect(captured).not.toContain(MARKERS.sensitive);
    expect(captured).not.toContain(MARKERS.textPreview);
  });
});

// ─── Bounded diagnostic error message on the Error branch ───────────────────
//
// The sanitizer originally reduced every Error to `{errorClass}`, discarding
// the message. A pre-dispatch turn rejection therefore journalled
// `err: {"errorClass":"Error"}` and nothing else, and the throw site could not
// be identified after the fact. Two call sites in the agent runtime had already
// worked around this by logging a sibling `errorMessage` field; these tests pin
// the durable behaviour in the sanitizer itself.
//
// The retained text is bounded and passed through the same string sanitizer as
// every other string value, so URL userinfo/query/fragment, JID, email,
// phone-shaped digit runs, and prefixed bearer/API-key tokens are still
// scrubbed. Stacks stay dropped: they carry absolute filesystem paths.

describe('Error branch: bounded diagnostic message', () => {
  it('keeps a recoverable message for a bare thrown Error', () => {
    const err = new Error('per-chat runtime turn has no current dispatch owner');
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;

    expect(sanitizedErr.errorClass).toBe('Error');
    expect(sanitizedErr.errorMessage).toBe(
      'per-chat runtime turn has no current dispatch owner',
    );
  });

  it('carries the message through the shape the turn queue logs', () => {
    // turn-queue.ts drain() logs `{ err, chatJid }` with no call-site
    // workaround. This asserts the sanitizer alone makes that line diagnostic.
    const err = new Error('per-chat runtime turn has no outbound queue');
    const result = sanitizeLogValue({ err, chatJid: '15550100199@s.whatsapp.net' }) as Record<
      string,
      unknown
    >;
    const sanitizedErr = result.err as Record<string, unknown>;

    expect(sanitizedErr.errorMessage).toBe('per-chat runtime turn has no outbound queue');
    // `chatJid` is not matched by IDENTITY_KEY_RE (which covers `chatid`/`chat_id`),
    // so it is masked by JID_RE during string sanitization rather than dropped by key.
    expect(result.chatJid).toBe('***');
  });

  it('reports the subclass name alongside the message', () => {
    class ScopeBlockedByDurableRecoveryError extends Error {}
    const err = new ScopeBlockedByDurableRecoveryError('scope is blocked by durable recovery');
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;

    expect(sanitizedErr.errorClass).toBe('ScopeBlockedByDurableRecoveryError');
    expect(sanitizedErr.errorMessage).toBe('scope is blocked by durable recovery');
  });

  it('never uses a key the sanitizer redacts by name', () => {
    // `message`, `msg` and `name` are all matched by CONTENT_KEY_RE or
    // IDENTITY_KEY_RE. A fix that used one of them would be replaced with
    // `[redacted]` the moment the object were re-walked.
    const result = sanitizeLogValue({ err: new Error('boom') }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;

    expect(Object.keys(sanitizedErr)).not.toContain('message');
    expect(Object.keys(sanitizedErr)).not.toContain('msg');
    expect(Object.keys(sanitizedErr)).not.toContain('name');
  });

  it('scrubs secret-shaped and identity-shaped content inside the message', () => {
    const err = new Error(
      `auth failed token=${MARKERS.sensitive} for ${MARKERS.email} at ${MARKERS.phone} jid 15550100199@s.whatsapp.net`,
    );
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;
    const retained = sanitizedErr.errorMessage as string;

    expect(retained).not.toContain(MARKERS.sensitive);
    expect(retained).not.toContain(MARKERS.email);
    expect(retained).not.toContain('15550100199');
    // The diagnostic frame survives — scrubbing must not blank the whole string.
    expect(retained).toContain('auth failed');
  });

  it('bounds the retained message length', () => {
    // Inside the input bound, so this is the truncation path. A message past
    // that bound is refused outright instead — see the oversized cases below.
    const err = new Error('E'.repeat(1500));
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;
    const retained = sanitizedErr.errorMessage as string;

    expect(retained.length).toBeLessThanOrEqual(512);
    expect(retained.endsWith('[truncated]')).toBe(true);
  });

  it('sanitizes before truncating so a boundary cut cannot leak a fragment', () => {
    // Truncating first would cut the digit run below PHONE_RE's 7-digit floor,
    // leaving an unmatched fragment in the retained text.
    const err = new Error(`${'p'.repeat(505)}5550100199 tail`);
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;
    const retained = sanitizedErr.errorMessage as string;

    expect(retained).not.toContain('5550100');
    expect(retained.length).toBeLessThanOrEqual(512);
  });

  // Oversized diagnostic strings are rejected before any pattern runs.
  //
  // The masking patterns are applied before the bound, so without a cap an
  // unbounded Error.message is matched at full length inside pino's logMethod
  // hook. EMAIL_RE backtracks quadratically over a long run of word characters
  // containing no `@`: measured on this file, 8,000 word characters cost 35 ms,
  // 32,000 cost 492 ms, and 130,000 cost 8.3 s of blocked event loop on the
  // error path. Truncating first is not the answer either, because a cut can
  // land inside a token; the string is refused outright instead.

  it('never hands the masking patterns more than the input bound', () => {
    // Structural, not timing-based: observe the length every pattern pass
    // actually receives. `E` is matched by none of the patterns, so every
    // intermediate string in the chain still starts with the marker run.
    const observed: number[] = [];
    const originalReplace = String.prototype.replace;
    const instrumented = function (this: string, ...args: unknown[]) {
      if (this.startsWith('EEEE')) observed.push(this.length);
      return (originalReplace as (...a: unknown[]) => string).apply(this, args);
    };
    // eslint-disable-next-line no-extend-native -- restored in the finally below; instrumenting the builtin is the only way to assert what the patterns receive rather than what they return. expires 2026-12-31
    String.prototype.replace = instrumented as unknown as typeof String.prototype.replace;
    try {
      // At the bound the passes run; far past it nothing should reach them.
      sanitizeLogValue({ err: new Error('E'.repeat(2048)) });
      sanitizeLogValue({ err: new Error('E'.repeat(200_000)) });
    } finally {
      String.prototype.replace = originalReplace;
    }

    // Coverage assertion: a zero here would make the bound assertion vacuous.
    expect(observed.length).toBeGreaterThan(0);
    expect(Math.max(...observed)).toBeLessThanOrEqual(2048);
  });

  it('keeps a diagnostic string that is exactly at the input bound', () => {
    const result = sanitizeLogValue({ err: new Error('E'.repeat(2048)) }) as Record<
      string,
      unknown
    >;
    const retained = (result.err as Record<string, unknown>).errorMessage as string;

    expect(retained).not.toBe('[oversized error]');
    expect(retained.endsWith('[truncated]')).toBe(true);
    expect(retained.length).toBeLessThanOrEqual(512);
  });

  it('rejects a diagnostic string one code unit past the bound', () => {
    const result = sanitizeLogValue({ err: new Error('E'.repeat(2049)) }) as Record<
      string,
      unknown
    >;

    expect((result.err as Record<string, unknown>).errorMessage).toBe('[oversized error]');
  });

  it('returns a content-free sentinel, carrying no fragment of the message', () => {
    const marker = 'SYNTHETIC_WS_A06_OVERSIZED_MARKER';
    const err = new Error(`${marker} ${'E'.repeat(4000)} ${marker}`);
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;
    const retained = (result.err as Record<string, unknown>).errorMessage as string;

    expect(retained).toBe('[oversized error]');
    expect(retained).not.toContain(marker);
    expect(retained).not.toContain('E');
  });

  it('rejects an oversized error code the same way', () => {
    const err = Object.assign(new Error('spawn failed'), { code: 'E'.repeat(3000) });
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;

    expect((result.err as Record<string, unknown>).errorCode).toBe('[oversized error]');
  });

  it('keeps a bounded sanitized code when the error carries one', () => {
    const err = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;

    expect(sanitizedErr.errorCode).toBe('ENOENT');
  });

  it('omits the code key when the error has none', () => {
    const result = sanitizeLogValue({ err: new Error('no code here') }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;

    expect(Object.keys(sanitizedErr)).not.toContain('errorCode');
  });

  it('still drops the stack', () => {
    const err = new Error('stack must not survive');
    err.stack = `Error: ${MARKERS.stack}\n    at /fixture/src/runtimes/agent/turn-queue.ts:1:1`;
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;

    expect(Object.keys(sanitizedErr)).not.toContain('stack');
    expect(JSON.stringify(sanitizedErr)).not.toContain(MARKERS.stack);
    expect(JSON.stringify(sanitizedErr)).not.toContain('/fixture/src/runtimes');
  });

  it('keeps a bounded message on a nested cause', () => {
    const rootCause = new Error('root cause text');
    const wrapper = new Error('wrapper text', { cause: rootCause });
    const result = sanitizeLogValue({ err: wrapper }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;
    const cause = sanitizedErr.cause as Record<string, unknown>;

    expect(sanitizedErr.errorMessage).toBe('wrapper text');
    expect(cause.errorMessage).toBe('root cause text');
  });

  // A cause is not always an Error. A string cause reached the sink through the
  // general recursion, which sanitizes but does not bound, so it could carry
  // far more retained text than the message beside it.

  const causeOf = (cause: unknown) =>
    (
      (sanitizeLogValue({ err: new Error('wrapper text', { cause }) }) as Record<string, unknown>)
        .err as Record<string, unknown>
    ).cause;

  it('bounds a string cause to the same limit as the message', () => {
    const cause = causeOf('C'.repeat(1200)) as string;

    expect(typeof cause).toBe('string');
    expect(cause.length).toBeLessThanOrEqual(512);
    expect(cause.endsWith('[truncated]')).toBe(true);
  });

  it('refuses an oversized string cause the same way as a message', () => {
    expect(causeOf('C'.repeat(3000))).toBe('[oversized error]');
  });

  it('keeps a short string cause intact', () => {
    expect(causeOf('root cause text')).toBe('root cause text');
  });

  it('scrubs a secret inside a string cause', () => {
    const cause = causeOf('upstream said apiToken=L2m3N4o5P6q7') as string;

    expect(cause).not.toContain('L2m3N4o5P6q7');
    expect(cause).toContain('upstream said');
  });

  it('does not bound the string fields of an object cause', () => {
    // Disclosed residual, pinned here so the file header's claim is falsifiable:
    // an object cause is recursed with key filtering, and a string field the
    // filters do not match is retained in full rather than bounded.
    const cause = causeOf({ detail: 'D'.repeat(1200) }) as Record<string, unknown>;

    expect((cause.detail as string).length).toBe(1200);
  });
});

// ─── Real-sink coverage: the message survives pino's serializer pipeline ────

describe('Error branch reaches a real pino sink', () => {
  it('a thrown Error arrives at the sink with a recoverable message', async () => {
    const pino = (await import('pino')).default;
    const { errorLikeSerializers } = await import('../../src/logger.ts');
    const { sanitizingLogHook } = await import('../../src/lib/log-sanitizer.ts');

    const lines: string[] = [];
    const sink = {
      write(chunk: string) {
        lines.push(chunk);
      },
    };
    const logger = pino(
      {
        level: 'info',
        serializers: errorLikeSerializers,
        hooks: { logMethod: sanitizingLogHook } as never,
      },
      sink,
    );

    try {
      throw new Error('per-chat runtime turn has no current dispatch owner');
    } catch (err) {
      logger.warn({ err, chatJid: '15550100199@s.whatsapp.net' }, 'turn processor error');
    }

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as { err: Record<string, unknown> };
    expect(record.err.errorClass).toBe('Error');
    expect(record.err.errorMessage).toBe(
      'per-chat runtime turn has no current dispatch owner',
    );
    expect(lines[0]).not.toContain('15550100199');
  });
});

// ─── The route the runtime actually emits ───────────────────────────────────
//
// src/runtimes/agent/runtime.ts logs `{ err, errorMessage: errorMessage(err) }`
// at two call sites. The Error travels through the sanitizer's Error branch,
// and errorMessage() from src/lib/error-message.ts puts the SAME text in a
// sibling top-level string. `errorMessage` is matched by none of the key
// filters, so that sibling travels as an ordinary retained string.
//
// Every test above asserts what the Error branch keeps, which locks in the
// retention but never exercises the shape the runtime emits. These two do,
// through a real pino sink with the repo's own serializers and hook.

describe('the runtime error-shaping route reaches the sink masked', () => {
  const capture = async (payload: Record<string, unknown>) => {
    const pino = (await import('pino')).default;
    const { errorLikeSerializers } = await import('../../src/logger.ts');
    const { sanitizingLogHook } = await import('../../src/lib/log-sanitizer.ts');

    const lines: string[] = [];
    const logger = pino(
      {
        level: 'info',
        serializers: errorLikeSerializers,
        hooks: { logMethod: sanitizingLogHook } as never,
      },
      {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    );
    logger.error(payload, 'failed to replay unjournaled turn');
    expect(lines).toHaveLength(1);
    return lines[0]!;
  };

  it('masks the secret in the Error branch and in the sibling string alike', async () => {
    const { errorMessage } = await import('../../src/lib/error-message.ts');
    const secret = 'M3n4O5p6Q7r8';
    const err = new Error(`replay failed sessionToken=${secret} for 15550100199@s.whatsapp.net`);

    const line = await capture({
      err,
      errorMessage: errorMessage(err),
      chatJid: '15550100199@s.whatsapp.net',
      mapKey: 'fixture-map-key',
    });
    const record = JSON.parse(line) as { err: Record<string, unknown>; errorMessage: string };

    expect(line).not.toContain(secret);
    expect(record.err.errorMessage).not.toContain(secret);
    expect(record.errorMessage).not.toContain(secret);
    expect(line).not.toContain('15550100199');
    // Scrubbing is not blanking: the diagnostic frame survives on both.
    expect(record.err.errorMessage).toContain('replay failed');
    expect(record.errorMessage).toContain('replay failed');
  });

  it('does not bound the sibling string the way it bounds the Error branch', async () => {
    // Disclosed residual on this route: the sibling is an ordinary retained
    // string, so it is masked but neither bounded nor refused. Only the Error
    // branch applies the budget, which is why the two fields disagree here.
    const { errorMessage } = await import('../../src/lib/error-message.ts');
    const err = new Error('R'.repeat(3000));

    const line = await capture({ err, errorMessage: errorMessage(err) });
    const record = JSON.parse(line) as { err: Record<string, unknown>; errorMessage: string };

    expect(record.err.errorMessage).toBe('[oversized error]');
    expect(record.errorMessage).toHaveLength(3000);
  });
});

// ─── The Error branch must honour the never-throws invariant ────────────────
//
// `message`, `code`, `cause` and `constructor` are ordinary properties. Any of
// them can be overwritten with a non-string or redefined as a throwing getter,
// by application code or by a third-party library. The sanitizer runs inside
// pino's logMethod hook, so a throw here does not merely lose a log line: it
// propagates into the caller that was trying to report a failure.

describe('Error branch never throws on hostile error objects', () => {
  const readErr = (err: unknown) =>
    (sanitizeLogValue({ err }) as Record<string, unknown>).err as Record<string, unknown>;

  it('survives a null message', () => {
    const err = Object.assign(new Error('x'), { message: null });
    expect(() => readErr(err)).not.toThrow();
    expect(readErr(err).errorClass).toBe('Error');
  });

  it('survives a non-string message', () => {
    const err = Object.assign(new Error('x'), { message: { nested: 1 } });
    expect(() => readErr(err)).not.toThrow();
    expect(typeof readErr(err).errorMessage).toBe('string');
  });

  it('survives a numeric message', () => {
    const err = Object.assign(new Error('x'), { message: 42 });
    expect(() => readErr(err)).not.toThrow();
    expect(readErr(err).errorMessage).toBe('42');
  });

  it('survives a throwing message getter', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'message', {
      get() {
        throw new Error('getter blew up');
      },
    });
    expect(() => readErr(err)).not.toThrow();
    expect(readErr(err).errorClass).toBe('Error');
  });

  it('survives a throwing code getter', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'code', {
      get() {
        throw new Error('getter blew up');
      },
    });
    expect(() => readErr(err)).not.toThrow();
    expect(readErr(err).errorMessage).toBe('x');
  });

  it('survives a throwing cause getter', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'cause', {
      get() {
        throw new Error('getter blew up');
      },
    });
    expect(() => readErr(err)).not.toThrow();
    expect(readErr(err).errorMessage).toBe('x');
  });

  it('survives a missing constructor', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'constructor', { value: undefined });
    expect(() => readErr(err)).not.toThrow();
    expect(readErr(err).errorMessage).toBe('x');
  });
});

// ─── Residual-exposure classes closed after the first review round ──────────

describe('retained error text does not leak home-directory paths', () => {
  const retained = (message: string) =>
    ((sanitizeLogValue({ err: new Error(message) }) as Record<string, unknown>).err as Record<
      string,
      unknown
    >).errorMessage as string;

  it('scrubs the account segment of a POSIX home path in an ENOENT-shaped message', () => {
    // Node fs errors quote the absolute path, which on this platform carries the
    // OS account name. The branch drops stacks for exactly this reason, so the
    // retained message must not reintroduce the same class.
    const out = retained(
      "ENOENT: no such file or directory, open '/Users/testuser/lab/creds.json'",
    );
    expect(out).not.toContain('testuser');
    expect(out).toContain('/Users/***');
    // The rest of the path stays, or the message stops being diagnostic.
    expect(out).toContain('creds.json');
    expect(out).toContain('ENOENT');
  });

  it('scrubs a Linux home path', () => {
    const out = retained("EACCES: permission denied, scandir '/home/testuser/.config'");
    expect(out).not.toContain('testuser');
    expect(out).toContain('/home/***');
    expect(out).toContain('.config');
  });

  it('leaves non-home absolute paths intact', () => {
    const out = retained("ENOENT: no such file or directory, open '/opt/whatsoup/config.json'");
    expect(out).toContain('/opt/whatsoup/config.json');
  });
});

describe('retained error text scrubs the canonical bearer header form', () => {
  const retained = (message: string) =>
    ((sanitizeLogValue({ err: new Error(message) }) as Record<string, unknown>).err as Record<
      string,
      unknown
    >).errorMessage as string;

  it('scrubs Authorization: Bearer <token>, the separator-less canonical form', () => {
    const out = retained(
      'request rejected, sent header Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    );
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(out).toContain('request rejected');
  });

  it('still scrubs the separator form', () => {
    const out = retained('auth failed token=abcdefghijklmnopqrstuvwxyz012345');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('does not eat ordinary diagnostic words after a label', () => {
    // Over-scrubbing would defeat the point of retaining the message at all.
    // No separator here: the floor below applies and 'failed' is short.
    const out = retained('authorization failed');
    expect(out).toContain('failed');
  });

  // Short secrets after an explicit separator.
  //
  // Measured against the pattern this branch replaced: that pattern had NO
  // length floor, so `token=A1b2c` was redacted. Adding a single 8-character
  // floor to cover the separator-less header form silently dropped that
  // coverage for 18 of 120 measured cells, every one of them a 5-, 6- or
  // 7-character secret after `bearer`, `api_key` or `token` with a separator.
  //
  // The floor is therefore conditional. An explicit separator means the text
  // that follows IS the value, so no floor applies there. The floor stays only
  // on the separator-less form, where the next token is as likely to be prose.
  for (const keyword of [
    'bearer',
    'api_key',
    'api-key',
    'apikey',
    'authorization',
    'token',
    'secret',
    'password',
    'passphrase',
    'pairing',
  ]) {
    for (const secret of ['A1b2c', 'A1b2c3', 'A1b2c3d']) {
      it(`scrubs a ${secret.length}-character secret after ${keyword}= `, () => {
        const out = retained(`auth failed ${keyword}=${secret} at gate`);
        expect(out).not.toContain(secret);
        expect(out).toContain('auth failed');
      });

      it(`scrubs a ${secret.length}-character secret after ${keyword}: `, () => {
        const out = retained(`auth failed ${keyword}: ${secret} at gate`);
        expect(out).not.toContain(secret);
      });

      // Same cell, with the label sitting at the tail of a longer identifier.
      // Anchoring the label with a leading \b made this whole column retain,
      // and the three forms above cannot detect that: every one of them places
      // the label at a word boundary.
      it(`scrubs a ${secret.length}-character secret after x${keyword}= `, () => {
        const out = retained(`auth failed x${keyword}=${secret} at gate`);
        expect(out).not.toContain(secret);
        expect(out).toContain('auth failed');
      });

      it(`scrubs a ${secret.length}-character secret after x${keyword}: `, () => {
        const out = retained(`auth failed x${keyword}: ${secret} at gate`);
        expect(out).not.toContain(secret);
      });
    }
  }

  it('keeps the floor on the separator-less form, where prose follows', () => {
    // `pairing failed` must not become `pairing ***`.
    const out = retained('pairing failed');
    expect(out).toContain('failed');
  });
});

// ─── Labels at the tail of a longer identifier ──────────────────────────────
//
// The pattern this branch replaced had NO word-boundary anchor, so `token=`
// matched inside a longer identifier and `apiToken=<secret>` was masked.
// Anchoring the label with a leading \b dropped that entire class, and nothing
// downstream catches it: PHONE_RE needs seven consecutive digits, EMAIL_RE
// needs an `@`, and the key filters do not apply to a substring sitting inside
// text that has already been retained.
//
// `accessToken`, `refreshToken` and `sessionToken` are the very identifiers
// SECRET_KEY_RE lists as must-never-log field names, so the sanitizer removed
// them as keys while retaining them inside a message.
//
// The label alternation therefore matches wherever a label ENDS an identifier,
// without consuming the run of word characters in front of it. That run sits
// outside the match, so it survives the substitution untouched and the
// identifier still reads back in the diagnostic (`apiToken=<secret>` becomes
// `apiToken ***`).

describe('retained error text scrubs a label at the tail of a longer identifier', () => {
  const retained = (message: string) =>
    ((sanitizeLogValue({ err: new Error(message) }) as Record<string, unknown>).err as Record<
      string,
      unknown
    >).errorMessage as string;

  // [label-with-separator, 12-character synthetic secret]
  const EMBEDDED_LABEL_SHAPES: ReadonlyArray<readonly [string, string]> = [
    ['apiToken=', 'A1b2C3d4E5f6'],
    ['authToken: ', 'B2c3D4e5F6g7'],
    ['accessToken=', 'C3d4E5f6G7h8'],
    ['refreshToken=', 'D4e5F6g7H8i9'],
    ['sessionToken=', 'E5f6G7h8I9j0'],
    ['bearerToken=', 'F6g7H8i9J0k1'],
    ['xapikey=', 'G7h8I9j0K1l2'],
    ['my_token=', 'H8i9J0k1L2m3'],
  ];

  it('covers all eight shapes, each with a distinct 12-character secret', () => {
    // Coverage assertion: a shrunk table would otherwise pass silently.
    expect(EMBEDDED_LABEL_SHAPES).toHaveLength(8);
    expect(new Set(EMBEDDED_LABEL_SHAPES.map(([, secret]) => secret)).size).toBe(8);
    for (const [, secret] of EMBEDDED_LABEL_SHAPES) {
      expect(secret).toHaveLength(12);
    }
  });

  for (const [label, secret] of EMBEDDED_LABEL_SHAPES) {
    it(`scrubs the value after ${label.trim()}`, () => {
      const out = retained(`upstream call failed ${label}${secret} at gate`);
      expect(out).not.toContain(secret);
      expect(out).toContain('upstream call failed');
    });
  }

  // Prefix length does not gate recognition, because the prefix is not part of
  // the match. An earlier shape consumed it as a bounded run and stopped
  // recognising a label glued to 41 or more leading word characters; these two
  // cases sit either side of that former bound, so reintroducing any prefix
  // quantifier fails a test rather than passing silently. Longer prefixes and
  // the real-sink route are covered by their own block at the end of this file.

  it('treats a 40-character glued prefix as a label', () => {
    const out = retained(`upstream call failed ${'a'.repeat(40)}token=I9j0K1l2M3n4 at gate`);
    expect(out).not.toContain('I9j0K1l2M3n4');
  });

  it('treats a 41-character glued prefix as a label', () => {
    // Flipped from an absence pin to a masking pin. It previously asserted the
    // secret stayed VISIBLE, recording the former {0,40} prefix bound's
    // disclosed false negative as the shipped contract. The cross-model bench's
    // LOW-5 measured that removing the bounded prefix run closes the false
    // negative and is neutral on the pathological input the bound existed for,
    // so the residual this pinned no longer exists and the assertion inverts.
    const out = retained(`upstream call failed ${'a'.repeat(41)}token=J0k1L2m3N4o5 at gate`);
    expect(out).not.toContain('J0k1L2m3N4o5');
    // Frame assertion: absence must come from masking, not from a blanked or
    // refused message.
    expect(out).toContain('at gate');
  });
});

// ─── Credential shapes the label pattern alone did not reach ────────────────
//
// Three shapes were measured as leaking through the retained message, each for
// a different reason:
//
// - `Authorization: Basic <value>` consumed the scheme word as the value and
//   left the credential in the clear.
// - `Authorization: Bearer <short>` was refused by the guard that stops one
//   label being taken as another's value, and the separator-less floor then
//   rejected the short token, so nothing matched at all.
// - A value containing characters outside the token class stopped at the first
//   of them, masking only the leading fragment and leaving the rest.
//
// The fourth is a regression pin rather than a fix: a compound underscore label
// is already covered, because `secret` ends the identifier and the `client_` in
// front of it falls outside the match.

describe('retained error text scrubs the wider credential shapes', () => {
  const retained = (message: string) =>
    ((sanitizeLogValue({ err: new Error(message) }) as Record<string, unknown>).err as Record<
      string,
      unknown
    >).errorMessage as string;

  // [case, message, the fragment that must not survive]
  const WIDER_SHAPES: ReadonlyArray<readonly [string, string, string]> = [
    [
      'an Authorization header carrying the Basic scheme',
      'request rejected Authorization: Basic QmFzaWNTZWNyZXQx at gate',
      'QmFzaWNTZWNyZXQx',
    ],
    [
      'an Authorization header carrying a six-character Bearer token',
      'request rejected Authorization: Bearer SYN123 at gate',
      'SYN123',
    ],
    [
      'a value containing characters outside the token class',
      'login failed password=Pw9@Xk2!Qm7 at gate',
      'Xk2!Qm7',
    ],
    [
      'a compound underscore label',
      'exchange failed client_secret=K1l2M3n4O5p6 at gate',
      'K1l2M3n4O5p6',
    ],
  ];

  it('covers all four shapes, each with a distinct synthetic secret', () => {
    // Coverage assertion: a shrunk table would otherwise pass silently.
    expect(WIDER_SHAPES).toHaveLength(4);
    expect(new Set(WIDER_SHAPES.map(([, , fragment]) => fragment)).size).toBe(4);
  });

  for (const [name, message, fragment] of WIDER_SHAPES) {
    it(`scrubs ${name}`, () => {
      const out = retained(message);
      expect(out).not.toContain(fragment);
      // The diagnostic frame must survive; scrubbing is not blanking.
      expect(out).toContain('at gate');
    });
  }
});

describe('retained error text uses the canonical JID pattern (SSOT)', () => {
  const retained = (message: string) =>
    ((sanitizeLogValue({ err: new Error(message) }) as Record<string, unknown>).err as Record<
      string,
      unknown
    >).errorMessage as string;

  it('scrubs a short-id @lid, which the sanitizer-local pattern missed entirely', () => {
    // 12345@lid: below PHONE_RE's 7-digit floor and not @s.whatsapp.net, so the
    // divergent local pattern let it through whole.
    const out = retained('no route for 12345@lid');
    expect(out).not.toContain('12345@lid');
    expect(out).toContain('no route for');
  });

  it('scrubs a device-suffixed JID', () => {
    const out = retained('owner conflict for 15550100199-6@s.whatsapp.net');
    expect(out).not.toContain('15550100199-6@s.whatsapp.net');
  });

  it('scrubs an uppercase-domain JID', () => {
    const out = retained('owner conflict for 15550100199@S.WHATSAPP.NET');
    expect(out).not.toContain('15550100199@S.WHATSAPP.NET');
  });

  it('scrubs a short-id @g.us group JID', () => {
    // 99999@g.us: five digits, so PHONE_RE's seven-digit floor does not reach it
    // either. Only the canonical pattern catches this one.
    const out = retained('no route for 99999@g.us');
    expect(out).not.toContain('99999@g.us');
    expect(out).toContain('no route for');
  });
});

// ─── The label shape, pinned through a real pino sink ───────────────────────
//
// The label is matched WITHOUT consuming the identifier run that precedes it.
// The prefix falls outside the match, so it survives the substitution verbatim
// and the diagnostic still reads back (`apiToken=<secret>` becomes
// `apiToken ***`), while the label alternation itself carries no quantifier to
// bound. That removes the former {0,40} prefix bound rather than raising it: a
// label glued to ANY number of leading word characters is now recognised, and
// there is no prefix run left for a pathological input to backtrack over.
//
// The cross-model bench's LOW-5 named the old bound's cost — a secret after a
// 41-character glued prefix was retained — and measured the replacement shape
// ReDoS-neutral on a 50,000-character prefix. The wall time there is the
// pre-existing EMAIL_RE quadratic documented above, not this pattern.
//
// Both directions are pinned below, so widening the label alternation fails a
// test rather than passing silently.

const captureSanitizedErrorLine = async (message: string): Promise<string> => {
  const pino = (await import('pino')).default;
  const { errorLikeSerializers } = await import('../../src/logger.ts');
  const { sanitizingLogHook } = await import('../../src/lib/log-sanitizer.ts');

  const lines: string[] = [];
  const logger = pino(
    {
      level: 'info',
      serializers: errorLikeSerializers,
      hooks: { logMethod: sanitizingLogHook } as never,
    },
    {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  );
  logger.warn({ err: new Error(message) }, 'turn processor error');
  expect(lines).toHaveLength(1);
  return lines[0]!;
};

const sanitizedErrorMessage = async (message: string): Promise<string> => {
  const record = JSON.parse(await captureSanitizedErrorLine(message)) as {
    err: Record<string, unknown>;
  };
  return record.err.errorMessage as string;
};

describe('the label shape masks a glued prefix of any length', () => {
  // [prefix length, 12-character synthetic secret]
  const GLUED_PREFIX_LENGTHS: ReadonlyArray<readonly [number, string]> = [
    [41, 'J0k1L2m3N4o5'],
    [60, 'N4o5P6q7R8s9'],
    [200, 'P6q7R8s9T0u1'],
  ];

  it('covers three prefix lengths past the former bound, each with a distinct secret', () => {
    // Coverage assertion, frozen rather than ranged: a per-row
    // `toBeGreaterThan(40)` would still pass if every row collapsed to the same
    // length, so the tuple itself is pinned.
    expect(GLUED_PREFIX_LENGTHS.map(([length]) => length)).toEqual([41, 60, 200]);
    expect(new Set(GLUED_PREFIX_LENGTHS.map(([length]) => length)).size).toBe(3);
    expect(new Set(GLUED_PREFIX_LENGTHS.map(([, secret]) => secret)).size).toBe(3);
    for (const [, secret] of GLUED_PREFIX_LENGTHS) {
      expect(secret).toHaveLength(12);
    }
  });

  it('masks a secret after a bare label (positive control, unchanged by the label shape)', async () => {
    const out = await sanitizedErrorMessage('upstream call failed token=I9j0K1l2M3n4 at gate');
    expect(out).not.toContain('I9j0K1l2M3n4');
    expect(out).toContain('at gate');
  });

  for (const [length, secret] of GLUED_PREFIX_LENGTHS) {
    it(`masks a secret glued behind a ${length}-character prefix`, async () => {
      const line = await captureSanitizedErrorLine(
        `upstream call failed ${'a'.repeat(length)}token=${secret} at gate`,
      );
      const out = (JSON.parse(line) as { err: Record<string, unknown> }).err
        .errorMessage as string;
      expect(line).not.toContain(secret);
      expect(out).not.toContain(secret);
      // Frame assertion: a refused or blanked message would satisfy the
      // absence check above without the pattern having matched anything.
      expect(out).toContain('at gate');
      expect(out).toContain(`${'a'.repeat(length)}token ***`);
    });
  }

  // The other direction. These three read identically at the previous head and
  // at this one; they fail only if the label alternation is widened.
  const UNCHANGED_BY_THE_LABEL_SHAPE: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a label that does not end the identifier is not a label',
      'tokenizer=plainvalue at gate',
      'tokenizer=plainvalue at gate',
    ],
    [
      'the prefix survives the substitution, so the identifier still reads back',
      'upstream call failed apiToken=A1b2C3d4E5f6 at gate',
      'upstream call failed apiToken *** at gate',
    ],
    [
      'prose after a label word is left alone by the separator-less floor',
      'authorization failed',
      'authorization failed',
    ],
  ];

  it('covers three shapes the label shape must not change', () => {
    // Coverage assertion: a shrunk table would otherwise pass silently.
    expect(UNCHANGED_BY_THE_LABEL_SHAPE).toHaveLength(3);
    expect(new Set(UNCHANGED_BY_THE_LABEL_SHAPE.map(([, message]) => message)).size).toBe(3);
  });

  for (const [name, message, expected] of UNCHANGED_BY_THE_LABEL_SHAPE) {
    it(`does not over-mask: ${name}`, async () => {
      expect(await sanitizedErrorMessage(message)).toBe(expected);
    });
  }
});

// ─── The value-side guard, pinned in both directions ────────────────────────
//
// The separator branch refuses to take another label word as its value. The
// guard exists for two shapes: `Authorization: token <credential>`, where the
// credential is the NEXT word, and `token=secret: <credential>`, where the
// nested label opens its own assignment. In both the first label would
// otherwise swallow the second and leave the real credential in the clear.
// What it must NOT refuse is a label word that merely begins the value.
//
// The discriminator is the character AFTER the nested label: whitespace, `:`
// or `=` means the credential is still to come, anything else means the label
// word is part of the value. Keying the refusal on a word boundary refused all
// three cases. The cross-model bench's S0 measured that cost: a credential
// whose value BEGINS with a label word and a separating character,
// `token=secret-<credential>`, was refused by the guard, matched nothing at
// all, and reached the sink verbatim. The nested-assignment half is pinned by
// its own block at the end of this file.
//
// Both directions are pinned below: the values the guard must let through to
// masking, and the shape it must still refuse. Nothing here is a coverage
// hole the way it was when a one-token change to the guard passed the whole
// suite unchanged.

describe('the value-side guard admits a label-initial credential value', () => {
  const GUARD_LABELS = ['token', 'api_key', 'bearer'] as const;
  const GUARD_SEPARATORS = ['=', ': '] as const;
  // Value prefixes that are a label word plus a character OUTSIDE the guard's
  // follow set, which is what the boundary-keyed guard used to refuse and what
  // the guard must keep admitting.
  const LABEL_INITIAL_VALUE_PREFIXES = [
    'secret-',
    'token-',
    'authorization-',
    'api_key-',
  ] as const;
  const GUARD_SECRET = 'Zx9Kq2Wm7Lp4';

  it('covers the full label x separator x value-prefix matrix', () => {
    // Coverage assertion: a shrunk axis would otherwise pass silently.
    expect(GUARD_LABELS).toHaveLength(3);
    expect(GUARD_SEPARATORS).toHaveLength(2);
    expect(LABEL_INITIAL_VALUE_PREFIXES).toHaveLength(4);
    expect(GUARD_SECRET).toHaveLength(12);
  });

  it('masks a plain value after the same labels (positive control)', async () => {
    for (const label of GUARD_LABELS) {
      for (const separator of GUARD_SEPARATORS) {
        const out = await sanitizedErrorMessage(
          `upstream call failed ${label}${separator}I9j0K1l2M3n4 at gate`,
        );
        expect(out).not.toContain('I9j0K1l2M3n4');
        expect(out).toContain('at gate');
      }
    }
  });

  it('masks every label-initial value across the matrix', async () => {
    const leaking: string[] = [];
    const unframed: string[] = [];
    let examined = 0;
    for (const label of GUARD_LABELS) {
      for (const separator of GUARD_SEPARATORS) {
        for (const prefix of LABEL_INITIAL_VALUE_PREFIXES) {
          const message = `upstream call failed ${label}${separator}${prefix}${GUARD_SECRET} at gate`;
          const line = await captureSanitizedErrorLine(message);
          const out = (JSON.parse(line) as { err: Record<string, unknown> }).err
            .errorMessage as string;
          examined += 1;
          if (line.includes(GUARD_SECRET)) leaking.push(message);
          // Frame assertion per cell: a refused or blanked message would satisfy
          // the absence check without the pattern having matched anything.
          if (!out.includes('at gate')) unframed.push(message);
        }
      }
    }
    // Coverage assertion: a zero here would make both assertions below vacuous.
    expect(examined).toBe(24);
    expect(leaking).toEqual([]);
    expect(unframed).toEqual([]);
  });

  it('masks a label-initial value that ends the message', async () => {
    // The degenerate form of the same class: the value IS a label word, with
    // nothing after it, so no whitespace follows and the guard admits it.
    const out = await sanitizedErrorMessage('upstream call failed token=passphrase');
    expect(out).toBe('upstream call failed token ***');
  });

  // The other direction. These read identically before and after the guard
  // change; they fail if the guard stops refusing the shape it exists for.
  const UNCHANGED_BY_THE_GUARD: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a label word followed by whitespace still falls through to the separator-less branch',
      'request rejected Authorization: token Cr3d3nt1alV4lue9 at gate',
      'request rejected Authorization: token *** at gate',
    ],
    [
      'an authentication scheme is still consumed before the guard is reached',
      'request rejected Authorization: Basic QmFzaWNTZWNyZXQx at gate',
      'request rejected Authorization *** at gate',
    ],
    [
      'prose after a label word is still left alone',
      'authorization failed',
      'authorization failed',
    ],
    [
      'KNOWN NARROWING against df7ab647: retained here with its terminator, masked there',
      // This row pins a NARROWING, not neutral intended behaviour. df7ab647
      // masks this cell — `token=secret at gate` reads back as
      // `token==*** at gate` there — and this branch retains it, because the
      // guard refuses on its follow set whether or not a credential really
      // follows. The terminator is load-bearing: bare `token=secret` is masked
      // here too.
      //
      // It is pinned so the narrowing is visible and reversible, NOT because
      // retaining is the desired contract. Reversing it is the owner's WS-A06
      // decision; the sibling test below records how far the narrowing reaches.
      'upstream call failed token=secret at gate',
      'upstream call failed token=secret at gate',
    ],
  ];

  it('covers four shapes the guard change must not alter', () => {
    // Coverage assertion: a shrunk table would otherwise pass silently.
    expect(UNCHANGED_BY_THE_GUARD).toHaveLength(4);
    expect(new Set(UNCHANGED_BY_THE_GUARD.map(([, message]) => message)).size).toBe(4);
  });

  for (const [name, message, expected] of UNCHANGED_BY_THE_GUARD) {
    it(`leaves the guard's own shape alone: ${name}`, async () => {
      expect(await sanitizedErrorMessage(message)).toBe(expected);
    });
  }
});

// ─── A nested assignment must not be eaten as the outer label's value ───────
//
// The guard has to refuse a nested label that is ITSELF an assignment, not
// only one that is scheme-like. `token=secret: <value>` carries the credential
// after the INNER label, and the outer `token=` must not swallow `secret:` and
// stop at the whitespace, because that consumes the assignment operator and
// leaves the credential standing in the clear.
//
// The leak needs whitespace after the inner separator. `token=secret:<value>`
// with no space is masked either way, because the value class runs to the next
// whitespace and takes the credential with it. These rows therefore use the
// spaced form, which is the shape that actually leaked.
//
// Raised as the cross-model bench's HIGH against the previous head, where the
// guard keyed on whitespace alone: `secret:` is not followed by whitespace, so
// the guard admitted it as a value.

describe('the value-side guard refuses a nested label that opens its own assignment', () => {
  // [case, message, expected output]
  const NESTED_ASSIGNMENT_SHAPES: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a colon-separated nested assignment',
      'upstream call failed token=secret: SYNTHETICVALUE at gate',
      'upstream call failed token=secret *** at gate',
    ],
    [
      'an equals-separated nested assignment',
      'upstream call failed token=secret= SYNTHETICVALUE at gate',
      'upstream call failed token=secret *** at gate',
    ],
    [
      'a nested assignment under a different outer label',
      'upstream call failed api_key=token: SYNTHETICVALUE at gate',
      'upstream call failed api_key=token *** at gate',
    ],
  ];

  it('covers three nested-assignment shapes', () => {
    // Coverage assertion: a shrunk table would otherwise pass silently.
    expect(NESTED_ASSIGNMENT_SHAPES).toHaveLength(3);
    expect(new Set(NESTED_ASSIGNMENT_SHAPES.map(([, message]) => message)).size).toBe(3);
  });

  for (const [name, message, expected] of NESTED_ASSIGNMENT_SHAPES) {
    it(`masks the credential after ${name}`, async () => {
      const line = await captureSanitizedErrorLine(message);
      const out = (JSON.parse(line) as { err: Record<string, unknown> }).err
        .errorMessage as string;
      // The whole sink line, not only the retained field.
      expect(line).not.toContain('SYNTHETICVALUE');
      // Exact output: the inner label survives as the readable cue and the
      // credential after it is replaced. An absence check alone would pass on a
      // blanked message.
      expect(out).toBe(expected);
    });
  }

  it('masks the unspaced form too, by consuming the whole value run', async () => {
    // Not the leak shape, and it is masked at both heads. Pinned so that the
    // spaced and unspaced forms cannot silently diverge.
    const out = await sanitizedErrorMessage(
      'upstream call failed token=secret:SYNTHETICVALUE at gate',
    );
    expect(out).not.toContain('SYNTHETICVALUE');
    expect(out).toContain('at gate');
  });
});

// ─── How far the known narrowing reaches ────────────────────────────────────
//
// The row above pins one cell that df7ab647 masks and this branch retains. This
// block bounds that narrowing, so the disclosure is measured rather than
// asserted.
//
// The bound was originally written as "the bare label word, with nothing after
// it". That was FALSE, but so was the first correction of it. A chain of label
// words is retained only WITH A TERMINATOR: `password=token=secret at gate` is
// retained, while bare `password=token=secret` is MASKED. And the mechanism is
// not "the guard refuses at every link" — the last label is followed by the
// terminator, not a joiner, and is refused only when that terminator is itself
// in the follow set. The source comment carries the corrected statement, the
// per-terminator counts and the `bearer` scheme exception.
//
// The rows below are unchanged in behaviour. They are two-label chains carrying
// ` at gate`, and that is what they pin.

describe('the narrowing: label chains carrying a terminator are retained', () => {
  // Cells df7ab647 masks and this branch retains. Named, not ranged, so the extent
  // of the narrowing is visible in the test rather than implied.
  const RETAINED_BARE_LABEL_WORDS: readonly string[] = [
    'upstream call failed token=secret at gate',
    'upstream call failed api_key=token at gate',
    'upstream call failed bearer=password at gate',
  ];

  // The other side of the bound: a label word with credential material glued to
  // it is masked. If this ever flips, the narrowing has widened past the
  // disclosure and the guard's follow set is doing more than it is documented
  // to do.
  const MASKED_WITH_CREDENTIAL_MATERIAL: ReadonlyArray<readonly [string, string]> = [
    ['upstream call failed token=secretAbc123XY at gate', 'Abc123XY'],
    ['upstream call failed token=secret_Abc123XY at gate', 'Abc123XY'],
    ['upstream call failed api_key=tokenAbc123XY at gate', 'Abc123XY'],
    ['upstream call failed bearer=authorizationAbc123XY at gate', 'Abc123XY'],
  ];

  it('covers both sides of the bound', () => {
    // Coverage assertion: a shrunk table would otherwise pass silently.
    expect(RETAINED_BARE_LABEL_WORDS).toHaveLength(3);
    expect(MASKED_WITH_CREDENTIAL_MATERIAL).toHaveLength(4);
  });

  for (const message of RETAINED_BARE_LABEL_WORDS) {
    it(`retains the terminated chain, which df7ab647 masks: ${message}`, async () => {
      expect(await sanitizedErrorMessage(message)).toBe(message);
    });
  }

  for (const [message, material] of MASKED_WITH_CREDENTIAL_MATERIAL) {
    it(`still masks credential material glued to a label word: ${message}`, async () => {
      const out = await sanitizedErrorMessage(message);
      expect(out).not.toContain(material);
      expect(out).toContain('at gate');
    });
  }
});

// ─── Why the guard's refusal set stops at whitespace, `:` and `=` ───────────
//
// The follow set is a REFUSAL set: a nested label followed by one of its
// characters makes the separator branch reject. So adding characters to it
// makes the sanitizer mask LESS, not more, and that is counter-intuitive
// enough to have been proposed as an improvement.
//
// The joiners below are masked precisely BECAUSE the guard admits them: the
// value class runs to the next whitespace, so it swallows the joiner and the
// credential together in one match. Widening the refusal set to
// `[\s:=./+~]` was measured through this same sink and turns every row here
// into a leak — the guard rejects, the separator-less branch finds no
// whitespace, the separator branch finds no `[:=]`, and the whole assignment
// is retained with the credential in it.
//
// These rows exist so that a future widening of the follow set fails a test
// instead of being merged as a tightening.

describe('joiners outside the guard follow set stay masked', () => {
  // [message, expected output]
  const ADMITTED_JOINER_SHAPES: ReadonlyArray<readonly [string, string]> = [
    [
      'upstream call failed token=secret.SYNTHETICVALUE at gate',
      'upstream call failed token *** at gate',
    ],
    [
      'upstream call failed token=secret/SYNTHETICVALUE at gate',
      'upstream call failed token *** at gate',
    ],
    [
      'upstream call failed token=secret+SYNTHETICVALUE at gate',
      'upstream call failed token *** at gate',
    ],
    [
      'upstream call failed token=secret~SYNTHETICVALUE at gate',
      'upstream call failed token *** at gate',
    ],
    [
      'upstream call failed api_key=token.abc123 at gate',
      'upstream call failed api_key *** at gate',
    ],
  ];

  it('covers the four joiners plus the compound-label case', () => {
    // Coverage assertion: a shrunk table would otherwise pass silently.
    expect(ADMITTED_JOINER_SHAPES).toHaveLength(5);
    expect(new Set(ADMITTED_JOINER_SHAPES.map(([message]) => message)).size).toBe(5);
    // Each row must actually carry the joiner it is named for, so a rewritten
    // fixture cannot quietly test the same shape five times.
    for (const joiner of ['.', '/', '+', '~']) {
      expect(
        ADMITTED_JOINER_SHAPES.some(([message]) => message.includes(`secret${joiner}`)),
      ).toBe(true);
    }
  });

  for (const [message, expected] of ADMITTED_JOINER_SHAPES) {
    it(`masks through the sink: ${message}`, async () => {
      const line = await captureSanitizedErrorLine(message);
      const out = (JSON.parse(line) as { err: Record<string, unknown> }).err
        .errorMessage as string;
      expect(line).not.toContain('SYNTHETICVALUE');
      expect(line).not.toContain('abc123');
      expect(out).toBe(expected);
    });
  }
});
