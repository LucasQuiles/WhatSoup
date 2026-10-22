/**
 * Direct tests for src/fleet/routes/ops-config.ts (#2239 slice 2/5).
 *
 * handleConfigUpdate and its validation helpers moved out of ops.ts. These
 * cases import the new module directly and exercise the moved behaviour; the
 * shim case pins that ops.ts still re-exports the same function, so existing
 * callers keep working unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleConfigUpdate } from '../../../src/fleet/routes/ops-config.ts';
import * as opsShim from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { validationError } from '../../../src/fleet/response-error-projection.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));

function fakeInstance(configPath: string): DiscoveredInstance {
  return {
    name: 'test-line',
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/test-line/bot.db',
    stateRoot: '/state/test-line',
    logDir: '/data/test-line/logs',
    healthToken: 'tok123',
    configPath,
    socketPath: null,
  };
}

function depsFor(instance: DiscoveredInstance): OpsDeps {
  return makeDeps<any>({ discovery: { getInstance: vi.fn(() => instance) } });
}

describe('ops-config handleConfigUpdate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ops-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(data: Record<string, unknown> = {}): string {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ name: 'test-line', type: 'chat', ...data }));
    return configPath;
  }

  it('is the same function ops.ts re-exports', () => {
    expect(opsShim.handleConfigUpdate).toBe(handleConfigUpdate);
  });

  it('rejects a non-JSON body with the invalid_json projection and leaves the config untouched', async () => {
    const configPath = writeConfig({ accessMode: 'self_only' });
    const before = fs.readFileSync(configPath, 'utf-8');
    const res = mockRes();

    await handleConfigUpdate(
      mockReq({ body: '{not json', method: 'PATCH' }),
      res, depsFor(fakeInstance(configPath)), { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    // correlation_id is minted per response; every other field must match.
    expect(JSON.parse(res._body)).toEqual({
      ...validationError('invalid_json', 'unknown'),
      correlation_id: expect.any(String),
    });
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('refuses a transport change with 409 and does not write', async () => {
    const configPath = writeConfig({ transport: 'baileys' });
    const before = fs.readFileSync(configPath, 'utf-8');
    const res = mockRes();

    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({ transport: 'signal' }), method: 'PATCH' }),
      res, depsFor(fakeInstance(configPath)), { name: 'test-line' },
    );

    expect(res._status).toBe(409);
    expect(JSON.parse(res._body)).toEqual({
      error: 'transport is immutable; create a new line to change transports',
    });
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('deep-merges a valid patch, persists it, and publishes realtime events', async () => {
    const configPath = writeConfig({ accessMode: 'self_only', description: 'old' });
    const deps = depsFor(fakeInstance(configPath));
    const res = mockRes();

    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({ accessMode: 'allowlist' }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(persisted.accessMode).toBe('allowlist');
    expect(persisted.description).toBe('old');
    expect(deps.realtime.publish).toHaveBeenCalled();
  });

  it('keeps direct file writes off bare utf-8 string encoding (mirrors ops-private-writes)', () => {
    const source = fs.readFileSync('src/fleet/routes/ops-config.ts', 'utf-8');
    const unsafeWrites = source
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter(({ text }) => text.includes('fs.writeFileSync('))
      .filter(({ text }) => /,\s*['"]utf-8['"]\s*\)/.test(text));

    expect(source).toContain('export async function handleConfigUpdate(');
    expect(unsafeWrites).toEqual([]);
  });
});
