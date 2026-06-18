# BOT ERRORS Q-Loop Unattended Readiness Gate

## Decision

The current state is **advisory and supervised**, not unattended-complete.

The system may move to unattended readiness only when BOT ERRORS, Q-loop coordination, worker delegation, and fleet rollout have reproducible evidence from a clean, named commit and from live routing-host validation. A local dirty tree, an uncommitted live patch, an empty worker report, or a self-reported pass is not sufficient evidence.

## Mission

Prove that WhatSoup can detect, preserve, route, review, and summarize operational failures without silently losing alerts, spamming BOT ERRORS, trusting empty OpenCode output, or confusing local proof with live routing-host proof.

## Host Parameters

These steps run against the live BOT ERRORS routing host over SSH. Set the host alias once per shell so the runbook stays portable across deployments:

```bash
ROUTING_HOST=<routing-host-ssh-alias>
```

All `ssh "$ROUTING_HOST"` commands below assume this is exported. Replace `<routing-host-ssh-alias>` with the SSH alias of whichever host currently routes BOT ERRORS.

## Scope

In scope:
- BOT ERRORS producer durability, writefail breadcrumbs, redaction, and test provenance isolation.
- Dispatcher and collector routing, dedupe, cooldown, recovery, archive, and state semantics.
- Q-loop polling, heartbeat, dynamic wait, message dedupe, and blocked/approved phase tracking.
- Launchd and systemd environment sourcing, fail-closed routing, and service liveness.
- OpenCode worker orchestration evidence, empty-output rejection, and Q promotion flow.
- Fitness-ring enforcement readiness, warning baselines, and agent self-review artifacts.
- Fleet rollout gates for the lab hosts and minis.

Out of scope:
- Brick, because it is not part of the WhatSoup fleet.
- Broad feature work that does not prevent silent failure, alert spam, bad routing, or unreviewed agent changes.
- Unapproved live deploys or branch pushes.

## Non-Negotiable Gates

### G0: Provenance

No work can be accepted as production-ready unless it is present in a named commit on a named branch that Q can fetch into a clean non-prod worktree.

Required evidence:
- Branch name.
- Commit hash.
- `git status --short` from the producing tree.
- Q clean-worktree verification output.
- Test and typecheck logs from Q, not only Codex.

Reject if:
- Required code exists only in an untracked file.
- Required code exists only in a dirty live checkout.
- Tests pass only on a machine with local untracked files.
- The routing host and local disagree about files that route BOT ERRORS.

### G1: Routing-Host Drift

The live BOT ERRORS routing host carries production traffic, so dirty production drift must be captured, explained, and reconciled before fleet deploy.

Required evidence:
- Dirty-file inventory from the routing host.
- For every dirty file: owner, reason, keep/drop decision, and verification command.
- Archive path for any live file replaced or reconciled.
- Post-reconciliation `git status --short` and targeted test log.

Reject if:
- Live file changes are overwritten without an archive.
- Live code regresses committed hardening.
- Local patch is applied over drift without reading the live file first.

### G2: Alert Durability

An alert is accepted only if the producer either durably writes it to the outbox or records a durable writefail breadcrumb that can be recovered.

Required evidence:
- Temp-file fsync before rename.
- Parent-directory fsync after rename where the platform supports it.
- Writefail breadcrumb durability and redaction tests.
- Crash-window tests for write failure, rename failure, and fallback recovery.
- No live alert leakage during tests.

Reject if:
- Outbox write failure plus unconfigured legacy fallback only creates a local log line.
- Test mode can write to the live outbox without an explicit override.
- Writefail breadcrumbs can include raw tokens, passwords, JIDs, or phone numbers.

### G3: Routing Safety

BOT ERRORS routing must fail closed when the target chat or sender line drifts.

Required evidence:
- `BOT_ERRORS_JID` is present and is a group JID.
- `BOT_ERRORS_EXPECTED_JID` is present and matches `BOT_ERRORS_JID`.
- Systemd and launchd paths source the same private env contract.
- Health check reports missing or mismatched routing env.
- Tests prove one-to-one JIDs and mismatched group JIDs do not send.

