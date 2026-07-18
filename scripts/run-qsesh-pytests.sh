#!/usr/bin/env bash
set -euo pipefail

export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="tools/qsesh${PYTHONPATH:+:$PYTHONPATH}"

targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then
  targets=(tools/qsesh/tests)
fi

python_candidates=()
if [[ -n "${QSESH_PYTHON:-}" ]]; then
  python_candidates+=("$QSESH_PYTHON")
fi
python_candidates+=(python3.12 python3)

for python_bin in "${python_candidates[@]}"; do
  if command -v "$python_bin" >/dev/null 2>&1 && "$python_bin" -c 'import pytest' >/dev/null 2>&1; then
    exec "$python_bin" -m pytest -q -p no:cacheprovider "${targets[@]}"
  fi
done

echo "pytest is required to run qSesh Python tests" >&2
exit 2
