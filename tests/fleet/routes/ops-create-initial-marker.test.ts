import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleCreateLine } from '../../../src/fleet/routes/ops.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

describe('handleCreateLine initial-database marker', () => {
  let root: string;
  const previous: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-create-marker-'));
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) previous[name] = process.env[name];
    process.env.XDG_CONFIG_HOME = path.join(root, 'config');
    process.env.XDG_DATA_HOME = path.join(root, 'data');
    process.env.XDG_STATE_HOME = path.join(root, 'state');
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('arms a private canonical marker before first boot', async () => {
    const deps = makeDeps<any>({ discovery: { getInstance: vi.fn(() => null) } });
    const req = mockReq({ method: 'POST', body: JSON.stringify({
      name: 'freshline', type: 'passive', adminPhones: ['+15550001111'],
    }) });
    const res = mockRes();
    await handleCreateLine(req as never, res as never, deps);
    expect(res._status).toBe(201);
    const marker = path.join(root, 'data', 'whatsoup', 'instances', 'freshline', '.initial-database-create-approved');
    expect(fs.readFileSync(marker, 'utf8')).toBe('freshline\n');
    expect(fs.lstatSync(marker).mode & 0o777).toBe(0o600);
  });
});
