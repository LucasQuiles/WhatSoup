import { describe, expect, it, vi } from 'vitest';
import {
  ensureClaudeFileStoreCredential,
  type ClaudeFileStoreHealDeps,
} from '../../../../src/runtimes/agent/providers/claude-filestore-heal.ts';

const NOW = 1_783_000_000_000;
const silentLog = { info: () => {}, warn: () => {} };

function oauth(expiresAt: number | null, token = 'tok'): Record<string, unknown> {
  return { accessToken: token, refreshToken: 'r', ...(expiresAt === null ? {} : { expiresAt }) };
}

function baseDeps(over: Partial<ClaudeFileStoreHealDeps> = {}): ClaudeFileStoreHealDeps {
  return {
    platform: 'darwin',
    env: { CLAUDE_CONFIG_DIR: '/tmp/wsheal/.claude' },
    now: () => NOW,
    readKeychain: () => JSON.stringify({ mcpOAuth: { k: 1 }, claudeAiOauth: oauth(NOW + 60_000) }),
    readFileStore: () => null,
    writeFileStore: vi.fn(),
    log: silentLog,
    ...over,
  };
}

describe('ensureClaudeFileStoreCredential', () => {
  it('no-ops off darwin', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({ platform: 'linux', writeFileStore }));
    expect(r.outcome).toBe('skipped-not-darwin');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('no-ops when CLAUDE_CONFIG_DIR is unset', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({ env: {}, writeFileStore }));
    expect(r.outcome).toBe('skipped-no-config-dir');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('no-ops when the keychain has no token', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({ readKeychain: () => null, writeFileStore }));
    expect(r.outcome).toBe('skipped-no-keychain-token');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('does not heal from an already-expired keychain token', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readKeychain: () => JSON.stringify({ claudeAiOauth: oauth(NOW - 1) }),
      writeFileStore,
    }));
    expect(r.outcome).toBe('skipped-no-keychain-token');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('heals when the file store is missing the claude token, preserving other keys', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readFileStore: () => JSON.stringify({ mcpOAuth: { keep: true } }),
      writeFileStore,
    }));
    expect(r.outcome).toBe('healed');
    expect(writeFileStore).toHaveBeenCalledTimes(1);
    const [path, data] = writeFileStore.mock.calls[0];
    expect(path).toBe('/tmp/wsheal/.claude/.credentials.json');
    const written = JSON.parse(data);
    expect(written.mcpOAuth).toEqual({ keep: true });          // preserved
    expect(written.claudeAiOauth.accessToken).toBe('tok');      // healed from keychain
    expect(written.claudeAiOauth.expiresAt).toBe(NOW + 60_000);
  });

  it('heals when the file-store token is expired', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readFileStore: () => JSON.stringify({ claudeAiOauth: oauth(NOW - 10_000, 'old') }),
      writeFileStore,
    }));
    expect(r.outcome).toBe('healed');
    expect(JSON.parse(writeFileStore.mock.calls[0][1]).claudeAiOauth.accessToken).toBe('tok');
  });

  it('heals when the keychain token is strictly newer', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readKeychain: () => JSON.stringify({ claudeAiOauth: oauth(NOW + 120_000, 'new') }),
      readFileStore: () => JSON.stringify({ claudeAiOauth: oauth(NOW + 60_000, 'cur') }),
      writeFileStore,
    }));
    expect(r.outcome).toBe('healed');
    expect(JSON.parse(writeFileStore.mock.calls[0][1]).claudeAiOauth.accessToken).toBe('new');
  });

  it('does NOT downgrade a fresher file-store token', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readKeychain: () => JSON.stringify({ claudeAiOauth: oauth(NOW + 30_000, 'kc') }),
      readFileStore: () => JSON.stringify({ claudeAiOauth: oauth(NOW + 90_000, 'fresher') }),
      writeFileStore,
    }));
    expect(r.outcome).toBe('skipped-file-store-current');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('is fail-open: a throwing write returns skipped-error and does not throw', () => {
    const r = ensureClaudeFileStoreCredential(baseDeps({
      writeFileStore: () => { throw new Error('disk full'); },
    }));
    expect(r.outcome).toBe('skipped-error');
  });

  it('is fail-open on malformed keychain JSON', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({ readKeychain: () => '{not json', writeFileStore }));
    expect(r.outcome).toBe('skipped-no-keychain-token');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('treats an empty-string keychain accessToken as no token (no false heal)', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readKeychain: () => JSON.stringify({ claudeAiOauth: { accessToken: '', expiresAt: NOW + 60_000 } }),
      writeFileStore,
    }));
    expect(r.outcome).toBe('skipped-no-keychain-token');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('treats a non-object keychain claudeAiOauth as no token', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readKeychain: () => JSON.stringify({ claudeAiOauth: 'oops-a-string' }),
      writeFileStore,
    }));
    expect(r.outcome).toBe('skipped-no-keychain-token');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('treats expiresAt exactly equal to now as expired (boundary, no resurrection)', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readKeychain: () => JSON.stringify({ claudeAiOauth: oauth(NOW) }),
      writeFileStore,
    }));
    expect(r.outcome).toBe('skipped-no-keychain-token');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('heals a missing file token even when the keychain token has no recorded expiry', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readKeychain: () => JSON.stringify({ claudeAiOauth: oauth(null, 'no-exp') }),
      readFileStore: () => null,
      writeFileStore,
    }));
    expect(r.outcome).toBe('healed');
    expect(JSON.parse(writeFileStore.mock.calls[0][1]).claudeAiOauth.accessToken).toBe('no-exp');
  });

  it('does NOT downgrade when neither token records an expiry (cannot prove keychain newer)', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readKeychain: () => JSON.stringify({ claudeAiOauth: oauth(null, 'kc') }),
      readFileStore: () => JSON.stringify({ claudeAiOauth: oauth(null, 'disk') }),
      writeFileStore,
    }));
    expect(r.outcome).toBe('skipped-file-store-current');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('is fail-open when readFileStore itself throws', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(baseDeps({
      readFileStore: () => { throw new Error('EACCES'); },
      writeFileStore,
    }));
    expect(r.outcome).toBe('skipped-error');
    expect(writeFileStore).not.toHaveBeenCalled();
  });
});
