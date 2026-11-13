/**
 * Direct tests for src/fleet/routes/ops-lifecycle.ts (#2239 slice 3/5).
 *
 * The service-lifecycle handlers (restart, stop, delete) and handleCreateLine
 * moved out of ops.ts. These cases import the new module directly and exercise
 * the moved behaviour; the shim case pins that ops.ts still re-exports the
 * same functions, so existing callers keep working unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  handleCreateLine,
  handleDeleteLine,
  handleRestart,
  handleStop,
} from '../../../src/fleet/routes/ops-lifecycle.ts';
import * as opsShim from '../../../src/fleet/routes/ops.ts';
import { handlePairingPreflight } from '../../../src/fleet/routes/ops-auth.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

vi.mock('../../../src/lib/keyring.ts', () => ({ lookupCredential: vi.fn(() => null) }));

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const XDG_KEYS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;

describe('ops-lifecycle handlers', () => {
  let tmpDir: string;
  const saved: Partial<Record<(typeof XDG_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ops-lifecycle-'));
    for (const key of XDG_KEYS) saved[key] = process.env[key];
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
  });

  afterEach(() => {
    for (const key of XDG_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedInstanceDirs(name: string) {
    const configDir = path.join(tmpDir, 'config', 'whatsoup', 'instances', name);
    const dataDir = path.join(tmpDir, 'data', 'whatsoup', 'instances', name);
    const stateDir = path.join(tmpDir, 'state', 'whatsoup', 'instances', name);
    for (const dir of [configDir, dataDir, stateDir]) fs.mkdirSync(dir, { recursive: true });
    return { configDir, dataDir, stateDir };
  }

  it('are the same functions ops.ts re-exports', () => {
    expect(opsShim.handleRestart).toBe(handleRestart);
    expect(opsShim.handleStop).toBe(handleStop);
    expect(opsShim.handleDeleteLine).toBe(handleDeleteLine);
    expect(opsShim.handleCreateLine).toBe(handleCreateLine);
  });

  it('restart reports 202 restart_requested after the service manager restarts', async () => {
    const deps = makeDeps<any>({ discovery: { getInstance: vi.fn(() => ({ name: 'line-a' })) } }) as OpsDeps;
    const res = mockRes();

    await handleRestart(mockReq({ method: 'POST' }), res, deps, { name: 'line-a' });

    expect(res._status).toBe(202);
    expect(JSON.parse(res._body)).toEqual({ status: 'restart_requested', instance: 'line-a' });
    expect(deps.serviceManager.restart).toHaveBeenCalledWith('line-a');
  });

  it('delete treats an already-absent systemd unit as success and removes instance state', async () => {
    const name = 'delete-line';
    const dirs = seedInstanceDirs(name);
    const deps = makeDeps<any>({}) as OpsDeps;
    const unit = ['whatsoup', `${name}.service`].join('@');
    vi.mocked(deps.serviceManager.stop).mockRejectedValueOnce(new Error(`unit ${unit} not found`));
    const res = mockRes();

    await handleDeleteLine(mockReq({ method: 'DELETE' }), res, deps, { name });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ deleted: name });
    expect(fs.existsSync(dirs.configDir)).toBe(false);
    expect(fs.existsSync(dirs.dataDir)).toBe(false);
    expect(fs.existsSync(dirs.stateDir)).toBe(false);
  });

  it('delete keeps instance state when stop fails for a non-benign reason', async () => {
    const name = 'delete-line';
    const dirs = seedInstanceDirs(name);
    const deps = makeDeps<any>({}) as OpsDeps;
    vi.mocked(deps.serviceManager.stop).mockRejectedValueOnce(new Error('permission denied'));
    const res = mockRes();

    await handleDeleteLine(mockReq({ method: 'DELETE' }), res, deps, { name });

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({ schema: 'fleet-error-v1', code: 'service_stop_failed',
      instance: name, operation: 'instance_delete', stage: 'execute', mutation_state: 'unknown', retryable: false });
    expect(deps.serviceManager.disable).not.toHaveBeenCalled();
    expect(fs.existsSync(dirs.configDir)).toBe(true);
  });

  it.each(['stop', 'disable'] as const)('bounds %s failures and preserves files without publishing success', async (action) => {
    const name = 'delete-private-failure';
    const dirs = seedInstanceDirs(name);
    const deps = makeDeps<any>({}) as OpsDeps;
    vi.mocked(deps.serviceManager[action]).mockRejectedValueOnce(new Error('private path /secret/service.log token=canary'));
    const res = mockRes();

    await handleDeleteLine(mockReq({ method: 'DELETE' }), res, deps, { name });

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({ schema: 'fleet-error-v1',
      instance: name,
      code: action === 'stop' ? 'service_stop_failed' : 'service_action_failed',
      operation: 'instance_delete', stage: 'execute', mutation_state: 'unknown', rollback_state: 'not_applicable', retryable: false,
      correlation_id: expect.any(String),
    });
    expect(res._body).not.toContain('/secret/service.log');
    expect(res._body).not.toContain('canary');
    expect(deps.discovery.scan).not.toHaveBeenCalled();
    expect(deps.realtime.publish).not.toHaveBeenCalled();
    expect(fs.existsSync(dirs.configDir)).toBe(true);
    expect(fs.existsSync(dirs.dataDir)).toBe(true);
    expect(fs.existsSync(dirs.stateDir)).toBe(true);
  });

  it('reports incomplete deletion and succeeds only after the remaining files can be removed', async () => {
    const name = 'delete-incomplete';
    const dirs = seedInstanceDirs(name);
    const deps = makeDeps<any>({}) as OpsDeps;
    const { rmSync: remove } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fault = vi.mocked(fs.rmSync).mockImplementation((target, options) => {
      if (target === dirs.configDir) throw Object.assign(new Error('private cleanup diagnostic'), { code: 'EACCES' });
      return remove(target, options);
    });
    try {
      const failed = mockRes();
      await handleDeleteLine(mockReq({ method: 'DELETE' }), failed, deps, { name });
      expect(failed._status).toBe(500);
      expect(JSON.parse(failed._body)).toMatchObject({ schema: 'fleet-error-v1', operation: 'instance_delete', code: 'instance_cleanup_failed',
        message: 'Instance cleanup is incomplete. Inspect remaining state before retrying.',
        stage: 'commit', mutation_state: 'unknown', rollback_state: 'not_applicable', retryable: false });
      expect(failed._body).not.toContain('private cleanup diagnostic');
      expect(fs.existsSync(dirs.configDir)).toBe(true);
      expect(fs.existsSync(dirs.dataDir)).toBe(false);
      expect(fs.existsSync(dirs.stateDir)).toBe(false);
      expect(deps.realtime.publish).not.toHaveBeenCalled();
    } finally {
      fault.mockImplementation(remove);
    }

    const recovered = mockRes();
    await handleDeleteLine(mockReq({ method: 'DELETE' }), recovered, deps, { name });
    expect(recovered._status).toBe(200);
    expect(JSON.parse(recovered._body)).toEqual({ deleted: name });
    expect(fs.existsSync(dirs.configDir)).toBe(false);
    expect(deps.serviceManager.stop).toHaveBeenCalledTimes(2);
    expect(deps.serviceManager.disable).toHaveBeenCalledTimes(2);
  });

  it('reports failed creation cleanup instead of claiming that no mutation started', async () => {
    const name = 'create-incomplete';
    const configDir = path.join(tmpDir, 'config', 'whatsoup', 'instances', name);
    const deps = makeDeps<any>({}) as OpsDeps;
    vi.mocked(deps.serviceManager.enable).mockRejectedValueOnce(new Error('enable response lost'));
    const { rmSync: remove } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fault = vi.mocked(fs.rmSync).mockImplementation((target, options) => {
      if (target === configDir) throw Object.assign(new Error('private cleanup diagnostic'), { code: 'EACCES' });
      return remove(target, options);
    });
    try {
      const res = mockRes();
      await handleCreateLine(mockReq({ method: 'POST', body: JSON.stringify({
        name, type: 'chat', adminPhones: ['15551230006'], healthPort: 3202,
      }) }), res, deps);
      expect(res._status).toBe(500);
      expect(JSON.parse(res._body)).toMatchObject({ schema: 'fleet-error-v1', operation: 'instance_create', code: 'rollback_failed',
        stage: 'rollback', mutation_state: 'rollback_failed', rollback_state: 'failed', retryable: false });
      expect(res._body).not.toContain('private cleanup diagnostic');
      expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(true);
      expect(deps.serviceManager.disable).toHaveBeenCalledWith(name);
      expect(deps.realtime.publish).not.toHaveBeenCalled();
    } finally {
      fault.mockImplementation(remove);
    }
  });

  it('retains recovery state when a failed enable cannot be compensated', async () => {
    const name = 'enable-uncertain';
    const deps = makeDeps<any>({}) as OpsDeps;
    vi.mocked(deps.serviceManager.enable).mockRejectedValueOnce(new Error('enable response lost'));
    vi.mocked(deps.serviceManager.disable).mockRejectedValueOnce(new Error('disable response lost'));
    const res = mockRes();
    await handleCreateLine(mockReq({ method: 'POST', body: JSON.stringify({
      name, type: 'chat', adminPhones: ['15551230006'], healthPort: 3202,
    }) }), res, deps);

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({ operation: 'instance_create', stage: 'rollback', code: 'rollback_failed',
      mutation_state: 'rollback_failed', rollback_state: 'failed', retryable: false });
    expect(deps.serviceManager.disable).toHaveBeenCalledWith(name);
    expect(fs.existsSync(path.join(tmpDir, 'config', 'whatsoup', 'instances', name, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'data', 'whatsoup', 'instances', name))).toBe(true);
    expect(deps.realtime.publish).not.toHaveBeenCalled();
  });

  it('create refuses an invalid name with the unchanged 400 message and writes nothing', async () => {
    const deps = makeDeps<any>({}) as OpsDeps;
    const res = mockRes();

    await handleCreateLine(
      mockReq({ method: 'POST', body: JSON.stringify({ name: 'X', type: 'chat', adminPhones: ['15551230006'] }) }),
      res, deps,
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({
      error: 'name must be 2-30 lowercase alphanumeric/hyphens, starting with a letter',
    });
    expect(fs.existsSync(path.join(tmpDir, 'config'))).toBe(false);
    expect(deps.serviceManager.enable).not.toHaveBeenCalled();
  });

  it('preserves the configured account scope from creation through pairing preflight', async () => {
    const name = 'scoped-line';
    const accountScopeId = 'scope:create-roundtrip';
    const deps = makeDeps<any>({}) as OpsDeps;
    const res = mockRes();
    await handleCreateLine(mockReq({ method: 'POST', body: JSON.stringify({
      name, type: 'chat', adminPhones: ['15551230006'], accountScopeId,
    }) }), res, deps);

    expect(res._status).toBe(201);
    const configPath = path.join(tmpDir, 'config', 'whatsoup', 'instances', name, 'config.json');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).accountScopeId).toBe(accountScopeId);
    vi.mocked(deps.discovery.getInstance).mockReturnValue({
      name, configPath, stateRoot: path.join(tmpDir, 'state', 'whatsoup', 'instances', name),
    } as never);
    const preflight = mockRes();
    await handlePairingPreflight(mockReq({
      method: 'POST', headers: { authorization: 'Bearer test-token' },
    }), preflight, deps, { name });
    expect(preflight._status).toBe(200);
    expect(JSON.parse(preflight._body).scopeId).toBe(accountScopeId);
  });

  it.each(['not-a-scope', '/tmp/account', 'scope:15551230006', 42, {}, []].map((accountScopeId) => ({ accountScopeId })))(
    'rejects malformed account scope %j before creating instance state', async ({ accountScopeId }) => {
      const name = 'invalid-scope';
      const deps = makeDeps<any>({}) as OpsDeps;
      const res = mockRes();
      await handleCreateLine(mockReq({ method: 'POST', body: JSON.stringify({
        name, type: 'chat', adminPhones: ['15551230006'], accountScopeId,
      }) }), res, deps);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toContain('accountScopeId');
      expect(fs.existsSync(path.join(tmpDir, 'config', 'whatsoup', 'instances', name))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'data', 'whatsoup', 'instances', name))).toBe(false);
      expect(deps.serviceManager.enable).not.toHaveBeenCalled();
    },
  );

  it('creates a configured M365 agent with the full deny floor before launch', async () => {
    const { REQUIRED_DENY } = await import('../../../src/core/settings-template.ts');
    const { lookupCredential } = await import('../../../src/lib/keyring.ts');
    vi.mocked(lookupCredential).mockClear();
    const cwd = path.join(tmpDir, 'agent');
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const enabledPlugins = { 'microsoft_365@microsoft-365-dev': true };
    const deps = makeDeps<any>({}) as OpsDeps;
    const res = mockRes();
    await handleCreateLine(mockReq({ method: 'POST', body: JSON.stringify({
      name: 'bridge-agent', type: 'agent', adminPhones: ['15551230006'],
      agentOptions: {
        cwd, provider: 'claude-cli', allowM365Mutations: true, enabledPlugins,
        m365Bridge: {
          tenantId: '11111111-2222-3333-4444-555555555555',
          accountEmail: 'user@example.test', origin: 'https://127.0.0.1:10000', profile: 'user-full-v1',
        },
      },
    }) }), res, deps);
    expect(res._status).toBe(201);
    const settings = JSON.parse(fs.readFileSync(path.join(cwd, '.claude/settings.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([...REQUIRED_DENY]));
    expect(settings.enabledPlugins).toEqual(enabledPlugins);
    expect(vi.mocked(lookupCredential).mock.calls.filter(([service]) => service.startsWith('agent365'))).toEqual([]);
    expect(deps.serviceManager.enable).toHaveBeenCalledWith('bridge-agent');
  });

  it('keeps direct file writes off bare utf-8 string encoding (mirrors ops-private-writes)', () => {
    const source = fs.readFileSync('src/fleet/routes/ops-lifecycle.ts', 'utf-8');
    const unsafeWrites = source
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter(({ text }) => text.includes('fs.writeFileSync('))
      .filter(({ text }) => /,\s*['"]utf-8['"]\s*\)/.test(text));

    expect(source).toContain('export async function handleCreateLine(');
    expect(unsafeWrites).toEqual([]);
  });
});
