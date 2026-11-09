# Testing paths

Use the Node version in `.nvmrc` and install the root dependencies with `npm ci`.
Install `console` dependencies before root suites that exercise console lint or build
fixtures. The guard package has its own install under `tools/whatsoup_guard`.

## Choose work before starting workers

```sh
npm run --silent test:plan -- --base origin/main --json
npm run --silent test:affected -- --base origin/main --max-workers 2 --json

# Explicit source paths for an iteration:
npm run --silent test:plan -- --files src/lib/short-hash.ts --json
npm run --silent test:affected -- --files src/lib/short-hash.ts --timeout-ms 120000 --json

# A specific regression, using the existing full-suite battery:
npm test -- tests/lib/short-hash.test.ts --maxWorkers=1

# Full root coverage, with the existing floors and console coverage check:
npm run --silent test:affected -- --full --suite root --coverage --timeout-ms 2700000

# Existing local release gate, including the guard package:
npm run --silent test:affected -- --full --timeout-ms 3600000
```

`test:plan` is read-only and runs without application dependencies. JSON includes
the profile, changed paths, reasons, resolved base/head, selected lanes and limits.
It compares the merge base with the worktree, including staged, unstaged and
untracked files. `--files` accepts space-separated repository paths and cannot
be combined with `--base`. Unknown arguments and invalid refs fail visibly.

| Profile | Selection |
| --- | --- |
| `docs` | Allowlisted Markdown only; CI runs documentation checks without application installs or Docker. |
| `affected` | Eligible library, memory, console or guard source. Root tests use Vitest's transitive import graph plus the existing text-reference companion search. Console changes also run lint, build, design and both browser configurations. |
| `full` | Security, identity, authorization, persistence, runtime lifecycle, dependencies, configuration, tests, scripts, deployment, renames/deletions, fixtures, unknown inputs or explicit `--full`/`--coverage`. |

The selection policy lives in `scripts/lib/test-selection-policy.ts`. The old
`triage:required-suites` command remains an informational union of functional and
fitness suites; malformed input now exits nonzero. It also recognizes TSX tests.
Before selecting affected work, the planner validates the existing BOT ERRORS
runtime manifest, including required paths, hashes and markers. Deployed library
inputs select full validation because Python parity tests also consume them.
Missing or invalid manifest evidence selects full validation.

Activate the workflow split only after `pr metadata` and the trusted
`test-integrity (private)` check have run on a candidate and an authorized
operator has added them to `main` branch protection.
Run `npm run guard:branch-protection-drift` against the live settings and require
agreement with `docs/enforcement/branch-protection-expected.json` before merging.
The committed expectation is not an applied GitHub setting. PR metadata is checked
on PR events, including edits; merge groups rely on those PR checks before admission
and receive the required metadata context without pretending to have a PR body.
To roll back, restore the full Quality workflow's metadata enforcement before
removing the separate requirement; keep both checks available during that transition.

Private scanning runs from the default branch after Quality completes. Quality
never receives its deploy key. Main and scheduled scans bind exact commits;
tag scans also validate the tag target and main ancestry. The tag release gate
accepts an advancing main only after ancestry is verified again; the scanned
commit, first-parent baseline, tag target and run attempt must remain unchanged. It
waits for a small receipt from the authenticated private workflow and verifies
both run attempts and the source SHA. Missing, failed or stale evidence cannot
complete a release. This ordering avoids waiting for a scanner that itself
waits for Quality to finish. See the [cutover checklist](contributing/quality-guardrails-checklist.md).
After correcting a scanner infrastructure failure, rerun its workflow and then the
tag receipt consumer. The scanner replaces its own prior receipt, and the consumer
requires the new artifact identity and current scanner attempt. This recovery does
not require rerunning unchanged Quality tests. A changed Quality attempt or source
commit still requires fresh matching validation. Receipts expire after thirty days.

Vitest can follow static and literal dynamic imports. It cannot prove arbitrary
computed imports or filesystem dependencies. Fixture and configuration changes
therefore select full validation; the text-reference search preserves existing
non-import companions. A no-tests result is a failure. New runtime dependency
patterns need a policy update or full validation, rather than a skip flag.

