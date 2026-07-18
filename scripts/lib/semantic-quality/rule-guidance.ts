import { createHash } from 'node:crypto';

import type {
  BoundaryCommand,
  BoundaryCorrectionStep,
  BoundaryVerificationStep,
  EvidenceState,
} from './boundary-types.ts';

export interface BoundaryRuleGuidance {
  ruleVersion: number;
  expected: string[];
  impact: string[];
  safeControls: string[];
  correction: BoundaryCorrectionStep[];
  verification: BoundaryVerificationStep[];
  rerun: BoundaryCommand;
  rerunPurpose: 'integration-boundary' | 'focused-family-replay';
  sourceRefs: string[];
}

type RuleInvariantGuidance = Omit<BoundaryRuleGuidance,
  'correction' | 'verification' | 'rerun' | 'rerunPurpose' | 'sourceRefs'> & {
    verificationExpected: string;
  };

const define = (
  expected: string,
  impact: string,
  safeControl: string,
  verificationExpected: string,
): RuleInvariantGuidance => ({
  ruleVersion: 1,
  expected: [expected],
  impact: [impact],
  safeControls: [safeControl],
  verificationExpected,
});

const RULE_GUIDANCE = {
  'boundary.action-identity-unproven': define(
    'The action has the exact required repository, target, and committed candidate identity.',
    'A decision bound to an unknown target can authorize a different action than the one reviewed.',
    'A valid action-specific Git or task identity remains accepted.',
    'Rerun the boundary with the exact target and assert its identity in JSON output.',
  ),
  'boundary.contract-invalid': define(
    'Every runtime enum and required nested field is valid after canonicalization.',
    'Malformed runtime values can bypass compile-time types and collapse to pass.',
    'A complete canonical finding retains its original decision.',
    'Replay the rejected field and its nearest valid neighbor through the contract tests.',
  ),
  'boundary.evidence-incomplete': define(
    'Every evidence source required by the action completed without limitations.',
    'Partial evidence cannot prove that no unsafe condition exists.',
    'A complete observation with no limitations may preserve its warn or pass decision.',
    'Repair the named evidence source and rerun the complete boundary action.',
  ),
  'boundary.evidence-volume-exceeded': define(
    'Canonical evidence remains within declared cardinality and byte budgets.',
    'Unbounded evidence can exhaust CI logs or remove corrective guidance from agent context.',
    'An at-limit receipt remains complete and byte-stable.',
    'Run the at-limit and one-over-limit receipt budget tests.',
  ),
  'boundary.finding-identity-conflict': define(
    'Every finding has one stable rule-and-evidence identity.',
    'Conflicting duplicates make receipt bytes depend on provider input order.',
    'Distinct evidence digests under one rule sort deterministically.',
    'Reverse the input order and compare complete receipt bytes.',
  ),
  'boundary.artifact-identity-conflict': define(
    'Each matched artifact identity appears once with one canonical state and fingerprint.',
    'Duplicate or conflicting artifact records make receipt identity depend on provider order.',
    'Distinct artifact identities in reversed order produce byte-identical receipts.',
    'Run exact-duplicate and conflicting-artifact reversal controls.',
  ),
  'boundary.timeout': define(
    'Every bounded evaluator action settles before its owned deadline.',
    'An unbounded evaluation can consume the agent or CI execution window without a decision.',
    'A neighboring action that settles before the same deadline remains accepted.',
    'Run the evaluator timeout fixture and its resolve-before-deadline control.',
  ),
  'semantic.production-reachability': define(
    'Every changed production module is reachable from a declared runtime root.',
    'Disconnected production code can pass isolated tests without affecting runtime behavior.',
    'A runtime import and behavior test through the declared owner remains accepted.',
    'Run the production-reachability fixtures and the integration semantic boundary.',
  ),
  'semantic.export-ownership': define(
    'Every reachable runtime export has a current production owner.',
    'Orphan exports preserve disconnected APIs and invite duplicate implementations.',
    'An export called by its reachable production owner remains accepted.',
    'Run the export-ownership fixtures and the integration semantic boundary.',
  ),
  'semantic.unresolved-runtime-edge': define(
    'Every literal relative runtime edge resolves in the exact candidate tree.',
    'An unresolved edge makes the claimed composition path unprovable.',
    'A valid literal edge to a committed source remains accepted.',
    'Run the unresolved-edge fixture and its valid neighboring import.',
  ),
  'semantic.invalid-allowlist': define(
    'Every allowlist record is canonical, owned, reasoned, current, and path-qualified.',
    'Malformed overrides can hide semantic evidence or false-block canonical paths.',
    'A canonical unexpired record with every required field remains accepted.',
    'Run policy validation and the canonical-path neighbor fixture.',
  ),
  'semantic.candidate-unavailable': define(
    'The requested candidate resolves to an exact committed tree.',
    'Without a candidate tree, semantic analysis cannot describe the proposed action.',
    'A neighboring valid commit identity resolves and is analyzed.',
    'Fetch the candidate and rerun the integration semantic boundary with the exact head.',
  ),
  'semantic.policy-unavailable': define(
    'The semantic policy is readable from the exact candidate revision.',
    'Missing policy leaves roots, source scope, and exceptions unknown.',
    'A readable schema-valid policy remains accepted.',
    'Restore the semantic policy and rerun its schema and boundary tests.',
  ),
  'semantic.source-tree-unavailable': define(
    'The exact candidate source tree and every declared root are readable.',
    'Partial source inventory makes reachability conclusions incomplete.',
    'A complete source tree with every configured root remains accepted.',
    'Restore the missing tree entry and rerun the exact-tree test.',
  ),
  'semantic.analysis-unavailable': define(
    'Parsing, graph construction, reachability, and ownership analysis complete.',
    'Partial graph output cannot prove semantic safety.',
    'A parseable neighboring source graph remains accepted.',
    'Correct the named analysis failure and rerun the focused semantic suite.',
  ),
  'semantic.invocation-invalid': define(
    'The CLI has one valid value for each singleton option.',
    'Ambiguous options can evaluate a different mode, target, or scope than requested.',
    'A single exact option value remains accepted.',
    'Correct the invocation and replay the exact CLI contract tests.',
  ),
  'semantic.receipt-write-failed': define(
    'The complete receipt is written atomically to a private non-symlink path.',
    'An in-memory decision without durable evidence cannot prove boundary completion.',
    'A private regular destination remains writable and durable.',
    'Repair the destination and rerun the entire boundary action.',
  ),
  'semantic.guard-negative-control': define(
    'Every changed guard has a fixture proving its unsafe input is rejected.',
    'A guard without a negative control can exist in source while never detecting its target.',
    'A guard with both unsafe and nearest-safe fixtures remains accepted.',
    'Run the evaluator negative-control fixture and the named guard test.',
  ),
  'supply-chain.mutable-action': define(
    'Every workflow action reference is pinned to an immutable commit identity.',
    'A mutable action tag can change executed code without a repository diff.',
    'An exact immutable action commit reference remains accepted.',
    'Run the mutable-action evaluator fixture and its pinned neighbor.',
  ),
  'supply-chain.mutable-image': define(
    'Every workflow or deploy image reference is pinned to an immutable digest.',
    'A mutable image tag can change runtime bytes without a repository diff.',
    'An exact image digest reference remains accepted.',
    'Run the mutable-image evaluator fixture and its digest-pinned neighbor.',
  ),
  'supply-chain.floating-runner': define(
    'Every safety-relevant runner contract is version-bounded by repository policy.',
    'A floating runner label can change toolchain behavior without a controlled version transition.',
    'A policy-approved version-bounded runner remains accepted.',
    'Run the floating-runner evaluator fixture and its version-bounded neighbor.',
  ),
  'process.unbounded-primitive': define(
    'Every bare process primitive is owned by a deadline and process-group reaper.',
    'An unowned child can outlive the gate and make a timeout look complete.',
    'A process-group-owned bounded child remains accepted.',
    'Run the unbounded-process evaluator fixture and watchdog canary.',
  ),
  'history.evidence-incomplete': define(
    'History proves the repository identity, coherent observation, and terminal page.',
    'Partial history cannot prove that an equivalent pull request or issue is absent.',
    'A complete bounded collection with a terminal cursor remains accepted.',
    'Repair the provider limitation and run the focused history verification.',
  ),
  'history.exact-open-pr': define(
    'A new boundary action does not recreate content already present in an open pull request.',
    'Exact canonical path-and-blob identity proves the existing proposal already owns the work.',
    'Materially different committed content with a different fingerprint remains accepted.',
    'Continue through the named open pull request or prove a material content change.',
  ),
  'history.exact-merged-pr': define(
    'Recreated merged work proves current main lacks the required reachable behavior.',
    'Merged content may be reverted, but recreating it without reachability proof repeats work.',
    'A proven current-main behavior gap plus a material delta remains reviewable.',
    'Link the merged artifact and prove the current behavior gap in focused verification.',
  ),
  'history.exact-closed-pr': define(
    'Closed-unmerged content is not recreated without satisfying its recorded disposition.',
    'Exact content survives branch deletion and proposal recreation and otherwise repeats prior work.',
    'A complete material re-entry packet satisfying every prior condition remains reviewable.',
    'Cite the closed artifact and satisfy its disposition before focused verification.',
  ),
  'history.renamed-patch-closed-pr': define(
    'A renamed candidate does not reproduce a stable patch from a closed-unmerged pull request.',
    'Stable patch identity detects recreated work even when paths and proposal commits change.',
    'A materially different patch with a different stable identity remains accepted.',
    'Resolve the prior disposition or change the implementation before replay.',
  ),
  'history.blob-subset': define(
    'Reused candidate blobs have an explicit relationship to every matching prior pull request.',
    'Exact blob reuse is strong duplicate context even when a shared refactor is legitimate.',
    'Intentional reuse with a distinct production owner and documented behavior delta remains reviewable.',
    'Link each match and explain every reused blob before focused verification.',
  ),
  'history.path-overlap': define(
    'Shared repository paths have a documented behavior-level distinction from prior proposals.',
    'Path overlap is contextual evidence that can expose repetition but is not duplicate proof alone.',
    'A distinct behavior on an overlapping path remains accepted as a warning-level case.',
    'Link the overlapping artifact and describe the behavioral delta.',
  ),
  'history.exact-issue': define(
    'A new issue has a materially distinct normalized task identity or continues the existing issue.',
    'An exact normalized title-and-body identity means the task already has an issue artifact.',
    'Materially distinct acceptance criteria produce a different task fingerprint.',
    'Continue on the named issue or revise the task body before focused verification.',
  ),
  'history.incomplete-reentry': define(
    'A resubmission cites every prior artifact, satisfies every condition, and names a changed owner.',
    'Cosmetic deltas or ambient overrides cannot cure a recorded architectural disposition.',
    'A material owner change or current fingerprint-scoped owner override remains reviewable.',
    'Complete the re-entry packet and replay the disposition fixtures.',
  ),
  'provenance.unavailable': define(
    'One coherent observation proves repository, remote tip, tracking tip, merge base, counts, and paths.',
    'Missing or contradictory upstream evidence makes duplicate and collision comparisons untrustworthy.',
    'A complete internally consistent observation from the configured upstream remains accepted.',
    'Fetch upstream, recompute every field from one observation, and replay provenance checks.',
  ),
  'provenance.stale-tracking-ref': define(
    'The local tracking ref equals the remotely observed tip before downstream comparison.',
    'A stale tracking identity invalidates merge-base, overlap, and duplicate conclusions.',
    'A fetched tracking ref equal to the observed remote tip remains accepted.',
    'Fetch the configured upstream, assert both OIDs match, and replay provenance checks.',
  ),
  'provenance.stale-overlap': define(
    'The candidate reconciles upstream changes that overlap candidate or high-coupling paths.',
    'Unreconciled safety-relevant overlap can invalidate implementation and verification.',
    'A current candidate or deliberately reconciled overlap with focused tests remains accepted.',
    'Reconcile upstream, test every named path, and replay provenance plus semantic boundaries.',
  ),
  'provenance.stale-disjoint': define(
    'An older candidate explicitly acknowledges and reviews a disjoint upstream delta.',
    'Disjoint paths lower immediate collision risk but do not make stale-base risk disappear.',
    'A current candidate or reviewed disjoint delta remains warning-level rather than blocked.',
    'Review the upstream delta, update when required, and replay provenance checks.',
  ),
} satisfies Record<string, RuleInvariantGuidance>;

