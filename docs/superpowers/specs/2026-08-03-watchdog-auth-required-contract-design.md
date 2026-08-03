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
restart-worthy failures retain exit code `1`; terminal transport-auth states and valid database
compatibility drains use exit code `5` to preserve their existing no-restart behavior without
being mistaken for provider recovery. Exit `5` never mutates the credential marker. Credential
classification runs only after those checks pass.

The credential state is one of three values:

### `dead`

Any one of these current signals is sufficient:

1. `turn_capability.model_usability_status == credential-unavailable`;
2. `instance.fallbackReason == auth-required`; or
3. `turn_capability.last_turn_error_class == auth-required` and the error is not superseded by a
   later successful turn.

The decision block exits `3`. The shell logs `CREDENTIAL-DEAD`, creates or retains the marker, and
does not call `restart_label`.

The active fallback reason is current by construction: the runtime returns it only while the
fallback window is active. The turn tracker clears its last error on a successful user turn; the
timestamp comparison remains a defensive guard for recorded or future-compatible payloads.

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

Every other liveness-passing payload is inconclusive. Examples include missing turn-capability
data, stale usability without a current auth error, or an unrecognized future shape.

The decision block exits `4`. The shell does not restart the bot and does not create or remove the
credential marker. Its final log state is `CREDENTIAL-UNKNOWN`, making the coverage gap visible
without inventing either failure or recovery.

## Marker state machine

| Prior marker | Credential state | Result |
|---|---|---|
| absent | dead | create marker; log `CREDENTIAL-DEAD`; no bot restart |
| present | dead | retain marker; log `CREDENTIAL-DEAD`; no bot restart |
| absent | recovered | remain absent; log `ok` |
| present | recovered | remove marker; log `ok` |
| absent | unknown | remain absent; log `CREDENTIAL-UNKNOWN` |
| present | unknown | retain marker; log `CREDENTIAL-UNKNOWN` |

Marker mutation errors must not be masked as success. A failed create or clear is logged as a
watchdog error and makes that watchdog invocation exit nonzero without calling `restart_label`.
The next scheduled invocation may retry the marker transition.

## Source changes

The change is intentionally limited to:

- `deploy/templates/watchdog-script.sh`: implement the three-state credential decision and marker
  transition handling;
- `tests/deploy/watchdog-credential-dead.test.ts`: add sanitized current-health regressions,
  recovery/unknown coverage, precedence checks, and shell-wiring assertions; and
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
2. A healthy, idle target proves the negative path: no marker appears, the watchdog logs `ok`, the
   bot PID is unchanged, and no restart line occurs.

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
