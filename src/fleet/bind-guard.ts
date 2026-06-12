import { createChildLogger } from '../logger.ts';

const log = createChildLogger('fleet:bind-guard');

/**
 * Explicit opt-in for binding the fleet server to a non-loopback address
 * while the served console HTML still carries the root fleet token (B1).
 * Value must be the literal string "1".
 */
export const FLEET_UNSAFE_REMOTE_CONSOLE_ENV = 'WHATSOUP_FLEET_UNSAFE_REMOTE_CONSOLE';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Fail startup when the fleet server would bind a non-loopback address
 * without the explicit unsafe override. The served console HTML embeds the
 * active root fleet token (see static.ts serveHtmlWithMeta), so any browser
 * that can reach the port receives full fleet control before any auth.
 *
 * This is a B1 *mitigation*: it contains the remote exposure class. The
 * closure (removing the token from HTML behind a console unlock/session
 * flow) supersedes it, after which this guard can be relaxed.
 */
export function assertSafeFleetBind(
  host: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (LOOPBACK_HOSTS.has(host)) return;

  if (env[FLEET_UNSAFE_REMOTE_CONSOLE_ENV] === '1') {
    log.warn(
      { event: 'console_unsafe_remote_override', host },
      `fleet console bound to a non-loopback address with ${FLEET_UNSAFE_REMOTE_CONSOLE_ENV}=1 — ` +
      'the root fleet token is served in unauthenticated HTML to anything that can reach this port',
    );
    return;
  }

  log.error(
    { event: 'console_dangerous_config_rejected', host, reason: 'root-token-in-unauthenticated-html' },
    'refusing non-loopback fleet bind while console HTML carries the root token',
  );
  throw new Error(
    `refusing to bind fleet server to non-loopback address ${JSON.stringify(host)}: ` +
    'the console HTML currently serves the root fleet token without authentication, so a remote bind ' +
    'exposes full fleet control to anything that can reach this port. Either keep FLEET_BIND_ADDRESS ' +
    `loopback (default 127.0.0.1) behind a reverse proxy/tunnel, or set ${FLEET_UNSAFE_REMOTE_CONSOLE_ENV}=1 ` +
    'to accept the risk explicitly (e.g. on a trusted private network such as a tailnet or isolated Docker bridge).',
  );
}
