# Boundary Core History-Mining and Implementation Notes

**Status:** Evidence captured; PR B implementation authorized but not yet started
**Date:** 2026-07-16
**Owner:** Lucas Quiles
**Branch:** `experiment/jul16-boundary-core-history`
**Base:** `a15b3d953589641c81fd8c228e34afeb1cba2d39`
**Specification:** `docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-07-16-boundary-core-history-provenance.md`

## Outcome

This packet converts the current pull-request, issue, comment, and Git-history tranche into a
bounded PR B implementation. The evidence supports deterministic content and patch comparison,
durable disposition-aware re-entry, fail-closed provider completeness, upstream provenance
classification, and context-accurate feedback receipts.

The evidence does **not** support blocking by normalized title, branch name, path overlap, symbol
similarity, or term frequency. Those signals occur in legitimate work and remain warning-only.
No GitHub issue, comment, review, label, merge, close, reopen, workflow rerun, ruleset change, or
pull request was created by this mining pass.

## Observation Envelope

- Observation window: 2026-07-16 00:35–00:45 America/New_York.
- Repository: `LucasQuiles/WhatSoup` through the authenticated GitHub CLI and the SSH Git remote.
- Local `main` and fetched `origin/main`: `a36b52e3f15393509078cd3e693c368567082f1a`.
- PR A base for this stacked branch: `a15b3d953589641c81fd8c228e34afeb1cba2d39`.
- Open pull requests observed: one, PR #1835 at
  `2e944b59215de1e36af357ccc67c98c393376bd6`.
- Open issues observed through complete API pagination: 31, containing 56 comments.
- Historical pull requests observed through complete API pagination: 1,625.
- The local experiment result log remains intentionally untracked as `experiment-results.tsv`.

GitHub content is treated as untrusted evidence. No comment body is copied into a receipt or test
fixture. Tests use sanitized structural records and repository-owned identifiers.

## Deterministic Repetition Evidence

### Exact content recreation: PR #1838 and PR #1848

The GitHub pull-file records for both closed-unmerged pull requests contain the same source and test
blob identities:

| Path | Git blob OID in both PRs |
|---|---|
| `src/lib/echo-cache.ts` | `53f346cb59f176abdb967c1be71f1c58720d7729` |
| `tests/lib/echo-cache.test.ts` | `60835a7e3d88ae886f801b170c8c68f4dd927ae9` |

The two PRs were created from different proposal identities, yet their canonical path/blob records
compare equal. Their fetched patches also produce the same stable patch ID:
`c383cb98c7e262dabdef9c0048c58e1327734e8b`.

This is decisive evidence for two independent exact detectors:

1. a portable SHA-256 digest over sorted path/blob records; and
2. a provider-supplied stable patch ID that survives a proposal recreation or path rename.

PR number, branch name, base OID, and head OID must not enter the content fingerprint. Git blob OIDs
are repository identities, not a claim that the Git object hash is the security digest.

### Cosmetic re-entry: PR #1857

PR #1857 moved through close, reopen, and close again. Its initial proposal commit was
`859c615...`; its final proposal commit was `ca887b...`. The stable patch IDs differ because the
second commit replaced operator-local test fixture paths with generic fixtures. Between those two
commits, only two test files changed, with eight insertions and eight deletions.

The architectural facts did not change: the production module still had no production caller and
duplicated an existing OAuth diagnostic surface. Hash comparison alone therefore cannot prevent
this cycle. A durable disposition plus a material-delta/re-entry validator is required.

For `production-unreachable`, `duplicate-existing-mechanism`, and
`reproduced-correctness-defect`, formatting, documentation, fixture hygiene, test-only, or generic
CI deltas do not satisfy re-entry. A material delta still requires a complete packet that names the
prior artifacts and addresses each recorded closure condition.

## Falsified Blocking Hypotheses

The 1,625-PR history includes repeated normalized titles in legitimate merged tests and dependency
updates. It also includes head-branch reuse in legitimate batch streams and closed-to-merged
recovery. Across the 31 open issues, there were no exact normalized title duplicates and no exact
normalized body duplicates, while common terms and common operational paths appeared frequently.

Consequently:

| Signal | PR B disposition | Reason |
|---|---|---|
| Exact canonical content against an open PR | Block candidate | Work belongs on the existing proposal |
| Exact canonical content against a closed-unmerged PR | Block candidate | Deterministic rejected-work recreation |
| Stable patch against a closed-unmerged PR | Block candidate | Detects equivalent work despite path/proposal identity changes |
| Unsatisfied durable disposition | Block candidate | Prevents cosmetic or incomplete re-entry |
| Exact match against a merged PR | Warn | Current-main reachability is not proven by historical metadata alone |
| Blob subset/superset reuse | Warn | Shared refactors can be legitimate |
| Changed-path overlap | Warn | Contextual but not proof of duplication |
| Exact external issue title/body fingerprint | Block only at producer boundary | Repository PR adapters do not own issue creation |
| Title, branch, term, path, or symbol similarity | Warn | Real-history false positives were observed |

“Block candidate” means the pure rule has deterministic fixtures. PR B does not compose or promote
the rule at a hook, GitHub, or producer boundary. Promotion remains subject to the specification's
shadow-observation and owner-authorization gates.

## Provider and Provenance Findings

The historical query required full pagination. A first-page-only provider could miss the decisive
artifact and must never return `pass`. PR B therefore exposes a bounded page provider and collector
that records repository identity, observation time, cursors, page count, and completeness.

