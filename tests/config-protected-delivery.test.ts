import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_DELIVERY_BASE_URL } from './helpers/protected-delivery-pins.ts';

// config.ts parses with the production pins; swap in the neutral test pins.
vi.mock('../src/core/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('./helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal));

const MANAGED_URL = TEST_DELIVERY_BASE_URL;
const CREDENTIAL_ENV = 'LINKS_MANAGED_CONFIG_TEST_TOKEN';

let tempDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    INSTANCE_CONFIG: process.env.INSTANCE_CONFIG,
    [CREDENTIAL_ENV]: process.env[CREDENTIAL_ENV],
    WHATSOUP_CONFIG_DIR: process.env.WHATSOUP_CONFIG_DIR,
    WHATSOUP_DATA_DIR: process.env.WHATSOUP_DATA_DIR,
    WHATSOUP_STATE_DIR: process.env.WHATSOUP_STATE_DIR,
    TMPDIR: process.env.TMPDIR,
  };
  tempDir = mkdtempSync(join(tmpdir(), 'config-protected-delivery-'));
  process.env.WHATSOUP_CONFIG_DIR = join(tempDir, 'config');
  process.env.WHATSOUP_DATA_DIR = join(tempDir, 'data');
  process.env.WHATSOUP_STATE_DIR = join(tempDir, 'state');
  delete process.env.INSTANCE_CONFIG;
  delete process.env[CREDENTIAL_ENV];
  vi.resetModules();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
  vi.resetModules();
});

function instanceConfig(agentOptions: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'protected-delivery-config-test',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15550000001'],
    paths: {
      configRoot: join(tempDir, 'instance-config'),
      dataRoot: join(tempDir, 'instance-data'),
      stateRoot: join(tempDir, 'instance-state'),
      authDir: join(tempDir, 'instance-config', 'auth'),
      dbPath: join(tempDir, 'instance-data', 'bot.db'),
      logDir: join(tempDir, 'instance-data', 'logs'),
      lockPath: join(tempDir, 'instance-state', 'bot.lock'),
      mediaDir: join(tempDir, 'instance-data', 'media'),
    },
    agentOptions,
  };
}

function protectedDelivery(enabled = true): Record<string, unknown> {
  return enabled
    ? { enabled: true, baseUrl: MANAGED_URL, credentialEnv: CREDENTIAL_ENV }
    : { enabled: false };
}

async function importConfig(agentOptions: Record<string, unknown>, credential?: string) {
  process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig(agentOptions));
  if (credential === undefined) delete process.env[CREDENTIAL_ENV];
  else process.env[CREDENTIAL_ENV] = credential;
  return import('../src/config.ts');
}

async function expectBindingFailure(agentOptions: Record<string, unknown>): Promise<void> {
  const { ConfigValidationError } = await import('../src/lib/startup-error.ts');
  await expect(importConfig(agentOptions, undefined)).rejects.toBeInstanceOf(ConfigValidationError);
  await expect(importConfig(agentOptions, undefined)).rejects.toThrow(/protectedDelivery requires per_chat/);
}

describe('raw INSTANCE_CONFIG protected-delivery admission', () => {
  it('fails unbound delivery before reading a credential', async () => {
    await expectBindingFailure({
      sessionScope: 'single',
      provider: 'openai-api',
      protectedDelivery: protectedDelivery(),
    });
  });

  it('accepts a per-chat CLI route with an explicit binding', async () => {
    const { config } = await importConfig({
      sessionScope: 'per_chat',
      provider: 'claude-cli',
      sandboxPerChat: true,
      protectedDelivery: protectedDelivery(),
    }, 'DUMMY managed token');
    expect(config.protectedDelivery).toMatchObject({ baseUrl: MANAGED_URL });
  });

  it('accepts an unflagged per-chat managed-loop route', async () => {
    const { config } = await importConfig({
      sessionScope: 'per_chat',
      provider: 'openai-api',
      protectedDelivery: protectedDelivery(),
    }, 'DUMMY managed token');
    expect(config.protectedDelivery).toMatchObject({ baseUrl: MANAGED_URL });
  });

  it('rejects a CLI fallback without an explicit binding', async () => {
    await expectBindingFailure({
      sessionScope: 'per_chat',
      provider: 'openai-api',
      fallbacks: [{ provider: 'claude-cli' }],
      protectedDelivery: protectedDelivery(),
    });
  });

  it('rejects fallback discovery without an explicit binding', async () => {
    await expectBindingFailure({
      sessionScope: 'per_chat',
      provider: 'openai-api',
      fallbackDiscovery: { mode: 'auto' },
      protectedDelivery: protectedDelivery(),
    });
  });

  it('leaves disabled delivery unchanged', async () => {
    const { config } = await importConfig({
      sessionScope: 'single',
      provider: 'claude-cli',
      protectedDelivery: protectedDelivery(false),
    }, undefined);
    expect(config).toHaveProperty('protectedDelivery', null);
  });

  it('admits linkHosts taken from config when every host is hash-pinned', async () => {
    const { config } = await importConfig({
      sessionScope: 'per_chat',
      provider: 'openai-api',
      protectedDelivery: { ...protectedDelivery(), linkHosts: ['links.example.test'] },
    }, 'DUMMY managed token');
    expect(config.protectedDelivery).toMatchObject({ baseUrl: MANAGED_URL, linkHosts: ['links.example.test'] });
  });

  it('fails startup when linkHosts names a host that is not pinned', async () => {
    const { ConfigValidationError } = await import('../src/lib/startup-error.ts');
    const agentOptions = {
      sessionScope: 'per_chat',
      provider: 'openai-api',
      protectedDelivery: { ...protectedDelivery(), linkHosts: ['links.example.test', 'evil.invalid'] },
    };
    await expect(importConfig(agentOptions, 'DUMMY managed token')).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(importConfig(agentOptions, 'DUMMY managed token')).rejects.toThrow(/linkHosts/);
  });
});
