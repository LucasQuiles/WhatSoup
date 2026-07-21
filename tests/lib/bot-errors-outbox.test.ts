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
  type BotErrorsOutboxInput,
  type BotErrorsV2OutboxInput,
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

const observationFixture = JSON.parse(readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'bot-errors-observation-v2.json'),
  'utf8',
)) as {
  legacy: { alert: Record<string, unknown>; clear: Record<string, unknown> };
  version2: { alert: Record<string, unknown>; clear: Record<string, unknown> };
};

function v2Input(overrides: Record<string, unknown> = {}): BotErrorsV2OutboxInput {
  return {
    eventType: 'alert',
    instance: 'fixture-agent',
    source: 'fixture-health',
    summary: 'synthetic health probe failed',
    evidence: 'synthetic health probe failed',
    observation: {
      state: 'fault',
      observedAt: '2026-07-20T10:00:00.000Z',
      producerSequence: 7,
      confidence: 'confirmed',
    },
    clearPolicy: {
      kind: 'health_snapshot',
      minimumSchemaVersion: 2,
    },
    remediation: {
      recoverability: 'auto_recoverable',
      requestedAction: 'probe_health',
      authorization: 'automatic_read_only',
    },
    ...overrides,
  } as unknown as BotErrorsV2OutboxInput;
}

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
  it('keeps explicit legacy events at schema v1 and matches the compatibility fixture', () => {
    for (const eventType of ['alert', 'clear'] as const) {
      const expected = observationFixture.legacy[eventType];
      const event = buildBotErrorsEvent({
        eventType,
        instance: String(expected.instance),
        source: String(expected.source),
        summary: String(expected.summary),
        evidence: String(expected.evidence),
      }, String(expected.id), String(expected.createdAt));

      expect(event).toMatchObject(expected);
      expect(event).not.toHaveProperty('observation');
      expect(event).not.toHaveProperty('clearPolicy');
      expect(event).not.toHaveProperty('remediation');
    }
  });

  it('emits schema v2 only for a complete typed protocol and matches the cross-language fixture', () => {
    const alert = buildBotErrorsEvent(
      v2Input(),
      String(observationFixture.version2.alert.id),
      String(observationFixture.version2.alert.createdAt),
    );
    const clear = buildBotErrorsEvent(v2Input({
      eventType: 'clear',
      summary: 'synthetic health probe recovered',
      evidence: 'synthetic health probe recovered',
      observation: {
        state: 'healthy',
        observedAt: '2026-07-20T10:05:00.000Z',
        producerSequence: 8,
        confidence: 'confirmed',
      },
      clearPolicy: {
        kind: 'health_snapshot',
        proofRef: 'receipt:health:fixture-agent:8',
        proofObservedAt: '2026-07-20T10:05:00.000Z',
        minimumSchemaVersion: 2,
      },
      remediation: {
        recoverability: 'auto_recoverable',
        requestedAction: 'observe_recovery',
        authorization: 'automatic_read_only',
      },
    }), String(observationFixture.version2.clear.id), String(observationFixture.version2.clear.createdAt));

    expect(alert).toMatchObject(observationFixture.version2.alert);
    expect(clear).toMatchObject(observationFixture.version2.clear);
  });

  it('models the protocol as an all-or-nothing compile-time union', () => {
    const legacy: BotErrorsOutboxInput = {
      eventType: 'alert', instance: 'fixture', source: 'fixture', summary: 'legacy',
    };
    const typed: BotErrorsOutboxInput = v2Input();
    // @ts-expect-error -- permanent negative type-contract fixture: typed observation requires clearPolicy and remediation; expires 2027-12-31
    const incomplete: BotErrorsOutboxInput = {
      eventType: 'alert',
      instance: 'fixture',
      source: 'fixture',
      summary: 'incomplete',
      observation: {
        state: 'fault' as const,
        observedAt: '2026-07-20T10:00:00.000Z',
        confidence: 'confirmed' as const,
      },
    };

    expect(legacy).toBeDefined();
    expect(typed).toBeDefined();
    expect(incomplete).toBeDefined();
  });

  it('derives a stable sha256 evidence fingerprint after redaction', () => {
    const first = buildBotErrorsEvent(v2Input({ evidence: 'token=raw-secret' }), 'event-a', '2026-07-20T10:00:05.000Z');
    const second = buildBotErrorsEvent(v2Input({ evidence: 'token=raw-secret' }), 'event-b', '2026-07-20T10:00:05.000Z');

    expect(first.observation?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.observation?.fingerprint).toBe(first.observation?.fingerprint);
    expect(JSON.stringify(first)).not.toContain('raw-secret');
  });

  it.each([
    ['observation.state', { state: 'broken', observedAt: '2026-07-20T10:00:00.000Z', confidence: 'confirmed' }],
    ['observation.confidence', { state: 'fault', observedAt: '2026-07-20T10:00:00.000Z', confidence: 'certain' }],
    ['clearPolicy.kind', { kind: 'weak_text', minimumSchemaVersion: 2 }],
    ['remediation.recoverability', { recoverability: 'eventually', requestedAction: 'probe_health', authorization: 'automatic_read_only' }],
    ['remediation.authorization', { recoverability: 'auto_recoverable', requestedAction: 'probe_health', authorization: 'anyone' }],
  ] as const)('rejects an invalid schema-v2 %s enum', (path, value) => {
    const [field] = path.split('.');
    expect(() => buildBotErrorsEvent(v2Input({ [field!]: value }), 'event', '2026-07-20T10:00:05.000Z'))
      .toThrow(/protocol|observation|policy|remediation|invalid/i);
  });

  it('accepts every schema-v2 policy, confidence, recoverability, and authorization enum', () => {
    const policies = [
      'same_source_newer', 'health_snapshot', 'outbound_after_incident',
      'auth_bond_and_outbound', 'source_quiet_and_health', 'manual_ack',
    ];
    const confidence = ['suspected', 'probable', 'confirmed'];
    const recoverability = [
      'auto_recoverable', 'operator_recoverable', 'manual_relink_required',
      'manual_repair_required', 'unrecoverable', 'unknown',
    ];
    const authorization = [
      'automatic_read_only', 'automatic_safe_retry', 'owner_required', 'physical_required',
    ];

    for (const kind of policies) {
      expect(() => buildBotErrorsEvent(v2Input({ clearPolicy: { kind, minimumSchemaVersion: 2 } })))
        .not.toThrow();
    }
    for (const value of confidence) {
      expect(() => buildBotErrorsEvent(v2Input({
        observation: { state: 'fault', observedAt: '2026-07-20T10:00:00.000Z', confidence: value },
      }))).not.toThrow();
    }
    for (const value of recoverability) {
      expect(() => buildBotErrorsEvent(v2Input({
        remediation: { recoverability: value, requestedAction: 'probe_health', authorization: 'automatic_read_only' },
      }))).not.toThrow();
    }
    for (const value of authorization) {
      expect(() => buildBotErrorsEvent(v2Input({
        remediation: { recoverability: 'auto_recoverable', requestedAction: 'probe_health', authorization: value },
      }))).not.toThrow();
    }
  });

  it('enforces schema-v2 event/state pairings and complete protocol combinations', () => {
    expect(() => buildBotErrorsEvent(v2Input({
      observation: { state: 'unknown', observedAt: '2026-07-20T10:00:00.000Z', confidence: 'suspected' },
    }))).not.toThrow();
    expect(() => buildBotErrorsEvent(v2Input({
      observation: { state: 'healthy', observedAt: '2026-07-20T10:00:00.000Z', confidence: 'confirmed' },
    }))).toThrow(/alert|fault|unknown|observation/i);
    expect(() => buildBotErrorsEvent(v2Input({
      eventType: 'clear',
      observation: { state: 'fault', observedAt: '2026-07-20T10:00:00.000Z', confidence: 'confirmed' },
    }))).toThrow(/clear|healthy|observation/i);
    expect(() => buildBotErrorsEvent({
      ...v2Input(),
      clearPolicy: undefined,
    } as unknown as Parameters<typeof buildBotErrorsEvent>[0])).toThrow(/clear policy|protocol/i);
    expect(() => buildBotErrorsEvent({
      ...v2Input(),
      remediation: undefined,
    } as unknown as Parameters<typeof buildBotErrorsEvent>[0])).toThrow(/remediation|protocol/i);
  });

  it('enforces timestamp ordering, proof pairing, and optional producer sequence bounds', () => {
    expect(() => buildBotErrorsEvent(v2Input({
      observation: { state: 'fault', observedAt: 'not-a-time', confidence: 'confirmed' },
    }), 'event', '2026-07-20T10:00:05.000Z')).toThrow(/observedAt|timestamp/i);
    expect(() => buildBotErrorsEvent(v2Input({
      observation: { state: 'fault', observedAt: '2026-07-20T10:00:06.000Z', confidence: 'confirmed' },
    }), 'event', '2026-07-20T10:00:05.000Z')).toThrow(/observedAt|createdAt|timestamp/i);
    expect(() => buildBotErrorsEvent(v2Input({
      observation: { state: 'fault', observedAt: '2026-07-20T10:00:00.000Z', producerSequence: -1, confidence: 'confirmed' },
    }))).toThrow(/producer sequence|producerSequence/i);
    expect(() => buildBotErrorsEvent(v2Input({
      observation: { state: 'fault', observedAt: '2026-07-20T10:00:00.000Z', producerSequence: 1.5, confidence: 'confirmed' },
    }))).toThrow(/producer sequence|producerSequence/i);
    expect(() => buildBotErrorsEvent(v2Input({
      observation: {
        state: 'fault', observedAt: '2026-07-20T10:00:00.000Z',
        producerSequence: Number.MAX_SAFE_INTEGER + 1, confidence: 'confirmed',
      },
    }))).toThrow(/producer sequence|producerSequence/i);
    for (const producerSequence of [0, Number.MAX_SAFE_INTEGER]) {
      expect(() => buildBotErrorsEvent(v2Input({
        observation: { state: 'fault', observedAt: '2026-07-20T10:00:00.000Z', producerSequence, confidence: 'confirmed' },
      }))).not.toThrow();
    }
    expect(() => buildBotErrorsEvent(v2Input({
      clearPolicy: { kind: 'health_snapshot', proofObservedAt: '2026-07-20T10:00:00.000Z', minimumSchemaVersion: 2 },
    }))).toThrow(/proof.*reference|proofRef/i);
    expect(() => buildBotErrorsEvent(v2Input({
      eventType: 'clear',
      observation: { state: 'healthy', observedAt: '2026-07-20T10:00:00.000Z', confidence: 'confirmed' },
      clearPolicy: { kind: 'health_snapshot', proofRef: 'receipt:health:1', proofObservedAt: '2026-07-20T10:00:01.000Z', minimumSchemaVersion: 2 },
    }), 'event', '2026-07-20T10:00:05.000Z')).toThrow(/proofObservedAt|observedAt|timestamp/i);
  });

  it('requires proof references on proof-bearing clears and bounds protocol strings', () => {
    const clear = {
      eventType: 'clear',
      observation: { state: 'healthy', observedAt: '2026-07-20T10:00:00.000Z', confidence: 'confirmed' },
    };
    expect(() => buildBotErrorsEvent(v2Input({
      ...clear,
      clearPolicy: { kind: 'health_snapshot', minimumSchemaVersion: 2 },
    }))).toThrow(/proof.*reference|proofRef/i);
    expect(() => buildBotErrorsEvent(v2Input({
      clearPolicy: { kind: 'health_snapshot', proofRef: 'r'.repeat(513), minimumSchemaVersion: 2 },
    }))).toThrow(/proof.*512|proof.*long|proofRef/i);
    expect(() => buildBotErrorsEvent(v2Input({
      remediation: { recoverability: 'auto_recoverable', requestedAction: `a${'b'.repeat(128)}`, authorization: 'automatic_read_only' },
    }))).toThrow(/requested action|requestedAction|128/i);
    expect(() => buildBotErrorsEvent(v2Input({
      clearPolicy: { kind: 'health_snapshot', minimumSchemaVersion: 3 },
    }))).toThrow(/schema version|minimumSchemaVersion/i);
  });

  it('redacts proof references before returning or durably writing schema-v2 events', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-v2-proof-'));
    process.env['BOT_ERRORS_OUTBOX_DIR'] = join(tmpRoot, 'outbox');
    const input = v2Input({
      eventType: 'clear',
      observation: { state: 'healthy', observedAt: '2026-07-20T10:00:00.000Z', confidence: 'confirmed' },
      clearPolicy: {
        kind: 'health_snapshot',
        proofRef: 'receipt token=unredacted-proof-secret',
        proofObservedAt: '2026-07-20T10:00:00.000Z',
        minimumSchemaVersion: 2,
      },
    });

    const built = buildBotErrorsEvent(input, 'event', '2026-07-20T10:00:05.000Z');
    const written = writeBotErrorsEvent(input);
    expect(built.clearPolicy?.proofRef).toContain('[REDACTED]');
    expect(JSON.stringify(built)).not.toContain('unredacted-proof-secret');
    expect(readFileSync(written.path, 'utf8')).not.toContain('unredacted-proof-secret');
  });

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
      id: '11111111-1111-4111-8111-111111111111',
      eventType: 'clear',
      severity: 'info',
      instance: 'unknown',
      source: 'unknown',
      summary: 'clear event from unknown',
      evidence: '',
      runtime: {
        invocationId: 'systemd-invocation',
        systemdExecPid: '4242',
      },
      diagnostics: {
        queue: join(tmpRoot, 'state', 'outbox'),
      },
    });
    expect(event.runtime.envKeys).toContain('LOG_DIR');
    expect(event.runtime.envKeys).toContain('WHATSOUP_VISIBLE_FLAG');
    expect(event.runtime.envKeys).not.toContain('WHATSOUP_SECRET_TOKEN');
    expect(event.diagnostics.logHints).toContain(join(tmpRoot, 'logs', 'whatsoup.log'));
    expect(event.diagnostics.logHints).toContain([
      'journalctl --user -u whatsoup',
      "unknown.service --since '30 minutes ago'",
    ].join('@'));
    expect(event.diagnostics.logHints).toContain("journalctl --user -u bot-errors-dispatcher.service --since '30 minutes ago'");
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

    expect(event.summary).toBe('provider token=[REDACTED] failed');
    expect(event.evidence).toContain('cookie=[REDACTED]');
    expect(event.evidence).toContain('[REDACTED PHONE]');
    expect(event.evidence).toContain('for [REDACTED PHONE]');
    expect(event.criticalAsset.asset.path).toBe('[REDACTED CREDENTIAL PATH]');
    expect(event.criticalAsset.asset.owner).toBe('line=[REDACTED PHONE]');
    expect(event.criticalAsset.asset.fingerprint).toBe('fp-123');
    expect(event.criticalAsset.failure.operatorAction).toBe('rotate token=[REDACTED]');
    expect(event.criticalAsset.failure.clearRequirement).toContain('[REDACTED PHONE]');
    expect(event.criticalAsset.evidenceRefs).toEqual([
      'Authorization: Bearer [REDACTED]',
      ['https://[REDACTED]', 'example.invalid/path'].join('@'),
    ]);
    expect(JSON.stringify(event)).not.toContain('raw-secret');
    expect(JSON.stringify(event)).not.toContain('topsecret');
    expect(JSON.stringify(event)).not.toContain('session-secret');
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

    // The device-suffixed JIDs (the leak this fix closes) are fully masked.
    expect(event.summary).not.toContain(deviceJid);
    expect(event.evidence).not.toContain(deviceJid);
    expect(event.evidence).not.toContain(deviceLid);
    // No regression: plain and device-dash JIDs still redact.
    expect(event.evidence).not.toContain(plainJid);
    expect(event.evidence).not.toContain(dashJid);
    expect(event.evidence).toContain('[REDACTED WHATSAPP JID]');
    expect(JSON.stringify(event)).not.toContain(':6@');
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
      summary: 'directory fsync fallback',
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

