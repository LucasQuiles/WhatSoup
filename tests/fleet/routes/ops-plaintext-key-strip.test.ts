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
  const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;
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
      accessMode: 'self_only', introSent: true,
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

  it('remediation: a pre-existing on-disk plaintext key is scrubbed by an unrelated PATCH', async () => {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.apiKey = 'anthropic-sentinel-victim';
    existing.transport = 'twilio';
    existing.twilioConfig = {
      account: 'pk-line',
      accountSid: `AC${'a'.repeat(32)}`,
      authTokenService: 'twilio-service',
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
      safeValue: 'updated-twilio-service',
      config: {
        account: 'pk-line',
        accountSid: `AC${'a'.repeat(32)}`,
        authTokenService: 'existing-twilio-service',
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
      safeValue: 'updated-bluebubbles-service',
      config: {
        account: 'pk-line',
        backend: 'bluebubbles',
        sender: 'owner@example.com',
        bluebubblesUrl: 'https://messages.example.test',
        bluebubblesPasswordService: 'existing-bluebubbles-service',
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
        bluebubblesPasswordService: 'whatsoup-bluebubbles-test',
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
    expect(disk.imessageConfig.bluebubblesPasswordService).toBe('whatsoup-bluebubbles-test');
    expect(disk.imessageConfig.bluebubblesUrl).toBe('https://messages.example.test');
    expect(rawDisk).not.toContain('must-not-reach-disk-or-response');
    expect(rawDisk).not.toContain('must-not-reach-disk-snake');
    expect(rawDisk).not.toContain('must-not-reach-disk-short');
    expect(rawDisk).not.toContain('must-not-reach-disk-backup');
    expect(rawDisk).not.toContain('must-not-reach-disk-prefix-backup');
    expect(rawDisk).not.toContain('must-not-reach-disk-generic-secret');
    expect(res._body).not.toContain('must-not-reach-disk-or-response');
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
