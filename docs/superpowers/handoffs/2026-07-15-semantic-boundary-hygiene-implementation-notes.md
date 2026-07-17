# Semantic Boundary Hygiene Implementation Notes

**Status:** Completed — PR A implemented locally in shadow mode; enforcement promotion deferred
**Date:** 2026-07-15
**Owner:** Lucas Quiles
**Branch:** `experiment/jul15-semantic-boundary-eval`
**Specification:** `docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md`
**PR A plan:** `docs/superpowers/plans/2026-07-15-semantic-boundary-foundation.md`

## Purpose

This is the durable handoff between the measurement experiment and production implementation. It
records what was actually observed, which decisions are locked for PR A, how experiment code maps
to production boundaries, which actions remain unauthorized, and which evidence must be appended
during implementation. It is not a completion report and must not be read as evidence that any
hook, workflow, required check, or ruleset currently enforces semantic hygiene.

## Artifact and Commit Map

| Commit | Artifact | Meaning |
|---|---|---|
| `ca8bf4bcda24a973c535da16247a2e6fd43d6394` | Initial semantic-boundary design | Approved architectural direction before measurement |
| `1f49e9984ce1cfd85265b3beb9d161d080931f9f` | Locked 40-case corpus and baseline | Baseline labels fixed before candidate implementation |
| `b8d5d02e60883231be6e3151d38025cc076204a6` | Candidate evaluator | AST reachability, policy decisions, and structured findings |
| `29a2d194914a3b2616532bfe77ca94484f9910a2` | Post-freeze 18-case holdout | Adversarial cases added without changing candidate logic |
| `095b6ebd0` | PR A plan | Approved task order, interfaces, verification, and commit boundaries |
| `44a049e8e` | Semantic graph | Exact committed-tree reader and runtime reachability graph |
| `a015f6ab8` | Semantic policy | Delta-aware module and export ownership classification |
| `727eabf39` | Semantic receipt | Stable receipt schema, shadow/enforce exit semantics, and CLI |
| `791c33922` | Guard proof | Semantic companion-test proof with negative controls |
| `dc6c16bb9` | Decision-poll proof | AST relationships and bounded executable hook probes |
| `64f93e5a4` | Orphan removal | Removed the unowned `emitDelegationReceipt` export after exact-tree proof |
| `fdd7612ea` | Shadow composition | Shared evaluator/production engine, local gate, and Node-24 CI summary |

The experiment result log is `experiment-results.tsv` in the isolated worktree. It is intentionally
untracked under the experiment protocol. The committed JSON corpora are the reproducible inputs:

- `tests/fixtures/semantic-boundary-eval/cases.json`;
- `tests/fixtures/semantic-boundary-eval/holdout.json`.

The experiment script is `scripts/experiments/semantic-boundary-eval.ts`. PR A must extract generic
semantic graph and receipt behavior into `scripts/lib/semantic-quality/` and import those functions
back into the evaluator. Copying the experiment into a second guard would recreate the duplication
this program is intended to prevent.

## Measured Results

| Evaluation | Correct | Accuracy | False blocks | Missed block cases | Detector scope |
|---|---:|---:|---:|---:|---|
| Current-gate baseline | 13/40 | 32.5% | 0 | 19 | Observed required-check outcomes plus current-policy mapping |
| Candidate on locked corpus | 40/40 | 100% | 0 | 0 | 10 visible PR cases, 30 synthetic cases, 7 Git revisions |
| Frozen candidate on holdout | 18/18 | 100% | 0 | 0 | 17 new synthetic cases plus current PR #1835 head |

Candidate intervention findings contained every structurally required feedback field. The main
candidate run took approximately 31 seconds to traverse seven historical revisions on a shared,
loaded host. The one-revision holdout completed in approximately two seconds with warm object/cache
state. These are experiment timings, not production latency budgets.

The 100% scores are bounded evidence, not a generalization claim. Synthetic expected decisions are
derived from the approved policy, the visible PR sample is intentionally failure-heavy, GitHub API
pagination/auth/error behavior was not implemented as a production provider, and no controlled
study yet shows that an agent corrects faster after receiving a receipt.

## Visible Example Mapping

