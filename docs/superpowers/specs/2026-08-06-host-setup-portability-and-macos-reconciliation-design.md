# Host Setup Portability and macOS Reconciliation Design

**Date:** 2026-08-06

**Status:** Under review for staged implementation

**Issues:** #3031, #3032, #3033

**Audited base:** `78e4fa4e54be3416462e3bea637ef00392d31e6e`

## 1. Outcome

Make WhatSoup's supported-host claim cover the complete install, verify, and
deployment lifecycle rather than only runtime abstractions. A clean supported
host must have one deterministic way to learn what it needs, explicitly install
the selected dependency profile, run the same prerequisite checks as CI, and
prove the services actually loaded on macOS.

The work lands as two reviewable pull requests:

1. host capability/setup ownership plus hermetic release tests (#3031, #3032);
2. macOS fleet and per-instance watchdog reconciliation (#3033).

The first pull request is the base for the second. Production deployment waits
until the relevant pull request is locally verified, reviewed, green in GitHub,
and merged. Development and pre-merge validation occur in isolated worktrees on
the target macOS host; the live checkout and services remain unchanged.

## 2. Goals

- Give runtime, quality, release, and optional features explicit dependency
  profiles.
- Separate read-only detection from package installation and service mutation.
- Bootstrap or resolve the pinned Node before any npm-dependent setup step.
- Make macOS/Homebrew, Debian/apt, and Arch/pacman outcomes explicit.
- Make CI and local verification consume the same capability definitions.
- Remove ambient Python and `flock` dependencies from cross-platform tests.
- Reconcile the canonical macOS fleet service and opt-in instance watchdogs with
  backups, explicit migration, and loaded-state proof.
- Preserve every existing fail-closed production boundary.

## 3. Non-goals

- Installing every optional WhatSoup feature during ordinary runtime setup.
- Installing or emulating external `flock` on macOS.
- Replacing systemd, launchd, Homebrew, apt, pacman, nvm, or the JavaScript
  package manager.
- Automatically installing nvm from an unaudited network bootstrap command.
- Guessing instance names, health ports, users, credentials, or legacy service
  ownership from process lists.
- Reopening the BOT ERRORS heartbeat schedule owned by #2466.
- Sending messages, triggering WhatsApp authentication, changing instance
  databases, or rotating credentials as installation verification.
- Repairing, mirroring, selecting, or otherwise mutating provider credential
  stores. Existing provider-recovery work remains owned by #2333 and #3020.
- Fixing fallback persistence/accounting or adding standing primary-provider
  proofs. Those runtime defects remain owned by #3017 and #3019.

## 4. Alternatives Considered

### A. Install missing binaries directly on the affected host

This restores one machine quickly but leaves setup, CI, and future hosts
inconsistent. Installing `flock` on macOS would specifically hide a test fixture
defect. Rejected.

### B. One comprehensive pull request

One branch could change dependency setup, tests, CI, launchd generation, and
service migration together. This gives one deployment event but couples two
different rollback domains and makes review evidence harder to isolate.
Rejected.

### C. Two staged pull requests with shared contracts (selected)

The first pull request establishes dependency and test correctness. The second
uses that verified foundation for macOS service reconciliation. Each pull request
can be reviewed, reverted, and deployed independently while the second remains
explicitly dependent on the first.

## 5. PR 1 Architecture: Host Capabilities and Hermetic Tests

### 5.1 Capability profiles

A portable Bash 3.2-compatible library owns a declarative stream of capability
records. It avoids associative arrays, `mapfile`, GNU-only flags, Node, Python,
and jq so the diagnostic path works before language runtimes are available.

Each record declares:

- stable capability ID and profile;
- required, optional, or platform-inapplicable disposition;
- executable or feature probe;
- minimum or compatible version rule where applicable;
- package names for supported package-manager adapters;
- bounded remediation text.

Initial profiles are:

- `runtime`: pinned Node, npm, Git, platform service manager, required runtime
  interpreters for services selected by setup, and non-secret credential-store
  capability detection;
- `quality`: runtime plus Python 3.12, ripgrep, zsh, ShellCheck, and the managed
  Python quality environment;
- `release`: quality plus GNU timeout and platform-applicable release tools;
- optional feature profiles remain owned by their existing installers, beginning
  with transcription.

External `flock` is required only where the Linux release-proof installer runs.
It is platform-inapplicable for the macOS JavaScript test profile.

### 5.2 Read-only doctor

One public command checks a selected profile and supports human and JSON output.
It returns:

- `0` when all required applicable capabilities pass;
- `1` when one or more required capabilities are missing or incompatible;
- `2` when the check itself is inconclusive or its contract is malformed.

Verdicts distinguish `available`, `missing`, `incompatible`, `path_hidden`,
`optional_missing`, `not_applicable`, and `inconclusive`. The command never
installs packages, modifies shell profiles, reads credential values, or mutates
services.

Credential-store capability is structural only: the doctor may establish that
the platform integration exists and report inaccessible or ambiguous state, but
it must not infer login health from a file, Keychain item, or CLI status command.
It never copies credential material between stores.

The PATH check compares the invoking shell with the deterministic search roots
used by WhatSoup wrappers. A binary present under a supported root but absent
from the current PATH is `path_hidden`, not `missing`.

### 5.3 Explicit host-dependency installation

Installation is a separate explicit action. It accepts one profile and one of:

- detected Homebrew on macOS;
- apt on Debian-family Linux;
- pacman on Arch Linux.

The installer shows the exact package plan before mutation, accepts a
noninteractive confirmation only through an explicit flag, and reruns the
read-only doctor afterward. It does not alter shell profiles or services.
Unknown package managers return bounded manual instructions.

Language-level Python quality packages live in a WhatSoup-managed virtual
environment under the user's data directory. The installer never modifies the
system Python environment. Existing Python test runners gain the managed
interpreter as a candidate while preserving their explicit environment
overrides.

### 5.4 Pinned Node bootstrap order

`deploy/setup.sh` remains directly executable with Bash and becomes the
documented entry point from a fresh checkout. Before its Node version gate or
`npm ci`, it invokes the existing nvm-aware pinned-Node installer and prepends
the exact pinned binary when available.

If neither a compatible Node nor a usable nvm installation exists, setup stops
before mutation with platform-specific installation guidance. It never pipes a
remote installer into a shell. The quick start no longer requires `npm ci`
before setup because setup already owns the lockfile-clean install.

Setup accepts a profile and an explicit host-dependency installation flag. The
ordinary runtime profile does not install quality or release tools.

### 5.5 CI convergence

CI may continue using pinned marketplace actions for Node and Python, but host
packages are installed through the same profile installer used locally. Every
quality lane runs the doctor after provisioning. A workflow cannot claim green
when the declared profile is incomplete or the doctor was skipped.

The real macOS lane runs the platform-sensitive suites from #3032. The full
Linux authority remains responsible for Linux-only service/install behavior.

### 5.6 Hermetic Python and flock tests

Tests that execute Python use one shared test helper with this precedence:

1. explicit `WHATSOUP_TEST_PYTHON`;
2. the managed quality environment;
3. `python3.12`;
4. another interpreter only if an explicit version/feature probe passes.

Resolution failure is reported as missing test infrastructure, not as a product
assertion failure.

The release-proof installer fixture provides a fake `flock` for success and lock
contention paths. A separate controlled-PATH test proves the production installer
still fails closed when `flock` is missing. Success cases never inherit an
undeclared host `flock`.

## 6. PR 2 Architecture: macOS Service Reconciliation

### 6.1 Ownership model

The reconciler treats four service classes separately:

- repository-global fleet service;
- generated instance runtime service;
- opt-in per-instance health watchdog;
- independently owned BOT ERRORS services.

PR 2 manages the fleet service and explicitly selected instance watchdogs only.
It inventories instance runtime services but does not replace their existing
generation owner. BOT ERRORS jobs remain out of scope.

### 6.2 Plan, apply, and verify modes

The reconciler exposes three operations:

- `plan`: read-only expected-versus-observed inventory;
- `apply`: write only explicitly selected plist/script targets, with backups;
- `verify`: prove on-disk and loaded definitions after installation.

Machine-specific values come from validated arguments or the selected instance's
validated configuration. Missing or ambiguous values fail before any write.

### 6.3 Canonical fleet service

A tracked template renders the canonical
`com.whatsoup.whatsoup-fleet` LaunchAgent through the pinned wrapper. The rendered
definition contains a deterministic generation fingerprint derived from its
normalized non-secret inputs.

Legacy fleet labels are reported. Migration requires an explicit old-label
argument and validates that the old and new jobs would not run concurrently on
the same port. Apply backs up the existing plist, boots out only the named old or
changed job, bootstraps the canonical job, and verifies the generation
fingerprint through launchd readback.

### 6.4 Per-instance watchdogs

Watchdog rendering requires an explicit instance name and health port. It
validates the instance runtime label, wrapper paths, canonical fleet label, log
paths, and template placeholders before writing either the script or plist.

Apply changes only the selected watchdog. It backs up existing files, validates
shell/plist syntax, bootstraps the job, and proves the loaded generation. It does
not restart a healthy instance merely to install monitoring.

### 6.5 Rollback

Every apply produces a private local receipt containing bounded target paths,
pre/post hashes, labels, generation fingerprints, command exit statuses, and
backup paths. It contains no credential values or instance message data.

Rollback restores only files and jobs owned by that receipt. A partial rollback
is nonzero and reported as inconclusive until the operator resolves it.

### 6.6 Provider-readiness boundary

Service reconciliation reports process and generation readiness separately from
provider readiness. It consumes an authoritative, fresh, target-context model
usability result when one exists; it does not create a second credential probe
or recovery implementation.

Current main already forwards `CLAUDE_CONFIG_DIR` to the Claude model probe,
attempts a fail-open macOS Keychain-to-file-store coherence heal before each
Claude CLI probe, discovers an unambiguous hash-suffixed Keychain service item,
and reports when a fresher file-store token may be shadowed by an older Keychain
item. Those behaviors remain runtime-owned and are not duplicated here.

Provider readiness is `inconclusive` when any of the following prevents a bound
proof:

- more than one candidate credential item exists and account identity cannot be
  proven;
- credential-store provenance or the serving launch context differs from the
  probe context;
- primary-usability evidence is missing or stale;
- the standing detection/proof mechanism is failing or unavailable; or
- fallback state cannot prove the active and failed chain entries survived a
  restart.

These conditions must block a claim that the primary is ready, but they do not
authorize the reconciler to choose an account, copy a token, start interactive
login, or alter fallback state. #3017 owns standing primary proof and exact
route attribution, #3019 owns fallback-chain persistence, #3020 owns
same-account provenance for credential healing, and #2333 owns interactive
recovery.

## 7. Testing Strategy

Implementation is test-first.

PR 1 begins with failing tests for:

- setup/CI capability drift;
- pinned Node availability before the first npm step;
- Homebrew, apt, pacman, unknown-manager, and check-only behavior;
- missing, incompatible, PATH-hidden, optional, and not-applicable verdicts;
- Python override and version validation;
- success-path fixture `flock` and controlled missing-`flock` behavior.

PR 2 begins with failing fixture tests for:

- absent, current, on-disk drifted, and loaded-old-generation fleet jobs;
- explicit legacy-label migration and conflict rejection;
- absent, partial, current, and drifted instance watchdogs;
- placeholder, port, path, and plist validation;
- backup, idempotency, verification, and rollback boundaries.
- separation of loaded-service, transport, fallback, and fresh target-context
  primary-provider verdicts;
- stale, ambiguous, context-mismatched, and unavailable provider evidence
  remaining inconclusive rather than green or authoritatively logged out.

Changed tests run through Test Integrity. Focused suites run under stable fork
pools. Each PR then runs type checks, shell syntax checks, relevant platform
fixtures, console build where dependency files changed, npm audit, branch gates,
and `npm run verify:release`. Masked, skipped, unavailable, or environment-blocked
checks remain inconclusive rather than pass.

## 8. Git and Publication Strategy

- Work starts from authenticated SSH `origin/main` at the audited commit or a
  newer explicitly refreshed commit.
- Target-host development uses external isolated worktrees; the clean live checkout is
  never the implementation branch.
- PR 1 branch: `fix/setup-portability-3031-3032`.
- PR 2 branch: `fix/macos-service-reconcile-3033`, created from refreshed main
  after PR 1 merges, or temporarily stacked with an explicit base.
- Commits use the public repository author identity and contain no automation
  attribution, model names, private addresses, or forbidden trailers.
- Pushes use the repository SSH remote through the authenticated workstation.
- No force push, destructive reset, checkout restore, or untracked-file cleanup is
  used. Unexpected dirt is preserved with `git stash --include-untracked` only
  when necessary.
- Before declaring a branch superseded or deleting it, use ancestry checks,
  `git cherry -v`, and `git range-diff` against the replacement.

## 9. Target-Host Deployment

The isolated worktree may run diagnostics and tests before publication, but the
live production checkout changes only after the corresponding PR is reviewed,
green, and merged.

Deployment uses an authenticated bundle, fast-forwards the clean live branch,
backs up changed plists and relevant configuration, installs lockfile-pinned
dependencies, and runs preflight before any restart. Service changes are applied
in the narrowest order: fleet migration/reload, selected watchdog installation,
then instance restart only if the merged runtime code requires it.

Acceptance requires fresh health for fleet and each selected instance, connected
transport state, loaded-generation proof, zero unexpected pending work, and no
new quarantine or recovery debt. Primary readiness additionally requires fresh
target-context model-usability evidence whose provider and model match the
configured primary. A healthy fallback is reported separately and cannot make
the primary ready. A failing or absent standing proof makes primary readiness
inconclusive and blocks the overall deployment-ready claim. No WhatsApp message
is sent as a deployment canary.

## 10. Risks and Controls

- **Package-manager mutation:** explicit install flag, printed plan, profile
  scoping, and post-install doctor.
- **Hosted-runner assumptions:** controlled PATH fixtures and real macOS coverage.
- **Node drift:** exact pinned resolution before npm and service-wrapper checks.
- **Duplicate fleet processes:** legacy migration requires explicit selection and
  port-conflict rejection.
- **Stale launchd definitions:** bootout/bootstrap plus generation readback;
  `kickstart` alone is never treated as reload proof.
- **Monitoring false confidence:** template presence is not deployment proof;
  loaded generation and fresh execution remain separate verdicts.
- **Credential false positives:** store presence, CLI status, browser success,
  and top-level HTTP green are not primary-usability proof; ambiguous or stale
  evidence remains inconclusive.
- **Repair scope creep:** setup and service reconciliation never mutate provider
  credential stores or fallback state; canonical runtime/recovery owners remain
  separate.
- **Rollback scope creep:** receipts own exact files and labels only.

## 11. Completion Criteria

PR 1 closes #3032 and closes #3031 only when the documented runtime, quality,
and release profiles are all represented and CI consumes the same contract. PR 2
closes #3033 only when plan/apply/verify/rollback behavior and loaded-state proof
are complete.

If implementation reveals that a package-manager adapter or launchd readback
cannot meet these criteria without unsafe privilege or topology assumptions, the
affected issue remains open with the verified narrower delivery stated in the PR;
the code must not convert that gap into a silent pass.