## Limits and truthful results

`--suite root|console|browser|guard|python` focuses one local lane. The report
names omitted lanes and CI obligations; it does not claim a complete merge gate.
The release manifest already runs the guard package once. CI additionally owns
the complete Python sentinel/behavioral gates, Docker and Node compatibility;
the report lists those obligations. `--suite python` runs both the curated
sentinel gate and the remaining behavioral suite that excludes those files.
`npm test` and `coverage:check` retain their existing full behavior. Coverage
requests always use the complete root suite and preserve 95% lines, 90% branches
and 93% functions. Browser and motion configurations remain separate.
Changes under `tools/whatsoup_guard/**` also run the standalone `whatsoup-guard`
Node 25 compatibility lane. Quality owns Node 24 guard typechecking and tests;
the standalone workflow does not repeat that version.

Affected execution defaults to two workers and a two-minute total budget. Full
validation defaults to thirty minutes. `--max-workers` accepts 1–4; browser
execution stays at one. `--timeout-ms` is a total budget, including admission.
The existing battery kills the child's process group at the bound and records
cleanup uncertainty. This is separate from Vitest's per-test timeout.
Maintained nested runners verify their enclosing battery's live process ancestry
and share its group, so an outer cancellation does not strand another detached
test tree. Missing or stale ownership evidence refuses nested execution.

`test:affected` refuses a second run in the same checkout immediately. It reports
the lock owner PID and never steals a live or ambiguous lock. Inspect the owner
before retrying. Where the host provides `~/.local/bin/loadgate`, admission is
strict with a maximum thirty-second wait. Other hosts report `local-limits-only`.
Do not increase the shared host cap to get past contention.

| Exit | Meaning |
| --- | --- |
| 0 | Selected work passed, or documentation has no application work. |
| 1 / child nonzero | A check failed; the child exit is preserved. |
| 2 | Invalid CLI input. |
| 75 | Busy; no additional run should be queued automatically. |
| 124 | Timeout; validation is incomplete. |
| 125 | Unavailable planning evidence, inconclusive execution/cleanup or missing/empty test report. |

With `--json`, stdout contains one document and child diagnostics remain on stderr.
Use `npm run --silent` as above to suppress npm's own non-JSON command banner.
Reports include each command's outcome and duration. Direct Vitest steps also
report files, passed/failed/pending tests from the actual runner report. Push and
release gates report a terminated child's PID and signal, preserve `128 + signal`
exits, and return 125 when an executable cannot start. Direct Vitest steps
with an all-skipped or missing report cannot become a successful affected run. Counts
measure execution, not assertion quality or exact semantic coverage.

The runner creates and removes its own scratch `TMPDIR`. Tests should use
`tests/helpers/tmp-dir.ts`, `tmp_path`, `TemporaryDirectory`, or registered cleanup.
Do not put scratch output in a durable evidence directory. The source-mutation
tripwire fails on a changed or missing `src/main.ts`, including changes before
a worker starts against the parent-provided SHA-256 anchor. The full battery,
affected runner and branch/release gates also compare repository inputs before
and after execution. These snapshots include tracked and nonignored untracked
files, with pre-existing dirty files and deletions preserved as the starting state.
Persistent changes reject the result; unavailable snapshot evidence is inconclusive.
Ignored generated output is excluded. The outer snapshot does not detect a
temporary change restored before comparison. Standalone browser scripts do not
take this snapshot; the affected runner and release gate cover browser execution.
Keep a custom `TMPDIR` parent short when exercising Unix sockets. The guard
package uses a short scratch prefix so its `tsx` IPC socket also fits beneath
the affected runner on macOS.

## Protocol ownership and recovery

The maintained contracts are the existing TypeScript result types and workflow
jobs below. This table maps their boundaries; it is not a second transition engine.
The scope is test planning, execution and promotion. Application sessions, delivery,
domain state and UI lifecycles are outside this testing protocol.

