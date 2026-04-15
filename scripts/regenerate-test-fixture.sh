#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

OUT="tests/fixtures/audio/hello.ogg"
TMP_AIFF="/tmp/whatsoup-fixture.aiff"

command -v say >/dev/null
command -v ffmpeg >/dev/null
mkdir -p "$(dirname "$OUT")"

say -o "$TMP_AIFF" "hello this is a test"
ffmpeg -hide_banner -loglevel error -y -i "$TMP_AIFF" -c:a libopus -b:a 16k "$OUT"
rm -f "$TMP_AIFF"

echo "Wrote $OUT"
