import { describe, expect, it, vi } from 'vitest';
import {
  installThirdPartyConsoleRedaction,
  redactThirdPartyConsoleArgs,
  redactThirdPartyConsoleString,
  redactThirdPartyConsoleValue,
} from '../../src/transport/third-party-console-redaction.ts';

describe('third-party console redaction', () => {
  it('redacts libsignal session objects before console formatting can print key material', () => {
    class SessionEntry {
      _chains = {
        'base64-session-chain-key': {
          chainKey: Buffer.from('chain-secret'),
          messageKeys: { 1: Buffer.from('message-key') },
        },
      };
      indexInfo = {
        remoteIdentityKey: Buffer.from('identity-secret'),
        baseKey: Buffer.from('base-secret'),
      };
      currentRatchet = {
        ephemeralKeyPair: {
          pubKey: Buffer.from('public-material'),
          privKey: Buffer.from('private-material'),
        },
        rootKey: Buffer.from('root-secret'),
      };
    }

    const redacted = JSON.stringify(redactThirdPartyConsoleArgs(['Closing session:', new SessionEntry()]));

    expect(redacted).toContain('SessionEntry');
    expect(redacted).toContain('redacted');
    expect(redacted).not.toContain('identity-secret');
    expect(redacted).not.toContain('private-material');
    expect(redacted).not.toContain('remoteIdentityKey');
    expect(redacted).not.toContain('privKey');
    expect(redacted).not.toContain('<Buffer');
  });

  it('redacts plain-object sensitive fields and already-formatted buffer strings', () => {
    const redacted = JSON.stringify(redactThirdPartyConsoleArgs([{
      safe: 'Pre-key upload timeout',
      remoteIdentityKey: Buffer.from('identity-secret'),
      nested: {
        pubKey: Buffer.from('public-material'),
        text: 'session <Buffer 01 02 03> for 15555550123@s.whatsapp.net',
      },
    }]));

    expect(redacted).toContain('Pre-key upload timeout');
    expect(redacted).toContain('<redacted_sensitive_fields>');
    expect(redacted).not.toContain('identity-secret');
    expect(redacted).not.toContain('public-material');
    expect(redacted).not.toContain('remoteIdentityKey');
    expect(redacted).not.toContain('pubKey');
    expect(redacted).not.toContain('15555550123');
    expect(redacted).not.toContain('<Buffer 01 02 03>');
  });

  it('drops libsignal session dumps when installed', () => {
    const captured: unknown[][] = [];
    const target = {
      debug: vi.fn((...args: unknown[]) => captured.push(args)),
      error: vi.fn((...args: unknown[]) => captured.push(args)),
      info: vi.fn((...args: unknown[]) => captured.push(args)),
      log: vi.fn((...args: unknown[]) => captured.push(args)),
      warn: vi.fn((...args: unknown[]) => captured.push(args)),
    } as any;

    const originalInfo = target.info;

    installThirdPartyConsoleRedaction(target);
    installThirdPartyConsoleRedaction(target);
    target.info('Closing session:', { privKey: Buffer.from('private-material') });

    expect(originalInfo).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it('installs once and wraps console methods with redaction', () => {
    const captured: unknown[][] = [];
    const target = {
      debug: vi.fn((...args: unknown[]) => captured.push(args)),
      error: vi.fn((...args: unknown[]) => captured.push(args)),
      info: vi.fn((...args: unknown[]) => captured.push(args)),
      log: vi.fn((...args: unknown[]) => captured.push(args)),
      warn: vi.fn((...args: unknown[]) => captured.push(args)),
    } as any;

    const originalInfo = target.info;

    installThirdPartyConsoleRedaction(target);
    installThirdPartyConsoleRedaction(target);
    target.info('Pre-key upload failed', { privKey: Buffer.from('private-material') });

    expect(originalInfo).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    const rendered = JSON.stringify(captured);
    expect(rendered).toContain('<redacted_sensitive_fields>');
    expect(rendered).not.toContain('private-material');
    expect(rendered).not.toContain('privKey');
  });

  it('keeps non-secret diagnostics readable', () => {
    expect(redactThirdPartyConsoleString('Failed to check/upload pre-keys during initialization')).toBe(
      'Failed to check/upload pre-keys during initialization',
    );
  });

  it('redacts primitive, typed, error, and sensitive-key values', () => {
    const errorWithStack = new Error('failed token=visible-value');
    errorWithStack.stack = 'Error: failed authorization=visible-value\n    at fixture';
    const errorWithoutStack = new Error('plain failure');
    errorWithoutStack.stack = undefined;

    const redacted = redactThirdPartyConsoleValue({
      count: 1,
      empty: null,
      big: 10n,
      bytes: Buffer.from('buffer-material'),
      typed: new Uint8Array([1, 2, 3]),
      at: new Date('2026-06-13T00:00:00.000Z'),
      errorWithStack,
      errorWithoutStack,
    }) as Record<string, unknown>;

    expect(redacted.count).toBe(1);
    expect(redacted.empty).toBeNull();
    expect(redacted.big).toBe('10');
    expect(redacted.bytes).toBe('<Buffer redacted length=15>');
    expect(redacted.typed).toBe('<Uint8Array redacted length=3>');
    expect(redacted.at).toBe('2026-06-13T00:00:00.000Z');
    expect(redacted.errorWithStack).toMatchObject({
      type: 'Error',
      message: 'failed token=<redacted>',
      stack: 'Error: failed authorization=<redacted>\n    at fixture',
    });
    expect(redacted.errorWithoutStack).toMatchObject({
      type: 'Error',
      message: 'plain failure',
      stack: undefined,
    });
    expect(redactThirdPartyConsoleValue('visible-value', 'accessToken')).toBe('<redacted>');
  });

  it('bounds recursive traversal and reports truncation without leaking sensitive data', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const shortArray = [1, 'safe'];
    const longArray = Array.from({ length: 31 }, (_item, index) => index);
    const longObject = Object.fromEntries(Array.from({ length: 41 }, (_item, index) => [`k${index}`, index]));
    const objectNamedObject = Object.create({});

    const redactedCircular = redactThirdPartyConsoleValue(circular) as Record<string, unknown>;
    const redactedDeep = redactThirdPartyConsoleValue(deep) as { a: { b: { c: { d: { e: unknown } } } } };
    const redactedShortArray = redactThirdPartyConsoleValue(shortArray) as unknown[];
    const redactedArray = redactThirdPartyConsoleValue(longArray) as unknown[];
    const redactedLongObject = redactThirdPartyConsoleValue(longObject) as Record<string, unknown>;

    expect(redactedCircular.self).toBe('<circular>');
    expect(redactedDeep.a.b.c.d.e).toBe('<max-depth>');
    expect(redactedShortArray).toEqual([1, 'safe']);
    expect(redactedArray).toHaveLength(31);
    expect(redactedArray.at(-1)).toBe('<truncated:1>');
    expect(Object.keys(redactedLongObject).filter(key => key.startsWith('k'))).toHaveLength(40);
    expect(redactedLongObject['<truncated_keys>']).toBe(1);
    expect(redactThirdPartyConsoleValue(objectNamedObject)).toEqual({ type: 'Object', redacted: true });
  });
});
