import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileSync } from '../lib/private-fs.ts';

export const INITIAL_DATABASE_CREATE_MARKER = '.initial-database-create-approved';

export function initialDatabaseCreateMarkerPath(dataRoot: string): string {
  return join(dataRoot, INITIAL_DATABASE_CREATE_MARKER);
}

export function writeInitialDatabaseCreateMarker(
  dataRoot: string,
  instance: string,
): string {
  const markerPath = initialDatabaseCreateMarkerPath(dataRoot);
  writePrivateFileSync(markerPath, `${instance}\n`, { exclusive: true, mode: 0o600 });
  return markerPath;
}

export function clearInitialDatabaseCreateMarker(
  dataRoot: string,
  instance: string,
): boolean {
  const markerPath = initialDatabaseCreateMarkerPath(dataRoot);
  try {
    const stat = lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    if (readFileSync(markerPath, 'utf8').trim() !== instance) return false;
    unlinkSync(markerPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
