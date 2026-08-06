# Host Setup Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a clean supported host discover, install, and verify WhatSoup's runtime, quality, and release dependencies through one portable contract, while removing ambient Python and `flock` dependencies from the affected tests.

**Architecture:** A Bash 3.2-compatible capability library is the single source of truth for profiles, probes, package mappings, PATH visibility, exact Node pinning, and native architecture. A read-only doctor and an explicit installer consume that library; setup bootstraps pinned Node before npm, while CI emits mandatory strict or compatibility-only doctor receipts. TypeScript test helpers own test-only Python selection and external-command fixtures.

**Tech Stack:** Bash 3.2, Vitest 4, TypeScript 5.9, GitHub Actions, Homebrew, apt, pacman, Python 3.12 virtual environments.

## Global Constraints

- Host profiles are `runtime`, `quality`, and `release`; optional transcription remains independently owned.
- Host-profile Node must equal `.nvmrc` exactly and its process architecture must match native host architecture.
- The `quality (25.x)` lane is compatibility-only and cannot produce a host-ready receipt.
- Doctor is read-only and exits `0` pass, `1` missing/incompatible, or `2` inconclusive/malformed.
- Package mutation requires explicit `--apply`; noninteractive mutation additionally requires `--yes`.
- Supported adapters are Homebrew on macOS, apt on Debian-family Linux, and pacman on Arch Linux.
- The quality venv defaults to `${XDG_DATA_HOME:-$HOME/.local/share}/whatsoup/quality-venv`; system Python is never modified.
- Credential checks are structural only and never read or copy credential values.
- External `flock` remains required by the Linux release-proof product path but is not a macOS JavaScript-test dependency.
- All new shell code must parse under macOS Bash 3.2 and avoid associative arrays, `mapfile`, GNU-only flags, Node, Python, and jq on the pre-runtime path.

---

## File Map

- `deploy/lib/host-capabilities.sh`: canonical profile records, platform normalization, native-architecture detection, probes, package mapping, and receipt helpers.
- `deploy/scripts/whatsoup-host-doctor.sh`: argument parsing and human/JSON read-only doctor output.
- `deploy/scripts/install-host-dependencies.sh`: plan/apply package-manager adapters and managed quality-venv creation.
- `deploy/setup.sh`: early host-install option, pinned-Node bootstrap, exact PATH selection, and strict runtime doctor.
- `tests/deploy/host-capabilities.test.ts`: black-box doctor fixtures for profiles, versions, architecture, PATH visibility, and exit taxonomy.
- `tests/deploy/install-host-dependencies.test.ts`: fake-manager ledgers for brew, apt, pacman, confirmation, post-install doctor, and venv ownership.
- `tests/deploy/setup-platform.test.ts`: setup ordering and clean-host replay coverage.
- `tests/scripts/ensure-node-installed.test.ts`: exact pinned-node bootstrap behavior.
- `tests/helpers/python-interpreter.ts`: shared test-only Python resolver.
- `tests/helpers/python-interpreter.test.ts`: override, managed-venv, version, and missing-prerequisite coverage.
- `tests/scripts/bot-errors-python-atomic-write-guard.test.ts`: consume the shared Python resolver.
- `tests/scripts/bot-errors-release-proof-installer.test.ts`: deterministic fake `flock` and controlled missing-`flock` case.
- `.github/workflows/quality.yml`: strict and compatibility doctor receipts plus the real-macOS affected suites.
- `scripts/safeguard-diagnostics.ts`: workflow-structure enforcement for doctor receipt steps and exact Node authority setup.
- `tests/scripts/safeguard-diagnostics.test.ts`: mutation cases proving absent doctor steps/contexts cannot pass.
- `package.json`: public doctor/install/test commands.
- `README.md`, `docs/runbook.md`, `docs/public-surface.md`: profile, bootstrap, and operator contract.
- `docs/publication-audit.md`, `docs/work-index.json`, `docs/work-index.md`: generated publication and plan indexes.

---

### Task 1: Canonical capability contract and read-only doctor

**Files:**
- Create: `deploy/lib/host-capabilities.sh`
- Create: `deploy/scripts/whatsoup-host-doctor.sh`
- Create: `tests/deploy/host-capabilities.test.ts`
- Modify: `package.json`
- Modify: `docs/public-surface.md`

