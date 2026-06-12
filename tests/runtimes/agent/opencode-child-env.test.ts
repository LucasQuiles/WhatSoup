/**
 * buildChildEnv — opencode-cli forwards the standard fleet provider keys.
 *
 * The opencode-cli branch must forward DEEPSEEK_API_KEY / MINIMAX_API_KEY
 * (resolved from the standard keychain via lookupCredential) so a session
 * launched as `opencode run -m minimax/...` or `deepseek/...` can authenticate.
 * Other providers must NOT receive these keys (per-provider credential
 * isolation — the security rationale documented on buildChildEnv).
 *
 * lookupCredential is mocked at the module boundary so the test is
 * deterministic regardless of what the host machine's real keychain holds
 * (the live fleet machine genuinely has deepseek/minimax entries, which would
 * otherwise contaminate the "absent" assertions).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const lookupCredentialMock = vi.fn<(service: string) => string | null>();

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

import { buildChildEnv } from '../../../src/runtimes/agent/session.ts';

function hasKey(env: Record<string, string | undefined>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

describe('buildChildEnv — opencode-cli standard fleet keys', () => {
  beforeEach(() => {
    lookupCredentialMock.mockReset();
  });

  it('forwards DEEPSEEK_API_KEY and MINIMAX_API_KEY when the keyring resolves them', () => {
    lookupCredentialMock.mockImplementation((service: string) => {
      if (service === 'deepseek') return 'ds-secret-123';
      if (service === 'minimax') return 'mm-secret-456';
      return null;
    });

    const env = buildChildEnv('opencode-cli');
    expect(env.DEEPSEEK_API_KEY).toBe('ds-secret-123');
    expect(env.MINIMAX_API_KEY).toBe('mm-secret-456');
  });

  it('omits DEEPSEEK_API_KEY/MINIMAX_API_KEY when the keyring resolves nothing', () => {
    lookupCredentialMock.mockReturnValue(null);

    const env = buildChildEnv('opencode-cli');
    expect(hasKey(env, 'DEEPSEEK_API_KEY')).toBe(false);
    expect(hasKey(env, 'MINIMAX_API_KEY')).toBe(false);
  });

  it('does NOT forward deepseek/minimax keys to a non-opencode provider (codex-cli)', () => {
    lookupCredentialMock.mockImplementation((service: string) => {
      if (service === 'deepseek') return 'ds-secret-123';
      if (service === 'minimax') return 'mm-secret-456';
      return null;
    });

    const env = buildChildEnv('codex-cli');
    expect(hasKey(env, 'DEEPSEEK_API_KEY')).toBe(false);
    expect(hasKey(env, 'MINIMAX_API_KEY')).toBe(false);
    // codex-cli never consults the keyring for these services.
    expect(lookupCredentialMock).not.toHaveBeenCalledWith('deepseek');
  });
});