| Example | Expected semantic result | Evidence and caveat |
|---|---|---|
| Historical PR #1835 head `f4eefeb4d23b76899da241e8c0fe936e00532087` | block | `src/lib/capability-grant.ts` was unreachable from production roots; separate reproduced correctness defects are outside the reachability verdict |
| Current PR #1835 head `3c2ce7bbde4018264fcef31743318fef7aeb5b5a` | pass for reachability | Current head wires capability grant through `src/main.ts`; this proves correction sensitivity, not overall PR approval |
| PR #1838 | block | Added `src/lib/echo-cache.ts` was a production island despite green checks |
| PR #1848 | block | Source/test path and blob OIDs were byte-identical to closed PR #1838; the exact-history rule belongs to PR B |
| PR #1854 | pass | `src/lib/self-mention-strip.ts` is reached through the existing ingest owner |
| PR #1857 | block | Added OAuth diagnostic module was unreachable and the hygiene-only re-entry did not cure the recorded disposition |
| PR #1858 | block | Added inbound mention gate was unreachable |
| PR #1859 | block | Added task-status formatter was unreachable |
| PRs #1845, #1846, #1860 | pass | Legitimate guard/harness fixes used as false-block controls |

Issue #1873's owner comment is the source for the changed-path/blob comparison and durable
disposition recommendation. Repository-side implementation remains read-only; issue or PR comment
writes are not part of PR A.

## Locked PR A Decisions

1. **Exact revision, not ambient files.** Branch analysis reads the candidate commit tree. A dirty
   worktree cannot silently alter the decision for a pushed head.
2. **Five declared roots.** `src/main.ts`, `src/bootstrap.ts`, `src/bootstrap-auth.ts`,
   `src/fleet/standalone.ts`, and `src/transport/auth.ts` are the initial runtime roots.
3. **Runtime edges only.** Type-only imports/re-exports are erased and do not count. Side-effect
   imports, value imports/re-exports, mixed type/value imports, and literal dynamic imports count.
4. **Delta-first blocking.** Added/copied/renamed unreachable modules may produce a would-block
   decision. Modified historical islands and full-tree export inventory warn in PR A.
5. **Unknown remains explicit.** Git, parse, root, policy, and candidate-identity failures produce
   `inconclusive` receipts.
6. **Shadow process behavior.** Receipts preserve their semantic decision, while shadow mode exits
   zero after visible feedback. Enforcement mode retains fail-closed exit codes but is manual only.
7. **No magic bypass.** The allowlist is structured, path-specific, owner-authored, expiring, and
   carries a re-entry condition.
8. **One implementation.** The evaluator, local gate, and workflow call the same graph/policy/receipt
   functions.
9. **No new required context.** Quality receives one Node-24-only shadow step; existing Node matrix
   required contexts remain unchanged.
10. **No external mutations.** No GitHub comments, labels, issues, PRs, merges, ruleset edits, or
    workflow reruns are authorized by these documents.

## Production Mapping

| Experiment responsibility | PR A production owner | Migration note |
|---|---|---|
| `runtimeSpecifiers`, resolution, graph traversal | `scripts/lib/semantic-quality/module-graph.ts` | Move and extend with explicit unresolved-edge and export-ownership output |
| direct `git ls-tree` / `git show` evaluation | `scripts/lib/semantic-quality/git-tree.ts` | Resolve full OIDs and merge base; use clean Git environment and bounded buffers |
| semantic decision branches | `scripts/lib/semantic-quality/policy.ts` | Restrict PR A to semantic rules; history/provenance/supply-chain remain experiment-only |
| `BoundaryFinding` / `BoundaryReceipt` | `scripts/lib/semantic-quality/receipt.ts` | Preserve field meaning and add enforcement mode/exact candidate metadata |
| evaluator CLI | `scripts/semantic-quality-check.ts` | New production CLI; experiment CLI remains measurement-only |
| corpus graph fixtures | `tests/fixtures/semantic-quality/` and production unit tests | Copy behavioral cases, not evaluator labels or PR-specific state |

The content-fingerprint, re-entry, upstream provenance, supply-chain, process-boundary, and issue
similarity branches stay in the experiment until their own tranches. PR A may preserve their tests,
but it must not present them as production enforcement.

## Guard-Test Proof Notes

The current `scripts/guard-test-coverage-check.ts` proves only that a companion path exists and its
name appears in `verify:push:branch`. PR A adds a semantic proof inventory without weakening those
existing blockers. Direct-import tests and subprocess tests are both valid patterns, but each must
invoke the guard and assert an unsafe outcome. A comment, string, import-only test, success-only
assertion, or unchecked subprocess is not proof.