**Interfaces:**
- Produces: `whatsoup_capability_records <profile> <platform> <node-policy>` as tab-separated records with fields `id`, `disposition`, `probe`, `version_rule`, `brew`, `apt`, `pacman`, and `remediation`.
- Produces: `whatsoup_probe_capability <record>` with globals `CAP_STATUS`, `CAP_VERSION`, `CAP_PATH`, and `CAP_DETAIL`.
- Produces: `whatsoup_native_arch` normalized to `arm64` or `x64`.
- Produces: CLI `deploy/scripts/whatsoup-host-doctor.sh --profile <runtime|quality|release> [--node-policy <exact|compatibility>] [--json]`.

- [ ] **Step 1: Write the failing black-box doctor tests**

Create a fixture builder that writes executable shims for `uname`, `sysctl`, `node`, `npm`, `git`, `launchctl`/`systemctl`, `security`/`secret-tool`, `python3.12`, `rg`, `zsh`, `shellcheck`, `timeout`/`gtimeout`, and `flock`. Spawn the doctor with only the fixture PATH plus `/usr/bin:/bin`.

Add these exact cases:

```ts
expect(runDoctor(fx, ['--profile', 'runtime', '--json']).status).toBe(0);
expect(verdict('node')).toMatchObject({ status: 'available', versionRule: 'exact:24.15.0' });
expect(wrongPatch('24.15.1')).toMatchObject({ exitCode: 1, status: 'incompatible' });
expect(rosettaNode()).toMatchObject({ exitCode: 1, status: 'incompatible' });
expect(unknownNativeArch()).toMatchObject({ exitCode: 2, status: 'inconclusive' });
expect(pathHidden('rg')).toMatchObject({ exitCode: 1, status: 'path_hidden' });
expect(runDoctor(fx, ['--profile', 'runtime', '--json'])).not.toMentionCredentialMaterial();
expect(runDoctor(fx, ['--profile', 'release', '--json']).records).toContainEqual(
  expect.objectContaining({ id: 'flock', status: 'not_applicable' }),
);
```

- [ ] **Step 2: Run the doctor suite and verify RED**

Run:

```bash
npm test -- tests/deploy/host-capabilities.test.ts --pool=forks --maxWorkers=1
```

Expected: FAIL because `deploy/scripts/whatsoup-host-doctor.sh` does not exist.

- [ ] **Step 3: Implement the portable capability library**

Use newline/tab records rather than Bash arrays. The profile expansion must be monotonic: `runtime`, then runtime plus quality records, then quality plus release records. Implement native architecture as:

```bash
whatsoup_native_arch() {
  platform="$1"
  machine="$(uname -m 2>/dev/null)" || return 2
  if [ "$platform" = "darwin" ]; then
    arm64_capable="$(sysctl -n hw.optional.arm64 2>/dev/null || true)"
    [ "$arm64_capable" = "1" ] && { printf '%s\n' arm64; return 0; }
  fi
  case "$machine" in
    arm64|aarch64) printf '%s\n' arm64 ;;
    x86_64|amd64|x64) printf '%s\n' x64 ;;
    *) return 2 ;;
  esac
}
```

Resolve executables first through the invoking PATH and then through the service roots `$HOME/.local/bin`, the `.nvmrc` nvm directory, `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, and `/sbin`. A service-root-only match is `path_hidden`.

For Node exact mode, compare `node --version` after removing `v` with `.nvmrc`, then compare `node -p 'process.arch'` with `whatsoup_native_arch`. Compatibility mode accepts only the `package.json#engines.node` major range and always labels the overall receipt `compatibility_only`.

- [ ] **Step 4: Implement doctor output and exit aggregation**

Parse only the declared flags; reject duplicate/unknown flags with exit 2. Emit one JSON object:

```json
{"schemaVersion":1,"profile":"runtime","nodePolicy":"exact","platform":"darwin","outcome":"pass","records":[]}
```

Aggregate any `inconclusive` to exit 2; otherwise aggregate `missing`, `incompatible`, or `path_hidden` required records to exit 1; otherwise exit 0. Human output uses the same record list and never performs a second probe.

- [ ] **Step 5: Wire public commands and rerun GREEN**

Add:

```json
"doctor": "bash deploy/scripts/whatsoup-host-doctor.sh"
```

Document both CLI surfaces in `docs/public-surface.md`, then run:

```bash
npm test -- tests/deploy/host-capabilities.test.ts --pool=forks --maxWorkers=1
bash -n deploy/lib/host-capabilities.sh deploy/scripts/whatsoup-host-doctor.sh
```

Expected: all doctor tests pass and both scripts parse.

- [ ] **Step 6: Commit Task 1**

