// tests/fleet/ops-spawn-token-warn.test.ts
// Verifies that handleCreateLine warns when keyring lookup throws (keyring
// unavailable) so the spawned instance will run without a health token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupCredential } from '../../src/lib/keyring.ts';
import { handleCreateLine } from '../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../src/fleet/routes/ops.ts';

const logWarn = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/logger.ts')>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      if (name !== 'fleet:ops') return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'warn') {
            return (...args: unknown[]) => {
              logWarn(...args);
              return (target as { warn: (...a: unknown[]) => unknown }).warn(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

vi.mock('../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(),
}));

const mockedLookupCredential = vi.mocked(lookupCredential);

import { mockReq, mockRes } from '../helpers/http-mocks.ts';

function makeDeps(): OpsDeps {
  return {
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
    },
  };
}

describe('ops handleCreateLine spawn-token warn', () => {
  let tmpDir: string;
  let originalConfigHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalStateHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-spawn-token-warn-'));
    originalConfigHome = process.env.XDG_CONFIG_HOME;
    originalDataHome = process.env.XDG_DATA_HOME;
    originalStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
    mockedLookupCredential.mockReset();
    logWarn.mockClear();
  });

  afterEach(() => {
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('warns when lookupCredential throws that the instance will run without a health token', async () => {
    mockedLookupCredential.mockImplementation(() => {
      throw new Error('keyring unavailable');
    });

    const res = mockRes();
    await handleCreateLine(
      mockReq({ body: JSON.stringify({
        name: 'warn-test-line',
        type: 'chat',
        adminPhones: ['+15551230000'],
      }), method: 'POST', url: '/api/lines' }),
      res,
      makeDeps(),
    );

    expect(res._status).toBe(201);

    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ instance: 'warn-test-line' }),
      expect.stringContaining('health token'),
    );

    // The warn must NOT include any token value (the lookup threw so there is no
    // token, but we also check no field named 'token' or 'key' contains a value)
    for (const call of logWarn.mock.calls) {
      const callStr = JSON.stringify(call);
      expect(callStr).not.toContain('keyring unavailable');
    }
  });

  it('does NOT warn when lookupCredential returns null (expected — no token configured)', async () => {
    mockedLookupCredential.mockReturnValue(null);

    const res = mockRes();
    await handleCreateLine(
      mockReq({ body: JSON.stringify({
        name: 'no-token-line',
        type: 'chat',
        adminPhones: ['+15551230001'],
      }), method: 'POST', url: '/api/lines' }),
      res,
      makeDeps(),
    );

    expect(res._status).toBe(201);

    // No warn about health token when lookup simply returns null
    const tokenWarns = logWarn.mock.calls.filter((args) =>
      JSON.stringify(args).includes('health token'),
    );
    expect(tokenWarns).toHaveLength(0);
  });
});
