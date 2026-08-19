import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  handleAuth,
  handlePairingPreflight,
  handlePairingApply,
  handlePairingStatus,
} from '../../../src/fleet/routes/ops-auth.ts';
import { readPairingOperationRecord } from '../../../src/transport/pairing-saga.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';
import { appendLatchTransition } from '../../../src/transport/terminal-latch.ts';
import { parseAccountScopeId } from '../../../src/transport/auth-custody-contracts.ts';

const SCOPE = 'scope:line-a-wa';

let root: string;
let configDir: string;
let stateRoot: string;

function writeInstanceConfig(config: Record<string, unknown>): string {
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function depsFor(configPath: string): OpsDeps {
  return makeDeps({
    discovery: {
      getInstance: (name: string) =>
        name === 'test-line'
          ? ({ name: 'test-line', stateRoot, configPath } as never)
          : undefined,
      scan: () => undefined,
    } as never,
  }) as unknown as OpsDeps;
}

function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: 'Bearer test-token', ...extra };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pairing-routes-test-'));
  configDir = join(root, 'config');
  stateRoot = join(root, 'state');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('pairing route authenticity requirements', () => {
  it('refuses requests without header-borne Bearer credentials', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const res = mockRes();
    await handlePairingPreflight(
      mockReq({ method: 'POST', url: '/api/lines/test-line/pairing/preflight' }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(401);
    expect(res._body).toContain('header-borne Bearer');
  });

  it('refuses cross-site requests even with a Bearer header', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const res = mockRes();
    await handlePairingApply(
      mockReq({
        method: 'POST',
        url: '/api/lines/test-line/pairing/apply',
        headers: authedHeaders({ 'sec-fetch-site': 'cross-site' }),
      }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(403);
  });
});

describe('pairing route scope gating', () => {
  it('409s for instances without a configured accountScopeId', async () => {
    const configPath = writeInstanceConfig({});
    const res = mockRes();
    await handlePairingPreflight(
      mockReq({ method: 'POST', url: '/api/lines/test-line/pairing/preflight', headers: authedHeaders() }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(409);
    expect(res._body).toContain('requires a configured accountScopeId');
  });

  it('500s on a present-but-malformed accountScopeId', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: 'not-a-scope' });
    const res = mockRes();
    await handlePairingPreflight(
      mockReq({ method: 'POST', url: '/api/lines/test-line/pairing/preflight', headers: authedHeaders() }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(500);
    expect(res._body).toContain('malformed');
  });
});

describe('handlePairingPreflight', () => {
  it('returns the side-effect-free typed plan for a scoped instance', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const res = mockRes();
    await handlePairingPreflight(
      mockReq({ method: 'POST', url: '/api/lines/test-line/pairing/preflight', headers: authedHeaders() }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.scopeId).toBe(SCOPE);
    expect(body.plan.latch).toEqual({ status: 'missing', revision: 0 });
    expect(body.plan.lease).toEqual({ status: 'vacant' });
  });
});

describe('handlePairingApply', () => {
  it('rejects a missing or non-JSON body', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const res = mockRes();
    await handlePairingApply(
      mockReq({
        method: 'POST',
        url: '/api/lines/test-line/pairing/apply',
        headers: authedHeaders(),
        body: 'not json',
      }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(400);
  });

  it('rejects a body missing required fields', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const res = mockRes();
    await handlePairingApply(
      mockReq({
        method: 'POST',
        url: '/api/lines/test-line/pairing/apply',
        headers: authedHeaders(),
        body: JSON.stringify({ idempotencyKey: 'op-1' }),
      }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(400);
    expect(res._body).toContain('authorizationId');
  });

  it('threads saga refusals through as 409 with the typed outcome (stale latch CAS)', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const scope = parseAccountScopeId(SCOPE)!;
    expect(
      appendLatchTransition(stateRoot, {
        v: 1,
        scopeId: scope,
        kind: 'latch_created',
        revision: 1,
        expectedPriorRevision: 0,
        at: '2026-08-18T12:00:00.000Z',
        operationId: 'latch-op-1',
        ownerAuthorizationId: null,
        latch: {
          v: 1,
          scopeId: scope,
          latchedGenerationId: null,
          latchedCredentialTreeDigest: 'd'.repeat(64),
          reason: 'serverside_logout_irreversible',
          evidenceDigest: 'f'.repeat(64),
          latchedAt: '2026-08-18T12:00:00.000Z',
        },
        supersededByGenerationId: null,
      }).ok,
    ).toBe(true);

    const res = mockRes();
    await handlePairingApply(
      mockReq({
        method: 'POST',
        url: '/api/lines/test-line/pairing/apply',
        headers: authedHeaders(),
        body: JSON.stringify({
          idempotencyKey: 'op-1',
          authorizationId: 'auth-1',
          method: 'pairing_code',
          expectedLatchRevision: 0,
          expectedCurrentGenerationId: null,
        }),
      }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(409);
    expect(JSON.parse(res._body)).toEqual({
      ok: false,
      errorClass: 'verification_failed',
      refusal: 'stale_latch_revision',
    });
  });
});

describe('handlePairingStatus', () => {
  it('reports the plan and null operation for an unknown idempotency key', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const res = mockRes();
    await handlePairingStatus(
      mockReq({
        method: 'GET',
        url: '/api/lines/test-line/pairing/status?idempotencyKey=nope',
        headers: authedHeaders(),
      }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.operation).toBeNull();
    expect(body.lastEvent).toBeNull();
    expect(body.plan.latch).toEqual({ status: 'missing', revision: 0 });
  });
});

describe('pairing route scope and credential-shape branches', () => {
  it('preflight 500s on a present-but-malformed accountScopeId', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: 'not-a-scope' });
    const res = mockRes();
    await handlePairingPreflight(
      mockReq({ method: 'POST', url: '/api/lines/test-line/pairing/preflight', headers: authedHeaders() }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(500);
    expect(res._body).toContain('malformed');
  });

  it('preflight 409s for a legacy instance with no accountScopeId', async () => {
    const configPath = writeInstanceConfig({});
    const res = mockRes();
    await handlePairingPreflight(
      mockReq({ method: 'POST', url: '/api/lines/test-line/pairing/preflight', headers: authedHeaders() }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(409);
  });

  it('refuses a URL-borne token credential even with a Bearer header', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const res = mockRes();
    await handlePairingApply(
      mockReq({
        method: 'POST',
        url: '/api/lines/test-line/pairing/apply?token=root-secret',
        headers: authedHeaders(),
        body: JSON.stringify({ idempotencyKey: 'op-1', authorizationId: 'a', method: 'pairing_code', expectedLatchRevision: 0, expectedCurrentGenerationId: null }),
      }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(403);
    expect(res._body).toContain('URL-borne token');
  });

  it('status 409s for a legacy instance with no accountScopeId', async () => {
    const configPath = writeInstanceConfig({});
    const res = mockRes();
    await handlePairingStatus(
      mockReq({ method: 'GET', url: '/api/lines/test-line/pairing/status', headers: authedHeaders() }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(409);
  });

  it('apply 500s on a present-but-malformed accountScopeId', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: 'bad scope value' });
    const res = mockRes();
    await handlePairingApply(
      mockReq({
        method: 'POST',
        url: '/api/lines/test-line/pairing/apply',
        headers: authedHeaders(),
        body: JSON.stringify({ idempotencyKey: 'op-1', authorizationId: 'a', method: 'pairing_code', expectedLatchRevision: 0, expectedCurrentGenerationId: null }),
      }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(500);
  });
});

describe('legacy handleAuth gate for scoped instances', () => {
  it('409s a scoped instance toward the pairing saga', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const res = mockRes();
    await handleAuth(
      mockReq({ method: 'GET', url: '/api/lines/test-line/auth', headers: authedHeaders() }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(409);
    expect(res._body).toContain('pairing saga');
  });

  it('409s a scoped instance with a malformed accountScopeId', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: 'not a scope' });
    const res = mockRes();
    await handleAuth(
      mockReq({ method: 'GET', url: '/api/lines/test-line/auth', headers: authedHeaders() }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    expect(res._status).toBe(409);
    expect(res._body).toContain('malformed');
  });
});

describe('handlePairingApply body validation permutations', () => {
  async function apply(body: unknown) {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const res = mockRes();
    await handlePairingApply(
      mockReq({
        method: 'POST',
        url: '/api/lines/test-line/pairing/apply',
        headers: authedHeaders(),
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    return res;
  }

  it('rejects a missing method', async () => {
    const res = await apply({ idempotencyKey: 'op-1', authorizationId: 'a', expectedLatchRevision: 0, expectedCurrentGenerationId: null });
    expect(res._status).toBe(400);
    expect(res._body).toContain('method');
  });

  it('rejects an invalid method', async () => {
    const res = await apply({ idempotencyKey: 'op-1', authorizationId: 'a', method: 'sms', expectedLatchRevision: 0, expectedCurrentGenerationId: null });
    expect(res._status).toBe(400);
  });

  it('rejects a non-integer / negative expectedLatchRevision', async () => {
    const res = await apply({ idempotencyKey: 'op-1', authorizationId: 'a', method: 'qr', expectedLatchRevision: -1, expectedCurrentGenerationId: null });
    expect(res._status).toBe(400);
    const res2 = await apply({ idempotencyKey: 'op-1', authorizationId: 'a', method: 'qr', expectedLatchRevision: 1.5, expectedCurrentGenerationId: null });
    expect(res2._status).toBe(400);
  });

  it('rejects an empty-string expectedCurrentGenerationId (undefined sentinel)', async () => {
    const res = await apply({ idempotencyKey: 'op-1', authorizationId: 'a', method: 'pairing_code', expectedLatchRevision: 0, expectedCurrentGenerationId: '' });
    expect(res._status).toBe(400);
  });

  it('accepts a string expectedCurrentGenerationId shape (reaches the saga, stale-generation refusal)', async () => {
    const res = await apply({ idempotencyKey: 'op-1', authorizationId: 'a', method: 'pairing_code', expectedLatchRevision: 0, expectedCurrentGenerationId: 'gen-x' });
    // No latch, current generation is null; a non-null expectation is a stale
    // precondition, threaded through as a 409 (not a 400 validation error).
    expect(res._status).toBe(409);
  });
});

describe('handlePairingStatus operation-record arms', () => {
  it('surfaces journal_unreadable when the operation journal cannot be read', async () => {
    const configPath = writeInstanceConfig({ accountScopeId: SCOPE });
    const journalPath = join(stateRoot, 'pairing-operations.ndjson');
    writeFileSync(journalPath, 'placeholder\n', { mode: 0o600 });
    const { chmodSync } = await import('node:fs');
    chmodSync(journalPath, 0o000);
    const res = mockRes();
    await handlePairingStatus(
      mockReq({ method: 'GET', url: '/api/lines/test-line/pairing/status?idempotencyKey=op-1', headers: authedHeaders() }),
      res as never,
      depsFor(configPath),
      { name: 'test-line' },
    );
    chmodSync(journalPath, 0o600);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).operation).toEqual({ state: 'journal_unreadable' });
  });
});
