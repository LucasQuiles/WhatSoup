#!/usr/bin/env bash
# Wave-4 adversarial QA driver — Anthropic family via claude CLI (headless, subscription).
set -u
DIR=${QA_ROOT:-$HOME/.cache/soup-v35-qa}
OUT=$DIR/reports-w4
mkdir -p "$DIR/tmp"
PROMPT_MOD=$DIR

declare -a BATCH1=(fleet-dark fleet-light hatch-dark hatch-light agents-dark agents-light)
declare -a BATCH2=(skills-hub-dark skills-hub-light dream-lab-dark dream-lab-light inbox-dark inbox-light)
declare -a BATCH3=(deployments-dark deployments-light settings-dark settings-light splash-dark splash-light)
declare -a GLOBALB=(fleet-dark hatch-dark agents-dark skills-hub-dark dream-lab-dark inbox-dark deployments-dark settings-dark splash-dark)

run_batch() {
  local name=$1; shift
  local mode=$1; shift
  local imgs=("$@")
  local paths="" names=""
  for i in "${imgs[@]}"; do paths="$paths $DIR/w4/$i.png"; names="$names $i.png"; done
  python3 - "$mode" $names > "$DIR/tmp/w4-claude-prompt.txt" <<'PYEOF'
import sys
sys.path.insert(0, '${QA_ROOT}')
from w4_prompt import surface_prompt, global_prompt
mode = sys.argv[1]
names = sys.argv[2:]
print(global_prompt(names) if mode == 'global' else surface_prompt(names))
PYEOF
  cat >> "$DIR/tmp/w4-claude-prompt.txt" <<EOF

FIRST use the Read tool to read each of these image files (they are the screenshots named above, in the same order):$paths
Then run the full battery and produce the structured report. Output ONLY the report.
EOF
  echo "[claude] $name starting"
  env -u ANTHROPIC_API_KEY claude -p "$(cat "$DIR/tmp/w4-claude-prompt.txt")" --allowedTools "Read" --output-format text > "$OUT/claude-$name.txt" 2>>"$OUT/claude.log"
  echo "[claude] $name: $(wc -c < "$OUT/claude-$name.txt") chars"
}

run_batch 1 surface "${BATCH1[@]}"
run_batch 2 surface "${BATCH2[@]}"
run_batch 3 surface "${BATCH3[@]}"
run_batch global global "${GLOBALB[@]}"
echo "[claude] DONE"
