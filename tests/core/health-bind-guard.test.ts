import { describe, it, expect } from 'vitest';
import { assertSafeHealthBind, HEALTH_UNSAFE_REMOTE_ENV } from '../../src/core/health-bind-guard.ts';

describe('assertSafeHealthBind (R7a)', () => {
  it('returns for loopback hosts without any override', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(() => assertSafeHealthBind(host, {})).not.toThrow();
    }
  });

  it('throws for a non-loopback bind without the explicit override', () => {
    expect(() => assertSafeHealthBind('0.0.0.0', {})).toThrow(/non-loopback/i);
    expect(() => assertSafeHealthBind('192.168.1.10', {})).toThrow(/HEALTH_BIND_ADDRESS/);
  });

  it('returns (with a warning) for a non-loopback bind when the override is set to "1"', () => {
    expect(() =>
      assertSafeHealthBind('0.0.0.0', { [HEALTH_UNSAFE_REMOTE_ENV]: '1' }),
    ).not.toThrow();
  });

  it('does NOT accept a non-"1" override value (must be exactly "1")', () => {
    expect(() =>
      assertSafeHealthBind('0.0.0.0', { [HEALTH_UNSAFE_REMOTE_ENV]: 'true' }),
    ).toThrow(/non-loopback/i);
  });
});
