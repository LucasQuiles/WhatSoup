import { describe, it, expect } from 'vitest';
import {
  resolveProviderCredentialState,
  isProviderRoutable,
  providerCredentialDisplayReason,
  spawnFailureCredentialNote,
} from '../../src/lib/provider-credential-eligibility.ts';
import type { ClaudeOAuthCredResult } from '../../src/lib/model-advisor.ts';

const deps = (over: Partial<{ lookup: () => string | null; oauth: () => ClaudeOAuthCredResult }> = {}) => ({
  lookup: () => null as string | null,
  oauth: () => ({ status: 'absent' as const }),
  ...over,
});

describe('resolveProviderCredentialState', () => {
  it('keyring providers: present when the looked-up value is usable, absent otherwise', () => {
    expect(resolveProviderCredentialState({ provider: 'openai-api' }, deps({ lookup: () => 'sk-x' }))).toBe('present-valid');
    expect(resolveProviderCredentialState({ provider: 'openai-api' }, deps())).toBe('absent');
    expect(resolveProviderCredentialState({ provider: 'anthropic-api' }, deps({ lookup: () => 'sk-ant' }))).toBe('present-valid');
    // reuses classifyCredentialValue: an empty/whitespace value is not usable
    expect(resolveProviderCredentialState({ provider: 'openai-api' }, deps({ lookup: () => '   ' }))).toBe('absent');
  });

  it('claude-cli: OAuth valid → present-valid', () => {
    expect(resolveProviderCredentialState({ provider: 'claude-cli' }, deps({ oauth: () => ({ status: 'present', token: 't' }) }))).toBe('present-valid');
  });

  it('claude-cli: expired WITH refresh → present-expired-refreshable (invariant 3: routable)', () => {
    expect(resolveProviderCredentialState({ provider: 'claude-cli' }, deps({ oauth: () => ({ status: 'expired', hasRefreshToken: true }) }))).toBe('present-expired-refreshable');
  });

  it('claude-cli: expired NO refresh → expired-no-refresh (not routable)', () => {
    expect(resolveProviderCredentialState({ provider: 'claude-cli' }, deps({ oauth: () => ({ status: 'expired', hasRefreshToken: false }) }))).toBe('expired-no-refresh');
  });

  it('claude-cli: absent OAuth → absent', () => {
    expect(resolveProviderCredentialState({ provider: 'claude-cli' }, deps())).toBe('absent');
  });

  it('codex-cli / gemini-cli: native subscription auth → native (fail-open, routable in slice 1)', () => {
    expect(resolveProviderCredentialState({ provider: 'codex-cli' }, deps())).toBe('native');
    expect(resolveProviderCredentialState({ provider: 'gemini-cli' }, deps())).toBe('native');
  });

  it('DEFAULT ARM (Q round 21c): an UNKNOWN future null-service provider fails open to native, not ineligible', () => {
    // A hypothetical 7th provider with no keyring service must NOT silently become
    // ineligible. The null-service branch returns 'native' for ANY such provider,
    // so this pins the DEFAULT arm — not the two known names — against a future
    // provider someone forgets to enroll.
    expect(resolveProviderCredentialState({ provider: 'some-future-cli' }, deps())).toBe('native');
    expect(isProviderRoutable('native')).toBe(true);
  });
});

describe('projections (invariant 4: one state, two projections)', () => {
  it('isProviderRoutable: valid, expired-refreshable, and native route; the rest do not', () => {
    expect(isProviderRoutable('present-valid')).toBe(true);
    expect(isProviderRoutable('present-expired-refreshable')).toBe(true);
    expect(isProviderRoutable('native')).toBe(true);
    expect(isProviderRoutable('expired-no-refresh')).toBe(false);
    expect(isProviderRoutable('absent')).toBe(false);
    expect(isProviderRoutable('rejected')).toBe(false);
  });

  it('providerCredentialDisplayReason: terminal reason for non-routable states, null for routable', () => {
    expect(providerCredentialDisplayReason('absent')).toMatch(/no credential/i);
    expect(providerCredentialDisplayReason('expired-no-refresh')).toMatch(/expired/i);
    expect(providerCredentialDisplayReason('rejected')).toMatch(/rejected/i);
    expect(providerCredentialDisplayReason('present-valid')).toBeNull();
    expect(providerCredentialDisplayReason('present-expired-refreshable')).toBeNull();
    expect(providerCredentialDisplayReason('native')).toBeNull();
  });
});

describe('spawnFailureCredentialNote (eligible-side disclosure — HEDGE, Q round 27)', () => {
  it('present-expired-refreshable → a HEDGED note that states the observed and does NOT assert the cause', () => {
    const note = spawnFailureCredentialNote('present-expired-refreshable');
    expect(note).not.toBeNull();
    // OBSERVED: sign-in expired + a refresh was expected. Pin the hedge, not a
    // confident cause — the failure site can't prove the refresh was the cause.
    expect(note).toMatch(/expired/i);
    expect(note).toMatch(/likely|try re-authenticating/i);
    // must NOT assert the unproven cause
    expect(note).not.toMatch(/refresh failed/i);
  });

  it('every other state → null (caller keeps its generic failure message)', () => {
    for (const s of ['present-valid', 'expired-no-refresh', 'absent', 'rejected', 'native'] as const) {
      expect(spawnFailureCredentialNote(s)).toBeNull();
    }
  });
});

describe('blast radius (Slice 1 obligation): F07 does not OVER-exclude', () => {
  it('with credentials present, no provider flips from the old presence-only verdict', () => {
    // Old isEntryCredentialed: null-service → true (always). New: claude-cli uses OAuth,
    // codex/gemini stay native→true. So with creds present, nothing goes ineligible.
    const providers = ['openai-api', 'anthropic-api', 'opencode-cli', 'claude-cli', 'codex-cli', 'gemini-cli'];
    const flips = providers.filter(
      (p) => !isProviderRoutable(resolveProviderCredentialState({ provider: p, model: 'x/y' }, { lookup: () => 'k', oauth: () => ({ status: 'present', token: 't' }) })),
    );
    expect(flips).toEqual([]);
  });
});
