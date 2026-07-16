import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearInitialDatabaseCreateMarker,
  initialDatabaseCreateMarkerPath,
  writeInitialDatabaseCreateMarker,
} from '../../src/core/initial-database-marker.ts';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-initial-db-marker-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('initial database create marker', () => {
  it('writes an exclusive private marker bound to the instance', () => {
    const dataRoot = tempRoot();

    const markerPath = writeInitialDatabaseCreateMarker(dataRoot, 'new-bot');

    expect(markerPath).toBe(initialDatabaseCreateMarkerPath(dataRoot));
    expect(readFileSync(markerPath, 'utf8')).toBe('new-bot\n');
    expect(lstatSync(markerPath).mode & 0o777).toBe(0o600);
    expect(() => writeInitialDatabaseCreateMarker(dataRoot, 'new-bot')).toThrow();
  });

  it('removes only the matching private regular marker after database open', () => {
    const dataRoot = tempRoot();
    const markerPath = writeInitialDatabaseCreateMarker(dataRoot, 'new-bot');

    expect(clearInitialDatabaseCreateMarker(dataRoot, 'new-bot')).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
    expect(clearInitialDatabaseCreateMarker(dataRoot, 'new-bot')).toBe(false);
  });

  it('does not remove a marker with mismatched content, permissive mode, or symlink identity', () => {
    for (const variant of ['mismatch', 'permissive', 'symlink']) {
      const dataRoot = tempRoot();
      const markerPath = initialDatabaseCreateMarkerPath(dataRoot);
      if (variant === 'mismatch') {
        writeFileSync(markerPath, 'another-bot\n', { mode: 0o600 });
      } else if (variant === 'permissive') {
        writeFileSync(markerPath, 'new-bot\n', { mode: 0o644 });
      } else {
        const target = path.join(dataRoot, 'marker-target');
        writeFileSync(target, 'new-bot\n', { mode: 0o600 });
        symlinkSync(target, markerPath);
      }

      expect(clearInitialDatabaseCreateMarker(dataRoot, 'new-bot')).toBe(false);
      expect(existsSync(markerPath)).toBe(true);
    }
  });
});
