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
  _setFileStoreDirForTests,
  _setOpenCodeAuthDirForTests,
  lookupCredential,
} from '../../src/lib/keyring.ts';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('writeCredential — macos-keychain backend', () => {
  let dir: string;

  beforeEach(() => {
    _resetBackendCache();
    vi.stubGlobal('process', { ...process, platform: 'darwin' } as unknown as NodeJS.Process);
    execFileSyncMock.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-macos-credstore-'));
    _setFileStoreDirForTests(dir);
  });
  afterEach(() => {
    _setFileStoreDirForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('keeps the secret off argv, bounds the child, and mirrors an unscoped write atomically', () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    const out = writeCredential('minimax', 'sk-test-VALUE');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileSyncMock.mock.calls[0]!;
    expect(cmd).toBe('security');
    // The secret MUST NOT appear anywhere on argv (visible via `ps -ww`).
    expect(JSON.stringify(args)).not.toContain('sk-test-VALUE');
    // -w is the LAST option so `security` prompts for the password on stdin.
    expect(args).toEqual(['add-generic-password', '-U', '-s', 'minimax', '-a', os.userInfo().username, '-w']);
    // The value is delivered out-of-band on stdin, sent twice (enter + retype prompt).
    expect((opts as { input?: string }).input).toBe('sk-test-VALUE\nsk-test-VALUE\n');
    expect(opts).toEqual(expect.objectContaining({
      timeout: 3_000,
      killSignal: 'SIGKILL',
      stdio: ['pipe', 'ignore', 'pipe'],
    }));
    expect(out.backend).toBe('macos-keychain');
    const mirror = path.join(dir, 'minimax.key');
    expect(fs.readFileSync(mirror, 'utf-8')).toBe('sk-test-VALUE');
    expect(fs.statSync(mirror).mode & 0o777).toBe(0o600);
  });

  it('leaves the unscoped file untouched for a user-scoped write', () => {
    const mirror = path.join(dir, 'minimax.key');
    fs.writeFileSync(mirror, 'existing-unscoped-value', { mode: 0o600 });
    execFileSyncMock.mockReturnValue(Buffer.from(''));

    expect(writeCredential('minimax', 'scoped-value', { user: 'bot' })).toEqual({ backend: 'macos-keychain' });
    expect(fs.readFileSync(mirror, 'utf-8')).toBe('existing-unscoped-value');
  });

  it('cleans up a stale mirror and throws a sanitized failure when mirroring fails', () => {
    const mirror = path.join(dir, 'minimax.key');
    fs.writeFileSync(mirror, 'stale-unscoped-value', { mode: 0o600 });
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    const value = `sensitive-${'x'.repeat(4_096)}`;

    let caught: unknown;
    try { writeCredential('minimax', value); } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(KeyringWriteError);
    expect((caught as KeyringWriteError).code).toBe('KEYRING_WRITE_FAILED');
    expect(JSON.stringify(caught)).not.toContain(value);
    expect(fs.existsSync(mirror)).toBe(false);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('attempts both layers for an unscoped delete', () => {
    const mirror = path.join(dir, 'minimax.key');
    fs.writeFileSync(mirror, 'unscoped-value', { mode: 0o600 });
    execFileSyncMock.mockReturnValue(Buffer.from(''));

    expect(deleteCredential('minimax')).toEqual({ deleted: true, backend: 'macos-keychain', reason: 'deleted' });
    expect(fs.existsSync(mirror)).toBe(false);
    const [, , opts] = execFileSyncMock.mock.calls[0]!;
    expect(opts).toEqual(expect.objectContaining({
      timeout: 3_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'ignore', 'pipe'],
    }));
  });

  it('leaves the unscoped file untouched for a user-scoped delete', () => {
    const mirror = path.join(dir, 'minimax.key');
    fs.writeFileSync(mirror, 'unscoped-value', { mode: 0o600 });
    execFileSyncMock.mockReturnValue(Buffer.from(''));

    expect(deleteCredential('minimax', { user: 'bot' })).toEqual({ deleted: true, backend: 'macos-keychain', reason: 'deleted' });
    expect(fs.readFileSync(mirror, 'utf-8')).toBe('unscoped-value');
  });

  it('removes the mirror but reports false when the unscoped keychain delete fails', () => {
    const mirror = path.join(dir, 'minimax.key');
    fs.writeFileSync(mirror, 'unscoped-value', { mode: 0o600 });
    execFileSyncMock.mockImplementation(() => { throw new Error('keychain delete failed'); });

    expect(deleteCredential('minimax')).toEqual({
      deleted: false, backend: 'macos-keychain',
      reason: 'backend_failed', errorCode: 'KEYRING_WRITE_FAILED',
    });
    expect(fs.existsSync(mirror)).toBe(false);
  });

  it('does not report true when an inaccessible mirror may still exist', () => {
    const mirror = path.join(dir, 'minimax.key');
    fs.writeFileSync(mirror, 'unscoped-value', { mode: 0o600 });
    fs.chmodSync(dir, 0o000);
    execFileSyncMock.mockReturnValue(Buffer.from(''));

    const result = deleteCredential('minimax');
    fs.chmodSync(dir, 0o700);

    expect(result).toEqual({
      deleted: false, backend: 'macos-keychain',
      reason: 'backend_failed', errorCode: 'KEYRING_WRITE_FAILED',
    });
    expect(fs.existsSync(mirror)).toBe(true);
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
    expect(opts).toEqual(expect.objectContaining({
      timeout: 3_000,
      killSignal: 'SIGKILL',
      stdio: ['pipe', 'ignore', 'pipe'],
    }));
  });

  it('bounds secret-tool deletion while preserving stdio', () => {
    const result = deleteCredential('minimax');
    expect(result).toEqual({ deleted: true, backend: 'secret-tool', reason: 'deleted' });
    const clearCall = execFileSyncMock.mock.calls.find((c) => c[1]?.[0] === 'clear');
    expect(clearCall?.[2]).toEqual(expect.objectContaining({
      timeout: 3_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'ignore', 'pipe'],
    }));
  });
});

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

  it.each(['', 'nested/service', 'nested\\service', 'nul\0service'])(
    'rejects unsafe file-store service name %j',
    (service) => {
      expect(() => writeCredential(service, 'must-not-write')).toThrow(KeyringWriteError);
      expect(lookupCredential(service, { skipEnv: true })).toBeNull();
      expect(deleteCredential(service).deleted).toBe(false);
    },
  );

  it.each(['Twilio.Auth:prod', 'a'.repeat(128)])('preserves flat custom service name %s', (service) => {
    writeCredential(service, 'custom-service-secret');
    expect(lookupCredential(service, { skipEnv: true })).toBe('custom-service-secret');
    expect(deleteCredential(service).deleted).toBe(true);
  });

  it('rejects a credential above the bounded file-store size', () => {
    expect(() => writeCredential('deepseek', 'x'.repeat(4_097))).toThrow(KeyringWriteError);
    expect(fs.existsSync(path.join(dir, 'deepseek.key'))).toBe(false);
  });

  it('does not read an unsafe public credential file', () => {
    const target = path.join(dir, 'deepseek.key');
    fs.writeFileSync(target, 'public-file-secret', { mode: 0o644 });
    fs.chmodSync(target, 0o644);

    expect(lookupCredential('deepseek', { skipEnv: true })).toBeNull();
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
    expect(call![1]).toEqual(['find-generic-password', '-s', 'deepseek', '-a', os.userInfo().username, '-w']);
  });
});

