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

## Phase 3 gate G1 — migration trigger (`mw-bot` restart)

Phase 3 introduced schema migration 20 (`fact_export_queue` table) in `src/core/database.ts`. Migrations fire at `src/main.ts:141-142` when `db.open()` is called — this is the de-facto migration trigger for the live `bot.db`.

Only `com.whatsoup.mw-bot` triggers migration for `~/.local/share/whatsoup/instances/mw-bot/bot.db`. `com.whatsoup.mw-cell` has a separate DB at `~/.local/share/whatsoup/instances/mw-cell/` — restarting it does **not** create missing tables in mw-bot's DB. `com.whatsoup.whatsoup-fleet` opens instance DBs read-only via `src/fleet/db-reader.ts:53-55` (`READ_ONLY_DATABASE_OPTIONS`) and does **not** run migrations under any circumstance.

### Actor contract

| Actor | DB path | Migration authority |
|---|---|---|
| `com.whatsoup.mw-bot` | `~/.local/share/whatsoup/instances/mw-bot/bot.db` | Yes — `db.open()` at `src/main.ts:141-142` |
| `com.whatsoup.mw-cell` | `~/.local/share/whatsoup/instances/mw-cell/` | Separate DB — writes to mw-bot path would be a bug |
| `com.whatsoup.whatsoup-fleet` | opens instance DBs via `src/fleet/db-reader.ts` | Read-only (`READ_ONLY_DATABASE_OPTIONS`) — never migrates |

### Operator procedure

```bash
# Confirm the schema version before restart
sqlite3 ~/.local/share/whatsoup/instances/mw-bot/bot.db \
  "SELECT MAX(version) FROM schema_migrations"

# Restart mw-bot (explicit operator GO required per Phase 3 gate G1)
launchctl kickstart -k gui/$(id -u)/com.whatsoup.mw-bot

# Wait ~5-10s for startup, then confirm migration applied
sqlite3 ~/.local/share/whatsoup/instances/mw-bot/bot.db \
  "SELECT MAX(version) FROM schema_migrations"
# Expected: version number bumped to the latest migration (20 for Phase 3)
```

### When not to run

Never restart mw-bot while a manual bridge run or backfill is actively writing to `bot.db`. Coordinate with ongoing operations before firing the kickstart.

### Regression reference

The 2026-04-17 incident where `fact_export_queue` was absent from live bot.db because mw-bot predated the migration-20 code deploy. Root cause: the code shipped but the process didn't reopen the DB. G1 exists to prevent this class of drift.

### Related gates

- G2 is the launchd bootstrap of `com.mwlab.mw-mind-whatsapp-bridge` (see separate bridge section if present).
- G1 is a prerequisite for the `backfill-enrichment --strict` workflow documented below.

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
| `4` | T1 accounting-invariant failure (`summary.batchesFailed > 0`), or argument parse error (unknown flag, missing required value) |
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

Note: the same stage vocabulary covers both `ExtractionError` and `ValidationError`. Check `failedBatches[].errorType` in the final telemetry record (see Recovery step 1) to determine which function fired.

### Recovery steps for exit code `6`

1. Read the final `run_complete` telemetry record. `runBackfill` emits this as the last JSONL line of every run (action: `run_complete`), with `inputs.failedBatches` carrying the full structured list:
   ```bash
   jq 'select(.action == "run_complete") | .inputs.failedBatches' \
     $MW_MIND_CLOSEOUT_DIR/task-5-backfill-telemetry.jsonl
   ```
   — or the last stdout block.
2. Identify the `stage`:
   - `provider-call` usually means transient — retry.
   - `schema-*` means the model is producing the wrong shape — do **not** retry with the same model.
3. For `schema-*` failures: swap `--provider`, swap `EXTRACTION_MODEL` / `VALIDATION_MODEL`, or revert to Anthropic.
4. For `provider-call` failures: check Ollama health (`curl http://localhost:11434/api/tags`), check for cold-load timeouts (raise via `WHATSOUP_API_TIMEOUT_MS` env var (in ms) or pre-warm model), retry.
5. Messages are retry-eligible based on `enrichment_processed_at IS NULL` (no DB reset needed); the `--run-id` is a run label, not a retry key — any value (same or different) works.

### Regression reference

On 2026-04-18, `qwen3:32b-tuned` returned `[{"fact":"..."}]` (missing the required `text` field), which caused the non-strict path to silently mark 282 messages as processed with zero facts. Strict mode is the structural defense against this class. Unit test `tests/runtimes/chat/enrichment/extractor.test.ts:350` reproduces the exact malformed shape as a regression guard.

### Local-model recipe (cloud-key-free)

```bash
ANTHROPIC_API_KEY=""
OPENAI_API_KEY="ollama-placeholder"   # SDK rejects literal empty string
OPENAI_BASE_URL="http://localhost:11434/v1"
EXTRACTION_MODEL=gemma3:27b
VALIDATION_MODEL=gemma3:27b
WHATSOUP_API_TIMEOUT_MS=60000 \
  npx tsx scripts/backfill-enrichment.ts --strict --provider openai --instance mw-bot
```

Only `gemma3:27b` has been proven viable in the default 30s `apiTimeoutMs`. `qwen2.5:72b` and `qwen3:32b-tuned` have both timed out at cold-load — set `WHATSOUP_API_TIMEOUT_MS=60000` (or higher; value is in ms) before invoking the script if using them. The env var overrides the hardcoded `config.apiTimeoutMs` default without a code edit.

## Open item

OpenAI L1 transcription is still pending live verification on mwlab because `OPENAI_API_KEY` is not configured there yet.
