/**
 * branch-protection-drift-guard — detects silent changes to `main`'s branch protection.
 *
 * WHY THIS EXISTS. R-02 (required approving review on `main`) was applied by hand through
 * the GitHub API during the 2026-07-21 CI/CD audit. Nothing detected it being turned off
 * again: the setting that gates every merge was itself unprotected, and a console toggle
 * would have silently removed it with no diff, no review and no alarm. The remediation was
 * a configuration change with no enforcement behind it, which is exactly the class of gap
 * the audit was opened to close.
 *
 * Changing protection is legitimate. Changing it *silently* is not. The expectation is
 * committed at `docs/enforcement/branch-protection-expected.json`, so a deliberate change
 * updates that file in the same PR and an undeclared one becomes a finding.
 *
 * SPLIT DESIGN (deliberate). `diffProtection` is pure and takes both sides as data, so the
 * whole comparator is tested offline with no token and no network. The CLI can read a
 * captured payload, or invoke `gh api` itself for the live check:
 *
 *   node --experimental-strip-types scripts/branch-protection-drift-guard.ts --live
 *
 * Reading protection requires an admin-scoped token, which CI does not have by default, so
 * this is NOT wired into `verify:push:branch` or `quality.yml` yet. Arming it needs a
 * read-only PAT exposed as a secret; until then it runs on demand. Wiring it without the
 * token would fail every run, and a gate that always fails gets removed rather than fixed.
 *
 * FAIL-CLOSED. Empty, unparseable, or non-protection input THROWS (exit 2, inconclusive) and
 * is never reported as "no drift". `gh api` prints `{"message":"Not Found"}` when the token
 * lacks admin scope — an authorization failure wearing a 200-shaped costume — so a payload
 * without the protection fields is rejected rather than treated as an empty ruleset.
 *
 * The live command does not use a shell pipeline. It owns the `gh api` child process and
 * checks both its exit status and payload, so matching JSON followed by a producer failure
 * is still INCONCLUSIVE rather than a false clean result.
 *
 * Node builtins only.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_INCONCLUSIVE = 2;

export const EXPECTED_PROTECTION_PATH = 'docs/enforcement/branch-protection-expected.json';
export const PROTECTION_API_PATH = 'repos/LucasQuiles/WhatSoup/branches/main/protection';

export interface RequiredStatusChecks {
  strict: boolean;
  contexts: string[];
}

export interface RequiredPullRequestReviews {
  required_approving_review_count: number;
  dismiss_stale_reviews: boolean;
}

export interface ObservedProtection {
  required_status_checks: RequiredStatusChecks;
  required_pull_request_reviews: RequiredPullRequestReviews;
  enforce_admins: boolean;
  allow_force_pushes: boolean;
  allow_deletions: boolean;
  required_linear_history: boolean;
  required_conversation_resolution: boolean;
}

export interface ExpectedProtection extends ObservedProtection {
  branch: string;
}

export interface ProtectionDrift {
  field: string;
  expected: string;
  observed: string;
  detail: string;
}

/** GitHub nests most booleans as `{ enabled: boolean }`; the comparator wants plain ones. */
function unwrapEnabled(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && typeof (value as { enabled?: unknown }).enabled === 'boolean') {
    return (value as { enabled: boolean }).enabled;
  }
  throw new Error(`observed protection field '${field}' is missing or not a boolean (inconclusive)`);
}

/**
 * Parse the observed side. Throws — never returns a partial object — because every failure
 * here means "I could not determine the protection state", which must surface as
 * inconclusive rather than as an empty ruleset that happens to differ from expectations.
 */
