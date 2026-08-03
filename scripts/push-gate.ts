#!/usr/bin/env node
/**
 * Declarative push-gate manifest + tiny runner (#2224).
 *
 * Replaces the ~5KB single-line `&&`-chained shell strings that
 * `verify:push:branch` / `verify:release` used to be. Orchestration logic no
 * longer lives as data in package.json: every step is one reviewable line in
 * an ordered array, the curated test list is one path per line, and the
 * runner reports per-step timing with fail-fast attribution.
 *
 * Behavior parity with the legacy strings is the contract:
 *  - same steps, same order (including verify:semantic:shadow's position
 *    mid-guard-block and the trailing scope print);
 *  - same fail-fast semantics (first non-zero exit aborts the pipeline);
 *  - the legacy `unset WHATSOUP_SKIP_*` preamble is preserved by deleting
 *    those variables from the environment before any step spawns.
 *
 * Registry discipline (enforced by tests/scripts/push-gate-manifest.test.ts):
 * every `guard:*` script in package.json is either a step in one of the two
 * pipelines or explicitly listed in CI_ONLY_GUARDS with a reason — a silent
 * gate-drop is a test failure, not a scrolling accident.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cleanGitEnv } from '../src/lib/git-env.ts';

export interface GateStep {
  readonly name: string;
  readonly cmd: string;
}

/** Legacy `unset` preamble, preserved as an environment mutation in main(). */
export const NEUTRALIZED_SKIP_VARS = [
  'WHATSOUP_SKIP_DOC_DRIFT',
  'WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT',
  'WHATSOUP_SKIP_NODE_PIN_CHECK',
  'WHATSOUP_SKIP_BOUNDARY_CHECK',
] as const;

/**
 * The curated test list the branch gate runs as a single vitest invocation.
 * One path per line so additions are reviewable diffs. Every entry is
 * asserted to exist on disk by the registry test (silent drift = failure).
 */
