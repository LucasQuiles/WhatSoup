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
export function trackTmpDirs(prefix = 'whatsoup-test-'): TrackedTmpDirs {
  const dirs: string[] = [];
  const make = (name: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}${name}-`));
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
