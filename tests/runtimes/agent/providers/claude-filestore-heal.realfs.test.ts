// Real-filesystem stress/assurance tests for the claude file-store heal.
//
// The unit suite (claude-filestore-heal.test.ts) injects readFileStore /
// writeFileStore, so the ACTUAL disk paths (defaultWriteFileStore's atomic
// tmp+rename+chmod, defaultReadFileStore, mode 0o600/0o700, merge-on-disk,
// idempotency across repeated runs) are only exercised here. We still inject
// readKeychain (never touch the real login keychain in tests) but let the real
// fs I/O run against a throwaway temp CLAUDE_CONFIG_DIR.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureClaudeFileStoreCredential } from '../../../../src/runtimes/agent/providers/claude-filestore-heal.ts';

const NOW = 1_783_000_000_000;
const silentLog = { info: () => {}, warn: () => {} };

function kc(expiresAt: number | null, token = 'kc-token', extra: Record<string, unknown> = {}) {
  return JSON.stringify({ mcpOAuth: { srv: 'x' }, claudeAiOauth: { accessToken: token, refreshToken: 'r', ...(expiresAt === null ? {} : { expiresAt }), ...extra } });
}

describe('ensureClaudeFileStoreCredential — real filesystem', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wsheal-'));
    path = join(dir, '.credentials.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(readKeychain: () => string | null, over: Record<string, unknown> = {}) {
    return ensureClaudeFileStoreCredential({
      platform: 'darwin',
      env: { CLAUDE_CONFIG_DIR: dir },
      now: () => NOW,
      readKeychain,
      log: silentLog,
      ...over,
    });
  }

  it('writes a real, valid, parseable file store when absent (0o600, dir 0o700)', () => {
    const r = run(() => kc(NOW + 60_000));
    expect(r.outcome).toBe('healed');
    expect(existsSync(path)).toBe(true);

    const written = JSON.parse(readFileSync(path, 'utf8'));       // must be valid JSON (no partial write)
    expect(written.claudeAiOauth.accessToken).toBe('kc-token');
    expect(written.mcpOAuth).toEqual({ srv: 'x' });               // keychain mcpOAuth carried in on fresh file
    expect(statSync(path).mode & 0o777).toBe(0o600);              // file perms
    expect(statSync(dir).mode & 0o777).toBe(0o700);               // dir perms
  });

  it('preserves an existing file-store mcpOAuth and unrelated keys when healing claudeAiOauth', () => {
    writeFileSync(path, JSON.stringify({ mcpOAuth: { keep: 'me' }, somethingElse: 42 }), { mode: 0o600 });
    const r = run(() => kc(NOW + 60_000));
    expect(r.outcome).toBe('healed');
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.mcpOAuth).toEqual({ keep: 'me' });             // existing file store wins for other keys
    expect(written.somethingElse).toBe(42);                       // unrelated key untouched
    expect(written.claudeAiOauth.accessToken).toBe('kc-token');   // claude token healed
  });

  it('is idempotent: repeated runs write exactly once, then no-op', () => {
    const first = run(() => kc(NOW + 60_000));
    expect(first.outcome).toBe('healed');
    const bytes1 = readFileSync(path);
    const mtime1 = statSync(path).mtimeMs;

    for (let i = 0; i < 5; i++) {
      const again = run(() => kc(NOW + 60_000));
      expect(again.outcome).toBe('skipped-file-store-current');   // no further heal
    }
    expect(readFileSync(path).equals(bytes1)).toBe(true);         // byte-identical
    expect(statSync(path).mtimeMs).toBe(mtime1);                  // never rewritten
  });

  it('heals a real on-disk malformed (non-JSON) file store', () => {
    writeFileSync(path, 'this is not json {{{', { mode: 0o600 });
    const r = run(() => kc(NOW + 60_000));
    expect(r.outcome).toBe('healed');
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.claudeAiOauth.accessToken).toBe('kc-token');
  });

  it('does NOT downgrade a real fresher on-disk token (no-op, bytes preserved)', () => {
    const fresh = JSON.stringify({ claudeAiOauth: { accessToken: 'disk-fresh', expiresAt: NOW + 90_000 } });
    writeFileSync(path, fresh, { mode: 0o600 });
    const before = readFileSync(path);
    const r = run(() => kc(NOW + 30_000, 'kc-older'));
    expect(r.outcome).toBe('skipped-file-store-current');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('re-heals a real expired on-disk token', () => {
    writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 'disk-dead', expiresAt: NOW - 10_000 } }), { mode: 0o600 });
    const r = run(() => kc(NOW + 60_000, 'kc-live'));
    expect(r.outcome).toBe('healed');
    expect(JSON.parse(readFileSync(path, 'utf8')).claudeAiOauth.accessToken).toBe('kc-live');
  });

  it('does not create or write a file when the keychain has no usable token', () => {
    const r = run(() => null);
    expect(r.outcome).toBe('skipped-no-keychain-token');
    expect(existsSync(path)).toBe(false);                          // nothing written
  });

  it('leaves no stray .tmp artifacts after a heal', () => {
    run(() => kc(NOW + 60_000));
    const stray = readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(stray).toEqual([]);
  });
});
