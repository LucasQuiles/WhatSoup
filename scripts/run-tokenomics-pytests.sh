#!/usr/bin/env bash
set -euo pipefail

export PYTHONDONTWRITEBYTECODE=1

if python3 -c 'import pytest' >/dev/null 2>&1; then
  exec python3 -m pytest -q -p no:cacheprovider plugins/tokenomics/tests
fi

if command -v pytest >/dev/null 2>&1; then
  exec pytest -q -p no:cacheprovider plugins/tokenomics/tests
fi

echo "pytest is required to run tokenomics Python tests" >&2
exit 2
