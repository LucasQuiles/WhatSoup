import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  catalogRuleIds,
  evidenceStateForRule,
  guidanceForRule,
  ruleCatalogDigestSha256,
} from '../../scripts/lib/semantic-quality/rule-guidance.ts';

const CURRENT_RULES = [
  'boundary.action-identity-unproven',
  'boundary.contract-invalid',
  'boundary.evidence-incomplete',
  'boundary.evidence-volume-exceeded',
  'boundary.finding-identity-conflict',
  'boundary.artifact-identity-conflict',
  'boundary.timeout',
  'semantic.production-reachability',
  'semantic.export-ownership',
  'semantic.unresolved-runtime-edge',
  'semantic.invalid-allowlist',
  'semantic.candidate-unavailable',
  'semantic.policy-unavailable',
  'semantic.source-tree-unavailable',
  'semantic.analysis-unavailable',
  'semantic.invocation-invalid',
  'semantic.receipt-write-failed',
  'semantic.guard-negative-control',
  'supply-chain.mutable-action',
  'supply-chain.mutable-image',
  'supply-chain.floating-runner',
  'process.unbounded-primitive',
  'history.evidence-incomplete',
  'history.exact-open-pr',
  'history.exact-merged-pr',
  'history.exact-closed-pr',
  'history.renamed-patch-closed-pr',
  'history.blob-subset',
  'history.path-overlap',
  'history.exact-issue',
  'history.incomplete-reentry',
  'provenance.unavailable',
  'provenance.stale-tracking-ref',
  'provenance.stale-overlap',
  'provenance.stale-disjoint',
] as const;

function assertCorrectiveGuidance(ruleId: (typeof CURRENT_RULES)[number]): void {
  const guidance = guidanceForRule(ruleId);
  expect(guidance.ruleVersion).toBe(1);
  for (const values of [guidance.expected, guidance.impact, guidance.safeControls]) {
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value.trim().length >= 12)).toBe(true);
  }
  expect(guidance.correction.length).toBeGreaterThanOrEqual(2);
  expect(guidance.correction.length).toBeLessThanOrEqual(4);
  expect(guidance.correction.every((step) =>
    step.target.trim().length >= 12 && step.expected.trim().length >= 24,
  )).toBe(true);
  expect(guidance.verification.length).toBeGreaterThan(0);
  expect(guidance.verification.every((step) =>
    step.command.trim().length > 0
    && step.args.length > 0
    && step.expected.trim().length >= 12,
  )).toBe(true);
  expect(guidance.rerun.command.trim().length).toBeGreaterThan(0);
  expect(guidance.rerun.args.length).toBeGreaterThan(0);
  expect(guidance.rerunPurpose).toMatch(/^(integration-boundary|focused-family-replay)$/);
  expect(guidance.sourceRefs.length).toBeGreaterThan(0);
  expect(guidance.sourceRefs.every((source) =>
    /^(?:scripts|tests|docs|config)\/[A-Za-z0-9._/-]+(?::\d+)?$|^boundary-contract:[a-z0-9-]+$/.test(source),
  )).toBe(true);
  expect(guidance.sourceRefs.every((source) =>
    source.startsWith('boundary-contract:') || existsSync(source.replace(/:\d+$/, '')),
  )).toBe(true);
  expect(evidenceStateForRule(ruleId)).toMatch(/^(observed|absent|invalid|unavailable|stale|unknown)$/);
  const prose = JSON.stringify(guidance).toLowerCase();
  expect(prose).not.toMatch(/"(?:fix it|fix this|retry|run tests|npm test|check logs|do better)"/);
  for (const command of guidance.verification) {
    expect(command.command).toBe('bash');
    expect(command.args[0]).toMatch(/^scripts\/run-with-pinned-(?:npm|node)\.sh$/);
    expect(existsSync(command.args[0]!)).toBe(true);
    const testFile = command.args.find((arg) => arg.startsWith('tests/'));
    expect(testFile && existsSync(testFile)).toBe(true);
  }
  expect(guidance.rerun.command).toBe('bash');
  expect(guidance.rerun.args[0]).toMatch(/^scripts\/run-with-pinned-(?:npm|node)\.sh$/);
  expect(existsSync(guidance.rerun.args[0]!)).toBe(true);
  const rerunTestFile = guidance.rerun.args.find((arg) => arg.startsWith('tests/'));
  if (rerunTestFile) expect(existsSync(rerunTestFile)).toBe(true);
  else expect(guidance.rerun.args).toContain('guard:semantic-quality');
}

describe('boundary rule guidance', () => {
  it('[BCF02-U01] returns guidance for a registered rule', () => {
    expect(
      () => guidanceForRule('boundary.action-identity-unproven'),
      'BCF_EXPECTATION_UNMET:BCF02-01',
    ).not.toThrow();
  });

  it('[BCF02-U02] rejects an unregistered rule with the closed error', () => {
    expect(
      () => guidanceForRule('unknown.rule'),
      'BCF_EXPECTATION_UNMET:BCF02-02',
    ).toThrow(/unregistered boundary rule/i);
  });

  it('[BCF02-U03] emits a stable SHA-256 catalog digest', () => {
    expect(
      () => ruleCatalogDigestSha256(),
      'BCF_EXPECTATION_UNMET:BCF02-03',
    ).not.toThrow();
  });

  it('[BCF02-U04] covers the complete frozen rule set', () => {
    expect(
      catalogRuleIds(),
      'BCF_EXPECTATION_UNMET:BCF02-04',
    ).toEqual([...CURRENT_RULES].sort());
  });

  it('[BCF02-S01] exposes the compile-safe catalog surface', () => {
    expect([
      catalogRuleIds,
      evidenceStateForRule,
      guidanceForRule,
      ruleCatalogDigestSha256,
    ].every((value) => typeof value === 'function')).toBe(true);
  });

  it('[BCF02-N01] validates every registered rule and keeps catalog IDs sorted', () => {
    for (const ruleId of CURRENT_RULES) assertCorrectiveGuidance(ruleId);
    expect(catalogRuleIds()).toEqual([...catalogRuleIds()].sort());
  });

  it('[BCF02-N02] returns detached guidance records', () => {
    const first = guidanceForRule('boundary.action-identity-unproven');
    first.expected.push('mutated caller-owned value');
    expect(guidanceForRule('boundary.action-identity-unproven').expected).not.toContain(
      'mutated caller-owned value',
    );
  });

  it('[BCF02-N03] maps a registered rule to its closed evidence state', () => {
    expect(evidenceStateForRule('boundary.action-identity-unproven')).toBe('absent');
  });

  it('[BCF02-N04] keeps the frozen rule set duplicate-free', () => {
    expect(new Set(CURRENT_RULES).size).toBe(CURRENT_RULES.length);
  });
});
