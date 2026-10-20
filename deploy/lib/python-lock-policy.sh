#!/usr/bin/env bash

# The Python package locks are qualified for this exact CPython release. Package
# managers may install a newer or older patch, so callers must verify before a
# lock is used rather than treating a minor-version command name as proof.
. "${BASH_SOURCE[0]%/*}/bounded-exec.sh"

WHATSOUP_LOCKED_PYTHON_IMPLEMENTATION=cpython
WHATSOUP_LOCKED_PYTHON_VERSION=3.13.16
WHATSOUP_PYTHON_INDEX_URL=https://pypi.org/simple

whatsoup_require_locked_python() {
  local python_bin="$1" observed
  observed="$(whatsoup_run_bounded "${WHATSOUP_PYTHON_PROBE_TIMEOUT:-5}" "$python_bin" -I -c 'import sys; print(f"{sys.implementation.name}:{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")' 2>/dev/null)" || {
    echo "Python lock policy: could not query $python_bin" >&2
    return 1
  }
  if [ "$observed" != "$WHATSOUP_LOCKED_PYTHON_IMPLEMENTATION:$WHATSOUP_LOCKED_PYTHON_VERSION" ]; then
    echo "Python lock policy: CPython $WHATSOUP_LOCKED_PYTHON_VERSION is required; found ${observed:-unknown}" >&2
    return 1
  fi
}

whatsoup_python_lock_target() {
  local python_bin="$1" platform arch
  platform="$(uname -s 2>/dev/null)" || return 1
  case "$platform" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *) echo "Python lock policy: unsupported platform $platform" >&2; return 1 ;;
  esac

  arch="$(whatsoup_run_bounded "${WHATSOUP_PYTHON_PROBE_TIMEOUT:-5}" "$python_bin" -I -c 'import platform; print(platform.machine())' 2>/dev/null)" || {
    echo "Python lock policy: could not query interpreter architecture for $python_bin" >&2
    return 1
  }
  case "$arch" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64|x64) arch=x64 ;;
    *) echo "Python lock policy: unsupported architecture $arch" >&2; return 1 ;;
  esac
  printf '%s-%s\n' "$platform" "$arch"
}

whatsoup_python_lock_path() {
  local root="$1" profile="$2" python_bin="$3" target
  target="$(whatsoup_python_lock_target "$python_bin")" || return 1
  case "$profile:$target" in
    quality:linux-x64) printf '%s\n' "$root/requirements/python/quality-cpython313-linux-x64.txt" ;;
    quality:linux-arm64) printf '%s\n' "$root/requirements/python/quality-cpython313-linux-arm64.txt" ;;
    quality:darwin-x64) printf '%s\n' "$root/requirements/python/quality-cpython313-darwin-x64.txt" ;;
    quality:darwin-arm64) printf '%s\n' "$root/requirements/python/quality-cpython313-darwin-arm64.txt" ;;
    transcription:linux-x64) printf '%s\n' "$root/requirements/python/transcription-cpython313-linux-x64.txt" ;;
    transcription:linux-arm64) printf '%s\n' "$root/requirements/python/transcription-cpython313-linux-arm64.txt" ;;
    transcription:darwin-x64) printf '%s\n' "$root/requirements/python/transcription-cpython313-darwin-x64.txt" ;;
    transcription:darwin-arm64) printf '%s\n' "$root/requirements/python/transcription-cpython313-darwin-arm64.txt" ;;
    *) echo "Python lock policy: unsupported lock profile/target $profile/$target" >&2; return 1 ;;
  esac
}


whatsoup_create_managed_venv() {
  local python_bin="$1" venv_root="$2" backup="" result=0
  if [ -L "$venv_root" ] || { [ -e "$venv_root" ] && { [ ! -d "$venv_root" ] || [ ! -f "$venv_root/pyvenv.cfg" ] || [ -L "$venv_root/pyvenv.cfg" ]; }; }; then
    echo "Python lock policy: refusing unrecognized managed environment $venv_root" >&2
    return 1
  fi
  whatsoup_require_locked_python "$python_bin" || return 1
  mkdir -p "$(dirname "$venv_root")" || return 1
  if [ -d "$venv_root" ]; then
    backup="$(mktemp -d "${venv_root}.previous.XXXXXX")" || return 1
    mv "$venv_root" "$backup/environment" || return 1
    echo "Python lock policy: previous environment retained at $backup/environment; retire only after installation and consumer verification" >&2
  fi
  "$python_bin" -I -m venv "$venv_root" || result=$?
  if [ "$result" -eq 0 ]; then
    chmod 700 "$venv_root" || result=$?
  fi
  if [ "$result" -ne 0 ] && [ -n "$backup" ]; then
    if [ -e "$venv_root" ] || [ -L "$venv_root" ]; then
      mv "$venv_root" "$backup/failed-environment" || return 1
    fi
    mv "$backup/environment" "$venv_root" || return 1
    echo "Python lock policy: restored previous environment; failed creation retained at $backup" >&2
  fi
  return "$result"
}

whatsoup_install_locked_requirements() {
  local python_bin="$1" root="$2" profile="$3" lock_path
  whatsoup_require_locked_python "$python_bin" || return 1
  lock_path="$(whatsoup_python_lock_path "$root" "$profile" "$python_bin")" || return 1
  if [ ! -f "$lock_path" ]; then
    echo "Python lock policy: missing declared lock $lock_path" >&2
    return 1
  fi
  PIP_CONFIG_FILE=/dev/null "$python_bin" -I -m pip --isolated install --disable-pip-version-check --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r "$lock_path"
}
