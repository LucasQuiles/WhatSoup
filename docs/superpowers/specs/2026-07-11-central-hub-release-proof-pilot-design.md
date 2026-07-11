# Central Hub Release-Proof Pilot Design

**Date:** 2026-07-11

**Status:** Approved design; ready for implementation planning after written-spec review

**Audited WhatSoup base:** `fafe0c6580389b20011e98624c7e36e73a61d122`

**Private host baseline:** Recorded in owner-local audit evidence and intentionally omitted from the public repository

**Publication and mutation boundary:** This document authorizes local specification and planning only. Pushes, pull requests, merges, pilot-host writes, BOT ERRORS emission, unit installation, app deploys, app restarts, qFleet writes, and changes on any other host remain separately owner-gated.

## 1. Outcome

Prove the in-place-git enforcement and detection path on one central pilot host without changing WhatSoup runtime behavior or touching higher-volume fleet machines.

The pilot must establish four independent facts:

1. provenance and runtime-staleness detectors are honest when their probes fail;
2. their scheduling and installation cannot restart, reload, signal, or rewrite a WhatSoup application service;
3. one BOT ERRORS alert and matching clear traverse the production dispatcher without leaving queue or incident residue;
4. monitor-only operation remains below a fixed resource budget and leaves both pilot application processes unchanged through a sustained soak.

The pilot is not a fleet rollout. qFleet dimensions, macOS fan-out, expected-head enforcement, and application restart proof remain behind later promotion gates.

## 2. Safety Boundary

The following constraints are mandatory:

- One privately identified central pilot host is the only production host in scope.
- No higher-usage or higher-volume fleet machine may be read or written as part of implementation or proof.
- One privately designated low-impact macOS validation host may be used only after the central-host soak if a Darwin-specific scheduler question cannot be settled with source tests and local plist validation. It may not be used as runtime-behavior evidence and its WhatSoup bots may not be restarted.
- The monitor-only phases may not modify `~/LAB/WhatSoup`, any instance database, auth material, app socket, app configuration, or `whatsoup@*.service` unit.
- Monitor code is materialized under a versioned host-local bundle, not copied into the running application checkout.
- Scheduled git inspection, including the existing health SHA read, is offline and uses `git --no-optional-locks`; it never fetches.
- Tree provenance has exactly one live producer on the pilot host. The daily-health profile keeps `expectTreeProvenance=false` while the standalone timer is installed.
- Every skipped, unavailable, masked, or unrun check is Inconclusive, not Pass.

## 3. Observed Current State

### 3.1 Pilot application state

Read-only inspection on 2026-07-11 established:

- the pilot host is Linux/systemd and uses an in-place-git WhatSoup checkout;
- the checkout is on a host-local feature branch whose exact name and SHA are retained only in the private execution ledger;
- it is 28 commits behind and 3 commits ahead of the last-fetched `origin/main`, and neither side is an ancestor of the other;
- the tree has one pre-existing untracked entry;
- both running application processes predate C1 and currently report nullable health `commit` and `branch` as `null`;
- both private WhatSoup instance services and `bot-errors-dispatcher.service` were active with zero restart count;
- both WhatSoup health endpoints returned HTTP 200, healthy status, connected WhatsApp state, and ready SQLite schema;
- the two application services used approximately 4.05 GB and 3.27 GB respectively at the observation point.

These values are a baseline, not a permanent expectation. Operational proof must capture them again immediately before each host mutation.

### 3.2 Existing detector state

- `bot-errors-runtime-staleness.py` exists and its source unit/timer exist, but the unit was not installed on the pilot host.
- `bot-errors-tree-provenance.py` can run standalone or be imported by daily health. The pilot host does not currently enable the daily-health integration.
- Read-only detector measurements on the pilot host were 0.05 seconds and 19 MB peak RSS for tree provenance, and 0.08 seconds and 14 MB peak RSS for runtime staleness.
- Runtime staleness classified both private instances as stale because source files are newer than their process boot epochs.
- The host-local BOT ERRORS runtime manifest exists and matches both detector script hashes, but `expected_head_sha` is absent.
- BOT ERRORS outbox, processing, dead-letter, and writefail directories were empty at the observation point.

### 3.3 Existing fleet and release paths

