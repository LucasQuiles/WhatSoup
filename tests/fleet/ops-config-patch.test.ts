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
import type { ServerResponse } from 'node:http';

import { normalizePhone, normalizePhoneE164, isAdminPhone } from '../../src/lib/phone.ts';
import { handleConfigUpdate } from '../../src/fleet/routes/ops.ts';
import { makeDeps } from '../helpers/http-mocks.ts';
import type { OpsDeps } from '../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../src/fleet/discovery.ts';
import { privateConfigLockPath } from '../../src/core/private-config-file.ts';
import { acquireProcessLock, releaseProcessLock } from '../../src/lib/process-lock.ts';

// Mock external deps used by ops.ts
vi.mock('../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

import { mockReq, mockRes } from '../helpers/http-mocks.ts';

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

function depsFor(instance: DiscoveredInstance): OpsDeps {
  return makeDeps({ discovery: { getInstance: vi.fn(() => instance) } });
}

// ---------------------------------------------------------------------------
// normalizePhoneE164
// ---------------------------------------------------------------------------

describe('normalizePhoneE164', () => {
  it('prepends "1" for a 10-digit NANP number', () => {
    expect(normalizePhoneE164('5551230006')).toBe('15551230006');
  });

  it('leaves an 11-digit number unchanged', () => {
    expect(normalizePhoneE164('15551230006')).toBe('15551230006');
  });

  it('strips formatting characters before normalizing', () => {
    // "+1 (555) 123-0006" → digits "15551230006" (11 digits) → returned as-is
    expect(normalizePhoneE164('+1 (555) 123-0006')).toBe('15551230006');
    // "(555) 123-0006" → digits "5551230006" (10 digits) → prepend 1
    expect(normalizePhoneE164('(555) 123-0006')).toBe('15551230006');
    // Dashes stripped: "555-123-0006" → "5551230006" (10 digits) → prepend 1
    expect(normalizePhoneE164('555-123-0006')).toBe('15551230006');
  });

  it('leaves a 14-digit number (international) unchanged', () => {
    // 14 digits — not NANP, returned as-is (digits only)
    expect(normalizePhoneE164('+44-20-7946-0958')).toBe('442079460958');
  });

  it('leaves a 7-digit number unchanged (no country code prepended)', () => {
    expect(normalizePhoneE164('5551234')).toBe('5551234');
  });

  it('fails closed for malformed runtime values', () => {
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
    expect(normalizePhoneE164(null)).toBe('');
    expect(normalizePhoneE164(undefined)).toBe('');
    expect(normalizePhoneE164(5551230006)).toBe('15551230006');
  });
});

// ---------------------------------------------------------------------------
// isAdminPhone
// ---------------------------------------------------------------------------

describe('isAdminPhone', () => {
  it('returns true for an exact match', () => {
    const admins = new Set(['15551230006']);
    expect(isAdminPhone('15551230006', admins)).toBe(true);
  });

  it('returns true for suffix match: 10-digit admin, 11-digit phone', () => {
    // Admin stored without country code, JID has full number
    const admins = new Set(['5551230006']);
    expect(isAdminPhone('15551230006', admins)).toBe(true);
  });

  it('returns true for reverse suffix match: 11-digit admin, 10-digit phone', () => {
    const admins = new Set(['15551230006']);
    expect(isAdminPhone('5551230006', admins)).toBe(true);
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
    expect(isAdminPhone('15551230006', admins)).toBe(false);
  });

  it('does not produce false positives for unrelated numbers', () => {
    const admins = new Set(['15551230006', '12125550100']);
    expect(isAdminPhone('19995551234', admins)).toBe(false);
  });

  it('returns false for empty admin set', () => {
    expect(isAdminPhone('15551230006', new Set())).toBe(false);
  });

  it('returns false instead of throwing for malformed phone values', () => {
    expect(isAdminPhone(null, new Set(['15551230006']))).toBe(false);
    expect(isAdminPhone(undefined, new Set(['15551230006']))).toBe(false);
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
    const deps = depsFor(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({ accessMode: 'superuser' }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toMatch(/accessMode must be one of/);
  });

  it('accepts all valid accessMode values', async () => {
    const validModes = ['self_only', 'allowlist', 'open_dm', 'groups_only'];
    for (const mode of validModes) {
      const configPath = writeConfig({ accessMode: 'self_only' });
      const inst = fakeInstance(configPath);
      const deps = depsFor(inst);

      const res = mockRes();
      await handleConfigUpdate(
        mockReq({ body: JSON.stringify({ accessMode: mode }), method: 'PATCH' }),
        res, deps, { name: 'test-line' },
      );

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).accessMode).toBe(mode);
    }
  });

  // -- adminPhones --

  it('rejects an empty adminPhones array with 400', async () => {
    const configPath = writeConfig();
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({ adminPhones: [] }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/adminPhones must be a non-empty array/);
  });

  it('rejects adminPhones that is not an array with 400', async () => {
    const configPath = writeConfig();
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({ adminPhones: '5551230006' }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/adminPhones must be a non-empty array/);
  });

  it('rejects adminPhones containing an empty string with 400', async () => {
    const configPath = writeConfig();
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({ adminPhones: ['5551230006', ''] }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/adminPhones must be a non-empty array/);
  });

  it('accepts valid adminPhones and normalizes them to E.164', async () => {
    const configPath = writeConfig();
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({ adminPhones: ['5551230006', '(212) 555-0100'] }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    // Both 10-digit → prepend 1
    expect(body.adminPhones).toContain('15551230006');
    expect(body.adminPhones).toContain('12125550100');
  });

  it('deduplicates adminPhones after normalization', async () => {
    const configPath = writeConfig();
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);

    const res = mockRes();
    await handleConfigUpdate(
      // Two representations of the same number
      mockReq({ body: JSON.stringify({ adminPhones: ['5551230006', '(555) 123-0006'] }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.adminPhones).toHaveLength(1);
    expect(body.adminPhones[0]).toBe('15551230006');
  });

  it('canonicalizes an iMessage AppleID admin identity', async () => {
    const configPath = writeConfig({
      transport: 'imessage',
      imessageConfig: { account: 'test-imsg', backend: 'imsg', sender: 'sender@example.test' },
    });
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);
    const res = mockRes();

    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({ adminPhones: ['Owner@Example.test'] }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).adminPhones).toEqual(['owner@example.test']);
  });

  it('canonicalizes a loader-compatible iMessage phone admin identity to provider wire form', async () => {
    const configPath = writeConfig({
      transport: 'imessage',
      imessageConfig: { account: 'test-imsg', backend: 'imsg', sender: 'sender@example.test' },
    });
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);
    const res = mockRes();

    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({ adminPhones: ['5551230000'] }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).adminPhones).toEqual(['+15551230000']);
  });

  // -- model (passthrough) --

  it('accepts any string value for model without validation', async () => {
    const configPath = writeConfig({ model: 'claude-3-5-sonnet-20241022' });
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({ model: 'claude-opus-4-9000' }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).model).toBe('claude-opus-4-9000');
  });

  it('deep-merges memory patches and persists canonical memory config', async () => {
    const configPath = writeConfig({
      memory: {
        pinecone: {
          apiKeyEnv: 'PINECONE_TEAM_KEY',
          index: 'mw-mind',
          namespaces: {
            facts: 'team-facts',
            chunks: 'team-chunks',
            summaries: 'team-summaries',
          },
        },
      },
    });
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({
        pineconeAllowedIndexes: ['mw-mind'],
        memory: {
          pinecone: {
            projectId: 'nf9hzvy',
            namespaces: { facts: 'mw-facts' },
          },
        },
      }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.memory.pinecone).toMatchObject({
      apiKeyEnv: 'PINECONE_TEAM_KEY',
      projectId: 'nf9hzvy',
      index: 'mw-mind',
      allowedIndexes: ['mw-mind'],
    });
    expect(body.memory.pinecone.namespaces).toEqual({
      facts: 'mw-facts',
      chunks: 'team-chunks',
      summaries: 'team-summaries',
    });
    expect(body).not.toHaveProperty('pineconeAllowedIndexes');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual(body);
  });

  it('fails closed when another process owns the config mutation lock', async () => {
    const configPath = writeConfig({ model: 'old-model' });
    const lock = acquireProcessLock(privateConfigLockPath(configPath), { token: 'held-fleet-patch-lock' });
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);

    try {
      const res = mockRes();
      await handleConfigUpdate(
        mockReq({ body: JSON.stringify({ model: 'new-model' }), method: 'PATCH' }),
        res, deps, { name: 'test-line' },
      );

      expect(res._status).toBe(500);
      // #2517: the raw lock-contention detail ('process lock active') is
      // redacted into the closed fleet-error-v1 projection.
      const lockBody = JSON.parse(res._body);
      expect(lockBody.schema).toBe('fleet-error-v1');
      expect(lockBody.code).toBe('internal_error');
      expect(lockBody.message).not.toContain('process lock active');
      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).model).toBe('old-model');
    } finally {
      releaseProcessLock(lock);
    }
  });

  // -- combined patch --

  it('accepts a combined patch with accessMode + adminPhones + model', async () => {
    const configPath = writeConfig({ accessMode: 'self_only' });
    const inst = fakeInstance(configPath);
    const deps = depsFor(inst);

    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ body: JSON.stringify({
        accessMode: 'allowlist',
        adminPhones: ['15551230006'],
        model: 'claude-haiku-3-5',
      }), method: 'PATCH' }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.accessMode).toBe('allowlist');
    expect(body.adminPhones).toEqual(['15551230006']);
    expect(body.model).toBe('claude-haiku-3-5');
  });
});
