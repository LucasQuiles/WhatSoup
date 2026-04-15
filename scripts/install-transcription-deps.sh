#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$HOME/.local/share/whatsoup"
VENV="$ROOT/transcription-venv"
MODELS="$ROOT/models"
FW_MODEL_DIR="$MODELS/faster-whisper"
WCPP_MODEL_DIR="$MODELS/whisper.cpp"
PYTHON_BIN="/opt/homebrew/bin/python3.12"

mkdir -p "$FW_MODEL_DIR" "$WCPP_MODEL_DIR"

brew install ffmpeg whisper-cpp python@3.12

if [ ! -d "$VENV" ]; then
  "$PYTHON_BIN" -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install faster-whisper huggingface-hub

if [ ! -f "$WCPP_MODEL_DIR/ggml-small.bin" ]; then
  curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin -o "$WCPP_MODEL_DIR/ggml-small.bin"
fi

echo "Dependencies installed."