describe('credential-path redaction (canonical pattern)', () => {
  function pathRedaction(rawPath: string): string {
    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'agent-alpha',
      source: 'provider_auth',
      summary: 'credential exposure',
      evidence: `leaked path ${rawPath} end`,
    });
    return event.evidence;
  }

  it('redacts a .config/secrets/ path (branch missing before canonical sync)', () => {
    expect(pathRedaction('/srv/app/.config/secrets/fleet.json')).toBe(
      'leaked path [REDACTED CREDENTIAL PATH] end',
    );
  });

  it('redacts a bare .env credential file with suffix', () => {
    expect(pathRedaction('/srv/app/.env.production')).toBe(
      'leaked path [REDACTED CREDENTIAL PATH] end',
    );
  });

  it('still redacts the previously-covered whatsoup auth path', () => {
    expect(pathRedaction('/u/.local/share/whatsoup/instances/rb/auth/creds.json')).toBe(
      'leaked path [REDACTED CREDENTIAL PATH] end',
    );
  });

  it('leaves non-credential text untouched', () => {
    expect(pathRedaction('https://example.com/public/page')).toBe(
      'leaked path https://example.com/public/page end',
    );
  });

  it('is ReDoS-safe on a long ambiguous slash-path (no catastrophic backtracking)', () => {
    // The pre-canonical `(?:~|/[^\s]+)*` prefix backtracked exponentially on this
    // shape once the required suffix failed. Bound the work to prove it is linear.
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
    // No credential category matched, so the adversarial input passes through.
    expect(event.evidence).toContain('a/a/');
  });
});
