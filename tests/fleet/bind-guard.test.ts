/**
 * B1 bind guard: a non-loopback bind exposes the console unlock endpoint to
 * the network and sends the operator-entered root token / session cookie
 * over plain HTTP unless fronted by TLS. Startup must fail loud unless the
 * operator explicitly opts in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const guardLogError = vi.hoisted(() => vi.fn());
const guardLogWarn = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/logger.ts')>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      if (name !== 'fleet:bind-guard') return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'error') {
            return (f: unknown, m?: string) => { guardLogError(f, m); };
          }
          if (prop === 'warn') {
            return (f: unknown, m?: string) => { guardLogWarn(f, m); };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

import { assertSafeFleetBind, FLEET_UNSAFE_REMOTE_CONSOLE_ENV } from '../../src/fleet/bind-guard.ts';

describe('assertSafeFleetBind', () => {
  beforeEach(() => {
    guardLogError.mockClear();
    guardLogWarn.mockClear();
  });

  it('allows loopback binds without any override', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(() => assertSafeFleetBind(host, {})).not.toThrow();
    }
    expect(guardLogError).not.toHaveBeenCalled();
    expect(guardLogWarn).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback bind with an actionable error and a structured log', () => {
    expect(() => assertSafeFleetBind('0.0.0.0', {})).toThrow(/root token|console/i);
    expect(() => assertSafeFleetBind('100.64.0.7', {})).toThrow(FLEET_UNSAFE_REMOTE_CONSOLE_ENV);

    expect(guardLogError).toHaveBeenCalled();
    const [fields] = guardLogError.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ event: 'console_dangerous_config_rejected', host: '0.0.0.0' });
    expect(JSON.stringify(fields)).not.toMatch(/[0-9a-f]{32,}/); // never a token value
  });

  it('allows a non-loopback bind with the explicit override, but warns', () => {
    const env = { [FLEET_UNSAFE_REMOTE_CONSOLE_ENV]: '1' };
    expect(() => assertSafeFleetBind('0.0.0.0', env)).not.toThrow();
    expect(guardLogWarn).toHaveBeenCalledOnce();
    const [fields] = guardLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ host: '0.0.0.0' });
  });

  it('treats only the literal "1" as the override value', () => {
    expect(() => assertSafeFleetBind('0.0.0.0', { [FLEET_UNSAFE_REMOTE_CONSOLE_ENV]: 'true' }))
      .toThrow();
    expect(() => assertSafeFleetBind('0.0.0.0', { [FLEET_UNSAFE_REMOTE_CONSOLE_ENV]: '' }))
      .toThrow();
  });
});
