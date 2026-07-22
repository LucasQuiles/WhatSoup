export type GuidanceKind =
  | 'source-correction'
  | 'precondition-correction'
  | 'infrastructure-retry'
  | 'evidence-recovery'
  | 'approval-required'
  | 'escalation'
  | 'none';

export type ReasonLifecycle = 'active' | 'deprecated' | 'superseded';
export type EvidenceConfidence = 'proven' | 'inconclusive' | 'proposed';
export type ReasonSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type RetryClass =
  | 'never'
  | 'after-source-change'
  | 'after-precondition-repair'
  | 'after-transient-condition'
  | 'after-lineage-reconciliation'
  | 'after-evidence-regeneration'
  | 'after-rebase-or-merge-refresh'
  | 'after-approval'
  | 'manual-recovery';
export type RemediationClass =
  | 'source-patch'
  | 'workflow-policy-change'
  | 'environment-setup'
  | 'exact-revision-rerun'
  | 'lineage-reconciliation'
  | 'artifact-quarantine'
  | 'rollback'
  | 'hosted-settings-change'
  | 'owner-decision'
  | 'exception-renewal'
  | 'control-retirement';

export interface WarningPolicyV1 {
  owner: string;
  remediationSlaHours: number;
  expiresAfterHours: number;
  escalationCondition: string;
  successorCode: string;
}

export interface ReasonDefinitionV2 {
  schemaVersion: 2;
  code: string;
  metadataState: 'complete' | 'legacy-partial';
  implementationState: 'implemented' | 'planned';
  lifecycle: ReasonLifecycle;
  supersededBy: string | null;
  guidanceKind: GuidanceKind;
  defaultOutcome: 'pass' | 'warn' | 'block' | 'inconclusive' | 'not-applicable';
  defaultSeverity: ReasonSeverity;
  applicableStages: readonly string[];
  confidenceRequired: EvidenceConfidence;
  retryClass: RetryClass;
  remediationClass: RemediationClass;
  requiredIdentityBindings: readonly string[];
  canonicalOwner: string;
  publicDisclosure: 'sanitized';
  messageTemplate: Readonly<{ summary: string; guidance: readonly string[] }>;
  fixtures: Readonly<{ unsafe: string; safeNeighbor: string; unavailableEvidence: string }>;
  warningPolicy: Readonly<WarningPolicyV1> | null;
}

interface ReasonInput {
  code: string;
  outcome: ReasonDefinitionV2['defaultOutcome'];
  guidanceKind: GuidanceKind;
  lifecycle?: ReasonLifecycle;
  supersededBy?: string | null;
  severity?: ReasonSeverity;
  retryClass?: RetryClass;
  remediationClass?: RemediationClass;
  canonicalOwner?: string;
  warningPolicy?: WarningPolicyV1 | null;
  applicableStages?: readonly string[];
  requiredIdentityBindings?: readonly string[];
  messageTemplate?: Readonly<{ summary: string; guidance: readonly string[] }>;
  fixtures?: Readonly<{ unsafe: string; safeNeighbor: string; unavailableEvidence: string }>;
  metadataState?: ReasonDefinitionV2['metadataState'];
  implementationState?: ReasonDefinitionV2['implementationState'];
}

function ownerFor(code: string): string {
  if (code.startsWith('ci.hooks.')) return 'ci.hooks.owner';
  if (code.startsWith('ci.refs.')) return 'outgoing-ref-policy-decision-owner';
  if (code.includes('classification')) return 'ci.classifier.owner';
  if (code.startsWith('ci.native.')) return 'ci.native-adapter.owner';
  if (code.startsWith('integrity.')) return 'ci.integrity.owner';
  if (code.startsWith('execution.')) return 'ci.execution.owner';
  if (code.startsWith('evidence.')) return 'ci.evidence.owner';
  if (code.startsWith('workflow.')) return 'ci.workflow.owner';
  if (code.startsWith('migration.')) return 'ci.migration.owner';
  return 'ci.evidence.owner';
}

