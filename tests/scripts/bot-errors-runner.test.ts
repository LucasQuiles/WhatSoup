import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';
const AWS_KEY_SAMPLE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN_SAMPLE = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
const JWT_SAMPLE = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'signaturepart1234567890'].join('.');
const URL_USERINFO_SAMPLE = `https://user:pass@${'example'}.com/path`;
const REDACTED_URL_USERINFO = `https://[REDACTED]@${'example'}.com/path`;
const PHONE_SAMPLE = '+1 (555) 123-4567';

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
    const stderrLine = [
      'token=secret',
      AWS_KEY_SAMPLE,
      GITHUB_TOKEN_SAMPLE,
      JWT_SAMPLE,
      URL_USERINFO_SAMPLE,
      PHONE_SAMPLE,
    ].join(' ');

    const result = spawnSync('python3', [
      'deploy/scripts/bot-errors-runner.py',
      '--instance', 'unit-test',
      '--source', 'process-exit',
      '--summary', 'unit-test process failed',
      '--diagnostic', 'jid=123@g.us',
      '--',
      'python3',
      '-c',
      `import sys; print("hello"); print(${JSON.stringify(stderrLine)}, file=sys.stderr); sys.exit(7)`,
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
    expect(event?.evidence).toContain('[REDACTED AWS ACCESS KEY]');
    expect(event?.evidence).toContain('[REDACTED GITHUB TOKEN]');
    expect(event?.evidence).toContain('[REDACTED JWT]');
    expect(event?.evidence).toContain(REDACTED_URL_USERINFO);
    expect(event?.evidence).toContain('[REDACTED PHONE]');
    expect(event?.evidence).not.toContain(AWS_KEY_SAMPLE);
    expect(event?.evidence).not.toContain(GITHUB_TOKEN_SAMPLE);
    expect(event?.evidence).not.toContain('eyJhbGci');
    expect(event?.evidence).not.toContain(URL_USERINFO_SAMPLE);
    expect(event?.evidence).not.toContain(PHONE_SAMPLE);
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

  it('caps long failure-event filenames while preserving the event id', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));
    const eventId = `runner/unsafe-${'x'.repeat(220)}`;

    const result = spawnSync('python3', [
      'deploy/scripts/bot-errors-runner.py',
      '--event-id', eventId,
      '--instance', `unit-instance-${'i'.repeat(100)}`,
      '--source', `process/source-${'s'.repeat(100)}`,
      '--summary', 'long runner filename failed',
      '--',
      'python3',
      '-c',
      'import sys; sys.exit(9)',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
      encoding: 'utf8',
    });

    expect(result.status).toBe(9);
    const files = readdirSync(join(tmpRoot, 'outbox')).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]!.length).toBeLessThanOrEqual(180);
    expect(files[0]).toMatch(/\.json$/);
    expect(files[0]).not.toContain('/');
    const [event] = events();
    expect(event?.id).toBe(eventId);
  });
});
