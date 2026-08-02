import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

export interface TrackedTmpDirs {
  make(name: string): string;
  cleanup(): void;
}

// Call at file scope: registering the afterEach hook inside a test is a
// vitest error, so trackTmpDirs() cannot be invoked from within it().
//
// `options.base` overrides the default `os.tmpdir()` base with a
// precomputed, already-resolved directory string, computed once at
// trackTmpDirs() call time — not re-resolved per make() call. This exists
// for callers that need a realpath-canonical base (e.g. macOS's /var ->
// /private/var symlink makes raw os.tmpdir() non-canonical, which trips
// production code that rejects non-canonical database path aliases). It is
// not a general-purpose arbitrary-base override.
export function trackTmpDirs(
  prefix = 'whatsoup-test-',
  options: { base?: string } = {},
): TrackedTmpDirs {
  const base = options.base ?? tmpdir();
  const dirs: string[] = [];
  const make = (name: string): string => {
    const dir = mkdtempSync(join(base, `${prefix}${name}-`));
    dirs.push(dir);
    return dir;
  };
  const cleanup = (): void => {
    // Atomic swap to avoid mutation-during-iteration if a make() races
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  afterEach(cleanup);
  return { make, cleanup };
}
