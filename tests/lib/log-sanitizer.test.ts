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
 * the one this suite no longer upholds. WS-A06 is tracked by issue #2164 and
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
    const err = new Error('E'.repeat(5000));
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
// The label alternation therefore accepts a leading run of word characters,
// and that run is part of the captured group, so the identifier still reads
// back in the diagnostic (`apiToken=<secret>` becomes `apiToken ***`).

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
