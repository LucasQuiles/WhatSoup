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

  it('redacts scalar, binary, date, and error values without losing diagnostic shape', () => {
    expect(redactThirdPartyConsoleValue('api_key=live-secret')).toBe('api_key=<redacted>');
    expect(redactThirdPartyConsoleValue(42n)).toBe('42');
    expect(redactThirdPartyConsoleValue(null)).toBeNull();
    expect(redactThirdPartyConsoleValue(false)).toBe(false);
    expect(redactThirdPartyConsoleValue('raw-secret', 'accessToken')).toBe('<redacted>');
    expect(redactThirdPartyConsoleValue(Buffer.from('private-material'))).toBe('<Buffer redacted length=16>');
    expect(redactThirdPartyConsoleValue(new Uint8Array([1, 2, 3, 4]))).toBe('<Uint8Array redacted length=4>');
    expect(redactThirdPartyConsoleValue(new Date('2026-06-15T20:00:00.000Z'))).toBe('2026-06-15T20:00:00.000Z');

    const withoutStack = new TypeError('password=super-secret');
    withoutStack.stack = undefined;
    expect(redactThirdPartyConsoleValue(withoutStack)).toEqual({
      type: 'TypeError',
      message: 'password=<redacted>',
      stack: undefined,
    });

    const withStack = new Error('token=super-secret');
    withStack.stack = 'Error: token=super-secret\n    at 15555550123@s.whatsapp.net';
    const redactedError = JSON.stringify(redactThirdPartyConsoleValue(withStack));
    expect(redactedError).toContain('Error');
    expect(redactedError).toContain('token=<redacted>');
    expect(redactedError).toContain('<jid:redacted>');
    expect(redactedError).not.toContain('super-secret');
    expect(redactedError).not.toContain('15555550123');
  });

  it('bounds recursive data structures while preserving useful non-secret context', () => {
    const circular: Record<string, unknown> = { safe: 'visible' };
    circular['self'] = circular;
    expect(redactThirdPartyConsoleValue(circular)).toEqual({
      safe: 'visible',
      self: '<circular>',
    });

    expect(redactThirdPartyConsoleValue(['visible', { token: 'array-secret' }])).toEqual([
      'visible',
      { '<redacted_sensitive_fields>': 1 },
    ]);

    const deep = { a: { b: { c: { d: { e: { token: 'deep-secret' } } } } } };
    expect(redactThirdPartyConsoleValue(deep)).toEqual({
      a: { b: { c: { d: { e: '<max-depth>' } } } },
    });

    const longArray = Array.from({ length: 32 }, (_, index) => `item-${index}`);
    const redactedArray = redactThirdPartyConsoleValue(longArray);
    expect(redactedArray).toHaveLength(31);
    expect(redactedArray).toContain('item-0');
    expect(redactedArray).toContain('<truncated:2>');

    const manyKeys = Object.fromEntries(Array.from({ length: 42 }, (_, index) => [`field${index}`, index]));
    const redactedObject = redactThirdPartyConsoleValue(manyKeys) as Record<string, unknown>;
    expect(Object.keys(redactedObject)).toHaveLength(41);
    expect(redactedObject['field0']).toBe(0);
    expect(redactedObject['<truncated_keys>']).toBe(2);
  });

  it('redacts non-plain objects without relying on prototype data', () => {
    class CustomDiagnostic {
      visible = 'metadata';
      token = 'super-secret';
    }

    expect(redactThirdPartyConsoleValue(new CustomDiagnostic())).toEqual({
      type: 'CustomDiagnostic',
      redacted: true,
    });

    const objectNamedPrototype = Object.create({ inherited: 'prototype-value' });
    objectNamedPrototype.visible = 'metadata';

    expect(redactThirdPartyConsoleValue(objectNamedPrototype)).toEqual({
      type: 'Object',
      redacted: true,
    });
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

  it('drops every known libsignal session dump prefix but passes ordinary diagnostics', () => {
    const captured: unknown[][] = [];
    const target = {
      debug: vi.fn((...args: unknown[]) => captured.push(args)),
      error: vi.fn((...args: unknown[]) => captured.push(args)),
      info: vi.fn((...args: unknown[]) => captured.push(args)),
      log: vi.fn((...args: unknown[]) => captured.push(args)),
      warn: vi.fn((...args: unknown[]) => captured.push(args)),
    } as any;

    installThirdPartyConsoleRedaction(target);

    for (const prefix of [
      'Closing session:',
      'Removing old closed session:',
      'Opening session:',
      'Migrating session to:',
      'Session already closed',
      'Session already open',
    ]) {
      target.warn(prefix, { privKey: Buffer.from('private-material') });
    }

    target.warn({ event: 'non-string-first-arg', privKey: Buffer.from('private-material') });
    target.warn('ordinary diagnostic', { token: 'super-secret', safe: 'visible' });

    expect(captured).toHaveLength(2);
    const rendered = JSON.stringify(captured);
    expect(rendered).toContain('non-string-first-arg');
    expect(rendered).toContain('ordinary diagnostic');
    expect(rendered).toContain('visible');
    expect(rendered).toContain('<redacted_sensitive_fields>');
    expect(rendered).not.toContain('private-material');
    expect(rendered).not.toContain('super-secret');
    expect(rendered).not.toContain('privKey');
    expect(rendered).not.toContain('token');
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

describe('third-party console redaction — compound/camelCase secret keys (QR-080)', () => {
  // Fixture VALUES carry an `example` marker so the repo-hygiene secret-assignment
  // guard treats them as obvious non-secrets; still 8+ char single tokens so the
  // redactor's value match fires.
  const LEAKED_BEFORE: Array<[string, string]> = [
    ['AWS multi-underscore', 'AWS_SESSION_TOKEN=exampleAwsSessionTokenValue01'],
    ['camelCase session', 'sessionToken=exampleSessionTokenValue02'],
    ['camelCase bearer', 'bearerToken=exampleBearerTokenValue03'],
    ['aws secret access key', 'aws_secret_access_key=exampleAwsSecretAccessKey04'],
    ['oauth client secret', 'client_secret=exampleClientSecretValue05'],
  ];
  it.each(LEAKED_BEFORE)('redacts compound/camelCase secret in free-text: %s', (_l, input) => {
    const out = redactThirdPartyConsoleString(input);
    expect(out).toContain('<redacted>');
    expect(out).not.toContain(input.split('=')[1]);
  });
  it('still redacts the original keys (no regression)', () => {
    expect(redactThirdPartyConsoleString('token=exampleBareTokenValue06')).toContain('<redacted>');
    expect(redactThirdPartyConsoleString('access_token=exampleAccessTokenValue07')).toContain('<redacted>');
  });
  it.each(['retry_count=12345678', 'patch=v2'])(
    'does not over-redact benign text: %s',
    (input) => { expect(redactThirdPartyConsoleString(input)).toBe(input); },
  );
});