Semantic proof begins in shadow mode because the real-repo exception count has not been measured.
The implementation record must capture every gap rather than immediately adding comments or broad
exceptions. Any later exception mechanism follows the structured owner/reason/expiry/re-entry
contract; the current `// meta-guard:no-test` mechanism is not expanded for semantic proof.

## Decision-Poll Notes

The current decision-poll guard uses raw anchors across production code, hook code, package scripts,
and documentation. PR A separates them:

- production TypeScript relationships are verified with AST structure;
- the lint hook is executed with one accepted and one prohibited transcript;
- package composition remains parsed script-order verification;
- documentation promises remain textual because text is the surface being protected.

A spawn error, signal, absent exit status, unreadable hook, or malformed TypeScript file is a
finding. The executable probe must have a bounded test fixture and may not run against live chats or
external services.

Implementation clarification: the runbook, configuration reference, and public-surface inventory
all define `poll-interaction-lint.mjs` as a fail-open PostToolUse diagnostic. The original Task 5
wording incorrectly expected prohibited input to exit nonzero. The corrected contract requires exit
0 for accepted and prohibited probes, an empty diagnostic surface for accepted input, and an exact
`asks-user-to-type-i-voted` session-local finding for prohibited input. The enclosing repository
guard fails closed when that behavior is absent, bounded execution is inconclusive, or the hook is a
textual no-op.

## Rollout and Rollback

PR A rollback removes `verify:semantic:shadow` from package/workflow composition while retaining the
pure library, tests, and manual command for diagnosis. It does not require deleting receipts or
rewriting history. The guard-test semantic layer and decision-poll structural layer can each be
rolled back independently because their current hard checks remain intact.

Promotion requires the specification's observation gates. In particular, no rule becomes a
required GitHub context or enforced local blocker without explicit owner authorization after false-
positive review, latency measurement, rollback proof, and an agent-correction trial.

Current workflows already use mutable third-party Action tags and the Docker base lacks a digest.
Supply-chain blocking before a dedicated baseline migration would create a repository-wide surprise
failure. Immutable pin migration and its provenance manifest therefore remain a separate plan.

## Authorization Boundary

Authorized by the current request:

- write and commit this specification, plan, and implementation-notes packet;
- later implement PR A locally after the documentation gate is accepted;
- run local tests, static checks, Git reads, and read-only GitHub evidence queries needed by PR A.

Not authorized without a new explicit request naming the action and target:

- push any branch or create/update a PR;
- create or comment on an issue;
- submit a review, merge, close, reopen, or label an artifact;
- change a ruleset or required status context;
- rerun or cancel a workflow;
- mutate an external artifact producer or host installation.

## PR A Verification Record

The final focused verification used the exact Task 8 command under `loadgate`:

- nine test files passed, 247/247 tests passed, exit 0;
- `typecheck:scripts` exited 0;
- `typecheck:all` exited 0;
- the test runner emitted the repository's pre-existing esbuild/Oxc configuration warning; no test
  result was masked;
- direct guard execution reported 18/18 guard scripts with a wired companion test;
- direct decision-poll guard execution exited 0 with no finding;
- test-integrity scans of every changed semantic test file reported no findings;
- the frozen baseline remained 13/40 with 19 missed block cases and zero false blocks;
- the candidate remained 40/40 with zero missed block cases and zero false blocks;
- the post-freeze holdout remained 18/18 with zero missed block cases and zero false blocks.

The complete `verify:push:branch` command then ran under `loadgate` and exited 0. Its composed test
sets passed 39 files / 740 tests, 14 design-guard files / 182 tests, and 87 tokenomics tests; console
lint and the production console build also completed successfully. Test-integrity reported six
known baseline findings and zero new or drifted findings. The import-boundary inventory improved
from 32 to 31 grandfathered violations. The fitness lane reported 202 non-blocking warnings and
zero errors. Design regression reported 13 passing blockers and seven report-only warnings.

Two limitations remain visible in that gate: ARC binding content comparison was skipped because the
sibling `agent-runtime-protocol` repository was unreachable, although the vendored SHA pin matched;
and safeguard diagnostics could not calculate ahead/behind state because this branch has no
upstream. Neither condition was masked as a clean check. No release suite, workflow run,
required-check change, or remote mutation is claimed by this packet.

## Shadow Inventory at `fdd7612ea`

The production shadow command was pinned to head
`fdd7612ea3555f3a89784df3614247078b3bf26a` and base
`a36b52e3f15393509078cd3e693c368567082f1a`; Git resolved merge base
`043c531e3dae51635dc60a5a85238e866ccbe291`. Its receipt decision was `warn` and its process exit
was 0, as required for shadow mode.

