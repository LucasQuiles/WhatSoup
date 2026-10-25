import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureClaudeFileStoreCredential } from '../../../../src/runtimes/agent/providers/claude-filestore-heal.ts';

const NOW = 1_783_000_000_000;
const SERVICE = ['Claude', 'Code-credentials'].join(' ');
const keychain = JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-current-token', expiresAt: NOW + 60_000 } });
const expiredFile = JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-expired-token', expiresAt: NOW - 1 } });

describe('credential-store detection never copies credentials', () => {
  let root: string;
  let configDir: string;
  let secureDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'credential-store-read-only-'));
    configDir = join(root, 'config');
    secureDir = join(root, 'secure');
    mkdirSync(configDir, { mode: 0o700 });
    mkdirSync(secureDir, { mode: 0o700 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const selector of ['config', 'secure', 'both'] as const) {
    it.each([false, true])(`${selector} selector preserves the file stores (existing=%s)`, (existing) => {
      const env = {
        HOME: root,
        ...(selector !== 'secure' ? { CLAUDE_CONFIG_DIR: configDir } : {}),
        ...(selector !== 'config' ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: secureDir } : {}),
      };
      const selectedDir = selector === 'config' ? configDir : secureDir;
      const paths = [join(configDir, '.credentials.json'), join(secureDir, '.credentials.json')];
      if (existing) for (const path of paths) writeFileSync(path, expiredFile, { mode: 0o600 });
      const before = paths.map((path) => existing ? { bytes: readFileSync(path), mode: statSync(path).mode } : null);
      const readKeychain = vi.fn(() => keychain);
      const readFileStore = vi.fn((path: string) => existsSync(path) ? readFileSync(path, 'utf8') : null);
      const log = { info: vi.fn(), warn: vi.fn() };
      // A legacy positive identity callback must not re-enable the removed writer.
      const deps = {
        platform: 'darwin' as const, env, now: () => NOW, readKeychain, readFileStore, log,
        expectedAccountDigest: `sha256:${'a'.repeat(64)}`,
        verifyAccountDigest: () => true,
      };

      const result = ensureClaudeFileStoreCredential(deps);

      for (const [index, path] of paths.entries()) {
        if (existing) {
          expect(readFileSync(path)).toEqual(before[index]!.bytes);
          expect(statSync(path).mode).toBe(before[index]!.mode);
        } else {
          expect(existsSync(path)).toBe(false);
        }
      }
      const suffix = createHash('sha256').update(selectedDir).digest('hex').slice(0, 8);
      expect(readKeychain).toHaveBeenCalledExactlyOnceWith(`${SERVICE}-${suffix}`);
      expect(readFileStore).toHaveBeenCalledExactlyOnceWith(join(selectedDir, '.credentials.json'));
      expect(result.outcome).toBe(existing ? 'two-stores-detected' : 'skipped-cli-reads-own-item');
      expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toContain('synthetic-');
    });
  }
});
