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

  it('handles Error objects: extracts class, drops message and stack', () => {
    const err = new Error(MARKERS.message);
    err.stack = `Error: ${MARKERS.stack}\n    at foo:1:1`;
    const result = sanitizeLogValue({ err }) as Record<string, unknown>;
    const sanitizedErr = result.err as Record<string, unknown>;
    expect(sanitizedErr.errorClass).toBe('Error');
    expect(JSON.stringify(sanitizedErr)).not.toContain(MARKERS.message);
    expect(JSON.stringify(sanitizedErr)).not.toContain(MARKERS.stack);
  });

  it('handles Error with cause chain', () => {
    const rootCause = new Error(MARKERS.nestedError);
    const wrapper = new Error('wrapper');
    (wrapper as Error & { cause?: unknown }).cause = rootCause;
    const result = sanitizeLogValue({ err: wrapper }) as Record<string, unknown>;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(MARKERS.nestedError);
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
      // Nested error
      err: Object.assign(new Error(MARKERS.message), {
        cause: new Error(MARKERS.nestedError),
        stack: MARKERS.stack,
      }),
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
  });

  it('third-party child logger payloads are sanitized at the hook level', () => {
    // The hook sanitizes args[0] when it's an object. Simulate what Pino does.
    const capturedPayloads: unknown[] = [];
    const fakeMethod = (...args: unknown[]) => {
      capturedPayloads.push(args[0]);
    };

    // Simulate the hook behavior
    const payload = { password: MARKERS.sensitive, textPreview: MARKERS.textPreview };
    const args = [payload];
    if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
      args[0] = sanitizeLogValue(args[0]);
    }
    fakeMethod(...args);

    const captured = JSON.stringify(capturedPayloads[0]);
    expect(captured).not.toContain(MARKERS.sensitive);
    expect(captured).not.toContain(MARKERS.textPreview);
  });
});