type RuleId = keyof typeof RULE_GUIDANCE;
type RuleFamily = 'contract' | 'cli' | 'semantic' | 'history' | 'provenance' | 'evaluator';

const FAMILY_EXECUTION: Record<RuleFamily, {
  testFile: string;
  sourceRef: string;
  rerunArgs: string[];
  rerunPurpose: BoundaryRuleGuidance['rerunPurpose'];
}> = {
  contract: {
    testFile: 'tests/scripts/semantic-boundary-contract.test.ts',
    sourceRef: 'scripts/lib/semantic-quality/boundary-contract.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'run', 'guard:semantic-quality', '--',
      '--scope', 'branch', '--mode', 'shadow', '--format', 'json', '--no-receipt'],
    rerunPurpose: 'integration-boundary',
  },
  cli: {
    testFile: 'tests/scripts/semantic-quality-check.test.ts',
    sourceRef: 'scripts/semantic-quality-check.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'run', 'guard:semantic-quality', '--',
      '--scope', 'branch', '--mode', 'shadow', '--format', 'json', '--no-receipt'],
    rerunPurpose: 'integration-boundary',
  },
  semantic: {
    testFile: 'tests/scripts/semantic-quality-policy.test.ts',
    sourceRef: 'scripts/lib/semantic-quality/policy.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'run', 'guard:semantic-quality', '--',
      '--scope', 'branch', '--mode', 'shadow', '--format', 'json', '--no-receipt'],
    rerunPurpose: 'integration-boundary',
  },
  history: {
    testFile: 'tests/scripts/semantic-history.test.ts',
    sourceRef: 'scripts/lib/semantic-quality/history.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'test', '--',
      'tests/scripts/semantic-history.test.ts', '--pool=forks', '--fileParallelism=false'],
    rerunPurpose: 'focused-family-replay',
  },
  provenance: {
    testFile: 'tests/scripts/semantic-provenance.test.ts',
    sourceRef: 'scripts/lib/semantic-quality/provenance.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'test', '--',
      'tests/scripts/semantic-provenance.test.ts', '--pool=forks', '--fileParallelism=false'],
    rerunPurpose: 'focused-family-replay',
  },
  evaluator: {
    testFile: 'tests/scripts/semantic-boundary-eval.test.ts',
    sourceRef: 'scripts/experiments/semantic-boundary-eval.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'test', '--',
      'tests/scripts/semantic-boundary-eval.test.ts', '--pool=forks', '--fileParallelism=false'],
    rerunPurpose: 'focused-family-replay',
  },
};

