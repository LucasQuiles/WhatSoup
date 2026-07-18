#!/usr/bin/env bash

# Source-only wrapper around the authoritative descriptor reader. The directory
# probe gives operators a precise early diagnostic; the TypeScript reader then
# repeats directory validation and performs the authoritative no-follow open,
# descriptor metadata checks, identity checks, and bounded read.
whatsoup_read_private_health_token() {
  if [ "$#" -ne 3 ]; then
    echo "FATAL: private health token reader received invalid arguments" >&2
    return 1
  fi

  local node="$1"
  local reader="$2"
  local token_file="$3"
  local token_dir=""
  local expected_uid="$EUID"
  local dir_uid=""
  local dir_mode=""
  local dir_mode_value=0

  token_dir="$(dirname "$token_file")"
  if [ -L "$token_dir" ] || [ ! -d "$token_dir" ]; then
    echo "FATAL: health token directory must be a real non-symlink directory" >&2
    return 1
  fi

  case "$(uname -s)" in
    Darwin)
      if ! dir_uid="$(stat -f '%u' -- "$token_dir" 2>/dev/null)" ||
         ! dir_mode="$(stat -f '%Lp' -- "$token_dir" 2>/dev/null)"; then
        echo "FATAL: unable to inspect health token directory metadata" >&2
        return 1
      fi
      ;;
    *)
      if ! dir_uid="$(stat -c '%u' -- "$token_dir" 2>/dev/null)" ||
         ! dir_mode="$(stat -c '%a' -- "$token_dir" 2>/dev/null)"; then
        echo "FATAL: unable to inspect health token directory metadata" >&2
        return 1
      fi
      ;;
  esac

  if [ "$dir_uid" != "$expected_uid" ]; then
    echo "FATAL: health token directory must be owned by the current uid" >&2
    return 1
  fi
  if ! [[ "$dir_mode" =~ ^[0-7]{3,4}$ ]]; then
    echo "FATAL: health token directory permissions cannot be validated" >&2
    return 1
  fi
  dir_mode_value=$((8#$dir_mode))
  if (( (dir_mode_value & 8#22) != 0 )); then
    echo "FATAL: health token directory must not be group- or world-writable" >&2
    return 1
  fi

  printf '%s\0' "$token_file" |
    "$node" --experimental-strip-types "$reader"
}