export const CURATED_TEST_PATHS = [
  'tests/redaction-parity.test.ts',
  'tests/scripts/check-commit-identity.test.ts',
  'tests/scripts/repo-hygiene-guard.test.ts',
  'tests/scripts/pre-push-alignment.test.ts',
  'tests/scripts/pre-push-guard.test.ts',
  'tests/scripts/pr-metadata-guard.test.ts',
  'tests/scripts/ci-control-ref-policy.test.ts',
  'tests/scripts/ci-control-classifier.test.ts',
  'tests/scripts/hooks-installed-guard.test.ts',
  'tests/scripts/ci-control-result.test.ts',
  'tests/scripts/git-estate-guard.test.ts',
  'tests/scripts/source-runtime-drift-check.test.ts',
  'tests/scripts/claude-settings-guard.test.ts',
  'tests/scripts/agent-decision-polls-guard.test.ts',
  'tests/scripts/safeguard-diagnostics.test.ts',
  'tests/scripts/check-fleet-bot-hardening-parity.test.ts',
  'tests/scripts/bot-errors-simulation-matrix.test.ts',
  'tests/scripts/check-bot-errors-runtime-manifest.test.ts',
  'tests/scripts/bot-errors-critical-surface-audit.test.ts',
  'tests/scripts/doc-drift-check.test.ts',
  'tests/scripts/public-surface-drift-check.test.ts',
  'tests/scripts/arc-binding-drift-check.test.ts',
  'tests/scripts/drift-skip-ci-gating.test.ts',
  'tests/scripts/work-index.test.ts',
  'tests/scripts/guard-doc-tally.test.ts',
  'tests/scripts/node-pin-consistency.test.ts',
  'tests/scripts/clock-budget.test.ts',
  'tests/scripts/db-read-prefix-budget.test.ts',
  'tests/scripts/expect-anything-budget.test.ts',
  'tests/scripts/fail-closed-gate-guard.test.ts',
  'tests/scripts/shell-node-integer-capture-guard.test.ts',
  'tests/scripts/durability-writer-guard.test.ts',
  'tests/scripts/tmpdir-helper-migration.test.ts',
  'tests/scripts/grant-resolver-inventory-guard.test.ts',
  'tests/scripts/ssot-pattern-guard.test.ts',
  'tests/scripts/ring-boundary-guard.test.ts',
  'tests/scripts/check-service-units.test.ts',
  'tests/scripts/check-insecure-tempfile.test.ts',
  'tests/scripts/check-zero-byte-tracked.test.ts',
  'tests/scripts/no-destructive-git-guard.test.ts',
  'tests/scripts/nonempty-string-ratchet.test.ts',
  'tests/scripts/nonempty-string-trim-length-ratchet.test.ts',
  'tests/scripts/guards-refuse-empty-scope.test.ts',
  'tests/scripts/guards-refuse-empty-scope-all.test.ts',
  'tests/scripts/guard-command-resolver.test.ts',
  'tests/scripts/baseline-growth-guard.test.ts',
  'tests/scripts/baseline-weight.test.ts',
  'tests/scripts/import-cycle-guard.test.ts',
  'tests/scripts/module-cycles.test.ts',
  'tests/scripts/phantom-dependency-guard.test.ts',
  'tests/scripts/dependency-declarations.test.ts',
  'tests/scripts/orphan-reachability-guard.test.ts',
  'tests/scripts/orphan-export-guard.test.ts',
  'tests/scripts/agent-lease.test.ts',
  'tests/scripts/check-instance-config.test.ts',
  'tests/scripts/check-coverage-headroom.test.ts',
  'tests/scripts/design-system-hygiene-guard.test.ts',
  'tests/scripts/harness-maintenance-guard.test.ts',
  'tests/scripts/logger-mock-residue.test.ts',
  'tests/scripts/publication-guard.test.ts',
  'tests/scripts/guard-test-coverage-check.test.ts',
  'tests/deploy/preflight-check.test.ts',
  'tests/scripts/import-boundary-check.test.ts',
  'tests/scripts/transport-pattern-check.test.ts',
  'tests/scripts/check-hardcoded-tmpdir.test.ts',
  'tests/scripts/eslint-fitness-check.test.ts',
  'tests/scripts/fitness-registry.test.ts',
  'tests/scripts/fitness-file-size-warning-budget.test.ts',
  'tests/lib/provider-key-service.test.ts',
  'tests/core/agent-config-validator-crossfield.test.ts',
  'tests/runtimes/agent/providers/credential-verify.test.ts',
  'tests/lib/api-key-resolver.test.ts',
  'tests/lib/provider-service-doc-sync.test.ts',
  'tests/console/credential-routing.test.ts',
  'tests/console/wizard-finish.test.ts',
  'tests/lib/config-plaintext-keys.test.ts',
  'tests/fleet/routes/ops-plaintext-key-strip.test.ts',
  'tests/scripts/generate-catch-ratchet.test.ts',
  'tests/eslint-rules/require-catch-justification.test.ts',
  // The manifest's own registry test dogfoods into the gate.
  'tests/scripts/push-gate-manifest.test.ts',
] as const;

const guard = (name: string): GateStep => ({ name, cmd: `npm run ${name}` });
const step = (name: string, cmd: string): GateStep => ({ name, cmd });

/** verify:push:branch — exact legacy order (semantic:shadow sits mid-block). */
export const BRANCH_STEPS: readonly GateStep[] = [
  guard('guard:repo:staged'),
  guard('guard:repo:branch-diff'),
  guard('guard:repo:commit-authors'),
  guard('guard:publication:staged'),
  guard('guard:doc-drift'),
  guard('guard:public-surface-drift'),
  guard('guard:work-index'),
  guard('guard:doc-tally'),
  guard('guard:node-pin-consistency'),
  guard('guard:source-runtime-drift'),
  guard('guard:arc-binding-drift'),
  guard('guard:fleet-bot-hardening-parity'),
  guard('guard:bot-errors-runtime-manifest'),
  guard('guard:bot-errors-critical-surface'),
  guard('guard:deployer-static'),
  guard('guard:bot-errors-simulation-matrix'),
  guard('guard:claude-settings'),
  guard('guard:agent-decision-polls'),
  guard('guard:safeguard-diagnostics'),
  step('verify:semantic:shadow', 'npm run verify:semantic:shadow'),
  guard('guard:test-integrity'),
  guard('guard:boundaries'),
  guard('guard:transport-patterns'),
  guard('guard:platform-patterns'),
  guard('guard:ssot-patterns'),
  guard('guard:ring-boundary-ratchet'),
  guard('guard:fail-closed-gate'),
  guard('guard:durability-writer'),
  guard('guard:service-units'),
  guard('guard:insecure-tempfile'),
  guard('guard:zero-byte-tracked'),
  guard('guard:no-destructive-git'),
  guard('guard:baseline-growth'),
  guard('guard:catch-ratchet'),
  guard('guard:import-cycle'),
  guard('guard:phantom-deps'),
  guard('guard:grant-resolver'),
  guard('guard:instance-config'),
  guard('guard:guard-test-coverage'),
  guard('guard:lint:src'),
  step('typecheck:all', 'npm run typecheck:all'),
  step('typecheck:scripts', 'npm run typecheck:scripts'),
  step('curated-tests', `npm test -- ${CURATED_TEST_PATHS.join(' ')} --pool=forks`),
  step('verify:console-design', 'npm run verify:console-design'),
  guard('guard:design-system-hygiene'),
  guard('guard:harness-maintenance'),
  step('test:tokenomics', 'npm run test:tokenomics'),
  step('console-lint', 'bash scripts/run-with-pinned-npm.sh --prefix console run lint'),
  step('console-build', 'bash scripts/run-with-pinned-npm.sh --prefix console run build'),
  step('push-gate-scope', 'bash scripts/print-push-gate-scope.sh'),
];

