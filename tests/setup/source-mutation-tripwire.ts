import { afterAll, beforeAll, expect } from 'vitest';
import {
  assertSourceMutationUnchanged,
  establishSourceMutationAnchor,
} from '../../scripts/lib/source-mutation.ts';

// Source-mutation tripwire. The suite has twice shipped a mutator that
// rewrites src/main.ts in the repo tree mid-run (caught by the source-runtime
// drift guard, which can only prove THAT the tree changed, not WHO wrote it).
// Each test file snapshots the tree hash when its fork loads and re-checks on
// exit: the file whose run moved the hash names ITSELF in the raw CI log, so
// one red run pinpoints the mutator. An optional externally exported
// WHATSOUP_TRIPWIRE_MAIN_SHA256 (set by the CI workflow before vitest starts)
// additionally catches cross-file gaps on entry. globalSetup cannot carry the
// baseline — its process.env never reaches forked workers.
const cwd = process.cwd();
const entryDigest = establishSourceMutationAnchor({ cwd });

function report(message: string): void {
  // Raw stderr, not console.error: vitest's console interception swallows
  // hook-context console output, and the whole point is surviving into the
  // raw CI log.
  process.stderr.write(`${message}\n`);
}

function check(stage: string, expectedDigest: string): void {
  const spec = expect.getState().testPath ?? 'unknown-spec';
  assertSourceMutationUnchanged({ cwd, expectedDigest, stage, spec, report });
}

beforeAll(() => {
  const anchor = process.env.WHATSOUP_TRIPWIRE_MAIN_SHA256;
  if (anchor) check('enter-vs-suite-anchor', anchor);
});

afterAll(() => {
  check('exit-vs-own-entry', entryDigest);
});
