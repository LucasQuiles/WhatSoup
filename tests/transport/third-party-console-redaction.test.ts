import { describe, expect, it, vi } from 'vitest';
import {
  installThirdPartyConsoleRedaction,
  redactThirdPartyConsoleArgs,
  redactThirdPartyConsoleString,
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
});
