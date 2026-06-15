set -u
D=deploy/scripts/whatsoup-bot-errors-deploy.sh
tmp=$(mktemp -d)
cat > "$tmp/manifest.json" <<JSON
{"schemaVersion":1,"files":[{"path":"deploy/scripts/lib/bot_errors_redaction.py","sha256":"1448da21ae9b598d4cafb342fc1c7aa042141ec3db7fee11c8ff1368cf94812f"}]}
JSON
echo '{"approved_f10":[]}' > "$tmp/ledger.json"
bash "$D" pin "$tmp/manifest.json" "$tmp/ledger.json" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef > "$tmp/out.log" 2>&1
rc=$?
echo "rc=$rc"; cat "$tmp/out.log"
head=$(python3 -c "import json;print(json.load(open('$tmp/manifest.json')).get('expected_head_sha'))")
led=$(python3 -c "import json;print('1448da21ae9b598d4cafb342fc1c7aa042141ec3db7fee11c8ff1368cf94812f' in json.load(open('$tmp/ledger.json'))['approved_f10'])")
# idempotency: running pin twice must not duplicate the ledger entry
bash "$D" pin "$tmp/manifest.json" "$tmp/ledger.json" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef >> "$tmp/out.log" 2>&1
count=$(python3 -c "import json;a=json.load(open('$tmp/ledger.json'))['approved_f10'];print(a.count('1448da21ae9b598d4cafb342fc1c7aa042141ec3db7fee11c8ff1368cf94812f'))")
rm -rf "$tmp"
if [ "$rc" = 0 ] && [ "$head" = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" ] && [ "$led" = "True" ] && [ "$count" = 1 ]; then echo "PIN_TEST_PASS"; else echo "PIN_TEST_FAIL rc=$rc head=$head led=$led count=$count"; fi
