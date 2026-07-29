import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  botErrorsOutboxDir,
  buildBotErrorsEvent,
  recordBotErrorsWritefail,
  writeBotErrorsEvent,
  type BotErrorsCriticalAssetDiagnostic,
} from '../../src/lib/bot-errors-outbox.ts';

const ENV_KEYS = [
  'BOT_ERRORS_ALLOW_LIVE_IN_TESTS',
  'BOT_ERRORS_DRY_PLATFORM',
  'BOT_ERRORS_DRY_PLATFORM_RELEASE',
  'BOT_ERRORS_OUTBOX_DIR',
  'BOT_ERRORS_STATE_DIR',
  'BOT_ERRORS_WRITEFAIL_DIR',
  'INVOCATION_ID',
  'LOG_DIR',
  'NODE_ENV',
  'SYSTEMD_EXEC_PID',
  'TMPDIR',
  'VITEST',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID',
  'WHATSOUP_VISIBLE_FLAG',
  'WHATSOUP_SECRET_TOKEN',
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

let tmpRoot = '';

function restoreEnv(): void {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  vi.doUnmock('../../src/lib/private-fs.ts');
  vi.resetModules();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('buildBotErrorsEvent', () => {
  it('defaults blank routing fields and uses Linux journalctl hints', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-build-'));
    process.env['BOT_ERRORS_STATE_DIR'] = join(tmpRoot, 'state');
    process.env['BOT_ERRORS_DRY_PLATFORM'] = 'linux';
    process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'] = '6.8.0-generic';
    process.env['LOG_DIR'] = join(tmpRoot, 'logs');
    process.env['NODE_ENV'] = 'test';
    process.env['WHATSOUP_VISIBLE_FLAG'] = '1';
    process.env['WHATSOUP_SECRET_TOKEN'] = 'must-not-list';
    process.env['INVOCATION_ID'] = 'systemd-invocation';
    process.env['SYSTEMD_EXEC_PID'] = '4242';

    const event = buildBotErrorsEvent({
      eventType: 'clear',
      instance: '   ',
      source: '   ',
      summary: '   ',
    }, '11111111-1111-4111-8111-111111111111', '2026-06-13T10:00:00.000Z');

    expect(event).toMatchObject({
      schemaVersion: 2,
      eventKind: 'incident_recovery',
      id: '11111111-1111-4111-8111-111111111111',
      eventType: 'clear',
      severity: 'info',
      instance: 'unknown',
      source: 'unknown',
      schemaVersion: 2,
      runtime: {
        invocationId: 'systemd-invocation',
        systemdExecPid: '4242',
      },
      diagnostics: {
        queue: join(tmpRoot, 'state', 'outbox'),
      },
    });
    // Issue #2386: summary and evidence are now bounded objects, not raw strings.
    expect(event.summary).toHaveProperty('failureClass');
    expect(event.summary).toHaveProperty('length');
    expect(event.summary).toHaveProperty('correlationDigest');
    expect(event.evidence).toHaveProperty('failureClass', 'none');
    expect(event.evidence).toHaveProperty('length', 0);
    // Issue #2386: envKeys and logHints are stripped (contain paths/args).
    expect(event.runtime).not.toHaveProperty('envKeys');
    expect(event.diagnostics).not.toHaveProperty('logHints');
  });

  it('emits only declared v2 envelope variants', () => {
    const variants = [
      {
        input: { eventType: 'alert' as const, severity: 'error' as const },
        expected: { eventKind: 'incident_alert', eventType: 'alert', severity: 'error' },
      },
      {
        input: { eventType: 'clear' as const, severity: 'info' as const },
        expected: { eventKind: 'incident_recovery', eventType: 'clear', severity: 'info' },
      },
      {
        input: { eventType: 'observation' as const, severity: 'info' as const },
        expected: { eventKind: 'observation', eventType: 'observation', severity: 'info' },
      },
    ];

    for (const { input, expected } of variants) {
      const event = buildBotErrorsEvent({
        ...input,
        instance: 'typed-envelope',
        source: 'unit-test',
        summary: 'declared envelope variant',
      });
      expect(event).toMatchObject({ schemaVersion: 2, ...expected });
    }

    const informationalAlert = buildBotErrorsEvent({
      eventType: 'alert',
      severity: 'info',
      instance: 'typed-envelope',
      source: 'invalid-alert',
      summary: 'informational alerts are observations, not incidents',
    });
    expect(informationalAlert).toMatchObject({
      schemaVersion: 2,
      eventKind: 'observation',
      eventType: 'observation',
      severity: 'info',
    });
    expect(() => buildBotErrorsEvent({
      eventType: 'clear',
      severity: 'critical',
      instance: 'typed-envelope',
      source: 'invalid-clear',
      summary: 'critical clears cannot authorize recovery',
    })).toThrow('invalid bot errors envelope');
  });

  it('redacts nested critical asset diagnostics without dropping primitive values', () => {
    const criticalAsset: BotErrorsCriticalAssetDiagnostic = {
      asset: {
        kind: 'credential',
        instance: 'agent-alpha',
        owner: 'line=15555550123',
        path: join('/tmp', 'fixture', '.config', 'whatsoup', 'instances', 'agent-alpha', 'tokens.env'),
        fingerprint: 'fp-123',
      },
      failure: {
        code: 'CREDENTIAL_EXPOSED',
        domain: 'provider',
        recoverability: 'manual_repair_required',
        confidence: 'confirmed',
        operatorAction: 'rotate token=raw-secret',
        clearRequirement: 'verify for +1 (555) 123-4567',
      },
      evidenceRefs: [
        'Authorization: Bearer topsecret',
        ['https://user:pass', 'example.invalid/path'].join('@'),
      ],
    };

    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'agent-alpha',
      source: 'provider_auth',
      summary: 'provider token=raw-secret failed',
      evidence: 'cookie=session-secret phone +1 555 123 4567 escalation for 14155551234',
      criticalAsset,
    }) as ReturnType<typeof buildBotErrorsEvent> & { criticalAsset: BotErrorsCriticalAssetDiagnostic };

    // Issue #2386: summary and evidence are now confined to bounded metadata.
    expect(event.summary).toHaveProperty('failureClass');
    expect(event.evidence).toHaveProperty('failureClass');
    // Raw secrets must not appear anywhere in the serialized event.
    expect(JSON.stringify(event)).not.toContain('raw-secret');
    expect(JSON.stringify(event)).not.toContain('topsecret');
    expect(JSON.stringify(event)).not.toContain('session-secret');
    // Critical asset diagnostics are still redacted via redactOutboxValue.
    expect(event.criticalAsset.asset.path).toBe('[REDACTED CREDENTIAL PATH]');
    expect(event.criticalAsset.asset.owner).toBe('line=[REDACTED PHONE]');
    expect(event.criticalAsset.asset.fingerprint).toBe('fp-123');
    expect(event.criticalAsset.failure.operatorAction).toBe('rotate token=[REDACTED]');
    expect(event.criticalAsset.failure.clearRequirement).toContain('[REDACTED PHONE]');
    expect(event.criticalAsset.evidenceRefs).toEqual([
      'Authorization: Bearer [REDACTED]',
      ['https://[REDACTED]', 'example.invalid/path'].join('@'),
    ]);
  });

  it('masks device-suffixed (`:N`) JIDs at the redactText boundary — BEAD-048', () => {
    // The device suffix (`:N`) is the dimension the old local outbox regex
    // dropped, so such JIDs leaked verbatim into the persisted disk event
    // before the redactText path was folded onto the SSOT `jidPattern()`.
    const deviceJid = `${'123456789'}:6@${'s.whatsapp.net'}`;
    const deviceLid = `${'12345'}:6@lid`;
    const plainJid = `${'123456'}@${'s.whatsapp.net'}`;
    const dashJid = `${'123456'}-2@${'s.whatsapp.net'}`;

    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'agent-alpha',
      source: 'provider_auth',
      summary: `device chat ${deviceJid} failed`,
      evidence: `device ${deviceJid}, lid ${deviceLid}, plain ${plainJid}, dash ${dashJid}`,
    });

    // Issue #2386: JIDs are confined to bounded metadata — they must not
    // appear anywhere in the serialized event. The evidence is now an
    // object (failureClass, length, correlationDigest), not a redacted string.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(deviceJid);
    expect(serialized).not.toContain(deviceLid);
    expect(serialized).not.toContain(plainJid);
    expect(serialized).not.toContain(dashJid);
    expect(serialized).not.toContain(':6@');
    expect(typeof event.summary).toBe('object');
    expect(typeof event.evidence).toBe('object');
  });

  it('allows live outbox resolution in tests only behind the explicit override', () => {
    delete process.env['BOT_ERRORS_STATE_DIR'];
    delete process.env['BOT_ERRORS_OUTBOX_DIR'];
    process.env['BOT_ERRORS_ALLOW_LIVE_IN_TESTS'] = '1';

    expect(botErrorsOutboxDir()).toBe(join(homedir(), '.local', 'state', 'bot-errors', 'outbox'));
  });

  it('chooses the Vitest sandbox from pool id, worker id, then the main fallback', () => {
    delete process.env['BOT_ERRORS_STATE_DIR'];
    delete process.env['BOT_ERRORS_OUTBOX_DIR'];
    delete process.env['BOT_ERRORS_ALLOW_LIVE_IN_TESTS'];

    process.env['VITEST'] = 'false';
    process.env['VITEST_POOL_ID'] = 'pool/unsafe';
    delete process.env['VITEST_WORKER_ID'];
    expect(botErrorsOutboxDir()).toBe(join(
      tmpdir(),
      'whatsoup-vitest-bot-errors',
      'pool_unsafe',
      String(process.pid),
      'state',
      'outbox',
    ));

    delete process.env['VITEST_POOL_ID'];
    process.env['VITEST_WORKER_ID'] = 'worker/unsafe';
    expect(botErrorsOutboxDir()).toBe(join(
      tmpdir(),
      'whatsoup-vitest-bot-errors',
      'worker_unsafe',
      String(process.pid),
      'state',
      'outbox',
    ));

    process.env['VITEST'] = 'true';
    delete process.env['VITEST_POOL_ID'];
    delete process.env['VITEST_WORKER_ID'];
    expect(botErrorsOutboxDir()).toBe(join(
      tmpdir(),
      'whatsoup-vitest-bot-errors',
      'main',
      String(process.pid),
      'state',
      'outbox',
    ));
  });
});

