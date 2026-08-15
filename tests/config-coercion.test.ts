/**
 * Config coercion hardening (#2295, HIGH findings + slice-3 cast sweep).
 *
 * Pins the repaired coercion surfaces:
 *  - intEnv: full-string numeric validation ("123abc" and "0x10" no longer
 *    silently truncate to a wrong-but-plausible integer — they fall back).
 *  - rateLimitWindowMs / rateLimitNoticeWindowMs: a SET-but-non-numeric value
 *    fails loud at startup (NaN here silently disabled rate limiting).
 *  - paths.{authDir,dbPath,lockPath}: a SET-but-non-string value fails loud
 *    (String(42) as a path would send filesystem state to a junk dir).
 *  - Slice 3: every former raw `as T | undefined` cast in config.ts now reads
 *    through optional{FiniteNumber,String,Boolean,Enum}/configSection — one
 *    representative case per family below, plus the null-means-unset contract
 *    the casts' nullish coalescing established.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MANAGED_ENV = [
  'INSTANCE_CONFIG',
  'MAX_TOKENS',
  'WHATSOUP_CONFIG_DIR',
  'WHATSOUP_DATA_DIR',
  'WHATSOUP_STATE_DIR',
  // config.ts repoints TMPDIR under dataRoot at import; without restore, the
  // NEXT test's mkdtempSync targets a directory afterEach just deleted.
  'TMPDIR',
  'HEALTH_PORT',
  'XDG_STATE_HOME',
  // homedir() honors $HOME on POSIX — the XDG-ignore test points it at the
  // per-test tmpdir so the fallback root never touches the real home.
  'HOME',
  // config.ts PUBLISHES the bot-errors routing vars when instance-config sets
  // them (#2192 slice 3a); save/restore so a publish in one test cannot leak.
  'BOT_ERRORS_JID',
  'BOT_ERRORS_EXPECTED_JID',
  'BOT_ERRORS_REQUIRE_EXPECTED',
  'BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS',
] as const;

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-coercion-'));
  process.env.WHATSOUP_CONFIG_DIR = path.join(tmpDir, 'config');
  process.env.WHATSOUP_DATA_DIR = path.join(tmpDir, 'data');
  process.env.WHATSOUP_STATE_DIR = path.join(tmpDir, 'state');
  delete process.env.INSTANCE_CONFIG;
  delete process.env.MAX_TOKENS;
  // Ambient deployment values would shadow the resolution chains under test.
  delete process.env.BOT_ERRORS_JID;
  delete process.env.BOT_ERRORS_EXPECTED_JID;
  delete process.env.BOT_ERRORS_REQUIRE_EXPECTED;
  delete process.env.BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS;
  vi.resetModules();
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeInstanceConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'coercion-test',
    type: 'chat',
    systemPrompt: 'Coercion test.',
    adminPhones: ['15550000001'],
    accessMode: 'allowlist',
    paths: {
      configRoot: path.join(tmpDir, 'inst-config'),
      dataRoot: path.join(tmpDir, 'inst-data'),
      stateRoot: path.join(tmpDir, 'inst-state'),
      authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
      dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
      logDir: path.join(tmpDir, 'inst-data', 'logs'),
      lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
      mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
    },
    ...overrides,
  };
}

describe('intEnv full-string validation', () => {
  it('falls back on a partial numeric parse instead of truncating', async () => {
    process.env.MAX_TOKENS = '123abc';
    const { config } = await import('../src/config.ts');
    expect(config.maxTokens).toBe(750);
  });

  it('falls back on hex-looking input instead of parsing it as 0', async () => {
    process.env.MAX_TOKENS = '0x10';
    const { config } = await import('../src/config.ts');
    expect(config.maxTokens).toBe(750);
  });

  it('still accepts a plain integer', async () => {
    process.env.MAX_TOKENS = '600';
    const { config } = await import('../src/config.ts');
    expect(config.maxTokens).toBe(600);
  });
});

describe('rate-limit window validation', () => {
  it('rejects a set-but-non-numeric rateLimitWindowMs at startup', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeInstanceConfig({ rateLimitWindowMs: 'fast' }),
    );
    await expect(import('../src/config.ts')).rejects.toThrow(
      /rateLimitWindowMs must be a finite number/,
    );
  });

  it('rejects a set-but-non-numeric rateLimitNoticeWindowMs at startup', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeInstanceConfig({ rateLimitNoticeWindowMs: { minutes: 5 } }),
    );
    await expect(import('../src/config.ts')).rejects.toThrow(
      /rateLimitNoticeWindowMs must be a finite number/,
    );
  });

  it('accepts a numeric rateLimitWindowMs', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeInstanceConfig({ rateLimitWindowMs: 120_000 }),
    );
    const { config } = await import('../src/config.ts');
    expect(config.rateLimitWindowMs).toBe(120_000);
  });
});

describe('cast-sweep families (#2295 slice 3)', () => {
  it('rejects a set-but-non-numeric top-level number field', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({ maxTokens: 'lots' }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /maxTokens must be a finite number/,
    );
  });

  it('treats an explicit null as unset (the former casts\' ?? contract)', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({ maxTokens: null }));
    const { config } = await import('../src/config.ts');
    expect(config.maxTokens).toBe(750);
  });

  it('rejects a set-but-non-numeric nested section field', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeInstanceConfig({ outboundGovernor: { windowMs: '3s' } }),
    );
    await expect(import('../src/config.ts')).rejects.toThrow(
      /outboundGovernor\.windowMs must be a finite number/,
    );
  });

  it('rejects a non-object config section', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({ outboundGovernor: 'fast' }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /outboundGovernor must be an object/,
    );
  });

  it('rejects an out-of-union enum value instead of letting it flow as a lying literal', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({ voiceReply: 'sometimes' }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /voiceReply must be one of/,
    );
  });

  it('rejects a set-but-non-string string field', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({ name: 42 }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /name must be a string/,
    );
  });

  it('rejects a non-string models entry', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeInstanceConfig({ models: { conversation: 42 } }),
    );
    await expect(import('../src/config.ts')).rejects.toThrow(
      /models\.conversation must be a string/,
    );
  });

  it('rejects a non-string controlPeers value', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeInstanceConfig({ controlPeers: { '15550000002': 7 } }),
    );
    await expect(import('../src/config.ts')).rejects.toThrow(
      /controlPeers must be an object of non-empty string values/,
    );
  });

  it('rejects a junk adminPhones entry with an indexed message', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeInstanceConfig({ adminPhones: ['15550000001', 42] }),
    );
    await expect(import('../src/config.ts')).rejects.toThrow(
      /adminPhones\[1\] must be a non-empty string/,
    );
  });

  it('accepts a fully-populated valid nested config', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeInstanceConfig({
        maxTokens: 900,
        outboundGovernor: { windowMs: 4_000, maxPerWindow: 8 },
        voiceReply: 'when_received',
        toolUpdateMode: 'minimal',
        controlPeers: { '15550000002': 'ops' },
        mediaRetention: { tempHours: 24 },
      }),
    );
    const { config } = await import('../src/config.ts');
    expect(config.maxTokens).toBe(900);
    expect(config.outboundGovernor.windowMs).toBe(4_000);
    expect(config.outboundGovernor.maxPerWindow).toBe(8);
    expect(config.outboundGovernor.maxWaitMs).toBe(5_000);
    expect(config.voiceReply).toBe('when_received');
    expect(config.toolUpdateMode).toBe('minimal');
    expect(config.controlPeers.get('15550000002')).toBe('ops');
    expect(config.mediaRetention.tempHours).toBe(24);
    expect(config.mediaRetention.cacheHours).toBe(168);
  });
});

describe('path absoluteness + env port range (#2295 M5/M7/M8)', () => {
  it('rejects a relative WHATSOUP_*_DIR override', async () => {
    process.env.WHATSOUP_DATA_DIR = 'relative/data';
    await expect(import('../src/config.ts')).rejects.toThrow(
      /WHATSOUP_DATA_DIR must be an absolute path/,
    );
  });

  it('ignores a relative XDG base per the XDG spec instead of honoring it', async () => {
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    delete process.env.WHATSOUP_STATE_DIR;
    process.env.XDG_STATE_HOME = 'relative/state';
    const { config } = await import('../src/config.ts');
    expect(config.stateRoot).toBe(path.join(fakeHome, '.local/state', 'whatsoup'));
  });

  it('rejects a relative instance dbPath', async () => {
    const base = makeInstanceConfig();
    (base.paths as Record<string, unknown>).dbPath = 'relative/bot.db';
    process.env.INSTANCE_CONFIG = JSON.stringify(base);
    await expect(import('../src/config.ts')).rejects.toThrow(
      /paths\.dbPath must be an absolute path/,
    );
  });

  it('falls back on an out-of-range env health port (validator range 1024-65535)', async () => {
    process.env.HEALTH_PORT = '80';
    const { config } = await import('../src/config.ts');
    expect(config.healthPort).toBe(9090);
  });

  it('still accepts an in-range env health port', async () => {
    process.env.HEALTH_PORT = '9099';
    const { config } = await import('../src/config.ts');
    expect(config.healthPort).toBe(9099);
  });
});

describe('instance path validation', () => {
  it('rejects a numeric dbPath at startup instead of stringifying it', async () => {
    const base = makeInstanceConfig();
    (base.paths as Record<string, unknown>).dbPath = 42;
    process.env.INSTANCE_CONFIG = JSON.stringify(base);
    // dbPath is a REQUIRED path: the instance-config-shape layer rejects a
    // non-string before config.ts's own requirePathString can (which remains
    // as defense in depth behind it).
    await expect(import('../src/config.ts')).rejects.toThrow(
      /INSTANCE_CONFIG.*paths object/,
    );
  });

  it('rejects a null authDir at startup', async () => {
    const base = makeInstanceConfig();
    (base.paths as Record<string, unknown>).authDir = null;
    process.env.INSTANCE_CONFIG = JSON.stringify(base);
    // authDir is OPTIONAL in the shape layer (spread only when a string), so
    // a set-but-invalid value used to flow through to the raw cast silently —
    // this is the load-bearing new rejection.
    await expect(import('../src/config.ts')).rejects.toThrow(
      /paths\.authDir/,
    );
  });
});

describe('bot-errors alert routing publish bridge (#2192 slice 3a)', () => {
  // Synthetic group JID (repo convention: 111111… prefix — the hygiene guard
  // rejects real-shaped 120363… group JIDs in added lines).
  const JID = '111111100000000001@g.us';

  it('publishes instance-config values to process.env and the typed fields agree', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      botErrorsJid: JID,
      botErrorsExpectedJid: JID,
      botErrorsRequireExpected: false,
    }));
    const { config } = await import('../src/config.ts');
    // The publish is the whole point: emit-alert.ts and
    // outbound-message-safety.ts read these env vars call-time and must see
    // the instance override.
    expect(process.env.BOT_ERRORS_JID).toBe(JID);
    expect(process.env.BOT_ERRORS_EXPECTED_JID).toBe(JID);
    expect(process.env.BOT_ERRORS_REQUIRE_EXPECTED).toBe('0');
    expect(config.botErrorsJid).toBe(JID);
    expect(config.botErrorsExpectedJid).toBe(JID);
    expect(config.botErrorsRequireExpected).toBe(false);
  });

  it('falls back to env values without rewriting them', async () => {
    process.env.BOT_ERRORS_JID = JID;
    process.env.BOT_ERRORS_REQUIRE_EXPECTED = 'off';
    const { config } = await import('../src/config.ts');
    expect(config.botErrorsJid).toBe(JID);
    expect(config.botErrorsExpectedJid).toBeNull();
    expect(config.botErrorsRequireExpected).toBe(false);
    // Env-sourced resolution must not publish: absence semantics elsewhere in
    // the family are load-bearing, so config only writes what instance-config
    // explicitly set.
    expect(process.env.BOT_ERRORS_EXPECTED_JID).toBeUndefined();
    expect(process.env.BOT_ERRORS_REQUIRE_EXPECTED).toBe('off');
  });

  it('leaves unset vars unset (no "undefined" strings) and defaults the fields', async () => {
    const { config } = await import('../src/config.ts');
    expect(config.botErrorsJid).toBeNull();
    expect(config.botErrorsExpectedJid).toBeNull();
    expect(config.botErrorsRequireExpected).toBe(true);
    // Exact absence, not just undefined-valued: a broken publish would write
    // the string "undefined" (or an empty value), and `in` also catches a
    // present-but-undefined key that a plain value read cannot distinguish.
    expect({
      BOT_ERRORS_JID: 'BOT_ERRORS_JID' in process.env,
      BOT_ERRORS_EXPECTED_JID: 'BOT_ERRORS_EXPECTED_JID' in process.env,
      BOT_ERRORS_REQUIRE_EXPECTED: 'BOT_ERRORS_REQUIRE_EXPECTED' in process.env,
    }).toEqual({
      BOT_ERRORS_JID: false,
      BOT_ERRORS_EXPECTED_JID: false,
      BOT_ERRORS_REQUIRE_EXPECTED: false,
    });
  });

  it('resolves toolFailureAlertsEnabled: default on, env kill-switch, instance precedence', async () => {
    const first = await import('../src/config.ts');
    expect(first.config.toolFailureAlertsEnabled).toBe(true);

    vi.resetModules();
    process.env.BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS = '0';
    const second = await import('../src/config.ts');
    expect(second.config.toolFailureAlertsEnabled).toBe(false);

    vi.resetModules();
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      toolFailureAlertsEnabled: true,
    }));
    const third = await import('../src/config.ts');
    expect(third.config.toolFailureAlertsEnabled).toBe(true);
  });
});
