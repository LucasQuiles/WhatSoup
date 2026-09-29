/**
 * Fail-loud logging for keyring.ts:
 *  - warns once when backend probe fails and caches 'env-only'
 *  - warns when a keyring read fails and falls back to env; a proven absent
 *    item (macOS exit 44, or a secret-tool miss that a non-unlocking search
 *    confirms) is a silent miss, not a failure
 *  - errors (not just warns) when the probe ERRORS vs is genuinely absent
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logWarn = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ warn: logWarn, error: logError }),
}));

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});

import {
  lookupCredential,
  lookupCredentialTyped,
  detectKeyringBackend,
  _resetBackendCache,
  _setFileStoreDirForTests,
  _setOpenCodeAuthDirForTests,
} from '../../src/lib/keyring.ts';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockedExecFileSync = vi.mocked(execFileSync);

describe('keyring fail-loud logging', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetBackendCache();
    vi.clearAllMocks();
    // clearAllMocks() clears call history but NOT queued mockImplementationOnce
    // entries; reset the execFileSync mock so an unconsumed once-impl from a
    // prior test cannot leak into the next one's probe.
    mockedExecFileSync.mockReset();
    mockedExecFileSync.mockReturnValue(Buffer.from(''));
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    delete process.env.REQUIRE_OS_KEYRING;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    process.env = { ...originalEnv };
  });

  describe('backend probe failure warning', () => {
    it('warns once when secret-tool probe fails and backend falls back to env-only', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      // Genuine absence: execFileSync surfaces a missing binary as ENOENT.
      mockedExecFileSync.mockImplementationOnce(() => {
        const err: Error & { code?: string } = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      });

      detectKeyringBackend();

      expect(logWarn).toHaveBeenCalledOnce();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'env-only', err: 'not found' }),
        expect.stringContaining('keyring backend probe failed'),
      );
    });

    it('does not warn when backend probe succeeds (secret-tool found)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));

      detectKeyringBackend();

      expect(logWarn).not.toHaveBeenCalled();
    });

    it('does not warn when secret-tool --help exits 2 with a usage banner', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockImplementationOnce(() => {
        const err: Error & { status?: number; stderr?: Buffer } = new Error('Command failed: secret-tool --help');
        err.status = 2;
        err.stderr = Buffer.from('usage: secret-tool lookup attribute value ...\n');
        throw err;
      });

      detectKeyringBackend();

      expect(logWarn).not.toHaveBeenCalled();
      expect(logError).not.toHaveBeenCalled();
    });

    it('does not warn on darwin (no probe attempted)', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

      detectKeyringBackend();

      expect(logWarn).not.toHaveBeenCalled();
    });

    it('warns only once per process (cached result — no second probe, no second warn)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockImplementationOnce(() => {
        const err: Error & { code?: string } = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      });

      detectKeyringBackend();
      detectKeyringBackend();

      expect(logWarn).toHaveBeenCalledOnce();
    });
  });

  describe('keyring read failure warning', () => {
    it('warns with service name and error when secret-tool lookup throws', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      // First call: probe succeeds (backend = secret-tool)
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      // Second call: actual lookup throws
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('secret-tool failed'); });

      lookupCredential('anthropic', { skipEnv: true });

      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'anthropic', backend: 'secret-tool', err: 'secret-tool failed' }),
        expect.stringContaining('keyring read failed'),
      );
    });

    it('warns with service name and error when macOS keychain lookup throws', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('keychain error'); });

      lookupCredential('anthropic', { skipEnv: true });

      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'anthropic', backend: 'macos-keychain', err: 'keychain error' }),
        expect.stringContaining('keyring read failed'),
      );
    });

    it('does not include secret values in the warn log', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('fail'); });

      process.env.ANTHROPIC_API_KEY = 'test-api-key-value-xyz';
      lookupCredential('anthropic', { skipEnv: false });

      for (const call of logWarn.mock.calls) {
        const callStr = JSON.stringify(call);
        expect(callStr).not.toContain('test-api-key-value-xyz');
      }
    });

    it('warns at most once per service while preserving warnings for distinct services', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      mockedExecFileSync.mockImplementation(() => { throw new Error('keychain error'); });

      lookupCredential('anthropic', { skipEnv: true });
      lookupCredential('anthropic', { skipEnv: true });
      lookupCredential('openai', { skipEnv: true });

      expect(logWarn).toHaveBeenCalledTimes(2);
    });

    it('clears warning deduplication through the backend reset seam', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      mockedExecFileSync.mockImplementation(() => { throw new Error('keychain error'); });

      lookupCredential('anthropic', { skipEnv: true });
      _resetBackendCache();
      lookupCredential('anthropic', { skipEnv: true });

      expect(logWarn).toHaveBeenCalledTimes(2);
    });
  });

  // `security find-generic-password` exits 44 (errSecItemNotFound) when the
  // item is simply absent. That is a miss, not a read failure: it must neither
  // warn nor make the typed lookup report `unreadable`. Real failures still do.
  describe('macOS keychain absent item vs read failure', () => {
    let storeDir: string;
    let openCodeDir: string;

    function securityError(status: number | null, stderr: string, code?: string): Error {
      const err: Error & { status?: number | null; stderr?: Buffer; code?: string; signal?: string } =
        new Error('Command failed: security find-generic-password');
      err.status = status;
      err.stderr = Buffer.from(stderr);
      if (code) { err.code = code; err.signal = 'SIGKILL'; }
      return err;
    }

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-warn-fs-'));
      openCodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-warn-oc-'));
      _setFileStoreDirForTests(storeDir);
      _setOpenCodeAuthDirForTests(openCodeDir);
    });

    afterEach(() => {
      _setFileStoreDirForTests(null);
      _setOpenCodeAuthDirForTests(null);
      fs.rmSync(storeDir, { recursive: true, force: true });
      fs.rmSync(openCodeDir, { recursive: true, force: true });
    });

    // execFileSync throws with `status: null` only when the child was killed by
    // a signal or the spawn itself failed (then `code` is set), so a status-less
    // error is never a clean errSecItemNotFound exit: only status 44 is absence.
    it.each([
      ['exit 44', securityError(44, 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n')],
    ])('does not warn or report unreadable for an absent item (%s)', (_label, err) => {
      mockedExecFileSync.mockImplementation(() => { throw err; });

      const result = lookupCredentialTyped('anthropic', { skipEnv: true });

      expect(result).toEqual({ value: null, reason: 'not_found', service: 'anthropic' });
      expect(logWarn).not.toHaveBeenCalled();
    });

    it.each([
      ['exit 36 (interaction not allowed)', securityError(36, 'security: SecKeychainItemCopyContent: User interaction is not allowed.\n')],
      ['timeout', securityError(null, '', 'ETIMEDOUT')],
      // A non-44 status is authoritative even when stderr says "could not be found".
      ['exit 37 (no default keychain)', securityError(37, 'security: SecKeychainCopyDefault: A default keychain could not be found.\n')],
      // Interrupted after printing the not-found diagnostic: the text must not win.
      ['signal-killed with not-found text', Object.assign(
        securityError(null, 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n'),
        { signal: 'SIGTERM' },
      )],
    ])('still warns and reports unreadable for a genuine failure (%s)', (_label, err) => {
      mockedExecFileSync.mockImplementation(() => { throw err; });

      const result = lookupCredentialTyped('anthropic', { skipEnv: true });

      expect(result.reason).toBe('unreadable');
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'anthropic', backend: 'macos-keychain' }),
        expect.stringContaining('keyring read failed'),
      );
    });

    // 'google' carries a migration fallback candidate ('gemini'): a failure on
    // the fallback is as real as one on the primary; only absence is silent.
    const ABSENT = () => securityError(44, 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n');

    it('reports unreadable with one warning when the primary is absent and the fallback fails', () => {
      mockedExecFileSync
        .mockImplementationOnce(() => { throw ABSENT(); })
        .mockImplementationOnce(() => { throw securityError(36, 'security: User interaction is not allowed.\n'); });

      const result = lookupCredentialTyped('google', { skipEnv: true });

      expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ value: null, reason: 'unreadable', service: 'google' });
      expect(logWarn).toHaveBeenCalledOnce();
    });

    // The warning is deduped per service, but the typed lookup clears the
    // failure flag before every call. A deduped repeat failure must still flag
    // the lookup, or the second call degrades a broken store to `not_found`.
    it('keeps reporting unreadable on a repeat lookup after the warning is deduped', () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        const candidate = (args as string[])[2];
        if (candidate === 'google') throw ABSENT();
        throw securityError(36, 'security: User interaction is not allowed.\n');
      });

      const first = lookupCredentialTyped('google', { skipEnv: true });
      const second = lookupCredentialTyped('google', { skipEnv: true });

      expect(first).toEqual({ value: null, reason: 'unreadable', service: 'google' });
      expect(second).toEqual({ value: null, reason: 'unreadable', service: 'google' });
      expect(logWarn).toHaveBeenCalledOnce();
    });

    it('keeps reporting unreadable on a repeat secret-tool lookup after the warning is deduped', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockImplementation((_file, args) => {
        if ((args as string[])[0] === '--help') return Buffer.from('');
        throw new Error('secret-tool failed');
      });

      const first = lookupCredentialTyped('whatsoup_health', { skipEnv: true });
      const second = lookupCredentialTyped('whatsoup_health', { skipEnv: true });

      expect(first).toEqual({ value: null, reason: 'unreadable', service: 'whatsoup_health' });
      expect(second).toEqual({ value: null, reason: 'unreadable', service: 'whatsoup_health' });
      expect(logWarn).toHaveBeenCalledOnce();
    });

    it('stays a silent not_found when the primary and the fallback are both absent', () => {
      mockedExecFileSync.mockImplementation(() => { throw ABSENT(); });

      const result = lookupCredentialTyped('google', { skipEnv: true });

      expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ value: null, reason: 'not_found', service: 'google' });
      expect(logWarn).not.toHaveBeenCalled();
    });

    it('returns the fallback value when the primary is absent', () => {
      mockedExecFileSync
        .mockImplementationOnce(() => { throw ABSENT(); })
        .mockImplementationOnce(() => Buffer.from('fallback-value\n'));

      const result = lookupCredentialTyped('google', { skipEnv: true });

      expect(result).toEqual({ value: 'fallback-value', reason: 'ok', service: 'google' });
      expect(logWarn).not.toHaveBeenCalled();
    });
  });

  // `secret-tool lookup` exits 1 with empty stderr both when nothing matches
  // and when a match stays locked (a dismissed unlock ends without an error),
  // and 1 is also its generic failure status. A silent exit 1 is a miss only
  // once a non-unlocking `secret-tool search` for the same attributes lists
  // nothing; every other outcome is a read failure, on the primary AND on any
  // migration candidate.
  describe('secret-tool absent item vs read failure', () => {
    let storeDir: string;
    let openCodeDir: string;
    let calls: string[];
    let unexpected: string[];

    // Shaped like execFileSync's throw (Node v24.15.0 lib/child_process.js
    // checkExecSyncError): a non-zero exit or a signal kill is "Command failed:
    // <argv>" plus any stderr, with a numeric status, or null status and the
    // signal; a timeout or spawn failure is the spawnSync errno error
    // ("spawnSync <file> <code>") with the result fields copied onto it. The
    // argv after the file name is omitted from the message.
    function secretToolError(
      status: number | null,
      stderr: string,
      extra: { signal?: string; code?: string } = {},
    ): Error {
      const message = extra.code
        ? `spawnSync secret-tool ${extra.code}`
        : `Command failed: secret-tool${stderr ? `\n${stderr}` : ''}`;
      const err: Error & {
        status?: number | null; signal?: string | null; stderr?: Buffer; stdout?: Buffer; code?: string;
      } = new Error(message);
      err.status = status;
      err.signal = extra.signal ?? null;
      err.stdout = Buffer.from('');
      err.stderr = Buffer.from(stderr);
      if (extra.code) err.code = extra.code;
      return err;
    }
    const NO_MATCH = () => secretToolError(1, '');
    const DBUS_FAILURE = () => secretToolError(1, 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n');
    const TIMEOUT = () => secretToolError(null, '', { signal: 'SIGKILL', code: 'ETIMEDOUT' });
    // `secret-tool search` output: nothing at all for zero matches, and item
    // lines on stdout for every match, even a locked one whose secret it
    // cannot read (libsecret 0.21.7 tool/secret-tool.c on_retrieve_secret).
    const NO_ITEMS = () => Buffer.from('');
    const LOCKED_ITEM = () => Buffer.from(
      '[1]\nlabel = whatsoup\ncreated = 2026-01-01 00:00:00\nmodified = 2026-01-01 00:00:00\n',
    );

    // The probe succeeds; every other call is keyed "<verb> <service value>"
    // and recorded in order. A call with no outcome is recorded as unexpected
    // and asserted empty after each test, so it cannot pass as a credential
    // failure through the production catch.
    function stubSecretTool(outcomes: Record<string, () => Buffer>): void {
      mockedExecFileSync.mockImplementation((_file, args) => {
        const argv = args as string[];
        if (argv[0] === '--help') return Buffer.from('');
        const key = `${argv[0]} ${argv[2]}`;
        calls.push(key);
        const outcome = outcomes[key];
        if (!outcome) {
          unexpected.push(argv.join(' '));
          throw new Error(`unexpected secret-tool call: ${argv.join(' ')}`);
        }
        return outcome();
      });
    }

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      calls = [];
      unexpected = [];
      storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-warn-st-fs-'));
      openCodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-warn-st-oc-'));
      _setFileStoreDirForTests(storeDir);
      _setOpenCodeAuthDirForTests(openCodeDir);
    });

    afterEach(() => {
      _setFileStoreDirForTests(null);
      _setOpenCodeAuthDirForTests(null);
      fs.rmSync(storeDir, { recursive: true, force: true });
      fs.rmSync(openCodeDir, { recursive: true, force: true });
      expect(unexpected).toEqual([]);
    });

    it('stays a silent not_found on repeat when every silent exit 1 is confirmed by an empty search', () => {
      stubSecretTool({
        'lookup google': () => { throw NO_MATCH(); },
        'search google': NO_ITEMS,
        'lookup gemini': () => { throw NO_MATCH(); },
        'search gemini': NO_ITEMS,
      });

      const first = lookupCredentialTyped('google', { skipEnv: true });
      const second = lookupCredentialTyped('google', { skipEnv: true });

      expect(first).toEqual({ value: null, reason: 'not_found', service: 'google' });
      expect(second).toEqual({ value: null, reason: 'not_found', service: 'google' });
      expect(logWarn).not.toHaveBeenCalled();
      const perLookup = ['lookup google', 'search google', 'lookup gemini', 'search gemini'];
      expect(calls).toEqual([...perLookup, ...perLookup]);
    });

    it('searches with the same attributes as the lookup, without --unlock, on the read options', () => {
      stubSecretTool({ 'lookup whatsoup_health': () => { throw NO_MATCH(); }, 'search whatsoup_health': NO_ITEMS });

      const result = lookupCredentialTyped('whatsoup_health', { user: 'bot', skipEnv: true });

      expect(result).toEqual({ value: null, reason: 'not_found', service: 'whatsoup_health' });
      expect(logWarn).not.toHaveBeenCalled();
      expect(calls).toEqual(['lookup whatsoup_health', 'search whatsoup_health']);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'secret-tool',
        ['search', 'service', 'whatsoup_health', 'user', 'bot'],
        expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL', stdio: 'pipe' }),
      );
    });

    it('reports unreadable when a silent exit 1 hides a locked match (dismissed unlock)', () => {
      stubSecretTool({ 'lookup whatsoup_health': () => { throw NO_MATCH(); }, 'search whatsoup_health': LOCKED_ITEM });

      const first = lookupCredentialTyped('whatsoup_health', { skipEnv: true });
      const second = lookupCredentialTyped('whatsoup_health', { skipEnv: true });

      expect(first).toEqual({ value: null, reason: 'unreadable', service: 'whatsoup_health' });
      expect(second).toEqual({ value: null, reason: 'unreadable', service: 'whatsoup_health' });
      expect(logWarn).toHaveBeenCalledOnce();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          service: 'whatsoup_health', backend: 'secret-tool', err: expect.stringContaining('matching item'),
        }),
        expect.stringContaining('keyring read failed'),
      );
    });

    it.each([
      ['timeout', TIMEOUT, 'ETIMEDOUT'],
      ['exit 1 with stderr', DBUS_FAILURE, 'Cannot autolaunch D-Bus'],
      ['signal-killed', () => secretToolError(null, '', { signal: 'SIGTERM' }), 'Command failed'],
    ])('reports unreadable when the confirming search fails (%s)', (_label, makeErr, errText) => {
      stubSecretTool({
        'lookup whatsoup_health': () => { throw NO_MATCH(); },
        'search whatsoup_health': () => { throw makeErr(); },
      });

      const result = lookupCredentialTyped('whatsoup_health', { skipEnv: true });

      expect(result).toEqual({ value: null, reason: 'unreadable', service: 'whatsoup_health' });
      expect(calls).toEqual(['lookup whatsoup_health', 'search whatsoup_health']);
      expect(logWarn).toHaveBeenCalledOnce();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'whatsoup_health', err: expect.stringContaining(errText) }),
        expect.stringContaining('keyring read failed'),
      );
    });

    it('reports unreadable with one warning for exit 1 with stderr text, without searching', () => {
      stubSecretTool({ 'lookup whatsoup_health': () => { throw DBUS_FAILURE(); } });

      const result = lookupCredentialTyped('whatsoup_health', { skipEnv: true });

      expect(result).toEqual({ value: null, reason: 'unreadable', service: 'whatsoup_health' });
      expect(calls).toEqual(['lookup whatsoup_health']);
      expect(logWarn).toHaveBeenCalledOnce();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'whatsoup_health', backend: 'secret-tool' }),
        expect.stringContaining('keyring read failed'),
      );
    });

    it('reports unreadable when the primary is absent and the migration candidate times out', () => {
      stubSecretTool({
        'lookup google': () => { throw NO_MATCH(); },
        'search google': NO_ITEMS,
        'lookup gemini': () => { throw TIMEOUT(); },
      });

      const result = lookupCredentialTyped('google', { skipEnv: true });

      expect(result).toEqual({ value: null, reason: 'unreadable', service: 'google' });
      // The migration call happened, and the timeout is what was recorded —
      // against the requested service, not the migration candidate.
      expect(calls).toEqual(['lookup google', 'search google', 'lookup gemini']);
      expect(logWarn).toHaveBeenCalledOnce();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'google', backend: 'secret-tool', err: expect.stringContaining('ETIMEDOUT') }),
        expect.stringContaining('keyring read failed'),
      );
    });

    it('reports unreadable when the primary is whitespace and the migration candidate fails', () => {
      stubSecretTool({ 'lookup google': () => Buffer.from('  \n'), 'lookup gemini': () => { throw DBUS_FAILURE(); } });

      const result = lookupCredentialTyped('google', { skipEnv: true });

      expect(result).toEqual({ value: null, reason: 'unreadable', service: 'google' });
      expect(calls).toEqual(['lookup google', 'lookup gemini']);
      expect(logWarn).toHaveBeenCalledOnce();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'google', err: expect.stringContaining('Cannot autolaunch D-Bus') }),
        expect.stringContaining('keyring read failed'),
      );
    });

    it('returns ok when the primary fails and the migration candidate supplies a value', () => {
      stubSecretTool({ 'lookup google': () => { throw DBUS_FAILURE(); }, 'lookup gemini': () => Buffer.from('fallback-value\n') });

      const result = lookupCredentialTyped('google', { skipEnv: true });

      expect(result).toEqual({ value: 'fallback-value', reason: 'ok', service: 'google' });
      expect(calls).toEqual(['lookup google', 'lookup gemini']);
    });

    it.each([
      ['signal-killed', () => secretToolError(null, '', { signal: 'SIGTERM' })],
      ['timeout', TIMEOUT],
      ['spawn ENOENT', () => secretToolError(null, '', { code: 'ENOENT' })],
      ['exit 2 with empty stderr', () => secretToolError(2, '')],
    ])('reports unreadable for a non-absence failure without searching (%s)', (_label, makeErr) => {
      stubSecretTool({ 'lookup whatsoup_health': () => { throw makeErr(); } });

      const result = lookupCredentialTyped('whatsoup_health', { skipEnv: true });

      expect(result).toEqual({ value: null, reason: 'unreadable', service: 'whatsoup_health' });
      expect(calls).toEqual(['lookup whatsoup_health']);
      expect(logWarn).toHaveBeenCalledOnce();
    });
  });

  // Without an explicit `stdio`, execFileSync copies the child's stderr to this
  // process's stderr before throwing. Reads set piped stdio so stderr stays on
  // the thrown error (for classification) and is never echoed.
  describe('keyring read exec options', () => {
    it('passes piped stdio to the secret-tool lookup', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockImplementation(() => Buffer.from('value\n'));

      lookupCredential('whatsoup_health', { user: 'bot', skipEnv: true });

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'secret-tool',
        ['lookup', 'service', 'whatsoup_health', 'user', 'bot'],
        expect.objectContaining({ stdio: 'pipe', timeout: 3_000 }),
      );
    });

    it('passes piped stdio to the macOS keychain read', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      mockedExecFileSync.mockImplementation(() => Buffer.from('value\n'));

      lookupCredential('whatsoup_health', { user: 'bot', skipEnv: true });

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'whatsoup_health', '-a', 'bot', '-w'],
        expect.objectContaining({ stdio: 'pipe', timeout: 3_000 }),
      );
    });
  });

  // CRED-2: a probe that ERRORS (timeout, EACCES, unexpected exit) silently
  // downgrading all credential storage to plaintext 0600 files is alarming and
  // must be distinguished from a genuinely-absent keyring (ENOENT), which is the
  // expected, benign fallback on hosts with no keyring installed.
  describe('errored vs absent probe downgrade', () => {
    function makeErr(code?: string): Error & { code?: string } {
      const err: Error & { code?: string } = new Error(code ? `${code} probe` : 'probe blew up');
      if (code) err.code = code;
      return err;
    }

    it('logs at ERROR level (downgrade alarm) when the probe ERRORS, not just ENOENT', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      // Non-ENOENT failure: secret-tool exists but errored (e.g. timeout/EACCES).
      mockedExecFileSync.mockImplementationOnce(() => { throw makeErr('ETIMEDOUT'); });

      expect(detectKeyringBackend()).toBe('env-only');

      expect(logError).toHaveBeenCalledOnce();
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'env-only', err: expect.stringContaining('ETIMEDOUT') }),
        expect.stringMatching(/downgrade/i),
      );
    });

    it('does NOT log at ERROR level when the keyring is genuinely absent (ENOENT)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockImplementationOnce(() => { throw makeErr('ENOENT'); });

      expect(detectKeyringBackend()).toBe('env-only');

      expect(logError).not.toHaveBeenCalled();
      // Still warns so the env-only fallback remains operator-visible.
      expect(logWarn).toHaveBeenCalledOnce();
    });

    it('throws on an ERRORED probe downgrade when REQUIRE_OS_KEYRING is set', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      process.env.REQUIRE_OS_KEYRING = '1';
      mockedExecFileSync.mockImplementationOnce(() => { throw makeErr('EACCES'); });

      expect(() => detectKeyringBackend()).toThrow(/keyring/i);
    });

    it('does NOT throw for a genuinely-absent keyring even when REQUIRE_OS_KEYRING is set', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      process.env.REQUIRE_OS_KEYRING = '1';
      mockedExecFileSync.mockImplementationOnce(() => { throw makeErr('ENOENT'); });

      expect(detectKeyringBackend()).toBe('env-only');
    });
  });
});
