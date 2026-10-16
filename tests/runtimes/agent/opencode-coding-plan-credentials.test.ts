/**
 * End-to-end credential contract for OpenCode coding-plan provider ids: the
 * model prefix selects a credential service, the real lookupCredential resolves
 * it (environment, private file, platform keyring, OpenCode auth.json), and
 * buildChildEnv forwards exactly one key under the variable OpenCode reads for
 * that provider. Only the platform keyring command is stubbed (always "absent").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../../helpers/child-process.ts');
  return childProcessMock();
});

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  _resetBackendCache,
  _setFileStoreDirForTests,
  _setOpenCodeAuthDirForTests,
  SERVICE_ENV_MAP,
} from '../../../src/lib/keyring.ts';
import { buildChildEnv } from '../../../src/runtimes/agent/session.ts';

const mockedExecFileSync = vi.mocked(execFileSync);
const PROVIDER_ENV_VARS = [...new Set(Object.values(SERVICE_ENV_MAP))];

function keychainItemNotFound(): Error {
  const err: Error & { status?: number; stderr?: Buffer } = new Error('Command failed: security find-generic-password');
  err.status = 44;
  err.stderr = Buffer.from('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n');
  return err;
}

function providerKeysIn(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    PROVIDER_ENV_VARS.filter((name) => Object.prototype.hasOwnProperty.call(env, name)).map((name) => [name, env[name]]),
  );
}

describe('opencode-cli coding-plan credentials reach the child environment', () => {
  const originalPlatform = process.platform;
  const savedEnv: Record<string, string | undefined> = {};
  let storeDir: string;
  let openCodeDir: string;

  function writeOpenCodeAuth(entries: Record<string, string>): void {
    const data = Object.fromEntries(Object.entries(entries).map(([id, key]) => [id, { type: 'api', key }]));
    fs.writeFileSync(path.join(openCodeDir, 'auth.json'), JSON.stringify(data), { mode: 0o600 });
  }

  beforeEach(() => {
    _resetBackendCache();
    mockedExecFileSync.mockReset();
    mockedExecFileSync.mockImplementation(() => { throw keychainItemNotFound(); });
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
    for (const name of PROVIDER_ENV_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-coding-plan-store-'));
    openCodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-coding-plan-auth-'));
    _setFileStoreDirForTests(storeDir);
    _setOpenCodeAuthDirForTests(openCodeDir);
  });

  afterEach(() => {
    _setFileStoreDirForTests(null);
    _setOpenCodeAuthDirForTests(null);
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(openCodeDir, { recursive: true, force: true });
    for (const name of PROVIDER_ENV_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    _resetBackendCache();
  });

  it('forwards a zai-coding-plan environment credential as ZHIPU_API_KEY only', () => {
    process.env.ZHIPU_API_KEY = 'synthetic-zhipu-key';
    process.env.ZAI_API_KEY = 'synthetic-unselected-zai-key';

    const env = buildChildEnv('opencode-cli', undefined, 'zai-coding-plan/synthetic-model');

    expect(providerKeysIn(env)).toEqual({ ZHIPU_API_KEY: 'synthetic-zhipu-key' });
  });

  it('forwards an OpenCode auth.json login stored under the provider id', () => {
    writeOpenCodeAuth({
      'zai-coding-plan': 'synthetic-opencode-login-key',
      glm: 'synthetic-unselected-glm-key',
    });

    const env = buildChildEnv('opencode-cli', undefined, 'zai-coding-plan/synthetic-model');

    expect(providerKeysIn(env)).toEqual({ ZHIPU_API_KEY: 'synthetic-opencode-login-key' });
  });

  it('selects the minimax-coding-plan login, not the plain minimax login', () => {
    writeOpenCodeAuth({
      'minimax-coding-plan': 'synthetic-coding-plan-key',
      minimax: 'synthetic-unselected-minimax-key',
    });

    const env = buildChildEnv('opencode-cli', undefined, 'minimax-coding-plan/synthetic-model');

    expect(providerKeysIn(env)).toEqual({ MINIMAX_API_KEY: 'synthetic-coding-plan-key' });
  });

  it('forwards no provider key when the selected credential is absent everywhere', () => {
    writeOpenCodeAuth({ minimax: 'synthetic-unselected-minimax-key' });

    const env = buildChildEnv('opencode-cli', undefined, 'zai-coding-plan/synthetic-model');

    expect(providerKeysIn(env)).toEqual({});
  });
});
