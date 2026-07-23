#!/usr/bin/env bash
# Wave-4 adversarial QA driver — codex CLI (gpt-5.6) as third vote (OpenAI family, distinct model).
set -u
DIR=${QA_ROOT:-$HOME/.cache/soup-v35-qa}
OUT=$DIR/reports-w4
mkdir -p "$DIR/tmp"

declare -a BATCH1=(fleet-dark fleet-light hatch-dark hatch-light agents-dark agents-light)
declare -a BATCH2=(skills-hub-dark skills-hub-light dream-lab-dark dream-lab-light inbox-dark inbox-light)
declare -a BATCH3=(deployments-dark deployments-light settings-dark settings-light splash-dark splash-light)
declare -a GLOBALB=(fleet-dark hatch-dark agents-dark skills-hub-dark dream-lab-dark inbox-dark deployments-dark settings-dark splash-dark)

run_batch() {
  local name=$1; shift
  local mode=$1; shift
  local imgs=("$@")
  local args=() names=""
  for i in "${imgs[@]}"; do args+=(-i "$DIR/w4/$i.png"); names="$names $i.png"; done
  python3 - "$mode" $names > "$DIR/tmp/w4-codex-prompt.txt" <<'PYEOF'
import sys
sys.path.insert(0, '${QA_ROOT}')
from w4_prompt import surface_prompt, global_prompt
mode = sys.argv[1]
names = sys.argv[2:]
print(global_prompt(names) if mode == 'global' else surface_prompt(names))
PYEOF
  echo "[codex] $name starting"
  codex exec "${args[@]}" --skip-git-repo-check "$(cat "$DIR/tmp/w4-codex-prompt.txt")" </dev/null > "$OUT/codex-$name.txt" 2>>"$OUT/codex.log"
  echo "[codex] $name: $(wc -c < "$OUT/codex-$name.txt") chars"
}

run_batch 1 surface "${BATCH1[@]}"
run_batch 2 surface "${BATCH2[@]}"
run_batch 3 surface "${BATCH3[@]}"
run_batch global global "${GLOBALB[@]}"
echo "[codex] DONE"
