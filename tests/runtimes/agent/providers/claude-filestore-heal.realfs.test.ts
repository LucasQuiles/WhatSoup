// Real-filesystem assurance for the claude credential-store check: it must
// never create, rewrite or touch the file store, even when the own keychain
// item is usable and the file store is missing or stale, and even when a
// caller still passes the removed #3020 identity receipt and write seams.
// readKeychain is injected (never the real keychain); the file store is a
// throwaway temp CLAUDE_CONFIG_DIR.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'wsheal-')));
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

  it.each(['oversize', 'file-mode', 'parent-mode', 'symlink', 'hard-link'])(
    'reports an unreadable %s store without accepting or changing it', (kind) => {
      const content = kind === 'oversize'
        ? JSON.stringify({ ...JSON.parse(kc(NOW + 60_000)), padding: 'x'.repeat(1024 * 1024) })
        : kc(NOW + 60_000);
      writeFileSync(path, content, { mode: 0o600 });
      if (kind === 'file-mode') chmodSync(path, 0o644);
      else if (kind === 'parent-mode') chmodSync(dir, 0o755);
      else if (kind === 'hard-link') linkSync(path, join(dir, 'second-link'));
      else if (kind === 'symlink') {
        const target = join(dir, 'target');
        renameSync(path, target);
        symlinkSync(target, path);
      }
      expect(run().outcome).toBe('skipped-error');
      expect(readFileSync(path, 'utf8')).toBe(content);
    },
  );

  it('refuses a symlink ancestor of the selected store', () => {
    writeFileSync(path, kc(NOW + 60_000), { mode: 0o600 });
    const alias = join(dir, 'alias');
    symlinkSync(dir, alias, 'dir');
    expect(run({ env: { CLAUDE_CONFIG_DIR: alias } }).outcome).toBe('skipped-error');
    expect(readFileSync(path, 'utf8')).toBe(kc(NOW + 60_000));
  });

  it('refuses a FIFO without waiting for a writer', () => {
    execFileSync('mkfifo', [path], { timeout: 2000 });
    const moduleUrl = pathToFileURL(resolve('src/runtimes/agent/providers/claude-filestore-heal.ts')).href;
    const code = [
      'const [moduleUrl, configDir, now, keychain] = process.argv.slice(1);',
      'const { ensureClaudeFileStoreCredential } = await import(moduleUrl);',
      'console.log(JSON.stringify(ensureClaudeFileStoreCredential({',
      "platform: 'darwin', env: { CLAUDE_CONFIG_DIR: configDir },",
      'now: () => Number(now), readKeychain: () => keychain,',
      'log: { info() {}, warn() {} },',
      '})));',
    ].join('\n');
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types', '--input-type=module', '-e', code,
      moduleUrl, dir, String(NOW), kc(NOW + 60_000),
    ], {
      env: { ...process.env, VITEST: '1' }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ outcome: 'skipped-error' });
    expect(statSync(path).isFIFO()).toBe(true);
  });

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