const INVALID_SERVICES = ['', 'nested/service', 'nested\\service', 'nul\0service'] as const;

describe.each([
  { platform: 'darwin' as const, backend: 'macos-keychain' as const },
  { platform: 'linux' as const, backend: 'secret-tool' as const },
])('invalid service IDs — $platform', ({ platform, backend }) => {
  let authDir: string;

  beforeEach(() => {
    _resetBackendCache();
    vi.stubGlobal('process', { ...process, platform, env: { ...process.env } } as unknown as NodeJS.Process);
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-invalid-auth-'));
    _setOpenCodeAuthDirForTests(authDir);
    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify(Object.fromEntries(INVALID_SERVICES.map((service) => [service, { key: 'opencode-value' }]))),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    _setOpenCodeAuthDirForTests(null);
    fs.rmSync(authDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it.each(INVALID_SERVICES)('returns null for invalid lookup %j without child or OpenCode access', (service) => {
    expect(lookupCredential(service, { skipEnv: true })).toBeNull();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each(INVALID_SERVICES)('throws a sanitized write error for invalid service %j without child access', (service) => {
    let caught: unknown;
    try { writeCredential(service, 'sensitive-invalid-value', { user: 'bot' }); } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(KeyringWriteError);
    expect((caught as KeyringWriteError).code).toBe('KEYRING_WRITE_FAILED');
    expect(JSON.stringify(caught)).not.toContain('sensitive-invalid-value');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each(INVALID_SERVICES)('returns false for invalid delete %j without forwarding it to the backend', (service) => {
    expect(deleteCredential(service, { user: 'bot' })).toEqual({ deleted: false, backend, reason: 'unknown_service' });
    if (platform === 'darwin') {
      expect(execFileSyncMock).not.toHaveBeenCalled();
    } else {
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'secret-tool',
        ['--help'],
        expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
      );
    }
  });
});
