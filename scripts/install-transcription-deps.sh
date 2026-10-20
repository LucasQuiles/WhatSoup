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

whatsoup_create_managed_venv "$PYTHON_BIN" "$VENV"

install_transcription_requirements

if ! sha256_matches "$GGML_SMALL_PATH" "$EXPECTED_GGML_SMALL_SHA256"; then
  rm -f "$GGML_SMALL_PATH"
  download_ggml_model
fi

if ! sha256_matches "$GGML_SMALL_PATH" "$EXPECTED_GGML_SMALL_SHA256"; then
  rm -f "$GGML_SMALL_PATH"
  echo "Checksum mismatch for $GGML_SMALL_PATH" >&2
  exit 1
fi

echo "Dependencies installed."
