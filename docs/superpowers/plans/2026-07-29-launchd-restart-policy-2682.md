# launchd Restart-Policy Reconciliation Follow-up Plan

> Execute in the isolated branch
> `fix/launchd-migration-followup-20260729`.

**Status:** active

**Goal:** Provide the safe, opt-in migration and pairing/lifecycle behavior
needed after merged PR #2699 changed generated macOS instance plists to restart
nonzero application exits with a bounded cadence. This main-based follow-up
does not reopen or close #2682, which #2699 already resolved.

**Architecture:** Merged PR #2699 remains the owner of the generated
`KeepAlive` shape. This branch extends `src/fleet/platform.ts` as the owner of generated
plist identity validation, safe reloads, and service-manager behavior. A pure
instance-name policy is shared by routes, the platform owner, and the migration
CLI. macOS `enable()` remains non-starting because the create flow invokes it
before QR pairing. The authenticated path first boots out an existing job,
waits until credentials are persisted, the helper exits successfully, and its
stdio closes, then installs or reloads the plist. The CLI is dry-run by default and accepts no
paths, labels, domains, or shell fragments.

**Constraints:** Do not repeat #2699's generator/test/runbook change, deploy,
restart a live service, inspect operational state, modify Linux/Docker service
definitions, or expose configuration/credential/log content. The shared auth
completion gate is intentional across service managers; launchd reconciliation
remains macOS-only. Keep #2698, #2511, watchdog work, and the unrelated
fallback-PATH change out of this PR. Treat skipped, masked, or interrupted
checks as inconclusive.

---

## Task 1: Lock the migration and lifecycle contracts with failing tests

**Files:**

- Modify: `tests/fleet/platform-service-manager.test.ts`
- Modify: `src/fleet/platform.ts`

1. Treat merged PR #2699's combined restart policy as a prerequisite, rather than
   asserting or changing that generator contract here.
2. Prove creation does not write or load a pre-auth plist. Prove the later
   authenticated activation installs/reloads it through GUI-domain
   `bootout`/`bootstrap`/`kickstart -k` operations.
3. Replace legacy label-only `launchctl start`/`stop` control paths with
   service-target operations so a deliberate stop cannot be immediately undone
   by the new KeepAlive policy.
4. Create temporary plist files with an explicit non-writable mode before
   same-directory rename; preserve atomic replacement and cleanup semantics.

## Task 2: Add a fail-closed one-instance reconciler

**Files:**

- Modify: `src/fleet/platform.ts`
- Modify: `tests/fleet/platform-service-manager.test.ts`

1. Require a valid instance name and an existing plist whose Label and
   ProgramArguments match the stable WhatSoup-generated structural identity
   before a migration overwrites it; do not represent that structural check as
   proof of file authorship.
2. On `--apply`, render a complete temporary plist, atomically rename it,
   strictly `bootout` the GUI-domain service, then `bootstrap` and
   `kickstart -k` it.
3. On a failed bootstrap or kickstart, boot out a partially loaded new job,
   restore the old bytes, and attempt to restore the old job. Surface both the
   primary and rollback failures. A failed initial bootout restores bytes and
   aborts without guessing why it failed.
4. Prove dry-run is non-mutating; prove unsafe names, missing plists, and
   non-generated identities fail before any filesystem mutation or launchctl
   action.

## Task 3: Preserve a truthful pairing result

**Files:**

- Modify: `src/transport/auth.ts`
- Modify: `src/fleet/routes/ops.ts`
- Modify: `tests/transport/auth-cli-creds-save-failure.test.ts`
- Modify: `tests/fleet/routes/ops.test.ts`

1. Emit the `connected` helper event only after credentials save successfully.
2. Do not activate the service until the helper exits zero and its stdio closes
   after that event.
3. Bound the post-persistence wait; if the helper does not exit promptly, stop
   it and restore the prior service rather than stranding the instance.
4. Keep an SSE client close from killing a helper that has persisted pairing
   but has not yet cleanly exited and closed its stdio.
5. Wait for authenticated activation to report success or failure. On failure,
   send a sanitized SSE error rather than leaving a successful-pairing receipt
   that implies the instance is running.

## Task 4: Provide and document the bounded operator CLI

**Files:**

- Add: `scripts/reconcile-launchd-restart-policy.ts`
- Add: `tests/scripts/reconcile-launchd-restart-policy.test.ts`
- Modify: `package.json`
- Modify: `docs/runbooks/macos-launchd-deployment.md`
- Modify: `docs/runbooks/macos-host-setup.md`
- Modify: `docs/public-surface.md`

1. Support exactly one `--instance`, dry-run by default, and explicit `--apply`
   for an existing generated plist from the policy that #2699 introduced.
2. Print only a safe label and outcome; never print plist bytes or environment
   data. Expose the command through the pinned-node package script.
3. Document the generated policy, identity check, rollback behavior, and the
   explicit bootstrap/kickstart recovery sequence for a deliberately unloaded
   job. Do not prescribe fleet-wide migration.

## Task 5: Validate, review, and publish the draft

1. Run focused suites, typechecks, source lint, test-integrity, repository and
   publication guards, an exact-head review, and the push gate. Distinguish
   local mocks from a live macOS launchctl canary.
2. Re-fetch `origin` and re-check the merged #2699, closed #2682, related merged/closed work, the
   concurrent fallback-PATH PR, and the separate mixed #2682/#2698 lane
   immediately before publication. Preserve the latter without deletion.
3. Obtain independent code review from the supported code-review providers and
   verify every material finding against the actual diff and tests.
4. Commit public-safe scoped changes, push the isolated branch over SSH, and
   open one draft PR against `main`. State that it follows #2699 and do not
   use a closing reference for #2682.
5. Confirm #2699 retains its automatic #2682 reference and #2682 remains
   closed. Do not add a redundant issue comment or change its stale workflow
   label for this non-closing follow-up.