describe('writeBotErrorsEvent', () => {
  it('keeps millisecond precision in the outbox filename for causal ordering', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-order-'));
    const outbox = join(tmpRoot, 'outbox');
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outbox;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-30T12:00:00.123Z'));
      const written = writeBotErrorsEvent({
        eventType: 'alert',
        instance: 'ordering-test',
        source: 'outbound_delivery_ambiguous',
        summary: 'ordering proof',
      });

      const filename = written.path.split('/').at(-1)!;
      expect(filename).toMatch(
        /^20260730T120000Z_123\.ordering-test\.outbound_delivery_ambiguous\./,
      );
      expect([
        '20260730T120000Z.ordering-test.legacy-alert.json',
        filename,
      ].sort()).toEqual([
        '20260730T120000Z.ordering-test.legacy-alert.json',
        filename,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sanitizes and caps filename segments while preserving the event payload', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-write-'));
    const outbox = join(tmpRoot, 'outbox');
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outbox;

    const longInstance = `line ${'x'.repeat(120)}/../secret`;
    const written = writeBotErrorsEvent({
      eventType: 'alert',
      instance: longInstance,
      source: 'source with spaces/and/slashes',
      summary: 'filename sanitation proof',
    });
    const file = readdirSync(outbox).find((entry) => entry.endsWith('.json'));
    const event = JSON.parse(readFileSync(written.path, 'utf8')) as { instance: string; source: string };

    expect(file).toBeDefined();
    expect(file).not.toContain(' ');
    expect(file).not.toContain('/');
    expect(file?.split('.')[1]?.length).toBeLessThanOrEqual(80);
    expect(event.instance).toBe(longInstance);
    expect(event.source).toBe('source with spaces/and/slashes');
  });

  it('uses unknown filename segments for punctuation-only routing fields', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-segments-'));
    const outbox = join(tmpRoot, 'outbox');
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outbox;

    const written = writeBotErrorsEvent({
      eventType: 'alert',
      instance: '///',
      source: '***',
      summary: 'punctuation-only route names',
    });
    const file = readdirSync(outbox).find((entry) => entry.endsWith('.json'));
    const event = JSON.parse(readFileSync(written.path, 'utf8')) as { instance: string; source: string };

    expect(file).toContain('.unknown.unknown.');
    expect(event.instance).toBe('///');
    expect(event.source).toBe('***');
  });

  it('keeps the event durable when directory fsync is unavailable', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-fsync-'));
    const outbox = join(tmpRoot, 'outbox');
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outbox;
    let directoryOpenAttempts = 0;

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        openSync: vi.fn((
          path: Parameters<typeof actual.openSync>[0],
          flags: Parameters<typeof actual.openSync>[1],
          mode?: Parameters<typeof actual.openSync>[2],
        ) => {
          if (flags === 'r') {
            directoryOpenAttempts += 1;
            throw new Error(`directory fsync unavailable: ${String(path)}`);
          }
          return actual.openSync(path, flags, mode);
        }),
      };
    });
    const { writeBotErrorsEvent: writeWithBlockedDirectoryFsync } = await import('../../src/lib/bot-errors-outbox.ts');

    const written = writeWithBlockedDirectoryFsync({
      eventType: 'alert',
      instance: 'agent',
      source: 'fsync',
      summary: 'directory fsync fallback',
    });

    expect(JSON.parse(readFileSync(written.path, 'utf8'))).toMatchObject({
      instance: 'agent',
      source: 'fsync',
      schemaVersion: 2,
    });
    expect(directoryOpenAttempts).toBeGreaterThan(0);
  });
});