function familyForRule(ruleId: RuleId): RuleFamily {
  if (ruleId.startsWith('history.')) return 'history';
  if (ruleId.startsWith('provenance.')) return 'provenance';
  if (ruleId === 'semantic.invocation-invalid' || ruleId === 'semantic.receipt-write-failed') return 'cli';
  if (ruleId.startsWith('supply-chain.') || ruleId.startsWith('process.')
      || ruleId === 'semantic.guard-negative-control' || ruleId === 'boundary.timeout') return 'evaluator';
  if (ruleId.startsWith('semantic.')) return 'semantic';
  return 'contract';
}

function operationForRule(ruleId: RuleId): BoundaryCorrectionStep['operation'] {
  if (ruleId === 'history.exact-open-pr' || ruleId === 'history.exact-issue') return 'reuse';
  if (ruleId.startsWith('provenance.') || ruleId === 'history.evidence-incomplete') return 'refresh';
  return 'edit';
}

function executionForRule(ruleId: RuleId, invariant: RuleInvariantGuidance): Pick<BoundaryRuleGuidance,
  'correction' | 'verification' | 'rerun' | 'rerunPurpose' | 'sourceRefs'> {
  const familyName = familyForRule(ruleId);
  const family = FAMILY_EXECUTION[familyName];
  return {
    correction: [
      {
        operation: operationForRule(ruleId),
        target: `the concrete field, path, or artifact named by ${ruleId} evidence`,
        expected: invariant.expected[0]!,
      },
      {
        operation: 'edit',
        target: `the closed ${familyName} verification sequence for ${ruleId}`,
        expected: invariant.verificationExpected,
      },
    ],
    verification: [{
      command: 'bash',
      args: ['scripts/run-with-pinned-npm.sh', 'test', '--', family.testFile,
        '--pool=forks', '--fileParallelism=false'],
      expected: invariant.verificationExpected,
    }],
    rerun: { command: 'bash', args: [...family.rerunArgs] },
    rerunPurpose: family.rerunPurpose,
    sourceRefs: [family.sourceRef],
  };
}

