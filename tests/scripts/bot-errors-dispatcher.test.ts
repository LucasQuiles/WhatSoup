import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';
const AWS_KEY_SAMPLE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN_SAMPLE = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
const JWT_SAMPLE = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'signaturepart1234567890'].join('.');
const PRIVATE_KEY_SAMPLE = ['-----BEGIN ', 'PRIVATE KEY-----', '\nabc\n', '-----END ', 'PRIVATE KEY-----'].join('');
const URL_USERINFO_SAMPLE = `https://user:pass@${'example'}.com/path`;
const REDACTED_URL_USERINFO = `https://[REDACTED] at ${'example'}.com/path`;
const AT_SIGN = '@';
const TEST_SERVICE_NAME = `whatsoup${AT_SIGN}18454174651.service`;
const TEST_CHAT_JID = `q${AT_SIGN}s.whatsapp.net`;
const PHONE_SAMPLE = '+1 (555) 123-4567';

function writeEvent(root: string, severity = 'critical', overrides: Record<string, unknown> = {}) {
  const outbox = join(root, 'outbox');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const event = {
    schemaVersion: 1,
    id: 'attempt-counter-test',
    eventType: 'alert',
    severity,
    createdAt: '2026-05-31T00:00:00Z',
    machine: 'test-machine',
    instance: 'q',
    source: 'dispatcher-test',
    summary: 'attempt counter test',
    evidence: 'assert attempts increments before send',
    process: { pid: 123, cwd: root, argv: ['test'] },
    diagnostics: { logHints: ['journalctl --user -u bot-errors-dispatcher.service'], queue: outbox },
    delivery: { attempts: 0, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    ...overrides,
  };
  writeFileSync(join(outbox, '20260531T000000Z.attempt-counter-test.json'), `${JSON.stringify(event, null, 2)}\n`, { mode: 0o600 });
}

function writeWritefail(root: string, eventOverrides: Record<string, unknown> = {}) {
  const writefail = join(root, 'writefail');
  mkdirSync(writefail, { recursive: true, mode: 0o700 });
  const event = {
    schemaVersion: 1,
    id: 'writefail-recovery-test',
    eventType: 'alert',
    severity: 'critical',
    createdAt: '2026-05-31T00:00:00Z',
    machine: 'test-machine',
    instance: 'ana-bot',
    source: 'wf',
    summary: 'recovered from writefail',
    evidence: 'already redacted phone=[REDACTED PHONE]',
    process: { pid: 456, cwd: root, argv: ['test'] },
    diagnostics: { logHints: ['launchd health log'], queue: join(root, 'outbox') },
    delivery: { attempts: 0, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    ...eventOverrides,
  };
  const crumb = {
    schemaVersion: 1,
    kind: 'outbox_write_failure',
    recordedAt: '2026-05-31T00:00:01Z',
    failedTarget: join(root, 'outbox'),
    reason: 'PermissionError: denied',
    emitPid: 456,
    event,
  };
  writeFileSync(join(writefail, `${event.id}.writefail`), `${JSON.stringify(crumb, null, 2)}\n`, { mode: 0o600 });
}

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('bot-errors-dispatcher', () => {
  it('increments attempts before a successful send and persists the sent event', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    const sent = join(tmpRoot, 'sent');
    writeEvent(tmpRoot);

    execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
    });

    expect(readFileSync(capturePath, 'utf8')).toContain('dispatcher_attempts: 1');
    expect(readFileSync(capturePath, 'utf8')).toContain('dispatch_log:');
    expect(readFileSync(capturePath, 'utf8')).toContain('requested_action: Q investigate, remediate');
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "sent"');
    const sentFiles = readdirSync(sent);
    expect(sentFiles).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(sent, sentFiles[0]!), 'utf8')) as { delivery: { attempts: number; status: string } };
    expect(event.delivery.attempts).toBeGreaterThanOrEqual(1);
    expect(event.delivery.status).toBe('sent');
  });

  it('keeps an alert durable when the WhatsApp socket is unavailable and sends once after recovery', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    const outbox = join(tmpRoot, 'outbox');
    const sent = join(tmpRoot, 'sent');
    writeEvent(tmpRoot, 'critical', {
      id: 'socket-down-test',
      summary: 'socket unavailable must stay durable',
    });

    const failed = spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: '',
        BOT_ERRORS_JID: 'bot-errors-test-group',
        BOT_ERRORS_SOCKET_PATH: join(tmpRoot, 'missing.sock'),
      },
      encoding: 'utf8',
    });

    expect(failed.status).toBe(1);
    expect(existsSync(capturePath)).toBe(false);
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "send_failed"');
    const outboxFilesAfterFailure = readdirSync(outbox).filter((file) => file.endsWith('.json'));
    expect(outboxFilesAfterFailure).toHaveLength(1);
    const queuedPath = join(outbox, outboxFilesAfterFailure[0]!);
    const queued = JSON.parse(readFileSync(queuedPath, 'utf8')) as {
      delivery: { attempts: number; status: string; lastError: string; nextAttemptAtEpoch: number };
    };
    expect(queued.delivery.attempts).toBe(1);
    expect(queued.delivery.status).toBe('queued');
    expect(queued.delivery.lastError).toContain('missing.sock');
    expect(queued.delivery.nextAttemptAtEpoch).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const skippedDuringBackoff = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });
    expect(JSON.parse(skippedDuringBackoff)).toMatchObject({ processed: 0, sent: 0, failed: 0 });
    expect(existsSync(capturePath)).toBe(false);

    queued.delivery.nextAttemptAtEpoch = 0;
    writeFileSync(queuedPath, `${JSON.stringify(queued, null, 2)}\n`, { mode: 0o600 });
    const recovered = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(recovered)).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(readFileSync(capturePath, 'utf8').match(/socket unavailable must stay durable/g)).toHaveLength(1);
    expect(readdirSync(outbox).filter((file) => file.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync(sent)).toHaveLength(1);
  });

  it('reclaims a dispatcher processing claim after a crash and sends it once', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const processing = join(tmpRoot, 'processing');
    const sent = join(tmpRoot, 'sent');
    mkdirSync(processing, { recursive: true, mode: 0o700 });
    const event = {
      schemaVersion: 1,
      id: 'crash-reclaim-test',
      eventType: 'alert',
      severity: 'critical',
      createdAt: '2026-05-31T00:00:00Z',
      machine: 'test-machine',
      instance: 'q',
      source: 'dispatcher-crash-drill',
      summary: 'crash mid-claim must replay once',
      evidence: 'synthetic orphaned processing claim',
      process: { pid: 321, cwd: tmpRoot, argv: ['test'] },
      diagnostics: { logHints: ['journalctl --user -u bot-errors-dispatcher.service'], queue: join(tmpRoot, 'outbox') },
      delivery: { attempts: 0, status: 'sending', nextAttemptAtEpoch: 0, lastError: null },
    };
    writeFileSync(
      join(processing, '20260531T000000Z.crash-reclaim-test.json.999.processing'),
      `${JSON.stringify(event, null, 2)}\n`,
      { mode: 0o600 },
    );

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 1, sent: 1, reclaimed: 1, failed: 0 });
    expect(readFileSync(capturePath, 'utf8').match(/crash mid-claim must replay once/g)).toHaveLength(1);
    expect(readdirSync(processing)).toHaveLength(0);
    expect(readdirSync(sent)).toHaveLength(1);
  });

  it('renders info events as informational with no remediation request', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    writeEvent(tmpRoot, 'info');

    execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
    });

    const rendered = readFileSync(capturePath, 'utf8');
    expect(rendered).toContain('BOT INFO - attempt counter test');
    expect(rendered).toContain('requested_action: none');
    expect(rendered).not.toContain('requested_action: Q investigate');
  });

  it('suppresses daily-health info sends with a distinct auditable disposition', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    const sent = join(tmpRoot, 'sent');
    const suppressed = join(tmpRoot, 'suppressed');
    writeEvent(tmpRoot, 'info', {
      id: 'daily-health-ok',
      source: 'daily-health',
      instance: 'bot-errors-health',
      summary: 'BOT ERRORS daily health passed',
    });

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 1, sent: 0, suppressed: 1, failed: 0 });
    expect(existsSync(capturePath)).toBe(false);
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "suppressed"');
    expect(readdirSync(sent)).toHaveLength(0);
    const suppressedFiles = readdirSync(suppressed);
    expect(suppressedFiles).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(suppressed, suppressedFiles[0]!), 'utf8')) as {
      delivery: { attempts: number; status: string; suppressedReason: string };
    };
    expect(event.delivery.attempts).toBeGreaterThanOrEqual(1);
    expect(event.delivery.status).toBe('suppressed');
    expect(event.delivery.suppressedReason).toContain('daily-health info events');
  });

  it('still sends daily-health warnings', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    writeEvent(tmpRoot, 'warning', {
      id: 'daily-health-warning',
      source: 'daily-health',
      instance: 'bot-errors-health',
      summary: 'BOT ERRORS daily health found issues',
    });

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 1, sent: 1, suppressed: 0, failed: 0 });
    expect(readFileSync(capturePath, 'utf8')).toContain('BOT WARNING - BOT ERRORS daily health found issues');
  });

  it('recovers writefail breadcrumbs into the normal dispatch path', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    const sent = join(tmpRoot, 'sent');
    const recovered = join(tmpRoot, 'writefail-recovered');
    writeWritefail(tmpRoot);

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_WRITEFAIL_DIR: join(tmpRoot, 'writefail'),
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 1, sent: 1, writefailRecovered: 1, failed: 0 });
    expect(readFileSync(capturePath, 'utf8')).toContain('BOT ERROR - recovered from writefail');
    expect(readFileSync(capturePath, 'utf8')).toContain('writefail_recovered:');
    expect(readFileSync(capturePath, 'utf8')).toContain('already redacted phone=[REDACTED PHONE]');
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "writefail_recovered"');
    expect(readdirSync(recovered)).toHaveLength(1);
    const sentFiles = readdirSync(sent);
    expect(sentFiles).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(sent, sentFiles[0]!), 'utf8')) as {
      diagnostics: { writefailRecovery: { breadcrumb: string; reason: string } };
    };
    expect(event.diagnostics.writefailRecovery.reason).toContain('PermissionError');
    expect(event.diagnostics.writefailRecovery.breadcrumb).toContain('writefail-recovery-test.writefail');
  });

  it('does not replay writefail breadcrumbs for events already known locally', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    const sent = join(tmpRoot, 'sent');
    const recovered = join(tmpRoot, 'writefail-recovered');
    mkdirSync(sent, { recursive: true, mode: 0o700 });
    writeFileSync(join(sent, '20260531T000000Z.writefail-recovery-test.json.sent'), JSON.stringify({
      id: 'writefail-recovery-test',
      delivery: { status: 'sent' },
    }));
    writeWritefail(tmpRoot);

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_WRITEFAIL_DIR: join(tmpRoot, 'writefail'),
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 0, sent: 0, writefailRecovered: 0, failed: 0 });
    expect(existsSync(capturePath)).toBe(false);
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "writefail_duplicate"');
    expect(readdirSync(recovered)).toHaveLength(1);
    expect(readdirSync(sent)).toHaveLength(1);
  });

  it('does not treat substring event-id matches as writefail duplicates', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const sent = join(tmpRoot, 'sent');
    mkdirSync(sent, { recursive: true, mode: 0o700 });
    writeFileSync(join(sent, '20260531T000000Z.evt-ABCDEF123456.json.sent'), JSON.stringify({
      id: 'evt-ABCDEF123456',
      delivery: { status: 'sent' },
    }));
    writeWritefail(tmpRoot, {
      id: 'evt-ABCDEF',
      summary: 'substring collision must still send',
    });

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_WRITEFAIL_DIR: join(tmpRoot, 'writefail'),
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 1, sent: 1, writefailRecovered: 1, failed: 0 });
    expect(readFileSync(capturePath, 'utf8')).toContain('substring collision must still send');
    expect(readdirSync(sent)).toHaveLength(2);
  });

  it('renders at-sign-bearing diagnostics mention-safely', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const outbox = join(tmpRoot, 'outbox');
    writeEvent(tmpRoot, 'critical', {
      summary: `${TEST_SERVICE_NAME.replace(/\.service$/, '')} unreachable`,
      evidence: [
        `service=${TEST_SERVICE_NAME} chat=${TEST_CHAT_JID}`,
        AWS_KEY_SAMPLE,
        GITHUB_TOKEN_SAMPLE,
        JWT_SAMPLE,
        PRIVATE_KEY_SAMPLE,
        URL_USERINFO_SAMPLE,
        PHONE_SAMPLE,
      ].join('\n'),
      diagnostics: {
        logHints: [`journalctl --user -u ${TEST_SERVICE_NAME} --since '30 minutes ago'`],
        queue: outbox,
      },
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
    });

    const rendered = readFileSync(capturePath, 'utf8');
    expect(rendered).toContain('whatsoup at [REDACTED PHONE].service');
    expect(rendered).toContain('q at s.whatsapp.net');
    expect(rendered).toContain('[REDACTED AWS ACCESS KEY]');
    expect(rendered).toContain('[REDACTED GITHUB TOKEN]');
    expect(rendered).toContain('[REDACTED JWT]');
    expect(rendered).toContain('[REDACTED PEM PRIVATE KEY]');
    expect(rendered).toContain(REDACTED_URL_USERINFO);
    expect(rendered).toContain('[REDACTED PHONE]');
    expect(rendered).not.toContain(TEST_SERVICE_NAME.replace(/\.service$/, ''));
    expect(rendered).not.toContain(TEST_CHAT_JID);
    expect(rendered).not.toContain(AWS_KEY_SAMPLE);
    expect(rendered).not.toContain(GITHUB_TOKEN_SAMPLE);
    expect(rendered).not.toContain('eyJhbGci');
    expect(rendered).not.toContain('-----BEGIN');
    expect(rendered).not.toContain(URL_USERINFO_SAMPLE);
    expect(rendered).not.toContain(PHONE_SAMPLE);
  });

  it('ignores partial temp files in the outbox without delivery or quarantine', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const outbox = join(tmpRoot, 'outbox');
    const capturePath = join(tmpRoot, 'sent-message.txt');
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    const partialTemp = join(outbox, '.20260531T000000Z.partial-event.json.123.tmp');
    writeFileSync(partialTemp, '{"schemaVersion":1', { mode: 0o600 });

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 0, sent: 0, failed: 0 });
    expect(existsSync(capturePath)).toBe(false);
    expect(existsSync(partialTemp)).toBe(true);
    expect(readdirSync(join(tmpRoot, 'processing'))).toHaveLength(0);
    expect(readdirSync(join(tmpRoot, 'quarantine'))).toHaveLength(0);
    expect(readdirSync(join(tmpRoot, 'sent'))).toHaveLength(0);
  });
});
