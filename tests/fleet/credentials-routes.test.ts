// tests/fleet/credentials-routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

const keyringMock = vi.hoisted(() => ({
  writeCredential: vi.fn(),
  deleteCredential: vi.fn(),
  lookupCredential: vi.fn(),
}));
vi.mock('../../src/lib/keyring.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/keyring.ts')>()),
  ...keyringMock,
}));

import {
  handlePutCredential,
  handleDeleteCredential,
  handleVerifyCredential,
  handleGetCredential,
  CREDENTIAL_ALLOWLIST,
  CREDENTIAL_WRITE_BLOCKLIST,
  _resetVerifyCooldownsForTests,
} from '../../src/fleet/routes/credentials.ts';

/** Minimal req/res doubles matching the node:http handler contract. */
function fakeReq(body?: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  return req;
}
function fakeRes(): { res: ServerResponse; status: () => number; json: () => Record<string, unknown> } {
  let code = 0;
  let payload = '';
  const res = {
    writeHead(c: number) { code = c; return res; },
    setHeader() { return res; },
    end(chunk?: string) { payload = chunk ?? ''; },
  } as unknown as ServerResponse;
  return { res, status: () => code, json: () => JSON.parse(payload || '{}') };
}

beforeEach(() => {
  keyringMock.writeCredential.mockReset().mockReturnValue({ backend: 'macos-keychain' });
  keyringMock.deleteCredential.mockReset().mockReturnValue({ deleted: true, backend: 'macos-keychain' });
  keyringMock.lookupCredential.mockReset().mockReturnValue('resolved-key');
  _resetVerifyCooldownsForTests();
  delete process.env.DEEPSEEK_API_KEY;
});

describe('PUT /api/credentials/:service', () => {
  it('writes an allowlisted service and reports backend + envShadowed=false', async () => {
    const { res, status, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-new' }), res, { name: 'deepseek' });
    expect(keyringMock.writeCredential).toHaveBeenCalledWith('deepseek', 'sk-new');
    expect(status()).toBe(200);
    expect(json()).toEqual({ ok: true, service: 'deepseek', backend: 'macos-keychain', envShadowed: false });
  });

  it('reports envShadowed=true when the mapped env var is set', async () => {
    process.env.DEEPSEEK_API_KEY = 'shadow';
    const { res, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-new' }), res, { name: 'deepseek' });
    expect(json().envShadowed).toBe(true);
  });

  it('rejects a blocklisted service with 403 and never touches the keyring', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: 'whatsoup-health-token' });
    expect(status()).toBe(403);
    expect(keyringMock.writeCredential).not.toHaveBeenCalled();
  });

  it.each(['pinecone', 'elevenlabs', 'unknown-svc'])('rejects non-allowlisted %s with 404', async (svc) => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: svc });
    expect(status()).toBe(404);
    expect(keyringMock.writeCredential).not.toHaveBeenCalled();
  });

  it('rejects bad charset (uppercase / traversal) with 400 before any lookup', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: '../etc' });
    expect(status()).toBe(400);
    expect(keyringMock.writeCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['multiline', 'a\nb'],
    ['oversize', 'x'.repeat(4097)],
  ])('rejects %s value with 400', async (_label, value) => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value }), res, { name: 'deepseek' });
    expect(status()).toBe(400);
    expect(keyringMock.writeCredential).not.toHaveBeenCalled();
  });

  it('maps KEYRING_LOCKED to 503 without echoing the value', async () => {
    const { KeyringWriteError } = await vi.importActual<typeof import('../../src/lib/keyring.ts')>('../../src/lib/keyring.ts');
    keyringMock.writeCredential.mockImplementation(() => {
      throw new KeyringWriteError('KEYRING_LOCKED', 'keychain write failed for service deepseek');
    });
    const { res, status, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-SECRET' }), res, { name: 'deepseek' });
    expect(status()).toBe(503);
    expect(JSON.stringify(json())).not.toContain('sk-SECRET');
    expect(json().code).toBe('KEYRING_LOCKED');
  });
});
