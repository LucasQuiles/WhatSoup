#!/usr/bin/env bash

# Canonical host capability contract shared by doctor, setup, installation, and CI.
# Bash 3.2 compatible: no associative arrays, mapfile, Node, Python, or jq.

whatsoup_normalize_platform() {
  case "$1" in
    Darwin|darwin) printf '%s\n' darwin ;;
    Linux|linux) printf '%s\n' linux ;;
    *) return 2 ;;
  esac
}

whatsoup_normalize_arch() {
  case "$1" in
    arm64|aarch64) printf '%s\n' arm64 ;;
    x86_64|amd64|x64) printf '%s\n' x64 ;;
    *) return 2 ;;
  esac
}

whatsoup_native_arch() {
  platform="$1"
  machine="$(uname -m 2>/dev/null)" || return 2
  if [ "$platform" = "darwin" ]; then
    arm64_capable="$(sysctl -n hw.optional.arm64 2>/dev/null || true)"
    if [ "$arm64_capable" = "1" ]; then
      printf '%s\n' arm64
      return 0
    fi
  fi
  whatsoup_normalize_arch "$machine"
}

whatsoup_pinned_node_version() {
  version="$(tr -d '[:space:]' < "$WHATSOUP_CAPABILITY_ROOT/.nvmrc" 2>/dev/null || true)"
  case "$version" in
    [0-9]*.[0-9]*.[0-9]*) printf '%s\n' "$version" ;;
    *) return 2 ;;
  esac
}

whatsoup_service_path() {
  pinned="$(whatsoup_pinned_node_version 2>/dev/null || true)"
  printf '%s\n' "$HOME/.local/bin"
  [ -n "$pinned" ] && printf '%s\n' "${NVM_DIR:-$HOME/.nvm}/versions/node/v${pinned}/bin"
  printf '%s\n' /usr/local/bin /opt/homebrew/bin /usr/bin /bin /usr/sbin /sbin
}

whatsoup_resolve_executable() {
  executable_name="$1"
  resolved="$(command -v "$executable_name" 2>/dev/null || true)"
  if [ -n "$resolved" ] && [ -x "$resolved" ]; then
    CAP_PATH="$resolved"
    CAP_VISIBILITY=invoking_path
    return 0
  fi

  while IFS= read -r search_dir; do
    [ -n "$search_dir" ] || continue
    if [ -x "$search_dir/$executable_name" ]; then
      CAP_PATH="$search_dir/$executable_name"
      CAP_VISIBILITY=service_path_only
      return 0
    fi
  done <<EOF
$(whatsoup_service_path)
EOF

  CAP_PATH=""
  CAP_VISIBILITY=absent
  return 1
}

whatsoup_capability_records() {
  profile="$1"
  platform="$2"
  node_policy="$3"
  pinned="$(whatsoup_pinned_node_version)" || return 2

  printf 'node\trequired\tnode\t%s:%s\t\t\t\tInstall the .nvmrc-pinned Node with nvm.\n' "$node_policy" "$pinned"
  printf 'npm\trequired\tnpm\tcommand\t\t\t\tInstall npm with the pinned Node distribution.\n'
  printf 'git\trequired\tgit\tcommand\tgit\tgit\tgit\tInstall Git with the platform package manager.\n'
  if [ "$platform" = "darwin" ]; then
    printf 'service_manager\trequired\tlaunchctl\tstructural\t\t\t\tlaunchctl is supplied by macOS.\n'
    printf 'credential_store\toptional\tsecurity\tstructural\t\t\t\tsecurity is supplied by macOS.\n'
  else
    printf 'service_manager\trequired\tsystemctl\tstructural\t\tsystemd\tsystemd\tInstall the systemd user-service tools.\n'
    printf 'credential_store\toptional\tsecret-tool\tstructural\t\tlibsecret-tools\tlibsecret\tInstall the platform credential-store client if required.\n'
  fi

  [ "$profile" = "runtime" ] && return 0

  if [ "$platform" = "darwin" ]; then
    printf 'python\trequired\tpython3.12\tminimum:3.12\tpython@3.12\tpython3 python3-venv\tpython python-pip\tInstall Python 3.12 with venv support.\n'
  else
    printf 'python\trequired\tpython3.12\tminimum:3.12\tpython@3.12\tpython3 python3-venv\tpython python-pip\tInstall Python 3.12 with venv support.\n'
  fi
  printf 'rg\trequired\trg\tcommand\tripgrep\tripgrep\tripgrep\tInstall ripgrep.\n'
  printf 'zsh\trequired\tzsh\tcommand\tzsh\tzsh\tzsh\tInstall zsh.\n'
  printf 'shellcheck\trequired\tshellcheck\tcommand\tshellcheck\tshellcheck\tshellcheck\tInstall ShellCheck.\n'

  [ "$profile" = "quality" ] && return 0

  if [ "$platform" = "darwin" ]; then
    printf 'timeout\trequired\tgtimeout\tgnu-timeout\tcoreutils\tcoreutils\tcoreutils\tInstall GNU coreutils.\n'
    printf 'flock\tnot_applicable\tflock\tlinux-only\t\tutil-linux\tutil-linux\tExternal flock is Linux-only for release proof.\n'
  else
    printf 'timeout\trequired\ttimeout\tgnu-timeout\tcoreutils\tcoreutils\tcoreutils\tInstall GNU coreutils.\n'
    printf 'flock\trequired\tflock\tcommand\t\tutil-linux\tutil-linux\tInstall util-linux for flock.\n'
  fi
}