- qFleet's `code_currency`, `git_residue`, and `watcher_loadedness` probes intentionally exclude the central-role pilot host.
- `live-release-drift-alert.ts` and `release-snapshot-plan.ts` target snapshot/release-directory deployments and are not the correct proof plane for the pilot host's in-place-git model.
- qFleet matrix writes and role expansion are out of scope for this pilot.

## 4. Blocking Defects Found by the Adjacent-Path Audit

### B1. Runtime-staleness can emit a false clear after probe failure

`_run()` returns a command status, but instance discovery and the `systemctl`, `ps`, and `find` probes discard it. Empty output can become `stale=False`, and a running instance can then emit `CLEAR runtime_stale` without a valid boot epoch or source epoch.

Required correction:

- instance discovery failure is a probe error, not an empty healthy fleet;
- failed PID, elapsed-time, repo-root, or source-mtime probes never emit alert or clear state;
- a probe error exits `2` and leaves an existing incident untouched;
- a failed event emission exits `1`;
- a valid stale or fresh observation exits `0` after the corresponding event operation succeeds.

This correction must land before any runtime-staleness timer is installed.

### B2. Tree findings currently look like scheduler failures

Standalone tree provenance returns the finding severity as its process exit code: warning is `1` and critical is `2`. A systemd timer would therefore report a failed oneshot whenever the detector successfully found drift.

Required correction:

- preserve existing guard/CLI severity exits for interactive use;
- add an explicit `--reporter` mode for schedulers;
- `--reporter --once` emits and exits `0` for a successfully observed clean, warning, or critical state;
- `--reporter --print` performs the same observation without emission and exits `0` for every valid finding state;
- reporter mode exits `2` for inspection failure and `1` for event-write failure;
- reporter mode rejects `--fetch` so a scheduled invocation cannot mutate remote-tracking refs.

### B3. Tree provenance has two possible alert producers

The standalone script emits `source=tree-provenance`, while daily health embeds the same detector and emits through daily-health sources. Dispatcher identity is machine, instance, and source, so the two paths do not deduplicate.

Required correction:

- standalone scheduling is the only tree producer during the pilot;
- `expectTreeProvenance` remains false on the pilot host;
- a structural test prevents the installer from enabling both paths;
- documentation states which producer owns alert and clear state.

### B4. Existing installation paths are too broad or incomplete

`deploy/setup.sh` copies the complete unit set and re-enables existing application and fleet units. The hardened BOT ERRORS deployer does not manage these monitor units and covers only a subset of manifest-tracked scripts. Existing selfcheck/sentinel installer dry-run modes create directories and files before skipping activation.

Required correction:

- do not invoke `deploy/setup.sh`;
- do not claim the existing deployer's rollback guarantee for monitor units;
- use a narrow monitor installer with a true no-write dry run;
- include atomic backup, install, verification, mode switch, and rollback for only the monitor bundle and its two unit/timer pairs.

### B5. Default unit drift verification omits BOT ERRORS

`scripts/check-unit-drift.sh` accepts explicit unit names but its default list omits BOT ERRORS units.

Required correction:

- the pilot always passes all four monitor unit names explicitly;
- missing systemd directories or skipped comparisons are Inconclusive;
- loaded unit paths and drop-ins are verified with `systemctl --user show` or equivalent in addition to byte comparison.

## 5. Approaches Considered

### Approach A - Dedicated existing-detector timers from an isolated bundle (selected)

Keep tree provenance and runtime staleness as separate detectors and separate stable incident sources. Fix their reporting contracts, materialize their dependencies under a versioned monitor-only root, and install two resource-bounded oneshot timers.

Advantages:

- extends existing BOT ERRORS detectors and dispatcher behavior;
- preserves clear ownership per source;
- avoids app checkout changes and app restarts;
- supports narrow rollback and attribution;
- does not introduce a second new mechanism beside the already-approved composition workflow.

Cost: two services, two timers, and one narrow installer/runner contract.

### Approach B - Daily-health tree integration plus runtime-staleness timer

This uses fewer unit files but gives tree findings the daily-health cadence and incident plane. It also increases the risk of duplicate producers if standalone scheduling is later enabled.

Rejected because the broad daily-health source already contains unrelated incidents and provides weaker attribution and recovery proof.

### Approach C - Composite release-proof monitor or snapshot adaptation

