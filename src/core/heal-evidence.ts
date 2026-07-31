import { z } from 'zod';
import { FAULT_TAXONOMY_REGISTRY } from '../lib/fault-classifier.ts';

export const HEAL_REPORT_TYPES = ['crash', 'degraded', 'service_crash'] as const;
export type HealReportType = (typeof HEAL_REPORT_TYPES)[number];

const REGISTERED_CRASH_CAUSES = FAULT_TAXONOMY_REGISTRY.failureDomains.agentFailureClasses.values;

// These fixed SessionManager fallback categories preserve established
// single-flight separation when no provider taxonomy class is available.
// They are structural identifiers, never diagnostic text.
const STRUCTURAL_AUTOMATIC_CRASH_CAUSES = [
  'spawn_error',
  'managed_provider_error',
  'provider_turn_watchdog',
] as const;

const CRASH_CAUSES = Object.freeze([
  ...REGISTERED_CRASH_CAUSES,
  ...STRUCTURAL_AUTOMATIC_CRASH_CAUSES,
]);

const HEAL_EVIDENCE_FIXED_CAUSES = [
  'process_exit',
  'unclassified',
  'decryption_failure_threshold',
  'service_crash',
  'legacy_unclassified',
] as const;

const HEAL_EVIDENCE_CAUSES = new Set<string>([
  ...CRASH_CAUSES,
  ...HEAL_EVIDENCE_FIXED_CAUSES,
]);

const HEAL_EVIDENCE_CORRELATIONS = new Set<string>([
  ...CRASH_CAUSES.map((cause) => `heal:v1:crash:${cause}`),
  'heal:v1:crash:process_exit',
  'heal:v1:crash:unclassified',
  'heal:v1:degraded:decryption_failure_threshold',
  'heal:v1:service_crash:service_crash',
  'heal:v1:legacy_unclassified',
]);

const HEAL_EVIDENCE_ACTIONS = [
  'reauthenticate_provider',
  'check_provider_capacity',
  'check_provider_connectivity',
  'inspect_provider_configuration',
  'inspect_provider_permissions',
  'restart_or_inspect_provider',
  'investigate_crash',
  'investigate_decryption_failures',
  'investigate_service',
  'investigate_legacy_report',
] as const;

const healEvidenceCorrelationSchema = z.string().refine(
  (value) => HEAL_EVIDENCE_CORRELATIONS.has(value),
  'correlation must be a registered heal V1 value',
);

const healEvidenceCauseSchema = z.string().refine(
  (value) => HEAL_EVIDENCE_CAUSES.has(value),
  'cause must be a registered heal V1 value',
);

const healEvidenceCountsSchema = z.object({
  occurrences: z.number().int().min(1).max(1_000_000),
  affectedScopes: z.number().int().min(1).max(1_000_000).optional(),
}).strict();

const HealEvidenceV1FieldsSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.enum(HEAL_REPORT_TYPES),
  source: z.enum([
    'automatic_crash_reporter',
    'automatic_degradation_detector',
    'automatic_service_reporter',
    'legacy_unclassified',
  ]),
  cause: healEvidenceCauseSchema,
  stage: z.enum(['provider_session', 'inbound_decryption', 'service', 'unknown']),
  impact: z.enum(['single_session', 'delivery_degraded', 'service_availability', 'unknown']),
  evidenceCoverage: z.enum([
    'crash_classified',
    'exit_or_signal',
    'unclassified',
    'threshold_aggregate',
    'service_event',
    'legacy_context_rejected',
  ]),
  counts: healEvidenceCountsSchema,
  action: z.enum(HEAL_EVIDENCE_ACTIONS),
  correlation: healEvidenceCorrelationSchema,
}).strict();

export const HealEvidenceV1Schema = HealEvidenceV1FieldsSchema.superRefine((evidence, ctx) => {
  if (isValidHealEvidenceCombination(evidence)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'heal V1 fields must form a registered automatic evidence combination',
  });
});