const ALL_EXECUTION_STAGES = ['local', 'pre-commit', 'pre-push', 'pull-request', 'merge-group', 'release', 'deployment', 'scheduled'] as const;

function stagesFor(code: string): readonly string[] {
  if (code.startsWith('ci.hooks.')) return ['local', 'pre-commit', 'pre-push'];
  if (code.startsWith('ci.refs.')) return ['pre-push'];
  if (code.includes('classification')) return ['local', 'pre-push', 'pull-request', 'merge-group'];
  if (code.startsWith('ci.required-check.') || code.startsWith('workflow.result.')) return ['pull-request', 'merge-group', 'default-branch', 'release', 'deployment'];
  if (code.startsWith('ci.native.')) return ['local', 'pre-push', 'pull-request', 'merge-group'];
  if (code.startsWith('migration.')) return ['pull-request', 'default-branch', 'scheduled'];
  return ALL_EXECUTION_STAGES;
}

function bindingsFor(code: string): readonly string[] {
  const bindings = ['candidateOid', 'policyDigest'];
  if (code.startsWith('integrity.') || code.startsWith('execution.') || code.startsWith('evidence.')) bindings.push('toolDigest', 'attemptDigest');
  if (code.startsWith('workflow.') || code.startsWith('migration.')) bindings.push('manifestDigest', 'toolDigest');
  return bindings;
}

