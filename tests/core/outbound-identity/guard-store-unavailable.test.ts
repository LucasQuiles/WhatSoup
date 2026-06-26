import { describe, it, expect } from 'vitest';
import { applyOutboundIdentityGuard, OutboundIdentityError } from '../../../src/core/outbound-identity/guard.ts';
import type { IdentityStore } from '../../../src/core/outbound-identity/types.ts';

function throwingStore(throwsTimes: number): IdentityStore {
  let calls = 0;
  return {
    resolveLid: () => null,
    isKnownGroup: () => true,
    isWarm: () => {
      calls += 1;
      if (calls <= throwsTimes) throw new Error('SQLITE_BUSY: database is locked');
      return false;
    },
  };
}

describe('applyOutboundIdentityGuard — STORE_UNAVAILABLE fail-open', () => {
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
});
