// tests/transport/imessage/types.test.ts
// Type-shape conformance for the iMessage transport config + defaults.
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  E164_RE,
  APPLEID_EMAIL_RE,
  DEFAULT_IMESSAGE,
  type ImessageConfig,
  type ImessageBackend,
  type ImessageInboundMode,
} from '../../../src/transport/imessage/types.ts';

describe('imessage transport — types', () => {
  it('E164_RE accepts canonical E.164 numbers', () => {
    expect(E164_RE.test('+15551234567')).toBe(true);
    expect(E164_RE.test('+447911123456')).toBe(true);
    expect(E164_RE.test('15551234567')).toBe(false);
    expect(E164_RE.test('')).toBe(false);
  });

  it('APPLEID_EMAIL_RE accepts common email shapes and rejects garbage', () => {
    expect(APPLEID_EMAIL_RE.test('user@icloud.com')).toBe(true);
    expect(APPLEID_EMAIL_RE.test('name.example@me.com')).toBe(true);
    expect(APPLEID_EMAIL_RE.test('+15551234567')).toBe(false);  // not an email
    expect(APPLEID_EMAIL_RE.test('not-an-email')).toBe(false);
    expect(APPLEID_EMAIL_RE.test('missing@tld')).toBe(false);
    expect(APPLEID_EMAIL_RE.test('')).toBe(false);
  });

  it('DEFAULT_IMESSAGE is frozen with documented defaults', () => {
    expect(Object.isFrozen(DEFAULT_IMESSAGE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_IMESSAGE.rateLimit)).toBe(true);
    expect(DEFAULT_IMESSAGE.backend).toBe('bluebubbles');
    expect(DEFAULT_IMESSAGE.imsgSocketPath).toBe('/tmp/imsg.sock');
    expect(DEFAULT_IMESSAGE.inboundMode).toBe('poll');
    expect(DEFAULT_IMESSAGE.pollIntervalMs).toBe(15000);
    expect(DEFAULT_IMESSAGE.rateLimit.messagesPerMinute).toBe(30);
  });

  it('ImessageBackend admits exactly the two documented backends', () => {
    const a: ImessageBackend = 'imsg';
    const b: ImessageBackend = 'bluebubbles';
    expect([a, b]).toEqual(['imsg', 'bluebubbles']);
  });

  it('ImessageInboundMode admits only the implemented poll mode', () => {
    const mode: ImessageInboundMode = 'poll';
    expect(mode).toBe('poll');
    expectTypeOf<ImessageInboundMode>().toEqualTypeOf<'poll'>();
  });

  it('a fully-populated bluebubbles ImessageConfig satisfies the type', () => {
    const cfg: ImessageConfig = {
      account: 'mac-mini',
      backend: 'bluebubbles',
      bluebubblesUrl: 'https://bb.example.test',
      bluebubblesPasswordService: 'whatsoup-bluebubbles-mac-mini',
      sender: 'bot@icloud.com',
      inboundMode: 'poll',
      pollIntervalMs: 10000,
      rateLimit: { messagesPerMinute: 20 },
    };
    expect(cfg.account).toBe('mac-mini');
  });

  it('a fully-populated imsg ImessageConfig satisfies the type', () => {
    const cfg: ImessageConfig = {
      account: 'mac-mini',
      backend: 'imsg',
      imsgSocketPath: '/tmp/imsg.sock',
      sender: 'bot@icloud.com',
      inboundMode: 'poll',
      pollIntervalMs: 10000,
      rateLimit: { messagesPerMinute: 20 },
    };
    expect(cfg.backend).toBe('imsg');
  });
});
