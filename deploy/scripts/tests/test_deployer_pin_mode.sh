#!/usr/bin/env bash
set -euo pipefail
D=deploy/scripts/whatsoup-bot-errors-deploy.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/manifest.json" <<JSON
{"schemaVersion":1,"files":[{"path":"deploy/scripts/lib/bot_errors_redaction.py","sha256":"1448da21ae9b598d4cafb342fc1c7aa042141ec3db7fee11c8ff1368cf94812f"}]}
JSON
echo '{"approved_f10":[]}' > "$tmp/ledger.json"
bash "$D" pin "$tmp/manifest.json" "$tmp/ledger.json" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef > "$tmp/out.log" 2>&1
echo "rc=0"; cat "$tmp/out.log"
head=$(python3 -c "import json;print(json.load(open('$tmp/manifest.json')).get('expected_head_sha'))")
led=$(python3 -c "import json;print('1448da21ae9b598d4cafb342fc1c7aa042141ec3db7fee11c8ff1368cf94812f' in json.load(open('$tmp/ledger.json'))['approved_f10'])")
# idempotency: running pin twice must not duplicate the ledger entry
bash "$D" pin "$tmp/manifest.json" "$tmp/ledger.json" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef >> "$tmp/out.log" 2>&1
count=$(python3 -c "import json;a=json.load(open('$tmp/ledger.json'))['approved_f10'];print(a.count('1448da21ae9b598d4cafb342fc1c7aa042141ec3db7fee11c8ff1368cf94812f'))")
cat > "$tmp/spoof-manifest.json" <<JSON
{"schemaVersion":1,"files":[{"path":"evil/lib/bot_errors_redaction.py","sha256":"1448da21ae9b598d4cafb342fc1c7aa042141ec3db7fee11c8ff1368cf94812f"}]}
JSON
if bash "$D" pin "$tmp/spoof-manifest.json" "$tmp/ledger.json" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef > "$tmp/spoof.log" 2>&1; then
  echo "PIN_TEST_FAIL accepted spoofed F10 path"; cat "$tmp/spoof.log"; exit 1
fi
if bash "$D" pin "$tmp/manifest.json" "$tmp/ledger.json" not-a-sha > "$tmp/bad-head.log" 2>&1; then
  echo "PIN_TEST_FAIL accepted invalid head"; cat "$tmp/bad-head.log"; exit 1
fi
cat > "$tmp/partial-manifest.json" <<JSON
{"schemaVersion":1,"files":[{"path":"deploy/scripts/lib/bot_errors_redaction.py","sha256":"1448da21ae9b598d4cafb342fc1c7aa042141ec3db7fee11c8ff1368cf94812f"}]}
JSON
echo '{"approved_f10":"not-a-list"}' > "$tmp/bad-ledger.json"
if bash "$D" pin "$tmp/partial-manifest.json" "$tmp/bad-ledger.json" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef > "$tmp/bad-ledger.log" 2>&1; then
  echo "PIN_TEST_FAIL accepted malformed ledger"; cat "$tmp/bad-ledger.log"; exit 1
fi
partial_head=$(python3 -c "import json;print(json.load(open('$tmp/partial-manifest.json')).get('expected_head_sha'))")
if [ "$partial_head" != "None" ]; then
  echo "PIN_TEST_FAIL partial manifest was stamped before ledger validation"; cat "$tmp/bad-ledger.log"; exit 1
fi
if [ "$head" = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" ] && [ "$led" = "True" ] && [ "$count" = 1 ]; then
  echo "PIN_TEST_PASS"
else
  echo "PIN_TEST_FAIL head=$head led=$led count=$count"; exit 1
fi