A composite monitor could produce one incident containing git, manifest, and process facts. Adapting snapshot release-drift would also create one apparent deployment plane.

Rejected because both choices duplicate existing detector logic, blur source-specific clear semantics, and create a new enforcement mechanism. Snapshot semantics also do not fit the pilot host's in-place-git checkout.

## 6. Architecture

### 6.1 Detector contracts

`bot-errors-tree-provenance.py` remains the single owner of tree facts. Its `--reporter` scheduler mode is offline, uses no optional git locks, and separates finding severity from process health. Existing interactive/default severity exits remain compatible.

`bot-errors-runtime-staleness.py` remains the single owner of process-vs-source age. It must return a typed observation for discovery and each instance. Unknown or failed observations cannot be converted to fresh state.

The dispatcher remains unchanged unless red-first end-to-end tests expose a real contract defect. Incident keys remain:

```text
machine | instance | source
```

Tree provenance uses one stable host-level instance/source pair. Runtime staleness uses each WhatSoup instance with `source=runtime_stale`. No composite release-proof source is added.

### 6.2 Versioned monitor bundle

The installer materializes exact files from a merged WhatSoup commit under:

```text
~/.local/lib/whatsoup/release-proof/<40-char-sha>/
```

The bundle contains only the monitor runner and the manifest-tracked Python files required by tree provenance, runtime staleness, and event emission. A `current` symlink is changed atomically after all source hashes and unit syntax pass.

The bundle is verified against `deploy/bot-errors-runtime-manifest.json`; it does not create a new manifest schema. The application checkout is an inspection target only.

### 6.3 Scheduler runner

A small shell runner accepts exactly one component:

```text
tree
runtime-staleness
```

It reads a dedicated systemd environment file without sourcing it as shell, validates `BOT_ERRORS_RELEASE_PROOF_MODE` as `observe` or `emit`, acquires one shared nonblocking lock, and invokes only the selected detector.

- `observe`: tree invokes `--reporter --print`; runtime staleness invokes `--dry-run`.
- `emit`: tree invokes `--reporter --once`; runtime staleness invokes `--once`.
- lock contention exits `75` and records a skipped cycle.
- invalid mode or missing dependency exits `2` before detector execution.

The runner contains no detector logic and cannot call an application service command.

### 6.4 Systemd units

The tracked generic units are:

```text
bot-errors-tree-provenance.service
bot-errors-tree-provenance.timer
bot-errors-runtime-staleness.service
bot-errors-runtime-staleness.timer
```

Both services are `Type=oneshot` and include:

- `UMask=0077`;
- `TimeoutStartSec=45s`;
- `TimeoutStopSec=15s`;
- `KillMode=control-group`;
- `SuccessExitStatus=75`;
- `NoNewPrivileges=yes`;
- `PrivateTmp=yes`;
- read-only system protection with an explicit BOT ERRORS state write path, subject to `systemd-analyze --user verify` on the pilot host;
- `MemoryMax=128M` and `TasksMax=32`;
- low process and I/O priority.

The units must not contain `Requires=`, `PartOf=`, `BindsTo=`, `Restart=`, or commands targeting `whatsoup@*`, `whatsoup-fleet`, dispatcher, collector, or q-loop services.

Timers run every 30 minutes, use distinct initial offsets, include bounded randomized delay, and use `OnUnitInactiveSec` so a long run cannot overlap itself. The shared lock prevents cross-detector overlap.

### 6.5 Narrow installer

The installer has explicit operations:

```text
--dry-run --mode observe|emit
install --mode observe
set-mode emit
verify
rollback <receipt>
```

It must:

1. require an operator-supplied expected hostname, compare it exactly after canonicalization, and print only its fingerprint; tests use synthetic hostnames;
2. verify source files and manifest hashes before any destination write;
3. render all files into a temporary directory on the destination filesystem;
4. run shell parsing and systemd unit validation before activation;
5. acquire a single installer lock;
6. back up prior bundle pointer, mode file, unit bytes, and timer enabled/active state;
7. atomically replace only the four monitor unit files and current bundle pointer;
8. run `systemctl --user daemon-reload`;
9. enable or change only the two monitor timers;
10. verify installed bytes, loaded fragment paths, drop-ins, timer state, and mode;
11. print a receipt and exact rollback command.

