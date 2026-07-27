#!/usr/bin/env bash
set -euo pipefail

# Exit codes:
#   0: the free-space budget is satisfied
#   1: cleanup completed, but measured free space remains below budget
#   2: the result is inconclusive because setup or measurement failed

DEFAULT_BUDGET_KIB=$((30 * 1024 * 1024))
budget_raw=${CI_DISK_RECLAIM_BUDGET_KIB:-$DEFAULT_BUDGET_KIB}
actions_json=''

allowlisted_paths=(
  '/usr/share/dotnet'
  '/opt/ghc'
  '/usr/local/lib/android'
  '/usr/local/share/boost'
  '/opt/hostedtoolcache/CodeQL'
)

append_action() {
  local kind=$1
  local target=$2
  local outcome=$3
  local entry
  printf -v entry \
    '{"kind":"%s","target":"%s","outcome":"%s"}' \
    "$kind" \
    "$target" \
    "$outcome"
  if [[ -n "$actions_json" ]]; then
    actions_json+=','
  fi
  actions_json+=$entry
}

emit_receipt() {
  local exit_class=$1
  local skipped=$2
  local partial_failure=$3
  local free_before=$4
  local free_after=$5
  local error=${6:-}
  local error_field=''
  if [[ -n "$error" ]]; then
    printf -v error_field ',"error":"%s"' "$error"
  fi
  printf \
    '{"schema_version":1,"budget_kib":%s,"free_before_kib":%s,"free_after_kib":%s,"exit_class":"%s","skipped":%s,"partial_failure":%s%s,"actions":[%s]}\n' \
    "$budget_kib" \
    "$free_before" \
    "$free_after" \
    "$exit_class" \
    "$skipped" \
    "$partial_failure" \
    "$error_field" \
    "$actions_json"
}

read_free_kib() {
  local output
  local available
  if output=$(LC_ALL=C df -Pk /); then
    :
  else
    return 10
  fi
  if available=$(
    LC_ALL=C awk '
      BEGIN { valid = 1 }
      NR == 1 {
        if (NF != 7 ||
            $1 != "Filesystem" ||
            $2 != "1024-blocks" ||
            $3 != "Used" ||
            $4 != "Available" ||
            $5 != "Capacity" ||
            $6 != "Mounted" ||
            $7 != "on") {
          valid = 0
        }
      }
      NR == 2 {
        if (NF != 6 || $4 !~ /^[0-9]+$/ || $6 != "/") {
          valid = 0
        }
        available = $4
      }
      NR > 2 { valid = 0 }
      END {
        if (NR != 2 || valid != 1) {
          exit 2
        }
        print available
      }
    ' <<< "$output"
  ); then
    :
  else
    return 11
  fi
  printf '%s\n' "$available"
}

if [[ ! "$budget_raw" =~ ^[1-9][0-9]*$ ]]; then
  budget_kib=0
  emit_receipt 'inconclusive' true false null null 'budget_invalid'
  exit 2
fi
budget_kib=$budget_raw

initial_probe_status=0
if free_before_kib=$(read_free_kib); then
  :
else
  initial_probe_status=$?
fi
if ((initial_probe_status != 0)); then
  if ((initial_probe_status == 10)); then
    initial_error='df_initial_failed'
  else
    initial_error='df_initial_malformed'
  fi
  emit_receipt 'inconclusive' true false null null "$initial_error"
  exit 2
fi

if ((free_before_kib >= budget_kib)); then
  emit_receipt 'sufficient_space' true false "$free_before_kib" "$free_before_kib"
  exit 0
fi

partial_failure=false
for target in "${allowlisted_paths[@]}"; do
  if sudo rm -rf -- "$target" >&2; then
    append_action 'remove' "$target" 'succeeded'
  else
    append_action 'remove' "$target" 'failed'
    partial_failure=true
  fi
done

if docker image prune --all --force >&2; then
  append_action 'docker_prune' 'docker-images' 'succeeded'
else
  append_action 'docker_prune' 'docker-images' 'failed'
  partial_failure=true
fi

final_probe_status=0
if free_after_kib=$(read_free_kib); then
  :
else
  final_probe_status=$?
fi
if ((final_probe_status != 0)); then
  if ((final_probe_status == 10)); then
    final_error='df_final_failed'
  else
    final_error='df_final_malformed'
  fi
  emit_receipt \
    'inconclusive' \
    false \
    "$partial_failure" \
    "$free_before_kib" \
    null \
    "$final_error"
  exit 2
fi

if ((free_after_kib >= budget_kib)); then
  emit_receipt \
    'reclaimed' \
    false \
    "$partial_failure" \
    "$free_before_kib" \
    "$free_after_kib"
  exit 0
fi

emit_receipt \
  'insufficient_space' \
  false \
  "$partial_failure" \
  "$free_before_kib" \
  "$free_after_kib"
exit 1