describe('recordBotErrorsWritefail', () => {
  it('uses unknown filename segments and stringifies primitive write errors', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-primitive-'));
    const writefail = join(tmpRoot, 'writefail');
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefail;
    delete process.env['TMPDIR'];

    const path = recordBotErrorsWritefail(
      { evidence: ['token=raw-secret', 123, null] },
      'disk token=raw-secret',
      join(tmpRoot, 'outbox', 'event-token=raw-secret.json'),
    );

    expect(path).toEqual(expect.stringContaining('.unknown.unknown.writefail'));
    const crumb = JSON.parse(readFileSync(path!, 'utf8')) as {
      reason: string;
      failedTarget: string;
      event: { evidence: unknown[] };
    };
    expect(crumb.reason).toBe('disk token=[REDACTED]');
    expect(crumb.failedTarget).toContain('event-token=[REDACTED]');
    expect(crumb.failedTarget).not.toContain('raw-secret.json');
    expect(crumb.event.evidence).toEqual(['token=[REDACTED]', 123, null]);
    expect(JSON.stringify(crumb)).not.toContain('raw-secret');
  });

  it('returns null when every writefail directory is unavailable', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-none-'));
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = join(tmpRoot, 'primary');
    process.env['BOT_ERRORS_STATE_DIR'] = join(tmpRoot, 'state');
    process.env['TMPDIR'] = join(tmpRoot, 'tmp');
    mkdirSync(process.env['TMPDIR'], { recursive: true });

    vi.resetModules();
    vi.doMock('../../src/lib/private-fs.ts', () => ({
      forceEnsurePrivateDirectorySync: () => {
        throw new Error('no writable private directories');
      },
    }));
    const { recordBotErrorsWritefail: recordWithBlockedDirs } = await import('../../src/lib/bot-errors-outbox.ts');

    expect(recordWithBlockedDirs(
      { id: 'evt', instance: 'agent' },
      new Error('outbox failed'),
      join(tmpRoot, 'outbox', 'event.json'),
    )).toBeNull();
  });

  it('skips an unusable primary writefail path and writes to the state fallback', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-fallback-'));
    const first = join(tmpRoot, 'primary-writefail-file');
    const fallback = join(tmpRoot, 'state', 'writefail');
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = first;
    process.env['BOT_ERRORS_STATE_DIR'] = join(tmpRoot, 'state');
    writeFileSync(first, 'not a directory');

    const path = recordBotErrorsWritefail(
      { id: 'event-id', instance: 'agent' },
      new Error('outbox failed'),
      join(tmpRoot, 'outbox', 'event.json'),
    );

    expect(path).toEqual(expect.stringContaining(fallback));
    expect(readdirSync(fallback).filter((entry) => entry.endsWith('.writefail'))).toHaveLength(1);
  });
});

