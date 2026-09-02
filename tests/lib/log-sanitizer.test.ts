/**
 * WS-A06 metadata-only sink contract — real-sink negative canaries.
 *
 * These tests prove that the recursive pre-sink sanitizer strips sensitive
 * content from log payloads before they reach any Pino sink (stdout, file).
 *
 * Strategy: inject unique synthetic markers representing each content class
 * and assert they are ABSENT from captured output while safe event metadata
 * (event type, stage, counts) remains.
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
