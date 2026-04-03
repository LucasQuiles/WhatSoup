/**
 * Tests for PATCH /api/lines/:name/config validation logic.
 *
 * Covers:
 *  - normalizePhoneE164 from src/lib/phone.ts
 *  - isAdminPhone from src/lib/phone.ts
 *  - handleConfigUpdate validation in src/fleet/routes/ops.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { normalizePhoneE164, isAdminPhone } from '../../src/lib/phone.ts';
import { handleConfigUpdate } from '../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../src/fleet/discovery.ts';

// Mock external deps used by ops.ts
vi.mock('../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

function fakeInstance(configPath: string, overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
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
    ...overrides,
  };
}

function makeDeps(instance: DiscoveredInstance): OpsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => instance),
      getInstances: vi.fn(() => new Map()),
    } as any,
  };
}

// ---------------------------------------------------------------------------
// normalizePhoneE164
// ---------------------------------------------------------------------------

describe('normalizePhoneE164', () => {
  it('prepends "1" for a 10-digit NANP number', () => {
    expect(normalizePhoneE164('8459780919')).toBe('18459780919');
  });

  it('leaves an 11-digit number unchanged', () => {
    expect(normalizePhoneE164('18459780919')).toBe('18459780919');
  });

  it('strips formatting characters before normalizing', () => {
    // "+1 (845) 978-0919" → digits "18459780919" (11 digits) → returned as-is
    expect(normalizePhoneE164('+1 (845) 978-0919')).toBe('18459780919');
    // "(845) 978-0919" → digits "8459780919" (10 digits) → prepend 1
    expect(normalizePhoneE164('(845) 978-0919')).toBe('18459780919');
    // Dashes stripped: "845-978-0919" → "8459780919" (10 digits) → prepend 1
    expect(normalizePhoneE164('845-978-0919')).toBe('18459780919');
  });

  it('leaves a 14-digit number (international) unchanged', () => {
    // 14 digits — not NANP, returned as-is (digits only)
    expect(normalizePhoneE164('+44-20-7946-0958')).toBe('442079460958');
  });

  it('leaves a 7-digit number unchanged (no country code prepended)', () => {
    expect(normalizePhoneE164('5551234')).toBe('5551234');
  });
});

// ---------------------------------------------------------------------------
// isAdminPhone
// ---------------------------------------------------------------------------

describe('isAdminPhone', () => {
  it('returns true for an exact match', () => {
    const admins = new Set(['18459780919']);
    expect(isAdminPhone('18459780919', admins)).toBe(true);
  });

  it('returns true for suffix match: 10-digit admin, 11-digit phone', () => {
    // Admin stored without country code, JID has full number
    const admins = new Set(['8459780919']);
    expect(isAdminPhone('18459780919', admins)).toBe(true);
  });

  it('returns true for reverse suffix match: 11-digit admin, 10-digit phone', () => {
    const admins = new Set(['18459780919']);
    expect(isAdminPhone('8459780919', admins)).toBe(true);
  });

  it('requires a minimum of 7 digits for suffix matching (non-exact path)', () => {
    // Phone shorter than 7 digits: the exact-match fast path is skipped (different number),
    // and the suffix-match loop also skips because digits.length < 7
    const admins = new Set(['9999999999']);
    expect(isAdminPhone('123456', admins)).toBe(false);
  });

  it('skips admin entries shorter than 7 digits', () => {
    // Even if phone is long enough, a short admin entry is ignored
    const admins = new Set(['123456']);
    expect(isAdminPhone('18459780919', admins)).toBe(false);
  });

  it('does not produce false positives for unrelated numbers', () => {
    const admins = new Set(['18459780919', '12125550100']);
    expect(isAdminPhone('19995551234', admins)).toBe(false);
  });

  it('returns false for empty admin set', () => {
    expect(isAdminPhone('18459780919', new Set())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleConfigUpdate — PATCH validation
// ---------------------------------------------------------------------------

describe('handleConfigUpdate PATCH validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-patch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(data: Record<string, unknown> = {}): string {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ name: 'test-line', type: 'chat', ...data }));
    return configPath;
  }

  // -- accessMode --

  it('rejects an invalid accessMode with 400', async () => {
    const configPath = writeConfig({ accessMode: 'self_only' });
    const inst = fakeInstance(configPath);
    const deps = makeDeps(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ accessMode: 'superuser' })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/accessMode must be one of/);
  });

  it('accepts all valid accessMode values', async () => {
    const validModes = ['self_only', 'allowlist', 'open_dm', 'groups_only'];
    for (const mode of validModes) {
      const configPath = writeConfig({ accessMode: 'self_only' });
      const inst = fakeInstance(configPath);
      const deps = makeDeps(inst);

      const res = mockRes();
      await handleConfigUpdate(
        mockReq(JSON.stringify({ accessMode: mode })),
        res, deps, { name: 'test-line' },
      );

      expect(res._status).toBe(200, `expected 200 for accessMode=${mode}`);
      expect(JSON.parse(res._body).accessMode).toBe(mode);
    }
  });

  // -- adminPhones --

  it('rejects an empty adminPhones array with 400', async () => {
    const configPath = writeConfig();
    const inst = fakeInstance(configPath);
    const deps = makeDeps(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ adminPhones: [] })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/adminPhones must be a non-empty array/);
  });

  it('rejects adminPhones that is not an array with 400', async () => {
    const configPath = writeConfig();
    const inst = fakeInstance(configPath);
    const deps = makeDeps(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ adminPhones: '8459780919' })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/adminPhones must be a non-empty array/);
  });

  it('rejects adminPhones containing an empty string with 400', async () => {
    const configPath = writeConfig();
    const inst = fakeInstance(configPath);
    const deps = makeDeps(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ adminPhones: ['8459780919', ''] })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/adminPhones must be a non-empty array/);
  });

  it('accepts valid adminPhones and normalizes them to E.164', async () => {
    const configPath = writeConfig();
    const inst = fakeInstance(configPath);
    const deps = makeDeps(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ adminPhones: ['8459780919', '(212) 555-0100'] })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    // Both 10-digit → prepend 1
    expect(body.adminPhones).toContain('18459780919');
    expect(body.adminPhones).toContain('12125550100');
  });

  it('deduplicates adminPhones after normalization', async () => {
    const configPath = writeConfig();
    const inst = fakeInstance(configPath);
    const deps = makeDeps(inst);

    const res = mockRes();
    await handleConfigUpdate(
      // Two representations of the same number
      mockReq(JSON.stringify({ adminPhones: ['8459780919', '(845) 978-0919'] })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.adminPhones).toHaveLength(1);
    expect(body.adminPhones[0]).toBe('18459780919');
  });

  // -- model (passthrough) --

  it('accepts any string value for model without validation', async () => {
    const configPath = writeConfig({ model: 'claude-3-5-sonnet-20241022' });
    const inst = fakeInstance(configPath);
    const deps = makeDeps(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ model: 'claude-opus-4-9000' })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).model).toBe('claude-opus-4-9000');
  });

  // -- combined patch --

  it('accepts a combined patch with accessMode + adminPhones + model', async () => {
    const configPath = writeConfig({ accessMode: 'self_only' });
    const inst = fakeInstance(configPath);
    const deps = makeDeps(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        accessMode: 'allowlist',
        adminPhones: ['18459780919'],
        model: 'claude-haiku-3-5',
      })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.accessMode).toBe('allowlist');
    expect(body.adminPhones).toEqual(['18459780919']);
    expect(body.model).toBe('claude-haiku-3-5');
  });
});