`--dry-run` may print rendered content and intended commands but may not create a directory, file, lock, backup, outbox event, or systemd invocation.

## 7. Data and Control Flow

### 7.1 Observe mode

1. A timer activates its oneshot service.
2. The runner acquires the shared monitor lock.
3. The tree component inspects the app checkout offline, or runtime staleness reads systemd, `/proc`, process age, and source mtimes.
4. Tree runs as `--reporter --print`, while runtime staleness runs as `--dry-run`; each prints a redacted result and exits `0` for a valid finding or clean result.
5. No outbox event is written.
6. The service ends successful; the timer schedules the next run.

### 7.2 Emit mode

The flow is identical through observation. A valid observation then writes one alert or clear to the existing BOT ERRORS outbox. The existing dispatcher owns delivery, incident opening, duplicate suppression, recovery delivery, and incident closure.

Probe failure produces neither alert nor clear. Event-write failure marks the service failed so monitor-health and finding-state cannot be confused.

### 7.3 Controlled production alert drill

The drill is separate from detector activation:

1. capture queue counts, dispatcher PID/restart count, and absence of the planned incident key;
2. emit one warning with a unique conservative instance/source pair and `BOT_ERRORS_INLINE_LOG_TAIL=0`;
3. wait for that exact event ID to reach `sent/`, the incident to appear open, and live queue/error directories to return to baseline;
4. emit one same-key clear;
5. require the clear in `sent/`, absence of the incident key, drained queues, and independent human observation of both messages.

If the alert was not sent, no clear is emitted. If the clear is queued or retrying, no duplicate clear is emitted. Dead-letter or writefail evidence is preserved rather than manually deleted.

## 8. Execution Gates

### Gate 0 - Local correctness blockers

Land red-first fixes for false clears, scheduler exit semantics, no-optional-lock reads, duplicate-producer prevention, units, runner, installer, verification, and rollback. All repository guards and CI must pass before any host proof.

### Gate 1 - Pilot-host isolated dry proof

Stage the merged bundle without installing it. Render into an isolated temporary root, validate unit syntax, run both components against temporary BOT ERRORS state, and prove no application path changed.

### Gate 2 - Controlled BOT ERRORS alert and clear

Run the single production warning/recovery drill. This is an external communication and requires an execution-time owner confirmation even though its design is approved here.

### Gate 3 - Observe-only install and 24-hour soak

Install only the monitor units in `observe` mode. Capture app PIDs, start timestamps, restart counts, health, journals, detector duration/RSS, timer results, and git index metadata before and after.

### Gate 4 - Emit-mode activation and 48-hour soak

After a separate owner gate, atomically change only the monitor mode to `emit`. Run one manual tree cycle and one first-instance runtime-staleness cycle before automated discovery covers both private instances. Repeated findings must be suppressed by the dispatcher and every queue must drain.

### Gate 5 - Application provenance proof

This gate is outside monitor-only installation and requires a new explicit approval. Deploy an approved main SHA to the pilot host, perform the app restart, stamp that exact SHA into the host-local runtime manifest, and prove:

- `/health.instance.commit` is the full expected SHA;
- `/health.instance.branch` is the expected branch or detached sentinel;
- runtime-staleness clears after the restarted process loads the approved source;
- health, WhatsApp connection, SQLite readiness, and application restart counts settle within the approved window.

The current divergent host checkout must not be stamped as the desired release during earlier gates. Its exact SHA remains in the private execution ledger.

### Gate 6 - Promotion review

No fleet promotion is automatic. The owner reviews the complete receipt packet and decides whether to open a separate C2/qFleet or macOS rollout design. qFleet matrix writes remain prohibited before this decision.

## 9. Runtime Non-Regression Criteria

Monitor-only gates pass only when all of the following hold:

- both private instances' `MainPID` values are unchanged;
- both private instances' `ActiveEnterTimestampMonotonic` values are unchanged;
- both private instances' `NRestarts` values are unchanged;
- both health endpoints remain HTTP 200, healthy, WhatsApp-connected, and SQLite-ready;
- no monitor command starts, stops, restarts, reloads, kills, or signals an application or fleet service;
- no application checkout, database, auth, socket, or instance-config path changes;
- no scheduled git command fetches or mutates the index;
- each detector completes in less than 0.5 seconds wall time and below 32 MB peak RSS under normal operation;
- no monitor executions overlap;
- no unexplained warning/error-priority application journal entries appear;
- outbox, processing, writefail, quarantine, and dead-letter counts return to their pre-gate baseline;
- timer and service result state is successful, including audited lock-contention skips;
- all expected receipts and raw command outputs are retained.