Reject if:
- Missing expected JID silently disables alerts.
- Wrong target chat can receive alerts.
- Secrets are printed in service logs or generated plists.

### G4: Dispatcher And Collector Semantics

Dispatch, suppression, recovery, and archive movement must preserve evidence and avoid both spam and silent loss.

Required evidence:
- Incident-key tests for distinct source, machine, and instance boundaries.
- Cooldown, renotify, escalation, and clear semantics tests.
- Archive uniqueness tests for same-second events and truncated names.
- Collector writefail harvest, duplicate, poison, ack failure, and recovery tests.
- State files that record sent, suppressed, recovered, and failed dispositions.

Reject if:
- A sent event can overwrite another sent event.
- A recovery clear can overwrite an alert or hide its evidence.
- A stale duplicate can page Q indefinitely.
- A new distinct failure is suppressed by an overly broad key.

### G5: Service Supervision

The service mesh must make its own failures visible.

Required evidence:
- Active service/timer status for dispatcher, collector, q-loop, health check, and heartbeat watchdog.
- Recent heartbeat or state update for each service.
- Deadman or watchdog coverage for stale q-loop, stale dispatcher, stale collector, stale outbox, and stale health.
- Reboot and restart behavior documented per platform.

Reject if:
- A service can stop without a stale-state alert.
- A missing env file makes a service fail with no Q-visible diagnostic.
- Health checks only report failures and never prove success cadence.

### G6: Q-Loop Supervision

Q-loop must be a durable supervisor, not a one-off poller.

Required evidence:
- Last seen message primary key.
- Persisted phase state, including `blocked_by_q`.
- Dynamic wait state and heartbeat.
- Q silence detection and bounded nudges.
- Message history sufficient to reconstruct the last blocker and latest evidence.
- A daily or checkpoint summary format.

Reject if:
- Q-loop can lose Q's latest blocker after restart.
- Q-loop can spam BOT ERRORS when Q is quiet.
- Q-loop can mark complete without Q approval or explicit override.

### G7: Worker Evidence

OpenCode workers are advisory until their artifacts are non-empty, structured, and reviewed.

Required evidence:
- Prompt, scope, model/provider, start/end time, exit code, and artifact path.
- Non-empty report with findings, commands, and residual risks.
- Artifact validator that rejects empty, stale, or malformed output.
- Q or Codex promotion decision from advisory to accepted.

Reject if:
- Empty redirected output is treated as evidence.
- Worker failure is invisible.
- Multiple workers duplicate the same scope while critical gaps remain uncovered.

### G8: Coverage And Integrity

Coverage claims must describe the exact surface measured.

Required evidence:
- BOT ERRORS suite result.
- Full relevant TypeScript typecheck result.
- Test-integrity guard result.
- Coverage report for included surfaces, with exclusions listed.
- Explicit statement when repo-wide coverage is below the requested 99-100%.

Reject if:
- Masked test failures are called clean.
- Skipped tests are omitted from the summary.
- 99-100% coverage is claimed from a focused suite only.

### G9: Fleet Rollout

Fleet rollout happens one machine at a time, with rollback and physical-intervention risk tracked.

Required evidence per machine:
- Host identity and profile.
- WhatSoup instance and phone/profile mapping.
- Private routing env exists and is readable.
- Service status and state freshness.
- Pairing/auth-bond health.
- BOT ERRORS synthetic alert, clear, and writefail recovery drill.
- Q receives enough context to investigate without Lucas.

Reject if:
- Re-pairing is required and no local operator is available.
- Auth-bond loss is not classified as highest severity.
- Launchd fail-closed env bootstrap is deployed before env provisioning is proven.

## Current Known Blockers

1. Q has not approved the current state because the work is still dirty and not proven from a pushed, clean commit.
2. The routing host has had production drift that must be reconciled as its own task, not hidden inside unrelated changes.
3. OpenCode worker output validation exists in the dirty tree and rejects empty, stale, or malformed reports, but it is not accepted until Q verifies it from a clean commit.
4. Repo-wide 99-100% coverage is not proven. Focused BOT ERRORS coverage is strong, but broader surfaces still need measured proof.
5. Fleet env provisioning and launchd fail-closed behavior must be proven before deployment to the lab hosts or minis.

