import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => true));
const fsyncSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
    fsyncSync: fsyncSyncMock,
  };
});

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    warn: loggerWarn,
  }),
}));

import { clearAlertSource, emitAlert, observeAlertEmission, resetEmitAlertThrottle } from '../../src/lib/emit-alert.ts';
import { buildBotErrorsEvent } from '../../src/lib/bot-errors-outbox.ts';

const ALERT_SCRIPT = join(homedir(), '.claude', 'scripts', 'whatsapp-alert.sh');
const SPAWN_OPTIONS = { stdio: 'ignore', timeout: 5_000, detached: false, killSignal: 'SIGKILL' as const };
const BOT_ERRORS_JID = '120363555555555000@g.us';
const AWS_KEY_SAMPLE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN_SAMPLE = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
const JWT_SAMPLE = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'signaturepart1234567890'].join('.');
const PRIVATE_KEY_SAMPLE = ['-----BEGIN ', 'PRIVATE KEY-----', '\nabc\n', '-----END ', 'PRIVATE KEY-----'].join('');
const URL_USERINFO_SAMPLE = `https://user:pass@${'example'}.com/path`;
const REDACTED_URL_USERINFO = `https://[REDACTED]@${'example'}.com/path`;
const PHONE_SAMPLE = '+1 (555) 123-4567';
const WHATSAPP_JID_SAMPLE = '15555550123@s.whatsapp.net';
const CREDENTIAL_PATH_SAMPLE = '/home/testuser/.config/whatsoup/instances/agent-alpha/tokens.env';
const BOT_ERRORS_ENV_PATH_SAMPLE = '/home/testuser/.config/whatsoup/bot-errors.env';
const AUTH_PATH_SAMPLE = '/home/testuser/.local/share/whatsoup/instances/agent-alpha/auth/creds.json';
const BACKUP_PATH_SAMPLE = '/home/testuser/.local/state/whatsoup/auth-bond-backups/agent-alpha/latest';
let outboxDir = '';
let writefailDir = '';

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(filePath);
    if (entry.isFile() && filePath.endsWith('.ts')) return [filePath];
    return [];
  });
}

function spawnedChild() {
  return vi.mocked(spawn).mock.results.at(-1)?.value;
}

function readOnlyEvent() {
  const files = readdirSync(outboxDir);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(outboxDir, files[0]!), 'utf8')) as Record<string, unknown>;
}

function readOnlyWritefail() {
  const files = readdirSync(writefailDir).filter((file) => file.endsWith('.writefail'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(writefailDir, files[0]!), 'utf8')) as Record<string, any>;
}

afterEach(() => {
  if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
  if (writefailDir) rmSync(writefailDir, { recursive: true, force: true });
  delete process.env['BOT_ERRORS_OUTBOX_DIR'];
  delete process.env['BOT_ERRORS_WRITEFAIL_DIR'];
  delete process.env['BOT_ERRORS_STATE_DIR'];
  delete process.env['EMIT_ALERT_THROTTLE_MS'];
});

