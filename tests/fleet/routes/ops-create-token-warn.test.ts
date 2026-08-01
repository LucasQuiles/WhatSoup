/**
 * When the keyring read for the per-instance health token throws during
 * POST /api/lines, instance creation must still succeed (the instance just
 * starts without a token) — and the skip must be visible via a warn, not
 * silent (infra-audit fail-loud item).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const opsLogWarn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...orig,
    lookupCredential: vi.fn(() => {
      throw new Error('keychain locked');
    }),
  };
});

vi.mock('../../../src/logger.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/logger.ts')>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      if (name !== 'fleet:ops') return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'warn') {
            return (fields: unknown, msg?: string) => {
              opsLogWarn(fields, msg);
              return (target as { warn: (f: unknown, m?: string) => unknown }).warn(fields, msg);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

import { handleCreateLine } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

function succeedingDeps(): OpsDeps {
  // makeDeps's base discovery has no scan(); handleCreateLine calls it.
  return makeDeps({ discovery: { scan: vi.fn() } as any });
}

describe('handleCreateLine — keyring failure during health-token copy', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalConfigHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalStateHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-token-warn-test-'));
    originalHome = process.env.HOME;
    originalConfigHome = process.env.XDG_CONFIG_HOME;
    originalDataHome = process.env.XDG_DATA_HOME;
    originalStateHome = process.env.XDG_STATE_HOME;
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
    fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
    opsLogWarn.mockClear();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the instance without tokens.env and warns about the skipped token', async () => {
    const res = mockRes();
    await handleCreateLine(
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'tokenless-bot',
          type: 'chat',
          adminPhones: ['15551234567'],
        }),
      }),
      res,
      succeedingDeps(),
    );

    expect(res._status).toBe(201);

    const configDir = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'tokenless-bot');
    expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'tokens.env'))).toBe(false);

    const warnCalls = opsLogWarn.mock.calls.filter(([, msg]) =>
      typeof msg === 'string' && msg.includes('without a health token'));
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][0]).toMatchObject({ instance: 'tokenless-bot' });
    // Redaction posture: nothing token-shaped in the warn fields.
    expect(JSON.stringify(warnCalls[0][0])).not.toMatch(/WHATSOUP_HEALTH_TOKEN|token=/);
  });
});
