# Watchdog Auth-Required Contract Design

## Status

Approved approach: staged canonical repair. Source and tests land first, then owner-private
rendered artifacts are canaried and rolled out one host at a time from the reviewed source
revision. No installed script is edited in place.

## Problem

The launchd watchdog currently escalates a provider credential failure only when
`turn_capability.model_usability_status` is exactly `credential-unavailable`. That contract
predates the current health semantics. A current health response can correctly retain a stale
`model_usability_status=usable` while also reporting all of the following:

- `turn_capability.model_usable=null`;
- `turn_capability.model_usable_stale=true`;
- `turn_capability.last_turn_error_class=auth-required`;
- `instance.fallbackReason=auth-required`; and
- an active independent fallback provider.

The bot remains available through fallback, but the watchdog logs `ok` and does not create its
credential marker. This is a monitoring false negative. It is not fixed by restarting the bot,
and a restart may interrupt a live turn without changing the credential.

The existing marker lifecycle has a related evidence problem: a passing liveness decision clears
the marker even when credential evidence is missing or stale. Missing evidence is inconclusive,
not proof of credential recovery.

## Goals

1. Recognize current, normalized `auth-required` evidence without depending on one stale probe
   field.
2. Preserve the existing no-restart response for credential failures.
3. Clear a credential marker only after affirmative fresh primary recovery.
4. Keep liveness/restart decisions higher priority than provider-credential classification.
5. Reuse the canonical template, renderer, managed-component registry, and fleet rollout gates.
6. Prove both positive and negative behavior before a fleet rollout.

## Non-goals

- Reauthenticate a provider account.
- Restart or redeploy a bot application process.
- Change fallback selection, health serialization, or turn-capability tracking.
- Add a second renderer or a host-specific watchdog fork.
- Resolve the separately documented fleet-console/watchdog incompatibility on an excluded host.
- Replay durability or operator catch-up records.

## Considered approaches

### Source-only repair

This produces a reviewable fix with no live risk, but installed watchdogs remain divergent until a
later operation. It is insufficient as the complete fleet-alignment outcome.

### Immediate host patches

Editing installed scripts directly restores the missing signal quickly, but creates unreviewed
host-local code, inconsistent hashes, and another reconciliation burden. This approach is
rejected.

### Staged canonical repair

Fix the source template and tests on current main, render every host artifact through the existing
deterministic renderer, validate two complementary canaries, then roll out the same source revision
one host at a time. This is the selected approach because it combines source durability with
measured operational alignment.

## Credential-state contract

The embedded decision block continues to evaluate transport and process liveness first. Existing
restart-worthy failures retain exit code `1`. Terminal transport-auth states and valid database
compatibility drains route to exit code `4` (unknown-quiescent): their no-restart behavior and
stderr detail lines are unchanged, but they no longer clear the credential marker — missing
credential evidence during a drain or a transport-auth outage is inconclusive, not recovery.
Credential classification runs only after those checks pass.

The decision block's complete exit vocabulary is `0` recovered, `1` restart-worthy, `3` dead,
`4` unknown with no active fallback window, `5` unknown while a fallback window is active.

The credential state is one of three values:

### `dead`

Any one of these current signals is sufficient:

1. `turn_capability.model_usability_status == credential-unavailable`;
2. `instance.fallbackReason == auth-required`; or
3. `turn_capability.last_turn_error_class == auth-required` and the error is not superseded by a
   later successful turn.

The decision block exits `3`. The shell logs `CREDENTIAL-DEAD`, creates or retains the marker, and
does not call `restart_label`. The status-based signal is exactly `credential-unavailable`; other
non-usable statuses (`model-unavailable`, `provider-unavailable`, `timeout`, `unknown`) are not
credential death and classify `unknown`.

The fallback reason's PRESENCE is current by construction: the runtime returns it only while the
fallback window is active. Its VALUE, however, is the original arm reason frozen across window
extensions, so the exact `auth-required` match is sound but incomplete (see Known limitations).
The turn tracker clears its last error on a successful user turn; the timestamp comparison
remains a defensive guard for recorded or future-compatible payloads. `last_turn_error_at` and
`last_successful_turn_at` are epoch-millisecond numbers on live payloads; the guard parses
numbers first and accepts ISO strings only as a recorded/future-compatible fallback, and an
unparseable timestamp never converts an auth-required error into recovery.

### `recovered`

Recovery requires all of the following:

- no credential-dead signal above;
- `turn_capability.model_usable == true`;
- `turn_capability.model_usable_stale == false`;
- `turn_capability.model_usability_status == usable`; and
- `instance.fallbackReason` is null or absent.

The decision block exits `0`. The shell may remove an existing credential marker. This is an
affirmative primary-recovery proof, not merely absence of a failure field.

### `unknown`

Every other liveness-passing payload is inconclusive. This includes missing or null
turn-capability data (permanent and correct for non-agent instances — watchdogs install for every
instance type), stale usability without a current auth error, non-dead usability statuses, and
unrecognized future shapes. A truthy non-object `instance` or `turn_capability` value is such a
future shape: the decision block reads nothing from it, and it can never satisfy the recovery
conjunction — a malformed shape must classify unknown, not crash into the restart path or clear
the marker.

