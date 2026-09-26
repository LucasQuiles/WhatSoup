import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Pins the shell semantics the maintenance step runner relies on, under the
// same /bin/bash the launchd job uses (3.2 on macOS). Each case runs a small
// script that sources deploy/lib/step-runner.sh; the oracle is the printed
// trace and the results file, never the runner's own source text.

const LIB = path.join(process.cwd(), 'deploy/lib/step-runner.sh');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function bash(body: string): { status: number | null; stdout: string; results: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'hm-steps-'));
  dirs.push(dir);
  const results = path.join(dir, 'steps.tsv');
  const script = ['set -euo pipefail', `. "${LIB}"`, `R="${results}"`, ': > "$R"', body].join('\n');
  const r = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' });
  if (r.error) throw r.error;
  let text = '';
  try {
    text = readFileSync(results, 'utf8');
  } catch {
    text = '';
  }
  return { status: r.status, stdout: r.stdout, results: text };
}

describe('whatsoup_run_step under /bin/bash', () => {
  it('stops a step at its first failing command, records its rc, and runs the next step', () => {
    const r = bash([
      'failing() { echo one; false; echo not-reached; }',
      'passing() { echo two; }',
      'whatsoup_run_step "$R" first failing',
      'whatsoup_run_step "$R" second passing',
      'echo parent-continued',
    ].join('\n'));
    expect(r.stdout).toBe('one\ntwo\nparent-continued\n');
    expect(r.results).toBe('first\t1\nsecond\t0\n');
    expect(r.status).toBe(0);
  });

  it('re-establishes errexit inside the step even when the caller runs with errexit off', () => {
    // The naive form `set +e; (step)` would print not-reached: errexit is not restored in the subshell.
    const r = bash([
      'set +e',
      'failing() { false; echo not-reached; }',
      'whatsoup_run_step "$R" only failing',
      'case "$-" in *e*) echo errexit-on ;; *) echo errexit-off ;; esac',
    ].join('\n'));
    expect(r.stdout).toBe('errexit-off\n');
    expect(r.results).toBe('only\t1\n');
  });

  it('restores the caller errexit setting after the step', () => {
    const r = bash([
      'whatsoup_run_step "$R" only false',
      'case "$-" in *e*) echo errexit-on ;; *) echo errexit-off ;; esac',
    ].join('\n'));
    expect(r.stdout).toBe('errexit-on\n');
  });

  it('does not fire the parent ERR trap for a failure it records, and keeps the trap installed', () => {
    const r = bash([
      "trap 'echo parent-err' ERR",
      'whatsoup_run_step "$R" only false',
      'echo after-step',
      'false',
    ].join('\n'));
    expect(r.stdout).toBe('after-step\nparent-err\n');
    expect(r.results).toBe('only\t1\n');
    expect(r.status).toBe(1);
  });

  it('does not run the parent EXIT trap inside the step', () => {
    const r = bash([
      "trap 'echo parent-exit' EXIT",
      'whatsoup_run_step "$R" only true',
      'echo after-step',
    ].join('\n'));
    expect(r.stdout).toBe('after-step\nparent-exit\n');
  });

  it('keeps no variable a step sets: results travel only through the results file', () => {
    const r = bash([
      'value=parent',
      'setter() { value=child; }',
      'whatsoup_run_step "$R" only setter',
      'echo "$value"',
    ].join('\n'));
    expect(r.stdout).toBe('parent\n');
  });

  it('observes that errexit does not reach inside a command substitution on this bash', () => {
    // Step code must therefore check the status of work done inside $(...) explicitly.
    const r = bash([
      'inner() { false; echo inner-continued; }',
      'outer() { local v; v="$(inner)"; echo "got $v"; }',
      'whatsoup_run_step "$R" only outer',
    ].join('\n'));
    expect(r.stdout).toBe('got inner-continued\n');
    expect(r.results).toBe('only\t0\n');
  });

  it('records a step killed by a signal with the signal status', () => {
    const r = bash([
      // bash 3.2 has no BASHPID; a direct child sh signals its parent, the step subshell.
      'suicide() { sh -c \'kill -TERM $PPID\'; sleep 5; }',
      'whatsoup_run_step "$R" only suicide',
      'echo after-step',
    ].join('\n'));
    expect(r.stdout).toBe('after-step\n');
    expect(r.results).toBe('only\t143\n');
  });
});
