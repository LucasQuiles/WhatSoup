import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBaseChildEnv } from '../../../../src/runtimes/agent/providers/child-env.ts';

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
});
