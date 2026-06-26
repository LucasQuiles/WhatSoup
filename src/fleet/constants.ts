/**
 * Leaf constants shared between the fleet server and instance config without
 * importing either heavy module (fleet/index.ts must stay loadable without
 * instance config; config.ts must not pull in the fleet server).
 */

/**
 * Default fleet/GUI port. Also hardcoded (necessarily) in the shell wrapper
 * `deploy/whatsoup-fleet` and unit `deploy/whatsoup-fleet.service` — change
 * all of them together.
 */
export const DEFAULT_FLEET_PORT = 9099;
export const DEFAULT_INSTANCE_HEALTH_PORT = 9090;

/**
 * Agreed per-instance health-port band for a single host's fleet.
 *
 * Instance `healthPort` values are expected to fall in this inclusive range so
 * the fleet console (DEFAULT_FLEET_PORT) and per-host tooling can reason about
 * the port map without probing. The band deliberately STOPS one below
 * DEFAULT_FLEET_PORT: a bot health port equal to the fleet console port is the
 * "console squat" failure class (a bot answering on the port fleet tooling
 * expects the console on). SSOT consumed by scripts/check-instance-config.ts.
 *
 * The hard validity floor/ceiling (1024-65535) is enforced separately by
 * src/core/agent-config-validator.ts; this narrower band is the convention.
 */
export const INSTANCE_HEALTH_PORT_MIN = 9090;
export const INSTANCE_HEALTH_PORT_MAX = 9098;

/** Valid `range` query tokens accepted by the fleet metrics endpoints. */
export const VALID_METRICS_RANGES = new Set(['24h', '7d', '30d']);
