#!/usr/bin/env bash
# Wave-4b — sol/tera/luna persona passes via codex CLI (gpt-5.6).
set -u
DIR=${QA_ROOT:-$HOME/.cache/soup-v35-qa}
OUT=$DIR/reports-w4
mkdir -p "$DIR/tmp"
SURFACES=(fleet hatch agents skills-hub dream-lab inbox deployments settings splash)

run_codex() {
  local name=$1; shift
  local persona=$1; shift
  local imgs=("$@")
  local args=() names=""
  for i in "${imgs[@]}"; do args+=(-i "$DIR/w4/$i.png"); names="$names $i.png"; done
  python3 - "$persona" $names > "$DIR/tmp/w4-persona-prompt.txt" <<'PYEOF'
import sys
sys.path.insert(0, '${QA_ROOT}')
from w4_personas import sol_prompt, luna_prompt, tera_prompt
persona = sys.argv[1]; names = sys.argv[2:]
fn = {'sol': sol_prompt, 'luna': luna_prompt, 'tera': tera_prompt}[persona]
print(fn(names))
PYEOF
  echo "[$persona] $name starting"
  codex exec "${args[@]}" --skip-git-repo-check "$(cat "$DIR/tmp/w4-persona-prompt.txt")" </dev/null > "$OUT/$persona-$name.txt" 2>>"$OUT/personas.log"
  echo "[$persona] $name: $(wc -c < "$OUT/$persona-$name.txt") chars"
}

B1=(fleet hatch agents)
B2=(skills-hub dream-lab inbox)
B3=(deployments settings splash)

for b in 1 2 3; do
  eval "set -- \${B$b[@]}"
  run_codex $b sol "$1-light" "$2-light" "$3-light"
done
for b in 1 2 3; do
  eval "set -- \${B$b[@]}"
  run_codex $b luna "$1-dark" "$2-dark" "$3-dark"
done
run_codex global-dark tera "${SURFACES[@]/%/-dark}"
run_codex global-light tera "${SURFACES[@]/%/-light}"
echo "[personas] DONE"
