import { describe, expect, it } from 'vitest';

describe('resolveSignalConfig', () => {
  it('defaults polling fields for an explicit UNIX socket configuration', async () => {
    const { resolveSignalConfig } = await import('../src/config.ts');
    expect(resolveSignalConfig({
      account: 'ops',
      phoneNumber: '+15551110000',
      socketPath: '/run/user/1000/whatsoup/signal.sock',
    })).toEqual({
      account: 'ops',
      phoneNumber: '+15551110000',
      socketPath: '/run/user/1000/whatsoup/signal.sock',
      inboundMode: 'poll',
      pollIntervalMs: 15000,
      rateLimit: { messagesPerMinute: 30 },
    });
  });

  it('preserves a TCP endpoint without injecting the default socket path', async () => {
    const { resolveSignalConfig } = await import('../src/config.ts');
    expect(resolveSignalConfig({
      account: 'ops',
      phoneNumber: '+15551110000',
      tcpHost: '127.0.0.1',
      tcpPort: 7583,
    })).toMatchObject({ tcpHost: '127.0.0.1', tcpPort: 7583 });
    expect(resolveSignalConfig({
      account: 'ops',
      phoneNumber: '+15551110000',
      tcpPort: 7583,
    })).not.toHaveProperty('socketPath');
  });

  it('throws instead of silently coercing stream mode to poll', async () => {
    const { resolveSignalConfig } = await import('../src/config.ts');
    expect(() => resolveSignalConfig({
      account: 'ops',
      phoneNumber: '+15551110000',
      inboundMode: 'stream',
    })).toThrow(/streaming is not implemented/);
  });

  it('rejects ambiguous or incomplete endpoints on direct resolution paths', async () => {
    const { resolveSignalConfig } = await import('../src/config.ts');
    expect(() => resolveSignalConfig({
      account: 'ops',
      phoneNumber: '+15551110000',
      socketPath: '/tmp/signalc.sock',
      tcpPort: 7583,
    })).toThrow(/exactly one/);
    expect(() => resolveSignalConfig({
      account: 'ops',
      phoneNumber: '+15551110000',
      tcpHost: '127.0.0.2',
    })).toThrow(/requires tcpPort/);
    expect(() => resolveSignalConfig({
      account: 'ops',
      phoneNumber: '+15551110000',
    })).toThrow(/exactly one/);
    expect(() => resolveSignalConfig({
      account: 'ops',
      phoneNumber: '+15551110000',
      tcpHost: '192.0.2.10',
      tcpPort: 7583,
    })).toThrow(/loopback/);
    expect(() => resolveSignalConfig({
      account: 'ops',
      phoneNumber: '+15551110000',
      socketPath: 'relative/signal.sock',
    })).toThrow(/absolute/);
    expect(() => resolveSignalConfig({
      account: 'ops',
      phoneNumber: '+15551110000',
      socketPath: '/tmp/signalc.sock',
      pollIntervalMs: 1.5,
    })).toThrow(/timer integer/);
  });
});

describe('resolveImessageConfig', () => {
  it('keeps only fields belonging to the selected backend', async () => {
    const { resolveImessageConfig } = await import('../src/config.ts');
    expect(resolveImessageConfig({
      account: 'ops',
      backend: 'bluebubbles',
      sender: 'owner@example.com',
      bluebubblesUrl: 'https://messages.example.test',
      bluebubblesPasswordService: 'whatsoup-bluebubbles-ops',
    })).toEqual({
      account: 'ops',
      backend: 'bluebubbles',
      sender: 'owner@example.com',
      bluebubblesUrl: 'https://messages.example.test',
      bluebubblesPasswordService: 'whatsoup-bluebubbles-ops',
      inboundMode: 'poll',
      pollIntervalMs: 15_000,
      rateLimit: { messagesPerMinute: 30 },
    });
  });

  it.each([
    [{ account: 'ops', backend: 'not-a-backend', sender: 'owner@example.com' }, /backend/i],
    [{ account: 'ops', backend: 'imsg', sender: 'Owner@Example.com' }, /lowercase AppleID/i],
    [{ account: 'ops', backend: 'imsg', sender: 'owner\u0007@example.com' }, /AppleID/i],
    [{ account: 'ops', backend: 'imsg', sender: 'owner\u202E@example.com' }, /AppleID/i],
    [{ account: 'ops', backend: 'imsg', sender: 'owner\u200B@example.com' }, /AppleID/i],
    [{ account: 'ops', backend: 'imsg', sender: 'owner\u2028@example.com' }, /AppleID/i],
    [{
      account: 'ops',
      backend: 'imsg',
      sender: 'owner@example.com',
      bluebubblesUrl: 'https://messages.example.test',
    }, /bluebubblesUrl/i],
    [{
      account: 'ops',
      backend: 'bluebubbles',
      sender: 'owner@example.com',
      bluebubblesUrl: 'https://messages.example.test',
      bluebubblesPasswordService: 'whatsoup-bluebubbles-ops',
      imsgSocketPath: '/tmp/imsg.sock',
    }, /imsgSocketPath/i],
  ])('fails closed on noncanonical direct iMessage resolution: %#', async (raw, expected) => {
    const { resolveImessageConfig } = await import('../src/config.ts');
    expect(() => resolveImessageConfig(raw)).toThrow(expected);
  });

  it('rejects unimplemented webhook mode during direct resolution', async () => {
    const { resolveImessageConfig } = await import('../src/config.ts');
    expect(() => resolveImessageConfig({
      account: 'ops',
      backend: 'bluebubbles',
      sender: 'owner@example.com',
      inboundMode: 'webhook',
    })).toThrow(/only "poll".*not implemented/i);
  });
});

describe('resolveAdminIdentities', () => {
  it('preserves Signal UUIDs and canonicalizes Signal phone identities as +E.164', async () => {
    const { resolveAdminIdentities } = await import('../src/config.ts');
    expect(resolveAdminIdentities([
      '01234567-89ab-cdef-0123-456789abcdef',
      '+1 (555) 111-0000',
      '15552220000',
    ], 'signal')).toEqual([
      '01234567-89ab-cdef-0123-456789abcdef',
      '+15551110000',
      '+15552220000',
    ]);
  });

  it('rejects an invalid Signal admin identity instead of storing a broken route', async () => {
    const { resolveAdminIdentities } = await import('../src/config.ts');
    for (const invalid of [
      'not-a-signal-identity',
      'oops15551234567wrong',
    ]) {
      expect(() => resolveAdminIdentities([invalid], 'signal'))
        .toThrow(/Signal admin identity/);
    }
  });

  it('preserves lowercase AppleID emails and canonicalizes iMessage phones as +E.164', async () => {
    const { resolveAdminIdentities } = await import('../src/config.ts');
    expect(resolveAdminIdentities([
      ' Owner@Example.COM ',
      '+1 (555) 111-0000',
    ], 'imessage')).toEqual([
      'owner@example.com',
      '+15551110000',
    ]);
  });

});