const RULE_EVIDENCE_STATE: Record<RuleId, EvidenceState> = {
  'boundary.action-identity-unproven': 'absent',
  'boundary.contract-invalid': 'invalid',
  'boundary.evidence-incomplete': 'unavailable',
  'boundary.evidence-volume-exceeded': 'invalid',
  'boundary.finding-identity-conflict': 'invalid',
  'boundary.artifact-identity-conflict': 'invalid',
  'boundary.timeout': 'unavailable',
  'semantic.production-reachability': 'observed',
  'semantic.export-ownership': 'observed',
  'semantic.unresolved-runtime-edge': 'observed',
  'semantic.invalid-allowlist': 'invalid',
  'semantic.candidate-unavailable': 'unavailable',
  'semantic.policy-unavailable': 'unavailable',
  'semantic.source-tree-unavailable': 'unavailable',
  'semantic.analysis-unavailable': 'unavailable',
  'semantic.invocation-invalid': 'invalid',
  'semantic.receipt-write-failed': 'unavailable',
  'semantic.guard-negative-control': 'absent',
  'supply-chain.mutable-action': 'observed',
  'supply-chain.mutable-image': 'observed',
  'supply-chain.floating-runner': 'observed',
  'process.unbounded-primitive': 'observed',
  'history.evidence-incomplete': 'unavailable',
  'history.exact-open-pr': 'observed',
  'history.exact-merged-pr': 'observed',
  'history.exact-closed-pr': 'observed',
  'history.renamed-patch-closed-pr': 'observed',
  'history.blob-subset': 'observed',
  'history.path-overlap': 'observed',
  'history.exact-issue': 'observed',
  'history.incomplete-reentry': 'absent',
  'provenance.unavailable': 'unavailable',
  'provenance.stale-tracking-ref': 'stale',
  'provenance.stale-overlap': 'stale',
  'provenance.stale-disjoint': 'stale',
};

