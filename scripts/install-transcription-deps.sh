#!/usr/bin/env bash
set -euo pipefail

# Installs the transcription toolchain (ffmpeg, whisper.cpp, a pinned Python
# venv, and the ggml-small model) on both first-class platforms.
#
# #2256: this script previously assumed macOS-on-Apple-Silicon Homebrew in four
# places and aborted on Linux under `set -e` — a hardcoded
# /opt/homebrew/bin/python3.12, an unconditional `brew install`, and `shasum`,
# which is a Perl utility absent from minimal Linux images. The project targets
# Linux (systemd), macOS (launchd) and Docker as first-class platforms and CI
# runs on both ubuntu-latest and macos-14.
#
# Tool lookup follows the patterns already used in this repo rather than new
# machinery: the candidate-loop + `command -v` shape from
# scripts/run-tokenomics-pytests.sh, and the dual-tool checksum helper from
# deploy/scripts/whatsoup-bot-errors-deploy.sh.

# Best-effort: Homebrew's bin dirs are not on a non-login shell's PATH on macOS.
# Only prepend what actually exists, so this is a genuine no-op elsewhere rather
# than a platform assumption baked into PATH.
for brew_bin in /opt/homebrew/bin /usr/local/bin; do
  [ -d "$brew_bin" ] && PATH="$brew_bin:$PATH"
done
export PATH

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/lib/python-lock-policy.sh
. "$REPO_ROOT/deploy/lib/python-lock-policy.sh"
# shellcheck source=deploy/lib/bounded-exec.sh
. "$REPO_ROOT/deploy/lib/bounded-exec.sh"

ROOT="$HOME/.local/share/whatsoup"
VENV="$ROOT/transcription-venv"
MODELS="$ROOT/models"
FW_MODEL_DIR="$MODELS/faster-whisper"
FW_MODEL_NAME="large-v3-turbo"
FW_MODEL_REVISION="0c94664816ec82be77b20e824c8e8675995b0029"
FW_MODEL_PATH="$FW_MODEL_DIR/$FW_MODEL_NAME-$FW_MODEL_REVISION"
FW_MODEL_BASE_URL="https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo/resolve/$FW_MODEL_REVISION"
FW_MODEL_MAX_FILESIZE=2147483648
FW_MODEL_FILE_BLOCKS=4194304
WCPP_MODEL_DIR="$MODELS/whisper.cpp"
FW_VERSION="1.2.1"
HF_VERSION="1.10.2"
CTRANS_VERSION="4.7.1"
EXPECTED_GGML_SMALL_SHA256="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
GGML_SMALL_PATH="$WCPP_MODEL_DIR/ggml-small.bin"
GGML_SMALL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"

# sha256 via whichever tool the platform ships: `shasum` (macOS, Perl) or
# `sha256sum` (GNU coreutils). Same shape as sha() in
# deploy/scripts/whatsoup-bot-errors-deploy.sh. Fails closed — a missing tool or
# a failed hash returns non-zero rather than comparing an empty string, which
# would make every checksum "mismatch" and silently re-download forever.
sha256_of() {
  local path="$1" out rc
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$path" 2>/dev/null)"; rc=$?
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$path" 2>/dev/null)"; rc=$?
  else
    echo "Neither sha256sum nor shasum is available; cannot verify model integrity" >&2
    return 1
  fi
  if [ $rc -ne 0 ] || [ -z "$out" ]; then return 1; fi
  printf '%s\n' "${out%% *}"
}

sha256_matches() {
  local path="$1" expected="$2" actual
  [ -f "$path" ] || return 1
  actual="$(sha256_of "$path")" || return 1
  [ "$actual" = "$expected" ]
}

install_transcription_requirements() {
  whatsoup_run_bounded "${WHATSOUP_PIP_INSTALL_TIMEOUT:-600}" \
    whatsoup_install_locked_requirements "$VENV/bin/python" "$REPO_ROOT" transcription
}

download_ggml_model() {
  (
    # A kernel limit also bounds downloads with an absent or misleading length.
    # Bash uses at most 1024-byte blocks here, giving a hard ceiling of 1 GiB.
    ulimit -f 1048576 || exit 1
    whatsoup_run_bounded "${WHATSOUP_MODEL_DOWNLOAD_TIMEOUT:-600}" \
      curl --disable --location --fail --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 600 --max-redirs 3 --max-filesize 536870912 \
      "$GGML_SMALL_URL" --output "$GGML_SMALL_PATH"
  )
}

