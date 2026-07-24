import { describe, expect, it } from 'vitest';

import {
  classifyProviderFailure,
  isFallbackEligibleForFailureClass,
  providerFailureArmsFallback,
  type AgentFailureClass,
  type ProviderFailureKind,
} from '../../../src/runtimes/agent/failure-taxonomy.ts';
import {
  ALL_AGENT_FAILURE_CLASSES,
  RESPONSE_WORKFLOWS,
  assertRegistryConsistency,
  providerKindToClass,
  workflowFor,
  workflowForProviderText,
} from '../../../src/runtimes/agent/response-registry.ts';

// The 19 classes, hand-listed so the test fails if the union grows without the
// registry (and ALL_AGENT_FAILURE_CLASSES) keeping up.
const EXPECTED_CLASSES: AgentFailureClass[] = [
  'provider_usage_limit',
  'provider_rate_limit',
  'provider_server_error',
  'provider_context_overflow',
  'provider_model_unavailable',
  'provider_policy_block',
  'provider_cli_crash',
  'provider_timeout',
  'provider_network_error',
  'provider_silent_hang',
  'provider_stream_corrupt',
  'provider_auth_required',
  'provider_binary_missing',
  'provider_permission_denied',
  'provider_state_locked',
  'mcp_transport_failure',
  'tool_handler_exception',
  'config_or_capability_missing',
  'provider_unknown',
];

const ALL_PROVIDER_KINDS: ProviderFailureKind[] = [
  'usage-limit',
  'rate-limit',
  'auth-required',
  'model-unavailable',
  'policy-block',
  'context-overflow',
];

describe('response-registry exhaustiveness', () => {
  it('has exactly one workflow per failure class and no extras', () => {
    expect(new Set(ALL_AGENT_FAILURE_CLASSES)).toEqual(new Set(EXPECTED_CLASSES));
    expect(ALL_AGENT_FAILURE_CLASSES).toHaveLength(EXPECTED_CLASSES.length);
  });

  it('keys self-match their errorClass field', () => {
    for (const cls of ALL_AGENT_FAILURE_CLASSES) {
      expect(workflowFor(cls).errorClass).toBe(cls);
    }
  });

  it('boot-time consistency guard does not throw', () => {
    expect(() => assertRegistryConsistency()).not.toThrow();
  });
});

describe('response-registry arms-consistency vs taxonomy SSOTs', () => {
  it('text-path classes arm exactly when providerFailureArmsFallback says so', () => {
    for (const cls of ALL_AGENT_FAILURE_CLASSES) {
      const wf = workflowFor(cls);
      if (wf.providerKind === null) continue;
      expect(wf.fallback.arms).toBe(providerFailureArmsFallback(wf.providerKind));
    }
  });

  it('class-only failures arm exactly when isFallbackEligibleForFailureClass says so', () => {
    for (const cls of ALL_AGENT_FAILURE_CLASSES) {
      const wf = workflowFor(cls);
      if (wf.providerKind !== null) continue;
      expect(wf.fallback.arms).toBe(
        isFallbackEligibleForFailureClass(cls, {
          failureDomain: 'independent',
          contextWindow: 'larger',
        }),
      );
    }
  });

  it('never advertises arming-only fallback flags on a non-arming class', () => {
    for (const cls of ALL_AGENT_FAILURE_CLASSES) {
      const wf = workflowFor(cls);
      if (wf.fallback.arms) continue;
      expect(wf.fallback.carriesContextHandoff).toBe(false);
      expect(wf.fallback.markActiveEntryFailedOnTrigger).toBe(false);
    }
  });

  it('only runs diagnostics on arming classes', () => {
    for (const cls of ALL_AGENT_FAILURE_CLASSES) {
      const wf = workflowFor(cls);
      if (!wf.fallback.arms) {
        expect(wf.diagnostics).toHaveLength(0);
      }
    }
  });
});

