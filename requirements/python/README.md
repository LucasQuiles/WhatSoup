# Python dependency locks

The committed locks in this directory are the only approved source for production,
CI, release, host-quality, and transcription Python installs. They are qualified
for CPython `3.13.16` and the named target (`linux-x64`, `linux-arm64`,
`darwin-x64`, or `darwin-arm64`). Installers select the target with
`deploy/lib/python-lock-policy.sh` from the selected interpreter's architecture,
require the exact runtime, and use the PyPI
simple index with `--require-hashes` and `--only-binary :all:`. Pip runs in
isolated mode with `PIP_CONFIG_FILE=/dev/null`, excluding inherited pip options
and all configuration files from the approved package-source selection.
The interpreter identity probe, environment creation, package installation and
transcription script all use Python's `-I` mode. Ambient `PYTHONPATH`, user-site
packages and the working directory cannot substitute startup or dependency modules.
An x86_64 interpreter under Rosetta uses the `darwin-x64` lock even on an
ARM-capable Mac. A failed or unsupported interpreter architecture probe stops
installation before pip runs. The probe runs in isolated mode so ambient Python
paths cannot replace the platform module used for lock selection.
Installer capability, identity and architecture probes, and the host doctor's exact Python
identity probe, use a five-second budget through the shared shell supervisor.
`WHATSOUP_PYTHON_PROBE_TIMEOUT` overrides that budget; expiration fails the probe
and reaps its process group, with a further termination grace period.

The dependency guard also checks direct `pip` invocations prefixed by shell
assignments or `env`, including environment-clearing, unset, working-directory
and option-delimiter prefixes. Split-string or unknown `env` options on a pip
line fail closed. Its scan fails closed above 4 MiB per file, 64 MiB total
read bytes, 10,000 directory entries, or 64 nested directories. Policy and lock
reads share these bounds. Unreadable files and size changes detected while reading
fail the scan; this is not an atomic snapshot of concurrent repository edits.
Symbolic links in scanned source fail rather than being followed or silently skipped.
Excluded documentation, tests and build/dependency directories are not scanned;
an exceeded bound is a failure, not evidence that the remaining files are safe.
Literal shell `-c` command strings are scanned recursively, including nested
wrappers. Pip-bearing command strings with unresolved expansion, unknown options
or more than 16 nested shell wrappers fail closed. The guard is a bounded source
scan; dynamically generated commands outside the scanned source still require review.

## Replacing managed environments

The host and transcription installers create a fresh managed environment before
applying a lock. An existing environment must have a regular `pyvenv.cfg`; symlink
or unrecognized targets are refused. Its complete directory is retained at the
printed adjacent `.previous.*` path, so old packages and startup hooks cannot run
in the replacement. A failed environment creation restores the previous path and
retains partial output for inspection. A later package-install failure leaves the
previous directory available for an explicit rollback; do not use the incomplete
replacement. Retire the retained environment only after installation, imports and
its consumers pass, using the applicable storage-retirement procedure.

## Migration regression prerequisites

The managed-environment regression uses real CPython 3.12 and the locked 3.13.16
runtime. CI provisions both explicitly. For local runs, set
`WHATSOUP_TEST_LEGACY_PYTHON` and `WHATSOUP_TEST_LOCKED_PYTHON` to their executable
paths when `python3.12` and `python3.13` do not resolve to those versions. Missing or
wrong runtimes fail the test; they do not skip the migration check. The test checks
both generic launchers, old startup-hook exclusion, and retained prior bytes.

## Transcription runtime acceptance

The required Linux Node 25 compatibility job and macOS quality job require the real audio fixture to pass
directly through faster-whisper in the freshly installed transcription lock.
Linux audio package setup runs in the existing compatibility job, which does not
receive the private dependency deploy key used by the Node 24 job.
`scripts/run-locked-transcription-smoke.sh <venv-python> <fixture-directory>`
provides the same check locally. Use a dedicated temporary fixture directory.
It verifies CPython 3.13.16, downloads a revision-pinned tiny.en model with four
SHA-256 checks, and selects the interpreter and local model explicitly. The test
fails if a prerequisite is missing and cannot fall back to another provider.
The ordinary optional shared-chain test remains separate from this required lane.
This smoke check covers runtime compatibility; it does not qualify every model.
Ordinary transcription also checks the selected interpreter in isolated mode
against `lock-policy.json` before normalizing audio or starting the model. A wrong
implementation, patch version, failed probe or five-second timeout rejects that
provider attempt. Termination can take an additional two-second grace period
before SIGKILL. An explicit interpreter override does not bypass the check.

On 2026-10-20, the transcription input added `av<19` because faster-whisper 1.2.1
passes `metadata_errors` to `av.open`, an argument removed in PyAV 19
([upstream issue](https://github.com/SYSTRAN/faster-whisper/issues/1589)).
All four transcription locks were regenerated with the commands below and
`uv 0.11.1`. Each lock records its exact resolved version and hashes. The required
Linux and macOS audio checks remain the compatibility acceptance boundary.

The transcription installer bounds Homebrew, pip and the model download to
600 seconds, with a 15-second connect limit, three redirects, HTTPS-only
transport, a 512 MiB curl limit, and an independent kernel file ceiling of at most
1 GiB. Curl's inherited configuration is disabled. A timeout remains a failure;
there is no automatic retry. `WHATSOUP_PKG_INSTALL_TIMEOUT`, `WHATSOUP_PIP_INSTALL_TIMEOUT` and
`WHATSOUP_MODEL_DOWNLOAD_TIMEOUT` can set the outer operation budgets.

## Updating a lock

Record the update date, reason or advisory, input-pin change, generator version,
commands, target, review, and clean-install or owning-test evidence in the change
record. Do not edit generated lock bytes or hashes by hand.

On 2026-10-13, the initial locks for issue #3777 were generated with `uv 0.11.1`
from `https://pypi.org/simple` and an interpreter whose identity was verified as
CPython `3.13.16`. The inputs are `quality-cpython313.in` and
`transcription-cpython313.in`. Set `PYTHON_31316` to an exact interpreter before
regenerating every target after changing either input or the approved runtime policy:

```bash
PYTHON_31316=/path/to/cpython-3.13.16/bin/python3.13
"$PYTHON_31316" -I -c 'import sys; assert sys.implementation.name == "cpython" and sys.version_info[:3] == (3, 13, 16)'
uv pip compile requirements/python/quality-cpython313.in \
  --output-file requirements/python/quality-cpython313-linux-x64.txt \
  --generate-hashes --only-binary :all: --python "$PYTHON_31316" \
  --python-version 3.13.16 \
  --python-platform x86_64-unknown-linux-gnu \
  --default-index https://pypi.org/simple --no-sources --no-progress
```

Use the same command for each combination below, changing the input, output, and
`--python-platform` values:

| Target | `--python-platform` |
|---|---|
| `linux-x64` | `x86_64-unknown-linux-gnu` |
| `linux-arm64` | `aarch64-unknown-linux-gnu` |
| `darwin-x64` | `x86_64-apple-darwin` |
| `darwin-arm64` | `aarch64-apple-darwin` |

Run `npm run guard:python-dependency-lock`, inspect the complete lock diff and
input pins, then run a clean venv install for every locally available target. CI
must complete the Linux quality path before treating the Linux lock as verified.
Treat a generator warning that substitutes another Python patch as a failed update.
If a dependency has no wheel for a supported target, do not add an sdist fallback:
record the blocked target and resolve the dependency or support decision first.
