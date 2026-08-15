import { createChildLogger } from '../logger.ts';

const log = createChildLogger('fleet:bind-guard');

/**
 * Explicit opt-in for binding the fleet server to a non-loopback address.
 * Value must be the literal string "1".
 */
export const FLEET_UNSAFE_REMOTE_CONSOLE_ENV = 'WHATSOUP_FLEET_UNSAFE_REMOTE_CONSOLE';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Fail startup when the fleet server would bind a non-loopback address
 * without the explicit unsafe override. Post-B1 the served HTML carries no
 * token, but a remote plain-HTTP bind still (a) exposes the console unlock
 * endpoint to the network and (b) transmits the operator-entered root token
 * and the session cookie unencrypted. Defense-in-depth: opt in explicitly
 * on trusted private networks only.
 */
export function assertSafeFleetBind(
  host: string,
  // env-allowed: pure-resolver param-default; the DI idiom, not a bypass
  env: Record<string, string | undefined> = process.env,
): void {
  if (LOOPBACK_HOSTS.has(host)) return;

  if (env[FLEET_UNSAFE_REMOTE_CONSOLE_ENV] === '1') {
    log.warn(
      { event: 'console_unsafe_remote_override', host },
      `fleet console bound to a non-loopback address with ${FLEET_UNSAFE_REMOTE_CONSOLE_ENV}=1 — ` +
      'the unlock endpoint is network-reachable and credentials (root token + session cookie, which omits Secure) travel over plain HTTP — front this port with TLS',
    );
    return;
  }

  log.error(
    { event: 'console_dangerous_config_rejected', host, reason: 'non-loopback-console-endpoint' },
    'refusing non-loopback fleet bind without the explicit unsafe override',
  );
  throw new Error(
    `refusing to bind fleet server to non-loopback address ${JSON.stringify(host)}: ` +
    'a remote bind exposes the console unlock endpoint and sends the root token/session cookie over ' +
    'plain HTTP unless fronted by TLS. Either keep FLEET_BIND_ADDRESS ' +
    `loopback (default 127.0.0.1) behind a reverse proxy/tunnel, or set ${FLEET_UNSAFE_REMOTE_CONSOLE_ENV}=1 ` +
    'to accept the risk explicitly (e.g. on a trusted private network such as a tailnet or isolated Docker bridge).',
  );
}
