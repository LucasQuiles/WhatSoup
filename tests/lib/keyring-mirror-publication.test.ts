// tests/lib/keyring-mirror-publication.test.ts
// On macOS, writeCredential writes the keychain first and then mirrors the value
// into the private file store. When the mirror write fails, the stale mirror is
// deleted only if the new value provably never reached it; a published or
// possibly-published mirror must not be deleted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PrivatePublicationState } from '../../src/lib/private-fs-isolated.ts';

const mirrorWrite = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});

vi.mock('../../src/lib/private-fs-isolated.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/private-fs-isolated.ts')>()),
  writeAtomicPrivateFileIsolatedSync: mirrorWrite,
}));

import { execFileSync } from 'node:child_process';
import {
  _resetBackendCache,
  _setFileStoreDirForTests,
  KeyringWriteError,
  writeCredential,
} from '../../src/lib/keyring.ts';

const mockedExecFileSync = vi.mocked(execFileSync);
const originalPlatform = process.platform;

describe('writeCredential mirror failure on macOS', () => {
  let storeDir: string;

  beforeEach(() => {
    _resetBackendCache();
    vi.clearAllMocks();
    mockedExecFileSync.mockReset();
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-mirror-'));
    _setFileStoreDirForTests(storeDir);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    _setFileStoreDirForTests(null);
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  function attemptWithMirrorFailure(publication: PrivatePublicationState | undefined): {
    code: string | undefined;
    mirrorPresent: boolean;
  } {
    const mirror = path.join(storeDir, 'anthropic.key');
    fs.writeFileSync(mirror, 'old-value', { mode: 0o600 });
    mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
    mirrorWrite.mockImplementationOnce(() => {
      const error = Object.assign(new Error('mirror write failed'), { code: 'EIO' });
      throw publication === undefined ? error : Object.assign(error, { publication });
    });
    let code: string | undefined;
    try {
      writeCredential('anthropic', 'new-value');
    } catch (error) {
      expect(error).toBeInstanceOf(KeyringWriteError);
      code = (error as KeyringWriteError).code;
    }
    return { code, mirrorPresent: fs.existsSync(mirror) };
  }

  it('deletes the stale mirror when the new value was not published', () => {
    expect(attemptWithMirrorFailure('not-published')).toEqual({ code: 'KEYRING_WRITE_FAILED', mirrorPresent: false });
    expect(mirrorWrite).toHaveBeenCalledTimes(1);
  });

  it('keeps the mirror when the new value was published', () => {
    expect(attemptWithMirrorFailure('published')).toEqual({ code: 'KEYRING_WRITE_FAILED', mirrorPresent: true });
  });

  it('keeps the mirror when publication is unknown', () => {
    expect(attemptWithMirrorFailure('unknown')).toEqual({ code: 'KEYRING_WRITE_FAILED', mirrorPresent: true });
  });

  it('treats an error without a publication state as unknown and keeps the mirror', () => {
    expect(attemptWithMirrorFailure(undefined)).toEqual({ code: 'KEYRING_WRITE_FAILED', mirrorPresent: true });
  });
});
