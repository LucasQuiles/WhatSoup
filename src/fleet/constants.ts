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
