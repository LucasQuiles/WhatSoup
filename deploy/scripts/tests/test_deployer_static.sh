#!/usr/bin/env bash
set -euo pipefail
D=deploy/scripts/whatsoup-bot-errors-deploy.sh
bash -n "$D" || { echo "STATIC_FAIL: syntax"; exit 1; }
# `local` may appear only inside function bodies. The deployer defines functions sha(), do_verify(),
# smoke_redaction(); flag any `local ` that is NOT within a function (heuristic: none expected at all
# in case-arms — assert zero `local` usage outside the helper functions by checking the case block).
if awk '/^[a-zA-Z_]+\(\)/{infn=1} /^}/{infn=0} /^[[:space:]]*local[[:space:]]/{if(!infn){print NR": "$0; bad=1}} END{exit bad?1:0}' "$D"; then
  :
else
  echo "STATIC_FAIL: 'local' used outside a function"; exit 1
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bash "$D" verify "$PWD" > "$tmp/verify-current.log" 2>&1 || { echo "STATIC_FAIL: repo-root verify"; cat "$tmp/verify-current.log"; exit 1; }
mkdir -p "$tmp/root/deploy/scripts/lib"
ln -s "$PWD/deploy/scripts/lib/bot_errors_redaction.py" "$tmp/root/deploy/scripts/lib/bot_errors_redaction.py"
if bash "$D" verify "$tmp/root" > "$tmp/symlink.log" 2>&1; then
  echo "STATIC_FAIL: symlinked bundle path accepted"; cat "$tmp/symlink.log"; exit 1
fi
grep -q "SYMLINK" "$tmp/symlink.log" || { echo "STATIC_FAIL: symlink failure not reported"; cat "$tmp/symlink.log"; exit 1; }
echo "STATIC_PASS"
