import { describe, it, expect } from 'vitest';
import { assertOutboundIdentity } from '../../../src/core/outbound-identity/guard.ts';
import type { IdentityStore } from '../../../src/core/outbound-identity/types.ts';

/** In-memory fake — exercises the pure decision logic without a DB. */
function fakeStore(over: Partial<IdentityStore> = {}): IdentityStore {
  return {
    resolveLid: () => null,
    isWarm: () => false,
    isApprovedGroup: () => true,
    ...over,
  };
}

describe('assertOutboundIdentity — cold floor', () => {
  it('log-only: cold @lid target → warn/COLD_TARGET (send still allowed)', () => {
    const store = fakeStore({ resolveLid: () => '15550009999@s.whatsapp.net', isWarm: () => false });
    const d = assertOutboundIdentity('11111110000402@lid', { caller: 'mcp', mode: 'log-only' }, store);
    expect(d).toEqual({ verdict: 'warn', code: 'COLD_TARGET', reason: expect.any(String) });
  });

  it('enforce: cold @lid target → block/COLD_TARGET', () => {
    const store = fakeStore({ resolveLid: () => '15550009999@s.whatsapp.net', isWarm: () => false });
    const d = assertOutboundIdentity('11111110000402@lid', { caller: 'mcp', mode: 'enforce' }, store);
    expect(d).toEqual({ verdict: 'block', code: 'COLD_TARGET', reason: expect.any(String) });
  });

  it('warm contact → allow', () => {
    const store = fakeStore({ isWarm: () => true });
    const d = assertOutboundIdentity('15550001111@s.whatsapp.net', { caller: 'mcp', mode: 'enforce' }, store);
    expect(d).toEqual({ verdict: 'allow' });
  });

  it('enforce: unresolvable @lid → block/AMBIGUOUS', () => {
    const store = fakeStore({ resolveLid: () => null });
    const d = assertOutboundIdentity('11111119999999@lid', { caller: 'mcp', mode: 'enforce' }, store);
    expect(d).toEqual({ verdict: 'block', code: 'AMBIGUOUS', reason: expect.any(String) });
  });

  it('log-only: unresolvable @lid → warn/AMBIGUOUS', () => {
    const store = fakeStore({ resolveLid: () => null });
    const d = assertOutboundIdentity('11111119999999@lid', { caller: 'mcp', mode: 'log-only' }, store);
    expect(d).toEqual({ verdict: 'warn', code: 'AMBIGUOUS', reason: expect.any(String) });
  });
});

describe('assertOutboundIdentity — LID device-suffix normalization (QR-025)', () => {
  it('normalizes a device-suffixed @lid before resolve → resolves the warm identity, not AMBIGUOUS', () => {
    // lid_mappings is keyed by the NORMALIZED lid (no :device suffix); resolveLid returns a
    // warm phone only for the normalized form. A device-suffixed LID for the SAME identity
    // must still resolve — without normalize it misses and is floored AMBIGUOUS (fail-closed).
    const NORMALIZED = '11111110000402';
    const store = fakeStore({
      resolveLid: (lid: string) => (lid === NORMALIZED ? '15550001111@s.whatsapp.net' : null),
      isWarm: () => true,
    });
    const d = assertOutboundIdentity(`${NORMALIZED}:8@lid`, { caller: 'agent', mode: 'enforce' }, store);
    expect(d).toEqual({ verdict: 'allow' });
  });
});

describe('assertOutboundIdentity — system caller bypass', () => {
  for (const caller of ['health', 'scheduler', 'reply-guarantee', 'report-channel'] as const) {
    it(`${caller} to a cold target → allow in enforce mode`, () => {
      const store = fakeStore({ isWarm: () => false, resolveLid: () => '15550009999@s.whatsapp.net' });
      const d = assertOutboundIdentity('11111110000402@lid', { caller, mode: 'enforce' }, store);
      expect(d).toEqual({ verdict: 'allow' });
    });
  }
});

describe('assertOutboundIdentity — plain phone jid', () => {
  it('cold s.whatsapp.net target → block in enforce', () => {
    const store = fakeStore({ isWarm: () => false });
    const d = assertOutboundIdentity('15550009999@s.whatsapp.net', { caller: 'agent', mode: 'enforce' }, store);
    expect(d).toEqual({ verdict: 'block', code: 'COLD_TARGET', reason: expect.any(String) });
  });
});

describe('assertOutboundIdentity — group classification', () => {
  it('known group → allow', () => {
    const store = fakeStore({ isApprovedGroup: () => true });
    const d = assertOutboundIdentity('1111111000000001@g.us', { caller: 'mcp', mode: 'enforce' }, store);
    expect(d).toEqual({ verdict: 'allow' });
  });

  it('enforce: unknown group → block/UNKNOWN_GROUP', () => {
    const store = fakeStore({ isApprovedGroup: () => false });
    const d = assertOutboundIdentity('1111111000000002@g.us', { caller: 'mcp', mode: 'enforce' }, store);
    expect(d).toEqual({ verdict: 'block', code: 'UNKNOWN_GROUP', reason: expect.any(String) });
  });

  it('log-only: unknown group → warn/UNKNOWN_GROUP', () => {
    const store = fakeStore({ isApprovedGroup: () => false });
    const d = assertOutboundIdentity('1111111000000002@g.us', { caller: 'mcp', mode: 'log-only' }, store);
    expect(d).toEqual({ verdict: 'warn', code: 'UNKNOWN_GROUP', reason: expect.any(String) });
  });

  it('system caller to unknown group → allow (infra bypass precedes group block)', () => {
    const store = fakeStore({ isApprovedGroup: () => false });
    const d = assertOutboundIdentity('1111111000000002@g.us', { caller: 'report-channel', mode: 'enforce' }, store);
    expect(d).toEqual({ verdict: 'allow' });
  });
});
