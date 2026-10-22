import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const patchDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(patchDirectory);
// Ignore a calling hook's context and repositories above a release export.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
env.GIT_CEILING_DIRECTORIES = path.dirname(root);

function apply(patch, flags = []) {
  const result = spawnSync('git', ['apply', '--whitespace=nowarn', ...flags, '--', patch], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error(`Cannot run required dependency patch: ${result.error?.message ?? result.signal}`);
  }
  return result;
}

const patches = readdirSync(patchDirectory).filter((name) => name.endsWith('.patch')).sort();
if (patches.length === 0) throw new Error('No required dependency patch files found');

for (const name of patches) {
  const patch = path.join(patchDirectory, name);
  const check = apply(patch, ['--check']);
  if (check.status === 0) {
    const result = apply(patch);
    if (result.status !== 0) throw new Error(`Failed to apply ${name}: ${result.stderr.trim()}`);
    console.log(`Applied required dependency patch: ${name}`);
  } else if (apply(patch, ['--reverse', '--check']).status === 0) {
    console.log(`Required dependency patch already applied: ${name}`);
  } else {
    throw new Error(`Required dependency patch conflicts: ${name}\n${check.stderr.trim()}`);
  }
}
