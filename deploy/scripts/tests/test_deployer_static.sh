set -u
D=deploy/scripts/whatsoup-bot-errors-deploy.sh
bash -n "$D" || { echo "STATIC_FAIL: syntax"; exit 1; }
# `local` may appear only inside function bodies. The deployer defines functions sha(), do_verify(),
# smoke_redaction(); flag any `local ` that is NOT within a function (heuristic: none expected at all
# in case-arms — assert zero `local` usage outside the helper functions by checking the case block).
if awk '/^[a-zA-Z_]+\(\)/{infn=1} /^}/{infn=0} /^[[:space:]]*local[[:space:]]/{if(!infn){print NR": "$0; bad=1}} END{exit bad?1:0}' "$D"; then
  echo "STATIC_PASS"
else
  echo "STATIC_FAIL: 'local' used outside a function"; exit 1
fi