function humanizeCode(code: string): string {
  const words = code.split(/[.-]/u).filter(Boolean);
  const sentence = words.join(' ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function guidanceFor(guidanceKind: GuidanceKind): readonly string[] {
  switch (guidanceKind) {
    case 'source-correction': return ['Repair the canonical source or policy owner, preserve the adjacent safe behavior, and do not disable the control.'];
    case 'precondition-correction': return ['Repair the named precondition, then regenerate evidence for the same exact revision before changing product source.'];
    case 'infrastructure-retry': return ['Retry only after the registered transient condition clears and retain the original attempt evidence.'];
    case 'evidence-recovery': return ['Regenerate complete terminal evidence for the exact revision; do not substitute progress, stale, or partial output.'];
    case 'approval-required': return ['Obtain the registered role approval for the exact bounded scope before continuing.'];
    case 'escalation': return ['Stop mutation, reconcile the changed identity or authority, and replay only the invalidated dependency closure.'];
    case 'none': return ['No remediation is required; retain the exact evidence binding.'];
  }
}

function fixturesFor(code: string, outcome: ReasonDefinitionV2['defaultOutcome']): Readonly<{ unsafe: string; safeNeighbor: string; unavailableEvidence: string }> {
  if (outcome === 'pass') {
    return {
      unsafe: `Required evidence is incomplete, so ${code} must not be emitted.`,
      safeNeighbor: `Complete exact-bound evidence emits ${code}.`,
      unavailableEvidence: `A required identity is unavailable, so ${code} must not be emitted.`,
    };
  }
  if (outcome === 'not-applicable') {
    return {
      unsafe: `A caller claims ${code} without a trusted classifier reason.`,
      safeNeighbor: `A trusted classifier receipt supplies the closed reason for ${code}.`,
      unavailableEvidence: `Classifier evidence is unavailable, so ${code} cannot be emitted.`,
    };
  }
  return {
    unsafe: `The canonical owner receives a synthetic input that produces ${code}.`,
    safeNeighbor: `An adjacent synthetic input avoids ${code} without disabling or bypassing the control.`,
    unavailableEvidence: `A required input for ${code} is unavailable or malformed and cannot be treated as pass.`,
  };
}

function defaultRetry(outcome: ReasonDefinitionV2['defaultOutcome'], guidanceKind: GuidanceKind): RetryClass {
  if (outcome === 'pass' || outcome === 'not-applicable') return 'never';
  if (outcome === 'block' || outcome === 'warn') return 'after-source-change';
  if (guidanceKind === 'precondition-correction') return 'after-precondition-repair';
  if (guidanceKind === 'approval-required') return 'after-approval';
  if (guidanceKind === 'escalation') return 'after-lineage-reconciliation';
  if (guidanceKind === 'infrastructure-retry') return 'after-transient-condition';
  return 'after-evidence-regeneration';
}

function defaultRemediation(guidanceKind: GuidanceKind): RemediationClass {
  if (guidanceKind === 'precondition-correction') return 'environment-setup';
  if (guidanceKind === 'evidence-recovery') return 'exact-revision-rerun';
  if (guidanceKind === 'approval-required') return 'owner-decision';
  if (guidanceKind === 'escalation') return 'lineage-reconciliation';
  return 'source-patch';
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function defineReason(input: ReasonInput): ReasonDefinitionV2 {
  const metadataState = input.metadataState ?? 'legacy-partial';
  const complete = metadataState === 'complete';
  const definition: ReasonDefinitionV2 = {
    schemaVersion: 2,
    code: input.code,
    metadataState,
    implementationState: input.implementationState ?? 'implemented',
    lifecycle: input.lifecycle ?? 'active',
    supersededBy: input.supersededBy ?? null,
    guidanceKind: input.guidanceKind,
    defaultOutcome: input.outcome,
    defaultSeverity: input.severity ?? (input.outcome === 'block' ? 'high' : input.outcome === 'inconclusive' ? 'medium' : input.outcome === 'warn' ? 'medium' : 'info'),
    applicableStages: complete ? input.applicableStages ?? stagesFor(input.code) : [],
    confidenceRequired: input.outcome === 'inconclusive' ? 'inconclusive' : 'proven',
    retryClass: input.retryClass ?? defaultRetry(input.outcome, input.guidanceKind),
    remediationClass: input.remediationClass ?? defaultRemediation(input.guidanceKind),
    requiredIdentityBindings: complete ? input.requiredIdentityBindings ?? bindingsFor(input.code) : [],
    canonicalOwner: complete ? input.canonicalOwner ?? ownerFor(input.code) : 'legacy-metadata-unmigrated',
    publicDisclosure: 'sanitized',
    messageTemplate: complete
      ? input.messageTemplate ?? { summary: humanizeCode(input.code), guidance: guidanceFor(input.guidanceKind) }
      : { summary: 'Legacy compatibility metadata is incomplete and non-authoritative.', guidance: ['Use the canonical native owner until a reviewed taxonomy migration is implemented.'] },
    fixtures: complete
      ? input.fixtures ?? fixturesFor(input.code, input.outcome)
      : { unsafe: 'not-admitted:unsafe', safeNeighbor: 'not-admitted:safe-neighbor', unavailableEvidence: 'not-admitted:unavailable-evidence' },
    warningPolicy: complete ? input.warningPolicy ?? null : null,
  };
  return deepFreeze(definition) as ReasonDefinitionV2;
}

const REASONS = deepFreeze([
  defineReason({
    code: 'ci.check.passed', outcome: 'pass', guidanceKind: 'none', metadataState: 'complete',
    canonicalOwner: 'ci-policy-owner', applicableStages: ALL_EXECUTION_STAGES,
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest'],
    messageTemplate: { summary: 'The registered control completed for the exact trusted inputs.', guidance: ['Retain the exact terminal evidence and its identity bindings.'] },
  }),
  defineReason({
    code: 'ci.classification.not-applicable', outcome: 'not-applicable', guidanceKind: 'none', metadataState: 'complete',
    canonicalOwner: 'ci-classifier-decision-owner', applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'classifierDigest', 'toolDigest'],
    messageTemplate: { summary: 'The trusted classifier proved that the control is not applicable.', guidance: ['Retain the closed classifier reason and exact revision binding.'] },
  }),
  defineReason({
    code: 'ci.required-check.missing', outcome: 'inconclusive', guidanceKind: 'evidence-recovery', metadataState: 'complete',
    canonicalOwner: 'ci-policy-owner', applicableStages: ['pull-request', 'merge-group', 'default-branch', 'release', 'deployment'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest'],
    messageTemplate: { summary: 'The required evidence did not prove the declared boundary.', guidance: ['Repair the named precondition.', 'Replay the focused check.'] },
  }),
  defineReason({
    code: 'ci.required-check.warning-only',
    outcome: 'warn',
    guidanceKind: 'source-correction',
    lifecycle: 'deprecated',
    supersededBy: 'quality.semantic.finding.warning',
  }),
  defineReason({ code: 'ci.required-check.tuple-mismatch', outcome: 'inconclusive', guidanceKind: 'escalation' }),
  defineReason({
    code: 'ci.input.precondition-unproven', outcome: 'inconclusive', guidanceKind: 'precondition-correction', metadataState: 'complete',
    canonicalOwner: 'ci-policy-owner', applicableStages: ALL_EXECUTION_STAGES,
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest'],
    messageTemplate: { summary: 'The required evidence did not prove the declared boundary.', guidance: ['Repair the named precondition.', 'Replay the focused check.'] },
  }),
  defineReason({
    code: 'ci.execution.attempt-inconclusive', outcome: 'inconclusive', guidanceKind: 'evidence-recovery', metadataState: 'complete',
    canonicalOwner: 'ci-policy-owner', applicableStages: ALL_EXECUTION_STAGES,
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest'],
    messageTemplate: { summary: 'The required evidence did not prove the declared boundary.', guidance: ['Repair the named precondition.', 'Replay the focused check.'] },
  }),
  defineReason({ code: 'ci.execution.stale-receipt', outcome: 'inconclusive', guidanceKind: 'evidence-recovery', lifecycle: 'deprecated', supersededBy: 'evidence.receipt.attempt.stale' }),
  defineReason({ code: 'ci.execution.invalid-receipt', outcome: 'inconclusive', guidanceKind: 'evidence-recovery' }),
  defineReason({
    code: 'ci.native.receipt-unavailable', outcome: 'inconclusive', guidanceKind: 'evidence-recovery', metadataState: 'complete',
    canonicalOwner: 'ci.native-adapter.owner', applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest'],
    messageTemplate: { summary: 'The native detector receipt is unavailable or cannot be trusted.', guidance: ['Regenerate the native receipt for the exact revision and preserve its native cause.'] },
  }),
  defineReason({
    code: 'ci.native.semantic-quality', outcome: 'block', guidanceKind: 'source-correction', metadataState: 'complete',
    canonicalOwner: 'semantic-quality-decision-owner', applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group', 'default-branch', 'release'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'nativeEvidenceDigest'],
    messageTemplate: { summary: 'The native semantic-quality owner proved a blocking finding.', guidance: ['Repair the canonical native semantic finding without changing its rule, severity, or exception owner.'] },
  }),
  defineReason({
    code: 'ci.native.repository-hygiene.finding', outcome: 'block', guidanceKind: 'source-correction', metadataState: 'complete',
    implementationState: 'implemented', canonicalOwner: 'repository-hygiene-decision-owner',
    applicableStages: ['pre-push', 'pull-request', 'merge-group', 'default-branch', 'release'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'nativeEvidenceDigest'],
    messageTemplate: {
      summary: 'The native repository-hygiene owner proved a blocking exact-range finding.',
      guidance: ['Repair the preserved native repository-hygiene cause without changing its rule, severity, or exception owner.'],
    },
    fixtures: {
      unsafe: 'A validated exact-range repository-hygiene receipt contains a native blocking cause.',
      safeNeighbor: 'The adjacent exact range validates with no native repository-hygiene cause.',
      unavailableEvidence: 'The exact native receipt, byte binding, lineage, tool digest, or policy digest is unavailable or mismatched.',
    },
  }),
  defineReason({
    code: 'ci.native.privacy-publication.finding', outcome: 'block', guidanceKind: 'source-correction', metadataState: 'complete',
    implementationState: 'implemented', severity: 'critical', canonicalOwner: 'publication-decision-owner',
    applicableStages: ['pre-push', 'pull-request', 'merge-group', 'default-branch', 'release'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'nativeEvidenceDigest'],
    messageTemplate: {
      summary: 'The native publication owner proved a blocking exact-range privacy finding.',
      guidance: ['Repair the preserved native publication cause without changing its rule, severity, or exception owner.'],
    },
    fixtures: {
      unsafe: 'A validated exact-range publication receipt contains a native blocking privacy cause.',
      safeNeighbor: 'The adjacent exact range validates with no native publication cause.',
      unavailableEvidence: 'The exact native receipt, byte binding, lineage, tool digest, or policy digest is unavailable or mismatched.',
    },
  }),
  defineReason({
    code: 'quality.semantic.finding.warning',
    outcome: 'warn',
    guidanceKind: 'source-correction',
    metadataState: 'complete',
    implementationState: 'implemented',
    severity: 'medium',
    applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group', 'default-branch', 'release'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest', 'nativeEvidenceDigest'],
    canonicalOwner: 'semantic-quality-decision-owner',
    messageTemplate: {
      summary: 'The native semantic-quality owner reported an actionable advisory finding.',
      guidance: ['Repair the native semantic finding before its governed expiry; do not treat the warning as passing mandatory evidence.'],
    },
    fixtures: {
      unsafe: 'A valid semantic-quality receipt contains a native warning finding and preserves its granular rule ID.',
      safeNeighbor: 'The adjacent semantic fixture has no warning finding and the native receipt passes.',
      unavailableEvidence: 'The native receipt, rule ID, revision binding, or policy digest is missing or malformed.',
    },
    warningPolicy: {
      owner: 'semantic-quality-decision-owner',
      remediationSlaHours: 8,
      expiresAfterHours: 12,
      escalationCondition: 'The native semantic warning remains unresolved when its protected validity interval expires.',
      successorCode: 'quality.semantic.warning.expired',
    },
  }),
  defineReason({
    code: 'quality.semantic.warning.expired', outcome: 'block', guidanceKind: 'source-correction', metadataState: 'complete',
    canonicalOwner: 'semantic-quality-decision-owner', applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group', 'default-branch', 'release'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest', 'nativeEvidenceDigest', 'warningTransition'],
    messageTemplate: {
      summary: 'The governed semantic-quality warning expired without a verified remediation receipt.',
      guidance: ['Repair the original native semantic finding and emit a new exact-revision receipt; do not reset or suppress the original warning interval.'],
    },
  }),
  defineReason({
    code: 'ci.native.boundary-run', outcome: 'block', guidanceKind: 'source-correction', metadataState: 'complete',
    canonicalOwner: 'boundary-run-decision-owner', applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'nativeEvidenceDigest'],
    messageTemplate: { summary: 'The native boundary-run owner proved a blocking finding.', guidance: ['Repair the canonical boundary-run finding without recomputing its native decision.'] },
  }),
  defineReason({ code: 'ci.hooks.pass', outcome: 'pass', guidanceKind: 'none' }),
  defineReason({ code: 'ci.hooks.path-foreign', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.path-absolute', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.path-escaping', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.path-missing', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.path-disabled', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.input-invalid', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.source-missing', outcome: 'block', guidanceKind: 'source-correction' }),
  defineReason({ code: 'ci.hooks.source-invalid', outcome: 'block', guidanceKind: 'source-correction' }),
  defineReason({ code: 'ci.hooks.installed-missing', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.installed-symlink', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.installed-type-invalid', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.installed-unexpected', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.installed-hardlink', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.installed-identity-changed', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.installed-mode-mismatch', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.installed-bytes-mismatch', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.hooks.head-moved', outcome: 'inconclusive', guidanceKind: 'evidence-recovery' }),
  defineReason({ code: 'ci.hooks.evidence-unavailable', outcome: 'inconclusive', guidanceKind: 'evidence-recovery' }),
  defineReason({ code: 'ci.refs.pass', outcome: 'pass', guidanceKind: 'none' }),
  defineReason({ code: 'ci.refs.input-malformed', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.refs.input-budget', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.refs.input-duplicate', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.refs.remote-identity-unavailable', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.refs.remote-policy-prohibited', outcome: 'block', guidanceKind: 'source-correction' }),
  defineReason({ code: 'ci.refs.policy-unknown', outcome: 'inconclusive', guidanceKind: 'evidence-recovery' }),
  defineReason({ code: 'ci.refs.graph-unavailable', outcome: 'inconclusive', guidanceKind: 'evidence-recovery' }),
  defineReason({ code: 'ci.refs.delete-prohibited', outcome: 'block', guidanceKind: 'source-correction' }),
  defineReason({ code: 'ci.refs.force-update-prohibited', outcome: 'block', guidanceKind: 'source-correction' }),
  defineReason({ code: 'ci.refs.object-type-prohibited', outcome: 'block', guidanceKind: 'source-correction' }),
  defineReason({ code: 'ci.refs.local-source-unbound', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.refs.object-format-unsupported', outcome: 'inconclusive', guidanceKind: 'precondition-correction' }),
  defineReason({ code: 'ci.refs.private-binding-unavailable', outcome: 'inconclusive', guidanceKind: 'evidence-recovery' }),
  defineReason({
    code: 'ci.refs.exact-set-mismatch', outcome: 'inconclusive', guidanceKind: 'evidence-recovery',
    implementationState: 'implemented', retryClass: 'after-evidence-regeneration', remediationClass: 'exact-revision-rerun',
  }),
  defineReason({
    code: 'ci.refs.local-ref-moved', outcome: 'inconclusive', guidanceKind: 'escalation',
    implementationState: 'implemented', retryClass: 'after-lineage-reconciliation', remediationClass: 'lineage-reconciliation',
  }),
  defineReason({
    code: 'ci.refs.transport-authority-unavailable', outcome: 'inconclusive', guidanceKind: 'evidence-recovery',
    implementationState: 'implemented', retryClass: 'after-evidence-regeneration', remediationClass: 'exact-revision-rerun',
  }),
  defineReason({ code: 'evidence.receipt.attempt.stale', outcome: 'inconclusive', guidanceKind: 'evidence-recovery', implementationState: 'planned' }),
  defineReason({ code: 'workflow.result.requirement.missing', outcome: 'inconclusive', guidanceKind: 'evidence-recovery', implementationState: 'planned' }),
  defineReason({ code: 'migration.parity.result.mismatch', outcome: 'inconclusive', guidanceKind: 'escalation', implementationState: 'planned' }),
  defineReason({
    code: 'integrity.writer.worktree.concurrent',
    outcome: 'inconclusive',
    guidanceKind: 'escalation',
    retryClass: 'after-lineage-reconciliation',
    remediationClass: 'lineage-reconciliation',
    metadataState: 'complete',
    implementationState: 'planned',
    applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'manifestDigest', 'toolDigest', 'lineageLease', 'writerIdentity'],
    messageTemplate: {
      summary: 'Another uncoordinated writer can mutate the leased worktree or branch.',
      guidance: ['Stop mutation, identify every writer by observed process identity, designate one writer, and replay evidence created under the conflicting lease.'],
    },
    fixtures: {
      unsafe: 'A second writer with a distinct PID and process group acquires the same worktree and branch.',
      safeNeighbor: 'One designated writer holds the lease while every reviewer remains read-only.',
      unavailableEvidence: 'Writer PID, process group, start time, CWD, or lease ownership cannot be observed.',
    },
  }),
  defineReason({
    code: 'integrity.lineage.review.stale',
    outcome: 'inconclusive',
    guidanceKind: 'evidence-recovery',
    retryClass: 'after-lineage-reconciliation',
    remediationClass: 'lineage-reconciliation',
    metadataState: 'complete',
    implementationState: 'planned',
    applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'manifestDigest', 'toolDigest', 'lineageLease', 'reviewDigest'],
    messageTemplate: {
      summary: 'A review binds source, plan, policy, or prerequisite bytes that are no longer current.',
      guidance: ['Quarantine the stale review, reconcile the changed identity, and dispatch a new read-only review against the current bytes.'],
    },
    fixtures: {
      unsafe: 'A reviewed file or prerequisite digest changes after review dispatch.',
      safeNeighbor: 'The review receipt hashes exactly match every current reviewed input.',
      unavailableEvidence: 'The review omits its source, plan, policy, or tool digest.',
    },
  }),
  defineReason({
    code: 'integrity.process.identity.unproven',
    outcome: 'inconclusive',
    guidanceKind: 'precondition-correction',
    metadataState: 'complete',
    implementationState: 'planned',
    applicableStages: ALL_EXECUTION_STAGES,
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest', 'processIdentity'],
    canonicalOwner: 'ci.execution.owner',
    messageTemplate: {
      summary: 'Process identity is inferred from a label or command string instead of observed ownership facts.',
      guidance: ['Observe PID, parent, process group, start time, CWD, executable identity, and owned resources before trusting or terminating the process.'],
    },
    fixtures: {
      unsafe: 'Two processes share a historical command label but have different parents, process groups, start times, and working directories.',
      safeNeighbor: 'The target process matches the leased PID, parent, process group, start time, CWD, executable digest, and ownership record.',
      unavailableEvidence: 'One or more required process identity fields cannot be observed.',
    },
  }),
  defineReason({
    code: 'execution.shell.failure.masked',
    outcome: 'block',
    guidanceKind: 'source-correction',
    metadataState: 'complete',
    implementationState: 'planned',
    applicableStages: ALL_EXECUTION_STAGES,
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest'],
    messageTemplate: {
      summary: 'Shell control flow can publish success after an earlier required assertion failed.',
      guidance: ['Capture every direct status, preserve the primary failure through cleanup, and emit success only from the explicit terminal branch.'],
    },
    fixtures: {
      unsafe: 'A failing assertion is followed by a successful command and an unconditional success message.',
      safeNeighbor: 'The direct assertion status is preserved through cleanup and success is emitted only from the terminal branch.',
      unavailableEvidence: 'The direct child or pipeline component statuses are not captured.',
    },
  }),
  defineReason({
    code: 'execution.process-group.child-live',
    outcome: 'inconclusive',
    guidanceKind: 'evidence-recovery',
    metadataState: 'complete',
    implementationState: 'planned',
    applicableStages: ALL_EXECUTION_STAGES,
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest'],
    messageTemplate: {
      summary: 'An owned child process remains alive while terminal evidence is being published.',
      guidance: ['Reap the complete owned process group, invalidate the attempt receipt, and start a new attempt identity.'],
    },
    fixtures: {
      unsafe: 'A background child survives parent cancellation and terminal receipt publication.',
      safeNeighbor: 'Cancellation terminates and reaps every process in the owned group before receipt publication.',
      unavailableEvidence: 'Process-group ownership or terminal liveness cannot be observed.',
    },
  }),
  defineReason({
    code: 'evidence.receipt.state.nonterminal',
    outcome: 'inconclusive',
    guidanceKind: 'evidence-recovery',
    metadataState: 'complete',
    implementationState: 'planned',
    applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group', 'release', 'deployment', 'runtime', 'scheduled'],
    requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest'],
    messageTemplate: {
      summary: 'Progress or partial state was presented as terminal evidence.',
      guidance: ['Wait for atomic terminal publication with the exact-byte digest and confirm the owned process group has ended.'],
    },
    fixtures: {
      unsafe: 'A progress log or mutable latest-status file is submitted as the final receipt.',
      safeNeighbor: 'A unique attempt atomically publishes its terminal receipt after every owned child exits.',
      unavailableEvidence: 'The terminal receipt, exact-byte digest, or attempt identity is unavailable.',
    },
  }),
  defineReason({
    code: 'evidence.change-record.missing',
    outcome: 'block',
    guidanceKind: 'source-correction',
    metadataState: 'complete',
    implementationState: 'implemented',
    messageTemplate: {
      summary: 'The commit declares no resolvable change record, or its referenced record file is absent from the tree.',
      guidance: ['Add exactly one Change-Record trailer whose referenced changes/<id>.yaml record exists in the same revision; do not weaken the requirement with a low declared risk.'],
    },
    fixtures: {
      unsafe: 'A commit carries no Change-Record trailer, or a Change-Record trailer whose changes/<id>.yaml file does not exist.',
      safeNeighbor: 'The commit declares exactly one Change-Record trailer whose changes/<id>.yaml record is present in the tree.',
      unavailableEvidence: 'Record presence cannot be determined because the tree or record path is unreadable; that is inconclusive, not a passing absence.',
    },
  }),
  defineReason({
    code: 'evidence.trailer.invalid',
    outcome: 'block',
    guidanceKind: 'source-correction',
    metadataState: 'complete',
    implementationState: 'implemented',
    messageTemplate: {
      summary: 'A change-record trailer is unrecognized, duplicated, out of bounds, or omits an obligated companion trailer.',
      guidance: ['Use only the recognized bounded trailers (Change-Record, Regression-For, Change-Intent), exactly one Change-Record, and supply Regression-For whenever Change-Intent is bugfix.'],
    },
    fixtures: {
      unsafe: 'A commit adds an unknown Change-* trailer, two Change-Record trailers, an injection-bearing value, or Change-Intent: bugfix without Regression-For.',
      safeNeighbor: 'The commit uses one Change-Record, bounded recognized trailer values, and pairs Change-Intent: bugfix with a Regression-For trailer.',
      unavailableEvidence: 'The commit message cannot be read; that is inconclusive, not a passing valid trailer set.',
    },
  }),
  defineReason({
    code: 'evidence.trailer.record-mismatch',
    outcome: 'block',
    guidanceKind: 'source-correction',
    metadataState: 'complete',
    implementationState: 'implemented',
    messageTemplate: {
      summary: 'A present change record is provably inconsistent with its trailer pointer, its filename, the schema, or the allowed record set.',
      guidance: ['Reconcile the record so its declared id matches its filename and the Change-Record trailer, it is schema-valid, and every referenced record is in the allowed set.'],
    },
    fixtures: {
      unsafe: 'A present, readable changes/<id>.yaml declares a different id, fails the schema, is unparseable, or references a record outside the allowed set.',
      safeNeighbor: 'The present record is schema-valid, its declared id matches its filename and the trailer, and it is within the allowed record set.',
      unavailableEvidence: 'The record cannot be read to compare against its pointer; that is inconclusive, not a passing match.',
    },
  }),
] as ReasonDefinitionV2[]) as readonly ReasonDefinitionV2[];

