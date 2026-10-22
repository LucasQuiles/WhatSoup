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
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));

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
    expect(JSON.parse(res._body)).toEqual({ error: 'stop failed: permission denied', instance: name });
    expect(deps.serviceManager.disable).not.toHaveBeenCalled();
    expect(fs.existsSync(dirs.configDir)).toBe(true);
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