| Lifecycle and authority | Required behavior and normal entry point | Recovery and evidence |
| --- | --- | --- |
| Selection: `test-selection-policy.ts` and `test-plan.ts` | `test:plan` resolves paths and revisions before choosing docs, affected or full. Unsafe, missing or unknown input cannot select a narrow successful run. | Correct invalid input; use `--full` for dependencies the import graph cannot represent. Policy and planner tests exercise malformed input, deleted paths and high-risk changes. Path classification is not semantic proof. |
| Checkout admission: existing `process-lock.ts` | `test:affected` acquires one lock for the checkout before starting commands. Busy, stale or ambiguous ownership returns 75; it does not become queued work. | Inspect the reported PID and its descendants. A dead owner does not prove children exited. Reconcile ownership before explicit lock recovery; do not delete a lock to force admission. Lock tests cover refusal and release. |
| Host admission: existing `loadgate` | Each bounded command uses strict admission where installed; a busy host starts no additional test job. Hosts without it report `local-limits-only`. | Retry only after contention is resolved. Preserve the shared cap. Direct Vitest and legacy commands do not acquire the new checkout lock; use the documented runner for concurrent agent iteration. |
| Execution: `full-suite-battery.ts` | `test:affected` owns a total deadline and scratch directory, forwards termination, bounds the child process group, and preserves nonzero status. | Timeout is incomplete; uncertain cleanup is inconclusive. Normal exit releases scratch and lock. After SIGKILL or host loss, inspect remaining processes and ownership before retrying; automatic recovery is not guaranteed. Battery tests exercise failure, timeout and cancellation. |
| Source evidence: `source-mutation.ts` | The battery, affected runner and push gates compare Git input snapshots before returning success. The per-test main-file tripwire provides additional localization. | Persistent writes require investigation and rerunning against the final source. Git/read errors leave evidence inconclusive. Controlled non-main writes prove rejection; ignored build output remains allowed. |
| Result reconciliation: `test-affected.ts` | Only a completed successful command can pass. Direct Vitest results must contain executed passing assertions and reconciled counters. Missing, empty or contradictory reports return 125. | Fix the failed command or report producer, then rerun affected work. Pending assertions remain visible and unverified. Documentation's `not-required` means no application work, not that CI documentation checks passed. |
| CI completion: `check-test-jobs.ts` | The stable `quality (24.x)` and `quality (25.x)` jobs require the selected workers to succeed. Missing, skipped, cancelled and failed required workers reject promotion. | Inspect the selected worker's failure. Existing safeguard diagnostics and negative mutations detect omitted or advisory required steps. Compiler caches contain build state, never successful test verdicts. |
| PR metadata and protection | `pr-metadata.yml` checks PR content on edits independently of expensive code validation. Live branch protection must require its context alongside existing checks. | Verify the actual settings with the drift command before claiming enforcement. Restore inline metadata validation before removing the separate requirement during rollback. |
| Private integrity | `private-test-integrity.yml` runs trusted default-branch code after Quality. The driver qualifies its pinned runtime and scans immutable candidate data without executing it. | The main-only environment owns the read-only key. Stale identities, unsupported inputs, missing tooling and cleanup failures cannot pass. PR custom-check requirements need hosted qualification and live protection readback. |
| Release and scheduled validation | Quality directly runs full validation for tags and schedules. `tag-release-gate.yml` consumes Quality completion and the exact private scanner receipt. Local full validation uses the existing release manifest once. | Failed releases remain failed; absent or uncertain receipts are incomplete. Tag runs are not cancelled by newer work. Fork scanning and merge queues remain unsupported; do not enable a queue without qualifying every required context. |

Changes to selection, guards, report formats, test runners or workflows must update
their behavioral tests and this guide together. The normal safeguard and curated
gate checks detect drift; instructions alone cannot prevent a bypass. Known local
bypasses above do not replace the repository's required CI checks. Hosted activation
is established only by candidate execution and live protection readback.

## Reuse integrity and compiler tools

The existing qTest installation is `~/.claude/plugins/test-integrity/scripts/test-integrity`.
Use its shared test-integrity skill. Before editing a test, scan the affected files
and inspect parser availability:

