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

  it('injects UPPER and lower case proxy vars when egressProxyPort is set (F4)', () => {
    const env = buildChildEnv('claude-cli', { egressProxyPort: 3128 });
    // Uppercase (historical) …
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:3128');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:3128');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
    // … and lowercase (F4): curl reads lowercase `http_proxy` for plain HTTP
    // (post-httpoxy) and ignores the uppercase form, so `curl http://host`
    // would bypass the proxy entirely without these.
    expect(env.http_proxy).toBe('http://127.0.0.1:3128');
    expect(env.https_proxy).toBe('http://127.0.0.1:3128');
    expect(env.no_proxy).toBe('localhost,127.0.0.1');
  });

  it('omits all six proxy vars when egressProxyPort is not set (baseOpts omitted)', () => {
    const env = buildChildEnv('claude-cli');
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('omits all six proxy vars when baseOpts is supplied without egressProxyPort', () => {
    const env = buildChildEnv('claude-cli', { whatsoupInstance: 'line-a' });
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('omits all six proxy vars when egressProxyPort is not positive (0)', () => {
    const env = buildChildEnv('claude-cli', { egressProxyPort: 0 });
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('does not bleed an unrelated process.env var into the child env (allowlist invariant)', () => {
    process.env.WHATSOUP_EGRESS_SENTINEL = 'leak';
    const env = buildChildEnv('claude-cli', { egressProxyPort: 3128 });
    expect(env).not.toHaveProperty('WHATSOUP_EGRESS_SENTINEL');
  });
});
