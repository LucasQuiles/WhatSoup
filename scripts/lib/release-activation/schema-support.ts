/**
 * The highest database schema migration a release tree can open, read from the
 * release itself so an activation can refuse to start a release on a database
 * it would reject (`DatabaseCompatibilityError` `future_schema`).
 *
 * The source is `src/core/database-schema-version.ts`, the dependency-free
 * constant the pre-main compatibility gate compares against and that
 * `src/core/database.ts` asserts equals the last key of its migration registry.
 * The file must be sealed by the release manifest (`files[]`, which lists every
 * git-tracked file) and its bytes must match the sealed sha256. Any other state
 * (no manifest, file not sealed, digest mismatch, unrecognised text) is
 * `null`: support that cannot be proven is treated as too low.
 */
import type { ReleaseSnapshotManifest } from '../../release-snapshot-plan.ts';
import { readBoundedConsumerFile, sha256 } from './plan.ts';

export const SCHEMA_VERSION_SOURCE = 'src/core/database-schema-version.ts';
const SCHEMA_VERSION_DECLARATION = /^export const CURRENT_SCHEMA_MIGRATION = (\d+);$/m;

export interface ReleaseSchemaSupport {
  /** Highest migration the release opens, or null when it cannot be proven. */
  max: number | null;
  detail: string;
}

export function readReleaseSchemaSupport(releaseRoot: string, manifest: ReleaseSnapshotManifest | null): ReleaseSchemaSupport {
  if (manifest === null) return { max: null, detail: 'release manifest unavailable: schema support unproven' };
  const entry = manifest.files.find((file) => file.path === SCHEMA_VERSION_SOURCE);
  if (entry === undefined) return { max: null, detail: `${SCHEMA_VERSION_SOURCE} is not sealed by the release manifest: schema support unproven` };
  const bytes = readBoundedConsumerFile(releaseRoot, SCHEMA_VERSION_SOURCE);
  if (!Buffer.isBuffer(bytes)) return { max: null, detail: `${SCHEMA_VERSION_SOURCE} is not a regular root-bound file` };
  if (bytes.length !== entry.sizeBytes || sha256(bytes) !== entry.sha256) {
    return { max: null, detail: `${SCHEMA_VERSION_SOURCE} differs from the sealed release file` };
  }
  const matches = bytes.toString('utf8').match(new RegExp(SCHEMA_VERSION_DECLARATION.source, 'gm')) ?? [];
  const match = matches.length === 1 ? SCHEMA_VERSION_DECLARATION.exec(matches[0]!) : null;
  const max = match === null ? null : Number(match[1]);
  if (max === null || !Number.isSafeInteger(max)) {
    return { max: null, detail: `${SCHEMA_VERSION_SOURCE} has no single CURRENT_SCHEMA_MIGRATION declaration` };
  }
  return { max, detail: `opens schema migrations up to ${max}` };
}
