# launchd Restart-Policy Reconciliation Follow-up Design

**Status:** active

## Context

Issue #2682 identifies a supervisor-contract mismatch: generated macOS launchd
plists restart only signal-crashed processes, while the application intentionally
uses nonzero process exits for recoverable failure paths. Linux already treats
those exits as restartable failures through systemd's `Restart=on-failure`.

Merged PR #2699 owns the generator change and its paired #2698 work; GitHub
automatically linked its `Closes #2682` reference and closed both issues. This
design is a main-based, non-closing follow-up for the part #2699 deliberately
leaves to deployment: safe reconciliation of existing generated plists and safe
first activation when the new KeepAlive behavior implies an initial launch. Provider-fallback,
restart-marker, watchdog, and fallback-PATH work remain deliberately excluded.

## Restart Contract

PR #2699 introduced this launchd restart policy:

```xml
<key>KeepAlive</key>
<dict>
  <key>Crashed</key>
  <true/>
  <key>SuccessfulExit</key>
  <false/>
</dict>
<key>ThrottleInterval</key>
<integer>60</integer>
```

launchd ORs KeepAlive dictionary predicates. `Crashed=true` retains restart
coverage for crash-associated signals; `SuccessfulExit=false` adds ordinary
nonzero exits. Both are necessary for parity with the intent of systemd's
failure-restart policy. `ThrottleInterval=60` bounds repeated attempts and
matches an existing in-repository launchd sentinel precedent. This branch does
not modify or re-test that parent-owned generator contract.

The explicit `RunAtLoad=false` remains unchanged, but KeepAlive implies an
initial launch when a plist is loaded. The follow-up therefore prevents a new
instance from loading a plist until pairing succeeds.

## Existing-install Reconciliation

An on-disk plist does not update a job that launchd has already bootstrapped.
The change therefore provides a narrow CLI for exactly one validated instance
name:

- Dry run is the default; `--apply` is required before changing disk or
  invoking launchctl.
- A migration requires an existing plist whose Label and ProgramArguments
  match the stable WhatSoup-generated structural identity. It rejects a plist
  that does not have that form, but cannot prove the authorship of a matching
  file; operators must not use it to take over a hand-managed matching plist.
- The migrator writes a same-directory temporary plist with mode `0644`, then
  atomically renames it into place. This prevents a permissive umask from
  creating a group- or world-writable LaunchAgent plist.
- It runs strict GUI-domain `bootout`, `bootstrap`, and `kickstart -k` in that
  order. A bootstrap or kickstart failure boots out any partially loaded new
  job, restores prior bytes, then attempts to restore the prior job.
- An initial bootout failure restores old bytes and aborts. Only an explicit
  absence result is benign during rollback or intentional stop/disable work;
  authorization and domain errors remain visible.

The fleet's regular macOS controls use service-target operations rather than
the legacy label-only `launchctl start`/`stop` commands. An intentional stop
uses `bootout`; a later start/restart bootstraps the known plist and kickstarts
it. This prevents the KeepAlive policy from immediately defeating a deliberate
stop and keeps control actions in the correct GUI domain.

## Pairing and Activation Contract

Initial creation is deliberately separate. macOS `enable()` records no job
before QR authentication. When re-authenticating an existing instance, the
auth flow boots out its job first so KeepAlive cannot relaunch it while the
runtime lock is needed.

The pairing helper emits `connected` only after credential persistence. The
fleet waits for a clean helper exit and closed stdio after that event before it
installs or reactivates the plist. A bounded post-persistence completion window terminates
a hung helper and restores the prior service; it otherwise keeps the helper
alive if the SSE client closes in this short interval. Activation completion
then determines the final receipt:
success triggers discovery; a failure is logged and sent to the SSE client as a
sanitized error rather than implying the paired instance is running.

## Boundaries and Safety

- The shared pure instance-name policy runs before a name contributes to a
  filesystem path or launchctl target.
- The CLI accepts no arbitrary plist path, label, uid, domain, or shell
  fragment. `launchctl` is invoked with argument arrays, never a shell.
- The implementation does not read, print, or copy configuration, credentials,
  logs, health bodies, or host-specific data. Public CLI output contains only
  the validated instance label and dry-run/apply outcome.
- Linux systemd and Docker service definitions remain unchanged. Their shared
  auth flow now also waits for persisted credentials, a clean helper exit, and
  closed helper stdio
  before it starts a service, so a successful pairing receipt remains truthful
  on every platform.
- No live launchctl mutation or deployment is part of this change; macOS
  GUI-domain/keychain behavior still requires a post-review canary.

## Verification

The focused suite retains #2699's generator assertion as a prerequisite and
adds coverage for safe writer mode, unsafe names, non-generated identities,
rollback after bootstrap, kickstart, or cleanup failure, and generic
stop/restart without legacy label commands. Auth tests prove the
credential-save ordering, clean-exit-and-stdio-close activation gate, client-close behavior,
and sanitized activation-error receipt.

The delivery gate additionally includes focused Vitest suites, source and
script typechecks, lint/test-integrity/publication checks, exact-head diff
review, independent implementation review, and draft-PR CI. The main-based
draft does not add a second closing reference; #2699 remains the sole automatic
GitHub link to closed #2682. This follow-up does not change #2682's workflow
label.
