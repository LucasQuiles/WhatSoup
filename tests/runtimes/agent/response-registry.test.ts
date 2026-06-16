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

// The 18 classes, hand-listed so the test fails if the union grows without the
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
