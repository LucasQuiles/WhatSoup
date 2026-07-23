import { describe, expect, it } from 'vitest';

import {
  allReasonDefinitions,
  isEmittableReason,
  isLegacyCompatibleReason,
  isRegisteredLimitationCode,
  reasonDefinition,
  type ReasonDefinitionV2,
} from '../../scripts/lib/ci-control/reasons.ts';
import * as reasonApi from '../../scripts/lib/ci-control/reasons.ts';

const REQUIRED_IDENTITY_BINDINGS = ['candidateOid', 'policyDigest'] as const;

function expectCompleteDefinition(definition: ReasonDefinitionV2): void {
  expect(definition.schemaVersion).toBe(2);
  expect(['active', 'deprecated', 'superseded']).toContain(definition.lifecycle);
  expect(['pass', 'warn', 'block', 'inconclusive', 'not-applicable']).toContain(definition.defaultOutcome);
  expect(['info', 'low', 'medium', 'high', 'critical']).toContain(definition.defaultSeverity);
  expect(definition.applicableStages.length).toBeGreaterThan(0);
  expect(['proven', 'inconclusive', 'proposed']).toContain(definition.confidenceRequired);
  expect(definition.requiredIdentityBindings).toEqual(expect.arrayContaining([...REQUIRED_IDENTITY_BINDINGS]));
  expect(definition.canonicalOwner).toMatch(/^[a-z0-9.-]+$/);
  expect(definition.publicDisclosure).toBe('sanitized');
  expect(definition.messageTemplate.summary.length).toBeGreaterThan(0);
  expect(definition.messageTemplate.guidance.length).toBeGreaterThan(0);
  expect(definition.fixtures.unsafe.length).toBeGreaterThan(0);
  expect(definition.fixtures.safeNeighbor.length).toBeGreaterThan(0);
  expect(definition.fixtures.unavailableEvidence.length).toBeGreaterThan(0);
  expect(definition.metadataState).toBe('complete');
  expect(['implemented', 'planned']).toContain(definition.implementationState);
}

