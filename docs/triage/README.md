# Open-Issue Triage

This directory holds the public, deterministic evidence used to review the open issue
inventory. It does not hold complete issue bodies, private runtime identifiers, live
credentials, or private operational topology.

The canonical artifacts are:

- `open-issue-registry.json`: the validated machine-readable evidence registry;
- `open-issue-registry.md`: a byte-for-byte generated view of that registry;
- `open-issue-review-ledger.jsonl`: an append-only, hash-linked mutation receipt;
- `plans/*.json`: tracked, body-free mutation plans; and
- `snapshots/*.json`: bounded, field-projected live-inventory captures.

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

## Exit contract

- `0`: verified success or no-op
- `1`: unexpected internal invariant
- `2`: invocation, JSON, or schema invalid
- `3`: stale plan, precondition drift, or ownership conflict
- `4`: public-safety or workflow-policy rejection
- `5`: unknown mutation result, post-write mismatch, or ledger durability failure
- `6`: authentication, API, transport, or rate-limit failure before mutation

Skipped, missing, masked, or environment-blocked checks are inconclusive, not clean.
