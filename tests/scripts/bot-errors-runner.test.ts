import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function events(): Array<Record<string, any>> {
  const outbox = join(tmpRoot, 'outbox');
  return readdirSync(outbox)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(outbox, name), 'utf8')) as Record<string, any>);
}

describe('bot-errors-runner', () => {
  it('emits a durable alert with command context when a process exits nonzero', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));
    mkdirSync(join(tmpRoot, 'outbox'), { recursive: true });

    const result = spawnSync('python3', [
      'deploy/scripts/bot-errors-runner.py',
      '--instance', 'unit-test',
      '--source', 'process-exit',
      '--summary', 'unit-test process failed',
      '--diagnostic', 'jid=123@g.us',
      '--',
      'python3',
      '-c',
      'import sys; print("hello"); print("token=secret", file=sys.stderr); sys.exit(7)',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
      encoding: 'utf8',
    });

    expect(result.status).toBe(7);
    expect(result.stdout).toContain('hello');
    expect(result.stderr).toContain('bot-errors-runner: queued failure alert');
    const [event] = events();
    expect(event).toMatchObject({
      eventType: 'alert',
      severity: 'critical',
      instance: 'unit-test',
      source: 'process-exit',
      summary: 'unit-test process failed',
    });
    expect(event?.evidence).toContain('exit_code=7');
    expect(event?.evidence).toContain('jid=123@g.us');
    expect(event?.evidence).toContain('token=[REDACTED]');
    expect(event?.diagnostics.queue).toContain(tmpRoot);
  });

  it('does not emit an alert when the command succeeds', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));

    const output = execFileSync('python3', [
      'deploy/scripts/bot-errors-runner.py',
      '--instance', 'unit-test',
      '--summary', 'should not emit',
      '--',
      'python3',
      '-c',
      'print("ok")',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
      encoding: 'utf8',
    });

    expect(output).toContain('ok');
    expect(() => readdirSync(join(tmpRoot, 'outbox'))).toThrow();
  });

  it('emits an alert when the executable is missing', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));

    const result = spawnSync('python3', [
      'deploy/scripts/bot-errors-runner.py',
      '--instance', 'missing-command',
      '--summary', 'missing command failed',
      '--',
      'definitely-not-a-real-bot-errors-command',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
      encoding: 'utf8',
    });

    expect(result.status).toBe(127);
    const [event] = events();
    expect(event?.evidence).toContain('failure=exec_not_found');
    expect(event?.evidence).toContain('exit_code=127');
  });
});