/** verify:release — exact legacy order. */
export const RELEASE_STEPS: readonly GateStep[] = [
  guard('guard:repo:release-hygiene'),
  guard('guard:repo:commit-authors'),
  guard('guard:publication:all'),
  guard('guard:doc-drift'),
  guard('guard:public-surface-drift'),
  guard('guard:work-index'),
  guard('guard:doc-tally'),
  guard('guard:node-pin-consistency'),
  guard('guard:source-runtime-drift'),
  guard('guard:arc-binding-drift'),
  guard('guard:fleet-bot-hardening-parity'),
  guard('guard:bot-errors-runtime-manifest'),
  guard('guard:bot-errors-simulation-matrix'),
  guard('guard:claude-settings'),
  guard('guard:agent-decision-polls'),
  guard('guard:safeguard-diagnostics'),
  step('verify:semantic:shadow', 'npm run verify:semantic:shadow'),
  guard('guard:test-integrity:required'),
  guard('guard:boundaries'),
  guard('guard:fail-closed-gate'),
  guard('guard:durability-writer'),
  guard('guard:service-units'),
  guard('guard:insecure-tempfile'),
  guard('guard:zero-byte-tracked'),
  guard('guard:platform-patterns'),
  guard('guard:no-destructive-git'),
  guard('guard:catch-ratchet'),
  guard('guard:grant-resolver'),
  guard('guard:instance-config'),
  guard('guard:guard-test-coverage'),
  guard('guard:lint:src'),
  step('test:tokenomics', 'npm run test:tokenomics'),
  step('test:drills', 'npm run test:drills'),
  step('whatsoup-guard-ci', 'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard ci'),
  step('whatsoup-guard-typecheck', 'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard run typecheck'),
  step('whatsoup-guard-test', 'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard test'),
  step('console-ci', 'bash scripts/run-with-pinned-npm.sh --prefix console ci'),
  step('console-lint', 'bash scripts/run-with-pinned-npm.sh --prefix console run lint'),
  step('typecheck:all', 'npm run typecheck:all'),
  step('coverage:check', 'npm run coverage:check -- --pool=forks --fileParallelism=false'),
  step('console-build', 'bash scripts/run-with-pinned-npm.sh --prefix console run build'),
  step('verify:console-design:live', 'npm run verify:console-design:live'),
  step('verify:console-browser', 'npm run verify:console-browser'),
];

/**
 * package.json `guard:*` scripts that are deliberately NOT push-gate steps.
 * The registry test fails if a guard script lands in package.json without
 * joining a pipeline or this list (silent gate-drop prevention).
 */
