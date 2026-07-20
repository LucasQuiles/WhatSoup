#!/usr/bin/env bash
set -euo pipefail

export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="tools/qsesh${PYTHONPATH:+:$PYTHONPATH}"

targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then
  targets=(tools/qsesh/tests)
fi

# Identify the ENVIRONMENT a candidate runs in, not the file on disk.
#
# Deliberately NOT `readlink -f`: the managed runtime is a venv-style symlink
# whose site-packages resolve relative to the LINK. Resolving it yields the base
# interpreter, which has no pytest — so canonicalising the path silently drops
# the very runtime this script exists to exercise. sys.prefix + version is the
# thing that actually distinguishes one test run from another.
env_id() {
  "$1" -c 'import sys; print(sys.prefix, "%d.%d.%d" % sys.version_info[:3])' 2>/dev/null
}

if [[ -n "${QSESH_PYTHON:-}" ]]; then
  # An explicit override means "use exactly this interpreter" — do not widen it.
  python_candidates=("$QSESH_PYTHON")
else
  # The qSesh metric contract requires cross-runtime determinism: word/token
  # counts resolve \w against the interpreter's Unicode database, so a value can
  # be right on 3.12 and wrong on 3.14. This loop used to `exec` on the first
  # interpreter it found, and the list held only (python3.12 python3) — so the
  # managed 3.14 runtime was never invoked and every green report was
  # single-runtime, hiding exactly that class of defect. Run every available
  # target runtime instead.
  python_candidates=(
    "${HOME}/.local/share/qsesh-runtimes/py314/bin/python"
    python3.14
    python3.12
    python3
  )
fi

seen=""
ran=0
status=0

for python_bin in "${python_candidates[@]}"; do
  command -v "$python_bin" >/dev/null 2>&1 || continue
  ident=$(env_id "$python_bin") || continue
  [[ -n "$ident" ]] || continue
  case "${seen}" in
    *"|${ident}|"*) continue ;;
  esac
  "$python_bin" -c 'import pytest' >/dev/null 2>&1 || continue

  seen="${seen}|${ident}|"
  ran=$((ran + 1))
  printf '== qsesh tests: %s (%s) ==\n' "$python_bin" "$ident" >&2
  # Do not short-circuit: a later interpreter's failure must still be reported.
  if ! "$python_bin" -m pytest -q -p no:cacheprovider "${targets[@]}"; then
    status=1
  fi
done

if [[ "${ran}" -eq 0 ]]; then
  echo "pytest is required to run qSesh Python tests" >&2
  exit 2
fi

exit "${status}"
