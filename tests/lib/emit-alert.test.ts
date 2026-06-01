import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    warn: loggerWarn,
  }),
}));

import { clearAlertSource, emitAlert } from '../../src/lib/emit-alert.ts';
import { buildBotErrorsEvent } from '../../src/lib/bot-errors-outbox.ts';

const ALERT_SCRIPT = join(homedir(), '.claude', 'scripts', 'whatsapp-alert.sh');
const SPAWN_OPTIONS = { stdio: 'ignore', timeout: 5_000, detached: false };
const BOT_ERRORS_JID = 'test-alert-target';
const AWS_KEY_SAMPLE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN_SAMPLE = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
const JWT_SAMPLE = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'signaturepart1234567890'].join('.');
const PRIVATE_KEY_SAMPLE = ['-----BEGIN ', 'PRIVATE KEY-----', '\nabc\n', '-----END ', 'PRIVATE KEY-----'].join('');
const URL_USERINFO_SAMPLE = `https://user:pass@${'example'}.com/path`;
const REDACTED_URL_USERINFO = `https://[REDACTED]@${'example'}.com/path`;
const PHONE_SAMPLE = '+1 (555) 123-4567';
const ORIGINAL_HOME = process.env['HOME'];
const ORIGINAL_TMPDIR = process.env['TMPDIR'];
let outboxDir = '';
let writefailDir = '';

function spawnedChild() {
  return vi.mocked(spawn).mock.results.at(-1)?.value;
}

function readOnlyEvent() {
  const files = readdirSync(outboxDir);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(outboxDir, files[0]!), 'utf8')) as Record<string, unknown>;
}

