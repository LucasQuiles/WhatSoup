# qRegistry Investigation Loop

Status: local automation design and runbook.

This repo's durable investigation register is `qregistry.ndjson`. The registry is append-only by
agent convention: probes observe reality, but only a lead agent or owner changes dispositions.

## Control Files

| Path | Purpose |
|---|---|
| `qregistry.ndjson` | Canonical per-repo register. One JSON object per line. |
| Optional seed audit (`DEFAULT_AUDIT` in `scripts/qregistry-loop.ts`) | Seed audit behind the current QR rows when present; branches that do not carry it skip staging safely. |
| `scripts/qregistry-loop.ts` | Poller/controller that validates the register and can launch bounded OpenCode workers on manual runs. |
| `raw/qregistry-loop/` | Ignored generated artifacts: run briefs, checker output, worker output, state hashes. |
| `../qRegistry/scripts/qregistry-check.py` or `$QREGISTRY_CHECKER` | Canonical shared read-only checker. Referenced, not vendored. |

## Polling Contract

The scheduled loop runs every 15 minutes in observe-only mode. Each tick:

1. Reads `qregistry.ndjson`.
2. Runs the canonical qRegistry checker.
3. Writes a run packet under `raw/qregistry-loop/runs/<timestamp>/`.
4. Compares the register hash and checker-result hash with the previous tick.
5. Exits without worker dispatch.

Manual worker dispatch is available with `--force` after QR-022 is resolved or accepted for a
one-off run:

- `review`: adversarial codebase/source review against staged repo files.
- `research`: related work, history, implementation-agent readiness, and candidate QR enrichments.

The loop has a directory lock at `raw/qregistry-loop/lock`; overlapping ticks skip instead of
running concurrent investigations.

## Safety Boundary

- The loop never mutates `qregistry.ndjson`.
- The loop never pushes, opens PRs, deploys, or posts externally.
- Worker inputs are staged files only: the register, the seed audit, and safe repo-local files
  referenced by actionable QR entries.
- Files with risky suffixes (`.db`, `.sqlite`, `.env`, key material) and paths outside the repo are
  not staged.
- Secret-like strings are redacted into generated staged copies before any worker dispatch.
- Worker output is evidence to review, not truth. A lead agent must verify any candidate row or
  implementation claim before appending to the register.

## Manual Commands

Validate without dispatch:

```bash
npm run qregistry:loop -- --no-dispatch --force
```

Force a worker pass after QR-022 is resolved or accepted for a one-off run:

```bash
npm run qregistry:loop -- --force --max-workers 2
```

Show the schedule:

```bash
mq-schedule show whatsoup-qregistry-loop
```

Run the scheduled command immediately:

```bash
mq-schedule run whatsoup-qregistry-loop
```

## Incoming Implementation Agent Workflow

1. Read `qregistry.ndjson`.
2. Read the latest `raw/qregistry-loop/runs/<timestamp>/brief.md`.
3. Read `worker-review.md` and `worker-research.md` from the same run, if present.
4. Re-verify load-bearing claims against source files.
5. Append new QR rows or enrich existing rows only after lead verification.
6. For implementation, create a small plan with:
   - target QR id,
   - source evidence,
   - falsifier/done-test,
   - exact files,
   - TDD command,
   - rollback or no-op behavior.

## qRegistry Row Enrichment Checklist

Every new or enriched row should answer:

- What is the smallest falsifiable claim?
- What file:line evidence supports it?
- What probe observes the done state?
- What would falsify the finding?
- Which implementation agent files/tests should be inspected first?
- What owner decision is required, if any?
- What related QR rows does it block or depend on?