describe('response-registry provider-text bridge', () => {
  it('providerKindToClass round-trips back to the same kind', () => {
    for (const kind of ALL_PROVIDER_KINDS) {
      expect(workflowFor(providerKindToClass(kind)).providerKind).toBe(kind);
    }
  });

  it('workflowForProviderText agrees with classifyProviderFailure', () => {
    const corpus = [
      "You're out of extra usage. Claude will be available at 8pm.",
      '_Rate limited - please wait a moment and try again._',
      'Not logged in — please run /login.',
      'The selected model may not exist or you may not have access.',
      'This request violates our usage policy.',
      'Prompt is too long: maximum context length exceeded.',
      'just a normal assistant reply with no error',
    ];
    for (const text of corpus) {
      const kind = classifyProviderFailure(text);
      const wf = workflowForProviderText(text);
      if (kind === null) {
        expect(wf).toBeNull();
      } else {
        expect(wf).not.toBeNull();
        expect(wf!.providerKind).toBe(kind);
        expect(wf!.errorClass).toBe(providerKindToClass(kind));
      }
    }
  });

  // Masking-gap guard: ALL_PROVIDER_KINDS above deliberately omits 'server-error'
  // and 'transient-network' because their workflow classes (provider_server_error
  // / provider_network_error) carry providerKind=null, so they do NOT satisfy the
  // round-trip identity workflowFor(class).providerKind === kind. That null is the
  // exact signal the runtime dispatcher (dispatchProviderFailureResult) must key
  // on to fall through to the legacy handling — a non-null wf with a null
  // providerKind otherwise produced a silent no-op. These assertions lock the
  // null mapping (and the class identity) so the gap cannot silently reopen.
  it('server-error and transient-network map to null-providerKind classes (dispatch fall-through signal)', () => {
    const NULL_KIND_TEXT_KINDS: ProviderFailureKind[] = ['server-error', 'transient-network'];
    for (const kind of NULL_KIND_TEXT_KINDS) {
      const cls = providerKindToClass(kind);
      const wf = workflowFor(cls);
      expect(wf.errorClass).toBe(cls);
      // The class-only workflow does NOT echo the provider-text kind: this null is
      // what handleProviderFailureResult / dispatchProviderFailureResult must treat
      // as "fall through to legacy", not "handled".
      expect(wf.providerKind).toBeNull();
    }
    expect(providerKindToClass('server-error')).toBe('provider_server_error');
    expect(providerKindToClass('transient-network')).toBe('provider_network_error');
  });

  it('workflowForProviderText resolves server-error and transient-network texts to non-null class-only workflows', () => {
    const cases: Array<{ text: string; cls: AgentFailureClass; kind: ProviderFailureKind }> = [
      { text: 'API Error 503: Service temporarily unavailable. overloaded_error', cls: 'provider_server_error', kind: 'server-error' },
      { text: 'API Error: The socket connection was closed unexpectedly.', cls: 'provider_network_error', kind: 'transient-network' },
    ];
    for (const { text, cls, kind } of cases) {
      expect(classifyProviderFailure(text)).toBe(kind);
      const wf = workflowForProviderText(text);
      expect(wf).not.toBeNull();
      expect(wf!.errorClass).toBe(cls);
      // Non-null workflow + null providerKind is precisely the combination that
      // tripped the silent no-op in dispatchProviderFailureResult.
      expect(wf!.providerKind).toBeNull();
    }
  });
});

describe('response-registry behavior-preserving seed values', () => {
  it('usage-limit arms, suppresses text, replays, and runs account diagnostics', () => {
    const wf = RESPONSE_WORKFLOWS.provider_usage_limit;
    expect(wf.fallback.arms).toBe(true);
    expect(wf.fallback.markActiveEntryFailedOnTrigger).toBe(true);
    expect(wf.suppressRawProviderText).toBe(true);
    expect(wf.retry).toBe('replay-on-standin');
    expect(wf.diagnostics).toContain('account-auth-status');
    expect(wf.userTemplate).toBe('usage-limit');
  });

  it('auth-required requires an independent provider', () => {
    expect(RESPONSE_WORKFLOWS.provider_auth_required.fallback.requireIndependentProvider).toBe(true);
  });

  it('model-unavailable arms via direct activation (not mark-failed)', () => {
    const wf = RESPONSE_WORKFLOWS.provider_model_unavailable;
    expect(wf.fallback.arms).toBe(true);
    expect(wf.fallback.markActiveEntryFailedOnTrigger).toBe(false);
  });

  it('context-overflow and policy-block kill-and-respawn without arming', () => {
    for (const wf of [RESPONSE_WORKFLOWS.provider_context_overflow, RESPONSE_WORKFLOWS.provider_policy_block]) {
      expect(wf.fallback.arms).toBe(false);
      expect(wf.retry).toBe('kill-and-respawn');
      expect(wf.suppressRawProviderText).toBe(true);
    }
  });

  it('context-overflow surfaces a notice; policy-block stays silent', () => {
    // Both runtime result handlers enqueue a context-limit notice for overflow,
    // but emit nothing user-facing for a policy block.
    expect(RESPONSE_WORKFLOWS.provider_context_overflow.userTemplate).toBe('context-overflow');
    expect(RESPONSE_WORKFLOWS.provider_policy_block.userTemplate).toBe('none');
  });

  it('internal/config failures are inert (no arm, no retry, no diagnostics, no message)', () => {
    for (const cls of ['provider_binary_missing', 'mcp_transport_failure', 'tool_handler_exception', 'config_or_capability_missing', 'provider_unknown'] as const) {
      const wf = RESPONSE_WORKFLOWS[cls];
      expect(wf.fallback.arms).toBe(false);
      expect(wf.retry).toBe('none');
      expect(wf.diagnostics).toHaveLength(0);
      expect(wf.userTemplate).toBe('none');
    }
  });
});

