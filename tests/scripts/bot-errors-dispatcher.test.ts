import { execFileSync } from 'node:child_process';
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
    expect(rendered).toContain('whatsoup at 18454174651.service');
    expect(rendered).toContain('q at s.whatsapp.net');
    expect(rendered).toContain('[REDACTED AWS ACCESS KEY]');
    expect(rendered).toContain('[REDACTED GITHUB TOKEN]');
    expect(rendered).toContain('[REDACTED JWT]');
    expect(rendered).toContain('[REDACTED PEM PRIVATE KEY]');
    expect(rendered).toContain(REDACTED_URL_USERINFO);
    expect(rendered).not.toContain(TEST_SERVICE_NAME.replace(/\.service$/, ''));
    expect(rendered).not.toContain(TEST_CHAT_JID);
    expect(rendered).not.toContain(AWS_KEY_SAMPLE);
    expect(rendered).not.toContain(GITHUB_TOKEN_SAMPLE);
    expect(rendered).not.toContain('eyJhbGci');
    expect(rendered).not.toContain('-----BEGIN');
    expect(rendered).not.toContain(URL_USERINFO_SAMPLE);
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
