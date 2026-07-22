import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
// Complete mock: ops.ts transitively imports fleet/index.ts and fleet/platform.ts,
// both of which call execFileSync at module-load (git rev-parse) / keyring probe time.
// An incomplete mock ({ execFile, spawn } only) leaves execFileSync as undefined,
// which the keyring backend probe catches — but vitest logs a warning per call and
// the fork worker can hang on teardown under --pool=forks (issue #1834).
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  exec: vi.fn(),
  execSync: vi.fn(),
}));

import { handleConfigUpdate } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';

function mockReq(body = ''): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  (stream as any).headers = {};
  (stream as any).url = '/';
  (stream as any).method = 'PATCH';
  process.nextTick(() => {
    (stream as unknown as PassThrough).write(body);
    (stream as unknown as PassThrough).end();
  });
  return stream;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) { res._status = status; },
    end(data?: string) { if (data) res._body = data; },
  };
  return res as any;
}

describe('handleConfigUpdate — plaintext provider-key strip', () => {
  let tmpDir: string;
  let configPath: string;
  let deps: OpsDeps;
  const envKeys = [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'INSTANCE_CONFIG',
    'TMPDIR',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-pk-strip-'));
    for (const k of envKeys) { saved[k] = process.env[k]; }
    process.env.HOME = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, '.local', 'share');
    process.env.XDG_STATE_HOME = path.join(tmpDir, '.local', 'state');
    const dir = path.join(process.env.XDG_CONFIG_HOME, 'whatsoup', 'instances', 'pk-line');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    configPath = path.join(dir, 'config.json');
    // adminPhones must be non-empty — the shared validator (agent-config-validator.ts)
    // rejects an empty array on PATCH with a 400, which would fail these tests for the
    // wrong reason (setup/validation), not the one under test (key persistence).
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'pk-line', type: 'chat', adminPhones: ['15551234567'], healthPort: 9095,
      accessMode: 'self_only', systemPrompt: 'You are a test bot.', introSent: true,
    }, null, 2) + '\n', { mode: 0o600 });
    deps = {
      discovery: {
        getInstance: vi.fn(() => ({ name: 'pk-line', configPath })),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn(), disable: vi.fn(), start: vi.fn(), stop: vi.fn(),
        restart: vi.fn(), startFire: vi.fn(),
      } as any,
    } as OpsDeps;
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('strips apiKey/openaiKey from a hostile PATCH; control sibling survives', async () => {
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        apiKey: 'anthropic-sentinel-direct',
        openaiKey: 'openai-sentinel-direct',
        api_key: 'anthropic-sentinel-snake',
        apiKeyBackup: 'anthropic-sentinel-backup',
        backupApiKey: 'anthropic-sentinel-prefix-backup',
        legacyApiKey: 'anthropic-sentinel-legacy',
        providerApiKey: 'anthropic-sentinel-provider',
        openai_key: 'openai-sentinel-snake',
        openaiKeyBackup: 'openai-sentinel-backup',
        backupOpenaiKey: 'openai-sentinel-prefix-backup',
        legacyOpenaiKey: 'openai-sentinel-legacy',
        backupAuthToken: 'twilio-token-evil',
        twilioAuthTokenBackup: 'twilio-token-backup-evil',
        legacyBluebubblesPassword: 'bluebubbles-password-evil',
        providerSecret: 'provider-secret-evil',
        providerSecretBackup: 'provider-secret-backup-evil',
        providerCredential: 'provider-credential-evil',
        providerCredentialCopy: 'provider-credential-copy-evil',
        healthToken: 'runtime-token-evil',
        maxTokens: 750,
        tokenBudget: 5000,
        description: 'kept',
      })),
      res, deps, { name: 'pk-line' },
    );
    expect(res._status).toBe(200);
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(disk.apiKey).toBeUndefined();
    expect(disk.openaiKey).toBeUndefined();
    expect(disk.api_key).toBeUndefined();
    expect(disk.apiKeyBackup).toBeUndefined();
    expect(disk.backupApiKey).toBeUndefined();
    expect(disk.legacyApiKey).toBeUndefined();
    expect(disk.providerApiKey).toBeUndefined();
    expect(disk.openai_key).toBeUndefined();
    expect(disk.openaiKeyBackup).toBeUndefined();
    expect(disk.backupOpenaiKey).toBeUndefined();
    expect(disk.legacyOpenaiKey).toBeUndefined();
    expect(disk.backupAuthToken).toBeUndefined();
    expect(disk.twilioAuthTokenBackup).toBeUndefined();
    expect(disk.legacyBluebubblesPassword).toBeUndefined();
    expect(disk.providerSecret).toBeUndefined();
    expect(disk.providerSecretBackup).toBeUndefined();
    expect(disk.providerCredential).toBeUndefined();
    expect(disk.providerCredentialCopy).toBeUndefined();
    expect(disk.healthToken).toBeUndefined();
    expect(disk.maxTokens).toBe(750);
    expect(disk.tokenBudget).toBe(5000);
    expect(disk.description).toBe('kept');
    const body = JSON.parse(res._body);
    expect(body.apiKey).toBeUndefined();
    expect(body.openaiKey).toBeUndefined();
    // strong terminal assertion: the raw on-disk bytes carry NEITHER key value
    const rawDisk = fs.readFileSync(configPath, 'utf8');
    expect(rawDisk).not.toContain('anthropic-sentinel-direct');
    expect(rawDisk).not.toContain('openai-sentinel-direct');
    expect(rawDisk).not.toContain('anthropic-sentinel-snake');
    expect(rawDisk).not.toContain('anthropic-sentinel-backup');
    expect(rawDisk).not.toContain('anthropic-sentinel-prefix-backup');
    expect(rawDisk).not.toContain('anthropic-sentinel-legacy');
    expect(rawDisk).not.toContain('anthropic-sentinel-provider');
    expect(rawDisk).not.toContain('openai-sentinel-snake');
    expect(rawDisk).not.toContain('openai-sentinel-backup');
    expect(rawDisk).not.toContain('openai-sentinel-prefix-backup');
    expect(rawDisk).not.toContain('openai-sentinel-legacy');
    expect(rawDisk).not.toContain('twilio-token-evil');
    expect(rawDisk).not.toContain('twilio-token-backup-evil');
    expect(rawDisk).not.toContain('bluebubbles-password-evil');
    expect(rawDisk).not.toContain('provider-secret-evil');
    expect(rawDisk).not.toContain('provider-secret-backup-evil');
    expect(rawDisk).not.toContain('provider-credential-evil');
    expect(rawDisk).not.toContain('provider-credential-copy-evil');
    expect(rawDisk).not.toContain('runtime-token-evil');
    expect(res._body).not.toContain('twilio-token-evil');
    expect(res._body).not.toContain('twilio-token-backup-evil');
    expect(res._body).not.toContain('bluebubbles-password-evil');
    expect(res._body).not.toContain('provider-secret-evil');
    expect(res._body).not.toContain('provider-secret-backup-evil');
    expect(res._body).not.toContain('provider-credential-evil');
    expect(res._body).not.toContain('provider-credential-copy-evil');
    expect(res._body).not.toContain('runtime-token-evil');
  });

  it('rejects nested plaintext provider keys on PATCH without changing persisted config', async () => {
    const before = fs.readFileSync(configPath, 'utf8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        chatOptions: {
          openaiProviderConfig: {
            baseUrl: 'https://chat.example.test/v1',
            apiKeyService: 'openai',
            apiKey: 'nested-chat-patch-secret',
          },
        },
        transcriptionOptions: {
          openaiProviderConfig: {
            baseUrl: 'https://audio.example.test/v1',
            apiKeyService: 'openai',
            openaiKey: 'nested-audio-patch-secret',
          },
        },
      })),
      res,
      deps,
      { name: 'pk-line' },
    );

    expect(res._status).toBe(400);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(res._body).not.toContain('nested-chat-patch-secret');
    expect(res._body).not.toContain('nested-audio-patch-secret');
  });

  it('remediation: a pre-existing on-disk plaintext key is scrubbed by an unrelated PATCH', async () => {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.apiKey = 'anthropic-sentinel-victim';
    existing.transport = 'twilio';
    existing.twilioConfig = {
      account: 'pk-line',
      accountSid: `AC${'a'.repeat(32)}`,
      authTokenService: 'whatsoup-twilio-pk-line',
      phoneNumber: '+15551234567',
      inboundMode: 'poll',
      pollIntervalMs: 15_000,
      legacySecret: 'nested-victim-secret',
    };
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ description: 'unrelated touch' })),
      res, deps, { name: 'pk-line' },
    );
    expect(res._status).toBe(200);
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).not.toContain('anthropic-sentinel-victim');
    expect(raw).not.toContain('nested-victim-secret');
    expect(JSON.parse(raw).description).toBe('unrelated touch');
  });

  it('migrates legacy Pinecone maps without treating secretary as a secret field', async () => {
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        pineconeProjectId: 'test-project',
        pineconeNamespaces: {
          secretary: 'secretary-namespace',
          'docs.v1': 'docs-v1-namespace',
        },
        pineconeKnowledgeProfiles: {
          secretary: {
            namespace: 'secretary-namespace',
            description: 'safe profile',
            provider: { value: 'unsupported-provider-secret-sentinel' },
            providers: [[['unsupported-array-secret-sentinel']]],
          },
        },
      })),
      res,
      deps,
      { name: 'pk-line' },
    );

    expect(res._status).toBe(200);
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(disk).not.toHaveProperty('pineconeNamespaces');
    expect(disk).not.toHaveProperty('pineconeKnowledgeProfiles');
    expect(disk.memory.pinecone.namespaces.secretary).toBe('secretary-namespace');
    expect(disk.memory.pinecone.namespaces['docs.v1']).toBe('docs-v1-namespace');
    expect(disk.memory.pinecone.namespaces.docs).toBeUndefined();
    expect(disk.memory.pinecone.knowledgeProfiles.secretary).toEqual({
      namespace: 'secretary-namespace',
      description: 'safe profile',
    });
    const rawDisk = fs.readFileSync(configPath, 'utf8');
    expect(rawDisk).not.toContain('unsupported-provider-secret-sentinel');
    expect(rawDisk).not.toContain('unsupported-array-secret-sentinel');
    expect(res._body).not.toContain('unsupported-provider-secret-sentinel');
    expect(res._body).not.toContain('unsupported-array-secret-sentinel');

    const { loadInstance } = await import('../../../src/instance-loader.ts');
    expect(() => loadInstance('pk-line')).not.toThrow();
    const loaded = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(loaded.memory.pinecone.namespaces.secretary).toBe('secretary-namespace');
    expect(loaded.memory.pinecone.namespaces['docs.v1']).toBe('docs-v1-namespace');
    expect(loaded.memory.pinecone.namespaces.docs).toBeUndefined();
    expect(loaded.memory.pinecone.knowledgeProfiles.secretary).toEqual({
      namespace: 'secretary-namespace',
      description: 'safe profile',
    });
  });

  it('strips misplaced Pinecone environment selectors before PATCH persistence and load', async () => {
    const sentinel = 'literal-nested-secret-sentinel';
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        memory: {
          retention: {
            days: { pineconeApiKeyEnv: sentinel },
          },
        },
      })),
      res,
      deps,
      { name: 'pk-line' },
    );

    expect(res._status).toBe(200);
    const rawDisk = fs.readFileSync(configPath, 'utf8');
    expect(rawDisk).not.toContain(sentinel);
    expect(res._body).not.toContain(sentinel);

    const disk = JSON.parse(rawDisk);
    expect(disk.memory.retention.days).toEqual({});

    const { loadInstance } = await import('../../../src/instance-loader.ts');
    expect(() => loadInstance('pk-line')).not.toThrow();
    const loaded = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(loaded.memory.retention.days).toEqual({});
  });

  it('does not persist dotted keys that impersonate canonical secret exemptions', async () => {
    const secretSentinel = 'dotted-map-secret-sentinel';
    const selectorSentinel = 'DOTTED_SELECTOR_SENTINEL';
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        'memory.pinecone.knowledgeProfiles': { apiKey: secretSentinel },
        'memory.pinecone': { apiKeyEnv: selectorSentinel },
      })),
      res,
      deps,
      { name: 'pk-line' },
    );

    expect(res._status).toBe(200);
    const rawDisk = fs.readFileSync(configPath, 'utf8');
    for (const sentinel of [secretSentinel, selectorSentinel]) {
      expect(rawDisk).not.toContain(sentinel);
      expect(res._body).not.toContain(sentinel);
    }
    const disk = JSON.parse(rawDisk);
    expect(disk['memory.pinecone.knowledgeProfiles']).toEqual({});
    expect(disk['memory.pinecone']).toEqual({});

    const { loadInstance } = await import('../../../src/instance-loader.ts');
    expect(() => loadInstance('pk-line')).not.toThrow();
    const loaded = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(loaded['memory.pinecone.knowledgeProfiles']).toEqual({});
    expect(loaded['memory.pinecone']).toEqual({});
  });

  it('round-trips an own __proto__ namespace through PATCH, disk, response, and load', async () => {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.pineconeProjectId = 'test-project';
    existing.pineconeNamespaces = { existing: 'existing-namespace' };
    fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq('{"pineconeNamespaces":{"__proto__":"proto-namespace"}}'),
      res,
      deps,
      { name: 'pk-line' },
    );

    expect(res._status).toBe(200);
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const diskNamespaces = disk.memory.pinecone.namespaces;
    expect(diskNamespaces.existing).toBe('existing-namespace');
    expect(Object.hasOwn(diskNamespaces, '__proto__')).toBe(true);
    expect(diskNamespaces['__proto__']).toBe('proto-namespace');
    expect(JSON.parse(res._body).memory.pinecone.namespaces['__proto__']).toBe('proto-namespace');

    const { loadInstance } = await import('../../../src/instance-loader.ts');
    expect(() => loadInstance('pk-line')).not.toThrow();
    const loaded = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(Object.hasOwn(loaded.memory.pinecone.namespaces, '__proto__')).toBe(true);
    expect(loaded.memory.pinecone.namespaces['__proto__']).toBe('proto-namespace');
  });

  it('rejects a Twilio webhook URL query on PATCH without changing persisted config', async () => {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.transport = 'twilio';
    existing.twilioConfig = {
      account: 'pk-line',
      accountSid: `AC${'a'.repeat(32)}`,
      authTokenService: 'whatsoup-twilio-pk-line',
      phoneNumber: '+15551234567',
      inboundMode: 'webhook',
      pollIntervalMs: 15_000,
      webhook: { publicBaseUrl: 'https://relay.example.test/twilio', listenPort: 8443 },
    };
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });

    const before = fs.readFileSync(configPath, 'utf8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        twilioConfig: {
          webhook: {
            publicBaseUrl: 'https://relay.example.test/twilio?token=url-query-marker',
          },
        },
      })),
      res, deps, { name: 'pk-line' },
    );

    expect(res._status).toBe(400);
    expect(res._body).not.toContain('url-query-marker');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('rejects hostile provider headers on PATCH without changing persisted config', async () => {
    const before = fs.readFileSync(configPath, 'utf8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        chatOptions: {
          openaiProviderConfig: {
            headers: { Authorization: 'patch-provider-header-sentinel' },
          },
        },
      })),
      res,
      deps,
      { name: 'pk-line' },
    );

    expect(res._status).toBe(400);
    expect(res._body).not.toContain('patch-provider-header-sentinel');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it.each([
    {
      transport: 'twilio',
      field: 'twilioConfig',
      secrets: {
        authToken: 'raw-twilio-token',
        auth_token: 'raw-twilio-token-snake',
        token: 'raw-twilio-token-short',
        authTokenBackup: 'raw-twilio-token-backup',
        backupAuthToken: 'raw-twilio-token-prefix-backup',
        secret: 'raw-twilio-generic-secret',
        twilioToken: 'raw-twilio-prefixed-token',
      },
      safeField: 'authTokenService',
      safeValue: 'whatsoup-twilio-pk-line',
      config: {
        account: 'pk-line',
        accountSid: `AC${'a'.repeat(32)}`,
        authTokenService: 'whatsoup-twilio-pk-line',
        phoneNumber: '+15551234567',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    },
    {
      transport: 'signal',
      field: 'signalConfig',
      secrets: {
        token: 'raw-signal-token',
        secret: 'raw-signal-secret',
        credential: 'raw-signal-credential',
      },
      safeField: 'socketPath',
      safeValue: '/tmp/updated-signal.sock',
      config: {
        account: 'pk-line',
        phoneNumber: '+15551234567',
        socketPath: '/tmp/existing-signal.sock',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    },
    {
      transport: 'imessage',
      field: 'imessageConfig',
      secrets: {
        bluebubblesPassword: 'raw-bluebubbles-password',
        bluebubbles_password: 'raw-bluebubbles-password-snake',
        password: 'raw-bluebubbles-password-short',
        passwordBackup: 'raw-bluebubbles-password-backup',
        backupBluebubblesPassword: 'raw-bluebubbles-prefix-backup',
        bluebubblesSecret: 'raw-bluebubbles-generic-secret',
      },
      safeField: 'bluebubblesPasswordService',
      safeValue: 'whatsoup-bluebubbles-pk-line',
      config: {
        account: 'pk-line',
        backend: 'bluebubbles',
        sender: 'owner@example.com',
        bluebubblesUrl: 'https://messages.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-pk-line',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    },
  ])('strips raw secret aliases from $field PATCH disk and response while preserving safe siblings', async ({
    transport,
    field,
    secrets,
    safeField,
    safeValue,
    config,
  }) => {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.transport = transport;
    if (transport === 'signal') existing.adminPhones = ['+15551234567'];
    existing[field] = config;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        [field]: {
          ...secrets,
          [safeField]: safeValue,
        },
      })),
      res,
      deps,
      { name: 'pk-line' },
    );

    expect(res._status).toBe(200);
    const rawDisk = fs.readFileSync(configPath, 'utf8');
    const disk = JSON.parse(rawDisk);
    const body = JSON.parse(res._body);
    for (const [secretField, secretValue] of Object.entries(secrets)) {
      expect(disk[field][secretField]).toBeUndefined();
      expect(body[field][secretField]).toBeUndefined();
      expect(rawDisk).not.toContain(secretValue);
      expect(res._body).not.toContain(secretValue);
    }
    expect(disk[field][safeField]).toBe(safeValue);
    expect(body[field][safeField]).toBe(safeValue);
    expect(disk[field].account).toBe('pk-line');
    expect(body[field].account).toBe('pk-line');
  });
});

