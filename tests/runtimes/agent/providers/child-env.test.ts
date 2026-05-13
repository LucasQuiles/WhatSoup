import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildBaseChildEnv,
  FAILCLOSED_FLAG,
} from '../../../../src/runtimes/agent/providers/child-env.ts';

const MANAGED_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'NODE_PATH',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'SUDO_ASKPASS',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'PINECONE_API_KEY',
  'CUSTOM_SECRET',
  'ALLOW_M365_MUTATIONS',
  'WHATSOUP_CONNECTOR_FAILCLOSED',
] as const;

let savedEnv: Record<string, string | undefined>;

function resetManagedEnv(next: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>> = {}) {
  for (const key of MANAGED_ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(next)) {
    process.env[key] = value;
  }
}

describe('buildBaseChildEnv', () => {
  beforeEach(() => {
    savedEnv = Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
    resetManagedEnv();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('exports the base child env builder', () => {
    expect(buildBaseChildEnv).toBeTypeOf('function');
  });

  it('returns only allowlisted system variables and strips unrelated secrets', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/tmp/child-config',
      OPENAI_API_KEY: 'openai-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      PINECONE_API_KEY: 'pinecone-secret',
      CUSTOM_SECRET: 'custom-secret',
    });

    const env = buildBaseChildEnv();

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/tmp/child-config',
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('PINECONE_API_KEY');
    expect(env).not.toHaveProperty('CUSTOM_SECRET');
  });

  it('returns an isolated copy instead of a live process.env reference', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
    });

    const env = buildBaseChildEnv();
    env.PATH = '/modified-path';

    expect(process.env.PATH).toBe('/usr/bin');

    process.env.HOME = '/changed-home';
    expect(env.HOME).toBe('/tmp/child-home');
  });

  it('propagates ALLOW_M365_MUTATIONS when set (mw-bot M365 bypass)', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      ALLOW_M365_MUTATIONS: '1',
    });

    const env = buildBaseChildEnv();

    expect(env).toHaveProperty('ALLOW_M365_MUTATIONS', '1');
  });

  it('omits ALLOW_M365_MUTATIONS when not set (default read-only)', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
    });

    const env = buildBaseChildEnv();

    expect(env).not.toHaveProperty('ALLOW_M365_MUTATIONS');
  });
});

// ─── #411 fail-closed opt-in flag ─────────────────────────────────────────────
// Default (flag unset): unconditional propagation, identical to pre-#411.
// Opt-in (flag = '1'): the per-instance agentOptions.allowM365Mutations gates
// propagation. Anything else (unset, missing, false) drops the var.

describe('buildBaseChildEnv (#411 WHATSOUP_CONNECTOR_FAILCLOSED gate)', () => {
  beforeEach(() => {
    savedEnv = Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
    resetManagedEnv();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('exports the canonical flag name', () => {
    expect(FAILCLOSED_FLAG).toBe('WHATSOUP_CONNECTOR_FAILCLOSED');
  });

  it('flag unset: ALLOW_M365_MUTATIONS propagates unconditionally (current default)', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      ALLOW_M365_MUTATIONS: '1',
    });

    // No agentOptions.allowM365Mutations supplied → still propagates,
    // because the failclosed flag is unset (today's behavior).
    const env = buildBaseChildEnv();
    expect(env).toHaveProperty('ALLOW_M365_MUTATIONS', '1');

    // Even with allowM365Mutations: false, propagation continues when
    // the flag is unset — the opts are simply ignored in default mode.
    const env2 = buildBaseChildEnv({ allowM365Mutations: false });
    expect(env2).toHaveProperty('ALLOW_M365_MUTATIONS', '1');
  });

  it('flag=1 + allowM365Mutations=true: propagates', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      ALLOW_M365_MUTATIONS: '1',
      WHATSOUP_CONNECTOR_FAILCLOSED: '1',
    });

    const env = buildBaseChildEnv({ allowM365Mutations: true });

    expect(env).toHaveProperty('ALLOW_M365_MUTATIONS', '1');
  });

  it('flag=1 + allowM365Mutations missing: drops the var', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      ALLOW_M365_MUTATIONS: '1',
      WHATSOUP_CONNECTOR_FAILCLOSED: '1',
    });

    const env = buildBaseChildEnv();

    expect(env).not.toHaveProperty('ALLOW_M365_MUTATIONS');
  });

  it('flag=1 + allowM365Mutations=false: drops the var', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      ALLOW_M365_MUTATIONS: '1',
      WHATSOUP_CONNECTOR_FAILCLOSED: '1',
    });

    const env = buildBaseChildEnv({ allowM365Mutations: false });

    expect(env).not.toHaveProperty('ALLOW_M365_MUTATIONS');
  });

  it('flag values other than "1" are treated as unset (back-compat)', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      ALLOW_M365_MUTATIONS: '1',
      WHATSOUP_CONNECTOR_FAILCLOSED: 'true', // not the canonical "1"
    });

    const env = buildBaseChildEnv();

    expect(env).toHaveProperty('ALLOW_M365_MUTATIONS', '1');
  });
});
