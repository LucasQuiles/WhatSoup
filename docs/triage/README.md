# Open-Issue Triage

This directory holds the public, deterministic evidence used to review the open issue
inventory. It does not hold complete issue bodies, private runtime identifiers, live
credentials, or private operational topology.

The canonical artifacts are:

- `open-issue-registry.json`: the validated machine-readable evidence registry;
- `open-issue-registry.md`: a byte-for-byte generated view of that registry;
- `open-issue-review-ledger.jsonl`: an append-only, hash-linked mutation receipt;
- `plans/*.json`: tracked, body-free mutation plans; and
- `reviews/*.json`: tracked review manifests that bind exact body-free evidence
  records to one source registry and main revision; and
- `snapshots/*.json`: bounded, field-projected live-inventory captures and
  immutable reconciliation seals.

Every tracked plan or snapshot needs its own `PUBLIC` row in
`docs/publication-audit.md` in the same commit. The publication guard rejects an
unclassified path; wildcard prose here is not an audit classification.

The registry and generated view are added only after one final live capture covers every
open issue exactly once. Until then, the tooling is deliberately not wired into
pre-commit, pre-push, or CI.

## Offline checks

Schema discovery and repository checks do not require GitHub authentication or network
access:

```bash
npm run --silent triage:issues -- schema
npm run --silent triage:issues -- check \
  --registry docs/triage/open-issue-registry.json
npm run --silent triage:issues -- render --check \
  --registry docs/triage/open-issue-registry.json
```

`check` validates the registry, the complete receipt chain, and the generated Markdown
view. To regenerate the view intentionally:

```bash
npm run --silent triage:issues -- render --write \
  --registry docs/triage/open-issue-registry.json
```

## Live capture and dry-run

Live commands use the narrow GitHub adapter. Capture only the fields needed for review
and bound large arrays:

```bash
npm run --silent triage:issues -- snapshot \
  --registry docs/triage/open-issue-registry.json \
  --output docs/triage/snapshots/<snapshot-id>.json \
  --fields counts,labels,open_issue_numbers,open_pull_requests \
  --limit 500
```

Before planning a mutation, fetch `origin/main`, record its exact 40-character object
ID, and revalidate the issue timestamp, body hash, labels, source evidence, and pull
request overlap. Dry-run performs no issue or ledger mutation:

```bash
npm run --silent triage:issues -- issue dry-run \
  --registry docs/triage/open-issue-registry.json \
  --issue-number <issue-number> \
  --expected-main-oid <origin-main-object-id> \
  --output docs/triage/plans/<batch-id>.json
```

The output summary contains the artifact path, affected issue numbers, warnings, and
the canonical plan digest. That digest is computed over the canonical batch without
its embedded self-hash fields; it is the apply confirmation value, not a byte-for-byte
file digest. The plan never prints or stores complete issue bodies.

## Apply and recovery

An apply plan must be repository-confined, tracked, clean, single-linked, unchanged, and
digest-confirmed. The issue set and stable idempotency key are separate confirmations:

```bash
npm run --silent triage:issues -- issue apply \
  --registry docs/triage/open-issue-registry.json \
  --plan docs/triage/plans/<batch-id>.json \
  --confirm-plan-sha256 <plan-sha256> \
  --confirm-issues <comma-separated-issue-numbers> \
  --idempotency-key <stable-batch-key>
```

The tool re-reads each issue after its single PATCH and appends body-free receipts to
the canonical ledger. It never blindly retries a write. If the transport response is
ambiguous, the result is classified from an immediate re-read; an unknown result stops
the batch and exits with code 5.

Artifact creation is serialized by an owner-bearing process lock. A dead owner from the
same known boot is recovered automatically for this retry-safe lane; a live owner
blocks, and a corrupt or unknown-boot lock fails closed for explicit inspection. The
ledger seed must be either an empty file or exactly one LF byte; other whitespace is
invalid and is never normalized during apply.

Use the plan to re-read without mutating:

```bash
npm run --silent triage:issues -- issue re-read \
  --registry docs/triage/open-issue-registry.json \
  --plan docs/triage/plans/<batch-id>.json
```

Do not create a replacement plan, retry a PATCH, edit the ledger, or delete the branch
while an outcome is unknown. Preserve the tracked plan and ledger, inspect the live
issue and receipt chain, then resolve the evidence gap in a separately reviewed batch.

## Registry reconciliation

A refresh manifest is the only accepted input for adding, replacing, retaining, or
removing registry records. The manifest and every referenced record must be
repository-confined, tracked, clean, committed, byte-hash matched, sorted, unique, and
strict-schema valid. An issue removal additionally requires two exact closed-state
reads around the final complete capture. Timestamp-only retention and overlap removal
must be explicit manifest attestations; the reconciler never silently carries changed
evidence forward.

First run the read-only gate:

```bash
npm run --silent triage:issues -- registry reconcile --check \
  --registry docs/triage/open-issue-registry.json \
  --reviews docs/triage/reviews/<refresh-id>.json \
  --snapshot docs/triage/snapshots/<seal-id>.json \
  --expected-main-oid <origin-main-object-id>
```

The gate requires the exact SSH origin, tracking `origin/main`, live remote `main`, and
GitHub API `main` to equal the requested object ID. It captures the complete open issue,
pull-request, changed-file, closing-reference, and label estate three times; any
inventory or nested pull-request drift stops the operation. The check computes and
validates the candidate registry, generated view, snapshot classification, additions,
and removals without writing files.

After reviewing the committed manifest bytes and check summary, write all four
artifacts as one common-git-directory transaction:

```bash
npm run --silent triage:issues -- registry reconcile --write \
  --registry docs/triage/open-issue-registry.json \
  --reviews docs/triage/reviews/<refresh-id>.json \
  --snapshot docs/triage/snapshots/<seal-id>.json \
  --expected-main-oid <origin-main-object-id> \
  --confirm-review-sha256 <manifest-byte-sha256> \
  --idempotency-key <stable-refresh-key>
```

The transaction creates the immutable body-free snapshot and replaces the canonical
registry, generated Markdown, and publication audit only from exact before-state
hashes. Its lock and journal live in the Git common directory so sibling worktrees
coordinate. A live owner blocks. Candidate, backup, journal, or target ambiguity fails
closed without overwriting unproven bytes.

If the write is interrupted, preserve every common-directory transaction artifact and
rerun the exact `--write` command with the same manifest digest, snapshot path, main
object ID, and idempotency key. Do not delete a journal, candidate, backup, snapshot, or
lock to make a retry proceed. The recovery path may roll forward only links and bytes
whose ownership and hashes it can prove.

The local filesystem API does not expose descriptor-relative mutation on every
supported platform. The transaction therefore revalidates parent identities at every
available boundary and coordinates all repository writers, but it does not claim
atomic protection against a hostile process swapping a parent directory between the
last check and the operating-system call. Such interference is an inconclusive
recovery event, not a clean write.

## Exit contract

- `0`: verified success or no-op
- `1`: unexpected internal invariant
- `2`: invocation, JSON, or schema invalid
- `3`: stale plan, precondition drift, or ownership conflict
- `4`: public-safety or workflow-policy rejection
- `5`: unknown mutation result, post-write mismatch, or ledger durability failure
- `6`: authentication, API, transport, or rate-limit failure before mutation

Skipped, missing, masked, or environment-blocked checks are inconclusive, not clean.
