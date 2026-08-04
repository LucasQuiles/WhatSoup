/**
 * Regression coverage for the cwd / plugin-dir symlink-escape defense in
 * fleet/routes/ops.ts. The route already uses fs.realpathSync to dereference
 * symlinks; these tests pin that behavior against regression.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type * as os from 'node:os';
import type { ServerResponse } from 'node:http';

type OsModule = typeof os;

const { HOME, OUTSIDE_ROOT } = vi.hoisted(() => {
  const nodeFs = require('node:fs');
  const nodeOs = require('node:os');
  const nodePath = require('node:path');
  return {
    HOME: nodeFs.realpathSync(
      nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wsoup-symlink-home-')),
    ) as string,
    OUTSIDE_ROOT: nodeFs.realpathSync(
      nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wsoup-symlink-outside-')),
    ) as string,
  };
});

vi.mock('node:os', async (importOriginal: () => Promise<OsModule>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: () => HOME,
  };
});

vi.mock('../../../src/fleet/mcp-client.ts', () => ({
  mcpCall: vi.fn(),
}));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { handleConfigUpdate } from '../../../src/fleet/routes/ops.ts';
import { makeDeps } from '../../helpers/http-mocks.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';

import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

function makeInstance(configPath: string): DiscoveredInstance {
  return {
    name: 'sym-test',
    type: 'agent',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: path.join(HOME, 'bot.db'),
    stateRoot: path.join(HOME, 'state'),
    logDir: path.join(HOME, 'logs'),
    healthToken: 'tok',
    configPath,
    socketPath: null,
  } as DiscoveredInstance;
}

function depsFor(instance: DiscoveredInstance): OpsDeps {
  const map = new Map<string, DiscoveredInstance>([[instance.name, instance]]);
  return makeDeps({ discovery: { getInstance: (name: string) => map.get(name), getInstances: () => map } });
}

function writeConfig(configPath: string, contents: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(contents));
}

function expectPersistedConfig(configPath: string, expected: Record<string, unknown>): void {
  const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  expect(persisted).toEqual(expected);
}

const baseAgentConfig = {
  name: 'sym-test',
  type: 'agent',
  accessMode: 'self_only',
  agentOptions: { cwd: HOME, sessionScope: 'per_chat' },
};

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(OUTSIDE_ROOT, { recursive: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleConfigUpdate symlink-escape defense (regression)', () => {
  it('REJECTS an existing cwd symlink alias that resolves exactly to HOME', async () => {
    const configPath = path.join(HOME, 'config.json');
    const workspace = path.join(HOME, 'workspace');
    const homeAlias = path.join(HOME, 'home-alias');
    fs.mkdirSync(workspace);
    fs.symlinkSync(HOME, homeAlias);
    const config = {
      ...baseAgentConfig,
      agentOptions: { cwd: workspace, sessionScope: 'per_chat' },
    };
    writeConfig(configPath, config);

    const req = mockReq({ body: JSON.stringify({ agentOptions: { cwd: homeAlias, sessionScope: 'per_chat' } }), method: 'PATCH' });
    const res = mockRes();
    await handleConfigUpdate(req, res, depsFor(makeInstance(configPath)), { name: 'sym-test' });

    expect(res._status).toBe(400);
    expect(res._body).toContain('agentOptions.cwd');
    expectPersistedConfig(configPath, config);
  });

  it('REJECTS an existing regular file as cwd without persisting it', async () => {
    const configPath = path.join(HOME, 'config.json');
    const workspace = path.join(HOME, 'workspace');
    const file = path.join(HOME, 'not-a-workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(file, 'not a directory');
    const config = {
      ...baseAgentConfig,
      agentOptions: { cwd: workspace, sessionScope: 'per_chat' },
    };
    writeConfig(configPath, config);

    const req = mockReq({ body: JSON.stringify({ agentOptions: { cwd: file, sessionScope: 'per_chat' } }), method: 'PATCH' });
    const res = mockRes();
    await handleConfigUpdate(req, res, depsFor(makeInstance(configPath)), { name: 'sym-test' });

    expect(res._status).toBe(400);
    expect(res._body).toContain('agentOptions.cwd');
    expectPersistedConfig(configPath, config);
  });

  it('accepts a cwd symlink alias to a physically distinct child directory', async () => {
    const configPath = path.join(HOME, 'config.json');
    const workspace = path.join(HOME, 'workspace');
    const workspaceAlias = path.join(HOME, 'workspace-alias');
    fs.mkdirSync(workspace);
    fs.symlinkSync(workspace, workspaceAlias);
    writeConfig(configPath, baseAgentConfig);

    const req = mockReq({ body: JSON.stringify({ agentOptions: { cwd: workspaceAlias, sessionScope: 'per_chat' } }), method: 'PATCH' });
    const res = mockRes();
    await handleConfigUpdate(req, res, depsFor(makeInstance(configPath)), { name: 'sym-test' });

    expect(res._status).toBe(200);
    expectPersistedConfig(configPath, {
      ...baseAgentConfig,
      agentOptions: { cwd: workspaceAlias, sessionScope: 'per_chat' },
    });
  });

  it('accepts a new child cwd below HOME', async () => {
    const configPath = path.join(HOME, 'config.json');
    const newWorkspace = path.join(HOME, 'new-workspace');
    writeConfig(configPath, baseAgentConfig);

    const req = mockReq({ body: JSON.stringify({ agentOptions: { cwd: newWorkspace, sessionScope: 'per_chat' } }), method: 'PATCH' });
    const res = mockRes();
    await handleConfigUpdate(req, res, depsFor(makeInstance(configPath)), { name: 'sym-test' });

    expect(res._status).toBe(200);
    expectPersistedConfig(configPath, {
      ...baseAgentConfig,
      agentOptions: { cwd: newWorkspace, sessionScope: 'per_chat' },
    });
  });

  it('REJECTS an agentOptions.cwd that points at a symlink leading outside HOME', async () => {
    const configPath = path.join(HOME, 'config.json');
    writeConfig(configPath, baseAgentConfig);

    const escapeTarget = path.join(OUTSIDE_ROOT, 'secret');
    fs.mkdirSync(escapeTarget, { recursive: true });
    const escapeLink = path.join(HOME, 'escape');
    fs.symlinkSync(escapeTarget, escapeLink);

    const req = mockReq({ body: JSON.stringify({ agentOptions: { cwd: escapeLink, sessionScope: 'per_chat' } }), method: 'PATCH' });
    const res = mockRes();
    await handleConfigUpdate(req, res, depsFor(makeInstance(configPath)), { name: 'sym-test' });

    expect(res._status).toBe(400);
    expect(res._body).toContain('agentOptions.cwd');
    expectPersistedConfig(configPath, baseAgentConfig);
  });

  it('REJECTS an agentOptions.cwd nested under a home-side symlink that targets outside HOME', async () => {
    const configPath = path.join(HOME, 'config.json');
    writeConfig(configPath, baseAgentConfig);

    fs.mkdirSync(OUTSIDE_ROOT, { recursive: true });
    const escapeLink = path.join(HOME, 'escape');
    fs.symlinkSync(OUTSIDE_ROOT, escapeLink);

    const req = mockReq({ body: JSON.stringify({
        agentOptions: { cwd: path.join(escapeLink, 'sub'), sessionScope: 'per_chat' },
      }), method: 'PATCH' });
    const res = mockRes();
    await handleConfigUpdate(req, res, depsFor(makeInstance(configPath)), { name: 'sym-test' });

    expect(res._status).toBe(400);
    expect(res._body).toContain('agentOptions.cwd');
    expectPersistedConfig(configPath, baseAgentConfig);
  });

  it('REJECTS a pluginDirs entry that points outside HOME via symlink (cwd is a valid subdir)', async () => {
    const configPath = path.join(HOME, 'config.json');
    const workspace = path.join(HOME, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const config = {
      ...baseAgentConfig,
      agentOptions: { cwd: workspace, sessionScope: 'per_chat' },
    };
    writeConfig(configPath, config);

    const escapeLink = path.join(HOME, 'plugins-escape');
    fs.symlinkSync(OUTSIDE_ROOT, escapeLink);

    const req = mockReq({ body: JSON.stringify({
        agentOptions: {
          cwd: workspace,
          sessionScope: 'per_chat',
          pluginDirs: [escapeLink],
        },
      }), method: 'PATCH' });
    const res = mockRes();
    await handleConfigUpdate(req, res, depsFor(makeInstance(configPath)), { name: 'sym-test' });

    expect(res._status).toBe(400);
    expect(res._body).toContain('pluginDirs');
    expectPersistedConfig(configPath, config);
  });

  it('REJECTS an absolute cwd outside HOME without any symlink (basic confinement)', async () => {
    const configPath = path.join(HOME, 'config.json');
    writeConfig(configPath, baseAgentConfig);

    const req = mockReq({ body: JSON.stringify({ agentOptions: { cwd: OUTSIDE_ROOT, sessionScope: 'per_chat' } }), method: 'PATCH' });
    const res = mockRes();
    await handleConfigUpdate(req, res, depsFor(makeInstance(configPath)), { name: 'sym-test' });

    expect(res._status).toBe(400);
    expect(res._body).toContain('agentOptions.cwd');
    expectPersistedConfig(configPath, baseAgentConfig);
  });
});