describe('response-registry residual-branch coverage', () => {
  // The three throw branches of assertRegistryConsistency (lines 348, 357,
  // and 365 in src/runtimes/agent/response-registry.ts) are reached only when
  // the registry drifts from the taxonomy SSOTs. The existing tests above
  // cover the "happy" arms; this block mutates the imported RESPONSE_WORKFLOWS
  // object, asserts the throw, and restores in try/finally so a failed
  // assertion does not leak the mutation into subsequent tests.

  it("throws when a registry key's errorClass field does not self-match", () => {
    const target = RESPONSE_WORKFLOWS.provider_usage_limit;
    const original = target.errorClass;
    target.errorClass = 'provider_rate_limit';
    try {
      expect(() => assertRegistryConsistency()).toThrow(
        /response-registry: key provider_usage_limit maps to errorClass provider_rate_limit/,
      );
    } finally {
      target.errorClass = original;
    }
  });

  it('throws when fallback.arms disagrees with providerFailureArmsFallback (providerKind path)', () => {
    const target = RESPONSE_WORKFLOWS.provider_context_overflow;
    const original = target.fallback.arms;
    // provider_context_overflow is non-arming by spec; flipping arms=true
    // forces a mismatch with providerFailureArmsFallback('context-overflow').
    target.fallback.arms = true;
    try {
      expect(() => assertRegistryConsistency()).toThrow(
        /provider_context_overflow fallback\.arms=true disagrees with eligibility SSOT \(false\); update the registry or the gate\./,
      );
    } finally {
      target.fallback.arms = original;
    }
  });

  it('throws when fallback.arms disagrees with isFallbackEligibleForFailureClass (class-only path)', () => {
    const target = RESPONSE_WORKFLOWS.provider_binary_missing;
    const original = target.fallback.arms;
    // provider_binary_missing is a class-only non-arming failure; flipping
    // arms=true forces a mismatch with isFallbackEligibleForFailureClass.
    target.fallback.arms = true;
    try {
      expect(() => assertRegistryConsistency()).toThrow(
        /provider_binary_missing fallback\.arms=true disagrees with eligibility SSOT \(false\); update the registry or the gate\./,
      );
    } finally {
      target.fallback.arms = original;
    }
  });

  it('throws when a non-arming class advertises carriesContextHandoff', () => {
    const target = RESPONSE_WORKFLOWS.provider_policy_block;
    const original = target.fallback.carriesContextHandoff;
    target.fallback.carriesContextHandoff = true;
    try {
      expect(() => assertRegistryConsistency()).toThrow(
        /response-registry: provider_policy_block is non-arming but advertises arming-only fallback flags/,
      );
    } finally {
      target.fallback.carriesContextHandoff = original;
    }
  });

  it('throws when a non-arming class advertises markActiveEntryFailedOnTrigger', () => {
    const target = RESPONSE_WORKFLOWS.provider_policy_block;
    const original = target.fallback.markActiveEntryFailedOnTrigger;
    target.fallback.markActiveEntryFailedOnTrigger = true;
    try {
      expect(() => assertRegistryConsistency()).toThrow(
        /response-registry: provider_policy_block is non-arming but advertises arming-only fallback flags/,
      );
    } finally {
      target.fallback.markActiveEntryFailedOnTrigger = original;
    }
  });

  it('prior mutations were restored: assertRegistryConsistency passes again', () => {
    // Cleanup invariant: every test in this describe block restores the
    // field it mutated in its finally clause. If any of them leaked a
    // mutation, this call would throw. Captures the outcome as a value so
    // the assertion is concrete (not a lone not-toThrow).
    let result: 'ok' | string = 'unset';
    try {
      assertRegistryConsistency();
      result = 'ok';
    } catch (e) {
      result = e instanceof Error ? e.message : String(e);
    }
    expect(result).toBe('ok');
  });
});
