#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$HOME/.local/share/whatsoup"
VENV="$ROOT/transcription-venv"
MODELS="$ROOT/models"
FW_MODEL_DIR="$MODELS/faster-whisper"
WCPP_MODEL_DIR="$MODELS/whisper.cpp"
PYTHON_BIN="/opt/homebrew/bin/python3.12"
FW_VERSION="1.2.1"
HF_VERSION="1.10.2"
CTRANS_VERSION="4.7.1"
EXPECTED_GGML_SMALL_SHA256="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
GGML_SMALL_PATH="$WCPP_MODEL_DIR/ggml-small.bin"
GGML_SMALL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"

sha256_matches() {
  local path="$1"
  local expected="$2"
  [ -f "$path" ] || return 1
  [ "$(shasum -a 256 "$path" | awk '{print $1}')" = "$expected" ]
}

mkdir -p "$FW_MODEL_DIR" "$WCPP_MODEL_DIR"

brew install ffmpeg whisper-cpp python@3.12

if [ ! -d "$VENV" ]; then
  "$PYTHON_BIN" -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install \
  "faster-whisper==$FW_VERSION" \
  "huggingface-hub==$HF_VERSION" \
  "ctranslate2==$CTRANS_VERSION"

if ! sha256_matches "$GGML_SMALL_PATH" "$EXPECTED_GGML_SMALL_SHA256"; then
  rm -f "$GGML_SMALL_PATH"
  curl -L --fail --retry 3 --continue-at - "$GGML_SMALL_URL" -o "$GGML_SMALL_PATH"
fi

if ! sha256_matches "$GGML_SMALL_PATH" "$EXPECTED_GGML_SMALL_SHA256"; then
  rm -f "$GGML_SMALL_PATH"
  echo "Checksum mismatch for $GGML_SMALL_PATH" >&2
  exit 1
fi

echo "Dependencies installed."
