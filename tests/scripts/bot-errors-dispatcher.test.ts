/**
 * Dispatcher tests intentionally assert rendered BOT ERRORS message text,
 * dry-send captures, and dispatch logs as behavioral output contracts.
 *
 * test-integrity: source-string-ok
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';
const tmpdir = () => '/tmp';
const AWS_KEY_SAMPLE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN_SAMPLE = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
const JWT_SAMPLE = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'signaturepart1234567890'].join('.');
const PRIVATE_KEY_SAMPLE = ['-----BEGIN ', 'PRIVATE KEY-----', '\nabc\n', '-----END ', 'PRIVATE KEY-----'].join('');
const URL_USERINFO_SAMPLE = `https://user:pass@${'example'}.com/path`;
const REDACTED_URL_USERINFO = `https://[REDACTED] at ${'example'}.com/path`;
const AT_SIGN = '@';
const TEST_SERVICE_NAME = `whatsoup${AT_SIGN}15551230001.service`;
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

function captureMessages(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => (JSON.parse(line) as { text: string }).text);
}

function writeStormEvent(root: string, machine: string, overrides: Record<string, unknown> = {}) {
  const outbox = join(root, 'outbox');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const safeMachine = machine.replace(/[^A-Za-z0-9_.:-]+/g, '_');
  const event = {
    schemaVersion: 1,
    id: `storm-${safeMachine}`,
    eventType: 'alert',
    severity: 'critical',
    createdAt: '2026-05-31T00:00:00Z',
    machine,
    platform: 'darwin',
    instance: 'bot-errors-health',
    source: 'daily-health',
    summary: `${machine} missing required tools send_message,missing_tool`,
    evidence: `machine=${machine} profile=${safeMachine}.json required_missing=missing_tool`,
    process: { pid: 123, cwd: root, argv: ['health'] },
    diagnostics: {
      logHints: [`/var/log/bot-errors/${safeMachine}.log`, join(root, 'remote', safeMachine, 'health.json')],
      queue: outbox,
    },
    delivery: { attempts: 0, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    ...overrides,
  };
  writeFileSync(
    join(outbox, `20260531T000000Z.${safeMachine}.${event.id}.json`),
    `${JSON.stringify(event, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function writeRecoveryEvent(root: string, index: number, overrides: Record<string, unknown> = {}) {
  const outbox = join(root, 'outbox');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const event = {
    schemaVersion: 1,
    id: `recovery-${index}`,
    eventType: 'clear',
    severity: 'info',
    createdAt: `2026-05-31T00:${String(index).padStart(2, '0')}:00Z`,
    machine: 'HOST-A',
    platform: 'darwin',
    instance: 'Loops',
    source: 'llm_total_failure',
    summary: 'alert source cleared: llm_total_failure',
    evidence: `clear_index=${index}`,
    process: { pid: 123, cwd: root, argv: ['recovery-test'] },
    diagnostics: { logHints: [`/tmp/recovery-${index}.log`], queue: outbox },
    delivery: { attempts: 0, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    ...overrides,
  };
  const created = String(event.createdAt).replace(/[-:]/g, '');
  const eventId = String(event.id).replace(/[^A-Za-z0-9_.:-]+/g, '_');
  writeFileSync(join(outbox, `${created}.Loops.${eventId}.json`), `${JSON.stringify(event, null, 2)}\n`, { mode: 0o600 });
}

// Seed an already-open incident into the durable incident-state, standing in for
// the alert a prior dispatcher run would have surfaced. A clear/recovery only
// surfaces when it closes an open incident of the same key; a clear with no open
// incident is orphan-suppressed as connection-flap noise (see commit 3c678e57 and
// deploy/scripts/tests/test_bot_errors_orphan_clear_suppression.py). openedEpoch
// predates the recovery events so the clear is not treated as clock-skewed.
function seedOpenIncident(root: string, key: string, openedEpoch = Math.floor(Date.UTC(2026, 4, 30) / 1000)) {
  const state = {
    version: 1,
    openIncidents: {
      [key]: {
        status: 'open',
        eventCreatedAtEpoch: openedEpoch,
        openedAt: openedEpoch,
        openedIso: new Date(openedEpoch * 1000).toISOString().replace('.000', ''),
        suppressedCount: 0,
      },
    },
    lastSentAt: {},
  };
  writeFileSync(join(root, 'incident-state.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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

    const testGroupJid = ['120363', '000000000000', '@g.us'].join('');
    const failed = spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: '',
        BOT_ERRORS_JID: testGroupJid,
        BOT_ERRORS_EXPECTED_JID: testGroupJid,
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

  it('closes daily-health-fail incidents from a later healthy daily-health summary', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const suppressed = join(tmpRoot, 'suppressed');
    const incidentKey = 'test-machine|line-a|daily-health-fail:line-a';
    writeFileSync(join(tmpRoot, 'incident-state.json'), `${JSON.stringify({
      version: 1,
      openIncidents: {
        [incidentKey]: {
          status: 'open',
          eventId: 'daily-health-fail-line-a',
          eventCreatedAt: '2026-05-31T00:00:00Z',
          eventCreatedAtEpoch: 1780185600,
          openedAt: 1780185600,
          openedIso: '2026-05-31T00:00:00Z',
          lastSummary: 'line-a daily health failed',
          lastEvidence: 'health line-a: FAIL status=unhealthy',
        },
      },
      lastSentAt: { [incidentKey]: 1780185600 },
    }, null, 2)}\n`, { mode: 0o600 });
    writeEvent(tmpRoot, 'info', {
      id: 'daily-health-recovers-line-a',
      source: 'daily-health',
      instance: 'bot-errors-health',
      createdAt: '2026-05-31T00:05:00Z',
      summary: 'BOT ERRORS daily health passed',
      evidence: [
        'health line-a: 200 status=healthy wa_connected=true state=connected',
        'auth_bond_status=present auth_bond_creds_exists=true auth_bond_creds_size=42',
        'auth_failure_class=none',
      ].join(' '),
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
    const incidentState = JSON.parse(readFileSync(join(tmpRoot, 'incident-state.json'), 'utf8')) as {
      openIncidents: Record<string, unknown>;
      lastSentAt: Record<string, unknown>;
    };
    expect(incidentState.openIncidents).not.toHaveProperty(incidentKey);
    expect(incidentState.lastSentAt).not.toHaveProperty(incidentKey);
    const [suppressedFile] = readdirSync(suppressed);
    const suppressedEvent = JSON.parse(readFileSync(join(suppressed, suppressedFile!), 'utf8')) as {
      diagnostics?: { sourceSpecificRecoveredIncidents?: string[] };
      delivery: { suppressedReason: string };
    };
    expect(suppressedEvent.delivery.suppressedReason).toContain('daily-health info events');
    expect(suppressedEvent.diagnostics?.sourceSpecificRecoveredIncidents).toEqual([incidentKey]);
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

  it('collapses same-fingerprint storms into one manifest-backed digest', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    const collapsed = join(tmpRoot, 'storm-collapsed');
    const manifests = join(tmpRoot, 'storm-manifests');
    const sent = join(tmpRoot, 'sent');
    const hosts = ['MACLAB', 'MWLAB', ...Array.from({ length: 11 }, (_, index) => `mini${index + 1}`)];
    hosts.forEach((host, index) => {
      writeStormEvent(tmpRoot, host, {
        id: `storm-${host}`,
        summary: index % 2 === 0
          ? `${host} missing required tools send_message,missing_tool`
          : `${host} missing required tools missing_tool,send_message`,
      });
    });

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
        BOT_ERRORS_STORM_THRESHOLD: '3',
        BOT_ERRORS_STORM_WINDOW_SECONDS: '120',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 1, sent: 1, stormCollapsed: 13, failed: 0 });
    const rendered = readFileSync(capturePath, 'utf8');
    expect(rendered.match(/BOT ERRORS storm collapse/g)).toHaveLength(1);
    expect(rendered).toContain('affected_hosts: 13');
    expect(rendered).toContain('affected_host_list:');
    hosts.forEach((host) => expect(rendered).toContain(host));
    expect(rendered).toContain('storm_manifest:');
    expect(rendered).toContain('requested_action: Q investigate');
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "storm_digest_queued"');
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "storm_collapsed"');
    expect(readdirSync(collapsed)).toHaveLength(13);
    expect(readdirSync(manifests)).toHaveLength(1);
    expect(readdirSync(sent)).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(manifests, readdirSync(manifests)[0]!), 'utf8')) as {
      affectedHosts: number;
      entries: unknown[];
      entriesCollapsed: unknown[];
      hosts: string[];
    };
    expect(manifest.affectedHosts).toBe(13);
    expect(manifest.entries).toHaveLength(13);
    expect(manifest.entriesCollapsed).toHaveLength(13);
    expect(manifest.hosts).toHaveLength(13);
    hosts.forEach((host) => expect(manifest.hosts).toContain(host));
  });

  it('does not merge distinct storm fingerprints', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const collapsed = join(tmpRoot, 'storm-collapsed');
    for (const host of ['mini1', 'mini2', 'mini3']) {
      writeStormEvent(tmpRoot, host, { id: `same-${host}`, summary: `${host} missing required tools send_message` });
    }
    writeStormEvent(tmpRoot, 'mini4', {
      id: 'one-off-mini4',
      source: 'tool-failure',
      summary: 'mini4 tool call failed differently',
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

    expect(JSON.parse(output)).toMatchObject({ processed: 2, sent: 2, stormCollapsed: 3, failed: 0 });
    const messages = captureMessages(capturePath);
    expect(messages).toHaveLength(2);
    expect(readFileSync(capturePath, 'utf8')).toContain('BOT ERRORS storm collapse');
    expect(readFileSync(capturePath, 'utf8')).toContain('mini4 tool call failed differently');
    expect(readdirSync(collapsed)).toHaveLength(3);
  });

  it('limits storm collapse to one digest per time window', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    ['mini1', 'mini2', 'mini3'].forEach((host) => writeStormEvent(tmpRoot, host, {
      id: `early-${host}`,
      createdAt: '2026-05-31T00:00:00Z',
    }));
    ['mini4', 'mini5', 'mini6'].forEach((host) => writeStormEvent(tmpRoot, host, {
      id: `late-${host}`,
      createdAt: '2026-05-31T00:03:00Z',
    }));

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
        BOT_ERRORS_STORM_THRESHOLD: '3',
        BOT_ERRORS_STORM_WINDOW_SECONDS: '120',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 2, sent: 2, stormCollapsed: 6, failed: 0 });
    expect(readFileSync(capturePath, 'utf8').match(/BOT ERRORS storm collapse/g)).toHaveLength(2);
  });

  it('collapses storms that straddle a fixed bucket boundary inside the sliding window', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    [
      ['mini1', '2026-05-31T00:01:59Z'],
      ['mini2', '2026-05-31T00:02:00Z'],
      ['mini3', '2026-05-31T00:02:01Z'],
    ].forEach(([host, createdAt]) => writeStormEvent(tmpRoot, host!, {
      id: `boundary-${host}`,
      createdAt,
      summary: `${host} missing required tools send_message`,
    }));

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
        BOT_ERRORS_STORM_THRESHOLD: '3',
        BOT_ERRORS_STORM_WINDOW_SECONDS: '120',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 1, sent: 1, stormCollapsed: 3, failed: 0 });
    expect(readFileSync(capturePath, 'utf8').match(/BOT ERRORS storm collapse/g)).toHaveLength(1);
  });

  it('collapses trickle storms across a fixed boundary when the rolling span is inside the window', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    [
      ['mini1', '2026-05-31T00:01:50Z'],
      ['mini2', '2026-05-31T00:02:31Z'],
      ['mini3', '2026-05-31T00:03:12Z'],
    ].forEach(([host, createdAt]) => writeStormEvent(tmpRoot, host!, {
      id: `trickle-${host}`,
      createdAt,
      summary: `${host} missing required tools send_message`,
    }));

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
        BOT_ERRORS_STORM_THRESHOLD: '3',
        BOT_ERRORS_STORM_WINDOW_SECONDS: '120',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 1, sent: 1, stormCollapsed: 3, failed: 0 });
    expect(readFileSync(capturePath, 'utf8')).toContain('BOT ERRORS storm collapse');
  });

  it('reuses an already-queued storm digest after a crash before collapsing later originals', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    const outbox = join(tmpRoot, 'outbox');
    const collapsed = join(tmpRoot, 'storm-collapsed');
    const manifests = join(tmpRoot, 'storm-manifests');
    const sent = join(tmpRoot, 'sent');
    const hosts = ['MACLAB', 'MWLAB', ...Array.from({ length: 11 }, (_, index) => `mini${index + 1}`)];
    hosts.forEach((host) => writeStormEvent(tmpRoot, host, { id: `first-${host}` }));

    const queuedOnly = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once', '--max-events', '0'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(queuedOnly)).toMatchObject({ processed: 0, sent: 0, stormCollapsed: 13, failed: 0 });
    expect(existsSync(capturePath)).toBe(false);
    expect(readdirSync(outbox).filter((file) => file.endsWith('.json'))).toHaveLength(1);

    for (const host of ['mini12', 'mini13', 'mini14']) {
      writeStormEvent(tmpRoot, host, { id: `late-${host}`, createdAt: '2026-05-31T00:00:01Z' });
    }
    const replay = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(replay)).toMatchObject({ processed: 1, sent: 1, stormCollapsed: 3, failed: 0 });
    expect(readFileSync(capturePath, 'utf8').match(/BOT ERRORS storm collapse/g)).toHaveLength(1);
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "storm_digest_reused"');
    expect(readdirSync(outbox).filter((file) => file.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync(collapsed)).toHaveLength(16);
    expect(readdirSync(sent)).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(manifests, readdirSync(manifests)[0]!), 'utf8')) as {
      entries: unknown[];
      entriesCollapsed: unknown[];
    };
    expect(manifest.entries).toHaveLength(16);
    expect(manifest.entriesCollapsed).toHaveLength(16);
  });

  it('keeps daily-health recovery noise suppressed instead of storm-posting it', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    ['mini1', 'mini2', 'mini3'].forEach((host) => writeStormEvent(tmpRoot, host, {
      id: `recovery-${host}`,
      severity: 'info',
      source: 'daily-health',
      summary: 'BOT ERRORS daily health passed',
    }));

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 3, sent: 0, suppressed: 3, stormCollapsed: 0, failed: 0 });
    expect(existsSync(capturePath)).toBe(false);
  });

  it('suppresses duplicate clear recoveries while preserving the first visible recovery', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    const sent = join(tmpRoot, 'sent');
    const suppressed = join(tmpRoot, 'suppressed');
    // The 12 clears recover one real incident; seed the open incident a prior
    // alert would have created so the surviving (first) recovery closes it and
    // surfaces. Without it every clear is orphan-suppressed (no open incident).
    seedOpenIncident(tmpRoot, 'HOST-A|Loops|llm_total_failure');
    const summaries = [
      'alert source cleared: llm_total_failure',
      ' Alert   Source   Cleared:   llm_total_failure ',
    ];
    for (let index = 0; index < 12; index += 1) {
      writeRecoveryEvent(tmpRoot, index, {
        id: `duplicate-clear-${index}`,
        createdAt: `2026-05-31T00:00:${String(index).padStart(2, '0')}Z`,
        summary: summaries[index % summaries.length],
      });
    }

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
        BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS: '120',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({
      processed: 1,
      sent: 1,
      suppressed: 11,
      recoveryDeduped: 11,
      failed: 0,
    });
    expect(readFileSync(capturePath, 'utf8').match(/BOT RECOVERY/g)).toHaveLength(1);
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "recovery_duplicate_suppressed"');
    expect(readdirSync(sent)).toHaveLength(1);
    expect(readdirSync(suppressed)).toHaveLength(11);
    const state = JSON.parse(readFileSync(join(tmpRoot, 'dispatcher-state.json'), 'utf8')) as {
      counts: { outbox: number; sent: number; suppressed: number };
      recoveryDeduped: number;
      suppressed: number;
    };
    expect(state.counts).toMatchObject({ outbox: 0, sent: 1, suppressed: 11 });
    expect(state.recoveryDeduped).toBe(11);
    expect(state.suppressed).toBe(11);
    const suppressedEvent = JSON.parse(readFileSync(join(suppressed, readdirSync(suppressed)[0]!), 'utf8')) as {
      delivery: { status: string; suppressedReason: string; attempts: number };
    };
    expect(suppressedEvent.delivery.status).toBe('suppressed');
    expect(suppressedEvent.delivery.suppressedReason).toContain('duplicate recovery/info event');
    expect(suppressedEvent.delivery.attempts).toBe(0);
  });

  it('uses conservative recovery normalization without stripping distinguishing tokens', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    writeRecoveryEvent(tmpRoot, 1, {
      id: 'distinct-run-123',
      summary: 'alert source cleared: llm_total_failure run=123 at 2026-05-31T00:01:00Z',
    });
    writeRecoveryEvent(tmpRoot, 2, {
      id: 'distinct-run-124',
      summary: 'alert source cleared: llm_total_failure run=124 at 2026-05-31T00:01:00Z',
    });
    writeRecoveryEvent(tmpRoot, 3, {
      id: 'distinct-host',
      machine: 'HOST-B',
      summary: 'alert source cleared: llm_total_failure run=123 at 2026-05-31T00:01:00Z',
    });
    writeRecoveryEvent(tmpRoot, 4, {
      id: 'distinct-source',
      source: 'tool_call_failure',
      summary: 'alert source cleared: llm_total_failure run=123 at 2026-05-31T00:01:00Z',
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

    // recoveryDeduped: 0 is the property under test: the four recoveries carry
    // distinguishing tokens (run=123 vs run=124, a different host, a different
    // source) that must land in four DISTINCT recovery fingerprints, so none is
    // collapsed as a duplicate. If normalization stripped any of those tokens,
    // recoveryDeduped would rise above 0. Each recovery has no matching open
    // incident, so all four are orphan-suppressed rather than surfaced — that is
    // orthogonal to the conservative-normalization property this test guards.
    expect(JSON.parse(output)).toMatchObject({ processed: 4, sent: 0, suppressed: 4, recoveryDeduped: 0, failed: 0 });
    const reasons = readdirSync(join(tmpRoot, 'suppressed')).map(
      (file) =>
        (JSON.parse(readFileSync(join(tmpRoot, 'suppressed', file), 'utf8')) as { delivery: { suppressedReason: string } })
          .delivery.suppressedReason,
    );
    expect(reasons).toHaveLength(4);
    // "no open incident" (not the recovery-duplicate reason) confirms each event
    // reached should_suppress_send as its own distinct recovery — none was merged.
    expect(reasons.every((reason) => reason.includes('no open incident'))).toBe(true);
  });

  it('does not redact 10-to-15 digit recovery tokens into the same duplicate fingerprint', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    writeRecoveryEvent(tmpRoot, 1, {
      id: 'bytes-free-1733000111',
      summary: 'disk recovery bytesFree=1733000111 ok',
    });
    writeRecoveryEvent(tmpRoot, 2, {
      id: 'bytes-free-1733000999',
      summary: 'disk recovery bytesFree=1733000999 ok',
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

    // recoveryDeduped: 0 is the property under test: bytesFree=1733000111 and
    // bytesFree=1733000999 are 10-to-15 digit tokens that must NOT be redacted to
    // one fingerprint. Distinct fingerprints mean neither recovery is collapsed as
    // a duplicate; if the tokens were redacted alike, one would be recovery-deduped
    // (recoveryDeduped: 1). Both then have no open incident and are orphan-
    // suppressed — orthogonal to the fingerprint-distinctness property guarded here.
    expect(JSON.parse(output)).toMatchObject({ processed: 2, sent: 0, suppressed: 2, recoveryDeduped: 0, failed: 0 });
    const reasons = readdirSync(join(tmpRoot, 'suppressed')).map(
      (file) =>
        (JSON.parse(readFileSync(join(tmpRoot, 'suppressed', file), 'utf8')) as { delivery: { suppressedReason: string } })
          .delivery.suppressedReason,
    );
    expect(reasons).toHaveLength(2);
    // Both carry the orphan reason (not the recovery-duplicate reason), confirming
    // the two distinct-token recoveries were never merged by the dedupe pass.
    expect(reasons.every((reason) => reason.includes('no open incident'))).toBe(true);
  });

  it('does not suppress a clear separated from the previous clear by a same-fingerprint alert', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    // Seed the incident the first clear recovers (a prior alert would have opened
    // it). The same-fingerprint critical alert between the two clears reopens the
    // incident, so the second clear also closes an open incident and surfaces;
    // both recoveries are therefore non-orphan. This isolates the dedupe-barrier
    // property: the alert splits the two clears into separate recovery episodes so
    // the second is not suppressed as a duplicate of the first.
    seedOpenIncident(tmpRoot, 'HOST-A|Loops|llm_total_failure');
    writeRecoveryEvent(tmpRoot, 0, {
      id: 'flap-clear-before',
      createdAt: '2026-05-31T00:00:00Z',
      summary: 'flapping source restored',
    });
    writeRecoveryEvent(tmpRoot, 1, {
      id: 'flap-alert-between',
      eventType: 'alert',
      severity: 'critical',
      createdAt: '2026-05-31T00:00:30Z',
      summary: 'flapping source restored',
    });
    writeRecoveryEvent(tmpRoot, 2, {
      id: 'flap-clear-after',
      createdAt: '2026-05-31T00:01:00Z',
      summary: 'flapping source restored',
    });

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
        BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS: '120',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 3, sent: 3, suppressed: 0, recoveryDeduped: 0, failed: 0 });
    const rendered = readFileSync(capturePath, 'utf8');
    expect(rendered.match(/BOT RECOVERY/g)).toHaveLength(2);
    expect(rendered).toContain('BOT ERROR - flapping source restored');
  });

  it('prune_suppressed uses delivery.suppressedAt from event JSON, not file mtime, to determine oldest', () => {
    // The five files are written with mtimes in ASCENDING order (old-0 oldest by mtime)
    // but suppressedAt timestamps in DESCENDING order (old-0 newest by suppressedAt).
    // Correct behavior: prune old-4 and old-3 (oldest by suppressedAt).
    // Mtime-only behavior: prune old-0 and old-1 (oldest by mtime) — wrong.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const suppressed = join(tmpRoot, 'suppressed');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    mkdirSync(suppressed, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 5; index += 1) {
      const file = join(suppressed, `flip-${index}.json.suppressed`);
      // suppressedAt in descending order: flip-0 is newest, flip-4 is oldest
      const suppressedAt = new Date(Date.UTC(2026, 4, 31, 0, 4 - index, 0)).toISOString();
      writeFileSync(file, JSON.stringify({
        id: `flip-${index}`,
        delivery: { status: 'suppressed', suppressedAt, suppressedReason: 'test' },
      }), { mode: 0o600 });
      // mtime in ascending order: flip-0 is oldest mtime, flip-4 is newest mtime
      const mtime = new Date(Date.UTC(2026, 4, 31, 0, index, 0));
      utimesSync(file, mtime, mtime);
    }

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_SUPPRESSED_MAX_FILES: '3',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ suppressedPruned: 2 });
    const remaining = readdirSync(suppressed).sort();
    // flip-0, flip-1, flip-2 must survive (newest suppressedAt)
    expect(remaining).toEqual(['flip-0.json.suppressed', 'flip-1.json.suppressed', 'flip-2.json.suppressed']);
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "suppressed_pruned"');
  });

  it('caps retained suppressed events after accounting for newly suppressed duplicates', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const suppressed = join(tmpRoot, 'suppressed');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    mkdirSync(suppressed, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 5; index += 1) {
      const file = join(suppressed, `old-${index}.json.suppressed`);
      writeFileSync(file, JSON.stringify({ id: `old-${index}` }), { mode: 0o600 });
      const mtime = new Date(Date.UTC(2026, 4, 31, 0, index, 0));
      utimesSync(file, mtime, mtime);
    }

    const output = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_SUPPRESSED_MAX_FILES: '3',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toMatchObject({ processed: 0, sent: 0, suppressed: 0, suppressedPruned: 2, failed: 0 });
    expect(readdirSync(suppressed)).toHaveLength(3);
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "suppressed_pruned"');
    const state = JSON.parse(readFileSync(join(tmpRoot, 'dispatcher-state.json'), 'utf8')) as {
      counts: { suppressed: number };
      suppressedPruned: number;
    };
    expect(state.counts.suppressed).toBe(3);
    expect(state.suppressedPruned).toBe(2);
  });

  it('suppresses test-provenance events and sends one path-free debounced meta-alert', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const suppressed = join(tmpRoot, 'suppressed');
    const eventRuntime = {
      provenance: {
        producer: 'ts-lib',
        test: true,
        signals: ['VITEST'],
        strongSignals: ['VITEST'],
        outboxPolicy: 'explicit-outbox',
        liveOutboxRedirected: false,
        resolvedOutbox: join(tmpRoot, 'home', '.local', 'state', 'bot-errors', 'outbox'),
      },
    };
    writeStormEvent(tmpRoot, 'MACLAB', {
      id: 'test-provenance-1',
      severity: 'warning',
      source: 'test-source',
      summary: 'test event should not page q',
      runtime: eventRuntime,
    });
    writeStormEvent(tmpRoot, 'MWLAB', {
      id: 'test-provenance-2',
      severity: 'warning',
      source: 'test-source',
      summary: 'second test event should not page q',
      runtime: eventRuntime,
    });

    const first = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
        BOT_ERRORS_TEST_PROVENANCE_META_WINDOW_SECONDS: '900',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(first)).toMatchObject({
      processed: 1,
      sent: 1,
      suppressed: 2,
      testProvenanceSuppressed: 2,
      testProvenanceMetaAlerted: 1,
      failed: 0,
    });
    expect(readdirSync(suppressed)).toHaveLength(2);
    const rendered = readFileSync(capturePath, 'utf8');
    expect(rendered.match(/dispatcher refused test-provenance events/g)).toHaveLength(1);
    expect(rendered).toContain('refused_events:2');
    expect(rendered).not.toContain(tmpRoot);
    expect(rendered).not.toContain('/home/');
    expect(rendered).not.toContain('resolvedOutbox');

    writeStormEvent(tmpRoot, 'mini1', {
      id: 'test-provenance-3',
      severity: 'warning',
      source: 'test-source',
      summary: 'third test event debounced',
      runtime: eventRuntime,
    });
    const second = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
        BOT_ERRORS_TEST_PROVENANCE_META_WINDOW_SECONDS: '900',
      },
      encoding: 'utf8',
    });

    expect(JSON.parse(second)).toMatchObject({
      processed: 0,
      sent: 0,
      suppressed: 1,
      testProvenanceSuppressed: 1,
      testProvenanceMetaAlerted: 0,
      failed: 0,
    });
    expect(readFileSync(capturePath, 'utf8').match(/dispatcher refused test-provenance events/g)).toHaveLength(1);
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

  it('does not treat a stable id with a new createdAt as a writefail duplicate', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const sent = join(tmpRoot, 'sent');
    mkdirSync(sent, { recursive: true, mode: 0o700 });
    writeFileSync(join(sent, '20260531T000000Z.stable-recurring.json.sent'), JSON.stringify({
      id: 'stable-recurring',
      createdAt: '2026-05-31T00:00:00Z',
      delivery: { status: 'sent' },
    }));
    writeWritefail(tmpRoot, {
      id: 'stable-recurring',
      createdAt: '2026-05-31T00:05:00Z',
      summary: 'stable id new occurrence should recover',
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
    expect(readFileSync(capturePath, 'utf8')).toContain('stable id new occurrence should recover');
    expect(readdirSync(sent)).toHaveLength(2);
  });

  it('caps recovered writefail filenames while preserving the recovered event id', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const sent = join(tmpRoot, 'sent');
    const writefail = join(tmpRoot, 'writefail');
    const eventId = `writefail/unsafe-${'x'.repeat(220)}`;
    mkdirSync(writefail, { recursive: true, mode: 0o700 });
    const event = {
      schemaVersion: 1,
      id: eventId,
      eventType: 'alert',
      severity: 'critical',
      createdAt: '2026-05-31T00:00:00Z',
      machine: 'test-machine',
      instance: `ana-bot-${'i'.repeat(100)}`,
      source: `wf/source-${'s'.repeat(100)}`,
      summary: 'long recovered writefail filename',
      evidence: 'filename cap regression',
      diagnostics: { logHints: ['launchd health log'], queue: join(tmpRoot, 'outbox') },
      delivery: { attempts: 0, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    };
    writeFileSync(join(writefail, 'unsafe-id-payload.writefail'), JSON.stringify({
      schemaVersion: 1,
      kind: 'outbox_write_failure',
      recordedAt: '2026-05-31T00:00:01Z',
      failedTarget: join(tmpRoot, 'outbox'),
      reason: 'PermissionError: denied',
      emitPid: 456,
      event,
    }));

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
    const sentFiles = readdirSync(sent).filter((file) => file.endsWith('.sent'));
    expect(sentFiles).toHaveLength(1);
    expect(sentFiles[0]!.length).toBeLessThanOrEqual(180);
    expect(sentFiles[0]).toMatch(/\.sent$/);
    const sentEvent = JSON.parse(readFileSync(join(sent, sentFiles[0]!), 'utf8')) as { id: string };
    expect(sentEvent.id).toBe(eventId);
    expect(readFileSync(capturePath, 'utf8')).toContain('long recovered writefail filename');
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

  // BE-G5: a transient WhatsApp-transport disconnect (the dispatcher's own send
  // socket briefly down) must not be conflated with a permanent/content failure.
  // It rides its own retry budget and redelivers when transport recovers, instead
  // of burning the 10-attempt permanent cap and dead-lettering a deliverable alert.
  it('defers a transient WhatsApp-disconnect delivery failure instead of dead-lettering it at the attempt cap', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const outbox = join(tmpRoot, 'outbox');
    const deadLetter = join(tmpRoot, 'dead-letter');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    // attempts: 9 → the next attempt reaches the permanent cap (10). A permanent
    // failure here dead-letters; a transient transport blip must not.
    writeEvent(tmpRoot, 'critical', {
      id: 'transient-disconnect-test',
      summary: 'transient disconnect must stay deliverable',
      delivery: { attempts: 9, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    });

    spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_FAIL: 'WhatsApp is temporarily disconnected. Try again in a moment.',
      },
      encoding: 'utf8',
    });

    const deadFiles = existsSync(deadLetter) ? readdirSync(deadLetter).filter((f) => f.endsWith('.json')) : [];
    expect(deadFiles).toHaveLength(0);
    const queuedFiles = readdirSync(outbox).filter((f) => f.endsWith('.json'));
    expect(queuedFiles).toHaveLength(1);
    const queued = JSON.parse(readFileSync(join(outbox, queuedFiles[0]!), 'utf8')) as {
      delivery: { attempts: number; status: string; transientAttempts?: number };
    };
    // The transient try is tracked on its own counter and does NOT advance the
    // permanent attempt budget that drives email fallback + dead-letter.
    expect(queued.delivery.transientAttempts).toBeGreaterThanOrEqual(1);
    expect(queued.delivery.attempts).toBeLessThan(10);
    expect(queued.delivery.status).toBe('queued');
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "send_deferred_transient"');
  });

  // BE-G5 fail-safe: a genuinely-undeliverable (permanent/content) failure must
  // STILL dead-letter at the cap so a real undeliverable alert surfaces — the
  // transient carve-out must not over-suppress.
  it('still dead-letters a permanent delivery failure once the attempt cap is exhausted', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-'));
    const deadLetter = join(tmpRoot, 'dead-letter');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    writeEvent(tmpRoot, 'critical', {
      id: 'permanent-failure-test',
      summary: 'permanent failure must dead-letter',
      delivery: { attempts: 9, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    });

    spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_FAIL: 'send_message returned error: chat not found',
      },
      encoding: 'utf8',
    });

    const deadFiles = existsSync(deadLetter) ? readdirSync(deadLetter).filter((f) => f.endsWith('.json')) : [];
    expect(deadFiles).toHaveLength(1);
    // The dead-lettered record is the permanent-failure event itself (a fresh
    // dead-letter meta-alert is separately queued to the outbox — expected).
    const deadRecord = JSON.parse(readFileSync(join(deadLetter, deadFiles[0]!), 'utf8')) as { event: { id: string } };
    expect(deadRecord.event.id).toBe('permanent-failure-test');
    expect(readFileSync(dispatchLog, 'utf8')).toContain('"type": "dead_lettered"');
  });
});

describe('release-proof drill: two-run alert/clear traversal', () => {
  const DRILL_SOURCE = 'release_proof_drill';
  const DRILL_INSTANCE = 'drill-synthetic';
  // bot-errors-emit.py stamps runtime.provenance.test=true whenever any of
  // these vars are present in ITS OWN process env (STRONG_TEST_SIGNAL_KEYS in
  // deploy/scripts/bot-errors-emit.py). The dispatcher's
  // suppress_test_provenance_events() backstop then refuses any such event
  // before it ever reaches should_suppress_send. This drill exists to prove
  // the real incident lifecycle (open / duplicate / clear / orphan), so the
  // emitted event must look production-shaped rather than vitest-shaped —
  // strip the signals from the emitter's env only (the dispatcher itself
  // never reads these vars, confirmed by grep of bot-errors-dispatcher.py).
  const TEST_SIGNAL_ENV_KEYS = ['VITEST', 'VITEST_WORKER_ID', 'JEST_WORKER_ID', 'PYTEST_CURRENT_TEST'];

  function emitDrill(root: string, extra: string[]): void {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BOT_ERRORS_STATE_DIR: root,
      BOT_ERRORS_INLINE_LOG_TAIL: '0',
    };
    for (const key of TEST_SIGNAL_ENV_KEYS) delete env[key];
    execFileSync('python3', ['deploy/scripts/bot-errors-emit.py', ...extra], {
      cwd: process.cwd(),
      env,
    });
  }

  function dispatchOnce(root: string, capture: string): string {
    return execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: root,
        BOT_ERRORS_DRY_SEND_CAPTURE: capture,
        BOT_ERRORS_INLINE_LOG_TAIL: '0',
      },
    });
  }

  function dirCount(root: string, name: string): number {
    const dir = join(root, name);
    return existsSync(dir) ? readdirSync(dir).length : 0;
  }

  it('one warning then one same-key clear; duplicates suppressed; queues drain', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-drill-'));
    const capture = join(tmpRoot, 'capture.jsonl');
    const dispatchLog = join(tmpRoot, 'logs', 'dispatch.jsonl');
    const alertArgs = [
      '--severity', 'warning',
      '--source', DRILL_SOURCE,
      '--instance', DRILL_INSTANCE,
      '--summary', 'release-proof drill alert',
    ];
    const clearArgs = ['--clear', '--source', DRILL_SOURCE, '--instance', DRILL_INSTANCE];

    // Run 1: alert opens an incident and lands in sent/.
    emitDrill(tmpRoot, alertArgs);
    const alertRun = dispatchOnce(tmpRoot, capture);
    expect(JSON.parse(alertRun)).toMatchObject({ processed: 1, sent: 1, suppressed: 0, failed: 0 });
    expect(dirCount(tmpRoot, 'outbox')).toBe(0);
    expect(dirCount(tmpRoot, 'sent')).toBe(1);
    const incidentsAfterAlert = JSON.parse(readFileSync(join(tmpRoot, 'incident-state.json'), 'utf8')) as {
      openIncidents: Record<string, unknown>;
    };
    // incident-state.json also carries a flapState ledger (Pattern F trip
    // counters) keyed the same way, which never clears on a same-key clear —
    // a whole-file substring check would false-pass a still-closed incident.
    // openIncidents is the actual open/closed observable, so assert on it
    // directly, matching the structured-parse idiom this file already uses
    // (see the daily-health-fail incident-close test above).
    const openIncidentKeys = Object.keys(incidentsAfterAlert.openIncidents);
    expect(openIncidentKeys).toHaveLength(1);
    const incidentKey = openIncidentKeys[0]!;
    expect(incidentKey).toContain(DRILL_SOURCE);
    expect(incidentKey).toContain(DRILL_INSTANCE);

    // Duplicate alert with the same key while the incident is still open. The
    // real observable (see should_suppress_send in
    // deploy/scripts/bot-errors-dispatcher.py) is the "incident already open
    // for {key}; duplicate suppressed" branch: the event is archived to
    // suppressed/, dispatch.jsonl logs a "suppressed" entry carrying that
    // reason, and — unlike the renotify-after-INCIDENT_RENOTIFY_SECONDS path —
    // no new line lands in capture.jsonl, since these two runs happen well
    // inside the (6h default) renotify window.
    emitDrill(tmpRoot, alertArgs);
    const duplicateRun = dispatchOnce(tmpRoot, capture);
    expect(JSON.parse(duplicateRun)).toMatchObject({ processed: 1, sent: 0, suppressed: 1, failed: 0 });
    expect(dirCount(tmpRoot, 'outbox')).toBe(0);
    expect(readFileSync(dispatchLog, 'utf8')).toContain('duplicate suppressed');
    const alertMessagesAfterDuplicate = captureMessages(capture).filter((text) => text.includes('release-proof drill alert'));
    expect(alertMessagesAfterDuplicate).toHaveLength(1);

    // Run 2: same-key clear closes the incident.
    emitDrill(tmpRoot, clearArgs);
    const clearRun = dispatchOnce(tmpRoot, capture);
    expect(JSON.parse(clearRun)).toMatchObject({ processed: 1, sent: 1, suppressed: 0, failed: 0 });
    const incidentsAfterClear = JSON.parse(readFileSync(join(tmpRoot, 'incident-state.json'), 'utf8')) as {
      openIncidents: Record<string, unknown>;
    };
    expect(incidentsAfterClear.openIncidents).not.toHaveProperty(incidentKey);
    const messagesAfterClear = captureMessages(capture);
    expect(messagesAfterClear).toHaveLength(2);
    expect(messagesAfterClear[1]).toContain('BOT RECOVERY');
    expect(messagesAfterClear[1]).toContain(DRILL_SOURCE);

    // Orphan clear: the incident is already closed, so this clear has no open
    // incident to recover. should_suppress_send's "clear has no open incident
    // for {key}; stale recovery suppressed" branch fires — the same "no open
    // incident" wording asserted in
    // deploy/scripts/tests/test_bot_errors_orphan_clear_suppression.py.
    emitDrill(tmpRoot, clearArgs);
    const orphanRun = dispatchOnce(tmpRoot, capture);
    expect(JSON.parse(orphanRun)).toMatchObject({ processed: 1, sent: 0, suppressed: 1, failed: 0 });
    expect(readFileSync(dispatchLog, 'utf8')).toContain('no open incident');

    for (const queue of ['outbox', 'processing', 'writefail', 'dead-letter', 'quarantine']) {
      expect(dirCount(tmpRoot, queue), `${queue} not drained`).toBe(0);
    }
    const rendered = readFileSync(capture, 'utf8');
    expect(rendered).toContain('release-proof drill alert');
  });
});

describe('still-open reminder exponential backoff', () => {
  // Production defect (2026-07-17, fleet coordinator host): "ESCALATED still open" reminders for
  // long-open incidents (release drift, degraded health) re-paged at the fixed
  // renotify interval indefinitely, drowning the BOT ERRORS group. The reminder
  // cadence must back off exponentially per incident_key — first reminder after
  // the base interval as today, doubling per sent reminder, capped — and the
  // backoff must persist in incident-state.json so restarts do not reset it
  // (every dispatchBackoff() call below IS a fresh dispatcher process).
  const BACKOFF_SOURCE = 'backoff_drill';
  const BACKOFF_INSTANCE = 'drill-backoff';
  const TEST_SIGNAL_ENV_KEYS = ['VITEST', 'VITEST_WORKER_ID', 'JEST_WORKER_ID', 'PYTEST_CURRENT_TEST'];

  function emitBackoffAlert(root: string): void {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BOT_ERRORS_STATE_DIR: root,
      BOT_ERRORS_INLINE_LOG_TAIL: '0',
    };
    for (const key of TEST_SIGNAL_ENV_KEYS) delete env[key];
    execFileSync('python3', ['deploy/scripts/bot-errors-emit.py',
      '--severity', 'warning',
      '--source', BACKOFF_SOURCE,
      '--instance', BACKOFF_INSTANCE,
      '--summary', 'backoff drill alert',
    ], { cwd: process.cwd(), env });
  }

  function dispatchBackoff(root: string, capture: string, extraEnv: Record<string, string> = {}): string {
    return execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: root,
        BOT_ERRORS_DRY_SEND_CAPTURE: capture,
        BOT_ERRORS_INLINE_LOG_TAIL: '0',
        BOT_ERRORS_INCIDENT_RENOTIFY_SECONDS: '60',
        ...extraEnv,
      },
    });
  }

  type OpenRecord = Record<string, unknown> & { renotifyIntervalSeconds?: number };

  function readIncidentState(root: string): { openIncidents: Record<string, OpenRecord> } {
    return JSON.parse(readFileSync(join(root, 'incident-state.json'), 'utf8'));
  }

  function patchOpenRecord(root: string, key: string, patch: Record<string, unknown>): void {
    const statePath = join(root, 'incident-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { openIncidents: Record<string, OpenRecord> };
    state.openIncidents[key] = { ...state.openIncidents[key], ...patch };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  it('doubles the still-open reminder interval per incident and persists it across dispatcher runs', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-backoff-'));
    const capture = join(tmpRoot, 'capture.jsonl');

    // Initial escalation is immediate, exactly as today.
    emitBackoffAlert(tmpRoot);
    expect(JSON.parse(dispatchBackoff(tmpRoot, capture))).toMatchObject({ processed: 1, sent: 1, suppressed: 0 });
    const key = Object.keys(readIncidentState(tmpRoot).openIncidents)[0]!;
    expect(key).toContain(BACKOFF_SOURCE);

    // Make the incident long-open (escalated) and due for its FIRST reminder:
    // 90s since last notification >= 60s base interval.
    let now = Math.floor(Date.now() / 1000);
    patchOpenRecord(tmpRoot, key, { openedAt: now - 100000, lastNotifiedAt: now - 90, lastSentAt: now - 90 });
    emitBackoffAlert(tmpRoot);
    expect(JSON.parse(dispatchBackoff(tmpRoot, capture))).toMatchObject({ processed: 1, sent: 1, suppressed: 0 });
    const reminders = captureMessages(capture).filter((text) => text.includes('ESCALATED still open'));
    expect(reminders).toHaveLength(1);
    // The doubled interval is durably recorded on the open incident record.
    expect(readIncidentState(tmpRoot).openIncidents[key]!.renotifyIntervalSeconds).toBe(120);

    // 90s since the first reminder: past the fixed 60s cadence (the old defect
    // re-paged here every cycle) but inside the doubled 120s interval -> suppressed.
    now = Math.floor(Date.now() / 1000);
    patchOpenRecord(tmpRoot, key, { lastNotifiedAt: now - 90, lastSentAt: now - 90 });
    emitBackoffAlert(tmpRoot);
    expect(JSON.parse(dispatchBackoff(tmpRoot, capture))).toMatchObject({ processed: 1, sent: 0, suppressed: 1 });
    expect(captureMessages(capture).filter((text) => text.includes('ESCALATED still open'))).toHaveLength(1);

    // 130s since the first reminder: past the doubled interval -> second
    // reminder sends and the interval doubles again.
    now = Math.floor(Date.now() / 1000);
    patchOpenRecord(tmpRoot, key, { lastNotifiedAt: now - 130, lastSentAt: now - 130 });
    emitBackoffAlert(tmpRoot);
    expect(JSON.parse(dispatchBackoff(tmpRoot, capture))).toMatchObject({ processed: 1, sent: 1, suppressed: 0 });
    expect(captureMessages(capture).filter((text) => text.includes('ESCALATED still open'))).toHaveLength(2);
    expect(readIncidentState(tmpRoot).openIncidents[key]!.renotifyIntervalSeconds).toBe(240);
  });

  it('caps the reminder backoff at the configured ceiling', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-backoff-'));
    const capture = join(tmpRoot, 'capture.jsonl');
    const capEnv = { BOT_ERRORS_INCIDENT_RENOTIFY_CAP_SECONDS: '180' };

    emitBackoffAlert(tmpRoot);
    expect(JSON.parse(dispatchBackoff(tmpRoot, capture, capEnv))).toMatchObject({ processed: 1, sent: 1 });
    const key = Object.keys(readIncidentState(tmpRoot).openIncidents)[0]!;

    // Stored interval above the cap is clamped: due after 200s >= cap 180s.
    let now = Math.floor(Date.now() / 1000);
    patchOpenRecord(tmpRoot, key, {
      openedAt: now - 100000,
      lastNotifiedAt: now - 200,
      lastSentAt: now - 200,
      renotifyIntervalSeconds: 960,
    });
    emitBackoffAlert(tmpRoot);
    expect(JSON.parse(dispatchBackoff(tmpRoot, capture, capEnv))).toMatchObject({ processed: 1, sent: 1, suppressed: 0 });
    // Advancing from the cap stays at the cap.
    expect(readIncidentState(tmpRoot).openIncidents[key]!.renotifyIntervalSeconds).toBe(180);

    // Inside the capped interval -> suppressed even though far past the base interval.
    now = Math.floor(Date.now() / 1000);
    patchOpenRecord(tmpRoot, key, { lastNotifiedAt: now - 170, lastSentAt: now - 170 });
    emitBackoffAlert(tmpRoot);
    expect(JSON.parse(dispatchBackoff(tmpRoot, capture, capEnv))).toMatchObject({ processed: 1, sent: 0, suppressed: 1 });
  });
});
