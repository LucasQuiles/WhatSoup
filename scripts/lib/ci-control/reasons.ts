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
  { schemaVersion: 1, code: 'ci.hooks.pass', guidanceKind: 'none', defaultOutcome: 'pass' },
  { schemaVersion: 1, code: 'ci.hooks.path-foreign', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.path-absolute', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.path-escaping', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.path-missing', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.path-disabled', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.input-invalid', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.source-missing', guidanceKind: 'source-correction', defaultOutcome: 'block' },
  { schemaVersion: 1, code: 'ci.hooks.source-invalid', guidanceKind: 'source-correction', defaultOutcome: 'block' },
  { schemaVersion: 1, code: 'ci.hooks.installed-missing', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.installed-symlink', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.installed-type-invalid', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.installed-unexpected', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.installed-hardlink', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.installed-identity-changed', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.installed-mode-mismatch', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.installed-bytes-mismatch', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.head-moved', guidanceKind: 'evidence-recovery', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.hooks.evidence-unavailable', guidanceKind: 'evidence-recovery', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.refs.pass', guidanceKind: 'none', defaultOutcome: 'pass' },
  { schemaVersion: 1, code: 'ci.refs.input-malformed', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.refs.input-budget', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.refs.input-duplicate', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.refs.remote-identity-unavailable', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.refs.remote-policy-prohibited', guidanceKind: 'source-correction', defaultOutcome: 'block' },
  { schemaVersion: 1, code: 'ci.refs.policy-unknown', guidanceKind: 'evidence-recovery', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.refs.graph-unavailable', guidanceKind: 'evidence-recovery', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.refs.delete-prohibited', guidanceKind: 'source-correction', defaultOutcome: 'block' },
  { schemaVersion: 1, code: 'ci.refs.force-update-prohibited', guidanceKind: 'source-correction', defaultOutcome: 'block' },
  { schemaVersion: 1, code: 'ci.refs.object-type-prohibited', guidanceKind: 'source-correction', defaultOutcome: 'block' },
  { schemaVersion: 1, code: 'ci.refs.local-source-unbound', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.refs.object-format-unsupported', guidanceKind: 'precondition-correction', defaultOutcome: 'inconclusive' },
  { schemaVersion: 1, code: 'ci.refs.private-binding-unavailable', guidanceKind: 'evidence-recovery', defaultOutcome: 'inconclusive' },
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
