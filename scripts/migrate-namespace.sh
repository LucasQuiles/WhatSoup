#!/usr/bin/env bash
# migrate-namespace.sh
#
# ONE-TIME migration: copies auth, DB, and config from legacy namespaces
# into the canonical whatsoup/instances/ namespace layout.
#
# Run ONCE, manually, AFTER all legacy services are stopped.
#
# Usage:
#   ./migrate-namespace.sh [--dry-run]
#
# Instances migrated:
#   q        <- personal   (~/.config/whatsapp-instances/personal/)
#   loops    <- loops      (~/.config/whatsapp-instances/loops/)
#   besbot   <- besbot     (~/.config/whatsapp-instances/besbot/)
#   personal <- new passive (~/.config/whatsapp-mcp/auth_info/)

set -euo pipefail

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
DRY_RUN=false
ERRORS=0
WARNINGS=0
SKIPPED=()
COPIED=()
CHECKSUM_MISMATCHES=()
LEGACY_PATHS_PRESERVED=()

# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()    { echo "[INFO]  $*"; }
warn()   { echo "[WARN]  $*" >&2; WARNINGS=$((WARNINGS + 1)); }
error()  { echo "[ERROR] $*" >&2; ERRORS=$((ERRORS + 1)); }
skip()   { echo "[SKIP]  $*"; SKIPPED+=("$*"); }
action() { echo "[DO]    $*"; }

# Run a command (or print it in dry-run mode).
run() {
  if $DRY_RUN; then
    echo "[DRY]   $*"
  else
    "$@"
  fi
}

# Copy a single file; skip if dest exists; verify checksum after copy.
copy_file() {
  local src="$1"
  local dest="$2"

  if [[ ! -f "$src" ]]; then
    warn "Source file not found, skipping: $src"
    return
  fi

  if [[ -e "$dest" ]]; then
    skip "Destination already exists: $dest"
    return
  fi

  action "cp $src -> $dest"
  run mkdir -p "$(dirname "$dest")"
  run cp -p "$src" "$dest"

  if ! $DRY_RUN; then
    local src_sum dest_sum
    src_sum=$(sha256sum "$src" | awk '{print $1}')
    dest_sum=$(sha256sum "$dest" | awk '{print $1}')
    if [[ "$src_sum" != "$dest_sum" ]]; then
      error "Checksum mismatch after copy: $src -> $dest"
      CHECKSUM_MISMATCHES+=("$src -> $dest")
    else
      COPIED+=("$dest")
    fi
  else
    COPIED+=("$dest (dry-run)")
  fi
}

# Copy a directory recursively; skip if dest already exists (with warning).
copy_dir() {
  local src="$1"
  local dest="$2"

  if [[ ! -d "$src" ]]; then
    warn "Source directory not found, skipping: $src"
    return
  fi

  if [[ -d "$dest" ]]; then
    skip "Destination directory already exists: $dest"
    return
  fi

  action "cp -rp $src/ -> $dest/"
  run mkdir -p "$(dirname "$dest")"
  run cp -rp "$src/" "$dest/"
  COPIED+=("$dest/ (directory)")
}

# Ensure a directory exists; idempotent.
ensure_dir() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    skip "Directory already exists: $dir"
    return
  fi
  action "mkdir -p $dir"
  run mkdir -p "$dir"
  COPIED+=("$dir/ (created)")
}

# Copy all bot.db* WAL sidecars from a source directory to dest directory.
copy_db_with_wal() {
  local src_dir="$1"
  local dest_dir="$2"

  if [[ ! -d "$src_dir" ]]; then
    warn "DB source directory not found: $src_dir"
    return
  fi

  local found_any=false
  for src_file in "$src_dir"/bot.db*; do
    [[ -e "$src_file" ]] || continue
    found_any=true
    local fname
    fname=$(basename "$src_file")
    local dest_file="$dest_dir/$fname"

    if [[ -e "$dest_file" ]]; then
      skip "DB file already exists: $dest_file"
      continue
    fi

    action "cp (DB+WAL) $src_file -> $dest_file"
    run mkdir -p "$dest_dir"
    run cp -p "$src_file" "$dest_file"

    if ! $DRY_RUN; then
      local src_sum dest_sum
      src_sum=$(sha256sum "$src_file" | awk '{print $1}')
      dest_sum=$(sha256sum "$dest_file" | awk '{print $1}')
      if [[ "$src_sum" != "$dest_sum" ]]; then
        error "Checksum mismatch: $src_file -> $dest_file"
        CHECKSUM_MISMATCHES+=("$src_file -> $dest_file")
      else
        COPIED+=("$dest_file")
      fi
    else
      COPIED+=("$dest_file (dry-run)")
    fi
  done

  if ! $found_any; then
    log "No bot.db* files found in $src_dir (will be created on first boot)"
  fi
}