download_faster_whisper_file() {
  local destination="$1" expected="$2" url="$3" pending
  if [ -L "$destination" ] || { [ -e "$destination" ] && [ ! -f "$destination" ]; }; then
    echo "Refusing unsafe faster-whisper destination $destination" >&2
    return 1
  fi
  if sha256_matches "$destination" "$expected"; then return 0; fi
  pending="$(mktemp "${destination}.pending.XXXXXX")" || return 1
  echo "Faster-whisper replacement retained at $pending; retire only after consumer verification" >&2
  (
    # ulimit units vary by host; this admits the 1.62 GB artifact while curl caps declared transfers at 2 GB.
    ulimit -f "$FW_MODEL_FILE_BLOCKS" || exit 1
    whatsoup_run_bounded "${WHATSOUP_MODEL_DOWNLOAD_TIMEOUT:-900}" \
      curl --disable --location --fail --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 900 --max-redirs 3 --max-filesize "$FW_MODEL_MAX_FILESIZE" \
      "$url" --output "$pending"
  ) || return $?
  if ! sha256_matches "$pending" "$expected"; then
    echo "Checksum mismatch for $pending" >&2
    return 1
  fi
  mv "$pending" "$destination"
}

publish_faster_whisper_model() {
  whatsoup_run_bounded "${WHATSOUP_PYTHON_PROBE_TIMEOUT:-5}" "$VENV/bin/python" -I -c '
import ctypes
import os
import sys

source, destination = map(os.fsencode, sys.argv[1:])
libc = ctypes.CDLL(None, use_errno=True)
if sys.platform == "darwin":
    rename = libc.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    arguments = (source, destination, 4)  # RENAME_EXCL
elif sys.platform == "linux":
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    arguments = (-100, source, -100, destination, 1)  # AT_FDCWD, RENAME_NOREPLACE
else:
    raise RuntimeError("exclusive model publication is unsupported on this platform")
rename.restype = ctypes.c_int
if rename(*arguments) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), os.fsdecode(destination))
' "$1" "$2"
}

