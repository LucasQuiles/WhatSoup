/**
 * Response-workflow registry (SSOT for *what to do* about a failure).
 *
 * `failure-taxonomy.ts` answers "what kind of failure is this?" (classification).
 * This module answers "what response workflow does that failure trigger?" — the
 * diagnostics to run, the fallback policy, the retry policy, and the user-facing
 * message template. Call-sites read a {@link ResponseWorkflow} instead of
 * hand-rolling activate→diagnostics→replay→notify branches.
 *
 * The table is pure data keyed on the 19-class {@link AgentFailureClass} (the
 * superset that also covers CLI crash / timeout / network / stream-corrupt,
 * which the provider-text path never sees). The provider-text path bridges in
 * via {@link workflowForProviderText}.
 *
 * BEHAVIOR-PRESERVING: seed values reproduce today's runtime behavior. Two
 * eligibility SSOTs in `failure-taxonomy.ts` govern arming and disagree by
 * design — the registry gates each class against whichever path invokes it:
 *  - classes with a `providerKind` (reached via {@link classifyProviderFailure}
 *    on terminal result text) gate against {@link providerFailureArmsFallback};
 *  - classes with `providerKind === null` (reached only via
 *    {@link classifyAgentFailure}) gate against
 *    {@link isFallbackEligibleForFailureClass} under best-case policy.
 * {@link assertRegistryConsistency} enforces both at module load.
 */

import {
  classifyProviderFailure,
  isFallbackEligibleForFailureClass,
  providerFailureArmsFallback,
  type AgentFailureClass,
  type ProviderFailureKind,
} from './failure-taxonomy.ts';

/** Diagnostic probes the {@link runDiagnosticBundle} orchestrator can run. */
export type DiagnosticId =
  | 'health-snapshot'
  | 'usage-limit-reset-parse'
  | 'primary-model-usability'
  | 'primary-recovery-probe'
  | 'account-auth-status';

/** How the dispatcher should treat the interrupted turn after a failure. */
export type RetryPolicy =
  | 'none'
  | 'replay-on-standin'
  | 'kill-and-respawn';

/** Deterministic user-message templates (rendered by the message composer). */
export type UserTemplateId =
  | 'usage-limit'
  | 'rate-limit'
  | 'auth-required'
  | 'model-unavailable'
  | 'context-overflow'
  | 'transient'
  | 'no-fallback'
  | 'credentials-missing'
  | 'exhausted'
  | 'tool-activity-blocked'
  | 'none';

export interface FallbackPolicy {
  /**
   * Whether this class can arm a fallback window. The capability flag, not the
   * runtime decision — the dispatcher still re-checks
   * {@link isFallbackEligibleForFailureClass} with the live failure-domain /
   * context-window policy before arming (so e.g. context-overflow only arms
   * against a larger backup window).
   */
  arms: boolean;
  /** auth-required must skip same-provider entries (re-auth needs an independent provider). */
  requireIndependentProvider: boolean;
  /** Whether the stand-in should be seeded with rehydrated conversation context. */
  carriesContextHandoff: boolean;
  /**
   * Whether arming marks the active fallback entry failed first
   * (`activateProviderFallbackAfterTerminalResult`) vs activating directly
   * (`activateProviderFallback`). Preserves the model-unavailable split at
   * runtime.ts (~4951).
   */
  markActiveEntryFailedOnTrigger: boolean;
}

export interface ResponseWorkflow {
  errorClass: AgentFailureClass;
  /** The provider-text kind this class bridges from, or null for class-only failures. */
  providerKind: ProviderFailureKind | null;
  diagnostics: readonly DiagnosticId[];
  fallback: FallbackPolicy;
  retry: RetryPolicy;
  userTemplate: UserTemplateId;
  /** Whether the raw provider text is suppressed from chat (never forwarded as normal output). */
  suppressRawProviderText: boolean;
}

/**
 * Structured result of {@link runDiagnosticBundle}. Declared here in the SSOT
 * so the diagnostic-bundle producer and the `renderUserMessage` consumer share
 * one concrete type — removing the cross-stage contract risk. Confidence reuses
 * the alert-outbox vocabulary.
 */
export type DiagnosticConfidence = 'suspected' | 'probable' | 'confirmed';

export interface DiagnosticFinding {
  id: DiagnosticId;
  ok: boolean;
  confidence: DiagnosticConfidence;
  /** Already-redacted one-line summary. */
  summary: string;
  data?: Record<string, unknown>;
}

export interface DiagnosticBundle {
  errorClass: AgentFailureClass;
  providerKind: ProviderFailureKind | null;
  findings: DiagnosticFinding[];
  /** Parsed usage-limit reset time, when known. */
  resetAt: number | null;
  collectedAt: number;
}

