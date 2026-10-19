// Real-filesystem assurance for the claude credential-store check: it must
// never create, rewrite or touch the file store, even when the own keychain
// item is usable and the file store is missing or stale, and even when a
// caller still passes the removed #3020 identity receipt and write seams.
// readKeychain is injected (never the real keychain); the file store is a
// throwaway temp CLAUDE_CONFIG_DIR.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureClaudeFileStoreCredential,
  type ClaudeFileStoreHealDeps,
} from '../../../../src/runtimes/agent/providers/claude-filestore-heal.ts';

const NOW = 1_783_000_000_000;
const silentLog = { info: () => {}, warn: () => {} };

function kc(expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: 'kc-token', refreshToken: 'r', expiresAt } });
}

describe('ensureClaudeFileStoreCredential - real filesystem', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wsheal-'));
    path = join(dir, '.credentials.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(over: Record<string, unknown> = {}) {
    // The removed write-path seams are passed on purpose: an old caller's
    // matching identity receipt must not bring the mirror back.
    return ensureClaudeFileStoreCredential({
      platform: 'darwin',
      env: { CLAUDE_CONFIG_DIR: dir },
      now: () => NOW,
      readKeychain: () => kc(NOW + 3_600_000),
      log: silentLog,
      expectedAccountId: 'test-expected-account',
      verifyAccountId: () => true,
      ...over,
    } as ClaudeFileStoreHealDeps);
  }

  it('never creates a file store beside a usable own item', () => {
    expect(run().outcome).toBe('skipped-cli-reads-own-item');
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never rewrites a stale file store', () => {
    const stale = JSON.stringify({ claudeAiOauth: { accessToken: 'file-token', refreshToken: 'f', expiresAt: NOW - 1 } });
    writeFileSync(path, stale, { mode: 0o600 });
    const before = statSync(path).mtimeMs;
    expect(run().outcome).toBe('two-stores-detected');
    expect(readFileSync(path, 'utf8')).toBe(stale);
    expect(statSync(path).mtimeMs).toBe(before);
    expect(readdirSync(dir)).toEqual(['.credentials.json']);
  });
});