## Implementation Plan

### Task 1: Capture Evidence Roots

Files:
- Create: `artifacts/bot-errors-readiness/2026-06-10/README.md`
- Create: `artifacts/bot-errors-readiness/2026-06-10/local-status.txt`
- Create: `artifacts/bot-errors-readiness/2026-06-10/routing-host-status.txt`

Steps:

1. Create the evidence directory:

   ```bash
   mkdir -p artifacts/bot-errors-readiness/2026-06-10
   ```

2. Capture local branch and dirty status:

   ```bash
   {
     date -u
     git rev-parse --abbrev-ref HEAD
     git rev-parse HEAD
     git status --short --branch
   } > artifacts/bot-errors-readiness/2026-06-10/local-status.txt
   ```

3. Capture routing-host branch and dirty status:

   ```bash
   ssh "$ROUTING_HOST" 'cd ~/LAB/WhatSoup && { date -u; git rev-parse --abbrev-ref HEAD; git rev-parse HEAD; git status --short --branch; }' \
     > artifacts/bot-errors-readiness/2026-06-10/routing-host-status.txt
   ```

4. Write `artifacts/bot-errors-readiness/2026-06-10/README.md`:

   ```markdown
   # BOT ERRORS Readiness Evidence - 2026-06-10

   Current decision: advisory and supervised.

   This directory stores reproducible evidence for the BOT ERRORS / Q-loop unattended-readiness gate.

   Required before go:
   - Clean fetchable commit hash reviewed by Q.
   - Routing-host drift reconciliation.
   - BOT ERRORS suite and typecheck logs.
   - Q-loop poll and heartbeat proof.
   - OpenCode worker artifact validation.
   - Per-machine rollout evidence for the lab hosts and minis.
   ```

### Task 2: Prove The Current BOT ERRORS Code In A Clean, Named Commit

Files:
- Create: `artifacts/bot-errors-readiness/2026-06-10/q-clean-commit-request.md`
- Modify only after review: BOT ERRORS source, deploy scripts, and tests already touched by the hardening branch.

Steps:

1. Create `artifacts/bot-errors-readiness/2026-06-10/q-clean-commit-request.md`:

   ```markdown
   # Q Clean Commit Request

   Requested branch: chore/ff038-eslint-ring
   Requested proof: full dependency closure, not a named-file slice.
   Required Q checks:
   - npm run typecheck:all
   - npm run guard:test-integrity
   - npm test -- tests/scripts/bot-errors-emit.test.ts tests/scripts/bot-errors-runner.test.ts tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-collector.test.ts tests/scripts/bot-errors-heartbeat-watchdog.test.ts tests/scripts/bot-errors-health-check.test.ts tests/scripts/bot-errors-q-loop.test.ts tests/scripts/bot-errors-service-templates.test.ts tests/lib/emit-alert.test.ts --pool=forks

   Do not approve from dirty working tree evidence.
   ```

2. Inspect branch dependency closure before staging:

   ```bash
   git diff --name-only
   git diff --cached --name-only
   ```

3. Run local proof before any commit:

   ```bash
   npm run typecheck:all
   npm run guard:test-integrity
   npm test -- tests/scripts/bot-errors-emit.test.ts tests/scripts/bot-errors-runner.test.ts tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-collector.test.ts tests/scripts/bot-errors-heartbeat-watchdog.test.ts tests/scripts/bot-errors-health-check.test.ts tests/scripts/bot-errors-q-loop.test.ts tests/scripts/bot-errors-service-templates.test.ts tests/lib/emit-alert.test.ts --pool=forks
   ```

4. Ask Lucas before pushing:

   ```text
   Q requires a pushed branch and commit hash for clean verification. I have local evidence ready. Approve pushing chore/ff038-eslint-ring to origin for Q review?
   ```

### Task 3: Reconcile Routing-Host Production Drift

Files:
- Create: `artifacts/bot-errors-readiness/2026-06-10/routing-host-drift-files.txt`
- Create: `artifacts/bot-errors-readiness/2026-06-10/routing-host-drift-inventory.md`
- Create: `artifacts/bot-errors-readiness/2026-06-10/routing-host-bot-errors-verification.txt`