const DIAG_TRANSIENT: readonly DiagnosticId[] = ['health-snapshot'];
const DIAG_RATE: readonly DiagnosticId[] = ['health-snapshot', 'primary-recovery-probe'];
const DIAG_USAGE: readonly DiagnosticId[] = [
  'usage-limit-reset-parse',
  'health-snapshot',
  'account-auth-status',
  'primary-recovery-probe',
];
const DIAG_AUTH: readonly DiagnosticId[] = [
  'health-snapshot',
  'account-auth-status',
  'primary-recovery-probe',
];
const DIAG_MODEL: readonly DiagnosticId[] = ['health-snapshot', 'account-auth-status'];
const DIAG_NONE: readonly DiagnosticId[] = [];

/** A non-arming, no-op response (internal/config failures that produce no user message). */
function inertWorkflow(
  errorClass: AgentFailureClass,
  providerKind: ProviderFailureKind | null = null,
): ResponseWorkflow {
  return {
    errorClass,
    providerKind,
    diagnostics: DIAG_NONE,
    fallback: {
      arms: false,
      requireIndependentProvider: false,
      carriesContextHandoff: false,
      markActiveEntryFailedOnTrigger: false,
    },
    retry: 'none',
    userTemplate: 'none',
    suppressRawProviderText: false,
  };
}

/** A class-path transient failure that can fail over to an independent backup. */
function transientWorkflow(
  errorClass: AgentFailureClass,
  diagnostics: readonly DiagnosticId[] = DIAG_TRANSIENT,
  suppressRawProviderText = false,
): ResponseWorkflow {
  return {
    errorClass,
    providerKind: null,
    diagnostics,
    fallback: {
      arms: true,
      requireIndependentProvider: false,
      carriesContextHandoff: true,
      markActiveEntryFailedOnTrigger: true,
    },
    retry: 'replay-on-standin',
    userTemplate: 'transient',
    suppressRawProviderText,
  };
}

/**
 * The registry. Typed as a total `Record<AgentFailureClass, …>` so a new class
 * added to the union without an entry is a COMPILE error, not a runtime
 * surprise. {@link assertRegistryConsistency} adds the runtime arms-consistency
 * and exhaustiveness guards at module load.
 */
export const RESPONSE_WORKFLOWS: Record<AgentFailureClass, ResponseWorkflow> = {
  provider_usage_limit: {
    errorClass: 'provider_usage_limit',
    providerKind: 'usage-limit',
    diagnostics: DIAG_USAGE,
    fallback: {
      arms: true,
      requireIndependentProvider: false,
      carriesContextHandoff: true,
      markActiveEntryFailedOnTrigger: true,
    },
    retry: 'replay-on-standin',
    userTemplate: 'usage-limit',
    suppressRawProviderText: true,
  },
  provider_rate_limit: {
    errorClass: 'provider_rate_limit',
    providerKind: 'rate-limit',
    diagnostics: DIAG_RATE,
    fallback: {
      arms: true,
      requireIndependentProvider: false,
      carriesContextHandoff: true,
      markActiveEntryFailedOnTrigger: true,
    },
    retry: 'replay-on-standin',
    userTemplate: 'rate-limit',
    suppressRawProviderText: true,
  },
  provider_auth_required: {
    errorClass: 'provider_auth_required',
    providerKind: 'auth-required',
    diagnostics: DIAG_AUTH,
    fallback: {
      arms: true,
      requireIndependentProvider: true,
      carriesContextHandoff: true,
      markActiveEntryFailedOnTrigger: true,
    },
    retry: 'replay-on-standin',
    userTemplate: 'auth-required',
    suppressRawProviderText: true,
  },
  provider_model_unavailable: {
    errorClass: 'provider_model_unavailable',
    providerKind: 'model-unavailable',
    diagnostics: DIAG_MODEL,
    fallback: {
      arms: true,
      requireIndependentProvider: false,
      // Direct activation (activateProviderFallback), not the mark-failed path —
      // preserves the runtime.ts (~4951) model-unavailable split.
      carriesContextHandoff: true,
      markActiveEntryFailedOnTrigger: false,
    },
    retry: 'replay-on-standin',
    userTemplate: 'model-unavailable',
    suppressRawProviderText: true,
  },
  // Provider-text classes that do NOT arm fallback today: suppressed + session
  // killed (kill-and-respawn). providerFailureArmsFallback() is false for both.
  provider_context_overflow: {
    errorClass: 'provider_context_overflow',
    providerKind: 'context-overflow',
    diagnostics: DIAG_NONE,
    fallback: {
      arms: false,
      requireIndependentProvider: false,
      carriesContextHandoff: false,
      markActiveEntryFailedOnTrigger: false,
    },
    retry: 'kill-and-respawn',
    // Both runtime result handlers emit a deterministic context-limit notice
    // before respawning ("Context limit reached — starting fresh session…"),
    // so this class DOES surface a user message (unlike policy-block).
    userTemplate: 'context-overflow',
    suppressRawProviderText: true,
  },
  provider_policy_block: {
    errorClass: 'provider_policy_block',
    providerKind: 'policy-block',
    diagnostics: DIAG_NONE,
    fallback: {
      arms: false,
      requireIndependentProvider: false,
      carriesContextHandoff: false,
      markActiveEntryFailedOnTrigger: false,
    },
    retry: 'kill-and-respawn',
    userTemplate: 'none',
    suppressRawProviderText: true,
  },
  // Class-only failures (providerKind null). Arming follows
  // isFallbackEligibleForFailureClass(class, {independent, larger}).
  provider_server_error: transientWorkflow('provider_server_error', DIAG_TRANSIENT, true),
  provider_cli_crash: transientWorkflow('provider_cli_crash'),
  provider_timeout: transientWorkflow('provider_timeout', DIAG_RATE, true),
  provider_network_error: transientWorkflow('provider_network_error'),
  provider_silent_hang: transientWorkflow('provider_silent_hang', DIAG_RATE),
  provider_stream_corrupt: transientWorkflow('provider_stream_corrupt'),
  // Non-arming class-only failures: no fallback, no diagnostics, no user message.
  provider_binary_missing: inertWorkflow('provider_binary_missing'),
  provider_permission_denied: inertWorkflow('provider_permission_denied'),
  provider_state_locked: inertWorkflow('provider_state_locked'),
  mcp_transport_failure: inertWorkflow('mcp_transport_failure'),
  tool_handler_exception: inertWorkflow('tool_handler_exception'),
  config_or_capability_missing: inertWorkflow('config_or_capability_missing'),
  provider_unknown: inertWorkflow('provider_unknown'),
};

