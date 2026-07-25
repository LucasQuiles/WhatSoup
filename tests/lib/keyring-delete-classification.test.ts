/**
 * #2292 L8 — a credential delete must distinguish "nothing to remove" from
 * "the store could not be consulted".
 *
 * Before this, four separate paths in `deleteCredential` collapsed to
 * `deleted: false`, and the fleet route mapped that to HTTP 404. An operator
 * whose keychain was locked was told the credential did not exist, while it
 * remained stored and readable.
 *
 * Setup mirrors tests/lib/keyring-write.test.ts (same execFileSync mock, same
 * darwin stub, same temp file-store) so only the classification is under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: execFileSyncMock,
}));

import { deleteCredential, _resetBackendCache, _setFileStoreDirForTests } from '../../src/lib/keyring.ts';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Build a child-process failure the way execFileSync does: status + stderr. */
function execFailure(status: number, stderr: string): Error & { status: number; stderr: string } {
  const err = new Error(`Command failed with exit code ${status}`) as Error & { status: number; stderr: string };
  err.status = status;
  err.stderr = stderr;
  return err;
}

describe('deleteCredential classification — macos-keychain (#2292 L8)', () => {
  let dir: string;

  beforeEach(() => {
    _resetBackendCache();
    vi.stubGlobal('process', { ...process, platform: 'darwin' } as unknown as NodeJS.Process);
    execFileSyncMock.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-del-class-'));
    _setFileStoreDirForTests(dir);
  });
  afterEach(() => {
    _setFileStoreDirForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('reports ABSENT — not a failure — when the keychain has no such item (status 44)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw execFailure(44, 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
    });
    const out = deleteCredential('minimax');
    // Absence carries no errorCode — there was no failure to classify.
    expect(out.errorCode).toBeUndefined();
    expect(out.deleted).toBe(false);
    expect(out.reason).toBe('absent');
  });

  it('recognises item-not-found from the message even when the status is unhelpful', () => {
    execFileSyncMock.mockImplementation(() => {
      throw execFailure(1, 'The specified item could not be found in the keychain.');
    });
    expect(deleteCredential('minimax').reason).toBe('absent');
  });

  // The case the issue is actually about.
  it('reports BACKEND_FAILED, not absent, when the keychain is LOCKED (status 36)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw execFailure(36, 'security: SecKeychainItemDelete: User interaction is not allowed.');
    });
    const out = deleteCredential('minimax');
    expect(out.reason).toBe('backend_failed');
    expect(out.errorCode).toBe('KEYRING_LOCKED');
    expect(out.deleted).toBe(false);
  });

  it('reports BACKEND_FAILED with KEYRING_ACCESS_DENIED when access is refused (status 45)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw execFailure(45, 'security: errSecAuthFailed');
    });
    const out = deleteCredential('minimax');
    expect(out.reason).toBe('backend_failed');
    expect(out.errorCode).toBe('KEYRING_ACCESS_DENIED');
  });

  it('never leaks the child-process error itself — only a sanitized code', () => {
    // A raw execFileSync error carries spawnargs/stderr; the fleet server logs
    // `{ err }` globally, so any of it reaching the result is a leak vector.
    execFileSyncMock.mockImplementation(() => {
      const err = execFailure(36, 'interaction is not allowed') as unknown as Record<string, unknown>;
      err.spawnargs = ['security', 'delete-generic-password', '-w', 'sk-SECRET-VALUE'];
      throw err;
    });
    const out = deleteCredential('minimax');
    expect(JSON.stringify(out)).not.toContain('sk-SECRET-VALUE');
    expect(JSON.stringify(out)).not.toContain('spawnargs');
    expect(out.errorCode).toBe('KEYRING_LOCKED');
  });

  it('reports DELETED when the keychain delete succeeds and the mirror is gone', () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    const out = deleteCredential('minimax');
    expect(out.reason).toBe('deleted');
    expect(out.deleted).toBe(true);
  });

  it('rejects an unknown service as UNKNOWN_SERVICE without consulting any backend', () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    const out = deleteCredential('nested/service');
    expect(out.reason).toBe('unknown_service');
    expect(out.deleted).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  // Discriminating case: the pre-existing best-effort contract must survive.
  it('still sweeps the file mirror even when the keychain delete fails', () => {
    const mirror = path.join(dir, 'minimax.key');
    fs.writeFileSync(mirror, 'unscoped-value', { mode: 0o600 });
    execFileSyncMock.mockImplementation(() => { throw execFailure(36, 'interaction is not allowed'); });

    const out = deleteCredential('minimax');

    // Removing what CAN be removed is the long-standing contract of this
    // function; classification must not turn it into an early return.
    expect(fs.existsSync(mirror)).toBe(false);
    expect(out.reason).toBe('backend_failed');
  });
});
