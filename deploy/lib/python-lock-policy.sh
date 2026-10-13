#!/usr/bin/env bash

# The Python package locks are qualified for this exact CPython release. Package
# managers may install a newer or older patch, so callers must verify before a
# lock is used rather than treating a minor-version command name as proof.
WHATSOUP_LOCKED_PYTHON_IMPLEMENTATION=cpython
WHATSOUP_LOCKED_PYTHON_VERSION=3.13.16
WHATSOUP_PYTHON_INDEX_URL=https://pypi.org/simple

whatsoup_require_locked_python() {
  local python_bin="$1" observed
  observed="$($python_bin -c 'import sys; print(f"{sys.implementation.name}|{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")' 2>/dev/null)" || {
    echo "Python lock policy: could not query $python_bin" >&2
    return 1
  }
  if [ "$observed" != "$WHATSOUP_LOCKED_PYTHON_IMPLEMENTATION|$WHATSOUP_LOCKED_PYTHON_VERSION" ]; then
    echo "Python lock policy: CPython $WHATSOUP_LOCKED_PYTHON_VERSION is required; found ${observed:-unknown}" >&2
    return 1
  fi
}

whatsoup_python_lock_target() {
  local platform arch arm64_capable
  platform="$(uname -s 2>/dev/null)" || return 1
  case "$platform" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *) echo "Python lock policy: unsupported platform $platform" >&2; return 1 ;;
  esac

  arch="$(uname -m 2>/dev/null)" || return 1
  if [ "$platform" = darwin ] && command -v sysctl >/dev/null 2>&1; then
    arm64_capable="$(sysctl -n hw.optional.arm64 2>/dev/null || true)"
    [ "$arm64_capable" != 1 ] || arch=arm64
  fi
  case "$arch" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64|x64) arch=x64 ;;
    *) echo "Python lock policy: unsupported architecture $arch" >&2; return 1 ;;
  esac
  printf '%s-%s\n' "$platform" "$arch"
}

whatsoup_python_lock_path() {
  local root="$1" profile="$2" target
  target="$(whatsoup_python_lock_target)" || return 1
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

whatsoup_install_locked_requirements() {
  local python_bin="$1" root="$2" profile="$3" lock_path
  whatsoup_require_locked_python "$python_bin" || return 1
  lock_path="$(whatsoup_python_lock_path "$root" "$profile")" || return 1
  if [ ! -f "$lock_path" ]; then
    echo "Python lock policy: missing declared lock $lock_path" >&2
    return 1
  fi
  "$python_bin" -m pip install --disable-pip-version-check --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r "$lock_path"
}
