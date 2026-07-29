import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let tmpRoot = '';

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('node:crypto');
  vi.doUnmock('node:fs');
  vi.doUnmock('node:os');
  vi.resetModules();
  delete process.env['BOT_ERRORS_OUTBOX_DIR'];
  delete process.env['BOT_ERRORS_STATE_DIR'];
  delete process.env['BOT_ERRORS_WRITEFAIL_DIR'];
  delete process.env['BOT_ERRORS_ALLOW_LIVE_IN_TESTS'];
  delete process.env['BOT_ERRORS_DRY_PLATFORM'];
  delete process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'];
  delete process.env['INVOCATION_ID'];
  delete process.env['LOG_DIR'];
  delete process.env['SYSTEMD_EXEC_PID'];
  delete process.env['WHATSOUP_TEST_MODE'];
  delete process.env['XDG_CONFIG_HOME'];
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('bot-errors outbox private writes', () => {
  it('refuses to publish an event through a pre-existing temp symlink', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-private-'));
    const outbox = join(tmpRoot, 'outbox');
    const writefail = join(tmpRoot, 'writefail');
    const outside = join(tmpRoot, 'outside-target');
    const eventId = '11111111-1111-4111-8111-111111111111';
    // Fractional-timestamp format introduced in #2560: milliseconds preserved
    // as _NNN suffix so same-second events sort lexically after old-format
    // names. The symlink must be at the exact tmp path the writer will target.
    const created = '20260611T123456Z_789';
    const tmpName = `.${created}.vitest-outbox.symlink-test.${eventId}.json.${process.pid}.tmp`;

    process.env['BOT_ERRORS_OUTBOX_DIR'] = outbox;
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefail;
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    writeFileSync(outside, 'outside-original', { mode: 0o600 });
    symlinkSync(outside, join(outbox, tmpName));

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:34:56.789Z'));
    vi.doMock('node:crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:crypto')>();
      return { ...actual, randomUUID: () => eventId };
    });

    const { writeBotErrorsEvent } = await import('../../src/lib/bot-errors-outbox.ts');

    expect(() => writeBotErrorsEvent({
      eventType: 'alert',
      instance: 'vitest-outbox',
      source: 'symlink-test',
      summary: 'symlink guard proof',
    })).toThrow();

    expect(readFileSync(outside, 'utf8')).toBe('outside-original');
    expect(existsSync(join(outbox, `${created}.vitest-outbox.symlink-test.${eventId}.json`))).toBe(false);
  });

  it('refuses to publish events through a symlinked outbox directory', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-dir-private-'));
    const outsideOutbox = join(tmpRoot, 'outside-outbox');
    const outboxLink = join(tmpRoot, 'outbox-link');
    const writefail = join(tmpRoot, 'writefail');

    mkdirSync(outsideOutbox, { recursive: true, mode: 0o700 });
    symlinkSync(outsideOutbox, outboxLink, 'dir');
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxLink;
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefail;

    const { writeBotErrorsEvent } = await import('../../src/lib/bot-errors-outbox.ts');

    expect(() => writeBotErrorsEvent({
      eventType: 'alert',
      instance: 'vitest-outbox',
      source: 'symlink-outbox-dir',
      summary: 'symlinked outbox dir should not be trusted',
    })).toThrow(/private directory.*symlink/);

    expect(readdirSync(outsideOutbox)).toEqual([]);
    expect(readdirSync(writefail).filter((entry) => entry.endsWith('.writefail'))).toHaveLength(1);
  });

  it('skips a symlinked writefail directory and records the breadcrumb in the next safe fallback', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-dir-private-'));
    const outsideWritefail = join(tmpRoot, 'outside-writefail');
    const writefailLink = join(tmpRoot, 'writefail-link');
    const fallbackState = join(tmpRoot, 'state');

    mkdirSync(outsideWritefail, { recursive: true, mode: 0o700 });
    symlinkSync(outsideWritefail, writefailLink, 'dir');
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefailLink;
    process.env['BOT_ERRORS_STATE_DIR'] = fallbackState;

    const { recordBotErrorsWritefail } = await import('../../src/lib/bot-errors-outbox.ts');
    const path = recordBotErrorsWritefail(
      { id: 'event-id', instance: 'vitest-outbox', evidence: 'token=super-secret' },
      new Error('primary outbox failed'),
      join(tmpRoot, 'outbox', 'event.json'),
    );

    expect(path).toEqual(expect.stringContaining(join(fallbackState, 'writefail')));
    expect(readdirSync(outsideWritefail)).toEqual([]);
    expect(readdirSync(join(fallbackState, 'writefail')).filter((entry) => entry.endsWith('.writefail'))).toHaveLength(1);
    expect(readFileSync(path!, 'utf8')).not.toContain('super-secret');
  });

  it('redacts event text, critical asset diagnostics, and sensitive env keys', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-redaction-'));
    process.env['BOT_ERRORS_OUTBOX_DIR'] = join(tmpRoot, 'outbox');
    process.env['INVOCATION_ID'] = 'launch-invocation';
    process.env['SYSTEMD_EXEC_PID'] = '12345';
    process.env['WHATSOUP_TEST_MODE'] = 'enabled';
    process.env['XDG_CONFIG_HOME'] = join(tmpRoot, 'xdg');
    process.env['BOT_ERRORS_API_TOKEN'] = 'must-not-be-listed';
    const userInfoUrl = ['https://user:pass@', 'example.invalid'].join('');
    const awsAccessKey = ['AKIA', '1234567890ABCDEF'].join('');
    const githubToken = ['ghp_', '1234567890abcdefghijklmnopqrst'].join('');
    const credentialPath = join('/tmp', '.config', 'whatsoup', 'instances', 'q', 'auth', 'creds.json');
    const authStatePath = join('/tmp', '.local', 'share', 'whatsoup', 'instances', 'q', 'auth', 'creds.json');
    const whatsappJid = ['12345678901', '@s.whatsapp.net'].join('');

    const { buildBotErrorsEvent } = await import('../../src/lib/bot-errors-outbox.ts');
    const event = buildBotErrorsEvent({
      eventType: 'clear',
      instance: '   ',
      source: '   ',
      summary: '   ',
      evidence: [
        'phone=+15551234567',
        'for +15557654321',
        'call me at +1 (555) 123-4567',
        'Authorization: Bearer live-token',
        'api_key=abc123',
        userInfoUrl,
        awsAccessKey,
        githubToken,
        'eyJaaaaaaaaaaa.bbbbbbbbbbb.ccccccccccc',
        credentialPath,
        whatsappJid,
      ].join('\n'),
      criticalAsset: {
        asset: {
          kind: 'credential',
          instance: 'q',
          path: authStatePath,
        },
        failure: {
          code: 'credential_exposed',
          domain: 'bot-errors-test',
          recoverability: 'manual_repair_required',
          confidence: 'confirmed',
          operatorAction: 'rotate token=live-secret',
          clearRequirement: 'prove phone +15559876543 is replaced',
        },
        evidenceRefs: ['Bearer nested-secret'],
      },
    }, '11111111-1111-4111-8111-111111111112', '2026-06-15T20:30:00.000Z');

    expect(event).toMatchObject({
      schemaVersion: 2,
      eventKind: 'incident_recovery',
      id: '11111111-1111-4111-8111-111111111112',
      eventType: 'clear',
      severity: 'info',
      instance: 'unknown',
      source: 'unknown',
      schemaVersion: 2,
      runtime: {
        invocationId: 'launch-invocation',
        systemdExecPid: '12345',
      },
    });
    // Issue #2386: summary and evidence are confined to bounded metadata.
    expect(typeof event.summary).toBe('object');
    expect(typeof event.evidence).toBe('object');
    // Raw secrets never cross the boundary.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('+15551234567');
    expect(serialized).not.toContain('+15557654321');
    expect(serialized).not.toContain('+1 (555) 123-4567');
    expect(serialized).not.toContain('live-token');
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('user:pass');
    // envKeys stripped (issue #2386): no environment key names cross boundary.
    expect(event.runtime).not.toHaveProperty('envKeys');
    expect(serialized).not.toContain('WHATSOUP_TEST_MODE');
    expect(serialized).not.toContain('XDG_CONFIG_HOME');
    expect(serialized).not.toContain('BOT_ERRORS_API_TOKEN');
    // CriticalAsset is still redacted via redactOutboxValue (defense-in-depth).
    expect(JSON.stringify(event.criticalAsset)).not.toContain('live-secret');
    expect(JSON.stringify(event.criticalAsset)).not.toContain('+15559876543');
    expect(JSON.stringify(event.criticalAsset)).toContain('[REDACTED CREDENTIAL PATH]');
    expect(JSON.stringify(event.criticalAsset)).toContain('[REDACTED]');
    expect(JSON.stringify(event.criticalAsset)).toContain('[REDACTED PHONE]');
  });

  it('uses safe fallback file segments for empty sanitized instance and source names', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-safe-segment-'));
    process.env['BOT_ERRORS_OUTBOX_DIR'] = join(tmpRoot, 'outbox');

    const { writeBotErrorsEvent } = await import('../../src/lib/bot-errors-outbox.ts');
    const result = writeBotErrorsEvent({
      eventType: 'alert',
      instance: '!!!',
      source: '***',
      summary: 'safe segment fallback',
    });

    expect(basename(result.path)).toContain('.unknown.unknown.');
    expect(readdirSync(join(tmpRoot, 'outbox')).filter((entry) => entry.endsWith('.json'))).toHaveLength(1);
  });

  it('derives test redirect outbox paths from worker and live-allow env variants', async () => {
    const originalVitest = process.env['VITEST'];
    const originalPool = process.env['VITEST_POOL_ID'];
    const originalWorker = process.env['VITEST_WORKER_ID'];
    const originalTmpdir = process.env['TMPDIR'];
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-state-'));

    try {
      process.env['BOT_ERRORS_STATE_DIR'] = join(tmpRoot, 'state');
      process.env['VITEST'] = 'false';
      process.env['VITEST_POOL_ID'] = 'pool/with spaces';
      delete process.env['VITEST_WORKER_ID'];
      delete process.env['BOT_ERRORS_STATE_DIR'];

      const mod = await import('../../src/lib/bot-errors-outbox.ts');
      const poolOutbox = mod.botErrorsOutboxDir();
      expect(poolOutbox).toContain('pool_with_spaces');

      process.env['VITEST_WORKER_ID'] = 'worker/with spaces';
      delete process.env['VITEST_POOL_ID'];
      delete process.env['BOT_ERRORS_STATE_DIR'];

      const workerOutbox = mod.botErrorsOutboxDir();
      expect(workerOutbox).toContain('worker_with_spaces');

      process.env['VITEST'] = 'true';
      delete process.env['VITEST_POOL_ID'];
      delete process.env['VITEST_WORKER_ID'];
      expect(mod.botErrorsOutboxDir()).toContain(`${join('whatsoup-vitest-bot-errors', 'main')}`);

      process.env['VITEST_WORKER_ID'] = '!!!';
      expect(mod.botErrorsOutboxDir()).toContain(`${join('whatsoup-vitest-bot-errors', 'unknown')}`);

      process.env['BOT_ERRORS_ALLOW_LIVE_IN_TESTS'] = '1';
      const liveAllowed = mod.botErrorsOutboxDir();
      expect(liveAllowed).toContain(join('.local', 'state', 'bot-errors', 'outbox'));

      delete process.env['TMPDIR'];
      process.env['BOT_ERRORS_STATE_DIR'] = join(tmpRoot, 'state-after-tmpdir-delete');
      const writefailPath = mod.recordBotErrorsWritefail(
        { evidence: 'token=abc123' },
        'Bearer plain-secret',
        join(tmpRoot, 'target.json'),
      );
      expect(writefailPath).toEqual(expect.stringContaining(join(tmpRoot, 'state-after-tmpdir-delete', 'writefail')));
      expect(readFileSync(writefailPath!, 'utf8')).not.toContain('plain-secret');
    } finally {
      if (originalVitest === undefined) delete process.env['VITEST'];
      else process.env['VITEST'] = originalVitest;
      if (originalPool === undefined) delete process.env['VITEST_POOL_ID'];
      else process.env['VITEST_POOL_ID'] = originalPool;
      if (originalWorker === undefined) delete process.env['VITEST_WORKER_ID'];
      else process.env['VITEST_WORKER_ID'] = originalWorker;
      if (originalTmpdir === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = originalTmpdir;
    }
  });

  it('publishes events when directory fsync is unavailable after a durable file write', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-outbox-dir-fsync-'));
    const outbox = join(tmpRoot, 'outbox');
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outbox;

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        openSync: (...args: Parameters<typeof actual.openSync>) => {
          const [target, flags] = args;
          if (String(target) === outbox && flags === 'r') {
            throw new Error('directory fsync unsupported');
          }
          return actual.openSync(...args);
        },
      };
    });

    const { writeBotErrorsEvent } = await import('../../src/lib/bot-errors-outbox.ts');
    const result = writeBotErrorsEvent({
      eventType: 'alert',
      instance: 'agent',
      source: 'dir-fsync',
      summary: 'directory fsync unavailable',
    });

    expect(existsSync(result.path)).toBe(true);
    expect(JSON.parse(readFileSync(result.path, 'utf8'))).toMatchObject({
      instance: 'agent',
      source: 'dir-fsync',
      delivery: { status: 'queued' },
    });
  });

  it('returns null when every writefail fallback directory is blocked', async () => {
    const originalTmpdir = process.env['TMPDIR'];
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-writefail-all-blocked-'));
    const blockedRoot = join(tmpRoot, 'blocked-root');
    try {
      writeFileSync(blockedRoot, 'not a directory');
      process.env['BOT_ERRORS_WRITEFAIL_DIR'] = join(blockedRoot, 'explicit');
      process.env['BOT_ERRORS_STATE_DIR'] = join(blockedRoot, 'state');
      process.env['TMPDIR'] = join(blockedRoot, 'tmp');

      vi.doMock('node:os', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:os')>();
        return {
          ...actual,
          homedir: () => join(blockedRoot, 'home'),
        };
      });

      const { recordBotErrorsWritefail } = await import('../../src/lib/bot-errors-outbox.ts');
      expect(recordBotErrorsWritefail({}, new Error('failed'), join(blockedRoot, 'outbox', 'event.json'))).toBeNull();
    } finally {
      if (originalTmpdir === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = originalTmpdir;
    }
  });

  it('strips operator log hints, env keys, hostname, platform, cwd, and argv (issue #2386)', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-metadata-strip-'));
    process.env['BOT_ERRORS_OUTBOX_DIR'] = join(tmpRoot, 'outbox');
    process.env['LOG_DIR'] = join(tmpRoot, 'logs');
    process.env['BOT_ERRORS_DRY_PLATFORM'] = 'linux';
    process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'] = '6.8.0-generic';

    const { buildBotErrorsEvent } = await import('../../src/lib/bot-errors-outbox.ts');
    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'agent',
      source: 'metadata-strip',
      summary: 'agent failure',
      evidence: 'TypeError: cannot read property x',
    });
    const serialized = JSON.stringify(event);

    // Issue #2386: logHints embedded instance names in operator commands
    // (journalctl/launchctl) and paths — stripped entirely.
    expect(event.diagnostics).not.toHaveProperty('logHints');
    expect(serialized).not.toContain('journalctl');
    expect(serialized).not.toContain('launchctl');
    expect(serialized).not.toContain('log show');

    // envKeys revealed runtime environment variable names — stripped.
    expect(event.runtime).not.toHaveProperty('envKeys');

    // machine/platform/cwd/execPath/argv stripped — host/path identifiers.
    expect(event).not.toHaveProperty('machine');
    expect(event).not.toHaveProperty('platform');
    expect(event.process).not.toHaveProperty('cwd');
    expect(event.process).not.toHaveProperty('execPath');
    expect(event.process).not.toHaveProperty('argv');
    expect(event.process).toHaveProperty('argvCount');

    // schemaVersion bumped to 2 for the confined shape.
    expect(event.schemaVersion).toBe(2);
  });
});