export function parseObservedProtection(raw: string): ObservedProtection {
  if (raw.trim() === '') {
    throw new Error('no observed protection input (empty) — inconclusive, refusing to report "no drift"');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`could not parse observed protection as JSON (inconclusive): ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('observed protection is not a JSON object (inconclusive)');
  }
  const record = parsed as Record<string, unknown>;

  const checks = record.required_status_checks;
  if (!checks || typeof checks !== 'object') {
    // This is the `{"message":"Not Found"}` case: a token without admin scope.
    throw new Error(
      'observed payload has no required_status_checks — this is usually a token without admin ' +
        'scope returning {"message":"Not Found"}, not a branch without protection (inconclusive)',
    );
  }
  const contexts = (checks as { contexts?: unknown }).contexts;
  if (!Array.isArray(contexts) || contexts.some((c) => typeof c !== 'string')) {
    throw new Error('observed required_status_checks.contexts is missing or not a string list (inconclusive)');
  }
  const reviews = record.required_pull_request_reviews;
  if (!reviews || typeof reviews !== 'object') {
    throw new Error('observed payload has no required_pull_request_reviews (inconclusive)');
  }
  const count = (reviews as { required_approving_review_count?: unknown }).required_approving_review_count;
  if (typeof count !== 'number') {
    throw new Error('observed required_approving_review_count is missing or not a number (inconclusive)');
  }

  return {
    required_status_checks: {
      strict: unwrapEnabled((checks as { strict?: unknown }).strict, 'required_status_checks.strict'),
      contexts: [...contexts] as string[],
    },
    required_pull_request_reviews: {
      required_approving_review_count: count,
      dismiss_stale_reviews: unwrapEnabled(
        (reviews as { dismiss_stale_reviews?: unknown }).dismiss_stale_reviews,
        'required_pull_request_reviews.dismiss_stale_reviews',
      ),
    },
    enforce_admins: unwrapEnabled(record.enforce_admins, 'enforce_admins'),
    allow_force_pushes: unwrapEnabled(record.allow_force_pushes, 'allow_force_pushes'),
    allow_deletions: unwrapEnabled(record.allow_deletions, 'allow_deletions'),
    required_linear_history: unwrapEnabled(record.required_linear_history, 'required_linear_history'),
    required_conversation_resolution: unwrapEnabled(
      record.required_conversation_resolution,
      'required_conversation_resolution',
    ),
  };
}

export function loadExpectedProtection(repoRoot: string = process.cwd()): ExpectedProtection {
  const file = path.join(repoRoot, EXPECTED_PROTECTION_PATH);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    // A missing expectation is not "nothing to compare"; it is an unchecked invariant.
    throw new Error(`cannot read the committed expectation at ${EXPECTED_PROTECTION_PATH} (inconclusive): ${(err as Error).message}`);
  }
  const parsed = JSON.parse(raw) as ExpectedProtection & { $comment?: unknown };
  delete (parsed as { $comment?: unknown }).$comment;
  return parsed;
}

function compareBoolean(field: string, expected: boolean, observedValue: boolean): ProtectionDrift | null {
  if (expected === observedValue) return null;
  return {
    field,
    expected: String(expected),
    observed: String(observedValue),
    detail: `${field}: expected ${String(expected)}, observed ${String(observedValue)}`,
  };
}

/**
 * Compare observed protection against the committed expectation.
 *
 * Contexts are compared as SETS — order is not meaningful to GitHub — but both directions
 * count. A removed check is the obvious regression; an ADDED one is also drift, because it
 * is a change nobody recorded. It may be entirely correct, and the fix is then a one-line
 * update to the expectation, which is exactly the review trail this guard exists to force.
 */
export function diffProtection(expected: ExpectedProtection, observedValue: ObservedProtection): ProtectionDrift[] {
  const findings: ProtectionDrift[] = [];

  const expectedContexts = [...expected.required_status_checks.contexts].sort();
  const observedContexts = [...observedValue.required_status_checks.contexts].sort();
  const missing = expectedContexts.filter((c) => !observedContexts.includes(c));
  const added = observedContexts.filter((c) => !expectedContexts.includes(c));
  if (missing.length > 0 || added.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`no longer required: ${missing.join(', ')}`);
    if (added.length > 0) parts.push(`newly required but not recorded: ${added.join(', ')}`);
    findings.push({
      field: 'required_status_checks.contexts',
      expected: expectedContexts.join(', '),
      observed: observedContexts.join(', '),
      detail: `required_status_checks.contexts drifted — ${parts.join('; ')}`,
    });
  }

  const strict = compareBoolean(
    'required_status_checks.strict',
    expected.required_status_checks.strict,
    observedValue.required_status_checks.strict,
  );
  if (strict) findings.push(strict);

  const expectedCount = expected.required_pull_request_reviews.required_approving_review_count;
  const observedCount = observedValue.required_pull_request_reviews.required_approving_review_count;
  if (expectedCount !== observedCount) {
    findings.push({
      field: 'required_pull_request_reviews.required_approving_review_count',
      expected: String(expectedCount),
      observed: String(observedCount),
      detail:
        `required_approving_review_count: expected ${expectedCount}, observed ${observedCount}` +
        (observedCount === 0 ? ' — R-02 has been removed; merges no longer require a review' : ''),
    });
  }

  const dismiss = compareBoolean(
    'required_pull_request_reviews.dismiss_stale_reviews',
    expected.required_pull_request_reviews.dismiss_stale_reviews,
    observedValue.required_pull_request_reviews.dismiss_stale_reviews,
  );
  if (dismiss) findings.push(dismiss);

  for (const field of [
    'enforce_admins',
    'allow_force_pushes',
    'allow_deletions',
    'required_linear_history',
    'required_conversation_resolution',
  ] as const) {
    const drift = compareBoolean(field, expected[field], observedValue[field]);
    if (drift) findings.push(drift);
  }

  return findings;
}

export function summarize(findings: ProtectionDrift[]): string {
  if (findings.length === 0) return 'branch-protection-drift-guard: no drift (matches docs/enforcement/branch-protection-expected.json)';
  return [
    `branch-protection-drift-guard: ${findings.length} drift finding(s) against ${EXPECTED_PROTECTION_PATH}:`,
    ...findings.map((f) => `  ${f.detail}`),
    '',
    'If the change was deliberate, update the committed expectation in the same PR so the',
    'new intent is reviewed. If it was not, restore the setting on GitHub.',
  ].join('\n');
}

function readObservedArg(argv: string[]): string {
  const live = argv.includes('--live');
  const idx = argv.indexOf('--observed');
  if (live && idx !== -1) {
    throw new Error('use exactly one observed source: --live or --observed <file|-> (inconclusive)');
  }
  if (live) {
    const result = spawnSync('gh', ['api', PROTECTION_API_PATH], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.error) {
      throw new Error(`GitHub protection query could not start (inconclusive): ${result.error.message}`);
    }
    if (result.status !== 0) {
      const outcome = result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`;
      throw new Error(`GitHub protection query failed with ${outcome} (inconclusive)`);
    }
    return result.stdout;
  }
  if (idx === -1 || argv[idx + 1] === undefined) {
    throw new Error(
      'usage: branch-protection-drift-guard (--live | --observed <file|->) ' +
        '(inconclusive without input)',
    );
  }
  const source = argv[idx + 1];
  return source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
}

function main(argv: string[]): void {
  let findings: ProtectionDrift[];
  try {
    findings = diffProtection(loadExpectedProtection(), parseObservedProtection(readObservedArg(argv)));
  } catch (err) {
    // Inconclusive is its own outcome. It is deliberately NOT exit 1: "I could not tell"
    // must never be indistinguishable from "I checked and it drifted".
    process.stderr.write(`branch-protection-drift-guard: INCONCLUSIVE — ${(err as Error).message}\n`);
    process.exitCode = EXIT_INCONCLUSIVE;
    return;
  }
  if (findings.length === 0) {
    console.log(summarize(findings));
    return;
  }
  console.error(summarize(findings));
  process.exitCode = EXIT_DRIFT;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
