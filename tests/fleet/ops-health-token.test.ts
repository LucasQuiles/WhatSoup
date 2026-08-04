import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { lookupCredential } from '../../src/lib/keyring.ts';
import { handleCreateLine } from '../../src/fleet/routes/ops.ts';
import { makeDeps } from '../helpers/http-mocks.ts';
import type { OpsDeps } from '../../src/fleet/routes/ops.ts';

vi.mock('../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(),
}));

const mockedLookupCredential = vi.mocked(lookupCredential);

import { mockReq, mockRes } from '../helpers/http-mocks.ts';

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function depsFor(): OpsDeps {
  return makeDeps();
}

describe('fleet ops health token service', () => {
  let tmpDir: string;
  let originalConfigHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalStateHome: string | undefined;
  let originalUmask: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-health-token-create-'));
    originalConfigHome = process.env.XDG_CONFIG_HOME;
    originalDataHome = process.env.XDG_DATA_HOME;
    originalStateHome = process.env.XDG_STATE_HOME;
    originalUmask = process.umask(0o022);
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
    mockedLookupCredential.mockReset();
    mockedLookupCredential.mockReturnValue(null);
  });

  afterEach(() => {
    process.umask(originalUmask);
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes tokens.env from the line-scoped health token lookup', async () => {
    mockedLookupCredential.mockImplementation((service, options) => {
      if (service === 'whatsoup-health-token' && options?.user === 'token-line' && options?.skipEnv === true && options?.skipMigrationFallbacks === true) {
        return 'line-scoped-token';
      }
      if (service === 'whatsoup_health') {
        return 'legacy-token';
      }
      return null;
    });

    const res = mockRes();
    await handleCreateLine(
      mockReq({ body: JSON.stringify({
        name: 'token-line',
        type: 'chat',
        adminPhones: ['15551234567'],
      }), method: 'POST', url: '/api/lines' }),
      res,
      makeDeps(),
    );

    expect(res._status).toBe(201);
    expect(lookupCredential).toHaveBeenCalledWith('whatsoup-health-token', { user: 'token-line', skipEnv: true, skipMigrationFallbacks: true });
    expect(lookupCredential).toHaveBeenCalledTimes(1);

    const tokenPath = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'token-line', 'tokens.env');
    expect(fs.readFileSync(tokenPath, 'utf-8')).toBe('WHATSOUP_HEALTH_TOKEN=line-scoped-token\n');
    expect(fileMode(tokenPath)).toBe(0o600);
  });

  it('does not write tokens.env from legacy migration fallback when canonical scoped lookup misses', async () => {
    mockedLookupCredential.mockImplementation((service, options) => {
      if (service === 'whatsoup-health-token' && options?.user === 'legacy-line' && options?.skipEnv === true) {
        return options?.skipMigrationFallbacks === true ? null : 'legacy-token';
      }
      return null;
    });

    const res = mockRes();
    await handleCreateLine(
      mockReq({ body: JSON.stringify({
        name: 'legacy-line',
        type: 'chat',
        adminPhones: ['15551234567'],
      }), method: 'POST', url: '/api/lines' }),
      res,
      makeDeps(),
    );

    expect(res._status).toBe(201);
    expect(lookupCredential).toHaveBeenCalledTimes(1);
    expect(lookupCredential).toHaveBeenCalledWith('whatsoup-health-token', { user: 'legacy-line', skipEnv: true, skipMigrationFallbacks: true });

    const tokenPath = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'legacy-line', 'tokens.env');
    expect(fs.existsSync(tokenPath)).toBe(false);
  });

  it('does not write tokens.env from shared env fallback when scoped lookup misses', async () => {
    mockedLookupCredential.mockImplementation((service, options) => {
      if (service === 'whatsoup-health-token' && options?.user === 'env-line' && options?.skipEnv === true && options?.skipMigrationFallbacks === true) {
        return null;
      }
      if (service === 'whatsoup_health') {
        return 'shared-env-token';
      }
      return null;
    });

    const res = mockRes();
    await handleCreateLine(
      mockReq({ body: JSON.stringify({
        name: 'env-line',
        type: 'chat',
        adminPhones: ['15551234567'],
      }), method: 'POST', url: '/api/lines' }),
      res,
      makeDeps(),
    );

    expect(res._status).toBe(201);
    expect(lookupCredential).toHaveBeenCalledTimes(1);
    expect(lookupCredential).toHaveBeenCalledWith('whatsoup-health-token', { user: 'env-line', skipEnv: true, skipMigrationFallbacks: true });

    const tokenPath = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'env-line', 'tokens.env');
    expect(fs.existsSync(tokenPath)).toBe(false);
  });
});