/** Every failure class, derived from the registry keys (single source for iteration). */
export const ALL_AGENT_FAILURE_CLASSES = Object.keys(RESPONSE_WORKFLOWS) as AgentFailureClass[];

/** The response workflow for a classified failure. */
export function workflowFor(errorClass: AgentFailureClass): ResponseWorkflow {
  return RESPONSE_WORKFLOWS[errorClass];
}

/**
 * Bridge for the provider-text path: classify terminal result text, then map to
 * the workflow for the matching class. Returns null when the text is not a
 * recognized provider failure (caller falls through to normal handling).
 */
export function workflowForProviderText(text: string): ResponseWorkflow | null {
  const kind = classifyProviderFailure(text);
  if (kind === null) return null;
  return RESPONSE_WORKFLOWS[providerKindToClass(kind)];
}

/** Map a {@link ProviderFailureKind} to its {@link AgentFailureClass}. */
export function providerKindToClass(kind: ProviderFailureKind): AgentFailureClass {
  switch (kind) {
    case 'usage-limit':
      return 'provider_usage_limit';
    case 'rate-limit':
      return 'provider_rate_limit';
    case 'auth-required':
      return 'provider_auth_required';
    case 'model-unavailable':
      return 'provider_model_unavailable';
    case 'policy-block':
      return 'provider_policy_block';
    case 'context-overflow':
      return 'provider_context_overflow';
    case 'server-error':
      return 'provider_server_error';
    case 'transient-network':
      return 'provider_network_error';
  }
}

/**
 * Boot-time integrity guard. Fails fast (at module load) rather than silently in
 * prod if the registry drifts from the taxonomy SSOTs:
 *  - exhaustiveness: every key is a real class and `errorClass` self-matches;
 *  - arms-consistency: each class's `fallback.arms` matches the eligibility SSOT
 *    that governs its invocation path (text-path vs class-path).
 * Throws on any inconsistency.
 */
export function assertRegistryConsistency(): void {
  for (const cls of ALL_AGENT_FAILURE_CLASSES) {
    const wf = RESPONSE_WORKFLOWS[cls];
    if (wf.errorClass !== cls) {
      throw new Error(`response-registry: key ${cls} maps to errorClass ${wf.errorClass}`);
    }
    const expectedArms = wf.providerKind !== null
      ? providerFailureArmsFallback(wf.providerKind)
      : isFallbackEligibleForFailureClass(cls, {
          failureDomain: 'independent',
          contextWindow: 'larger',
        });
    if (wf.fallback.arms !== expectedArms) {
      throw new Error(
        `response-registry: ${cls} fallback.arms=${wf.fallback.arms} disagrees with`
        + ` eligibility SSOT (${expectedArms}); update the registry or the gate.`,
      );
    }
    // A workflow that does not arm must not advertise a context handoff or a
    // mark-active-entry-failed trigger (both are arming-only behaviors).
    if (!wf.fallback.arms && (wf.fallback.carriesContextHandoff || wf.fallback.markActiveEntryFailedOnTrigger)) {
      throw new Error(`response-registry: ${cls} is non-arming but advertises arming-only fallback flags`);
    }
  }
}

assertRegistryConsistency();
