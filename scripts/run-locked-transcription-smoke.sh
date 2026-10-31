#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/deploy/lib/python-lock-policy.sh"
. "$REPO_ROOT/deploy/lib/bounded-exec.sh"

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <locked-venv-python> <dedicated-model-fixture-directory>" >&2
  exit 2
fi
PYTHON_BIN="$1"
MODEL_DIR="$2"
whatsoup_require_locked_python "$PYTHON_BIN"
"$PYTHON_BIN" -I -c 'import av, ctranslate2, faster_whisper, huggingface_hub'
command -v ffmpeg >/dev/null
mkdir -p "$MODEL_DIR"
MODEL_DIR="$(cd "$MODEL_DIR" && pwd)"
MODEL_REVISION=0d3d19a32d3338f10357c0889762bd8d64bbdeba

matches_hash() {
  "$PYTHON_BIN" -I -c 'import hashlib, pathlib, sys; p=pathlib.Path(sys.argv[1]); sys.exit(0 if p.is_file() and hashlib.file_digest(p.open("rb"), "sha256").hexdigest() == sys.argv[2] else 1)' "$1" "$2"
}

while read -r name digest; do
  destination="$MODEL_DIR/$name"
  if matches_hash "$destination" "$digest"; then continue; fi
  partial="$(mktemp "$MODEL_DIR/.download.XXXXXX")"
  trap 'rm -f "$partial"' EXIT
  (
    ulimit -f 131072
    whatsoup_run_bounded 150 curl --disable --fail --silent --show-error --location \
      --proto '=https' --proto-redir '=https' --connect-timeout 15 \
      --max-time 120 --max-redirs 3 --max-filesize 100000000 \
      "https://huggingface.co/Systran/faster-whisper-tiny.en/resolve/$MODEL_REVISION/$name" \
      --output "$partial"
  )
  matches_hash "$partial" "$digest"
  mv "$partial" "$destination"
  trap - EXIT
done <<'MODEL_FILES'
config.json 14b1b421a90349bc551b881461426b561a874049cb9e4c4864f2ca384f6a7cc5
tokenizer.json 929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df
vocabulary.txt ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf
model.bin 1a5afae06a4db91c975c9a9d78be5cc110ee4ea022ad57d55492e4550e936b2a
MODEL_FILES

cd "$REPO_ROOT"
export WHATSOUP_REQUIRE_LOCKED_TRANSCRIPTION=1
export WHATSOUP_FASTER_WHISPER_PYTHON="$PYTHON_BIN"
export WHATSOUP_FASTER_WHISPER_MODEL="$MODEL_DIR"
export HF_HUB_OFFLINE=1
exec bash scripts/run-with-pinned-node.sh node_modules/vitest/vitest.mjs run \
  --pool=forks tests/runtimes/chat/providers/transcription-integration.test.ts
