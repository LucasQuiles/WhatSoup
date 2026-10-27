import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBaseChildEnv } from '../../../../src/runtimes/agent/providers/child-env.ts';
import { makeAccountAuthStatusProbe } from '../../../../src/runtimes/agent/providers/account-auth-status.ts';
import { observeClaudeAccountIdentity } from '../../../../src/runtimes/agent/providers/claude-account-identity.ts';
import { createPrimaryModelProbeAdapters } from '../../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';

describe('Claude diagnostic and identity probes use the configured egress proxy', () => {
  const sourceEnv = {
    HOME: '/fixture/home', PATH: '/usr/bin', USER: 'fixture',
    CLAUDE_CONFIG_DIR: '/fixture/config', CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    HTTP_PROXY: 'http://ambient.invalid:9999', ALL_PROXY: 'http://ambient.invalid:9999',
  };

  for (const surface of ['diagnostic', 'identity'] as const) {
    it.each([undefined, 4312])(`${surface} uses only the configured port: %s`, async (egressProxyPort) => {
      const observed: NodeJS.ProcessEnv[] = [];
      const probe = async (_binary: string, _args: string[], env: NodeJS.ProcessEnv) => {
        observed.push(env);
        return { status: 'ok' as const, output: '{"loggedIn":false}' };
      };
      const deps = {
        resolveKeyService: () => null, lookupCredential: () => null,
        getProviderBinary: () => '/fixture/claude', probeBinaryAuthStatus: probe,
        probeBinaryCommand: probe, isAuthRequiredMessage: () => false,
        env: sourceEnv, egressProxyPort,
      };
      if (surface === 'diagnostic') {
        await makeAccountAuthStatusProbe({ provider: 'claude-cli' }, deps)(new AbortController().signal);
      } else {
        await observeClaudeAccountIdentity(deps);
      }
      expect(observed).toHaveLength(1);
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
        expect(observed[0]![key]).toBe(egressProxyPort ? 'http://127.0.0.1:4312' : undefined);
      }
      for (const key of ['NO_PROXY', 'no_proxy']) {
        expect(observed[0]![key]).toBe(egressProxyPort ? 'localhost,127.0.0.1' : undefined);
      }
      expect(observed[0]).not.toHaveProperty('ALL_PROXY');
      expect(observed[0]).not.toHaveProperty('all_proxy');
      expect(observed[0]!.CLAUDE_CONFIG_DIR).toBe('/fixture/config');
      expect(observed[0]!.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('');
    });
  }
});

const cases = [
  { name: 'unset', config: '/fixture/config', secure: undefined },
  { name: 'empty secure override', config: '/fixture/config', secure: '' },
  { name: 'secure override', config: '/fixture/config', secure: '/fixture/secure' },
  { name: 'secure only', config: undefined, secure: '/fixture/secure' },
];

describe('Claude credential selection agrees across serving and probes', () => {
  afterEach(() => vi.unstubAllEnvs());

  for (const surface of ['serving', 'diagnostic', 'identity', 'model'] as const) {
    it.each(cases)(`${surface} preserves $name`, async ({ config, secure }) => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', config);
      vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', secure);
      const env = {
        HOME: '/fixture/home', PATH: '/usr/bin', USER: 'fixture',
        ...(config !== undefined ? { CLAUDE_CONFIG_DIR: config } : {}),
        ...(secure !== undefined ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: secure } : {}),
        PRIVATE_SENTINEL: 'not-forwarded',
      };
      const observed: NodeJS.ProcessEnv[] = [];
      const probe = vi.fn(async (_binary: string, _args: string[], childEnv: NodeJS.ProcessEnv) => {
        observed.push(childEnv);
        return { status: 'ok' as const, output: '{"loggedIn":false}' };
      });

      if (surface === 'serving') {
        observed.push(buildBaseChildEnv());
      } else if (surface === 'diagnostic') {
        await makeAccountAuthStatusProbe({ provider: 'claude-cli', model: 'fixture-model' }, {
          resolveKeyService: () => null, lookupCredential: () => null,
          getProviderBinary: () => '/fixture/claude', probeBinaryAuthStatus: probe,
          isAuthRequiredMessage: () => false, env,
        })(new AbortController().signal);
      } else if (surface === 'identity') {
        await observeClaudeAccountIdentity({ getProviderBinary: () => '/fixture/claude', probeBinaryCommand: probe, env });
      } else {
        const adapters = createPrimaryModelProbeAdapters(undefined, {
          getProviderBinary: () => '/fixture/claude', probeBinaryCommand: probe,
          ensureClaudeFileStoreCredential: () => ({ outcome: 'skipped-not-darwin' }),
        });
        await adapters.probeBinaryModel!({ provider: 'claude-cli', model: 'fixture-model' });
      }

      expect(observed).toHaveLength(1);
      expect(observed[0]!.CLAUDE_CONFIG_DIR).toBe(config);
      expect(observed[0]!.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(secure);
      expect(Object.hasOwn(observed[0]!, 'CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(secure !== undefined);
      expect(observed[0]).not.toHaveProperty('PRIVATE_SENTINEL');
    });
  }
});
