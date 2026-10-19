// The claude credential-store check (claude-filestore-heal.ts) is detection
// only. With CLAUDE_CONFIG_DIR set the CLI reads the bot's own hashed keychain
// item, so a plaintext copy in the file store is a second live copy of the
// refresh token that trails every rotation; a slow keychain read makes the CLI
// fall back to that copy, post a stale refresh token and wipe the login. The
// check therefore never writes any store: it reports whether the CLI reads its
// own item, and flags (once per state change) when a file store holds a token
// beside it. Fixtures only: injected readers, no keychain, no real store.
import { describe, expect, it, vi } from 'vitest';
import {
  ensureClaudeFileStoreCredential,
  resetClaudeCredentialStoreStateForTests,
  type ClaudeFileStoreHealDeps,
} from '../../../../src/runtimes/agent/providers/claude-filestore-heal.ts';

const NOW = 1_783_000_000_000;
const ACCESS_SENTINEL = 'access-token-sentinel-3c1d';
const REFRESH_SENTINEL = 'refresh-token-sentinel-77ae';

function blob(expiresAt: number | null, token: string | null = ACCESS_SENTINEL): string {
  return JSON.stringify({
    claudeAiOauth: {
      ...(token === null ? {} : { accessToken: token }),
      refreshToken: REFRESH_SENTINEL,
      ...(expiresAt === null ? {} : { expiresAt }),
    },
  });
}

function capture() {
  const lines: Array<{ level: 'info' | 'warn'; obj: unknown; msg: string }> = [];
  return {
    lines,
    log: {
      info: (obj: unknown, msg: string) => { lines.push({ level: 'info', obj, msg }); },
      warn: (obj: unknown, msg: string) => { lines.push({ level: 'warn', obj, msg }); },
    },
  };
}

let dirSeq = 0;
function deps(over: Partial<ClaudeFileStoreHealDeps> = {}): ClaudeFileStoreHealDeps {
  dirSeq += 1;
  return {
    platform: 'darwin',
    env: { CLAUDE_CONFIG_DIR: `/tmp/wsheal-unit-${dirSeq}/.claude` },
    now: () => NOW,
    readKeychain: () => blob(NOW + 3_600_000),
    readFileStore: () => null,
    log: { info: () => {}, warn: () => {} },
    ...over,
  };
}

describe('ensureClaudeFileStoreCredential (detection only)', () => {
  it('is a no-op off darwin', () => {
    const readKeychain = vi.fn(() => blob(NOW + 60_000));
    expect(ensureClaudeFileStoreCredential(deps({ platform: 'linux', readKeychain })).outcome).toBe('skipped-not-darwin');
    expect(readKeychain).not.toHaveBeenCalled();
  });

  it('is a no-op when neither CLAUDE_CONFIG_DIR nor CLAUDE_SECURESTORAGE_CONFIG_DIR is set', () => {
    const readKeychain = vi.fn(() => blob(NOW + 60_000));
    expect(ensureClaudeFileStoreCredential(deps({ env: {}, readKeychain })).outcome).toBe('skipped-no-config-dir');
    expect(readKeychain).not.toHaveBeenCalled();
  });

  it('own item usable and no file store: the CLI reads its own item, nothing is written', () => {
    const r = ensureClaudeFileStoreCredential(deps());
    expect(r).toEqual({ outcome: 'skipped-cli-reads-own-item', keychainExpiresAt: NOW + 3_600_000, fileStoreExpiresAt: null });
  });

  it.each([
    ['missing', null],
    ['expired', blob(NOW - 1)],
    ['older than the own item', blob(NOW + 60_000)],
    ['without an access token', blob(NOW + 60_000, null)],
  ] as const)('own item usable and file store %s: still no mirror (no write seam exists)', (_label, fileStore) => {
    const r = ensureClaudeFileStoreCredential(deps({ readFileStore: () => fileStore }));
    expect(['skipped-cli-reads-own-item', 'two-stores-detected']).toContain(r.outcome);
    expect(r.outcome).not.toBe('healed');
  });

  it('own item absent: the CLI falls back to the file store on its own; nothing is written', () => {
    const r = ensureClaudeFileStoreCredential(deps({ readKeychain: () => null, readFileStore: () => blob(NOW + 60_000) }));
    expect(r.outcome).toBe('skipped-no-keychain-token');
  });

  it('own item expired counts as not usable', () => {
    const r = ensureClaudeFileStoreCredential(deps({ readKeychain: () => blob(NOW - 1) }));
    expect(r.outcome).toBe('skipped-no-keychain-token');
  });

  it('unparseable own item counts as absent', () => {
    expect(ensureClaudeFileStoreCredential(deps({ readKeychain: () => '{not json' })).outcome).toBe('skipped-no-keychain-token');
  });

  it('a reader that throws is contained (fail-open)', () => {
    const r = ensureClaudeFileStoreCredential(deps({ readKeychain: () => { throw new Error('security exploded'); } }));
    expect(r.outcome).toBe('skipped-error');
  });
});

describe('two-store detection', () => {
  it('flags a token in the file store beside a usable own item, with expiries only', () => {
    resetClaudeCredentialStoreStateForTests();
    const h = capture();
    const r = ensureClaudeFileStoreCredential(deps({ readFileStore: () => blob(NOW + 60_000), log: h.log }));
    expect(r).toEqual({ outcome: 'two-stores-detected', keychainExpiresAt: NOW + 3_600_000, fileStoreExpiresAt: NOW + 60_000 });
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]!.level).toBe('warn');
    expect(h.lines[0]!.obj).toMatchObject({
      outcome: 'two-stores-detected',
      keychainExpiresAt: NOW + 3_600_000,
      fileStoreExpiresAt: NOW + 60_000,
    });
    // Detection only: the line points at the fleet baseline and leaves the copy to the operator.
    expect(h.lines[0]!.msg).toContain('fleet baseline');
    expect(h.lines[0]!.msg).toContain('operator decision');
    expect(h.lines[0]!.msg).not.toMatch(/remove/i);
    const text = JSON.stringify(h.lines);
    expect(text).not.toContain(ACCESS_SENTINEL);
    expect(text).not.toContain(REFRESH_SENTINEL);
  });

  it('logs once per state change, not on every probe', () => {
    resetClaudeCredentialStoreStateForTests();
    const h = capture();
    const base = deps({ log: h.log });
    const twoStores = { ...base, readFileStore: () => blob(NOW + 60_000) };
    const ownOnly = { ...base, readFileStore: () => null };

    ensureClaudeFileStoreCredential(twoStores);
    ensureClaudeFileStoreCredential(twoStores);
    ensureClaudeFileStoreCredential(twoStores);
    expect(h.lines.filter((l) => l.level === 'warn')).toHaveLength(1);

    // The second store went away: one info line, then quiet again.
    ensureClaudeFileStoreCredential(ownOnly);
    ensureClaudeFileStoreCredential(ownOnly);
    expect(h.lines).toHaveLength(2);
    expect(h.lines[1]!.obj).toMatchObject({ outcome: 'skipped-cli-reads-own-item' });

    // And it came back: flagged again.
    ensureClaudeFileStoreCredential(twoStores);
    expect(h.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });

  it('a first check with only the own item logs nothing', () => {
    resetClaudeCredentialStoreStateForTests();
    const h = capture();
    ensureClaudeFileStoreCredential(deps({ log: h.log }));
    expect(h.lines).toEqual([]);
  });
});
