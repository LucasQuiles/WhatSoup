import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveTestPython } from '../helpers/python-interpreter.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adapter = join(repoRoot, 'tools/private-test-integrity');
const sources = [
  'private_scanner_candidate.py', 'runtime_capture.py', 'scanner_runtime.py',
  'bounded_github.py', 'github_binding.py', 'tests/native_capture_canary.py',
];

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function executeNative(root: string, scratch: string) {
  const receiptPath = join(scratch, 'native-result.json');
  const result = spawnSync(resolveTestPython(), [
    '-I', '-S', '-B', join(root, 'run_native_tests.py'), '--result', receiptPath,
  ], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8', timeout: 65_000, maxBuffer: 1024 * 1024, shell: false,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { result, receiptPath };
}

function copyAdapter(scratch: string): string {
  const fixture = join(scratch, 'adapter');
  mkdirSync(join(fixture, 'tests'), { recursive: true });
  for (const path of [...sources, 'run_native_tests.py']) {
    copyFileSync(join(adapter, path), join(fixture, path));
  }
  return fixture;
}

it('native qualification runs all synthetic cases and verifies the receipt', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'private-native-')));
  try {
    const expectedPins = Object.fromEntries(sources.map((path) => [path.split('/').at(-1)!, digest(join(adapter, path))]));
    const { result, receiptPath } = executeNative(adapter, scratch);
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt).toMatchObject({ status: 'passed', error: null, scratch_removed: true, caller_tmpdir: scratch, input_sha256: expectedPins });
    expect(receipt.limits).toEqual(['outer watchdog required', 'escaped descendant containment is not claimed']);
    expect(receipt.cases).toEqual([
      { case: 'small-json', capture_bytes: 16, conclusion: 'pass', status: 'passed', validator: 'accepted' },
      { case: 'dependency-write', capture_bytes: 16, conclusion: 'pass', status: 'passed', dependency_bytes: 524288 },
      { case: 'bounded-overflow', capture_bytes: 262144, conclusion: 'inconclusive', status: 'passed', validator: 'refused' },
      { case: 'existing-output', capture_bytes: 17, conclusion: 'inconclusive', status: 'passed' },
      { case: 'symlink-output', capture_bytes: 15, conclusion: 'inconclusive', status: 'passed' },
      { case: 'malformed-command', capture_bytes: 0, conclusion: 'inconclusive', status: 'passed' },
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 70_000);

it('native qualification refuses an omitted canary', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'private-native-missing-')));
  try {
    const fixture = copyAdapter(scratch);
    rmSync(join(fixture, 'tests/native_capture_canary.py'));
    const { result } = executeNative(fixture, scratch);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('native qualification failed');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 70_000);

it.each([
  ['group', 'assert_group_absent(child.pid)', 'assert_group_absent(os.getpgrp())'],
  ['child', 'require(child.poll() is not None, "owned helper leader was not reaped")', 'require(False, "owned helper leader was not reaped")'],
])('native qualification rejects a failing %s assertion', (_name, original, replacement) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'private-native-failure-')));
  try {
    const fixture = copyAdapter(scratch);
    const canary = join(fixture, 'tests/native_capture_canary.py');
    const text = readFileSync(canary, 'utf8');
    // Mutation controls must fail if the corresponding native assertion is removed.
    expect(text.split(original)).toHaveLength(2);
    writeFileSync(canary, text.replace(original, replacement));
    const { result, receiptPath } = executeNative(fixture, scratch);
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({
      status: 'inconclusive', error: 'CanaryError', scratch_removed: true, cases: [],
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 70_000);