```bash
git add deploy/lib/host-capabilities.sh deploy/scripts/whatsoup-host-doctor.sh tests/deploy/host-capabilities.test.ts package.json docs/public-surface.md
git commit -m "feat(setup): add portable host capability doctor (#3031)"
```

---

### Task 2: Explicit package-manager installation and managed quality venv

**Files:**
- Create: `deploy/scripts/install-host-dependencies.sh`
- Create: `tests/deploy/install-host-dependencies.test.ts`
- Modify: `deploy/lib/host-capabilities.sh`
- Modify: `package.json`
- Modify: `docs/public-surface.md`

**Interfaces:**
- Consumes: capability records and probes from Task 1.
- Produces: `install-host-dependencies.sh --profile <profile> [--manager <brew|apt|pacman>] [--apply] [--yes] [--json]`.
- Produces: quality interpreter at `${WHATSOUP_QUALITY_VENV:-${XDG_DATA_HOME:-$HOME/.local/share}/whatsoup/quality-venv}/bin/python`.

- [ ] **Step 1: Write failing adapter and mutation-boundary tests**

Use fake `brew`, `sudo`, `apt-get`, `pacman`, and Python executables that append argv to a private fixture ledger. Assert:

```ts
expect(plan('quality', 'brew')).toContainPackages(['git', 'python@3.12', 'ripgrep', 'shellcheck', 'zsh']);
expect(plan('release', 'apt')).toContainPackages(['git', 'python3', 'python3-venv', 'ripgrep', 'shellcheck', 'zsh', 'coreutils', 'util-linux']);
expect(plan('release', 'pacman')).toContainPackages(['git', 'python', 'python-pip', 'ripgrep', 'shellcheck', 'zsh', 'coreutils', 'util-linux']);
expect(planOnly()).toHaveEmptyLedger();
expect(applyWithoutConfirmation()).toMatchObject({ exitCode: 2 });
expect(unknownManager()).toMatchObject({ exitCode: 2, writes: 0 });
expect(applyQuality()).toHaveCreatedPrivateVenv('700');
expect(postInstallDoctorFailure()).toMatchObject({ exitCode: 1 });
```

- [ ] **Step 2: Run the installer suite and verify RED**

```bash
npm test -- tests/deploy/install-host-dependencies.test.ts --pool=forks --maxWorkers=1
```

Expected: FAIL because the installer does not exist.

- [ ] **Step 3: Implement plan/apply adapters**

Default mode prints a deduplicated package plan and performs no writes. `--apply --yes` executes exactly one adapter:

```bash
brew install "$@"
sudo apt-get update
sudo apt-get install -y "$@"
sudo pacman -S --needed --noconfirm "$@"
```

Interactive `--apply` prints the exact plan and accepts only `y` or `yes`; EOF/refusal exits 2 without mutation. Explicit `--manager` must agree with the detected platform family.

- [ ] **Step 4: Implement the managed venv and post-install proof**

For `quality` and `release`, resolve a Python 3.12-capable interpreter through the capability library, create the venv with `python -m venv`, chmod the venv root `0700`, and run:

```bash
"$venv_python" -m pip install pytest pytest-cov hypothesis ruff==0.15.10
```

Then rerun the same profile doctor. An unavailable venv module, package failure, or non-passing post-install doctor is nonzero and must not be rewritten as success.

- [ ] **Step 5: Run focused tests and shell checks**

Add the package command and public-surface row only after the installer exists:

```json
"setup:host-dependencies": "bash deploy/scripts/install-host-dependencies.sh"
```

```bash
npm test -- tests/deploy/install-host-dependencies.test.ts tests/deploy/host-capabilities.test.ts --pool=forks --maxWorkers=1
bash -n deploy/scripts/install-host-dependencies.sh deploy/lib/host-capabilities.sh
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add deploy/lib/host-capabilities.sh deploy/scripts/install-host-dependencies.sh tests/deploy/install-host-dependencies.test.ts package.json docs/public-surface.md
git commit -m "feat(setup): install explicit host dependency profiles (#3031)"
```

---

### Task 3: Bootstrap exact native Node before npm in setup

**Files:**
- Modify: `deploy/setup.sh`
- Modify: `deploy/scripts/ensure-node-installed.sh`
- Modify: `tests/deploy/setup-platform.test.ts`
- Modify: `tests/scripts/ensure-node-installed.test.ts`

**Interfaces:**
- Consumes: Task 1 doctor and Task 2 installer.
- Produces: `deploy/setup.sh [--profile <runtime|quality|release>] [--install-host-dependencies] [--yes]` while preserving `--check` and `--remove-timers`.

