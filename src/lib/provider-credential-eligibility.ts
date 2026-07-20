/**
 * Per-provider credential eligibility — the canonical fine-grained accessor
 * (Slice 1, C-A of the credential-driven model catalogue).
 *
 * Eligibility (F07 routing) and display read this via two projections
 * (`isProviderRoutable` / `providerCredentialDisplayReason`) — invariant 4:
 * one credential state, different projections, never a second independent
 * computation. Composes the existing credential-state.ts primitives
 * (`classifyCredentialValue`) and provider-key-service — does NOT reimplement
 * keyring/expiry classification.
 */
import { resolveProviderKeyService } from './provider-key-service.ts';
import { lookupCredential } from './keyring.ts';
import { resolveClaudeOAuthCred, type ClaudeOAuthCredResult } from './model-advisor.ts';
import { classifyCredentialValue } from './credential-state.ts';

export type ProviderCredentialState =
  | 'present-valid'
  | 'present-expired-refreshable'
  | 'expired-no-refresh'
  | 'absent'
  | 'rejected'
  // codex-cli / gemini-cli (and any future null-service provider): subscription/
  // login auth with no keyring service. Real validity is discovered at spawn
  // (invariant 3 — never presumed), so slice 1 fails OPEN to routable.
  | 'native';

export interface ProviderCredentialDeps {
  lookup?: (service: string) => string | null;
  oauth?: () => ClaudeOAuthCredResult;
}

/**
 * The per-provider credential verdict. claude-cli reads its OAuth cred (expired
 * WITH a refresh token is refreshable → routable); keyring providers classify
 * their looked-up value through the shared `classifyCredentialValue`; providers
 * with no keyring service (codex/gemini/unknown) are `native` (fail-open).
 */
export function resolveProviderCredentialState(
  input: { provider: string; model?: string; providerConfig?: unknown },
  deps: ProviderCredentialDeps = {},
): ProviderCredentialState {
  if (input.provider === 'claude-cli') {
    const cred = (deps.oauth ?? resolveClaudeOAuthCred)();
    if (cred.status === 'present') return 'present-valid';
    if (cred.status === 'expired') return cred.hasRefreshToken ? 'present-expired-refreshable' : 'expired-no-refresh';
    return 'absent';
  }
  const service = resolveProviderKeyService(input.provider, input.model, input.providerConfig);
  if (service === null) return 'native'; // default arm: any null-service provider fails open
  const value = (deps.lookup ?? lookupCredential)(service);
  return classifyCredentialValue(value) === 'ok' ? 'present-valid' : 'absent';
}

/**
 * Eligibility projection (F07): a state is routable when a spawn can proceed —
 * valid, expired-but-refreshable (the CLI refreshes at spawn), or native
 * (validity discovered at spawn). `expired-no-refresh` / `absent` / `rejected`
 * are not routable.
 */
export function isProviderRoutable(state: ProviderCredentialState): boolean {
  return state === 'present-valid' || state === 'present-expired-refreshable' || state === 'native';
}

/**
 * Display projection: a terminal, self-sufficient reason for a NON-routable
 * state (invariant 11 — disclosures on the turn they happen), else null.
 */
export function providerCredentialDisplayReason(state: ProviderCredentialState): string | null {
  switch (state) {
    case 'absent':
      return 'no credential configured';
    case 'expired-no-refresh':
      return 'credential expired (no refresh token)';
    case 'rejected':
      return 'credential rejected';
    default:
      return null;
  }
}

/**
 * The ELIGIBLE-side disclosure note for a turn/spawn FAILURE (the common config:
 * a primary routed on an `present-expired-refreshable` credential — routable
 * because a refresh was expected — that then failed at turn). Returns a HEDGED
 * note, or null to keep the caller's generic failure message.
 *
 * HEDGE, do NOT assert (Q round 27): at the failure site the caller knows the
 * route-time classification and that the turn failed — NOT that the failure was
 * the refresh. A 500, a network drop, or model-not-found on an aging-but-fine
 * credential would all be mislabeled if this said "refresh failed", sending the
 * user to re-auth for a problem re-auth won't fix. So state the observed and
 * hedge the cause. Only `present-expired-refreshable` warrants the note; every
 * other state (including `expired-no-refresh`, which is not routable and so is
 * not the primary's story here) returns null → generic message.
 */
export function spawnFailureCredentialNote(state: ProviderCredentialState): string | null {
  if (state !== 'present-expired-refreshable') return null;
  return (
    "I couldn't start a session. Your sign-in looks expired (a refresh was expected), " +
    'so that is the likely cause — try re-authenticating if this keeps happening.'
  );
}
