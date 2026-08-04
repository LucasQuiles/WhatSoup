# Watchdog Auth-Required Contract — TDD Implementation Plan

**Status:** Active — source implementation and publication hardening are complete; PR #2953 is
open for the merge gate. Host canary, rollout, and installed-state mutation remain owner-gated
and unperformed.

> **For agentic workers:** use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` task-by-task. Keep the checkboxes current.

## Outcome and boundary

Implement the approved source-only repair in
`docs/superpowers/specs/2026-08-03-watchdog-auth-required-contract-design.md`.
The launchd watchdog must distinguish a provider credential that is **dead**
from affirmative **recovery** and inconclusive **unknown** health evidence.
Only affirmative, fresh primary recovery may clear the credential marker.

This plan is self-contained. It replaces all earlier draft/override layers;
do not consult or copy a separate home-local draft during implementation.
It covers repository source, tests, CI, and docs only. Rendering, host canary,
rollout, rollback, on-host marker-consumer discovery, and any service/fleet
mutation require a separate current owner approval and are out of scope.

Worktree at review: `fix/watchdog-auth-required-contract-20260803`,
`5989c32ca25cb0aba9f20ed1ff6e5912ebd60682`, clean. Re-check both before
editing; if they differ, revalidate every quoted source anchor and update this
plan before proceeding.

## Contract to implement

Diagnostic object-shape validation precedes every mutation-authorizing liveness
decision. After that boundary passes, liveness and restart policy have
precedence over credential classification. The embedded Python block returns:

| Exit | Meaning | Shell action | Marker action | Final state |
|---:|---|---|---|---|
| 0 | recovered | no restart | remove only if it exists | `ok` |
| 1 | restart-worthy trusted liveness evidence | existing restart path | unchanged | `RESTARTED`, `RESTART-SUPPRESSED`, or `RESTART-FAILED` |
| 3 | credential dead | never restart | create/retain | `CREDENTIAL-DEAD` |
| 4 | unknown, no active fallback | never restart | unchanged | `CREDENTIAL-UNKNOWN` only if marker exists; otherwise `ok` |
| 5 | unknown, active fallback | never restart | unchanged | `CREDENTIAL-UNKNOWN` |
| 6 | untrusted diagnostic evidence | never restart | unchanged | `HEALTH-UNKNOWN` (shell exit `2`) |

Dead is any of:

1. `turn_capability.model_usability_status == "credential-unavailable"`;
2. `instance.fallbackReason == "auth-required"`; or
3. `turn_capability.last_turn_error_class == "auth-required"` unless a
   parsable later `last_successful_turn_at` supersedes a parsable
   `last_turn_error_at`.

Recovered requires every condition below:

1. no dead signal;
2. `model_usable is True`;
3. `model_usable_stale is False` (not merely non-true);
4. `model_usability_status == "usable"`; and
5. `instance.fallbackReason` is null or absent.

Everything else is unknown. A non-null fallback reason selects exit 5; absent
or null selects exit 4. `model-unavailable`, `provider-unavailable`,
`timeout`, `unknown`, null, future status values, absent/null
`turn_capability`, and non-agent instances are unknown, never credential-dead.
Use fallback-reason **presence**, not an allowlist, for the exit-5 predicate.

Accepted database-compatibility drain and terminal transport-auth branches are
evidence-free no-restart paths: change both from exit 0 to exit 4. Keep their
existing diagnostic stderr lines. The unauthenticated public `/health` envelope
lacks the diagnostic object shape, so it routes to exit 6 and must never reach
recovery or restart.

`last_turn_error_at` and `last_successful_turn_at` are live JSON epoch-
millisecond numbers (`normalizeNumberOrNull`), not ISO strings. The parser must
handle numbers first with `datetime.fromtimestamp(value / 1000, UTC)`, catch
`OverflowError`, `OSError`, and `ValueError`, then accept ISO strings only as a
defensive recorded/future-compatible fallback. Unparseable timestamps must not
turn an auth-required error into recovery: retain the dead signal unless both
timestamps parse and success is later.

Final state uses an upgrade-only ladder:

`CREDENTIAL-DEAD` (6) > `HEALTH-UNKNOWN` (5) >
`RESTARTED`/`RESTART-SUPPRESSED`/`RESTART-FAILED` (4) > `ERROR` (3) >
`CREDENTIAL-UNKNOWN` (2) > `ok` (1). Equal rank retains the first writer.
`restart_label` itself records restart outcome at permanent-stop, cooldown, and
kickstart terminal points. Call sites, including fleet health, do not assign a
lower final state afterward.

Untrusted diagnostic evidence uses shell exit `2`; marker, log, rotation,
bootstrap, kickstart, and cooldown-stamp failures also make the invocation
nonzero without authorizing an unrelated restart. The existing
`StartInterval=120`, `KeepAlive=false`, no `SuccessfulExit` plist behavior
means launchd does not use those codes as a restart trigger.

## Non-negotiable source constraints

- Modify the one canonical template: `deploy/templates/watchdog-script.sh`.
  Do not create a renderer or another decision block; use
  `deploy/scripts/render-watchdog.py` for render/verify.
- Preserve exactly one `python3 - <<'PY'` heredoc; its `PY` terminator stays at
  column zero with a following newline. Both TS and Python extractors depend on
  this shape.
- Do not reshape `if status not in ("healthy", "degraded"):`; the provider
  probe classifier regex-pins it. Do not touch the `NODE_BIN` line.
- Renderer replacement is substring based. New identifiers/text must not
  contain `BOT_NAME`, `BOT_PORT`, `FLEET_PORT`, `USERNAME`, or `__HOME__` as a
  substring. Preserve the header’s `USERNAME` token.
- Retain the TS static pins: exit-3 is the first `py_rc` branch; the 4/5 branch
  precedes generic nonzero restart; marker state/create/clear operations route
  only through the descriptor-confined helper; bearer-auth transport remains
  absent from curl argv.
- New test code must not discard stderr. Existing harness skips are not proof:
  the final pytest command must report zero skipped.
- Do not place credentials, chat IDs/content, private hostnames, accounts, or
  local paths in committed fixtures, logs, comments, commit messages, or docs.
- Do not change `deploy/managed-components.json`. Change
  `deploy/scripts/render-watchdog.py` or the terminal-logout E2E test only when
  a reproduced contradiction proves it necessary; the publication-blocker
  wave below records both justified changes and their regression tests.

## Known limitations to record, not conceal

`fallbackReason` retains its original arm reason across extensions; a fallback
success clears `last_turn_error_class`; and model usability is probed only at
startup then becomes stale after 30 minutes. Their combined case must surface
as exit 5 / `CREDENTIAL-UNKNOWN` while a fallback window remains active; it is
not a proof of credential health. Runtime-side re-probing, provider-aware
success tracking, and current-cause fallback reasons are follow-up work.

No in-repository consumer of the marker or final watchdog state was found.
External/on-host consumers are unknown and must be checked in the separately
authorized rollout phase. Do not claim a fleet console consumes the marker.

## Preflight and execution discipline

- [x] Confirm repository identity and a clean starting state:

  ```bash
  git rev-parse --show-toplevel
  git rev-parse HEAD
  git status --short
  ```

  Expected: the reviewed worktree, `5989c32ca…` before implementation commits,
  and no unrelated changes. Stop rather than overwrite a dirty overlapping
  change.

- [x] Activate and prove Node **24.15.0** before every `npx`/`npm` command.
  The review environment observed `v26.5.1`, which is out of the repository
  range and is inconclusive for JavaScript test results.

  ```bash
  whatsoup_node24="$HOME/.nvm/versions/node/v24.15.0/bin"
  test -x "$whatsoup_node24/node"
  export PATH="$whatsoup_node24:$PATH"
  test "$(node --version)" = "v24.15.0"
  node --version
  ```

  If that binary is absent, use the repository’s approved Node manager to
  install/select the exact `.nvmrc` value, rerun the assertions, and record the
  receipt. Do not silently fall back to PATH Node. Repository `npm` scripts
  already invoke `scripts/run-with-pinned-node.sh`; direct `npx vitest` needs
  this explicit shell activation.

- [x] Use TDD per task: add/adjust the named tests, run the focused command and
  observe the expected red failure, implement the smallest change, rerun green,
  then commit only task-owned paths. A masked failure, timeout, or skip is
  inconclusive, not green.

## Task 1 — Amend the contract and commit this plan

**Files:**
`docs/superpowers/specs/2026-08-03-watchdog-auth-required-contract-design.md`,
new `docs/superpowers/plans/2026-08-03-watchdog-auth-required-contract.md`.

- [x] Amend the design spec before code so it states exits 0/1/3/4/5, the
  table above, exit-4 stderr silence, exit-5 fallback diagnostics, and D2’s
  drain/terminal-auth exit-4 marker retention.
- [x] Replace the original “current by construction” wording with: fallback
  reason **presence** is current window state, but its value can be a frozen
  original arm reason; exact `auth-required` remains sound but incomplete.
- [x] Add the dead-set boundary, all known limitations above, and canary wording:
  healthy idle is an unknown-quiescent `ok` tier test; fixture harness proves
  affirmative clearing. The operational canary remains out of this source plan.
- [x] Document the final-state ladder and that only marker mutation failure
  returns nonzero. Include source changes for restart-policy tests, tiering
  suite, curated TS test registration, and CI zsh installation.
- [x] Copy the final contents of this reviewed plan into the repository path
  named above without embedding the private source-plan pathname.
- [x] Commit only those docs:

  ```bash
  git add docs/superpowers/specs/2026-08-03-watchdog-auth-required-contract-design.md \
    docs/superpowers/plans/2026-08-03-watchdog-auth-required-contract.md
  git commit -m "docs(deploy): amend watchdog credential contract and implementation plan"
  ```

## Task 2 — Decision classifier, routing, and load-bearing red tests

**Files:** `deploy/templates/watchdog-script.sh`,
`tests/deploy/watchdog-credential-dead.test.ts`,
`deploy/scripts/tests/test_watchdog_restart_policy.py`.

- [x] Update TS fixtures so `recovered` includes all four recovery fields plus
  `instance.fallbackReason: null`. Use `epochMsAgo(seconds): number` for turn
  timestamps; retain ISO timestamps only for `whatsapp.connection.last_pong_at`.
- [x] Add decision tests for: status dead signal; degraded dead signal; the
  stale-usable/auth-required problem shape; exact fallback reason; current
  auth error; a later successful turn; absent/null capability; stale idle;
  bare `usable`; all non-dead status values; non-auth active fallback; public
  envelope exit 1; liveness exit-1 precedence; terminal-auth exit 4; accepted
  drain exit 4. Assert exit-4 is credential-stderr-silent and exit-5 emits
  `CREDENTIAL-UNKNOWN`.
- [x] Keep the bearer-auth describe byte-identical. Update static routing pins
  to require 3 first, a 4/5 no-restart/no-marker branch before generic nonzero,
  and recovery’s checked removal path.
- [x] Update Python policy fixtures: missing credential evidence now means
  exit 4; add fresh recovered evidence to keep exit-0 coverage. Change accepted
  drain and terminal-auth expectations to 4. In every assertion whose meaning
  is “restart-worthy,” use exact `== 1`, not `!= 0`. Commit that assertion
  tightening separately after the load-bearing change so a failure is localizable.
- [x] Run and preserve expected red results:

  ```bash
  npx vitest run --pool=forks tests/deploy/watchdog-credential-dead.test.ts
  python3 -m pytest deploy/scripts/tests/test_watchdog_restart_policy.py --import-mode=importlib -q
  ```

- [x] Implement the classifier after the unchanged liveness branch. Numeric
  timestamp parsing must precede ISO fallback. Set dead-signal text without
  secrets; calculate recovery precisely; emit 5 only for non-null fallback;
  otherwise emit 4. Change accepted drain and terminal-auth to exit 4.
- [x] Rewrite the template marker comment to say “last conclusively dead,”
  “cleared only by exit 0,” “4/5 retain,” and “external alert paths may stat
  this file (no in-repo consumer).”
- [x] Add a minimal 4/5 `:` routing branch before generic nonzero restart; do
  not yet alter final-state behavior here. Keep 0 as the sole removal path.
- [x] Run green, including the byte-unchanged terminal E2E and renderer test:

  ```bash
  npx vitest run --pool=forks tests/deploy/watchdog-credential-dead.test.ts
  python3 -m pytest deploy/scripts/tests/test_watchdog_restart_policy.py \
    deploy/scripts/tests/test_watchdog_terminal_logout_e2e.py \
    deploy/scripts/tests/test_render_watchdog.py --import-mode=importlib -q
  ```

- [x] Commit classifier/routing and then the exact-exit assertion hardening as
  two commits:

  ```bash
  git commit -m "fix(deploy): add watchdog dead recovered unknown contract"
  git commit -m "test(deploy): tighten watchdog restart-policy exits"
  ```

## Task 3 — Final-state ladder and rendered watchdog tests

**Files:** template, TS static test, new
`deploy/scripts/tests/test_watchdog_credential_tiering.py`.

- [x] Create a pytest rendered-template harness with isolated HOME, unique bot
  names (to avoid `/tmp` lock collision), deterministic curl/launchctl stubs,
  and helpers for dead, recovered, unknown-quiescent, and unknown-fallback
  authenticated bodies. `run()` captures output with a timeout; test assertions
  inspect output and log/call files. The suite is marked skip-if-zsh-missing,
  but the final command must have zero skips.
- [x] Add red tests for all eight marker table rows, no restart on exits 3/4/5,
  exit-0 marker clearing, fallback diagnostics, restart kickstart outcome,
  cooldown/permanent-stop suppressed outcome, and credential-dead outranking a
  fleet restart. Seed restart cooldown using the same `$LOG_DIR/<label>.last-restart`
  path and epoch-second content used by the template.
- [x] Add `wd_rank`/`wd_note` after `log()`. It only upgrades `WD_FINAL`.
  `restart_label` calls `wd_note RESTART-SUPPRESSED` for permanent-stop and
  cooldown and `wd_note RESTARTED` immediately before kickstart. Do not change
  its return contract or add `WD_FINAL` assignments at callers/fleet branch.
- [x] In the exit-3 branch call `wd_note CREDENTIAL-DEAD`. In the 4/5 branch,
  call `wd_note CREDENTIAL-UNKNOWN` only if exit is 5 or marker exists. The
  branch never creates/removes a marker and never restarts.
- [x] Extend the TS static pin to require `CREDENTIAL-UNKNOWN` in the 4/5
  branch and no `restart_label`, `touch`, or removal there.
- [x] Verify red then green:

  ```bash
  python3 -m pytest deploy/scripts/tests/test_watchdog_credential_tiering.py --import-mode=importlib -q
  npx vitest run --pool=forks tests/deploy/watchdog-credential-dead.test.ts
  python3 -m pytest deploy/scripts/tests/test_watchdog_restart_policy.py \
    deploy/scripts/tests/test_watchdog_credential_tiering.py \
    deploy/scripts/tests/test_watchdog_terminal_logout_e2e.py \
    deploy/scripts/tests/test_render_watchdog.py --import-mode=importlib -q
  ```

- [x] Commit:

  ```bash
  git commit -m "fix(deploy): record watchdog final-state escalation ladder"
  ```

## Task 4 — Fail-closed marker I/O

**Files:** template and tiering suite.

- [x] Add red whole-script tests for marker creation failure and marker removal
  failure. Use a non-root-only permission fixture for creation (preserve the
  pre-existing log file so logging remains testable) and a marker directory
  containing a child for removal. Restore permissions in `finally`.
- [x] Require each test to prove: nonzero watchdog exit, exact `ERROR: failed
  to create|clear credential marker` logged through the normal log file,
  expected marker retention/absence, unchanged final state (`CREDENTIAL-DEAD`
  on create failure, `ok` on clear failure), and no kickstart. The non-root
  skip is a test-environment limitation; run this proof on a non-root runner
  before accepting the task.
- [x] Initialize `WD_EXIT=0`; set it to 1 only after guarded
  `touch "$CRED_MARKER" 2>>"$LOG"` or guarded
  `rm -f "$CRED_MARKER" 2>>"$LOG"` fails. Use `log()` for the error. At the
  common tail retain `log "$WD_FINAL"` then `exit "$WD_EXIT"`. Do not use
  `2>/dev/null || true`; do not restart on mutation failure.
- [x] Verify green with the Task-3 command. Assert existing restart-policy
  full-script paths still return 0; only marker mutation failure returns 1.
- [x] Commit:

  ```bash
  git commit -m "fix(deploy): fail closed on watchdog credential marker I/O"
  ```

## Task 5 — CI/gate registration and runbook

**Files:** `scripts/push-gate.ts`, `.github/workflows/quality.yml`,
`docs/runbook.md`.

- [x] Append `tests/deploy/watchdog-credential-dead.test.ts` to
  `CURATED_TEST_PATHS`; no new registry exists. In quality workflow’s existing
  apt install line add `zsh`, with a concise comment that it prevents rendered
  watchdog suites from skipping. Do not alter other jobs.
- [x] Add a **Launchd Watchdog Credential Marker** subsection after the
  database compatibility section and before Quick Health Check in `## 4. Health
  Endpoint`. Name the per-host launchd watchdog explicitly; do not confuse it
  with section 5.8 operation tracker or BOT ERRORS.
- [x] Document marker path generically, the table above, authenticated-health
  prerequisite, final-state ladder, reauth guidance, expected post-reauth
  unknown interval, marker-I/O error handling, and known limitations. Check
  actual heading anchors at edit time instead of citing guessed section numbers.
- [x] Verify:

  ```bash
  npx vitest run --pool=forks tests/scripts/push-gate-manifest.test.ts \
    tests/scripts/doc-drift-check.test.ts \
    tests/scripts/public-surface-drift-check.test.ts \
    tests/scripts/guard-doc-tally.test.ts
  npm run typecheck:scripts
  ```

- [x] Commit CI/gate then runbook separately:

  ```bash
  git commit -m "test(scripts): gate watchdog credential suite and install zsh"
  git commit -m "docs(runbook): document launchd watchdog credential marker"
  ```

## Task 6 — Final source verification and handoff

- [x] Re-run the exact Node 24.15.0 assertion, then:

  ```bash
  npx vitest run --pool=forks tests/deploy/watchdog-credential-dead.test.ts
  python3 -m pytest deploy/scripts/tests/test_watchdog_restart_policy.py \
    deploy/scripts/tests/test_watchdog_credential_tiering.py \
    deploy/scripts/tests/test_watchdog_terminal_logout_e2e.py \
    deploy/scripts/tests/test_render_watchdog.py --import-mode=importlib -q
  npm run typecheck
  npm run typecheck:scripts
  ```

  Require zero pytest skips; if a skip occurs, stop and fix the runner/CI proof.

- [x] Render, syntax-check, and verify one sanitized temporary artifact. Remove
  only that explicit temporary file after all three commands succeed:

  ```bash
  render_out=/tmp/zz-rendered-watchdog-auth-required-contract.sh
  python3 deploy/scripts/render-watchdog.py render \
    --template deploy/templates/watchdog-script.sh --bot-name zz-bot \
    --bot-port 9099 --fleet-port 9098 --home /tmp/zz-home --out "$render_out" --json
  zsh -n "$render_out"
  python3 deploy/scripts/render-watchdog.py verify --script "$render_out"
  rm -f "$render_out"
  ```

- [x] Run quality and branch gates:

  ```bash
  npm run guard:test-integrity
  npm run verify:push:branch
  ```

- [x] Report all commit SHAs, exact command results, Node receipt, and any
  skip/failure. State only that source implementation is verified if every
  required command passes. State explicitly that operational rollout remains
  unperformed and owner-gated.

## Acceptance and follow-up boundary

Source acceptance requires every table row and precedence case above to be
covered by a real test, the template constraints preserved, docs/CI co-updated,
and all Task-6 gates green under Node 24.15.0. A passing source plan does not
prove installed watchdog drift, fleet consumer behavior, or production health
semantics; those are rollout-phase receipts or runtime follow-up work.

---
## BASELINE AT EXECUTION — 4634c8cae (recorded 2026-08-03)

The review snapshot above (`5989c32ca…, clean`) predates two implementation
commits that landed on this branch before plan execution began:

- `c61172f04` "fix(watchdog): classify current provider auth failures" — the
  three dead signals with the numeric-first supersession guard, the exact
  recovered conjunction, unknown → exit 4 (marker untouched, no restart),
  guarded marker I/O with `WD_EXIT`, enriched TS fixtures, and a runbook
  section on the provider-credential states.
- `4634c8cae` "fix(watchdog): preserve markers outside provider recovery" —
  drain-accepted and terminal transport-auth stopped clearing the marker
  (routed at the time to an exit `5` "NO-RESTART" hold), marker create made
  conditional on absence (retain leaves mtime untouched), and rendered-template
  behavioral tests for the marker state machine and marker I/O failures were
  added to `test_watchdog_terminal_logout_e2e.py`.

The owner directed convergence to THIS plan's contract (decision recorded
2026-08-03): exit `5` means unknown-with-active-fallback and logs
`CREDENTIAL-UNKNOWN`; drain and terminal transport-auth route to exit `4`
(unknown-quiescent); there is no `NO-RESTART` final state. Remaining work
executed on top of `4634c8cae`:

1. Reroute drain/terminal-auth from exit `5` to exit `4`; redefine exit `5`
   as the fallback-active unknown tier (predicate: `instance.fallbackReason`
   non-null, presence not value); make exit `4` stderr-silent.
2. Tiered final logging: `CREDENTIAL-UNKNOWN` only when a marker is present
   or the window is active; quiescent unknown stays `ok`.
3. Per-signal dead diagnostics; read `fallbackReason` only (no invented
   snake_case fallback); qualify the marker header comment's external-consumer
   claim.
4. Final-state escalation ladder (`wd_rank`/`wd_note`) with restart outcomes
   recorded inside `restart_label`; restart paths stop reporting a final `ok`.
5. Marker I/O rework: `ERROR: failed to create|clear credential marker` via
   `log()` with `2>>"$LOG"` on the mutation; the final state is unchanged by a
   marker failure (`CREDENTIAL-DEAD` on create-fail, `ok` on clear-fail — no
   `WATCHDOG-ERROR` state); nonzero invocation exit retained.
6. Test updates for the converged vocabulary (TS + restart-policy), exact
   `== 1` restart assertions, and the new
   `test_watchdog_credential_tiering.py` ladder/tiering suite.
7. Gate registration (curated TS test, CI zsh) and runbook alignment with the
   final vocabulary.

The marker state machine and marker I/O failure proofs added to
`test_watchdog_terminal_logout_e2e.py` in `4634c8cae` cover the marker-action
column of the state table; the tiering suite covers the final-log column.
Together every row is behaviorally proven.

---
## POST-ADJUDICATION HARDENING — 90d0ac913 (recorded 2026-08-03)

The lead reproduced current-head failures after the earlier plan gates passed. Execute this wave
under the worktree writer lease; OpenCode strategy lanes stay read-only and advisory.

### Task 7 — RED tests for untrusted health evidence

- [x] Add rendered-harness tests requiring final `HEALTH-UNKNOWN`, process exit `2`, no kickstart,
  and no marker mutation for empty, malformed, duplicate-key, oversized, invalid top-level,
  non-object `whatsapp`, and non-object `connection` bodies.
- [x] Add future-success and future-pong cases. Both must be `HEALTH-UNKNOWN`; a future success must
  not supersede a current auth-required error.
- [x] Add the static TypeScript contract assertions for decision exit `6`, shell exit `2`, final
  state, duplicate-key rejection, and the 64 KiB boundary.
- [x] Run the focused Python and TypeScript tests and record the expected RED failures before editing
  the template.

### Task 8 — Implement `HEALTH-UNKNOWN`

- [x] Add exit `6` to the embedded Python decision contract and map it to `HEALTH-UNKNOWN`,
  `WD_EXIT=2`, no restart, and no marker mutation.
- [x] Reject duplicate JSON keys, invalid object shapes, empty/oversized bodies, non-finite or
  timezone-naive times, and evidence more than five seconds in the future.
- [x] Preserve the existing exits `0`, `1`, `3`, `4`, and `5` for valid evidence.
- [x] Re-run Task 7 to GREEN; checkpointed with the coupled source hardening in `1852da0b0`.

### Task 9 — Fail closed on token acquisition without argv exposure

- [x] Add RED tests for missing, quoted, duplicate, unsafe-mode, and valid token files. Invalid token
  evidence must skip bot curl and end `HEALTH-UNKNOWN`/exit `2` without marker mutation.
- [x] Add an argv-capture test proving a valid token is absent from curl argv, `-H` is absent, and
  `--config -` is present.
- [x] Implement the self-contained descriptor reader described in the amended design and add
  characterization tests for its accepted and rejected cases. The two implementations currently
  have independent coverage; an executable shared-fixture parity corpus remains follow-up work.
- [x] Send the validated token through the zsh builtin to `curl --config -` stdin, clear the
  unexported variable, and remove the lenient `sed`/`AUTH_ARGS` path.
- [x] Re-run focused token, renderer, and watchdog tests to GREEN; checkpointed in `1852da0b0`.

### Task 10 — Fail closed on watchdog-internal state errors

- [x] Add RED tests for a future cooldown stamp, failed `launchctl bootstrap`, failed log rotation,
  and fleet-down plus rejected fleet kickstart.
- [x] Reject future cooldown stamps as invalid, do not suppress the needed restart, and retain a
  nonzero result.
- [x] Propagate bootstrap, rotation, and post-open logging failures without masking stronger final
  states.
- [x] Prove the fleet kickstart failure produces `RESTART-FAILED`, nonzero exit, and no cooldown
  stamp. Re-run focused suites to GREEN; checkpointed in `1852da0b0`.

### Task 11 — Current-head review and gates

- [x] Re-run every command from Task 6 under Node `24.15.0`, require zero Python skips, render one
  sanitized artifact, and run `npm run guard:test-integrity` plus
  `npm run verify:push:branch`.
- [x] Re-run the benign adversarial counterexamples recorded in the local
  current-head adjudication packet.
- [x] Obtain independent read-only review from both strategy panes, verify every decisive claim at
  the lead, and record residual medium-risk work explicitly.
- [x] Do not merge, canary, deploy, alter launchd state, or access a real token in this source wave.

### Task 12 — Publication-blocker closure

- [x] Replace basic-offset pong fixtures with RFC 3339-compatible offsets so the watchdog tests run
  under the macOS system Python as well as newer Python releases.
- [x] Interpret live numeric turn timestamps as epoch milliseconds and replace toy timestamp
  fixtures with production-shaped epoch-millisecond values.
- [x] Validate non-object `turn_capability` before any liveness decision can authorize a restart;
  prove the combined malformed-shape/liveness-failure case through the rendered script.
- [x] Reject reserved template-placeholder substrings in renderer identity values so sequential
  replacement cannot silently corrupt `--home` while reporting a clean artifact.
- [x] Reconcile the design, runbook, execution checklist, and work index, then rerun final gates.
- [x] Publish the reviewed branch and open PR #2953 against `main`.

## Remaining objectives after source merge

These are explicit follow-on work, not hidden source-wave completion criteria:

1. Obtain separate owner approval for sanitized render/canary, installed-artifact drift proof,
   one-host-at-a-time rollout, rollback receipts, and on-host marker-consumer discovery.
2. Add a shared executable fixture corpus that proves the rendered Python token reader and
   `src/fleet/health-token-file.ts` stay behaviorally aligned.
3. Address runtime-side re-probing, provider-aware success tracking, and current-cause fallback
   reasons described in the accepted detection limitations.