install_faster_whisper_model() {
  (
    local destination="$1" base_url="$2" entry name digest stage lock
    shift 2
    [ "$#" -gt 0 ] || return 1
    for entry in "$@"; do
      name="${entry%% *}"
      digest="${entry#* }"
      case "$name" in ''|.*|*/*) echo "Unsafe faster-whisper manifest path $name" >&2; return 1 ;; esac
      if [ "${#digest}" -ne 64 ] || [[ "$digest" =~ [^0-9a-f] ]]; then return 1; fi
    done
    if [ -L "$destination" ] || { [ -e "$destination" ] && [ ! -d "$destination" ]; }; then
      echo "Refusing unsafe faster-whisper model destination $destination" >&2
      return 1
    fi
    if [ -d "$destination" ]; then
      for entry in "$@"; do
        name="${entry%% *}"
        digest="${entry#* }"
        if [ -L "$destination/$name" ] || ! sha256_matches "$destination/$name" "$digest"; then
          echo "Refusing unverified faster-whisper model at $destination" >&2
          return 1
        fi
      done
      return 0
    fi
    lock="${destination}.install.lock"
    if ! mkdir "$lock"; then
      echo "Faster-whisper model installation already in progress: $destination" >&2
      return 1
    fi
    FW_INSTALL_LOCK="$lock"
    trap 'result=$?; trap - EXIT; rmdir "$FW_INSTALL_LOCK" || result=1; exit "$result"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      echo "Faster-whisper model destination appeared while locking: $destination" >&2
      return 1
    fi
    stage="$(mktemp -d "${destination}.pending.XXXXXX")" || return 1
    echo "Faster-whisper model replacement retained at $stage; retire only after consumer verification" >&2
    for entry in "$@"; do
      name="${entry%% *}"
      digest="${entry#* }"
      download_faster_whisper_file "$stage/$name" "$digest" "$base_url/$name" || return $?
    done
    publish_faster_whisper_model "$stage" "$destination"
  )
}

finish_transcription_environment() {
  local model_stage
  if [ -L "$GGML_SMALL_PATH" ] || { [ -e "$GGML_SMALL_PATH" ] && [ ! -f "$GGML_SMALL_PATH" ]; }; then
    echo "Refusing unsafe model destination $GGML_SMALL_PATH" >&2
    return 1
  fi
  install_transcription_requirements || return $?
  whatsoup_run_bounded "${WHATSOUP_PYTHON_PROBE_TIMEOUT:-5}" \
    "$VENV/bin/python" -I -c 'import av, ctranslate2, faster_whisper, huggingface_hub' || return $?
  install_faster_whisper_model "$FW_MODEL_PATH" "$FW_MODEL_BASE_URL" \
    "config.json b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e" \
    "model.bin e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da" \
    "preprocessor_config.json 7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711" \
    "tokenizer.json 297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd" \
    "vocabulary.json c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1" || return $?
  if ! sha256_matches "$GGML_SMALL_PATH" "$EXPECTED_GGML_SMALL_SHA256"; then
    model_stage="$(mktemp -d "${GGML_SMALL_PATH}.pending.XXXXXX")" || return 1
    echo "Model replacement retained at $model_stage; retire only after consumer verification" >&2
    GGML_SMALL_PATH="$model_stage/model" download_ggml_model || return $?
    if ! sha256_matches "$model_stage/model" "$EXPECTED_GGML_SMALL_SHA256"; then
      echo "Checksum mismatch for $model_stage/model" >&2
      return 1
    fi
    if [ -e "$GGML_SMALL_PATH" ] || [ -L "$GGML_SMALL_PATH" ]; then
      [ ! -L "$GGML_SMALL_PATH" ] || return 1
      [ -f "$GGML_SMALL_PATH" ] || return 1
      cp -p "$GGML_SMALL_PATH" "$model_stage/previous-model" || return $?
    fi
    whatsoup_run_bounded "${WHATSOUP_PYTHON_PROBE_TIMEOUT:-5}" \
      "$VENV/bin/python" -I -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' \
      "$model_stage/model" "$GGML_SMALL_PATH" || return $?
  fi
}

# Resolve a Python that can build the venv. Candidate loop rather than a
# hardcoded path so this works on Linux, Intel macOS, and Apple Silicon without
# requiring the python@3.13 formula to live at one specific prefix. The lock
# policy qualifies both implementation and patch version before the candidate
# can create or reuse the managed venv.
resolve_python() {
  local candidates=() candidate
  [ -n "${WHATSOUP_TRANSCRIPTION_PYTHON:-}" ] && candidates+=("$WHATSOUP_TRANSCRIPTION_PYTHON")
  candidates+=(python3.13 python3)
  for candidate in "${candidates[@]}"; do
    if command -v "$candidate" >/dev/null 2>&1 \
      && whatsoup_run_bounded "${WHATSOUP_PYTHON_PROBE_TIMEOUT:-5}" "$candidate" -I -c 'import venv' >/dev/null 2>&1 \
      && whatsoup_require_locked_python "$candidate"; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

mkdir -p "$FW_MODEL_DIR" "$WCPP_MODEL_DIR"

# Homebrew installs the system deps on macOS. Everywhere else, verify they are
# present and say exactly what is missing — previously `brew install` simply
# died under `set -e` with "command not found", which tells a Linux operator
# nothing about what to install.
if command -v brew >/dev/null 2>&1; then
  whatsoup_run_bounded "${WHATSOUP_PKG_INSTALL_TIMEOUT:-600}" \
    brew install ffmpeg whisper-cpp python@3.13
else
  missing=()
  command -v ffmpeg >/dev/null 2>&1 || missing+=("ffmpeg")
  # whisper.cpp ships its CLI under either name depending on version/packaging.
  command -v whisper-cli >/dev/null 2>&1 || command -v whisper-cpp >/dev/null 2>&1 \
    || missing+=("whisper-cpp (whisper-cli)")
  resolve_python >/dev/null || missing+=("CPython 3.13.16 with venv")
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Homebrew is not available and these dependencies are missing: ${missing[*]}" >&2
    echo "Install them with your platform's package manager, for example:" >&2
    echo "  Debian/Ubuntu: sudo apt-get install -y ffmpeg python3.13 python3.13-venv" >&2
    echo "  Alpine:        sudo apk add ffmpeg python3" >&2
    echo "whisper.cpp is not packaged on most distros — build it from source:" >&2
    echo "  https://github.com/ggerganov/whisper.cpp#quick-start" >&2
    echo "Override the interpreter with WHATSOUP_TRANSCRIPTION_PYTHON if needed." >&2
    exit 1
  fi
fi

if ! PYTHON_BIN="$(resolve_python)"; then
  echo "No usable CPython $WHATSOUP_LOCKED_PYTHON_VERSION found (tried \$WHATSOUP_TRANSCRIPTION_PYTHON, python3.13, python3)" >&2
  exit 1
fi

whatsoup_create_managed_venv "$PYTHON_BIN" "$VENV" finish_transcription_environment

echo "Dependencies installed."