export const CI_ONLY_GUARDS: ReadonlyArray<{ readonly name: string; readonly reason: string }> = [
  { name: 'guard:agent-iteration-review', reason: 'agent-lane reviewer tooling, not a push gate' },
  { name: 'guard:branch-protection-drift', reason: 'queries live GitHub branch protection; network-bound, CI-only' },
  { name: 'guard:branch-retirement', reason: 'scheduled repo-lifecycle sweep in CI' },
  { name: 'guard:coverage-headroom', reason: 'coverage lane; equivalent runs in the gate via its curated test path' },
  { name: 'guard:drift-coverage', reason: 'CI drift-coverage analysis lane' },
  { name: 'guard:git-estate', reason: 'long-running estate sweep; equivalent runs in the gate via its curated test path' },
  { name: 'guard:hardcoded-tmpdir', reason: 'equivalent runs in the gate via its curated test path' },
  { name: 'guard:hooks-installed', reason: 'equivalent runs in the gate via its curated test path' },
  { name: 'guard:launchd-drift', reason: 'macOS launchd lane; platform-specific CI' },
  { name: 'guard:pr-metadata', reason: 'CI workflow step on pull_request; equivalent runs in the gate via its curated test path' },
  { name: 'guard:pre-push', reason: 'hook-lane umbrella alias; the manifest is the gate' },
  { name: 'guard:publication', reason: 'umbrella entry point, not a push-gate step' },
  { name: 'guard:publication:release', reason: 'release-lane entry point, not a push-gate step' },
  { name: 'guard:publication:write', reason: 'publication mutation lane, not a push-gate step' },
  { name: 'guard:repo', reason: 'umbrella entry point, not a push-gate step' },
  { name: 'guard:repo:commit-msg', reason: 'commit-msg hook lane, not a push-gate step' },
  { name: 'guard:repo:scan-history', reason: 'history-scan sweep in CI' },
  { name: 'guard:restart-preflight', reason: 'deploy/restart lane, not a push-gate step' },
  { name: 'guard:ring-boundaries', reason: 'CI ring check; the ratchet variant runs in the gate' },
  { name: 'guard:semantic-quality', reason: 'CI semantic-quality lane' },
  { name: 'guard:unit-drift', reason: 'CI unit-drift lane' },
  { name: 'guard:worker-artifacts', reason: 'CI worker-artifact audit lane' },
];

/**
 * Explicit allowlisted child env (repo-hygiene: no process.env inheritance).
 * Base is the repo's git-child allowlist (PATH/HOME/TMPDIR/XDG/…); WHATSOUP_*
 * vars pass through EXCEPT the neutralized skip-vars — which implements the
 * legacy `unset WHATSOUP_SKIP_*` preamble structurally rather than by
 * mutation: the skips simply never reach the children.
 */
export function pushGateChildEnv(): NodeJS.ProcessEnv {
  const env = cleanGitEnv();
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith('WHATSOUP_')
      && value !== undefined
      && !(NEUTRALIZED_SKIP_VARS as readonly string[]).includes(key)
    ) {
      env[key] = value;
    }
  }
  return env;
}

function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds.toFixed(1)}s`;
}

/**
 * Steps execute WITHOUT a shell (repo-hygiene: shell mode requires a reviewed
 * exception, and this runner needs none). Every manifest cmd is
 * whitespace-tokenizable by construction — the registry test ratchets the
 * no-shell-metacharacters invariant so a future step that would NEED a
 * shell fails review instead of silently reintroducing shell mode.
 */
function tokenize(cmd: string): { exe: string; args: string[] } {
  const tokens = cmd.split(' ').filter((token) => token.length > 0);
  const [exe, ...args] = tokens;
  if (!exe) throw new Error(`push-gate: empty step command`);
  return { exe, args };
}

function runStep(gateStep: GateStep): Promise<number> {
  return new Promise((resolvePromise) => {
    const { exe, args } = tokenize(gateStep.cmd);
    const child = spawn(exe, args, {
      stdio: 'inherit',
      env: pushGateChildEnv(),
    });
    child.on('close', (code) => resolvePromise(code ?? 1));
    child.on('error', () => resolvePromise(1));
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const lane = argv[0];
  const steps = lane === 'branch' ? BRANCH_STEPS : lane === 'release' ? RELEASE_STEPS : undefined;
  if (!steps) {
    console.error('Usage: push-gate.ts <branch|release>');
    return 64;
  }

  const startedAt = Date.now();
  let completed = 0;
  for (const gateStep of steps) {
    const stepStarted = Date.now();
    const code = await runStep(gateStep);
    const elapsed = Date.now() - stepStarted;
    if (code !== 0) {
      console.error(
        `push-gate(${lane}): FAIL at step ${completed + 1}/${steps.length}`
          + ` [${gateStep.name}] after ${formatElapsed(elapsed)} (exit ${code});`
          + ` ${steps.length - completed - 1} step(s) not run`,
      );
      return 1;
    }
    completed += 1;
    console.log(`push-gate(${lane}): [${completed}/${steps.length}] ${gateStep.name} ok (${formatElapsed(elapsed)})`);
  }

  console.log(
    `push-gate(${lane}): ${completed}/${steps.length} steps passed in ${formatElapsed(Date.now() - startedAt)}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`push-gate: runner fault: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    },
  );
}
