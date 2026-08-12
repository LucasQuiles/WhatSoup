/**
 * Config coercion hardening (#2295, HIGH findings).
 *
 * Pins the three repaired coercion surfaces:
 *  - intEnv: full-string numeric validation ("123abc" and "0x10" no longer
 *    silently truncate to a wrong-but-plausible integer — they fall back).
 *  - rateLimitWindowMs / rateLimitNoticeWindowMs: a SET-but-non-numeric value
 *    fails loud at startup (NaN here silently disabled rate limiting).
 *  - paths.{authDir,dbPath,lockPath}: a SET-but-non-string value fails loud
 *    (String(42) as a path would send filesystem state to a junk dir).
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