Any failed criterion stops progression. Any measurement that cannot be collected is Inconclusive and also stops progression.

## 10. Error Handling and Abort Rules

| Failure | Required behavior |
|---|---|
| Detector probe command fails or times out | Exit `2`; emit neither alert nor clear; preserve existing incident state. |
| Event write fails | Exit `1`; preserve error evidence; do not claim detector success. |
| Shared monitor lock is held | Exit `75`; record skipped cycle; do not wait or overlap. |
| Bundle hash or manifest shape mismatches | Abort before destination writes. |
| Unit parse or systemd verification fails | Abort before daemon reload or enablement. |
| Installer is interrupted after backup | Receipt identifies staged and prior state; rollback restores previous bytes and enablement. |
| Queue, writefail, quarantine, or dead-letter grows unexpectedly | Stop the drill or soak; preserve artifacts; do not manually drain. |
| Dispatcher PID or restart count changes | Stop; no clear or mode promotion until dispatcher health is understood. |
| Application PID/start time/restart count changes in monitor-only phase | Immediate failure and rollback; investigate before any retry. |
| Runtime resource budget is exceeded | Disable only monitor timers and preserve measurement evidence. |
| Human receipt is unavailable | Local delivery remains proven only to `sent/`; end-to-end alert proof is Inconclusive. |

## 11. Rollback

Rollback acquires the installer lock and acts only on pilot artifacts:

1. disable and stop the two monitor timers;
2. restore prior unit bytes or remove units that were previously absent;
3. restore the prior mode file and bundle pointer;
4. run `systemctl --user daemon-reload`;
5. restore prior monitor timer enablement and active state;
6. verify loaded fragments and byte parity;
7. confirm both private app PIDs, start timestamps, and restart counts remain unchanged;
8. retain the failed bundle, installer receipt, journals, and BOT ERRORS evidence for diagnosis.

Rollback never invokes an application, fleet, dispatcher, collector, or q-loop service command.

## 12. Test Strategy

### 12.1 Runtime-staleness tests

Extend the real black-box test harness to cover:

- discovery command failure;
- PID command failure and malformed PID output as distinct states;
- `ps` failure or malformed elapsed time;
- missing `/proc` plus absent explicit repo root;
- `find` failure and empty/unparseable source output;
- no alert or clear on every probe error;
- stale alert, fresh clear, not-running skip, emit failure, and successful reporter exits.

Tests use fake binaries and a stub emitter. They assert subprocess exit codes and emitted argv, not only helper return values.

### 12.2 Tree-provenance tests

Extend the Python fixture-repo suite to cover:

- interactive severity exits remain unchanged;
- reporter mode exits `0` for clean, warning, and critical findings;
- reporter inspection and write failures are nonzero;
- observe mode creates no state or outbox path;
- every offline tree-provenance git command includes `--no-optional-locks`;
- `.git/index` bytes and metadata remain unchanged;
- scheduled/reporter mode rejects fetch.

Extend the health SHA tests to prove its scheduled `git rev-parse` call also uses `--no-optional-locks` and preserves the existing graceful-degradation matrix.

### 12.3 Installer and unit tests

Use a temporary home, destination filesystem, fake systemctl, and command ledger to prove:

- dry-run produces zero filesystem and command-ledger delta;
- host allowlisting fails closed;
- source hashes and manifest paths are verified;
- source and destination symlinks are rejected where they can escape managed roots;
- unit rendering is deterministic and contains the complete safety/resource contract;
- no app/fleet unit name occurs in mutating commands;
- backup precedes replacement;
- partial-write and activation failures roll back;
- observe-to-emit mode change touches only the dedicated mode file;
- explicit unit-drift scope includes all four units;
- loaded fragment/drop-in verification rejects unexpected overrides;
- rollback restores bytes, pointer, mode, and prior enablement.

### 12.4 Dispatcher alert/clear tests

Add a two-run sandbox test using the real emitter and dispatcher:

