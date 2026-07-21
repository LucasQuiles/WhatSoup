import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookupCredentialMock = vi.fn<(service: string) => string | null>();

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

import { buildChildEnv } from '../../../src/runtimes/agent/session.ts';
import { CONFIG_ROOT_ISOLATION_FLAG } from '../../../src/runtimes/agent/providers/child-env.ts';

function hasKey(env: NodeJS.ProcessEnv, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

const MODEL_CREDENTIAL_CASES = [
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['deepseek', 'DEEPSEEK_API_KEY'],
  ['minimax', 'MINIMAX_API_KEY'],
  ['glm', 'ZAI_API_KEY'],
  ['xai', 'XAI_API_KEY'],
  ['groq', 'GROQ_API_KEY'],
  ['mistral', 'MISTRAL_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY'],
  ['google', 'GOOGLE_API_KEY'],
  ['fireworks-ai', 'FIREWORKS_API_KEY'],
  ['togetherai', 'TOGETHER_API_KEY'],
] as const;

const PROVIDER_CREDENTIAL_KEYS = MODEL_CREDENTIAL_CASES.map(([, envVar]) => envVar);

const REQUIRED_PARENT_ENV = {
  PATH: '/test/bin',
  HOME: '/test/home',
  USER: 'test-user',
  SHELL: '/bin/test-shell',
  LANG: 'C.UTF-8',
  TERM: 'dumb',
  NODE_PATH: '/test/node_modules',
  XDG_RUNTIME_DIR: '/tmp/test-runtime',
  XDG_CONFIG_HOME: '/tmp/test-config',
  XDG_DATA_HOME: '/tmp/test-data',
  TMPDIR: '/tmp/test-tmp',
} as const;

const DENIED_PARENT_ENV = {
  SUDO_ASKPASS: '/tmp/test-askpass',
  ALLOW_M365_MUTATIONS: '1',
  CLAUDE_CONFIG_DIR: '/tmp/test-claude-config',
  ALLOW_GITHUB_MUTATIONS: '1',
  UNRELATED_CONNECTOR_MUTATIONS: '1',
  UNRELATED_PROVIDER_MUTATIONS: '1',
  GITHUB_TOKEN: 'test-github-token',
  GH_TOKEN: 'test-gh-token',
  OPENCODE_API_KEY: 'test-opencode-key',
  GEMINI_API_KEY: 'parent-gemini-key',
  GOOGLE_GENERATIVE_AI_API_KEY: 'parent-google-generative-key',
  UNKNOWN_VENDOR_SECRET_TOKEN: 'test-unknown-secret',
  ...Object.fromEntries(PROVIDER_CREDENTIAL_KEYS.map((key) => [key, `parent-${key}`])),
} as const;

const MUTATED_ENV = {
  ...REQUIRED_PARENT_ENV,
  ...DENIED_PARENT_ENV,
  [CONFIG_ROOT_ISOLATION_FLAG]: '0',
};

describe('buildChildEnv — opencode-cli least-authority environment', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    lookupCredentialMock.mockReset();
    for (const [key, value] of Object.entries(MUTATED_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(MUTATED_ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('constructs the characterized system/WhatSoup allowlist and one selected credential', () => {
    lookupCredentialMock.mockImplementation((service) =>
      service === 'glm' ? 'test-glm-key' : null,
    );

    const env = buildChildEnv(
      'opencode-cli',
      { whatsoupInstance: 'test-line', whatsoupMcpSocket: '/tmp/test-whatsoup.sock' },
      'glm/glm-5.2',
    );

    expect(env).toEqual({
      ...REQUIRED_PARENT_ENV,
      WHATSOUP_INSTANCE: 'test-line',
      WHATSOUP_MCP_SOCKET: '/tmp/test-whatsoup.sock',
      ZAI_API_KEY: 'test-glm-key',
    });
    expect(lookupCredentialMock.mock.calls).toEqual([['glm']]);
  });

  it('resolves Gemini credentials from the keyring at child creation', () => {
    process.env.GOOGLE_API_KEY = 'inherited-google-key';
    process.env.GEMINI_API_KEY = 'inherited-gemini-key';
    lookupCredentialMock.mockImplementation((service) =>
      service === 'google' ? 'keyring-google-key' : null,
    );

    const env = buildChildEnv('gemini-cli');

    expect(lookupCredentialMock.mock.calls).toEqual([['google']]);
    expect(env.GOOGLE_API_KEY).toBe('keyring-google-key');
    expect(env.GEMINI_API_KEY).toBe('keyring-google-key');
  });

  it('preserves direct-launch compatibility for the legacy Gemini env alias', () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'legacy-gemini-key';
    lookupCredentialMock.mockReturnValue(null);

    const env = buildChildEnv('gemini-cli');

    expect(lookupCredentialMock.mock.calls).toEqual([['google']]);
    expect(env.GOOGLE_API_KEY).toBe('legacy-gemini-key');
    expect(env.GEMINI_API_KEY).toBe('legacy-gemini-key');
  });

  it('omits Gemini aliases when secure and compatibility resolution miss', () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    lookupCredentialMock.mockReturnValue(null);

    const env = buildChildEnv('gemini-cli');

    const presentAliases = Object.keys(env).filter((name) => [
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
    ].includes(name));
    expect(presentAliases).toEqual([]);
  });

  it.each(MODEL_CREDENTIAL_CASES)(
    'maps model prefix %s to only %s',
    (service, envVar) => {
      lookupCredentialMock.mockImplementation((requested) =>
        requested === service ? `test-${service}-key` : null,
      );

      const env = buildChildEnv('opencode-cli', undefined, `${service}/test-model`);

      expect(lookupCredentialMock.mock.calls).toEqual([[service]]);
      expect(env[envVar]).toBe(`test-${service}-key`);
      expect(PROVIDER_CREDENTIAL_KEYS.filter((key) => hasKey(env, key))).toEqual([envVar]);
    },
  );

  it('uses a valid custom-endpoint apiKeyService instead of the model prefix', () => {
    lookupCredentialMock.mockImplementation((service) =>
      service === 'openai' ? 'test-custom-endpoint-key' : null,
    );

    const env = buildChildEnv('opencode-cli', undefined, 'anthropic/model-x', {
      baseUrl: 'https://endpoint.example/v1',
      apiKeyService: 'openai',
    });

    expect(lookupCredentialMock.mock.calls).toEqual([['openai']]);
    expect(env.OPENAI_API_KEY).toBe('test-custom-endpoint-key');
    expect(PROVIDER_CREDENTIAL_KEYS.filter((key) => hasKey(env, key))).toEqual(['OPENAI_API_KEY']);
  });

  it('does not copy privilege, mutation, non-selected credential, or unknown secret-shaped keys', () => {
    lookupCredentialMock.mockReturnValue('test-glm-key');

    const env = buildChildEnv('opencode-cli', undefined, 'glm/glm-5.2');

    for (const key of Object.keys(DENIED_PARENT_ENV)) {
      if (key === 'ZAI_API_KEY') continue;
      expect(hasKey(env, key), `${key} must be absent`).toBe(false);
    }
    expect(env.ZAI_API_KEY).toBe('test-glm-key');
  });

  it('uses isolated HOME/XDG roots without forwarding the controlling flag', () => {
    process.env[CONFIG_ROOT_ISOLATION_FLAG] = '1';
    lookupCredentialMock.mockReturnValue('test-glm-key');

    const env = buildChildEnv(
      'opencode-cli',
      { configRoot: '/tmp/test-opencode-root' },
      'glm/glm-5.2',
    );

    expect(env.HOME).toBe('/tmp/test-opencode-root');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/test-opencode-root/.config');
    expect(env.XDG_DATA_HOME).toBe('/tmp/test-opencode-root/.local/share');
    expect(hasKey(env, CONFIG_ROOT_ISOLATION_FLAG)).toBe(false);
  });

  it('consults only the selected service and leaves its env var absent when the credential is unavailable', () => {
    lookupCredentialMock.mockReturnValue(null);

    const env = buildChildEnv('opencode-cli', undefined, 'glm/glm-5.2');

    expect(lookupCredentialMock.mock.calls).toEqual([['glm']]);
    expect(PROVIDER_CREDENTIAL_KEYS.filter((key) => hasKey(env, key))).toEqual([]);
  });

  it('rejects apiKeyService without a custom endpoint', () => {
    expect(() => buildChildEnv('opencode-cli', undefined, 'glm/glm-5.2', {
      apiKeyService: 'openai',
    })).toThrow(/apiKeyService requires.*baseUrl/);
    expect(lookupCredentialMock).not.toHaveBeenCalled();
  });

  it.each(['pinecone', 'unknown-service', '', 7])(
    'rejects invalid custom-endpoint apiKeyService %j',
    (apiKeyService) => {
      expect(() => buildChildEnv('opencode-cli', undefined, 'glm/glm-5.2', {
        baseUrl: 'https://endpoint.example/v1',
        apiKeyService,
      })).toThrow(/mapped inference-provider service/);
      expect(lookupCredentialMock).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'bare-model', 'unmapped-vendor/model-x'])(
    'rejects a selected model without a mapped credential service: %j',
    (model) => {
      expect(() => buildChildEnv('opencode-cli', undefined, model)).toThrow(
        /does not resolve to a mapped provider credential service/,
      );
      expect(lookupCredentialMock).not.toHaveBeenCalled();
    },
  );
});