The decision block exits `4` when no independent fallback window is active (unknown-quiescent)
and `5` when one is. The fallback-activeness predicate is `instance.fallbackReason` being
non-null — presence, not value, with no timestamp parsing. Neither exit restarts the bot; neither
creates or removes the credential marker.

The shell surfaces the gap only when there is something to surface: the final log state escalates
to `CREDENTIAL-UNKNOWN` when a credential marker is already present or the fallback window is
active (exit `5`); a quiescent unknown with no marker keeps the final log `ok`. This tiering
exists because a healthy idle bot's startup usability proof goes stale within its 30-minute
freshness TTL, so it classifies unknown-quiescent on essentially every cycle — logging
`CREDENTIAL-UNKNOWN` there would page on every healthy idle bot. The quiescent exit is also
stderr-silent for the same reason; exit `5` and the drain/terminal-auth branches keep their
stderr detail lines.

## Marker state machine

| Prior marker | Credential state | Result | Final log |
|---|---|---|---|
| absent | dead | create marker; no bot restart | `CREDENTIAL-DEAD` |
| present | dead | retain marker (mtime untouched); no bot restart | `CREDENTIAL-DEAD` |
| absent | recovered | remain absent | `ok` |
| present | recovered | remove marker | `ok` |
| absent | unknown-quiescent | remain absent | `ok` |
| absent | unknown, fallback window active | remain absent | `CREDENTIAL-UNKNOWN` |
| present | unknown-quiescent | retain marker | `CREDENTIAL-UNKNOWN` |
| present | unknown, fallback window active | retain marker | `CREDENTIAL-UNKNOWN` |

Marker mutation errors must not be masked as success. A failed create or clear is logged as a
watchdog error and makes that watchdog invocation exit nonzero without calling `restart_label`.
The next scheduled invocation may retry the marker transition. The final log state is unchanged
by a marker I/O failure: `CREDENTIAL-DEAD` on a failed create, `ok` on a failed clear — the
error line and the nonzero invocation exit carry the failure.

The final log line is managed by an upgrade-only escalation ladder: `CREDENTIAL-DEAD` >
`RESTARTED`/`RESTART-SUPPRESSED`/`RESTART-FAILED` > `CREDENTIAL-UNKNOWN` > `ok`. Restart
outcomes are recorded inside the restart helper at its terminal points and must be truthful:
`RESTARTED` is recorded only after `launchctl kickstart` returns success, and only a successful
kickstart arms the 5-minute cooldown stamp — a rejected kickstart logs
`ERROR: kickstart failed …`, records `RESTART-FAILED`, and leaves the cooldown unarmed so the
next cycle retries. A cooldown-stamp write failure after a successful restart keeps `RESTARTED`
and surfaces as `ERROR: failed to write restart cooldown stamp …`. A restart-worthy cycle never
reports a final `ok`, and a credential verdict recorded before the fleet-console check survives
it. Restart paths keep the script's exit status `0`; only a credential-marker mutation failure
makes the invocation exit nonzero.

## Known limitations

Three documented evasions are accepted, not fixed, by this design:

1. `instance.fallbackReason` is frozen at the ORIGINAL arm reason across window extensions, so an
   auth-required death that occurs during an open usage-limit fallback window reports
   `usage-limit`, not `auth-required`.
2. A successful fallback turn clears `last_turn_error_class`, erasing the auth-required turn-error
   signal.
3. The usability probe runs once at startup with a 30-minute freshness TTL and is never re-probed,
   so `model_usability_status` can stay a stale `usable` indefinitely.

The combined worst case (all three at once) still lands on unknown-with-active-fallback: exit `5`,
final log `CREDENTIAL-UNKNOWN`. A visible `CREDENTIAL-UNKNOWN` — not a false `ok` — is the
designed detection floor. Runtime-side re-probing, provider-aware success tracking, and
current-cause fallback reasons are follow-up work outside this design.

No in-repository consumer of the marker or final watchdog state exists. External/on-host
consumers are unknown and must be checked in the separately authorized rollout phase.

## Source changes

The change is intentionally limited to:

- `deploy/templates/watchdog-script.sh`: implement the credential decision exits `0/1/3/4/5`,
  marker transition handling, unmasked marker I/O, and the final-log escalation ladder;
- `tests/deploy/watchdog-credential-dead.test.ts`: add sanitized current-health regressions,
  recovery/unknown coverage, precedence checks, and shell-wiring assertions;
- `deploy/scripts/tests/test_watchdog_restart_policy.py`: expectation updates for the new exit
  vocabulary, plus exact-exit (`== 1`) restart assertions;
- `deploy/scripts/tests/test_watchdog_terminal_logout_e2e.py`: rendered-template behavioral
  coverage of the marker state machine and marker I/O failures;
