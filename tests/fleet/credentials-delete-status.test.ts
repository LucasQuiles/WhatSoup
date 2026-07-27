/**
 * #2292 L8 — DELETE /api/credentials/:service must not report a backend
 * failure as 404.
 *
 * `deleteCredential` used to collapse "no such item" and "the store could not
 * be consulted" into `deleted: false`, and this route mapped that to 404. An
 * operator whose keychain was locked was told the credential did not exist and
 * could reasonably conclude no deletion was needed — while it remained stored.
 */
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

import { handleDeleteCredential, _resetMutationCooldownsForTests } from '../../src/fleet/routes/credentials.ts';

function fakeReq(): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  process.nextTick(() => req.emit('end'));
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

describe('DELETE /api/credentials/:service — outcome classification (#2292 L8)', () => {
  beforeEach(() => {
    _resetMutationCooldownsForTests();
    keyringMock.deleteCredential.mockReset();
  });

  it('returns 200 when the credential was actually removed', async () => {
    keyringMock.deleteCredential.mockReturnValue({ deleted: true, backend: 'macos-keychain', reason: 'deleted' });
    const r = fakeRes();
    await handleDeleteCredential(fakeReq(), r.res, { name: 'deepseek' }, { instances: [] });
    expect(r.status()).toBe(200);
    expect(r.json().ok).toBe(true);
  });

  it('returns 404 when there was genuinely nothing to remove', async () => {
    keyringMock.deleteCredential.mockReturnValue({ deleted: false, backend: 'macos-keychain', reason: 'absent' });
    const r = fakeRes();
    await handleDeleteCredential(fakeReq(), r.res, { name: 'deepseek' }, { instances: [] });
    expect(r.status()).toBe(404);
  });

  // The defect. Both of these used to be 404.
  it('returns 500, NOT 404, when the keychain is locked', async () => {
    keyringMock.deleteCredential.mockReturnValue({
      deleted: false, backend: 'macos-keychain',
      reason: 'backend_failed', errorCode: 'KEYRING_LOCKED',
    });
    const r = fakeRes();
    await handleDeleteCredential(fakeReq(), r.res, { name: 'deepseek' }, { instances: [] });
    expect(r.status()).toBe(500);
    const body = r.json();
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe('KEYRING_LOCKED');
    expect(String(body.error)).toMatch(/store unavailable/i);
  });

  it('returns 500 when access to the store is denied', async () => {
    keyringMock.deleteCredential.mockReturnValue({
      deleted: false, backend: 'macos-keychain',
      reason: 'backend_failed', errorCode: 'KEYRING_ACCESS_DENIED',
    });
    const r = fakeRes();
    await handleDeleteCredential(fakeReq(), r.res, { name: 'deepseek' }, { instances: [] });
    expect(r.status()).toBe(500);
    expect(r.json().errorCode).toBe('KEYRING_ACCESS_DENIED');
  });

  // Discriminating case: "return 500 for every non-deleted outcome" would pass
  // the two tests above while destroying the legitimate 404.
  it('keeps 404 and 500 distinct — absent is not an error', async () => {
    keyringMock.deleteCredential.mockReturnValue({ deleted: false, backend: 'macos-keychain', reason: 'absent' });
    const absent = fakeRes();
    await handleDeleteCredential(fakeReq(), absent.res, { name: 'deepseek' }, { instances: [] });

    _resetMutationCooldownsForTests();
    keyringMock.deleteCredential.mockReturnValue({
      deleted: false, backend: 'macos-keychain', reason: 'backend_failed', errorCode: 'KEYRING_WRITE_FAILED',
    });
    const failed = fakeRes();
    await handleDeleteCredential(fakeReq(), failed.res, { name: 'deepseek' }, { instances: [] });

    expect(absent.status()).toBe(404);
    expect(failed.status()).toBe(500);
    expect(absent.status()).not.toBe(failed.status());
  });
});