# Rewrite a JSON field in-place: set key to new string value.
# Uses python3 so we don't require jq.
rewrite_json_field() {
  local file="$1"
  local key="$2"
  local value="$3"

  if $DRY_RUN; then
    echo "[DRY]   python3: set $file [\"$key\"] = \"$value\""
    return
  fi

  [[ -f "$file" ]] || { warn "JSON file not found for field rewrite: $file"; return; }

  python3 - "$file" "$key" "$value" <<'PYEOF'
import sys, json
fpath, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
with open(fpath) as f:
    data = json.load(f)
data[key] = value
with open(fpath, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PYEOF
}

# Write a JSON config file; skip if it already exists.
write_json_config() {
  local dest="$1"
  local content="$2"

  if [[ -e "$dest" ]]; then
    skip "Config already exists: $dest"
    return
  fi

  action "write $dest"
  run mkdir -p "$(dirname "$dest")"

  if ! $DRY_RUN; then
    printf '%s\n' "$content" > "$dest"
    COPIED+=("$dest")
  else
    echo "[DRY]   would write:"
    printf '%s\n' "$content" | sed 's/^/          /'
    COPIED+=("$dest (dry-run)")
  fi
}

# ---------------------------------------------------------------------------
# Prerequisite check
# ---------------------------------------------------------------------------
check_prerequisites() {
  log "Checking prerequisites..."

  # Fail if whatsapp-bot@personal is still running
  if systemctl --user is-active --quiet whatsapp-bot@personal 2>/dev/null; then
    error "whatsapp-bot@personal is still running. Stop it first:"
    echo "        systemctl --user stop whatsapp-bot@personal" >&2
    exit 1
  fi

  # Warn (don't fail) for other potentially running instances
  for instance in loops besbot; do
    if systemctl --user is-active --quiet "whatsapp-bot@${instance}" 2>/dev/null; then
      warn "whatsapp-bot@${instance} appears to be running — consider stopping it first"
    fi
  done

  log "Prerequisites OK"
}

# ---------------------------------------------------------------------------
# Instance: Q  (renamed from personal)
# ---------------------------------------------------------------------------
migrate_q() {
  log ""
  log "=== Instance: q (renamed from personal) ==="

  local legacy_config_dir="$HOME/.config/whatsapp-instances/personal"
  local dest_config_dir="$HOME/.config/whatsoup/instances/q"
  local dest_state_dir="$HOME/.local/state/whatsoup/instances/q"

  LEGACY_PATHS_PRESERVED+=("$legacy_config_dir (config+auth for q)")

  # --- Config ---
  if [[ -d "$legacy_config_dir" ]]; then
    # Copy instance.json -> config.json
    if [[ -f "$legacy_config_dir/instance.json" ]]; then
      copy_file "$legacy_config_dir/instance.json" "$dest_config_dir/config.json"
      # Rewrite name field
      if ! $DRY_RUN && [[ -f "$dest_config_dir/config.json" ]]; then
        action "rewrite config.json: name=personal -> name=q"
        rewrite_json_field "$dest_config_dir/config.json" "name" "q"
      elif $DRY_RUN; then
        echo "[DRY]   would rewrite config.json: name=personal -> name=q"
      fi
    else
      warn "instance.json not found in $legacy_config_dir"
    fi

    # Copy auth_info/ -> auth/
    if [[ -d "$legacy_config_dir/auth_info" ]]; then
      copy_dir "$legacy_config_dir/auth_info" "$dest_config_dir/auth"
    else
      warn "auth_info/ not found in $legacy_config_dir"
    fi

    # Copy any remaining files (excluding instance.json and auth_info/)
    while IFS= read -r -d '' f; do
      local rel="${f#$legacy_config_dir/}"
      # Skip items we've already handled
      [[ "$rel" == "instance.json" ]] && continue
      [[ "$rel" == auth_info* ]] && continue
      copy_file "$f" "$dest_config_dir/$rel"
    done < <(find "$legacy_config_dir" -maxdepth 1 -type f -print0)
  else
    warn "Legacy config directory not found: $legacy_config_dir"
  fi

  # --- DB ---
  local db_found=false
  for db_search_dir in \
    "$HOME/.local/share/whatsapp-instances/personal" \
    "$HOME/.config/whatsapp-instances/personal" \
    "$HOME/.local/share/whatsoup/personal"
  do
    if [[ -d "$db_search_dir" ]] && compgen -G "$db_search_dir/bot.db*" > /dev/null 2>&1; then
      log "Found DB in: $db_search_dir"
      LEGACY_PATHS_PRESERVED+=("$db_search_dir (DB for q)")
      copy_db_with_wal "$db_search_dir" "$HOME/.local/share/whatsoup/instances/q"
      db_found=true
      break
    fi
  done
  if ! $db_found; then
    log "No existing DB found for q instance (will be created on first boot)"
  fi

  # --- State ---
  ensure_dir "$dest_state_dir"
}

# ---------------------------------------------------------------------------
# Instance: Loops  (namespace move)
# ---------------------------------------------------------------------------
migrate_loops() {
  log ""
  log "=== Instance: loops (namespace move) ==="

  local legacy_config_dir="$HOME/.config/whatsapp-instances/loops"
  local dest_config_dir="$HOME/.config/whatsoup/instances/loops"
  local dest_state_dir="$HOME/.local/state/whatsoup/instances/loops"

  LEGACY_PATHS_PRESERVED+=("$legacy_config_dir (config+auth for loops)")

  # --- Config ---
  if [[ -d "$legacy_config_dir" ]]; then
    if [[ -f "$legacy_config_dir/instance.json" ]]; then
      copy_file "$legacy_config_dir/instance.json" "$dest_config_dir/config.json"
    else
      warn "instance.json not found in $legacy_config_dir"
    fi

    if [[ -d "$legacy_config_dir/auth_info" ]]; then
      copy_dir "$legacy_config_dir/auth_info" "$dest_config_dir/auth"
    else
      warn "auth_info/ not found in $legacy_config_dir"
    fi

    # Copy remaining top-level files
    while IFS= read -r -d '' f; do
      local rel="${f#$legacy_config_dir/}"
      [[ "$rel" == "instance.json" ]] && continue
      [[ "$rel" == auth_info* ]] && continue
      copy_file "$f" "$dest_config_dir/$rel"
    done < <(find "$legacy_config_dir" -maxdepth 1 -type f -print0)
  else
    warn "Legacy config directory not found: $legacy_config_dir"
  fi

  # --- DB ---
  local legacy_db_dir="$HOME/.local/share/whatsoup/loops"
  if [[ -d "$legacy_db_dir" ]]; then
    LEGACY_PATHS_PRESERVED+=("$legacy_db_dir (DB for loops)")
    copy_db_with_wal "$legacy_db_dir" "$HOME/.local/share/whatsoup/instances/loops"
  else
    log "No existing DB found for loops instance (will be created on first boot)"
  fi

  # --- State ---
  ensure_dir "$dest_state_dir"
}

# ---------------------------------------------------------------------------
# Instance: BES Bot  (namespace move)
# ---------------------------------------------------------------------------
migrate_besbot() {
  log ""
  log "=== Instance: besbot (namespace move) ==="

  local legacy_config_dir="$HOME/.config/whatsapp-instances/besbot"
  local dest_config_dir="$HOME/.config/whatsoup/instances/besbot"
  local dest_state_dir="$HOME/.local/state/whatsoup/instances/besbot"

  LEGACY_PATHS_PRESERVED+=("$legacy_config_dir (config+auth for besbot)")

  # --- Config ---
  if [[ -d "$legacy_config_dir" ]]; then
    if [[ -f "$legacy_config_dir/instance.json" ]]; then
      copy_file "$legacy_config_dir/instance.json" "$dest_config_dir/config.json"
    else
      warn "instance.json not found in $legacy_config_dir"
    fi

    if [[ -d "$legacy_config_dir/auth_info" ]]; then
      copy_dir "$legacy_config_dir/auth_info" "$dest_config_dir/auth"
    else
      warn "auth_info/ not found in $legacy_config_dir"
    fi

    # Copy remaining top-level files
    while IFS= read -r -d '' f; do
      local rel="${f#$legacy_config_dir/}"
      [[ "$rel" == "instance.json" ]] && continue
      [[ "$rel" == auth_info* ]] && continue
      copy_file "$f" "$dest_config_dir/$rel"
    done < <(find "$legacy_config_dir" -maxdepth 1 -type f -print0)
  else
    warn "Legacy config directory not found: $legacy_config_dir"
  fi

  # --- DB ---
  local legacy_db_dir="$HOME/.local/share/whatsoup/besbot"
  if [[ -d "$legacy_db_dir" ]]; then
    LEGACY_PATHS_PRESERVED+=("$legacy_db_dir (DB for besbot)")
    copy_db_with_wal "$legacy_db_dir" "$HOME/.local/share/whatsoup/instances/besbot"
  else
    log "No existing DB found for besbot instance (will be created on first boot)"
  fi

  # --- State ---
  ensure_dir "$dest_state_dir"
}

# ---------------------------------------------------------------------------
# Instance: Personal  (new passive)
# ---------------------------------------------------------------------------
migrate_personal() {
  log ""
  log "=== Instance: personal (new passive) ==="

  local legacy_auth_dir="$HOME/.config/whatsapp-mcp/auth_info"
  local dest_config_dir="$HOME/.config/whatsoup/instances/personal"
  local dest_state_dir="$HOME/.local/state/whatsoup/instances/personal"

  LEGACY_PATHS_PRESERVED+=("$legacy_auth_dir (auth for personal passive)")

  # --- Auth ---
  if [[ -d "$legacy_auth_dir" ]]; then
    if [[ -d "$dest_config_dir/auth" ]]; then
      skip "Auth directory already exists: $dest_config_dir/auth"
    else
      action "cp -rp $legacy_auth_dir/* -> $dest_config_dir/auth/"
      run mkdir -p "$dest_config_dir/auth"

      if ! $DRY_RUN; then
        # Copy contents of auth_info/ (not the dir itself)
        shopt -s dotglob nullglob
        local files=("$legacy_auth_dir"/*)
        shopt -u dotglob nullglob
        if (( ${#files[@]} > 0 )); then
          cp -rp "${files[@]}" "$dest_config_dir/auth/"
          COPIED+=("$dest_config_dir/auth/ (auth files from whatsapp-mcp)")
        else
          warn "auth_info directory is empty: $legacy_auth_dir"
        fi
      else
        COPIED+=("$dest_config_dir/auth/ (dry-run)")
      fi
    fi
  else
    warn "whatsapp-mcp auth_info not found: $legacy_auth_dir (auth QR scan required on first boot)"
  fi

  # --- Config ---
  write_json_config "$dest_config_dir/config.json" '{
  "name": "personal",
  "type": "passive",
  "adminPhones": ["18459780919"],
  "accessMode": "self_only",
  "healthPort": 9094
}'

  # --- DB: fresh on first boot ---
  log "personal: DB will be created fresh on first boot (passive instance)"

  # --- State ---
  ensure_dir "$dest_state_dir"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary() {
  echo ""
  echo "========================================"
  echo "  Migration Summary"
  echo "========================================"

  echo ""
  echo "Legacy paths preserved (NOT deleted):"
  if (( ${#LEGACY_PATHS_PRESERVED[@]} == 0 )); then
    echo "  (none)"
  else
    for p in "${LEGACY_PATHS_PRESERVED[@]}"; do
      echo "  - $p"
    done
  fi

  echo ""
  echo "Operations performed: ${#COPIED[@]}"

  echo ""
  echo "Skipped (already existed): ${#SKIPPED[@]}"
  if (( ${#SKIPPED[@]} > 0 )); then
    for s in "${SKIPPED[@]}"; do
      echo "  - $s"
    done
  fi

  echo ""
  if (( ${#CHECKSUM_MISMATCHES[@]} > 0 )); then
    echo "CHECKSUM MISMATCHES (${#CHECKSUM_MISMATCHES[@]}) — INVESTIGATE BEFORE PROCEEDING:"
    for m in "${CHECKSUM_MISMATCHES[@]}"; do
      echo "  !! $m"
    done
  else
    echo "Checksum verification: OK (no mismatches)"
  fi

  echo ""
  echo "Warnings: $WARNINGS"
  echo "Errors:   $ERRORS"

  if (( ERRORS > 0 )); then
    echo ""
    echo "Migration completed WITH ERRORS. Review output above." >&2
  elif (( WARNINGS > 0 )); then
    echo ""
    echo "Migration completed with warnings. Some source paths were absent"
    echo "(instances may not have been set up yet)."
  else
    echo ""
    echo "Migration completed successfully."
  fi

  if $DRY_RUN; then
    echo ""
    echo "(DRY-RUN — no files were written)"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  if $DRY_RUN; then
    log "*** DRY-RUN MODE — no files will be written ***"
  fi

  check_prerequisites
  migrate_q
  migrate_loops
  migrate_besbot
  migrate_personal
  print_summary

  if (( ERRORS > 0 )); then
    exit 1
  fi
}

main "$@"