Steps:

1. Capture routing-host dirty file list:

   ```bash
   ssh "$ROUTING_HOST" 'cd ~/LAB/WhatSoup && git status --short' \
     > artifacts/bot-errors-readiness/2026-06-10/routing-host-drift-files.txt
   ```

2. Create `artifacts/bot-errors-readiness/2026-06-10/routing-host-drift-inventory.md`:

   ```markdown
   # Routing-Host Drift Inventory

   Each row must be completed before rollout.

   | Path | Owner | Purpose | Keep/Drop | Verification |
   | --- | --- | --- | --- | --- |
   | deploy/scripts/bot-errors-dispatcher.py | BOT ERRORS | dispatcher archive and incident behavior | keep pending Q review | BOT ERRORS suite |
   | tests/scripts/bot-errors-dispatcher.test.ts | BOT ERRORS | dispatcher regression tests | keep pending Q review | BOT ERRORS suite |
   | tests/lib/emit-alert.test.ts | BOT ERRORS | producer and JID regression tests | keep pending Q review | BOT ERRORS suite |
   ```

3. Run routing-host BOT ERRORS proof:

   ```bash
   ssh "$ROUTING_HOST" 'cd ~/LAB/WhatSoup && npm test -- tests/scripts/bot-errors-emit.test.ts tests/scripts/bot-errors-runner.test.ts tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-collector.test.ts tests/scripts/bot-errors-heartbeat-watchdog.test.ts tests/scripts/bot-errors-health-check.test.ts tests/scripts/bot-errors-q-loop.test.ts tests/scripts/bot-errors-service-templates.test.ts tests/lib/emit-alert.test.ts --pool=forks && npm run typecheck:all' \
     > artifacts/bot-errors-readiness/2026-06-10/routing-host-bot-errors-verification.txt
   ```

### Task 4: Validate Archive And Suppression Semantics

Files:
- Modify: `deploy/scripts/bot-errors-dispatcher.py`
- Test: `tests/scripts/bot-errors-dispatcher.test.ts`
- Test: `tests/scripts/bot-errors-collector.test.ts`

Steps:

1. Run archive collision regression:

   ```bash
   npm test -- tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-collector.test.ts --pool=forks -t "same-second sent archives|dedupes a stale remote writefail claim"
   ```

2. Run full dispatcher and collector tests:

   ```bash
   npm test -- tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-collector.test.ts --pool=forks
   ```

3. Inspect archive usage:

   ```bash
   rg "unique_archive_path|\\.sent|\\.suppressed" deploy/scripts/bot-errors-dispatcher.py tests/scripts/bot-errors-dispatcher.test.ts
   ```

Expected: dispatcher uses `unique_archive_path` for both sent and suppressed archive moves.

### Task 5: Validate Routing Environment On Live Services

Files:
- Create: `artifacts/bot-errors-readiness/2026-06-10/routing-host-service-state.txt`

Steps:

1. Verify routing-host env file exists without printing secrets:

   ```bash
   ssh "$ROUTING_HOST" 'test -r ~/.config/whatsoup/bot-errors.env && echo bot-errors-env-readable'
   ```

2. Verify required keys are present without values:

   ```bash
   ssh "$ROUTING_HOST" 'set -a; . ~/.config/whatsoup/bot-errors.env; set +a; for key in BOT_ERRORS_JID BOT_ERRORS_EXPECTED_JID BOT_ERRORS_SOCKET BOT_ERRORS_DB; do [ -n "${!key:-}" ] && echo "$key=set" || echo "$key=missing"; done'
   ```

3. Capture service and timer state:

   ```bash
   ssh "$ROUTING_HOST" 'systemctl --user status --no-pager bot-errors-dispatcher.service bot-errors-q-loop.service bot-errors-collector.service bot-errors-health-check.timer bot-errors-heartbeat-watchdog.timer' \
     > artifacts/bot-errors-readiness/2026-06-10/routing-host-service-state.txt
   ```

### Task 6: Validate Q-Loop Supervision

Files:
- Create: `artifacts/bot-errors-readiness/2026-06-10/q-loop-poll.txt`

Steps:

1. Poll Q-loop with env sourced:

   ```bash
   ssh "$ROUTING_HOST" 'cd ~/LAB/WhatSoup && set -a && . ~/.config/whatsoup/bot-errors.env && set +a && python3 deploy/scripts/bot-errors-q-loop.py --once --no-send' \
     > artifacts/bot-errors-readiness/2026-06-10/q-loop-poll.txt
   ```

2. Confirm blocked state remains blocked until Q approves:

   ```bash
   rg '"phase": "blocked_by_q"|blocked_by_q' artifacts/bot-errors-readiness/2026-06-10/q-loop-poll.txt
   ```

### Task 7: Validate OpenCode Worker Evidence

Files:
- Create: `artifacts/bot-errors-readiness/2026-06-10/opencode-worker-nonempty.txt`
- Create: `artifacts/bot-errors-readiness/2026-06-10/opencode-worker-empty.txt`
- Create: `artifacts/bot-errors-readiness/2026-06-10/opencode-worker-evidence.md`

Steps:

1. Inventory existing worker outputs:

   ```bash
   find artifacts/opencode-workers -maxdepth 1 -type f -name '*.md' -size +0c | sort \
     > artifacts/bot-errors-readiness/2026-06-10/opencode-worker-nonempty.txt
   find artifacts/opencode-workers -maxdepth 1 -type f -name '*.md' -size 0c | sort \
     > artifacts/bot-errors-readiness/2026-06-10/opencode-worker-empty.txt
   ```

2. Create `artifacts/bot-errors-readiness/2026-06-10/opencode-worker-evidence.md`:

   ```markdown
   # OpenCode Worker Evidence

   Empty reports are failed evidence and cannot support readiness.

   Accepted as advisory input:
   - artifacts/opencode-workers/bot-errors-disaster-matrix-20260610-1615.md
   - artifacts/opencode-workers/bot-errors-monitors-probes-20260610-1615.md
   - artifacts/opencode-workers/bot-errors-coverage-integrity-20260610-1615.md
   - artifacts/opencode-workers/g10-fallback-gate-review-20260610-1615.md

   Rejected evidence:
   - Any zero-byte worker report.

   Promotion rule:
   Only Codex or Q can promote a worker finding from advisory to accepted after checking it against code and tests.
   ```

### Task 8: Produce The Go/No-Go Summary For Q

Files:
- Create: `artifacts/bot-errors-readiness/2026-06-10/go-no-go-summary.md`

Steps:

1. Create `artifacts/bot-errors-readiness/2026-06-10/go-no-go-summary.md`:

   ```markdown
   # BOT ERRORS Go/No-Go Summary

   Decision: NO-GO for unattended completion until Q approves a fetchable commit and routing-host drift reconciliation.

   Green evidence:
   - BOT ERRORS focused tests on the routing host.
   - Typecheck on the routing host.
   - Heartbeat watchdog one-shot on the routing host.
   - Services active on the routing host.

   Blocking evidence:
   - Q has not approved a clean fetchable commit.
   - Routing-host dirty production drift is not captured into a reviewed commit.
   - OpenCode worker empty-output failure mode is not automated.
   - Fleet env provisioning is not proven for the lab hosts and minis.

   Next owner:
   - Codex: prepare evidence and reconcile drift inventory.
   - Q: fetch clean commit and run adversarial verification.
   - Lucas: approve any push/deploy action that leaves the local machine.
   ```

2. Poll Q-loop after writing the summary:

   ```bash
   ssh "$ROUTING_HOST" 'cd ~/LAB/WhatSoup && set -a && . ~/.config/whatsoup/bot-errors.env && set +a && python3 deploy/scripts/bot-errors-q-loop.py --once --no-send'
   ```

## Go/No-Go Rule

Go only when all gates G0-G9 are green and Q replies APPROVED against a fetchable commit plus live routing-host evidence.

No-go if any of these are true:
- Required hardening is uncommitted.
- The routing host differs from the approved commit in files that route, persist, or suppress BOT ERRORS.
- Worker output is empty or unvalidated.
- Expected-JID or sender-line routing is unpinned.
- Any service can fail silently.
- Any alert class can be dropped without durable outbox, writefail breadcrumb, or Q-visible diagnostic.
