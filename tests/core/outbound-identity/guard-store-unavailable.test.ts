import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IdentityStore } from '../../../src/core/outbound-identity/types.ts';

// Hoisted logger spy: lets the fail-open audit be asserted by structured field,
// not just by message string. createChildLogger is captured at guard.ts import.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../../../src/logger.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  flushLogger: () => Promise.resolve(),
}));

const { applyOutboundIdentityGuard, OutboundIdentityError } = await import(
  '../../../src/core/outbound-identity/guard.ts'
);

function throwingStore(throwsTimes: number): IdentityStore {
  let calls = 0;
  return {
    resolveLid: () => null,
    isApprovedGroup: () => true,
    isWarm: () => {
      calls += 1;
      if (calls <= throwsTimes) throw new Error('SQLITE_BUSY: database is locked');
      return false;
    },
  };
}

describe('applyOutboundIdentityGuard — STORE_UNAVAILABLE fail-open', () => {
  beforeEach(() => warnSpy.mockClear());

  it('persistent read failure does NOT throw (fail-open), even in enforce mode', () => {
    const store = throwingStore(Infinity);
    expect(() =>
      applyOutboundIdentityGuard('15550009999@s.whatsapp.net', { caller: 'agent', mode: 'enforce' }, store),
    ).not.toThrow();
  });

  it('a cold target is only blocked on a SUCCESSFUL read (not a busy read)', () => {
    // First read throws, retry succeeds and returns cold → enforce blocks.
    const store = throwingStore(1);
    expect(() =>
      applyOutboundIdentityGuard('15550009999@s.whatsapp.net', { caller: 'agent', mode: 'enforce' }, store),
    ).toThrow(OutboundIdentityError);
  });

  it('fail-open audit is queryable by code field (STORE_UNAVAILABLE), not just message', () => {
    const store = throwingStore(Infinity);
    applyOutboundIdentityGuard('15550009999@s.whatsapp.net', { caller: 'agent', mode: 'enforce' }, store);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'STORE_UNAVAILABLE', verdict: 'warn', caller: 'agent', mode: 'enforce' }),
      expect.stringContaining('failing open'),
    );
  });
});