export type HealEvidenceV1 = z.infer<typeof HealEvidenceV1Schema>;

/**
 * Closed automatic-reporter input. Raw diagnostic values do not belong to this
 * API; callers must reduce them to a registered crash class or a termination
 * category before reaching the evidence boundary.
 */
export interface AutomaticHealReportInput {
  type: HealReportType;
  crashClass?: string;
  termination?: 'exit_or_signal';
  totalFailures?: number;
  affectedScopeCount?: number;
}

const ALLOWED_CRASH_CAUSES = new Set<string>(CRASH_CAUSES);

export function allowlistedHealCrashClass(
  value: unknown,
): string | undefined {
  return typeof value === 'string' && ALLOWED_CRASH_CAUSES.has(value)
    ? value
    : undefined;
}

function boundedCount(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined) return 1;
  return Math.max(1, Math.min(value, 1_000_000));
}

function actionForCrashCause(cause: string): (typeof HEAL_EVIDENCE_ACTIONS)[number] {
  switch (cause) {
    case 'provider_auth_required':
    case 'provider_state_locked':
      return 'reauthenticate_provider';
    case 'provider_usage_limit':
    case 'provider_rate_limit':
      return 'check_provider_capacity';
    case 'provider_network_error':
    case 'provider_timeout':
      return 'check_provider_connectivity';
    case 'provider_binary_missing':
    case 'config_or_capability_missing':
      return 'inspect_provider_configuration';
    case 'provider_permission_denied':
    case 'provider_policy_block':
      return 'inspect_provider_permissions';
    case 'provider_server_error':
    case 'provider_model_unavailable':
    case 'provider_cli_crash':
    case 'provider_silent_hang':
    case 'provider_stream_corrupt':
    case 'mcp_transport_failure':
    case 'tool_handler_exception':
    case 'provider_unknown':
      return 'restart_or_inspect_provider';
    default:
      return 'investigate_crash';
  }
}

function hasSingleOccurrenceOnly(counts: {
  occurrences: number;
  affectedScopes?: number;
}): boolean {
  return counts.occurrences === 1 && counts.affectedScopes === undefined;
}

function isValidHealEvidenceCombination(evidence: z.infer<typeof HealEvidenceV1FieldsSchema>): boolean {
  if (evidence.type === 'crash') {
    const isKnownCrashCause = CRASH_CAUSES.includes(evidence.cause);
    const isExit = evidence.cause === 'process_exit';
    const isUnclassified = evidence.cause === 'unclassified';
    return (
      (isKnownCrashCause || isExit || isUnclassified)
      && evidence.source === 'automatic_crash_reporter'
      && evidence.stage === 'provider_session'
      && evidence.impact === 'single_session'
      && evidence.evidenceCoverage === (isExit ? 'exit_or_signal' : isUnclassified ? 'unclassified' : 'crash_classified')
      && hasSingleOccurrenceOnly(evidence.counts)
      && evidence.action === actionForCrashCause(evidence.cause)
      && evidence.correlation === `heal:v1:crash:${evidence.cause}`
    );
  }

  if (evidence.type === 'degraded') {
    return (
      evidence.source === 'automatic_degradation_detector'
      && evidence.cause === 'decryption_failure_threshold'
      && evidence.stage === 'inbound_decryption'
      && evidence.impact === 'delivery_degraded'
      && evidence.evidenceCoverage === 'threshold_aggregate'
      && evidence.counts.affectedScopes !== undefined
      && evidence.action === 'investigate_decryption_failures'
      && evidence.correlation === 'heal:v1:degraded:decryption_failure_threshold'
    );
  }

  if (evidence.source === 'automatic_service_reporter') {
    return (
      evidence.cause === 'service_crash'
      && evidence.stage === 'service'
      && evidence.impact === 'service_availability'
      && evidence.evidenceCoverage === 'service_event'
      && hasSingleOccurrenceOnly(evidence.counts)
      && evidence.action === 'investigate_service'
      && evidence.correlation === 'heal:v1:service_crash:service_crash'
    );
  }

  return (
    evidence.source === 'legacy_unclassified'
    && evidence.cause === 'legacy_unclassified'
    && evidence.stage === 'unknown'
    && evidence.impact === 'unknown'
    && evidence.evidenceCoverage === 'legacy_context_rejected'
    && hasSingleOccurrenceOnly(evidence.counts)
    && evidence.action === 'investigate_legacy_report'
    && evidence.correlation === 'heal:v1:legacy_unclassified'
  );
}