const REASON_BY_CODE: ReadonlyMap<string, ReasonDefinitionV2> = new Map(REASONS.map((reason) => [reason.code, reason]));

const LIMITATION_CODES = deepFreeze([
  'ci.native.cause-code-unavailable',
  'ci.native.evidence-unavailable',
  'ci.native.progress-only',
  'ci.refs.private-binding-unavailable',
  'ci.refs.report-only',
] as string[]) as readonly string[];

export function allReasonDefinitions(): readonly ReasonDefinitionV2[] {
  return REASONS;
}

export function isRegisteredReason(code: unknown): code is string {
  return typeof code === 'string' && REASON_BY_CODE.has(code);
}

export function isEmittableReason(code: unknown): code is string {
  const definition = reasonDefinition(code);
  return definition?.lifecycle === 'active' && definition.implementationState === 'implemented' && definition.metadataState === 'complete';
}

export function isLegacyCompatibleReason(code: unknown): code is string {
  const definition = reasonDefinition(code);
  return definition?.lifecycle === 'active' && definition.implementationState === 'implemented';
}

export function reasonDefinition(code: unknown): ReasonDefinitionV2 | null {
  return typeof code === 'string' ? REASON_BY_CODE.get(code) ?? null : null;
}

export function isRegisteredLimitationCode(code: unknown): code is string {
  return typeof code === 'string' && LIMITATION_CODES.includes(code);
}