| Inventory surface | Observed result |
|---|---|
| Added/renamed would-block findings | 0 |
| Modified unreachable-module warnings | 0 |
| Full-tree export-ownership warnings | 1 aggregate finding: 115 exports across 52 reachable modules |
| Semantic companion-test gaps | 0; 18/18 registered guards had wired companion tests |
| Decision-poll structural/executable findings | 0 |
| Frozen-corpus false-block reviews | 0 across 40 locked and 18 holdout cases |
| Correction/repeat evidence | PR #1835 changed from an unreachable old head to a reachable current head; the locally cited `emitDelegationReceipt` export was removed and did not recur in the final inventory |

The correction observations show that the detector can distinguish a cited defect from its repaired
revision. They are not a controlled measurement of whether verbose feedback improves an agent's
next attempt. No feedback-effectiveness claim is made.

## Local Timing Observations

Ten Node processes evaluated the same immutable head/base under separate `loadgate` admissions.
The repository and Git object store had already been exercised, so every observation is classified
as object-cache warm and process cold. `real` is `/usr/bin/time -p` wall time; load is the host's
1/5/15-minute load average immediately before each run.

| Run | Real seconds | Host load | Cache state | Exit |
|---:|---:|---|---|---:|
| 1 | 6.98 | 6.73 / 9.28 / 10.87 | object warm; process cold | 0 |
| 2 | 8.18 | 6.31 / 9.11 / 10.79 | object warm; process cold | 0 |
| 3 | 7.65 | 6.52 / 9.11 / 10.77 | object warm; process cold | 0 |
| 4 | 7.25 | 7.67 / 9.27 / 10.81 | object warm; process cold | 0 |
| 5 | 7.01 | 7.69 / 9.25 / 10.80 | object warm; process cold | 0 |
| 6 | 6.93 | 7.52 / 9.16 / 10.74 | object warm; process cold | 0 |
| 7 | 6.96 | 7.40 / 9.10 / 10.72 | object warm; process cold | 0 |
| 8 | 6.84 | 7.80 / 9.13 / 10.71 | object warm; process cold | 0 |
| 9 | 8.50 | 7.81 / 9.11 / 10.69 | object warm; process cold | 0 |
| 10 | 6.87 | 7.47 / 9.00 / 10.63 | object warm; process cold | 0 |

The local warm-cache median was **7.00 seconds** and the nearest-rank p95 was **8.50 seconds**.
A defensible cold-object-cache run was unavailable after the repository had already been traversed.
No CI run was authorized or observed, so CI median and p95 remain unknown. These gaps prohibit
setting a production timeout from this packet.

## Promotion Decision

PR A remains shadow-only. The current full-tree warning is useful inventory but too broad for a
blocking boundary: 115 historical exports require ownership review, cold-cache and CI latency are
unknown, and agent-correction effectiveness has not been controlled. `verify:semantic` remains a
manual enforce-mode adapter; `verify:semantic:shadow` is the only composed adapter. Upstream hash,
duplicate-history, durable disposition, and external-producer checks remain PR B work.

## Risks and Unknowns

- Export-level orphan inventory can be noisier than module reachability. Task 6 must stop rather
  than delete `emitDelegationReceipt` if a production caller appears before implementation.
- Git rename/copy classification and incomplete history need fixture proof before reliance.
- TypeScript path aliases or non-relative registration mechanisms may require explicit composition
  adapters; none are assumed reachable by name similarity.
- A shadow process exit of zero can be ignored by agents unless stderr and CI summaries remain
  prominent. Correction-rate measurement is still absent.
- Shared-host load materially affects timing. Production timeouts cannot be inferred from the
  experiment's seven-revision wall time.
- The automated external PR/issue producer has not been located in this repository. Producer-side
  duplicate suppression remains incomplete until that owner surface is identified.
- This Codex session has no tmup tool. No SDLC runner, sentinel, or oracle receipt exists for this
  documentation pass; lead-only file inspection and deterministic guards are the available proof.

## Next Authorized Tranche

The next implementation tranche is not implicitly authorized by PR A. If the owner proceeds with
PR B, begin from the specification's upstream hash and duplicate-history provider boundaries, keep
provider failures explicit and bounded, and repeat the frozen-case/holdout method before composing
any blocker. Preserve `experiment-results.tsv` as an untracked experiment log. If implementation
moves to a new branch, use `git range-diff` and `git cherry -v` before treating either branch as
superseded.