describe('handleCreateLine — plaintext provider-key strip guard', () => {
  let tmpDir: string;
  const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-pk-create-'));
    for (const k of envKeys) { saved[k] = process.env[k]; }
    process.env.HOME = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, '.local', 'share');
    process.env.XDG_STATE_HOME = path.join(tmpDir, '.local', 'state');
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('CREATE guard: top-level apiKey/openaiKey in the create body never reach disk', async () => {
    const { handleCreateLine } = await import('../../../src/fleet/routes/ops.ts');
    // CREATE needs its own deps shape (mirrors ops-create-byok-roundtrip.test.ts's
    // successDeps()): getInstance must return undefined, not a fixed truthy stub,
    // or CREATE's uniqueness check 409s before the disk write is ever reached.
    const createDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
        startFire: vi.fn(),
      } as any,
    } as OpsDeps;

    const res = mockRes();
    const req = mockReq(JSON.stringify({
      name: 'pk-create', type: 'chat', adminPhones: ['15550000000'],
      apiKey: 'anthropic-sentinel-create', openaiKey: 'openai-sentinel-create',
    }));
    (req as any).method = 'POST';
    await handleCreateLine(req, res, createDeps);
    // The SECURITY assertion is disk content. Assert the write was reached as an
    // explicit precondition (createDeps mirrors the byte-identical successDeps()
    // that ops-create-byok-roundtrip.test.ts proves reaches a written config.json),
    // then assert the typed keys never landed in it.
    const createdPath = path.join(
      process.env.XDG_CONFIG_HOME as string, 'whatsoup', 'instances', 'pk-create', 'config.json',
    );
    expect(fs.existsSync(createdPath)).toBe(true); // precondition: CREATE reached the disk write
    const raw = fs.readFileSync(createdPath, 'utf8');
    expect(raw).not.toContain('anthropic-sentinel-create');
    expect(raw).not.toContain('openai-sentinel-create');
  });

  it('CREATE guard: unsafe Pinecone selectors and embed URLs never reach disk or response', async () => {
    const { handleCreateLine } = await import('../../../src/fleet/routes/ops.ts');
    const createDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
        startFire: vi.fn(),
      } as any,
    } as OpsDeps;
    const res = mockRes();
    const req = mockReq(JSON.stringify({
      name: 'memory-secret-create',
      type: 'chat',
      adminPhones: ['15550000000'],
      memory: {
        pinecone: {
          projectId: 'test-project',
          index: 'whatsapp-bot',
          apiKeyEnv: 'opaque-api-key-value-secret-sentinel',
          embedUrl: 'https://embed-user:embed-password@embed.example.test/v1?api_key=embed-query-sentinel',
          knowledgeProfiles: {
            secretary: {
              description: 'safe profile',
              embedUrl: 'https://profile.example.test/v1#profile-fragment-sentinel',
            },
          },
        },
      },
    }));
    (req as any).method = 'POST';

    await handleCreateLine(req, res, createDeps);

    expect(res._status).toBe(201);
    const createdPath = path.join(
      process.env.XDG_CONFIG_HOME as string,
      'whatsoup',
      'instances',
      'memory-secret-create',
      'config.json',
    );
    const raw = fs.readFileSync(createdPath, 'utf8');
    const disk = JSON.parse(raw);
    expect(disk.memory.pinecone).toEqual({
      projectId: 'test-project',
      index: 'whatsapp-bot',
      knowledgeProfiles: {
        secretary: { description: 'safe profile' },
      },
    });
    for (const sentinel of [
      'opaque-api-key-value-secret-sentinel',
      'embed-password',
      'embed-query-sentinel',
      'profile-fragment-sentinel',
    ]) {
      expect(raw).not.toContain(sentinel);
      expect(res._body).not.toContain(sentinel);
    }
  });

  it('CREATE guard: nested provider keys are rejected before disk or service mutation', async () => {
    const { handleCreateLine } = await import('../../../src/fleet/routes/ops.ts');
    const createDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
        startFire: vi.fn(),
      } as any,
    } as OpsDeps;
    const res = mockRes();
    const req = mockReq(JSON.stringify({
      name: 'nested-create',
      type: 'chat',
      adminPhones: ['15550000000'],
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://chat.example.test/v1',
          apiKeyService: 'openai',
          apiKey: 'nested-chat-create-secret',
        },
      },
      transcriptionOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://audio.example.test/v1',
          apiKeyService: 'openai',
          openaiKey: 'nested-audio-create-secret',
        },
      },
    }));
    (req as any).method = 'POST';

    await handleCreateLine(req, res, createDeps);

    expect(res._status).toBe(400);
    const createdPath = path.join(
      process.env.XDG_CONFIG_HOME as string,
      'whatsoup',
      'instances',
      'nested-create',
      'config.json',
    );
    expect(fs.existsSync(createdPath)).toBe(false);
    expect(res._body).not.toContain('nested-chat-create-secret');
    expect(res._body).not.toContain('nested-audio-create-secret');
    expect(createDeps.serviceManager.enable).not.toHaveBeenCalled();
    expect(createDeps.serviceManager.start).not.toHaveBeenCalled();
  });

  it('strips a BlueBubbles password from CREATE while preserving its keyring service and endpoint', async () => {
    const { handleCreateLine } = await import('../../../src/fleet/routes/ops.ts');
    const createDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
        startFire: vi.fn(),
      } as any,
    } as OpsDeps;
    const res = mockRes();
    const req = mockReq(JSON.stringify({
      name: 'bb-create',
      type: 'passive',
      transport: 'imessage',
      adminPhones: ['Owner@Example.com'],
      imessageConfig: {
        account: 'bb-create',
        backend: 'bluebubbles',
        sender: 'owner@example.com',
        bluebubblesUrl: 'https://messages.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-bb-create',
        bluebubblesPassword: 'must-not-reach-disk-or-response',
        bluebubbles_password: 'must-not-reach-disk-snake',
        password: 'must-not-reach-disk-short',
        passwordBackup: 'must-not-reach-disk-backup',
        backupBluebubblesPassword: 'must-not-reach-disk-prefix-backup',
        bluebubblesSecret: 'must-not-reach-disk-generic-secret',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    }));
    (req as any).method = 'POST';

    await handleCreateLine(req, res, createDeps);

    expect(res._status).toBe(201);
    const createdPath = path.join(
      process.env.XDG_CONFIG_HOME as string,
      'whatsoup',
      'instances',
      'bb-create',
      'config.json',
    );
    const rawDisk = fs.readFileSync(createdPath, 'utf8');
    const disk = JSON.parse(rawDisk);
    expect(disk.imessageConfig.bluebubblesPassword).toBeUndefined();
    expect(disk.imessageConfig.bluebubbles_password).toBeUndefined();
    expect(disk.imessageConfig.password).toBeUndefined();
    expect(disk.imessageConfig.passwordBackup).toBeUndefined();
    expect(disk.imessageConfig.backupBluebubblesPassword).toBeUndefined();
    expect(disk.imessageConfig.bluebubblesSecret).toBeUndefined();
    expect(disk.imessageConfig.bluebubblesPasswordService).toBe('whatsoup-bluebubbles-bb-create');
    expect(disk.imessageConfig.bluebubblesUrl).toBe('https://messages.example.test');
    expect(rawDisk).not.toContain('must-not-reach-disk-or-response');
    expect(rawDisk).not.toContain('must-not-reach-disk-snake');
    expect(rawDisk).not.toContain('must-not-reach-disk-short');
    expect(rawDisk).not.toContain('must-not-reach-disk-backup');
    expect(rawDisk).not.toContain('must-not-reach-disk-prefix-backup');
    expect(rawDisk).not.toContain('must-not-reach-disk-generic-secret');
    expect(res._body).not.toContain('must-not-reach-disk-or-response');
  });

  it('rejects a BlueBubbles URL fragment on CREATE without persisting it', async () => {
    const { handleCreateLine } = await import('../../../src/fleet/routes/ops.ts');
    const createDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
        startFire: vi.fn(),
      } as any,
    } as OpsDeps;
    const res = mockRes();
    const req = mockReq(JSON.stringify({
      name: 'bb-url-create',
      type: 'passive',
      transport: 'imessage',
      adminPhones: ['owner@example.com'],
      imessageConfig: {
        account: 'bb-url-create',
        backend: 'bluebubbles',
        sender: 'owner@example.com',
        bluebubblesUrl: 'https://messages.example.test/api#url-fragment-marker',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-bb-url-create',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    }));
    (req as any).method = 'POST';

    await handleCreateLine(req, res, createDeps);

    expect(res._status).toBe(400);
    expect(res._body).not.toContain('url-fragment-marker');
    expect(fs.existsSync(path.join(
      process.env.XDG_CONFIG_HOME as string,
      'whatsoup',
      'instances',
      'bb-url-create',
      'config.json',
    ))).toBe(false);
    expect(createDeps.serviceManager.enable).not.toHaveBeenCalled();
    expect(createDeps.serviceManager.start).not.toHaveBeenCalled();
  });

  it('rejects another line\'s Twilio token service on direct CREATE before disk or service mutation', async () => {
    const { handleCreateLine } = await import('../../../src/fleet/routes/ops.ts');
    const createDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
        startFire: vi.fn(),
      } as any,
    } as OpsDeps;
    const res = mockRes();
    const req = mockReq(JSON.stringify({
      name: 'twilio-selector-create',
      type: 'passive',
      transport: 'twilio',
      adminPhones: ['15551234567'],
      twilioConfig: {
        account: 'twilio-selector-create',
        accountSid: `AC${'a'.repeat(32)}`,
        authTokenService: 'whatsoup-twilio-other-line',
        phoneNumber: '+15551234567',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    }));
    (req as any).method = 'POST';

    await handleCreateLine(req, res, createDeps);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain('whatsoup-twilio-twilio-selector-create');
    expect(fs.existsSync(path.join(
      process.env.XDG_CONFIG_HOME as string,
      'whatsoup',
      'instances',
      'twilio-selector-create',
    ))).toBe(false);
    expect(createDeps.serviceManager.enable).not.toHaveBeenCalled();
    expect(createDeps.serviceManager.start).not.toHaveBeenCalled();
  });

  it('rejects another line\'s BlueBubbles service on direct CREATE without persisting it', async () => {
    const { handleCreateLine } = await import('../../../src/fleet/routes/ops.ts');
    const createDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
        startFire: vi.fn(),
      } as any,
    } as OpsDeps;
    const res = mockRes();
    const req = mockReq(JSON.stringify({
      name: 'bb-selector-create',
      type: 'passive',
      transport: 'imessage',
      adminPhones: ['owner@example.com'],
      imessageConfig: {
        account: 'bb-selector-create',
        backend: 'bluebubbles',
        sender: 'owner@example.com',
        bluebubblesUrl: 'https://collector.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-other-line',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    }));
    (req as any).method = 'POST';

    await handleCreateLine(req, res, createDeps);

    expect(res._status).toBe(400);
    expect(fs.existsSync(path.join(
      process.env.XDG_CONFIG_HOME as string,
      'whatsoup',
      'instances',
      'bb-selector-create',
      'config.json',
    ))).toBe(false);
    expect(createDeps.serviceManager.enable).not.toHaveBeenCalled();
    expect(createDeps.serviceManager.start).not.toHaveBeenCalled();
  });

  it('rejects another line\'s Twilio token service on PATCH without changing disk', async () => {
    const dir = path.join(process.env.XDG_CONFIG_HOME as string, 'whatsoup', 'instances', 'pk-line');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const configPath = path.join(dir, 'config.json');
    const original = {
      name: 'pk-line',
      type: 'passive',
      transport: 'twilio',
      adminPhones: ['15551234567'],
      healthPort: 9095,
      accessMode: 'self_only',
      introSent: true,
      twilioConfig: {
        account: 'pk-line',
        accountSid: `AC${'a'.repeat(32)}`,
        authTokenService: 'whatsoup-twilio-pk-line',
        phoneNumber: '+15551234567',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
    const patchDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => ({ name: 'pk-line', configPath })),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn(), disable: vi.fn(), start: vi.fn(), stop: vi.fn(),
        restart: vi.fn(), startFire: vi.fn(),
      } as any,
    } as OpsDeps;
    const before = fs.readFileSync(configPath, 'utf8');
    const res = mockRes();

    await handleConfigUpdate(
      mockReq(JSON.stringify({
        twilioConfig: { authTokenService: 'whatsoup-twilio-other-line' },
      })),
      res,
      patchDeps,
      { name: 'pk-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain('whatsoup-twilio-pk-line');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(patchDeps.serviceManager.restart).not.toHaveBeenCalled();
  });

  it('rejects another line\'s BlueBubbles service on PATCH without changing disk', async () => {
    const dir = path.join(process.env.XDG_CONFIG_HOME as string, 'whatsoup', 'instances', 'pk-line');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const configPath = path.join(dir, 'config.json');
    const original = {
      name: 'pk-line',
      type: 'chat',
      transport: 'imessage',
      adminPhones: ['owner@example.com'],
      healthPort: 9095,
      accessMode: 'self_only',
      introSent: true,
      imessageConfig: {
        account: 'pk-line',
        backend: 'bluebubbles',
        sender: 'owner@example.com',
        bluebubblesUrl: 'https://messages.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-pk-line',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
    const patchDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => ({ name: 'pk-line', configPath })),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn(), disable: vi.fn(), start: vi.fn(), stop: vi.fn(),
        restart: vi.fn(), startFire: vi.fn(),
      } as any,
    } as OpsDeps;

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        imessageConfig: {
          bluebubblesUrl: 'https://collector.example.test',
          bluebubblesPasswordService: 'whatsoup-bluebubbles-other-line',
        },
      })),
      res,
      patchDeps,
      { name: 'pk-line' },
    );

    expect(res._status).toBe(400);
    const rawDisk = fs.readFileSync(configPath, 'utf8');
    expect(JSON.parse(rawDisk)).toEqual(original);
    expect(rawDisk).not.toContain('collector.example.test');
    expect(rawDisk).not.toContain('whatsoup-bluebubbles-other-line');
    expect(patchDeps.serviceManager.restart).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'uppercase AppleID sender',
      existingConfig: {
        account: 'pk-line',
        backend: 'imsg',
        sender: 'owner@example.com',
        imsgSocketPath: '/tmp/imsg.sock',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
      patchConfig: { sender: 'Owner@Example.com' },
      expectedField: 'imessageConfig.sender',
    },
    {
      name: 'BlueBubbles field on imsg',
      existingConfig: {
        account: 'pk-line',
        backend: 'imsg',
        sender: 'owner@example.com',
        imsgSocketPath: '/tmp/imsg.sock',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
      patchConfig: { bluebubblesUrl: 'https://messages.example.test' },
      expectedField: 'imessageConfig.bluebubblesUrl',
    },
    {
      name: 'imsg field on BlueBubbles',
      existingConfig: {
        account: 'pk-line',
        backend: 'bluebubbles',
        sender: 'owner@example.com',
        bluebubblesUrl: 'https://messages.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-pk-line',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
      patchConfig: { imsgSocketPath: '/tmp/imsg.sock' },
      expectedField: 'imessageConfig.imsgSocketPath',
    },
  ])('rejects noncanonical iMessage PATCH config without changing disk: $name', async ({
    existingConfig,
    patchConfig,
    expectedField,
  }) => {
    const dir = path.join(process.env.XDG_CONFIG_HOME as string, 'whatsoup', 'instances', 'pk-line');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const configPath = path.join(dir, 'config.json');
    const existing = {
      name: 'pk-line',
      type: 'chat',
      transport: 'imessage',
      adminPhones: ['owner@example.com'],
      healthPort: 9095,
      accessMode: 'self_only',
      introSent: true,
      imessageConfig: existingConfig,
    };
    fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
    const patchDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => ({ name: 'pk-line', configPath })),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn(), disable: vi.fn(), start: vi.fn(), stop: vi.fn(),
        restart: vi.fn(), startFire: vi.fn(),
      } as any,
    } as OpsDeps;
    const before = fs.readFileSync(configPath, 'utf8');
    const res = mockRes();

    await handleConfigUpdate(
      mockReq(JSON.stringify({ imessageConfig: patchConfig })),
      res,
      patchDeps,
      { name: 'pk-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain(expectedField);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(patchDeps.serviceManager.restart).not.toHaveBeenCalled();
  });

  it('strips unknown Signal credential fields from direct CREATE', async () => {
    const { handleCreateLine } = await import('../../../src/fleet/routes/ops.ts');
    const createDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
        startFire: vi.fn(),
      } as any,
    } as OpsDeps;
    const res = mockRes();
    const req = mockReq(JSON.stringify({
      name: 'signal-create',
      type: 'passive',
      transport: 'signal',
      adminPhones: ['+15551234567'],
      signalConfig: {
        account: 'signal-create',
        phoneNumber: '+15551234567',
        socketPath: '/tmp/signal-create.sock',
        credential: 'must-not-reach-signal-disk',
        rateLimit: { messagesPerMinute: 30, token: 'must-not-reach-signal-rate-limit' },
      },
    }));
    (req as any).method = 'POST';

    await handleCreateLine(req, res, createDeps);

    expect(res._status).toBe(201);
    const createdPath = path.join(
      process.env.XDG_CONFIG_HOME as string,
      'whatsoup',
      'instances',
      'signal-create',
      'config.json',
    );
    const rawDisk = fs.readFileSync(createdPath, 'utf8');
    const disk = JSON.parse(rawDisk);
    expect(disk.signalConfig.credential).toBeUndefined();
    expect(disk.signalConfig.rateLimit).toEqual({ messagesPerMinute: 30 });
    expect(rawDisk).not.toContain('must-not-reach-signal-disk');
    expect(rawDisk).not.toContain('must-not-reach-signal-rate-limit');
    expect(res._body).not.toContain('must-not-reach-signal-disk');
  });
});
