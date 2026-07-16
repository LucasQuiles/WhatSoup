import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_INSTANCE_HEALTH_PORT } from './fleet/constants.ts';
import { configRoot, instancePaths } from './fleet/paths.ts';
import { DatabaseCompatibilityPermanentStartupError } from './core/database-compatibility-early.ts';

const INSTANCE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Build only the canonical fields required by the pre-runtime database gate.
 * This root-layer adapter owns fleet path derivation so the dependency-light
 * core inspection protocol never reaches upward into fleet modules.
 */
export function configureDatabaseCompatibilityBootstrap(instanceName: string): void {
  if (!INSTANCE_NAME_RE.test(instanceName) || instanceName.length > 30) {
    throw new DatabaseCompatibilityPermanentStartupError(
      'invalid instance name for database compatibility bootstrap',
      undefined,
    );
  }
  const paths = instancePaths(instanceName);
  let healthPort = DEFAULT_INSTANCE_HEALTH_PORT;
  try {
    const parsed = JSON.parse(
      readFileSync(join(configRoot(), instanceName, 'config.json'), 'utf8'),
    ) as { healthPort?: unknown };
    if (
      Number.isInteger(parsed.healthPort)
      && (parsed.healthPort as number) >= 1
      && (parsed.healthPort as number) <= 65_535
    ) {
      healthPort = parsed.healthPort as number;
    }
  } catch {
    // Deliberately defer missing/malformed unrelated config to loadInstance().
    // The database safety verdict remains observable on the canonical default.
  }
  process.env.INSTANCE_CONFIG = JSON.stringify({
    name: instanceName,
    healthPort,
    paths,
  });
}