function readOnlyWritefail(dir = writefailDir) {
  const files = readdirSync(dir).filter((file) => file.endsWith('.writefail'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as Record<string, any>;
}

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env['HOME'];
  else process.env['HOME'] = ORIGINAL_HOME;
  if (ORIGINAL_TMPDIR === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = ORIGINAL_TMPDIR;
  delete process.env['BOT_ERRORS_WRITEFAIL_DIR'];
  delete process.env['BOT_ERRORS_STATE_DIR'];
});

describe('emitAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
    existsSyncMock.mockReturnValue(true);
    if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
    if (writefailDir) rmSync(writefailDir, { recursive: true, force: true });
    outboxDir = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-'));
    writefailDir = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-'));
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxDir;
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefailDir;
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_STATE_DIR'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'];
  });

  it('writes a durable outbox event with instance, source, summary, and evidence', () => {
    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(readOnlyEvent()).toMatchObject({
      schemaVersion: 1,
      eventType: 'alert',
      severity: 'critical',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      summary: 'respawn exhausted',
      evidence: 'crashed 3 times',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('defaults to critical but honors an explicit non-critical severity override', () => {
    emitAlert(
      'whatsoup-prod',
      'instance_never_reachable',
      'configured but never came online',
      'connect ECONNREFUSED',
      'warning',
    );

    expect(readOnlyEvent()).toMatchObject({
      eventType: 'alert',
      severity: 'warning',
      instance: 'whatsoup-prod',
      source: 'instance_never_reachable',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('redacts obvious secret material before writing the event', () => {
    const secretEvidence = [
      'token=plain-secret',
      'Bearer abc.def',
      AWS_KEY_SAMPLE,
      GITHUB_TOKEN_SAMPLE,
      JWT_SAMPLE,
      PRIVATE_KEY_SAMPLE,
      URL_USERINFO_SAMPLE,
      PHONE_SAMPLE,
    ].join('\n');

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', secretEvidence);

    const event = readOnlyEvent() as { evidence: string };
    expect(event.evidence).toContain('token=[REDACTED]');
    expect(event.evidence).toContain('Bearer [REDACTED]');
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
    expect(event.evidence).not.toContain('-----END');
    expect(event.evidence).not.toContain(URL_USERINFO_SAMPLE);
    expect(event.evidence).not.toContain(PHONE_SAMPLE);
  });

  it('never exposes a truncated temp file as a live event', () => {
    writeFileSync(join(outboxDir, '.truncated.tmp'), '');

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    const liveEvents = readdirSync(outboxDir).filter((file) => file.endsWith('.json') && !file.startsWith('.'));
    expect(liveEvents).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outboxDir, liveEvents[0]!), 'utf8')) as Record<string, unknown>;
    expect(event).toMatchObject({
      eventType: 'alert',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
    });
  });

  it('uses Darwin log hints instead of journalctl for macOS-hosted bots', () => {
    process.env['BOT_ERRORS_DRY_PLATFORM'] = 'darwin';
    process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'] = '25.4.0';

    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'com.whatsoup.ana-bot',
      source: 'agent_respawn_failed',
      summary: 'respawn exhausted',
      evidence: 'crashed 3 times',
    });

    expect(event.platform).toBe('darwin 25.4.0');
    expect(event.diagnostics.logHints).toContain('launchctl print gui/$(id -u)/com.whatsoup.ana-bot');
    expect(event.diagnostics.logHints.some((hint) => hint.includes('log show --last 30m'))).toBe(true);
    expect(event.diagnostics.logHints.some((hint) => hint.includes('journalctl'))).toBe(false);
  });

  it('uses WSL process and observability hints instead of journalctl', () => {
    process.env['BOT_ERRORS_DRY_PLATFORM'] = 'linux';
    process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'] = '5.15.153.1-microsoft-standard-WSL2';

    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'brick-wsl-bot',
      source: 'tool_call_failed',
      summary: 'tool failed',
      evidence: 'exit 1',
    });

    expect(event.diagnostics.logHints).toContain("ps -eo pid,etime,cmd | grep -F 'brick-wsl-bot'");
    expect(event.diagnostics.logHints).toContain(join(homedir(), '.claude', 'observability', 'runtime'));
    expect(event.diagnostics.logHints.some((hint) => hint.includes('journalctl'))).toBe(false);
  });

  it('falls back to the legacy helper when the outbox write fails', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).toHaveBeenCalledWith(
      ALERT_SCRIPT,
      [
        '--alert-target',
        BOT_ERRORS_JID,
        '--instance',
        'whatsoup-prod',
        '--source',
        'agent_respawn_failed',
        '--summary',
        'respawn exhausted',
        '--evidence',
        'crashed 3 times',
      ],
      SPAWN_OPTIONS,
    );
    const child = spawnedChild();
    expect(child?.unref).toHaveBeenCalledOnce();
    expect(child?.on).toHaveBeenCalledWith('error', expect.any(Function));
    const crumb = readOnlyWritefail();
    expect(crumb).toMatchObject({ kind: 'outbox_write_failure', schemaVersion: 1 });
    expect(crumb.failedTarget).toBe('/dev/null/outbox');
    expect(crumb.event).toMatchObject({
      eventType: 'alert',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      summary: 'respawn exhausted',
      evidence: 'crashed 3 times',
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        err: expect.any(String),
      },
      'bot-errors outbox write failed',
    );
  });

  it('logs when both outbox write and legacy helper availability fail', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    existsSyncMock.mockReturnValue(false);

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).not.toHaveBeenCalled();
    expect(readOnlyWritefail().event.summary).toBe('respawn exhausted');
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy helper script not present',
    );
  });

  it('uses HOME writefail fallback before TMPDIR when override and state writefail dirs are blocked', () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-fallback-'));
    const blockedOverride = join(root, 'blocked-override');
    const stateRoot = join(root, 'state');
    const home = join(root, 'home');
    const writerTmp = join(root, 'writer-tmp');
    writeFileSync(blockedOverride, 'not a directory');
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(writerTmp, { recursive: true });
    writeFileSync(join(stateRoot, 'writefail'), 'not a directory');
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = join(blockedOverride, 'writefail');
    process.env['BOT_ERRORS_STATE_DIR'] = stateRoot;
    process.env['HOME'] = home;
    process.env['TMPDIR'] = writerTmp;

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    const homeWritefail = join(home, '.bot-errors-writefail');
    const tmpWritefail = join(writerTmp, 'bot-errors-writefail');
    expect(readOnlyWritefail(homeWritefail).event.summary).toBe('respawn exhausted');
    try {
      expect(readdirSync(tmpWritefail).filter((file) => file.endsWith('.writefail'))).toHaveLength(0);
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
    }
  });
});

describe('clearAlertSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
    existsSyncMock.mockReturnValue(true);
    if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
    if (writefailDir) rmSync(writefailDir, { recursive: true, force: true });
    outboxDir = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-'));
    writefailDir = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-'));
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxDir;
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefailDir;
    delete process.env['BOT_ERRORS_STATE_DIR'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'];
  });

  it('writes a durable clear event', () => {
    clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    expect(readOnlyEvent()).toMatchObject({
      schemaVersion: 1,
      eventType: 'clear',
      severity: 'info',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      summary: 'alert source cleared: agent_respawn_failed',
      evidence: 'repair_lane:whatsoup-prod',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('falls back to the legacy helper when clear outbox write fails', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';

    clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    expect(spawn).toHaveBeenCalledWith(
      ALERT_SCRIPT,
      ['--alert-target', BOT_ERRORS_JID, '--clear', 'repair_lane:whatsoup-prod', '--source', 'agent_respawn_failed'],
      SPAWN_OPTIONS,
    );
    const child = spawnedChild();
    expect(child?.unref).toHaveBeenCalledOnce();
    expect(child?.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(readOnlyWritefail().event).toMatchObject({
      eventType: 'clear',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      severity: 'info',
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        err: expect.any(String),
      },
      'bot-errors clear outbox write failed',
    );
  });
});
