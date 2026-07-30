import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';
const tmpdir = () => '/tmp';
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

function runAtomicWrite(targetPath: string) {
  return spawnSync('python3', ['-c', `
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("bot_errors_runner", "deploy/scripts/bot-errors-runner.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.atomic_write_json(Path(${JSON.stringify(targetPath)}), {"ok": True})
`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('bot-errors-runner', () => {
  it('asserts the atomic-write parent is private before creating a temp file', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));
    const realParent = join(tmpRoot, 'real-outbox');
    const linkedParent = join(tmpRoot, 'linked-outbox');
    mkdirSync(realParent, { recursive: true, mode: 0o700 });
    symlinkSync(realParent, linkedParent, 'dir');

    const result = runAtomicWrite(join(linkedParent, 'event.json'));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to use private directory through symlink');
    expect(readdirSync(realParent)).toEqual([]);
  });

  it('creates a missing atomic-write parent with private permissions', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));
    const parent = join(tmpRoot, 'new-outbox');
    const result = runAtomicWrite(join(parent, 'event.json'));

    expect(result.status).toBe(0);
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(parent, 'event.json'), 'utf8'))).toEqual({ ok: true });
  });

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
      schemaVersion: 2,
      eventKind: 'incident_alert',
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

  it('emits informational command failures as v2 observations', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));

    const result = spawnSync('python3', [
      'deploy/scripts/bot-errors-runner.py',
      '--instance', 'unit-test',
      '--source', 'process-observation',
      '--summary', 'unit-test informational failure',
      '--severity', 'info',
      '--',
      'python3',
      '-c',
      'import sys; sys.exit(7)',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
      encoding: 'utf8',
    });

    expect(result.status).toBe(7);
    const [event] = events();
    expect(event).toMatchObject({
      schemaVersion: 2,
      eventKind: 'observation',
      eventType: 'observation',
      severity: 'info',
      source: 'process-observation',
    });
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

  it('redirects an explicit live outbox under pytest provenance', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));
    const home = join(tmpRoot, 'home');
    const writerTmp = join(tmpRoot, 'tmp');
    const liveOutbox = join(home, '.local', 'state', 'bot-errors', 'outbox');
    mkdirSync(home, { recursive: true });
    mkdirSync(writerTmp, { recursive: true });

    const result = spawnSync('python3', [
      'deploy/scripts/bot-errors-runner.py',
      '--instance', 'pytest-runner',
      '--summary', 'pytest runner should redirect',
      '--',
      'python3',
      '-c',
      'import sys; sys.exit(5)',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: writerTmp,
        BOT_ERRORS_OUTBOX_DIR: liveOutbox,
        PYTEST_CURRENT_TEST: 'tests/test_runner.py::test_redirect (call)',
        VITEST: '',
        VITEST_WORKER_ID: '',
        NODE_ENV: '',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(5);
    expect(existsSync(liveOutbox)).toBe(false);
    const testRoot = join(writerTmp, 'whatsoup-vitest-bot-errors');
    const [workerDir] = readdirSync(testRoot);
    const outbox = join(testRoot, workerDir!, 'outbox');
    const event = JSON.parse(readFileSync(join(outbox, readdirSync(outbox)[0]!), 'utf8')) as Record<string, any>;
    expect(event.runtime.provenance).toMatchObject({
      producer: 'python-runner',
      test: true,
      outboxPolicy: 'test-redirect',
      liveOutboxRedirected: true,
    });
    expect(event.runtime.provenance.signals).toEqual(['PYTEST_CURRENT_TEST']);
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

  it('writes a recoverable writefail breadcrumb when the runner outbox is unwritable', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));
    const blocked = join(tmpRoot, 'blocked-outbox-parent');
    const writefail = join(tmpRoot, 'writefail');
    const capture = join(tmpRoot, 'capture.txt');
    writeFileSync(blocked, 'not a directory');
    const secretLine = `token=runner-secret ${GITHUB_TOKEN_SAMPLE}`;

    const result = spawnSync('python3', [
      'deploy/scripts/bot-errors-runner.py',
      '--instance', 'runner-writefail',
      '--source', 'service-exit',
      '--summary', 'runner outbox failed',
      '--',
      'python3',
      '-c',
      `import sys; print(${JSON.stringify(secretLine)}, file=sys.stderr); sys.exit(9)`,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VITEST: '',
        VITEST_WORKER_ID: '',
        NODE_ENV: '',
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_OUTBOX_DIR: join(blocked, 'outbox'),
        BOT_ERRORS_WRITEFAIL_DIR: writefail,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(9);
    expect(result.stderr).toContain('CRITICAL outbox write FAILED');
    expect(result.stderr).toContain('lost-alert breadcrumb written');
    expect(result.stderr).not.toContain('runner-secret');
    expect(result.stderr).not.toContain(GITHUB_TOKEN_SAMPLE);
    const crumbs = readdirSync(writefail).filter((name) => name.endsWith('.writefail'));
    expect(crumbs).toHaveLength(1);
    const crumb = JSON.parse(readFileSync(join(writefail, crumbs[0]!), 'utf8')) as Record<string, any>;
    expect(crumb).toMatchObject({ kind: 'outbox_write_failure', schemaVersion: 1 });
    expect(crumb.event.summary).toBe('runner outbox failed');
    expect(crumb.event.evidence).toContain('token=[REDACTED]');
    expect(crumb.event.evidence).toContain('[REDACTED GITHUB TOKEN]');
    expect(crumb.event.evidence).not.toContain('runner-secret');
    expect(crumb.event.evidence).not.toContain(GITHUB_TOKEN_SAMPLE);

    const dispatch = spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VITEST: '',
        VITEST_WORKER_ID: '',
        NODE_ENV: '',
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_WRITEFAIL_DIR: writefail,
        BOT_ERRORS_DRY_SEND_CAPTURE: capture,
      },
      encoding: 'utf8',
    });
    expect(dispatch.status).toBe(0);
    expect(readFileSync(capture, 'utf8')).toContain('runner outbox failed');
    expect(readFileSync(capture, 'utf8')).toContain('writefail_recovered');
    expect(readdirSync(join(tmpRoot, 'sent')).filter((name) => name.endsWith('.sent'))).toHaveLength(1);
  });

  it('prefers HOME writefail fallback before TMPDIR when runner state writefail is blocked', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));
    const blocked = join(tmpRoot, 'blocked-outbox-parent');
    const stateRoot = join(tmpRoot, 'state');
    const home = join(tmpRoot, 'home');
    const writerTmp = join(tmpRoot, 'writer-tmp');
    writeFileSync(blocked, 'not a directory');
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(writerTmp, { recursive: true });
    writeFileSync(join(stateRoot, 'writefail'), 'not a directory');

    const result = spawnSync('python3', [
      'deploy/scripts/bot-errors-runner.py',
      '--instance', 'runner-home-fallback',
      '--summary', 'runner should choose home fallback',
      '--',
      'python3',
      '-c',
      'import sys; sys.exit(8)',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: writerTmp,
        BOT_ERRORS_STATE_DIR: stateRoot,
        BOT_ERRORS_OUTBOX_DIR: join(blocked, 'outbox'),
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(8);
    expect(readdirSync(join(home, '.bot-errors-writefail')).filter((name) => name.endsWith('.writefail'))).toHaveLength(1);
    const tmpFallback = join(writerTmp, 'bot-errors-writefail');
    expect(existsSync(tmpFallback) ? readdirSync(tmpFallback).filter((name) => name.endsWith('.writefail')) : []).toHaveLength(0);
  });

  it('prints a redacted lost-event payload when every runner writefail fallback fails', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-runner-'));
    const blocked = join(tmpRoot, 'blocked-outbox-parent');
    const overrideFile = join(tmpRoot, 'override-file');
    const stateRoot = join(tmpRoot, 'state');
    const home = join(tmpRoot, 'home');
    const writerTmp = join(tmpRoot, 'writer-tmp');
    writeFileSync(blocked, 'not a directory');
    writeFileSync(overrideFile, 'not a directory');
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(writerTmp, { recursive: true });
    writeFileSync(join(stateRoot, 'writefail'), 'not a directory');
    writeFileSync(join(home, '.bot-errors-writefail'), 'not a directory');
    writeFileSync(join(writerTmp, 'bot-errors-writefail'), 'not a directory');
    const secretLine = `password=runner-password ${JWT_SAMPLE}`;

    const result = spawnSync('python3', [
      'deploy/scripts/bot-errors-runner.py',
      '--instance', 'runner-all-fallbacks-fail',
      '--summary', 'runner all fallbacks failed',
      '--',
      'python3',
      '-c',
      `import sys; print(${JSON.stringify(secretLine)}, file=sys.stderr); sys.exit(6)`,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: writerTmp,
        BOT_ERRORS_STATE_DIR: stateRoot,
        BOT_ERRORS_OUTBOX_DIR: join(blocked, 'outbox'),
        BOT_ERRORS_WRITEFAIL_DIR: join(overrideFile, 'child'),
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(6);
    expect(result.stderr).toContain('breadcrumb write failed in ALL fallback dirs');
    expect(result.stderr).toContain('lost-event payload follows');
    expect(result.stderr).toContain('password=[REDACTED]');
    expect(result.stderr).toContain('[REDACTED JWT]');
    expect(result.stderr).not.toContain('runner-password');
    expect(result.stderr).not.toContain('eyJhbGci');
  });
});