describe('emitAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
    existsSyncMock.mockReturnValue(true);
    fsyncSyncMock.mockClear();
    if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
    if (writefailDir) rmSync(writefailDir, { recursive: true, force: true });
    outboxDir = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-'));
    writefailDir = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-'));
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxDir;
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefailDir;
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'];
    resetEmitAlertThrottle();
  });

  it('writes a durable outbox event with instance, source, summary, and evidence', () => {
    const result = emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(readOnlyEvent()).toMatchObject({
      schemaVersion: 1,
      eventType: 'alert',
      severity: 'critical',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      summary: 'respawn exhausted',
      evidence: 'crashed 3 times',
    });
    expect(result).toMatchObject({
      ok: true,
      channel: 'outbox',
      status: 'durably_queued',
      outbox: { path: expect.stringContaining(outboxDir) },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fsyncs both event contents and the outbox directory before returning', () => {
    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(readOnlyEvent()).toMatchObject({ eventType: 'alert' });
    expect(fsyncSyncMock).toHaveBeenCalledTimes(2);
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
      'Authorization: Bearer assignment-secret-token',
      'Bearer abc.def',
      AWS_KEY_SAMPLE,
      GITHUB_TOKEN_SAMPLE,
      JWT_SAMPLE,
      PRIVATE_KEY_SAMPLE,
      URL_USERINFO_SAMPLE,
      PHONE_SAMPLE,
      WHATSAPP_JID_SAMPLE,
      CREDENTIAL_PATH_SAMPLE,
      BOT_ERRORS_ENV_PATH_SAMPLE,
      AUTH_PATH_SAMPLE,
      BACKUP_PATH_SAMPLE,
    ].join('\n');

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', secretEvidence);

    const event = readOnlyEvent() as { evidence: string };
    expect(event.evidence).toContain('token=[REDACTED]');
    expect(event.evidence).toContain('Authorization: Bearer [REDACTED]');
    expect(event.evidence).toContain('Bearer [REDACTED]');
    expect(event.evidence).toContain('[REDACTED AWS ACCESS KEY]');
    expect(event.evidence).toContain('[REDACTED GITHUB TOKEN]');
    expect(event.evidence).toContain('[REDACTED JWT]');
    expect(event.evidence).toContain('[REDACTED PEM PRIVATE KEY]');
    expect(event.evidence).toContain(REDACTED_URL_USERINFO);
    expect(event.evidence).toContain('[REDACTED PHONE]');
    expect(event.evidence).toContain('[REDACTED WHATSAPP JID]');
    expect(event.evidence).toContain('[REDACTED CREDENTIAL PATH]');
    expect(event.evidence).not.toContain('plain-secret');
    expect(event.evidence).not.toContain('assignment-secret-token');
    expect(event.evidence).not.toContain('abc.def');
    expect(event.evidence).not.toContain(AWS_KEY_SAMPLE);
    expect(event.evidence).not.toContain(GITHUB_TOKEN_SAMPLE);
    expect(event.evidence).not.toContain('eyJhbGci');
    expect(event.evidence).not.toContain('-----BEGIN');
    expect(event.evidence).not.toContain('-----END');
    expect(event.evidence).not.toContain(URL_USERINFO_SAMPLE);
    expect(event.evidence).not.toContain(PHONE_SAMPLE);
    expect(event.evidence).not.toContain(WHATSAPP_JID_SAMPLE);
    expect(event.evidence).not.toContain(CREDENTIAL_PATH_SAMPLE);
    expect(event.evidence).not.toContain(BOT_ERRORS_ENV_PATH_SAMPLE);
    expect(event.evidence).not.toContain(AUTH_PATH_SAMPLE);
    expect(event.evidence).not.toContain(BACKUP_PATH_SAMPLE);
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

    const result = emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

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
    expect(result).toMatchObject({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
      legacy: { attempted: true, accepted: true },
      outboxError: expect.any(String),
    });
    const child = spawnedChild();
    expect(child?.unref).toHaveBeenCalledOnce();
    expect(child?.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        err: expect.any(String),
      },
      'bot-errors outbox write failed',
    );
  });

  it('logs legacy helper spawn errors after a fallback send is attempted', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');
    spawnedChild()?.emit('error', new Error('spawn denied'));

    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed', err: 'spawn denied' },
      'alert emission failed; legacy helper failed',
    );
  });

  it('logs when both outbox write and legacy helper availability fail', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    existsSyncMock.mockReturnValue(false);

    const result = emitAlert(
      'whatsoup-prod',
      'agent_respawn_failed',
      'respawn exhausted',
      'Authorization: Bearer lost-secret-token',
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      channel: 'none',
      status: 'failed',
      legacy: { attempted: false, accepted: false, reason: 'helper_unavailable' },
      outboxError: expect.any(String),
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy helper script not present',
    );
    const crumb = readOnlyWritefail();
    expect(crumb).toMatchObject({
      kind: 'outbox_write_failure',
      failedTarget: expect.stringContaining('/dev/null/outbox'),
      event: {
        eventType: 'alert',
        severity: 'critical',
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        summary: 'respawn exhausted',
        evidence: 'Authorization: Bearer [REDACTED]',
      },
    });
    expect(JSON.stringify(crumb)).not.toContain('lost-secret-token');
    expect(fsyncSyncMock).toHaveBeenCalledTimes(2);
  });

  it('refuses legacy fallback when BOT_ERRORS_JID is missing', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    delete process.env['BOT_ERRORS_JID'];
    delete process.env['BOT_ERRORS_EXPECTED_JID'];

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      {},
      'BOT_ERRORS_JID not configured; legacy alert helper disabled',
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy alert target not configured',
    );
  });

  it('refuses legacy fallback when BOT_ERRORS_JID is not a group JID', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = '15551234567@s.whatsapp.net';
    process.env['BOT_ERRORS_EXPECTED_JID'] = '15551234567@s.whatsapp.net';

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      { targetSuffix: 's.whatsapp.net' },
      'BOT_ERRORS_JID is not a WhatsApp group JID; legacy alert helper disabled',
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy alert target not configured',
    );
  });

  it('refuses legacy fallback when BOT_ERRORS_JID drifts from BOT_ERRORS_EXPECTED_JID', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = '120363555555555000@g.us';
    process.env['BOT_ERRORS_EXPECTED_JID'] = 'expected-group@g.us';

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      {},
      'BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID; legacy alert helper disabled',
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy alert target not configured',
    );
  });

  it('refuses legacy fallback when BOT_ERRORS_EXPECTED_JID is missing by default', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_EXPECTED_JID'];
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];

    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      {},
      'BOT_ERRORS_EXPECTED_JID not configured; legacy alert helper disabled',
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert emission failed; legacy alert target not configured',
    );
  });

  it('allows legacy fallback without BOT_ERRORS_EXPECTED_JID only when explicitly disabled', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_EXPECTED_JID'];
    process.env['BOT_ERRORS_REQUIRE_EXPECTED'] = '0';

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
  });
});