- `deploy/scripts/tests/test_watchdog_credential_tiering.py` (new): rendered-template coverage of
  the final-log ladder and tiering;
- gate registration: `tests/deploy/watchdog-credential-dead.test.ts` joins `CURATED_TEST_PATHS`
  in `scripts/push-gate.ts`, and CI installs `zsh` so the rendered-template suites run in the
  quality workflow; and
- the relevant public runbook section: document the normalized signals, no-restart behavior, and
  proof required for marker clearing.

No new renderer is created. `deploy/scripts/render-watchdog.py` remains the only supported render
and placeholder-verification path. `deploy/managed-components.json` remains the component
inventory.

## Test strategy

Implementation follows red-green-refactor:

1. Add a sanitized degraded payload with stale `usable`, current `auth-required`, and active
   fallback. Confirm the current decision block incorrectly exits `0`.
2. Add a current `auth-required` turn-error payload without an active fallback. Confirm it also
   fails red.
3. Add fresh recovered and inconclusive payloads that pin exits `0` and `4` respectively.
4. Pin crash/restart precedence and terminal transport-auth behavior.
5. Pin shell routing so exits `3` and `4` never call `restart_label`.
6. Pin the marker state transitions and unmasked marker-I/O failures.
7. Run the focused TypeScript suite, canonical renderer tests, watchdog Python policy tests,
   shell syntax, typecheck, test-integrity guard, and the repository's applicable branch gates.

Tests execute the real embedded Python decision block extracted from the template. Static wiring
assertions supplement but do not replace behavioral execution.

## Fleet alignment and drift control

Operational data stays in an owner-private directory outside the public repository. The rollout
manifest records, per target:

- source commit and template SHA-256;
- renderer SHA-256;
- bot name, home, bot port, and fleet port as private parameters;
- expected rendered SHA-256;
- installed preimage SHA-256 and backup path;
- service and watchdog PIDs before and after;
- authenticated health classification before and after;
- expected marker state;
- watchdog log interval and absence of bot restart; and
- exact rollback command and target.

Different rendered hashes are expected when parameters differ. Alignment means every artifact is
reproducible from the same reviewed template and canonical renderer with recorded parameters, not
that every host has byte-identical output.

Installed scripts are never hand-edited. A target is aligned only when the canonical renderer
reproduces its installed hash exactly and placeholder verification reports none remaining.

## Canary and rollout

Before any installation, run rendered scripts against captured, sanitized health fixtures in an
isolated environment. No bot or service-manager label may be reachable from that harness.

Use two live canaries after explicit execution-time approval:

1. A credential-degraded, idle target proves the positive path: marker appears, the watchdog logs
   `CREDENTIAL-DEAD`, the bot PID is unchanged, and no restart line occurs.
2. A healthy, idle target proves the negative path: no marker appears, the watchdog's final log
   state is `ok`, the bot PID is unchanged, and no restart line occurs. Note that a healthy idle
   target classifies unknown-quiescent (exit `4`), not `recovered` — its startup usability proof
   is past the 30-minute freshness TTL. This canary therefore proves the quiescent `ok` tier;
   affirmative marker clearing is proven by the test harness fixtures, not by this canary.

An active provider child, an unproven in-memory queue, ambiguous authenticated health, unexpected
installed preimage, or unrelated watchdog contract drift excludes a target. An excluded target is
recorded and skipped; it is not forced into alignment.

After both canaries pass, continue one host at a time. Each host must pass preimage, render,
transfer, checksum, watchdog-only restart, two-cycle observation, bot-PID continuity, marker, and
authenticated-health gates before the next host begins. The bot application service is never
restarted by the rollout procedure.

## Rollback

Every live installation first preserves a timestamped, mode-preserving backup. Rollback restores
that exact preimage atomically and restarts only the watchdog service. A failed or inconclusive
post-install gate stops the wave; it does not trigger a second attempt or proceed to another host.

The source change remains separate from operational rollout receipts. A successful source test is
not reported as fleet deployment, and a successful canary is not reported as complete fleet
alignment.

## Security and privacy

- Health reads use the existing instance bearer without printing it.
- No credential value, chat identifier, message content, private hostname, user account, or local
  path is committed to the public repository.
- Owner-private rollout receipts contain only the minimum host parameters and bounded metadata.
- Provider inference probes, reauthentication, message sends, database writes, and application
  restarts are outside this design.

## Acceptance criteria

Source acceptance requires:

- the recorded stale-usable/current-auth-required shapes exit `3`;
- fresh usable primary recovery exits `0`;
- missing or stale inconclusive evidence exits `4`;
- credential and unknown states never call `restart_label`;
- markers transition only according to the table above;
- marker mutation failures are observable and nonzero;
- canonical render/verify tests pass with no placeholders; and
- focused tests, typecheck, test-integrity, syntax, and applicable repository guards pass.

Fleet acceptance requires separate owner-approved receipts proving both canaries and every included
target. Exclusions and skipped hosts remain explicit; they cannot be counted as aligned.
