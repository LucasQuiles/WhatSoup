import { describe, it, expect } from 'vitest';
import { assertOutboundIdentity } from '../../../src/core/outbound-identity/guard.ts';
import type { IdentityStore } from '../../../src/core/outbound-identity/types.ts';

/** In-memory fake — exercises the pure decision logic without a DB. */
function fakeStore(over: Partial<IdentityStore> = {}): IdentityStore {
  return {
    resolveLid: () => null,
    isWarm: () => false,
    isKnownGroup: () => true,
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