export function guidanceForRule(ruleId: string): BoundaryRuleGuidance {
  if (!(ruleId in RULE_GUIDANCE)) throw new Error(`unregistered boundary rule: ${ruleId}`);
  const registeredRule = ruleId as RuleId;
  const invariant = RULE_GUIDANCE[registeredRule];
  const execution = executionForRule(registeredRule, invariant);
  return structuredClone({
    ruleVersion: invariant.ruleVersion,
    expected: invariant.expected,
    impact: invariant.impact,
    safeControls: invariant.safeControls,
    correction: execution.correction,
    verification: execution.verification,
    rerun: execution.rerun,
    rerunPurpose: execution.rerunPurpose,
    sourceRefs: execution.sourceRefs,
  });
}

export function evidenceStateForRule(ruleId: string): EvidenceState {
  if (!(ruleId in RULE_EVIDENCE_STATE)) throw new Error(`unregistered boundary rule: ${ruleId}`);
  return RULE_EVIDENCE_STATE[ruleId as RuleId];
}

export function catalogRuleIds(): string[] {
  return Object.keys(RULE_GUIDANCE).sort();
}

export function ruleCatalogDigestSha256(): string {
  const canonical = Object.fromEntries(
    catalogRuleIds().map((ruleId) => [ruleId, guidanceForRule(ruleId)]),
  );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