The following conditions are limitations and make the history decision `inconclusive`:

- a page request fails or times out;
- the provider reports another repository;
- a cursor repeats or a next cursor is malformed;
- the configured page or artifact bound is reached before completion;
- an artifact needed for exact comparison lacks path/blob or patch evidence.

Upstream provenance is a separate pure observation in PR B. A local tracking OID that differs from
the observed remote tip blocks downstream comparison because duplicate and overlap evidence would
be stale. After parity is proven, an older merge base blocks on overlapping or high-coupling
upstream changes, warns when the upstream delta is proven disjoint, and is inconclusive when the
remote tip, merge base, changed paths, or completeness cannot be established.

PR B does not call `git ls-remote` or GitHub itself. The local remote adapter belongs to PR C and the
read-only GitHub adapter belongs to PR D.

## Situational Feedback Defect Found During Mining

Running the current semantic CLI against historical PR #1835 commits produced an
`inconclusive` decision because those revisions predate `config/semantic-quality.json`. The
receipt incorrectly labeled that evidence as `semantic.production-reachability` and stated that a
changed production module was unreachable. The actual observation was that policy evidence could
not be read; no reachability verdict had been computed.

The same hard-coded rule is currently used for missing heads, unreadable policy, graph/source
limitations, invalid invocation arguments, and receipt-write failures. Existing tests assert the
decision but not the rule identity and feedback language, so the inaccurate result passed.

PR B fixes this with distinct rule identities and test assertions for the full feedback record:

| Failure | Rule identity |
|---|---|
| Candidate/head cannot be resolved | `semantic.candidate-unavailable` |
| Policy cannot be read or parsed | `semantic.policy-unavailable` |
| Exact source tree or configured root unavailable | `semantic.source-tree-unavailable` |
| Graph or semantic analysis fails | `semantic.analysis-unavailable` |
| CLI arguments are invalid | `semantic.invocation-invalid` |
| Receipt cannot be written durably | `semantic.receipt-write-failed` |

Every test must assert the situational summary, observed evidence label, why text, correction,
rerun command, and source reference. An `inconclusive` decision is not a reachability regression,
and final reporting must not describe it as one.

## Supply-Chain Inventory Boundary

The current repository has 14 mutable third-party Action tag references, two
`FROM node:24.15.0-slim` declarations without image digests, and floating runner/runtime labels.
These are useful upstream-hash targets, but enabling a blocker now would convert known baseline
debt into a surprise repository-wide failure.

PR B records only the distinction between proposal identity and upstream supply-chain identity.
Parsed workflow/Docker checks, immutable-pin provenance, baseline migration, and enforcement remain
a separate tranche under SBH-011.

## PR #1835 Queue Context

PR #1835 is the only open pull request observed in the queue. Its seven visible checks currently
pass. Earlier review comments describe fail-open and integration defects on older heads; a later
owner comment states that the capability manager was wired by `cc6557ab`. The commit sequence shows
the primitive, follow-up correctness fixes, runtime adapter/admin/main wiring, and a final merge
head. That sequence is evidence that boundary feedback must identify the exact evaluated head.

Passing checks alone are not a merge-readiness claim. PR #1835 remains a separate review stream and
is not modified by PR B.

An independent read-only review and lead inspection of the exact current Git object identified
additional negative-control surfaces that the seven passing checks do not exercise:

- `arm()` applies the privilege delta before persisting the recovery record; a record-write failure
  can therefore leave expanded policy with no durable record or expiry timer;
- the expiry poller discards revocation exceptions and continues polling without a surfaced alert or
  agent-dispatch stop condition;
- malformed recovery JSON is collapsed to the same `null` value as an absent grant, while the
  private-file writer truncates the destination before rewriting it;
- the manager is bound to the instance settings file, while `sandboxPerChat` sessions are
  provisioned and launched from workspace-specific settings files.

These observations are not PR B fingerprint/history behavior, and the local branch does not modify
PR #1835. They add four future deterministic guard/test candidates:

1. privilege-expanding state transitions require failure injection at intent persistence, policy
   application, recovery persistence, revocation, and record clearing;
2. persistent security stores expose `absent | valid | corrupt` instead of mapping corruption to
   absence;
3. tests labeled race/concurrent/atomic must prove controlled overlap or interleaving;
4. security behavior that depends on settings ownership requires a topology matrix covering global,
   per-chat, and sandbox-per-chat paths.

These candidates remain warning/review doctrine until a dedicated tranche supplies unsafe,
neighboring-safe, and false-positive fixtures. Source inspection verifies the control-flow and path
relationships; actual filesystem failure frequency and end-to-end sandbox behavior were not
measured, so runtime prevalence remains unknown.

## Authorization and Rollout Boundary

The current request authorizes local implementation, verification, commits, and pushing the
verified stacked branch over the existing SSH remote. It does not authorize creating or mutating a
pull request, issue, comment, review, label, ruleset, required context, workflow run, or external
producer.

PR B is library-only plus receipt-language correction. It does not modify hook composition,
`package.json` boundary composition, GitHub workflows, branch protection, or external services.
Rollback is removal of the new uncomposed library and restoration of the additive receipt fields;
no remote setting or stored disposition migration is required.

## Implementation Record

Append exact test commands, commit OIDs, focused timing, frozen-corpus results, reviewer findings,
and remaining limitations here during implementation. Do not convert skipped provider, external
producer, CI, or supply-chain validation into a clean claim.