```sh
~/.claude/plugins/test-integrity/scripts/test-integrity doctor parsers --json
~/.claude/plugins/test-integrity/scripts/test-integrity scan tests/lib/short-hash.test.ts --format json
~/.claude/plugins/test-integrity/scripts/test-integrity baseline --check --ci tests/lib/short-hash.test.ts
```

Do not use `baseline --save` to hide a new finding. Advisory rules are review
prompts; semantic similarity and weak-looking assertions alone do not justify
deletion. A throwing Testing Library query already checks presence. Retain
distinct edge cases, negative cases, CSS checks and rendered behavior.

Prove a repaired assertion or gate with a real negative control. Existing result
artifacts can feed qTest without running another suite:

```sh
test-integrity coverage ingest coverage/lcov.info --root . --base origin/main --format json
test-integrity mutation ts src/example.ts --stryker-results path/to/mutation.json --json
```

These commands require the indicated artifacts; they do not create coverage or
run Stryker. `coverage ingest` produces surface, change-gap and health analysis;
there are no separate public `coverage surface` or `coverage health` commands.
Its `--base` analysis compares the merge base through committed `HEAD`; uncommitted
changes are not included. Use a matching committed source and coverage artifact
before claiming change-gap coverage, and inspect any Git-analysis warning.
Report unsupported formats, missing reports and incomplete mutants as unknown.
The repository's Stryker configuration remains an on-demand pilot, not a merge
requirement. Its dependencies and target compatibility must be qualified first.

TypeScript already provides semantic and function-signature checks; the existing
fitness registry supplies AST rules, and qTest supplies test-integrity parsing.
Use LSP navigation to inspect references, not as evidence that tests ran. Regex
and clone similarity can find review candidates but cannot establish behavioral
equivalence. No additional linter, clone service or semantic index is required
for this path. Compiler caches live in separate `.local/typescript` files for
root, scripts and all-source projects; they never cache passing test verdicts.

The existing `scripts/lib/semantic-quality/module-graph.ts` uses the TypeScript
AST for reachability and export ownership. Its adjacent `fingerprint.ts` records
content/proposal identity; it does not prove semantic equivalence. Reuse these
resources before adding clone detection or a separate index.
Python property tests already use Hypothesis through
`deploy/scripts/tests/bot_errors_property_support.py`, with sixteen deterministic
examples and isolated stores. Reuse that helper for stateful edge cases before
introducing another generator or increasing example counts across the suite.

Two additional tools were evaluated without adding project dependencies:

| Candidate | Decision and evidence |
| --- | --- |
| [actionlint](https://github.com/rhysd/actionlint) | The pinned 1.7.12 pilot checks Actions expressions and shell scripts. It validated the five changed workflows in 0.439 seconds locally. Retain it as a workflow review tool; this is not a hosted timing claim. |
| [Vitest ESLint plugin](https://github.com/vitest-dev/eslint-plugin-vitest) | `valid-expect-in-promise` is a useful advisory pilot for unawaited assertion chains. Do not adopt a broad preset: assertion-presence rules overlap qTest and can flag throwing queries or helpers. The inspected upstream 1.6.28 package declares TypeScript >=6, while this project uses 5.9.3; qualify an exact compatible release before installation. |

Stryker's [incremental mode](https://stryker-mutator.io/docs/stryker-js/incremental/)
reuses mutant verdicts and documents gaps for changes outside mutated/test files.
Start any future pilot cold, with one non-browser module, one worker and a total
time budget. A surviving mutant is a review lead; shared mutant kills do not
prove that a test can be removed. The current implementation instead validates
its changed gates with real failure, timeout, source-mutation and empty-report
controls, without adding another recurring suite.

For performance comparisons, record revision, Node/dependency versions, changed
paths, workers, cache state, selected files/tests, wall time, admission time and
outcome. Compare matched workloads. Keep skipped checks and hosted measurements
separate from local proof. Use actual negative controls to assess effectiveness;
a shorter duration alone is insufficient.