whatsoup_first_line() {
  "$@" 2>/dev/null | sed -n '1{s/[[:cntrl:]]/ /g;p;}'
}

whatsoup_probe_node() {
  version_rule="$1"
  raw_version="$(whatsoup_first_line "$CAP_PATH" --version)"
  version="${raw_version#v}"
  CAP_VERSION="$version"
  pinned="$(whatsoup_pinned_node_version)" || {
    CAP_STATUS=inconclusive
    CAP_DETAIL=node-pin-unavailable
    return 0
  }

  policy="${version_rule%%:*}"
  if [ "$policy" = "exact" ]; then
    if [ "$version" != "$pinned" ]; then
      CAP_STATUS=incompatible
      CAP_DETAIL=node-version-mismatch
      return 0
    fi
  else
    node_major="${version%%.*}"
    required_major="${pinned%%.*}"
    engine_max="$(sed -n 's/.*< *\([0-9][0-9]*\).*/\1/p' "$WHATSOUP_CAPABILITY_ROOT/package.json" | sed -n '1p')"
    case "$node_major:$required_major:$engine_max" in
      *[!0-9:]*|::*|*::)
        CAP_STATUS=inconclusive
        CAP_DETAIL=node-engine-range-unavailable
        return 0
        ;;
    esac
    if [ "$node_major" -lt "$required_major" ] || [ "$node_major" -ge "$engine_max" ]; then
      CAP_STATUS=incompatible
      CAP_DETAIL=node-version-incompatible
      return 0
    fi
  fi

  native_arch="$(whatsoup_native_arch "$WHATSOUP_CAPABILITY_PLATFORM" 2>/dev/null || true)"
  process_arch="$(whatsoup_first_line "$CAP_PATH" -p 'process.arch')"
  process_arch="$(whatsoup_normalize_arch "$process_arch" 2>/dev/null || true)"
  if [ -z "$native_arch" ] || [ -z "$process_arch" ]; then
    CAP_STATUS=inconclusive
    CAP_DETAIL=node-architecture-unavailable
  elif [ "$native_arch" != "$process_arch" ]; then
    CAP_STATUS=incompatible
    CAP_DETAIL=node-architecture-mismatch
  fi
}

whatsoup_probe_python() {
  raw_version="$(whatsoup_first_line "$CAP_PATH" --version)"
  version="${raw_version#Python }"
  CAP_VERSION="$version"
  major="${version%%.*}"
  remainder="${version#*.}"
  minor="${remainder%%.*}"
  case "$major:$minor" in
    *[!0-9:]*|:|*:) CAP_STATUS=inconclusive; CAP_DETAIL=python-version-unavailable ;;
    *)
      if [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 12 ]; }; then
        CAP_STATUS=incompatible
        CAP_DETAIL=python-version-incompatible
      fi
      ;;
  esac
}

whatsoup_probe_capability() {
  capability_id="$1"
  disposition="$2"
  probe="$3"
  version_rule="$4"

  CAP_STATUS=available
  CAP_VERSION=""
  CAP_PATH=""
  CAP_DETAIL=""
  CAP_VISIBILITY=""

  if [ "$disposition" = "not_applicable" ]; then
    CAP_STATUS=not_applicable
    CAP_DETAIL=platform-not-applicable
    return 0
  fi

  if ! whatsoup_resolve_executable "$probe"; then
    if [ "$disposition" = "optional" ]; then
      CAP_STATUS=optional_missing
    else
      CAP_STATUS=missing
    fi
    CAP_DETAIL=executable-not-found
    return 0
  fi
  if [ "$CAP_VISIBILITY" = "service_path_only" ]; then
    CAP_STATUS=path_hidden
    CAP_DETAIL=not-on-invoking-path
    return 0
  fi

  case "$capability_id" in
    node) whatsoup_probe_node "$version_rule" ;;
    python) whatsoup_probe_python ;;
    npm|git|rg|zsh|shellcheck|timeout)
      CAP_VERSION="$(whatsoup_first_line "$CAP_PATH" --version)"
      ;;
  esac
}

whatsoup_json_escape() {
  escaped="$1"
  escaped="${escaped//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  escaped="${escaped//$'\n'/ }"
  escaped="${escaped//$'\r'/ }"
  escaped="${escaped//$'\t'/ }"
  printf '%s' "$escaped"
}