- first run sends one warning and persists the exact incident key;
- duplicate alert is suppressed and audited;
- second run sends one same-key recovery and removes the key;
- repeated clear is orphan-suppressed;
- all sandbox queues drain;
- inline log tails remain disabled and no sensitive canary appears in output.

### 12.5 Gate verification

Targeted suites must be followed by the repository's branch gate and GitHub CI. Masked failures, environment skips, unavailable systemd validation, or fixture-only host evidence do not satisfy operational gates.

## 13. Planned File Surface

Expected WhatSoup implementation files:

- modify `deploy/scripts/bot-errors-runtime-staleness.py`;
- modify `deploy/scripts/bot-errors-tree-provenance.py`;
- modify `deploy/scripts/bot-errors-health-check.py` only to make scheduled SHA inspection use `git --no-optional-locks`;
- create `deploy/scripts/bot-errors-release-proof-run.sh`;
- create `deploy/scripts/install-bot-errors-release-proof.sh`;
- create `deploy/bot-errors-tree-provenance.service`;
- create `deploy/bot-errors-tree-provenance.timer`;
- modify `deploy/bot-errors-runtime-staleness.service`;
- modify `deploy/bot-errors-runtime-staleness.timer`;
- modify `deploy/bot-errors-runtime-manifest.json` for changed/new manifest-tracked runtime scripts;
- modify `scripts/check-bot-errors-runtime-manifest.ts` so the new runner and installer are mandatory manifest paths;
- extend `deploy/scripts/tests/test_bot_errors_tree_provenance.py`;
- extend `deploy/scripts/tests/test_bot_errors_f9_git_head_sha.py`;
- extend `tests/scripts/bot-errors-runtime-staleness.test.ts`;
- extend `tests/scripts/bot-errors-service-templates.test.ts`;
- extend `tests/scripts/unit-drift.test.ts`;
- add focused installer/rollback tests under `deploy/scripts/tests/` or `tests/scripts/` following the existing shell-fixture idiom;
- extend dispatcher integration coverage under `tests/scripts/bot-errors-dispatcher.test.ts`;
- update `deploy/scripts/README-bot-errors.md` and the central-hub/release deployment runbook.

No qFleet, SoupOps, instance runtime, health response, database, console, or macOS file is changed by this pilot implementation.

## 14. Promotion Packet

The owner receives one bounded packet containing:

- merged implementation SHA and manifest hash;
- local red/green/gate/CI evidence;
- installer dry-run and rollback receipts;
- before/after app PID, start timestamp, restart count, health, and journal snapshots;
- detector duration and RSS measurements across both soak phases;
- unit source, installed-byte, loaded-fragment, timer, and lock evidence;
- production alert and clear event IDs, sent archive paths, incident-state delta, queue counts, and human receipt status;
- every failure, skipped check, and Inconclusive result;
- exact rollback execution and post-rollback verification, if rollback occurred;
- an explicit recommendation to promote, extend the soak, revise, or stop.

Promotion requires owner approval. It never follows automatically from a green packet.

## 15. Explicit Non-Goals and Residuals

- No higher-volume fleet host rollout.
- No qFleet matrix writes or central-role expansion.
- No snapshot release conversion for the central pilot host.
- No application deploy or restart during monitor-only gates.
- No expected-head stamp before an approved application deploy.
- No automatic healing, checkout, reset, pull, merge, or fetch.
- No Hub Deadman installation; its absence limits independent alert-plane proof and remains a named residual.
- No macOS runtime proof. A privately designated low-impact macOS host is a conditional scheduler-only follow-up.
- No change to the mtime-based staleness heuristic beyond making unknown observations honest. Commit identity comes from C1 plus later expected-head stamping.
- No transactional redesign of the two-file manifest/approval-ledger pin operation. The pilot backs up and verifies both files and records the crash window as residual risk.
- No broad refactor of BOT ERRORS installers or `deploy/setup.sh`.

## 16. Baseline Verification for This Specification

The isolated specification worktree at `fafe0c65` passed:

- 35 targeted Vitest checks across runtime staleness, service templates, and unit drift;
- 24 Python checks across tree provenance and orphan-clear suppression;
- the deployer pin-mode suite;
- the deployer mutation/rollback suite.

All commands exited `0` under Node `24.15.0` and Python `3.12.13`. These results establish a clean planning baseline; they do not prove the future implementation or pilot-host operational gates.
