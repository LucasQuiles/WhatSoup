export type GuidanceKind =
  | 'source-correction'
  | 'precondition-correction'
  | 'infrastructure-retry'
  | 'evidence-recovery'
  | 'approval-required'
  | 'escalation'
  | 'none';

export interface ReasonDefinitionV1 {
  schemaVersion: 1;
  code: string;
  guidanceKind: GuidanceKind;
  defaultOutcome: 'pass' | 'warn' | 'block' | 'inconclusive' | 'not-applicable';
}

const REASONS = [
  { schemaVersion: 1, code: 'ci.check.passed', guidanceKind: 'none', defaultOutcome: 'pass' },
  { schemaVersion: 1, code: 'ci.classification.not-applicable', guidanceKind: 'none', defaultOutcome: 'not-applicable' },
  { schemaVersion: 1, code: 'ci.required-check.missing', guidanceKind: 'evidence-recovery', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.required-check.warning-only', guidanceKind: 'source-correction', defaultOutcome: 'warn' },
  { schemaVersion: 1, code: 'ci.required-check.tuple-mismatch', guidanceKind: 'escalation', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.input.precondition-unproven', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.execution.attempt-inconclusive', guidanceKind: 'evidence-recovery', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.execution.stale-receipt', guidanceKind: 'evidence-recovery', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.execution.invalid-receipt', guidanceKind: 'evidence-recovery', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.native.receipt-unavailable', guidanceKind: 'evidence-recovery', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.native.semantic-quality', guidanceKind: 'source-correction', defaultOutcome: 'block' },
  { schemaVersion: 1, code: 'ci.native.boundary-run', guidanceKind: 'source-correction', defaultOutcome: 'block' },
] as const satisfies readonly ReasonDefinitionV1[];

export const REGISTERED_REASON_CODES = new Set<string>(REASONS.map(({ code }) => code));
const REASON_BY_CODE = new Map<string, ReasonDefinitionV1>(REASONS.map((reason) => [reason.code, reason]));

export const REGISTERED_LIMITATION_CODES = new Set([
  'ci.native.cause-code-unavailable',
  'ci.native.evidence-unavailable',
  'ci.native.progress-only',
]);

export function isRegisteredReason(code: unknown): code is string {
  return typeof code === 'string' && REGISTERED_REASON_CODES.has(code);
}

export function reasonDefinition(code: unknown): ReasonDefinitionV1 | null {
  return typeof code === 'string' ? REASON_BY_CODE.get(code) ?? null : null;
}

export function isRegisteredLimitationCode(code: unknown): code is string {
  return typeof code === 'string' && REGISTERED_LIMITATION_CODES.has(code);
}
