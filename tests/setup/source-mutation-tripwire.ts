import { afterAll, beforeAll, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Source-mutation tripwire. The suite has twice shipped a mutator that
// rewrites src/main.ts in the repo tree mid-run (caught by the source-runtime
// drift guard, which can only prove THAT the tree changed, not WHO wrote it).
// Each test file snapshots the tree hash when its fork loads and re-checks on
// exit: the file whose run moved the hash names ITSELF in the raw CI log, so
// one red run pinpoints the mutator. An optional externally exported
// WHATSOUP_TRIPWIRE_MAIN_SHA256 (set by the CI workflow before vitest starts)
// additionally catches cross-file gaps on entry. globalSetup cannot carry the
// baseline — its process.env never reaches forked workers.
const target = join(process.cwd(), 'src/main.ts');

function currentDigest(): string {
  return createHash('sha256').update(readFileSync(target)).digest('hex');
}

const entryDigest = currentDigest();

function fire(stage: string, baseline: string, current: string): void {
  const spec = expect.getState().testPath ?? 'unknown-spec';
  // Raw stderr, not console.error: vitest's console interception swallows
  // hook-context console output, and the whole point is surviving into the
  // raw CI log.
  process.stderr.write(
    `TRIPWIRE src/main.ts mutated: stage=${stage} spec=${spec} baseline=${baseline.slice(0, 16)} current=${current.slice(0, 16)}\n`,
  );
}

beforeAll(() => {
  const anchor = process.env.WHATSOUP_TRIPWIRE_MAIN_SHA256;
  if (anchor && anchor !== entryDigest) fire('enter-vs-suite-anchor', anchor, entryDigest);
});

afterAll(() => {
  const exitDigest = currentDigest();
  if (exitDigest !== entryDigest) fire('exit-vs-own-entry', entryDigest, exitDigest);
});
