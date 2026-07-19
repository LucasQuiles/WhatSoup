/**
 * buildChildEnv — egress-proxy env injection (#1607).
 *
 * When a caller supplies `egressProxyPort` (a positive port number) via
 * `baseOpts`, `buildChildEnv` must inject `HTTP_PROXY`/`HTTPS_PROXY` pointed
 * at the local egress-allowlist proxy plus `NO_PROXY` so the proxy's own
 * loopback traffic isn't recursively proxied. Without `egressProxyPort`, none
 * of the three vars are added — today's unproxied behavior for instances
 * that have not opted into the allowlist.
 *
 * `buildChildEnv` builds an explicit env allowlist (never spreads
 * `process.env`) so each provider subprocess only receives the credentials
 * and vars it actually needs — see the security rationale on `buildChildEnv`
 * in src/runtimes/agent/session.ts. The last test here guards that invariant
 * for this change specifically: a var present in `process.env` but absent
 * from the allowlist must not bleed into the returned child env.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildChildEnv } from '../../../src/runtimes/agent/session.ts';

describe('buildChildEnv — egress proxy env injection (#1607)', () => {
  afterEach(() => {
    delete process.env.WHATSOUP_EGRESS_SENTINEL;
  });

  it('injects HTTP_PROXY/HTTPS_PROXY/NO_PROXY when egressProxyPort is set', () => {
    const env = buildChildEnv('claude-cli', { egressProxyPort: 3128 });
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:3128');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:3128');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
  });

  it('omits all three proxy vars when egressProxyPort is not set (baseOpts omitted)', () => {
    const env = buildChildEnv('claude-cli');
    expect(env).not.toHaveProperty('HTTP_PROXY');
    expect(env).not.toHaveProperty('HTTPS_PROXY');
    expect(env).not.toHaveProperty('NO_PROXY');
  });

  it('omits all three proxy vars when baseOpts is supplied without egressProxyPort', () => {
    const env = buildChildEnv('claude-cli', { whatsoupInstance: 'line-a' });
    expect(env).not.toHaveProperty('HTTP_PROXY');
    expect(env).not.toHaveProperty('HTTPS_PROXY');
    expect(env).not.toHaveProperty('NO_PROXY');
  });

  it('omits all three proxy vars when egressProxyPort is not positive (0)', () => {
    const env = buildChildEnv('claude-cli', { egressProxyPort: 0 });
    expect(env).not.toHaveProperty('HTTP_PROXY');
    expect(env).not.toHaveProperty('HTTPS_PROXY');
    expect(env).not.toHaveProperty('NO_PROXY');
  });

  it('does not bleed an unrelated process.env var into the child env (allowlist invariant)', () => {
    process.env.WHATSOUP_EGRESS_SENTINEL = 'leak';
    const env = buildChildEnv('claude-cli', { egressProxyPort: 3128 });
    expect(env).not.toHaveProperty('WHATSOUP_EGRESS_SENTINEL');
  });
});
