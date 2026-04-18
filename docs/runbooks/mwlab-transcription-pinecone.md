# mwlab Transcription and Pinecone Setup

## Pinecone key in the dedicated keychain

Store or update the Pinecone key in the mwlab dedicated keychain:

```bash
security add-generic-password -U \
  -k ~/.config/mwlab-secrets.keychain-db \
  -a mw \
  -s pinecone \
  -w 'pcsk_...'
```

Verify wrapper injection without printing the secret:

```bash
~/.local/bin/with-pinecone-env python3 - <<'PY'
import os
print('PINECONE_ENV_OK' if os.environ.get('PINECONE_API_KEY') else 'PINECONE_ENV_MISSING')
PY
```

## Launch agent wrapper

Keep `/Users/mw/.local/bin/with-pinecone-env` as the first `ProgramArguments` entry in `~/Library/LaunchAgents/com.whatsoup.mw-bot.plist`.

Reload after edits:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.whatsoup.mw-bot.plist >/dev/null 2>&1 || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.whatsoup.mw-bot.plist
```

## Instance config

`~/.config/whatsoup/instances/mw-bot/config.json` should keep:

```json
"pineconeIndex": "mw-mind"
```

Leave `pineconeAllowedIndexes` absent until `mw-mind` has a defined schema and should be exposed through `knowledge_search`.

## Local transcription bootstrap

Run from the deployment worktree:

```bash
cd ~/LAB/WhatSoup/.worktrees/docker
bash scripts/install-transcription-deps.sh
```

This installs:
- Homebrew `ffmpeg`
- Homebrew `whisper-cpp`
- Homebrew `python@3.12`
- dedicated venv at `~/.local/share/whatsoup/transcription-venv`
- faster-whisper cache under `~/.local/share/whatsoup/models/faster-whisper`
- whisper.cpp model at `~/.local/share/whatsoup/models/whisper.cpp/ggml-small.bin`

## `backfill-enrichment --strict` (P3.6-H2) operator guide

Operator-invoked retroactive enrichment of messages with `enrichment_processed_at IS NULL`. Preferred invocation:

```bash
npx tsx scripts/backfill-enrichment.ts --strict --provider {anthropic|openai} --run-id <id>
```

### What `--strict` changes

Flips the backfill into fail-closed mode. If `extractFacts()` or `validateFacts()` raises an `ExtractionError` / `ValidationError`, the script:

- Does **not** call `markMessagesProcessed` for the affected batch (messages stay retry-eligible)
- Records the failure in `BackfillSummary.failedBatches[]` with fields `{chatJid, messageIds, errorType, stage, details}`
- Writes `backfill_strict_fail_<stage>` to `enrichment_runs.error` (distinct from the `backfill_fail` tag used for T1 accounting-invariant failures)
- Exits with code `6` if `failedBatches.length > 0` (dry-run exempt — exits `0`)

### Exit code taxonomy

From `scripts/backfill-enrichment.ts`:

| Code | Meaning |
|---|---|
| `0` | Success (or dry-run) |
| `2` | Unhandled exception |
| `3` | `bot.db` missing |
| `4` | T1 accounting-invariant failure (enqueue/poller gate tripped) |
| `5` | Provider config error (missing API key or invalid model) |
| `6` | **P3.6-H2 strict-mode fail-closed** (ambiguous-empty model output caught) |

### Stage values for exit `6`

The `<stage>` in `backfill_strict_fail_<stage>`:

| Stage | Meaning |
|---|---|
| `provider-call` | Provider throw / timeout / network |
| `json-parse` | Malformed JSON from model |
| `schema-shape` | Top-level not an array (e.g. model returned object) |
| `schema-items-all-dropped` | Every item in the array failed schema (the 2026-04-18 qwen3:32b-tuned regression class) |

### Recovery steps for exit code `6`

1. Read the `failedBatches` JSON printed at end of run:
   ```bash
   jq '.failedBatches' $MW_MIND_CLOSEOUT_DIR/task-5-backfill-telemetry.jsonl
   ```
   — or the last stdout block.
2. Identify the `stage`:
   - `provider-call` usually means transient — retry.
   - `schema-*` means the model is producing the wrong shape — do **not** retry with the same model.
3. For `schema-*` failures: swap `--provider`, swap `EXTRACTION_MODEL` / `VALIDATION_MODEL`, or revert to Anthropic.
4. For `provider-call` failures: check Ollama health (`curl http://localhost:11434/api/tags`), check for cold-load timeouts (raise `apiTimeoutMs` or pre-warm model), retry.
5. Messages are retry-eligible — the same `--run-id` will pick them up again on next invocation (no DB reset needed).

### Regression reference

On 2026-04-18, `qwen3:32b-tuned` returned `[{"fact":"..."}]` (missing the required `text` field), which caused the non-strict path to silently mark 282 messages as processed with zero facts. Strict mode is the structural defense against this class. Unit test `tests/runtimes/chat/enrichment/extractor.test.ts:350` reproduces the exact malformed shape as a regression guard.

### Local-model recipe (cloud-key-free)

```bash
ANTHROPIC_API_KEY=""
OPENAI_API_KEY="ollama-placeholder"   # SDK rejects literal empty string
OPENAI_BASE_URL="http://localhost:11434/v1"
EXTRACTION_MODEL=gemma3:27b
VALIDATION_MODEL=gemma3:27b
npx tsx scripts/backfill-enrichment.ts --strict --provider openai --instance mw-bot
```

Only `gemma3:27b` has been proven viable in the default 30s `apiTimeoutMs`. `qwen2.5:72b` and `qwen3:32b-tuned` have both timed out at cold-load — raise timeout to ≥60s if using them.

## Open item

OpenAI L1 transcription is still pending live verification on mwlab because `OPENAI_API_KEY` is not configured there yet.
