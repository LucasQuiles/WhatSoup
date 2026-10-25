import { describe, expect, it, vi } from 'vitest';
import {
  ensureClaudeFileStoreCredentialForExpectedAccount,
} from '../../../../src/runtimes/agent/providers/claude-filestore-heal-identity.ts';
import type { ClaudeFileStoreHealDeps } from '../../../../src/runtimes/agent/providers/claude-filestore-heal.ts';
import type { AccountIdentityVerification } from '../../../../src/runtimes/agent/providers/claude-account-identity.ts';

const EXPECTED = `sha256:${'a'.repeat(64)}`;
const NOW = 1_783_000_000_000;

function verification(status: AccountIdentityVerification['status']): AccountIdentityVerification {
  return {
    status,
    reason: status === 'unverifiable' ? 'not-logged-in' : null,
    expectedDigestPrefix: 'aaaaaaaaaaaa',
    observedDigestPrefix: status === 'match' ? 'aaaaaaaaaaaa' : null,
    checkedAt: NOW,
  };
}

function deps(writeFileStore = vi.fn()): ClaudeFileStoreHealDeps {
  return {
    platform: 'darwin',
    env: { CLAUDE_CONFIG_DIR: '/tmp/expected-account/.claude' },
    now: () => NOW,
    readKeychain: () => JSON.stringify({ claudeAiOauth: { accessToken: 'token', expiresAt: NOW + 60_000 } }),
    readFileStore: () => null,
    writeFileStore,
    log: { info: () => {}, warn: () => {} },
  };
}

describe('ensureClaudeFileStoreCredentialForExpectedAccount', () => {
  it('refuses a credential copy when no ratified digest is configured', async () => {
    const writeFileStore = vi.fn();
    const observeNativeIdentity = vi.fn(async () => verification('match'));

    await expect(ensureClaudeFileStoreCredentialForExpectedAccount({
      expectedAccountDigest: null,
      healDeps: deps(writeFileStore),
      observeNativeIdentity,
    })).resolves.toMatchObject({ outcome: 'refused-no-expected-identity' });

    expect(observeNativeIdentity).not.toHaveBeenCalled();
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('copies only after a matching native-store identity verdict', async () => {
    const writeFileStore = vi.fn();
    const observeNativeIdentity = vi.fn(async () => verification('match'));

    await expect(ensureClaudeFileStoreCredentialForExpectedAccount({
      expectedAccountDigest: EXPECTED,
      env: { CLAUDE_CONFIG_DIR: '/tmp/expected-account/.claude', HOME: '/tmp/native-home' },
      healDeps: deps(writeFileStore),
      observeNativeIdentity,
    })).resolves.toMatchObject({ outcome: 'healed' });

    expect(observeNativeIdentity).toHaveBeenCalledWith(
      EXPECTED,
      expect.not.objectContaining({ CLAUDE_CONFIG_DIR: expect.anything() }),
      undefined,
    );
    expect(writeFileStore).toHaveBeenCalledOnce();
  });

  it('passes the digest through the digest receipt fields, never the account-id fields', async () => {
    const heal = vi.fn<NonNullable<Parameters<typeof ensureClaudeFileStoreCredentialForExpectedAccount>[0]['heal']>>(
      () => ({ outcome: 'skipped-file-store-current' as const }),
    );

    await ensureClaudeFileStoreCredentialForExpectedAccount({
      expectedAccountDigest: EXPECTED,
      heal,
      healDeps: deps(),
      observeNativeIdentity: async () => verification('match'),
    });

    const receipt = heal.mock.calls[0]?.[0];
    expect(receipt?.expectedAccountDigest).toBe(EXPECTED);
    expect(receipt?.verifyAccountDigest).toEqual(expect.any(Function));
    expect(receipt).not.toHaveProperty('expectedAccountId');
    expect(receipt).not.toHaveProperty('verifyAccountId');
  });

  it.each(['mismatch', 'unverifiable'] as const)('refuses a %s native-store identity verdict', async (status) => {
    const writeFileStore = vi.fn();

    await expect(ensureClaudeFileStoreCredentialForExpectedAccount({
      expectedAccountDigest: EXPECTED,
      healDeps: deps(writeFileStore),
      observeNativeIdentity: async () => verification(status),
    })).resolves.toMatchObject({
      outcome: status === 'mismatch' ? 'refused-identity-mismatch' : 'refused-identity-unverifiable',
    });

    expect(writeFileStore).not.toHaveBeenCalled();
  });
});
