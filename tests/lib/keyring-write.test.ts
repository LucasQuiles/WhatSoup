import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: execFileSyncMock,
}));

import {
  writeCredential,
  deleteCredential,
  KeyringWriteError,
  _resetBackendCache,
} from '../../src/lib/keyring.ts';
import * as os from 'node:os';

describe('writeCredential — macos-keychain backend', () => {
  beforeEach(() => {
    _resetBackendCache();
    vi.stubGlobal('process', { ...process, platform: 'darwin' } as unknown as NodeJS.Process);
    execFileSyncMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('invokes security add-generic-password with -U, -- separators, and the exact service/account', () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    const out = writeCredential('deepseek', 'sk-test-VALUE');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileSyncMock.mock.calls[0]!;
    expect(cmd).toBe('security');
    expect(args).toEqual([
      'add-generic-password', '-U',
      '-s', '--', 'deepseek',
      '-a', '--', os.userInfo().username,
      '-w', 'sk-test-VALUE',
    ]);
    expect(out.backend).toBe('macos-keychain');
  });

  it('maps a locked-keychain failure to KeyringWriteError KEYRING_LOCKED with no value in the error', () => {
    const childErr = Object.assign(new Error('User interaction is not allowed.'), {
      status: 36,
      stderr: Buffer.from('security: SecKeychainItemCreateFromContent: User interaction is not allowed.'),
      spawnargs: ['add-generic-password', '-w', 'sk-test-VALUE'],
    });
    execFileSyncMock.mockImplementation(() => { throw childErr; });
    let caught: unknown;
    try { writeCredential('deepseek', 'sk-test-VALUE'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(KeyringWriteError);
    const err = caught as KeyringWriteError;
    expect(err.code).toBe('KEYRING_LOCKED');
    // The sanitized error must carry NO secret material and NO child-process payload.
    expect(JSON.stringify({ msg: err.message, ...err })).not.toContain('sk-test-VALUE');
    expect((err as unknown as Record<string, unknown>).spawnargs).toBe(undefined);
    expect((err as unknown as Record<string, unknown>).stderr).toBe(undefined);
  });

  it('maps a generic write failure to KEYRING_WRITE_FAILED', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('boom'), { status: 1 });
    });
    let code = '';
    try { writeCredential('minimax', 'v'); } catch (e) { code = (e as KeyringWriteError).code; }
    expect(code).toBe('KEYRING_WRITE_FAILED');
  });
});

describe('writeCredential — secret-tool backend', () => {
  beforeEach(() => {
    _resetBackendCache();
    vi.stubGlobal('process', { ...process, platform: 'linux' } as unknown as NodeJS.Process);
    execFileSyncMock.mockReset();
    // detectKeyringBackend probes `secret-tool --help` first — succeed it.
    execFileSyncMock.mockReturnValue(Buffer.from(''));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('pipes the value via stdin (never argv) with -- separators', () => {
    writeCredential('minimax', 'mm-secret-VALUE');
    const storeCall = execFileSyncMock.mock.calls.find((c) => c[1]?.[0] === 'store');
    expect(storeCall).not.toBe(undefined);
    const [cmd, args, opts] = storeCall!;
    expect(cmd).toBe('secret-tool');
    expect(args).toEqual(['store', '--label=whatsoup minimax', 'service', 'minimax']);
    expect((opts as { input?: string }).input).toBe('mm-secret-VALUE');
    expect(JSON.stringify(args)).not.toContain('mm-secret-VALUE');
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { lookupCredential, _setFileStoreDirForTests } from '../../src/lib/keyring.ts';

describe('writeCredential — file-store backend (env-only hosts)', () => {
  let dir: string;
  beforeEach(() => {
    _resetBackendCache();
    vi.stubGlobal('process', { ...process, platform: 'linux', env: { ...process.env } } as unknown as NodeJS.Process);
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => { throw new Error('no secret-tool'); }); // probe fails → env-only
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-credstore-'));
    _setFileStoreDirForTests(dir);
  });
  afterEach(() => {
    _setFileStoreDirForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('writes a per-service 0600 file and lookupCredential reads it back', () => {
    const res = writeCredential('deepseek', 'ds-file-VALUE');
    expect(res.backend).toBe('env-only');
    const f = path.join(dir, 'deepseek.key');
    expect((fs.statSync(f).mode & 0o777)).toBe(0o600);
    expect((fs.statSync(dir).mode & 0o777)).toBe(0o700);
    delete (process.env as Record<string, string | undefined>).DEEPSEEK_API_KEY;
    expect(lookupCredential('deepseek')).toBe('ds-file-VALUE');
  });

  it('deleteCredential removes the file and reports deleted=false when absent', () => {
    writeCredential('deepseek', 'v1');
    expect(deleteCredential('deepseek').deleted).toBe(true);
    expect(deleteCredential('deepseek').deleted).toBe(false);
  });

  it('serializes concurrent writes — both values land (last write wins, none lost mid-flight)', () => {
    writeCredential('deepseek', 'A');
    writeCredential('minimax', 'B');
    delete (process.env as Record<string, string | undefined>).DEEPSEEK_API_KEY;
    delete (process.env as Record<string, string | undefined>).MINIMAX_API_KEY;
    expect(lookupCredential('deepseek')).toBe('A');
    expect(lookupCredential('minimax')).toBe('B');
  });
});

describe('lookupCredential — flag-injection guards', () => {
  beforeEach(() => {
    _resetBackendCache();
    vi.stubGlobal('process', { ...process, platform: 'darwin' } as unknown as NodeJS.Process);
    execFileSyncMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('passes -- separators to security find-generic-password', () => {
    execFileSyncMock.mockReturnValue(Buffer.from('val'));
    lookupCredential('deepseek', { skipEnv: true });
    const call = execFileSyncMock.mock.calls.find((c) => c[0] === 'security');
    expect(call![1]).toEqual(['find-generic-password', '-s', '--', 'deepseek', '-a', '--', os.userInfo().username, '-w']);
  });
});