describe('CP-F2e immutable taxonomy registry', () => {
  it('exposes complete, unique, recursively frozen definitions without mutable set authority', () => {
    const definitions = allReasonDefinitions();
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(new Set(definitions.map(({ code }) => code)).size).toBe(definitions.length);
    for (const definition of definitions) {
      if (definition.metadataState === 'complete') expectCompleteDefinition(definition);
      else expect(definition.metadataState).toBe('legacy-partial');
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.applicableStages)).toBe(true);
      expect(Object.isFrozen(definition.requiredIdentityBindings)).toBe(true);
      expect(Object.isFrozen(definition.messageTemplate)).toBe(true);
      expect(Object.isFrozen(definition.messageTemplate.guidance)).toBe(true);
      expect(Object.isFrozen(definition.fixtures)).toBe(true);
    }
    expect(() => (definitions as unknown as ReasonDefinitionV2[]).push(definitions[0]!)).toThrow();
    expect(() => Object.assign(definitions[0]!, { defaultOutcome: 'pass' })).toThrow();
  });

  it('keeps historical meanings readable but prevents deprecated or superseded emission', () => {
    const historical = reasonDefinition('ci.execution.stale-receipt');
    expect(historical).toMatchObject({
      lifecycle: 'deprecated',
      defaultOutcome: 'inconclusive',
      supersededBy: 'evidence.receipt.attempt.stale',
    });
    expect(reasonDefinition('evidence.receipt.attempt.stale')).toMatchObject({ lifecycle: 'active', defaultOutcome: 'inconclusive' });
    expect(isEmittableReason('ci.execution.stale-receipt')).toBe(false);
    expect(reasonDefinition('evidence.receipt.attempt.stale')).toMatchObject({ implementationState: 'planned' });
    expect(isEmittableReason('evidence.receipt.attempt.stale')).toBe(false);
    expect(reasonDefinition('unknown.code')).toBeNull();
  });

  it('requires governed warning escalation and a distinct registered successor', () => {
    const warnings = allReasonDefinitions().filter(({ defaultOutcome, lifecycle }) => defaultOutcome === 'warn' && lifecycle === 'active');
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(warning.lifecycle).toBe('active');
      expect(warning.warningPolicy).toMatchObject({ owner: expect.any(String), remediationSlaHours: expect.any(Number), expiresAfterHours: expect.any(Number), escalationCondition: expect.any(String), successorCode: expect.any(String) });
      const successor = reasonDefinition(warning.warningPolicy!.successorCode);
      expect(successor).not.toBeNull();
      expect(successor!.code).not.toBe(warning.code);
      expect(['block', 'inconclusive']).toContain(successor!.defaultOutcome);
    }
    expect((reasonApi as unknown as Record<string, unknown>).warningEscalationCode).toBeUndefined();
    expect(reasonDefinition('quality.semantic.warning.expired')).toMatchObject({
      lifecycle: 'active', metadataState: 'complete', implementationState: 'implemented',
      defaultOutcome: 'block', canonicalOwner: 'semantic-quality-decision-owner',
    });
  });

  it('enforces lifecycle and warning-policy invariants across the registry', () => {
    for (const definition of allReasonDefinitions()) {
      if (definition.lifecycle === 'active') expect(definition.supersededBy, definition.code).toBeNull();
      else {
        expect(definition.supersededBy, definition.code).toEqual(expect.any(String));
        expect(reasonDefinition(definition.supersededBy), definition.code).not.toBeNull();
        expect(definition.supersededBy, definition.code).not.toBe(definition.code);
      }
      if (definition.lifecycle === 'active' && definition.defaultOutcome === 'warn') {
        expect(definition.warningPolicy, definition.code).not.toBeNull();
        expect(Number.isFinite(definition.warningPolicy!.remediationSlaHours)).toBe(true);
        expect(Number.isFinite(definition.warningPolicy!.expiresAfterHours)).toBe(true);
        expect(definition.warningPolicy!.remediationSlaHours).toBeGreaterThan(0);
        expect(definition.warningPolicy!.expiresAfterHours).toBeGreaterThan(definition.warningPolicy!.remediationSlaHours);
      } else {
        expect(definition.warningPolicy, definition.code).toBeNull();
      }
    }
  });

  it('keeps planned P0 codes non-emittable until executable fixtures exist', () => {
    for (const code of [
      'integrity.writer.worktree.concurrent', 'integrity.lineage.review.stale',
      'integrity.process.identity.unproven', 'execution.shell.failure.masked',
      'execution.process-group.child-live', 'evidence.receipt.state.nonterminal',
    ]) {
      expect(reasonDefinition(code), code).toMatchObject({ metadataState: 'complete', implementationState: 'planned' });
      expect(isEmittableReason(code), code).toBe(false);
    }
  });

  it('uses a distinct implemented code for native semantic warnings', () => {
    expect(reasonDefinition('ci.required-check.warning-only')).toMatchObject({ lifecycle: 'deprecated', supersededBy: 'quality.semantic.finding.warning' });
    expect(reasonDefinition('quality.semantic.finding.warning')).toMatchObject({
      lifecycle: 'active', metadataState: 'complete', implementationState: 'implemented',
      defaultOutcome: 'warn', canonicalOwner: 'semantic-quality-decision-owner',
    });
    expect(isEmittableReason('ci.required-check.warning-only')).toBe(false);
    expect(isEmittableReason('quality.semantic.finding.warning')).toBe(true);
  });

  it('registers owner-specific native exact-range wrapper reasons without changing native causes', () => {
    expect(reasonDefinition('ci.native.repository-hygiene.finding')).toMatchObject({
      lifecycle: 'active',
      metadataState: 'complete',
      implementationState: 'implemented',
      defaultOutcome: 'block',
      defaultSeverity: 'high',
      canonicalOwner: 'repository-hygiene-decision-owner',
      requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'nativeEvidenceDigest'],
    });
    expect(reasonDefinition('ci.native.privacy-publication.finding')).toMatchObject({
      lifecycle: 'active',
      metadataState: 'complete',
      implementationState: 'implemented',
      defaultOutcome: 'block',
      defaultSeverity: 'critical',
      canonicalOwner: 'publication-decision-owner',
      requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'nativeEvidenceDigest'],
    });
    expect(isEmittableReason('ci.native.repository-hygiene.finding')).toBe(true);
    expect(isEmittableReason('ci.native.privacy-publication.finding')).toBe(true);
  });

  it('registers implemented report-only exact-ref canary reasons', () => {
    expect(reasonDefinition('ci.refs.exact-set-mismatch')).toMatchObject({
      lifecycle: 'active', metadataState: 'legacy-partial', implementationState: 'implemented',
      defaultOutcome: 'inconclusive', guidanceKind: 'evidence-recovery',
      retryClass: 'after-evidence-regeneration', remediationClass: 'exact-revision-rerun',
      canonicalOwner: 'legacy-metadata-unmigrated', applicableStages: [], requiredIdentityBindings: [],
    });
    expect(reasonDefinition('ci.refs.local-ref-moved')).toMatchObject({
      lifecycle: 'active', metadataState: 'legacy-partial', implementationState: 'implemented',
      defaultOutcome: 'inconclusive', guidanceKind: 'escalation',
      retryClass: 'after-lineage-reconciliation', remediationClass: 'lineage-reconciliation',
      canonicalOwner: 'legacy-metadata-unmigrated', applicableStages: [], requiredIdentityBindings: [],
    });
    expect(reasonDefinition('ci.refs.transport-authority-unavailable')).toMatchObject({
      lifecycle: 'active', metadataState: 'legacy-partial', implementationState: 'implemented',
      defaultOutcome: 'inconclusive', guidanceKind: 'evidence-recovery',
      retryClass: 'after-evidence-regeneration', remediationClass: 'exact-revision-rerun',
      canonicalOwner: 'legacy-metadata-unmigrated', applicableStages: [], requiredIdentityBindings: [],
    });
    expect(isEmittableReason('ci.refs.exact-set-mismatch')).toBe(false);
    expect(isEmittableReason('ci.refs.local-ref-moved')).toBe(false);
    expect(isEmittableReason('ci.refs.transport-authority-unavailable')).toBe(false);
    expect(isLegacyCompatibleReason('ci.refs.exact-set-mismatch')).toBe(true);
    expect(isLegacyCompatibleReason('ci.refs.local-ref-moved')).toBe(true);
    expect(isLegacyCompatibleReason('ci.refs.transport-authority-unavailable')).toBe(true);
    expect(isRegisteredLimitationCode('ci.refs.report-only')).toBe(true);
    expect(isRegisteredLimitationCode('ci.refs.private-binding-unavailable')).toBe(true);
  });

  it('separates complete authoritative emission from bounded legacy compatibility', () => {
    const legacyCompatible = (reasonApi as unknown as Record<string, unknown>).isLegacyCompatibleReason;
    expect(legacyCompatible).toEqual(expect.any(Function));
    expect(isEmittableReason('ci.hooks.path-foreign')).toBe(false);
    if (typeof legacyCompatible === 'function') {
      expect(legacyCompatible('ci.hooks.path-foreign')).toBe(true);
      expect(legacyCompatible('ci.execution.stale-receipt')).toBe(false);
    }
  });

  it('registers named P0 writer, stale-review, process, shell, and terminal-evidence causes', () => {
    for (const [code, outcome] of [
      ['integrity.writer.worktree.concurrent', 'inconclusive'],
      ['integrity.lineage.review.stale', 'inconclusive'],
      ['integrity.process.identity.unproven', 'inconclusive'],
      ['execution.shell.failure.masked', 'block'],
      ['execution.process-group.child-live', 'inconclusive'],
      ['evidence.receipt.state.nonterminal', 'inconclusive'],
    ] as const) {
      expect(reasonDefinition(code), code).toMatchObject({ lifecycle: 'active', defaultOutcome: outcome });
    }
  });

  it('binds P0 definitions to their truthful stages, identities, and actionable fixtures', () => {
    expect(reasonDefinition('integrity.writer.worktree.concurrent')).toMatchObject({
      applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group'],
      requiredIdentityBindings: ['candidateOid', 'policyDigest', 'manifestDigest', 'toolDigest', 'lineageLease', 'writerIdentity'],
      messageTemplate: {
        summary: 'Another uncoordinated writer can mutate the leased worktree or branch.',
      },
      fixtures: {
        unsafe: 'A second writer with a distinct PID and process group acquires the same worktree and branch.',
        safeNeighbor: 'One designated writer holds the lease while every reviewer remains read-only.',
        unavailableEvidence: 'Writer PID, process group, start time, CWD, or lease ownership cannot be observed.',
      },
    });
    expect(reasonDefinition('execution.shell.failure.masked')).toMatchObject({
      applicableStages: ['local', 'pre-commit', 'pre-push', 'pull-request', 'merge-group', 'release', 'deployment', 'scheduled'],
      requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest'],
      messageTemplate: {
        summary: 'Shell control flow can publish success after an earlier required assertion failed.',
      },
      fixtures: {
        unsafe: 'A failing assertion is followed by a successful command and an unconditional success message.',
        safeNeighbor: 'The direct assertion status is preserved through cleanup and success is emitted only from the terminal branch.',
        unavailableEvidence: 'The direct child or pipeline component statuses are not captured.',
      },
    });
    expect(reasonDefinition('evidence.receipt.state.nonterminal')).toMatchObject({
      applicableStages: ['local', 'pre-push', 'pull-request', 'merge-group', 'release', 'deployment', 'runtime', 'scheduled'],
      requiredIdentityBindings: ['candidateOid', 'policyDigest', 'toolDigest', 'attemptDigest'],
      messageTemplate: {
        summary: 'Progress or partial state was presented as terminal evidence.',
      },
    });
  });

  it('does not use placeholder message or fixture text for active definitions', () => {
    for (const definition of allReasonDefinitions().filter(({ lifecycle, metadataState }) => lifecycle === 'active' && metadataState === 'complete')) {
      expect(definition.messageTemplate.summary, definition.code).not.toContain('control condition was observed');
      expect(definition.messageTemplate.guidance.join(' '), definition.code).not.toContain('registered none remediation');
      expect(definition.fixtures.unsafe, definition.code).not.toBe(`${definition.code}:unsafe`);
      expect(definition.fixtures.safeNeighbor, definition.code).not.toBe(`${definition.code}:safe-neighbor`);
      expect(definition.fixtures.unavailableEvidence, definition.code).not.toBe(`${definition.code}:unavailable-evidence`);
    }
  });

  it('keeps missing evidence, failed preconditions, and failed attempts diagnostically distinct', () => {
    const missing = reasonDefinition('ci.required-check.missing');
    const precondition = reasonDefinition('ci.input.precondition-unproven');
    const attempt = reasonDefinition('ci.execution.attempt-inconclusive');

    expect(missing).not.toBeNull();
    expect(precondition).not.toBeNull();
    expect(attempt).not.toBeNull();
    expect(new Set([
      missing!.messageTemplate.summary,
      precondition!.messageTemplate.summary,
      attempt!.messageTemplate.summary,
    ])).toHaveLength(3);
    expect(missing!.messageTemplate.guidance.join(' ')).toMatch(/regenerate|required.*evidence/i);
    expect(precondition!.messageTemplate.guidance.join(' ')).toMatch(/precondition|setup/i);
    expect(attempt!.messageTemplate.summary).toMatch(/terminal.*attempt.*required assurance.*not complete/i);
    expect(attempt!.messageTemplate.summary).not.toMatch(/did not produce.*terminal evidence/i);
    expect(attempt!.messageTemplate.guidance.join(' ')).toMatch(/attempt|terminal|process/i);
    expect(attempt!.messageTemplate.guidance.join(' ')).toMatch(/reaped|ended/i);
    expect(attempt!.messageTemplate.guidance.join(' ')).toMatch(/failure condition|cause/i);
    expect(attempt!.messageTemplate.guidance.join(' ')).not.toMatch(/terminate/i);
  });
});
