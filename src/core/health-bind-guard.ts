import { createChildLogger } from '../logger.ts';

const log = createChildLogger('health:bind-guard');

/**
 * Explicit opt-in for binding the health server to a non-loopback address.
 * Value must be the literal string "1".
 */
export const HEALTH_UNSAFE_REMOTE_ENV = 'WHATSOUP_HEALTH_UNSAFE_REMOTE';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Fail startup when the health server would bind a non-loopback address without
 * the explicit unsafe override (R7a). The health server exposes operational
 * metadata over `GET /health` and a token-gated allowlist-mutation endpoint over
 * `POST /access`; a remote plain-HTTP bind puts both on the network and sends the
 * health token over the wire unencrypted. Mirrors `assertSafeFleetBind`
 * (`src/fleet/bind-guard.ts`). Defense-in-depth: opt in explicitly on trusted
 * private networks only, ideally behind TLS.
 */
export function assertSafeHealthBind(
  host: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (LOOPBACK_HOSTS.has(host)) return;

  if (env[HEALTH_UNSAFE_REMOTE_ENV] === '1') {
    log.warn(
      { event: 'health_unsafe_remote_override', host },
      `health server bound to a non-loopback address with ${HEALTH_UNSAFE_REMOTE_ENV}=1 — ` +
        'GET /health metadata and the token-gated POST /access endpoint are network-reachable ' +
        'and the health token travels over plain HTTP; front this port with TLS',
    );
    return;
  }

  log.error(
    { event: 'health_dangerous_config_rejected', host, reason: 'non-loopback-health-endpoint' },
    'refusing non-loopback health bind without the explicit unsafe override',
  );
  throw new Error(
    `refusing to bind health server to non-loopback address ${JSON.stringify(host)}: ` +
      'a remote bind exposes GET /health metadata and the token-gated POST /access endpoint and sends ' +
      'the health token over plain HTTP unless fronted by TLS. Either keep HEALTH_BIND_ADDRESS ' +
      `loopback (default 127.0.0.1) behind a reverse proxy/tunnel, or set ${HEALTH_UNSAFE_REMOTE_ENV}=1 ` +
      'to accept the risk explicitly (e.g. on a trusted private network such as a tailnet).',
  );
}