describe('credential-path confinement at the evidence boundary (issue #2386)', () => {
  // The event builder now confines evidence to bounded metadata. These tests
  // prove raw credential paths cannot cross the boundary. Pattern redaction
  // (redactText) remains as defense-in-depth but is no longer the primary
  // boundary — confinement is.
  function confinedEventHasRawPath(rawPath: string): boolean {
    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'agent-alpha',
      source: 'provider_auth',
      summary: 'credential exposure',
      evidence: `leaked path ${rawPath} end`,
    });
    return JSON.stringify(event).includes(rawPath);
  }

  it('confines a .config/secrets/ path', () => {
    expect(confinedEventHasRawPath('/srv/app/.config/secrets/fleet.json')).toBe(false);
  });

  it('confines a bare .env credential file with suffix', () => {
    expect(confinedEventHasRawPath('/srv/app/.env.production')).toBe(false);
  });

  it('confines the whatsoup auth path', () => {
    expect(confinedEventHasRawPath('/u/.local/share/whatsoup/instances/rb/auth/creds.json')).toBe(false);
  });

  it('confines non-credential text equally (metadata-only boundary)', () => {
    expect(confinedEventHasRawPath('https://example.com/public/page')).toBe(false);
  });

  it('is ReDoS-safe on a long ambiguous slash-path (no catastrophic backtracking)', () => {
    const evil = `/${'a/'.repeat(40000)}!`;
    const start = process.hrtime.bigint();
    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'agent-alpha',
      source: 'provider_auth',
      summary: 'credential exposure',
      evidence: evil,
    });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsedMs).toBeLessThan(1000);
    expect(JSON.stringify(event)).not.toContain('a/a/');
  });
});
