# Python dependency locks

The committed locks in this directory are the only approved source for production,
CI, release, host-quality, and transcription Python installs. They are qualified
for CPython `3.13.16` and the named target (`linux-x64`, `linux-arm64`,
`darwin-x64`, or `darwin-arm64`). Installers select the target with
`deploy/lib/python-lock-policy.sh`, require the exact runtime, and use the PyPI
simple index with `--require-hashes` and `--only-binary :all:`.

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
"$PYTHON_31316" -c 'import sys; assert sys.implementation.name == "cpython" and sys.version_info[:3] == (3, 13, 16)'
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
