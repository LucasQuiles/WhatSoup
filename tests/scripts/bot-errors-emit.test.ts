import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';
const AWS_KEY_SAMPLE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN_SAMPLE = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
const JWT_SAMPLE = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'signaturepart1234567890'].join('.');
const PRIVATE_KEY_SAMPLE = ['-----BEGIN ', 'PRIVATE KEY-----', '\nabc\n', '-----END ', 'PRIVATE KEY-----'].join('');
const URL_USERINFO_SAMPLE = `https://user:pass@${'example'}.com/path`;
const REDACTED_URL_USERINFO = `https://[REDACTED]@${'example'}.com/path`;
const PHONE_SAMPLE = '+1 (555) 123-4567';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function eventFrom(stateRoot: string) {
  const outbox = join(stateRoot, 'outbox');
  const files = readdirSync(outbox);
  expect(files).toHaveLength(1);
  return {
    name: files[0]!,
    path: join(outbox, files[0]!),
    event: JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as Record<string, any>,
  };
}

function outboxEvent() {
  return eventFrom(tmpRoot);
}

describe('bot-errors-emit', () => {
  it('writes a private durable BOT ERRORS event from shell-friendly arguments', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-emit-'));
    const evidencePath = join(tmpRoot, 'evidence.log');
    writeFileSync(evidencePath, [
      'line one',
      'api_key=plain-secret',
      'Authorization: Bearer abc.def',
      AWS_KEY_SAMPLE,
      GITHUB_TOKEN_SAMPLE,
      JWT_SAMPLE,
      PRIVATE_KEY_SAMPLE,
      URL_USERINFO_SAMPLE,
      PHONE_SAMPLE,
      '',
    ].join('\n'));

    const output = execFileSync('python3', [
      'deploy/scripts/bot-errors-emit.py',
      '--instance',
      'fleet-offload-sync',
      '--source',
      'unit-node-rsync',
      '--summary',
      'unit-node sync failed token=inline-secret',
      '--evidence',
      'rsync exited 12',
      '--evidence-file',
      evidencePath,
      '--log-hint',
      join('/tmp', 'bot-errors', 'unit-node-offload', 'logs', 'unit-node-offload-sync.log'),
      '--diagnostic',
      'target=unit-node',
      '--print-path',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
      encoding: 'utf8',
    }).trim();

    const { name, path, event } = outboxEvent();
    expect(output).toBe(path);
    expect(name.startsWith('.')).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(event).toMatchObject({
      schemaVersion: 2,
      eventKind: 'incident_alert',
      eventType: 'alert',
      severity: 'critical',
      instance: 'fleet-offload-sync',
      source: 'unit-node-rsync',
      delivery: { attempts: 0, status: 'queued' },
    });
    expect(event.summary).toBe('unit-node sync failed token=[REDACTED]');
    expect(event.evidence).toContain('rsync exited 12');
    expect(event.evidence).toContain('api_key=[REDACTED]');
    expect(event.evidence).toContain('Authorization: Bearer [REDACTED]');
    expect(event.evidence).toContain('[REDACTED AWS ACCESS KEY]');
    expect(event.evidence).toContain('[REDACTED GITHUB TOKEN]');
    expect(event.evidence).toContain('[REDACTED JWT]');
    expect(event.evidence).toContain('[REDACTED PEM PRIVATE KEY]');
    expect(event.evidence).toContain(REDACTED_URL_USERINFO);
    expect(event.evidence).toContain('[REDACTED PHONE]');
    expect(event.evidence).not.toContain('plain-secret');
    expect(event.evidence).not.toContain('abc.def');
    expect(event.evidence).not.toContain(AWS_KEY_SAMPLE);
    expect(event.evidence).not.toContain(GITHUB_TOKEN_SAMPLE);
    expect(event.evidence).not.toContain('eyJhbGci');
    expect(event.evidence).not.toContain('-----BEGIN');
    expect(event.evidence).not.toContain(URL_USERINFO_SAMPLE);
    expect(event.evidence).not.toContain(PHONE_SAMPLE);
    expect(event.diagnostics.logHints).toContain(join('/tmp', 'bot-errors', 'unit-node-offload', 'logs', 'unit-node-offload-sync.log'));
    expect(event.diagnostics.target).toBe('unit-node');
  });

  it('writes equivalent v2 recoveries for clear shortcut and explicit clear', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-emit-'));
    const shortcutRoot = join(tmpRoot, 'shortcut');
    const explicitRoot = join(tmpRoot, 'explicit');
    const emit = (stateRoot: string, args: string[]) => execFileSync('python3', [
      'deploy/scripts/bot-errors-emit.py',
      ...args,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: stateRoot },
    });

    emit(shortcutRoot, ['--clear', '--instance', 'contract-test', '--source', 'contract-clear']);
    emit(explicitRoot, ['--event-type', 'clear', '--instance', 'contract-test', '--source', 'contract-clear']);

    const shortcut = eventFrom(shortcutRoot).event;
    const explicit = eventFrom(explicitRoot).event;
    const expected = {
      schemaVersion: 2,
      eventKind: 'incident_recovery',
      eventType: 'clear',
      severity: 'info',
      summary: 'alert source cleared: contract-clear',
    };
    expect(shortcut).toMatchObject(expected);
    expect(explicit).toMatchObject(expected);
  });

  it('rejects a contradictory clear before writing an outbox entry', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-emit-'));
    let exitCode = 0;
    try {
      execFileSync('python3', [
        'deploy/scripts/bot-errors-emit.py',
        '--event-type', 'clear',
        '--severity', 'critical',
        '--instance', 'contract-test',
        '--source', 'contract-clear',
        '--summary', 'contradictory clear must not enqueue',
      ], {
        cwd: process.cwd(),
        env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
        stdio: 'pipe',
      });
    } catch (error: any) {
      exitCode = error.status ?? 1;
    }

    expect(exitCode).not.toBe(0);
    const outbox = join(tmpRoot, 'outbox');
    expect(existsSync(outbox) ? readdirSync(outbox) : []).toHaveLength(0);
  });

  it('uses hidden tmp files and leaves only final json visible', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-emit-'));

    execFileSync('python3', [
      'deploy/scripts/bot-errors-emit.py',
      '--instance',
      'unit-lab-offload-sync',
      '--source',
      'preflight',
      '--summary',
      'unit-lab preflight failed',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    expect(basename(files[0]!)).not.toMatch(/\\.tmp$/);
  });

  it('redirects an explicit live outbox under pytest provenance', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-emit-'));
    const home = join(tmpRoot, 'home');
    const writerTmp = join(tmpRoot, 'tmp');
    const liveOutbox = join(home, '.local', 'state', 'bot-errors', 'outbox');
    mkdirSync(home, { recursive: true });
    mkdirSync(writerTmp, { recursive: true });

    execFileSync('python3', [
      'deploy/scripts/bot-errors-emit.py',
      '--instance',
      'pytest-bot',
      '--source',
      'pytest-source',
      '--summary',
      'pytest should redirect',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: writerTmp,
        BOT_ERRORS_OUTBOX_DIR: liveOutbox,
        PYTEST_CURRENT_TEST: 'tests/test_bot_errors.py::test_redirect (call)',
        VITEST: '',
        VITEST_WORKER_ID: '',
        NODE_ENV: '',
      },
    });

    expect(existsSync(liveOutbox)).toBe(false);
    const testRoot = join(writerTmp, 'whatsoup-vitest-bot-errors');
    const [workerDir] = readdirSync(testRoot);
    const outbox = join(testRoot, workerDir!, 'outbox');
    const event = JSON.parse(readFileSync(join(outbox, readdirSync(outbox)[0]!), 'utf8')) as Record<string, any>;
    expect(event.runtime.provenance).toMatchObject({
      producer: 'python-emit',
      test: true,
      outboxPolicy: 'test-redirect',
      liveOutboxRedirected: true,
    });
    expect(event.runtime.provenance.signals).toEqual(['PYTEST_CURRENT_TEST']);
  });

  it('caps and sanitizes long explicit event filenames while preserving the payload id', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-emit-'));
    const eventId = `explicit/unsafe-${'x'.repeat(220)}`;

    execFileSync('python3', [
      'deploy/scripts/bot-errors-emit.py',
      '--event-id',
      eventId,
      '--instance',
      `unit-instance-${'i'.repeat(100)}`,
      '--source',
      `unit/source-${'s'.repeat(100)}`,
      '--summary',
      'long filename should stay durable',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot },
    });

    const { name, event } = outboxEvent();
    expect(name.length).toBeLessThanOrEqual(180);
    expect(name).toMatch(/\.json$/);
    expect(name).not.toContain('/');
    expect(event.id).toBe(eventId);
  });

  it('uses WSL-local diagnostics instead of per-service journalctl hints', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-emit-'));

    execFileSync('python3', [
      'deploy/scripts/bot-errors-emit.py',
      '--instance',
      'brick-wsl',
      '--source',
      'relay-canary',
      '--summary',
      'brick WSL relay canary',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SYS_PLATFORM: 'linux',
        BOT_ERRORS_DRY_PLATFORM_SYSTEM: 'Linux',
        BOT_ERRORS_DRY_PLATFORM_RELEASE: '6.6.87.2-microsoft-standard-WSL2',
      },
    });

    const { event } = outboxEvent();
    expect(event.platform).toBe('Linux 6.6.87.2-microsoft-standard-WSL2');
    expect(event.diagnostics.logHints).toContain(`ps -eo pid,etime,cmd | grep -F brick-wsl`);
    expect(event.diagnostics.logHints).toContain(join(tmpRoot, '.claude/observability/runtime'));
    expect(event.diagnostics.logHints).toContain(join(tmpRoot, 'outbox'));
    expect(event.diagnostics.logHints.some((hint: string) => hint.includes('journalctl'))).toBe(false);
  });

  it('records a reconstructable breadcrumb when the outbox is unwritable (B4)', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-emit-'));
    const roParent = join(tmpRoot, 'ro-parent');
    const writefail = join(tmpRoot, 'writefail');
    mkdirSync(roParent, { recursive: true });
    chmodSync(roParent, 0o500); // unwritable parent → mkdir of outbox fails

    let exitCode = 0;
    let stderr = '';
    try {
      execFileSync('python3', [
        'deploy/scripts/bot-errors-emit.py',
        '--instance',
        'ana-bot',
        '--source',
        'writefail-probe',
        '--summary',
        'should fail to write',
        '--evidence',
        'phone=+1 (555) 867-5309',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_OUTBOX_DIR: join(roParent, 'outbox'),
          BOT_ERRORS_WRITEFAIL_DIR: writefail,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err: any) {
      exitCode = err.status ?? 1;
      stderr = String(err.stderr ?? '');
    } finally {
      chmodSync(roParent, 0o700);
    }

    // Loud-fail: nonzero exit + stderr trace 1.
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('outbox write FAILED');

    // Trace 2: a reconstructable, still-redacted breadcrumb in the fallback dir.
    const crumbs = readdirSync(writefail).filter((f) => f.endsWith('.writefail'));
    expect(crumbs).toHaveLength(1);
    const crumb = JSON.parse(readFileSync(join(writefail, crumbs[0]!), 'utf8')) as Record<string, any>;
    expect(crumb).toMatchObject({ kind: 'outbox_write_failure', schemaVersion: 1 });
    expect(crumb.event).toMatchObject({ instance: 'ana-bot', severity: 'critical' });
    expect(crumb.event.evidence).toContain('[REDACTED PHONE]');
    expect(crumb.event.evidence).not.toContain('867-5309');
  });

  it('prefers the collector-visible home writefail fallback before TMPDIR', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-emit-'));
    const roParent = join(tmpRoot, 'ro-parent');
    const home = join(tmpRoot, 'home');
    const writerTmp = join(tmpRoot, 'launchd-tmp');
    mkdirSync(roParent, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(writerTmp, { recursive: true });
    chmodSync(roParent, 0o500);

    let exitCode = 0;
    try {
      execFileSync('python3', [
        'deploy/scripts/bot-errors-emit.py',
        '--instance',
        'ana-bot',
        '--source',
        'writefail-probe',
        '--summary',
        'should choose home fallback',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: writerTmp,
          BOT_ERRORS_STATE_DIR: join(roParent, 'state'),
          BOT_ERRORS_OUTBOX_DIR: join(roParent, 'outbox'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err: any) {
      exitCode = err.status ?? 1;
    } finally {
      chmodSync(roParent, 0o700);
    }

    expect(exitCode).not.toBe(0);
    expect(readdirSync(join(home, '.bot-errors-writefail')).filter((f) => f.endsWith('.writefail'))).toHaveLength(1);
    const tmpFallback = join(writerTmp, 'bot-errors-writefail');
    expect(existsSync(tmpFallback) ? readdirSync(tmpFallback).filter((f) => f.endsWith('.writefail')) : []).toHaveLength(0);
  });
});