describe('emitAlert — in-process throttle (legacy fallback path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
    existsSyncMock.mockReturnValue(true);
    fsyncSyncMock.mockClear();
    if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
    if (writefailDir) rmSync(writefailDir, { recursive: true, force: true });
    writefailDir = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-'));
    // Force outbox to fail so every call exercises the legacy spawn path.
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefailDir;
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];
    resetEmitAlertThrottle();
  });

  it('spawns only once when the same (instance, source, summary) triple is emitted twice within the throttle window', () => {
    emitAlert('inst', 'src', 'summary', 'evidence 1');
    emitAlert('inst', 'src', 'summary', 'evidence 2');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('spawns twice when source differs (different key -> not throttled)', () => {
    emitAlert('inst', 'src-a', 'summary', 'evidence');
    emitAlert('inst', 'src-b', 'summary', 'evidence');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('spawns twice when EMIT_ALERT_THROTTLE_MS=0 disables the throttle', () => {
    process.env['EMIT_ALERT_THROTTLE_MS'] = '0';

    emitAlert('inst', 'src', 'summary', 'evidence 1');
    emitAlert('inst', 'src', 'summary', 'evidence 2');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('killSignal: SIGKILL is present in the spawn options', () => {
    emitAlert('inst', 'src', 'summary', 'evidence');

    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ killSignal: 'SIGKILL' }),
    );
  });
});

describe('BOT ERRORS alert emission governance', () => {
  it('requires production callers to use checked alert wrappers', () => {
    const offenders = listTsFiles(join(process.cwd(), 'src'))
      .filter((filePath) => !filePath.endsWith(join('src', 'lib', 'emit-alert.ts')))
      .flatMap((filePath) => {
        const text = readFileSync(filePath, 'utf8');
        const lines = text.split(/\r?\n/);
        return lines.flatMap((line, index) => {
          if (/\b(?:emitAlert|clearAlertSource)\s*\(/.test(line)) {
            return [`${filePath}:${index + 1}:${line.trim()}`];
          }
          return [];
        });
      });

    expect(offenders).toEqual([]);
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
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM'];
    delete process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'];
    resetEmitAlertThrottle();
  });

  it('writes a durable clear event', () => {
    const result = clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    expect(readOnlyEvent()).toMatchObject({
      schemaVersion: 1,
      eventType: 'clear',
      severity: 'info',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      summary: 'alert source cleared: agent_respawn_failed',
      evidence: 'repair_lane:whatsoup-prod',
    });
    expect(result).toMatchObject({
      ok: true,
      channel: 'outbox',
      status: 'durably_queued',
      outbox: { path: expect.stringContaining(outboxDir) },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('falls back to the legacy helper when clear outbox write fails', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';

    const result = clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    expect(spawn).toHaveBeenCalledWith(
      ALERT_SCRIPT,
      ['--alert-target', BOT_ERRORS_JID, '--clear', 'repair_lane:whatsoup-prod', '--source', 'agent_respawn_failed'],
      SPAWN_OPTIONS,
    );
    const child = spawnedChild();
    expect(child?.unref).toHaveBeenCalledOnce();
    expect(child?.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        err: expect.any(String),
      },
      'bot-errors clear outbox write failed',
    );
    expect(result).toMatchObject({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
      legacy: { attempted: true, accepted: true },
      outboxError: expect.any(String),
    });
    const crumb = readOnlyWritefail();
    expect(crumb.event).toMatchObject({
      eventType: 'clear',
      severity: 'info',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
    });
  });

  it('returns a failed result when both clear outbox and legacy helper fail', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    existsSyncMock.mockReturnValue(false);

    const result = clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    expect(spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      channel: 'none',
      status: 'failed',
      legacy: { attempted: false, accepted: false, reason: 'helper_unavailable' },
      outboxError: expect.any(String),
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      { instance: 'whatsoup-prod', source: 'agent_respawn_failed' },
      'alert clear failed; legacy helper script not present',
    );
    const crumb = readOnlyWritefail();
    expect(crumb.event).toMatchObject({
      eventType: 'clear',
      severity: 'info',
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
    });
  });

  it('logs legacy fallback as accepted but unconfirmed when callers observe the result', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';

    const result = emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');
    const ok = observeAlertEmission(result, {
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      operation: 'alert',
    });

    expect(ok).toBe(true);
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        operation: 'alert',
        channel: 'legacy',
        status: 'legacy_accepted_unconfirmed',
        legacyAccepted: true,
      },
      'bot-errors legacy helper accepted alert; delivery is unconfirmed',
    );
  });

  it('returns false when callers observe a total emission failure', () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    existsSyncMock.mockReturnValue(false);

    const result = emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');
    const ok = observeAlertEmission(result, {
      instance: 'whatsoup-prod',
      source: 'agent_respawn_failed',
      operation: 'alert',
    });

    expect(ok).toBe(false);
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        operation: 'alert',
        channel: 'none',
        status: 'failed',
        outboxError: expect.any(String),
        legacyReason: 'helper_unavailable',
        legacyError: undefined,
      },
      'bot-errors alert emission failed in every channel',
    );
  });
});
