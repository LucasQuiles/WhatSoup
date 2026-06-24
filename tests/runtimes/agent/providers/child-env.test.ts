import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildBaseChildEnv,
  CONFIG_ROOT_ISOLATION_FLAG,
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
  'TMPDIR',
  'SUDO_ASKPASS',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'PINECONE_API_KEY',
  'CUSTOM_SECRET',
  'TOKENOMICS_SECRET',
  'ALLOW_M365_MUTATIONS',
  'WHATSOUP_CONNECTOR_FAILCLOSED',
  'WHATSOUP_AGENT_CONFIG_ROOT_ISOLATION',
  'WHATSOUP_INSTANCE',
  'WHATSOUP_MCP_SOCKET',
  'ENABLE_TOOL_SEARCH',
  'TOKENOMICS_BOT',
  'BASH_MAX_OUTPUT_LENGTH',
  'MAX_MCP_OUTPUT_TOKENS',
  'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'CLAUDE_CONFIG_DIR',
  'PLAYWRIGHT_MCP_SNAPSHOT_MODE',
  'PLAYWRIGHT_MCP_OUTPUT_MODE',
  'PLAYWRIGHT_MCP_CONSOLE_LEVEL',
] as const;

const TOKENOMICS_ENV_VARS = {
  ENABLE_TOOL_SEARCH: 'auto:5',
  TOKENOMICS_BOT: 'target-bot',
  BASH_MAX_OUTPUT_LENGTH: '120000',
  MAX_MCP_OUTPUT_TOKENS: '64000',
  CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '96000',
  CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: '1',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '0.72',
} as const;

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
      TMPDIR: '/tmp/owned-whatsoup',
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
      TMPDIR: '/tmp/owned-whatsoup',
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

  it('propagates ALLOW_M365_MUTATIONS when set by an opted-in instance', () => {
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

  it('emits reply-guarantee env only from explicit child-env options', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      WHATSOUP_INSTANCE: 'parent-instance',
      WHATSOUP_MCP_SOCKET: '/tmp/parent.sock',
    });

    const implicit = buildBaseChildEnv();
    expect(implicit).not.toHaveProperty('WHATSOUP_INSTANCE');
    expect(implicit).not.toHaveProperty('WHATSOUP_MCP_SOCKET');

    const explicit = buildBaseChildEnv({
      whatsoupInstance: 'line-a',
      whatsoupMcpSocket: '/tmp/line-a.sock',
    });
    expect(explicit).toMatchObject({
      WHATSOUP_INSTANCE: 'line-a',
      WHATSOUP_MCP_SOCKET: '/tmp/line-a.sock',
    });
  });

  it('passes tokenomics env vars through only when parent set and still strips unrelated or Playwright env', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      ...TOKENOMICS_ENV_VARS,
      TOKENOMICS_SECRET: 'must-not-leak',
      CUSTOM_SECRET: 'custom-secret',
      PLAYWRIGHT_MCP_SNAPSHOT_MODE: 'full',
      PLAYWRIGHT_MCP_OUTPUT_MODE: 'file',
      PLAYWRIGHT_MCP_CONSOLE_LEVEL: 'warning',
    });

    const env = buildBaseChildEnv();

    expect(env).toMatchObject(TOKENOMICS_ENV_VARS);
    expect(env).not.toHaveProperty('TOKENOMICS_SECRET');
    expect(env).not.toHaveProperty('CUSTOM_SECRET');
    expect(env).not.toHaveProperty('PLAYWRIGHT_MCP_SNAPSHOT_MODE');
    expect(env).not.toHaveProperty('PLAYWRIGHT_MCP_OUTPUT_MODE');
    expect(env).not.toHaveProperty('PLAYWRIGHT_MCP_CONSOLE_LEVEL');

    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
    });

    const unsetEnv = buildBaseChildEnv();
    for (const key of Object.keys(TOKENOMICS_ENV_VARS)) {
      expect(unsetEnv).not.toHaveProperty(key);
    }
  });

  it('forwards CLAUDE_CONFIG_DIR when the parent sets it, and omits it when unset', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
      CLAUDE_CONFIG_DIR: '/tmp/child-home/.claude',
    });

    const env = buildBaseChildEnv();
    expect(env).toHaveProperty('CLAUDE_CONFIG_DIR', '/tmp/child-home/.claude');

    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/child-home',
    });

    const unsetEnv = buildBaseChildEnv();
    expect(unsetEnv).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it('keeps parent HOME and XDG roots by default even when configRoot is supplied', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/host/home',
      XDG_CONFIG_HOME: '/host/config',
      XDG_DATA_HOME: '/host/data',
    });

    const env = buildBaseChildEnv({ configRoot: '/workspace/.agent-home' });

    expect(env).toMatchObject({
      HOME: '/host/home',
      XDG_CONFIG_HOME: '/host/config',
      XDG_DATA_HOME: '/host/data',
    });
  });

  it('rewrites HOME and XDG roots when config-root isolation is explicitly enabled', () => {
    resetManagedEnv({
      PATH: '/usr/bin',
      HOME: '/host/home',
      XDG_CONFIG_HOME: '/host/config',
      XDG_DATA_HOME: '/host/data',
      WHATSOUP_AGENT_CONFIG_ROOT_ISOLATION: '1',
    });

    const env = buildBaseChildEnv({ configRoot: '/workspace/.agent-home' });

    expect(env).toMatchObject({
      HOME: '/workspace/.agent-home',
      XDG_CONFIG_HOME: '/workspace/.agent-home/.config',
      XDG_DATA_HOME: '/workspace/.agent-home/.local/share',
    });
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

  it('exports the config-root isolation flag name', () => {
    expect(CONFIG_ROOT_ISOLATION_FLAG).toBe('WHATSOUP_AGENT_CONFIG_ROOT_ISOLATION');
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
