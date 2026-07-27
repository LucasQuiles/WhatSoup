// #2286: a credential that EXISTS but cannot be read (permission flip, disk
// error, corrupt JSON) must not be reported as absent. Reporting it absent is
// what drove false `fallback_credential_missing` alerts and could lead an
// operator to re-store a key that is present but broken.
//
// The distinction surfaces through lookupCredentialTyped's `reason`:
// 'unreadable' (a store failed) vs 'not_found' (nothing configured).
//
// Failure injection deliberately avoids chmod. readPrivateFileSync enforces
// maxBytes=4096, so an oversize credential file makes it throw on every
// platform with no permission manipulation — and therefore no dependence on
// whether the test runs as root. #2303 tracks nine existing chmod tests that
// fail when run as root; this suite does not add a tenth.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});

import {
  lookupCredentialTyped,
  _setOpenCodeAuthDirForTests,
  _setFileStoreDirForTests,
  _resetBackendCache,
} from '../../src/lib/keyring.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const originalPlatform = process.platform;
const SERVICE = 'minimax';
let openCodeDir: string;
let storeDir: string;

/** A credential file above readPrivateFileSync's 4096-byte ceiling. */
function writeOversizeCredential(): void {
  fs.writeFileSync(path.join(storeDir, `${SERVICE}.key`), 'x'.repeat(8192), { mode: 0o600 });
}

describe('credential read failures are distinguished from absence (#2286)', () => {
  beforeEach(() => {
    _resetBackendCache();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    openCodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-oc-'));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-fs-'));
    _setOpenCodeAuthDirForTests(openCodeDir);
    _setFileStoreDirForTests(storeDir);
    delete process.env.MINIMAX_API_KEY;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    _setOpenCodeAuthDirForTests(null);
    _setFileStoreDirForTests(null);
    fs.rmSync(openCodeDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
    _resetBackendCache();
  });

  it('reports an unreadable file-store credential as unreadable, not not_found', () => {
    writeOversizeCredential();
    const result = lookupCredentialTyped(SERVICE);
    expect(result.value).toBeNull();
    expect(result.reason).toBe('unreadable');
  });

  it('reports a corrupt opencode auth.json as unreadable, not not_found', () => {
    fs.writeFileSync(path.join(openCodeDir, 'auth.json'), '{ not valid json', { mode: 0o600 });
    const result = lookupCredentialTyped(SERVICE);
    expect(result.value).toBeNull();
    expect(result.reason).toBe('unreadable');
  });

  // ── Over-correction guards ────────────────────────────────────────────────
  // The fix removes a blanket catch. The failure direction that introduces is
  // turning a legitimate absence into a fault on the credential-presence hot
  // path, which would make EVERY unconfigured provider look broken. These two
  // pin the absent case and must keep passing.

  it('still reports a genuinely absent credential as not_found', () => {
    // No file-store entry, no auth.json at all — pure absence.
    const result = lookupCredentialTyped(SERVICE);
    expect(result.value).toBeNull();
    expect(result.reason).toBe('not_found');
  });

  it('treats a missing opencode auth.json (ENOENT) as absence, not a read failure', () => {
    fs.writeFileSync(path.join(storeDir, 'unrelated.key'), 'v', { mode: 0o600 });
    const result = lookupCredentialTyped(SERVICE);
    expect(result.reason).toBe('not_found');
    expect(result.reason).not.toBe('unreadable');
  });

  it('still resolves a readable credential as ok', () => {
    fs.writeFileSync(path.join(storeDir, `${SERVICE}.key`), 'good-value', { mode: 0o600 });
    const result = lookupCredentialTyped(SERVICE);
    expect(result.value).toBe('good-value');
    expect(result.reason).toBe('ok');
  });

  // ── Leak guard ────────────────────────────────────────────────────────────

  it('does not leak a failure recorded during a lookup that still succeeded', () => {
    // The leak this pins is specifically the 'ok' exit path. A first lookup
    // where an EARLY store fails but a LATER store supplies the value returns
    // 'ok' and never touches the failure flag on its way out — so without the
    // clear-before-lookup, the flag survives into the NEXT lookup and turns a
    // genuine absence into a false 'unreadable'.
    //
    // An earlier version of this test used two lookups that both ended in the
    // 'unreadable' branch. That branch clears the flag itself, so the clear-
    // before-lookup was never exercised and the test passed against a mutant
    // with it removed. Constructing the 'ok' exit is what makes this non-vacuous.
    writeOversizeCredential();
    fs.writeFileSync(
      path.join(openCodeDir, 'auth.json'),
      JSON.stringify({ [SERVICE]: { type: 'api', key: 'from-opencode' } }),
      { mode: 0o600 },
    );
    const first = lookupCredentialTyped(SERVICE);
    expect(first.value).toBe('from-opencode');
    expect(first.reason).toBe('ok');

    // Now remove every source: the credential is genuinely absent.
    fs.rmSync(path.join(storeDir, `${SERVICE}.key`));
    fs.rmSync(path.join(openCodeDir, 'auth.json'));

    const second = lookupCredentialTyped(SERVICE);
    expect(second.value).toBeNull();
    expect(second.reason).toBe('not_found');
  });

  it('does not leak a failure for one service into the result for another', () => {
    writeOversizeCredential();
    expect(lookupCredentialTyped(SERVICE).reason).toBe('unreadable');
    // A different known service with nothing configured is absent, not unreadable.
    expect(lookupCredentialTyped('anthropic').reason).toBe('not_found');
  });
});