- [ ] **Step 1: Add failing setup-order and exact-pin tests**

Add fixture-ledger assertions that `ensure-node-installed.sh` runs before `npm ci`, that the exact `.nvmrc` binary directory is prepended, and that version-correct wrong-architecture Node blocks before npm. Add a no-Node fixture with fake nvm proving setup reaches `npm ci` only after the pinned binary appears.

```ts
expect(events).toEqual(['host-plan', 'ensure-node:24.15.0', 'doctor:runtime', 'npm:ci']);
expect(wrongArchitecture.events).not.toContain('npm:ci');
expect(pathNodeOnly('24.15.1').status).toBe(1);
```

- [ ] **Step 2: Run setup tests and verify RED**

```bash
npm test -- tests/deploy/setup-platform.test.ts tests/scripts/ensure-node-installed.test.ts --pool=forks --maxWorkers=1
```

Expected: new ordering and exact-version assertions fail.

- [ ] **Step 3: Refactor setup argument parsing and bootstrap order**

Before any `node` or `npm` invocation:

```bash
installer_args=(--profile "$profile")
if [ "$install_host_dependencies" = "1" ]; then
  installer_args+=(--apply)
  [ "$assume_yes" = "1" ] && installer_args+=(--yes)
fi
bash "$REPO_ROOT/deploy/scripts/install-host-dependencies.sh" "${installer_args[@]}"
bash "$REPO_ROOT/deploy/scripts/ensure-node-installed.sh"
pinned_version="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc")"
pinned_bin="${NVM_DIR:-$HOME/.nvm}/versions/node/v${pinned_version}/bin"
[ -x "$pinned_bin/node" ] && PATH="$pinned_bin:$PATH"
export PATH
bash "$REPO_ROOT/deploy/scripts/whatsoup-host-doctor.sh" --profile "$profile"
```

Build argument arrays without `eval`. When `--install-host-dependencies` is absent, invoke the installer in plan-only mode only if setup needs to print consolidated remediation; never install implicitly.

- [ ] **Step 4: Make ensure-node postconditions exact**

After `nvm install`, require `$NVM_ROOT/versions/node/v$NVMRC_VERSION/bin/node --version` to equal `v$NVMRC_VERSION`. Keep the no-nvm path non-mutating, but make setup's subsequent strict doctor the authoritative failure.

- [ ] **Step 5: Run focused setup regression suites**

```bash
npm test -- tests/deploy/setup-platform.test.ts tests/deploy/setup-wrapper-installs.test.ts tests/scripts/ensure-node-installed.test.ts tests/scripts/wrapper-node-version-gate.test.ts --pool=forks --maxWorkers=1
bash -n deploy/setup.sh deploy/scripts/ensure-node-installed.sh
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add deploy/setup.sh deploy/scripts/ensure-node-installed.sh tests/deploy/setup-platform.test.ts tests/scripts/ensure-node-installed.test.ts
git commit -m "fix(setup): bootstrap exact native Node before npm (#3031)"
```

---

### Task 4: Hermetic Python and `flock` test prerequisites

**Files:**
- Create: `tests/helpers/python-interpreter.ts`
- Create: `tests/helpers/python-interpreter.test.ts`
- Modify: `tests/scripts/bot-errors-python-atomic-write-guard.test.ts`
- Modify: `tests/scripts/bot-errors-release-proof-installer.test.ts`

**Interfaces:**
- Produces: `resolveTestPython(options?: { env?: NodeJS.ProcessEnv; minimum?: readonly [number, number]; spawn?: typeof spawnSync }): string`.
- Throws: `TestPrerequisiteError` with code `python-missing`, `python-version`, or `python-probe-failed`.

- [ ] **Step 1: Write failing resolver and consumer tests**

Test precedence exactly:

```ts
WHATSOUP_TEST_PYTHON
${WHATSOUP_QUALITY_VENV}/bin/python
${XDG_DATA_HOME:-$HOME/.local/share}/whatsoup/quality-venv/bin/python
python3.12
python3
```

Every candidate must pass `sys.version_info >= (3, 12)` and a zero-exit probe. An explicit invalid override fails immediately and does not widen to another candidate. Add the RED regression where `python3.12` is absent but `WHATSOUP_TEST_PYTHON` points to a valid fixture.

- [ ] **Step 2: Run Python helper tests and verify RED**

