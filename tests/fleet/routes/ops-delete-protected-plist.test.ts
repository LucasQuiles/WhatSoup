/**
 * #3829: DELETE /api/lines/:name stops the service before it disables it. When
 * disable could not remove the service definition (a protected launchd plist),
 * the route must refuse before its stop step, so the job stays loaded and the
 * instance state stays in place.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDeleteLine } from '../../../src/fleet/routes/ops-lifecycle.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

const NAME = 'bot-a';
const XDG_KEYS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;

function serviceManagerWith(assertCanDisable: () => void) {
  return {
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    restartSelf: vi.fn().mockResolvedValue(undefined),
    startFire: vi.fn(),
    assertCanDisable: vi.fn(assertCanDisable),
  };
}

describe('handleDeleteLine with a service definition that cannot be removed (#3829)', () => {
  let tmpDir: string;
  const saved: Partial<Record<(typeof XDG_KEYS)[number], string | undefined>> = {};

  function seedInstanceDirs(): string[] {
    const dirs = XDG_KEYS.map((key) => path.join(process.env[key]!, 'whatsoup', 'instances', NAME));
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'marker.txt'), 'kept\n');
    }
    return dirs;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-delete-protected-'));
    for (const key of XDG_KEYS) {
      saved[key] = process.env[key];
      process.env[key] = path.join(tmpDir, key.toLowerCase());
    }
  });

  afterEach(() => {
    for (const key of XDG_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses before its stop step and keeps the instance state', async () => {
    const dirs = seedInstanceDirs();
    const svc = serviceManagerWith(() => {
      throw new Error(`launchd plist for com.whatsoup.${NAME} carries an immutable, append-only or no-unlink file flag and cannot be removed; the job was left loaded`);
    });
    const deps = makeDeps<OpsDeps>({ serviceManager: svc });

    const res = mockRes();
    await handleDeleteLine(mockReq({ method: 'POST', body: '', url: `/api/lines/${NAME}` }), res, deps, { name: NAME });

    expect(res._status).toBe(409);
    expect(JSON.parse(res._body).error).toMatch(/^delete refused: .*cannot be removed/);
    expect(svc.assertCanDisable).toHaveBeenCalledWith(NAME);
    expect(svc.stop).not.toHaveBeenCalled();
    expect(svc.disable).not.toHaveBeenCalled();
    expect(deps.discovery.scan).not.toHaveBeenCalled();
    expect(deps.realtime.publish).not.toHaveBeenCalled();
    for (const dir of dirs) expect(fs.existsSync(dir)).toBe(true);
  });

  it('checks first, then stops, disables and removes the state when the definition can be removed', async () => {
    const dirs = seedInstanceDirs();
    const svc = serviceManagerWith(() => {});
    const deps = makeDeps<OpsDeps>({ serviceManager: svc });

    const res = mockRes();
    await handleDeleteLine(mockReq({ method: 'POST', body: '', url: `/api/lines/${NAME}` }), res, deps, { name: NAME });

    expect(res._status).toBe(200);
    const [checked] = svc.assertCanDisable.mock.invocationCallOrder;
    const [stopped] = svc.stop.mock.invocationCallOrder;
    const [disabled] = svc.disable.mock.invocationCallOrder;
    expect(checked).toBeLessThan(stopped!);
    expect(stopped).toBeLessThan(disabled!);
    for (const dir of dirs) expect(fs.existsSync(dir)).toBe(false);
  });
});
