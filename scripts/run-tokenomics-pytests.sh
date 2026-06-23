#!/usr/bin/env bash
set -euo pipefail

export PYTHONDONTWRITEBYTECODE=1

python_candidates=()
if [[ -n "${TOKENOMICS_PYTHON:-}" ]]; then
  python_candidates+=("$TOKENOMICS_PYTHON")
fi
python_candidates+=(python3.12 python3)

for python_bin in "${python_candidates[@]}"; do
  if command -v "$python_bin" >/dev/null 2>&1 && "$python_bin" -c 'import pytest' >/dev/null 2>&1; then
    exec "$python_bin" -m pytest -q -p no:cacheprovider plugins/tokenomics/tests
  fi
done

if command -v pytest >/dev/null 2>&1; then
  exec pytest -q -p no:cacheprovider plugins/tokenomics/tests
fi

echo "pytest is required to run tokenomics Python tests" >&2
exit 2