```bash
npm test -- tests/helpers/python-interpreter.test.ts tests/scripts/bot-errors-python-atomic-write-guard.test.ts --pool=forks --maxWorkers=1
```

Expected: resolver module missing and the atomic guard still spawns `python3.12`.

- [ ] **Step 3: Implement and consume `resolveTestPython`**

Use `spawnSync(candidate, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'])` with bounded output and no shell. Resolve once at module setup in the atomic-writer test and pass the returned absolute/command path to every `spawnSync`.

- [ ] **Step 4: Make installer `flock` ownership explicit**

Add a fixture `flock` that implements nonblocking fd-lock success for ordinary installer cases. Add one controlled-PATH test that omits it and asserts:

```ts
expect(res.status).toBe(2);
expect(res.stderr).toContain('missing dependency: flock');
expect(snapshotDir(fx.home)).toEqual(before);
expect(ledgerLines(fx)).toHaveLength(0);
```

Construct installer PATH from fixture tools plus `/usr/bin:/bin`; do not append the host PATH.

- [ ] **Step 5: Run affected suites on the target macOS host**

```bash
npm test -- tests/helpers/python-interpreter.test.ts tests/scripts/bot-errors-python-atomic-write-guard.test.ts tests/scripts/bot-errors-release-proof-installer.test.ts tests/scripts/bot-errors-release-proof-run.test.ts --pool=forks --maxWorkers=1
```

Expected: all affected suites pass without an external macOS `flock` or PATH `python3.12`.

- [ ] **Step 6: Commit Task 4**

```bash
git add tests/helpers/python-interpreter.ts tests/helpers/python-interpreter.test.ts tests/scripts/bot-errors-python-atomic-write-guard.test.ts tests/scripts/bot-errors-release-proof-installer.test.ts
git commit -m "test(portability): own Python and flock prerequisites (#3032)"
```

---

### Task 5: CI convergence and absent-doctor enforcement

**Files:**
- Modify: `.github/workflows/quality.yml`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`
- Modify: `tests/scripts/pre-push-guard.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: doctor/installer commands from Tasks 1 and 2.
- Produces: strict JSON receipt at `$RUNNER_TEMP/whatsoup-doctor-quality.json` and compatibility receipt at `$RUNNER_TEMP/whatsoup-doctor-compatibility.json`.

- [ ] **Step 1: Add failing workflow-structure mutations**

Extend the safeguard diagnostics fixtures so each mutation fails independently:

```ts
removeStep('Host dependency profile (strict)');
removeStep('Validate strict doctor receipt');
removeStep('Host dependency profile (compatibility-only)');
renameJob('quality (24.x)', 'quality');
removeTrigger('merge_group');
changeNode24SetupFromNvmrcToMajorRange();
```

Assert every failure names the missing exact contract.

- [ ] **Step 2: Run workflow guard tests and verify RED**

```bash
npm test -- tests/scripts/safeguard-diagnostics.test.ts tests/scripts/pre-push-guard.test.ts --pool=forks --maxWorkers=1
```

Expected: new receipt-step assertions fail.

- [ ] **Step 3: Wire the strict authority job**

Change Setup Node 24 to `node-version-file: '.nvmrc'`. Replace independent apt/Python-package prerequisite commands with the shared installer where their capabilities overlap, then run:

```yaml
- name: Host dependency profile (strict)
  run: bash deploy/scripts/install-host-dependencies.sh --profile quality --apply --yes --json > "$RUNNER_TEMP/whatsoup-doctor-quality.json"
- name: Validate strict doctor receipt
  run: bash deploy/scripts/whatsoup-host-doctor.sh --profile quality --json | tee "$RUNNER_TEMP/whatsoup-doctor-quality.json"
```

The second command must be unconditional and its exit status must propagate through `pipefail` or a no-pipe writer path.

- [ ] **Step 4: Wire compatibility and macOS coverage**

In `quality (25.x)`, run the same capability evaluator with `--node-policy compatibility` and validate `outcome=compatibility_only`. In `bot-errors-health-macos`, add the four affected suites from Task 4. Do not install external `flock` on macOS.

- [ ] **Step 5: Enforce exact workflow structure**

Update `qualityCiLanePartitionFailures` to require exactly one strict doctor step, one strict receipt-validation step, one compatibility doctor step, `.nvmrc` setup in the authority job, `25.x` setup in compatibility, and both existing triggers/job names. Update the pre-push workflow expectations accordingly.

- [ ] **Step 6: Run CI contract tests**