function crashEvidence(input: AutomaticHealReportInput): HealEvidenceV1 {
  const cause = allowlistedHealCrashClass(input.crashClass) ?? (
    input.termination === 'exit_or_signal'
      ? 'process_exit'
      : 'unclassified'
  );
  const evidenceCoverage = cause === 'process_exit'
    ? 'exit_or_signal'
    : cause === 'unclassified'
      ? 'unclassified'
      : 'crash_classified';

  return {
    schemaVersion: 1,
    type: 'crash',
    source: 'automatic_crash_reporter',
    cause,
    stage: 'provider_session',
    impact: 'single_session',
    evidenceCoverage,
    counts: { occurrences: 1 },
    action: actionForCrashCause(cause),
    correlation: `heal:v1:crash:${cause}`,
  };
}

function degradationEvidence(input: AutomaticHealReportInput): HealEvidenceV1 {
  const totalFailures = boundedCount(input.totalFailures);
  const affectedScopeCount = boundedCount(input.affectedScopeCount);
  return {
    schemaVersion: 1,
    type: 'degraded',
    source: 'automatic_degradation_detector',
    cause: 'decryption_failure_threshold',
    stage: 'inbound_decryption',
    impact: 'delivery_degraded',
    evidenceCoverage: 'threshold_aggregate',
    counts: { occurrences: totalFailures, affectedScopes: affectedScopeCount },
    action: 'investigate_decryption_failures',
    correlation: 'heal:v1:degraded:decryption_failure_threshold',
  };
}

function serviceCrashEvidence(): HealEvidenceV1 {
  return {
    schemaVersion: 1,
    type: 'service_crash',
    source: 'automatic_service_reporter',
    cause: 'service_crash',
    stage: 'service',
    impact: 'service_availability',
    evidenceCoverage: 'service_event',
    counts: { occurrences: 1 },
    action: 'investigate_service',
    correlation: 'heal:v1:service_crash:service_crash',
  };
}

export function projectAutomaticHealEvidence(input: AutomaticHealReportInput): HealEvidenceV1 {
  if (input.type === 'degraded') return degradationEvidence(input);
  if (input.type === 'service_crash') return serviceCrashEvidence();
  return crashEvidence(input);
}

export function legacyUnclassifiedHealEvidence(): HealEvidenceV1 {
  return {
    schemaVersion: 1,
    type: 'service_crash',
    source: 'legacy_unclassified',
    cause: 'legacy_unclassified',
    stage: 'unknown',
    impact: 'unknown',
    evidenceCoverage: 'legacy_context_rejected',
    counts: { occurrences: 1 },
    action: 'investigate_legacy_report',
    correlation: 'heal:v1:legacy_unclassified',
  };
}

export function parseStoredHealEvidence(raw: string | null): HealEvidenceV1 {
  if (!raw) return legacyUnclassifiedHealEvidence();
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = HealEvidenceV1Schema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Intentional: malformed legacy context is replaced with a bounded repair projection.
  }
  return legacyUnclassifiedHealEvidence();
}

export function errorClassForHealEvidence(evidence: HealEvidenceV1): string {
  return `${evidence.type}__${evidence.cause}`;
}