```bash
npm test -- tests/scripts/safeguard-diagnostics.test.ts tests/scripts/pre-push-guard.test.ts tests/deploy/host-capabilities.test.ts --pool=forks --maxWorkers=1
npm run guard:safeguard-diagnostics
npm run guard:branch-protection-drift
```

Expected: all focused tests and the live guards pass. Run the branch-protection
readback from the authenticated workstation; missing GitHub authority is
inconclusive, not a pass.

- [ ] **Step 7: Commit Task 5**

```bash
git add .github/workflows/quality.yml scripts/safeguard-diagnostics.ts tests/scripts/safeguard-diagnostics.test.ts tests/scripts/pre-push-guard.test.ts package.json
git commit -m "ci: consume host capability receipts in required lanes (#3031)"
```

---

### Task 6: Documentation, generated indexes, and PR1 verification

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook.md`
- Modify: `docs/public-surface.md`
- Modify: `docs/publication-audit.md`
- Modify: `docs/work-index.json`
- Modify: `docs/work-index.md`

**Interfaces:**
- Consumes: completed PR1 commands and receipts.
- Produces: documented clean-host path and final branch verification evidence.

- [ ] **Step 1: Update operator documentation**

Document this exact sequence:

```bash
bash deploy/scripts/whatsoup-host-doctor.sh --profile runtime
bash deploy/setup.sh --profile runtime --install-host-dependencies
bash deploy/scripts/whatsoup-host-doctor.sh --profile quality
```

Explain profile contents, explicit mutation, exact `.nvmrc`/native-architecture enforcement, PATH-hidden results, managed venv location, compatibility-only CI, and why macOS does not install `flock` for JavaScript tests. Remove the old requirement to run `npm ci` before setup.

- [ ] **Step 2: Regenerate publication and work indexes**

```bash
npm run guard:publication:write
npm run work-index:regen
```

Expected: only canonical generated rows change.

- [ ] **Step 3: Run focused PR1 battery**

```bash
npm test -- tests/deploy/host-capabilities.test.ts tests/deploy/install-host-dependencies.test.ts tests/deploy/setup-platform.test.ts tests/deploy/setup-wrapper-installs.test.ts tests/scripts/ensure-node-installed.test.ts tests/helpers/python-interpreter.test.ts tests/scripts/bot-errors-python-atomic-write-guard.test.ts tests/scripts/bot-errors-release-proof-installer.test.ts tests/scripts/bot-errors-release-proof-run.test.ts tests/scripts/safeguard-diagnostics.test.ts tests/scripts/pre-push-guard.test.ts --pool=forks --maxWorkers=1
npm run typecheck:all
npm run guard:test-integrity:required
npm run guard:publication:release
npm run guard:repo:branch-diff
npm run guard:branch-protection-drift
```

Expected: every command passes with zero skipped or masked checks.

- [ ] **Step 4: Run platform and release gates**

```bash
bash deploy/scripts/whatsoup-host-doctor.sh --profile quality --json
bash deploy/scripts/install-host-dependencies.sh --profile release --json
npm run verify:push:branch
npm run verify:release
```

Expected: strict quality doctor passes on the target macOS host; release plan is
read-only; both gates pass. Any environment-unavailable Test Integrity or
release check remains inconclusive and blocks completion.

- [ ] **Step 5: Inspect the complete branch diff and commit docs**

```bash
git diff --check upstream/main...HEAD
git diff --stat upstream/main...HEAD
git log --format='%h %an <%ae> %s' upstream/main..HEAD
git add README.md docs/runbook.md docs/public-surface.md docs/publication-audit.md docs/work-index.json docs/work-index.md
git commit -m "docs: publish portable host setup profiles (#3031)"
```

- [ ] **Step 6: Verify exact-head publication readiness**

```bash
npm run verify:push:branch
git status --short --branch
git rev-parse HEAD upstream/main
```

Expected: gate passes against the exact clean head, branch is only ahead of canonical main, and no production checkout or service changed.

---

## Self-Review Record

- Spec coverage: Tasks 1-3 cover #3031's capability, installation, bootstrap, architecture, and PATH contracts; Task 4 covers #3032; Task 5 covers required CI contexts and macOS coverage; Task 6 covers documentation and gates.
- Placeholder scan: no deferred implementation markers or unnamed error handling remain.
- Type consistency: doctor flags, receipt paths, resolver names, profile names, exit codes, and venv paths are identical across producing and consuming tasks.
- Scope: no PR2 launchd reconciler, credential mutation, fallback accounting, WhatsApp canary, or production deployment is included.
