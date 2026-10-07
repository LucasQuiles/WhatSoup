# mwlab Transcription and Pinecone Setup

This runbook is mwlab-specific. The plist and bridge names below describe that
host's intended deployment shape and are not evidence that the bridge is
installed on maclab, nucles, or another WhatSoup instance.

## Pinecone key in the dedicated keychain

Use the shared [secret injection procedure](pinecone-transcription-bridge.md#secret-injection),
including its presence-only probe, with the deployment attributes recorded below:

```text
keychain: <deployment-keychain-path>
account: <deployment-account>
service: pinecone
```

The keychain path and account are required deployment parameters. Resolve them
from the private deployment record before using the shared procedure. This
configuration is not a fresh credential check.

## Launch agent wrapper

Keep `/Users/mw/.local/bin/with-pinecone-env` as the first `ProgramArguments` entry in `~/Library/LaunchAgents/com.whatsoup.mw-bot.plist`.

Reload after edits:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.whatsoup.mw-bot.plist >/dev/null 2>&1 || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.whatsoup.mw-bot.plist
```

## Instance config

`~/.config/whatsoup/instances/mw-bot/config.json` should use the canonical BYOK memory block:

```json
"memory": {
  "pinecone": {
    "apiKeyEnv": "PINECONE_API_KEY",
    "projectId": "nf9hzvy",
    "expectedHostSuffix": "-nf9hzvy.svc.aped-4627-b74a.pinecone.io",
    "index": "mw-mind",
    "namespaces": {
      "facts": "whatsapp-facts",
      "chunks": "whatsapp-chunks",
      "summaries": "whatsapp-summaries",
      "legacy": "whatsapp",
      "contacts": "whatsapp-contacts",
      "localDocs": "local-docs",
      "oneDrive": "onedrive"
    },
    "allowedIndexes": []
  }
}
```

Keep `memory.pinecone.allowedIndexes` empty until the configured index should be
exposed through `knowledge_search`. When adding that index, the agent also needs
either `agentOptions.sessionScope: "per_chat"` with `agentOptions.sandboxPerChat: true`,
or `memory.pinecone.knowledgeSearch.allowGlobalAgentSessions: true`; the default
is fail-closed for non-sandboxed global sessions.

Use the shared [config migration procedure](pinecone-transcription-bridge.md#instance-config)
with the configured instance ID, including `--keep-legacy` and the recency-gap check.
Preserve `auth/`, `tokens.env`, `bot.db`, and the dedicated keychain; the migration
only rewrites `config.json` and creates a backup by default.

## Local transcription bootstrap

Follow the shared [local transcription bootstrap](pinecone-transcription-bridge.md#local-transcription-bootstrap)
from the deployment worktree. The recorded whisper.cpp model path is
`~/.local/share/whatsoup/models/whisper.cpp/ggml-small.bin`.

## Phase 3 gate G1 — migration trigger (`mw-bot` restart)

This gate records the April 2026 rollout, which introduced migration 20
(`fact_export_queue`); that number is the historical acceptance target, not the
current schema ceiling. Confirm the current migration registry and deployed
service path before any restart. Runtime startup calls `Database.open()` on
its instance DB; writable maintenance tools can also trigger migrations.

For this rollout, the writable instance process owns migration of its database;
restarting a different instance does not migrate that database. Use the actor
table below to select the recorded instance. Fleet reads through `src/fleet/db-reader.ts`
with `READ_ONLY_DATABASE_OPTIONS` and does not migrate instance DBs.

### Actor contract

| Actor | DB path | Migration authority |
|---|---|---|
| Configured primary instance | `<instance-state-dir>/bot.db` | Yes — writable `Database.open()` on startup |
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

- G2 is the mwlab-only launchd bootstrap of
  `com.mwlab.mw-mind-whatsapp-bridge` if that bridge is deployed.
- G1 is a prerequisite for the `backfill-enrichment --strict` workflow documented below.

## `backfill-enrichment --strict` (P3.6-H2) operator guide

Use the shared [backfill enrichment strict-mode procedure](pinecone-transcription-bridge.md#backfill-enrichment-strict-mode)
with the configured instance ID. Its source-backed behavior, exit codes, stages, and
recovery steps are canonical for this deployment too.

### What `--strict` changes

See the shared procedure for retry eligibility, structured failure records,
strict-failure markers, and the dry-run exception. A dry-run exit `0` does not
prove that extraction or validation succeeded.

### Exit code taxonomy

The shared procedure owns the exit-code table for `scripts/backfill-enrichment.ts`.

### Stage values for exit `6`

The shared procedure owns the stage table and `errorType` interpretation. The
incident below is the historical `schema-items-all-dropped` regression.

### Recovery steps for exit code `6`

Follow the shared recovery steps. The original closeout stored telemetry at
`$MW_MIND_CLOSEOUT_DIR/task-5-backfill-telemetry.jsonl`; resolve the actual
current run's output path before inspecting `inputs.failedBatches`.

### Regression reference

On 2026-04-18, `qwen3:32b-tuned` returned `[{"fact":"..."}]` (missing the required `text` field), which caused the non-strict path to silently mark 282 messages as processed with zero facts. Strict mode is the structural defense against this class. Unit tests in `tests/runtimes/chat/enrichment/extractor.test.ts` cover malformed extraction shapes.

### Local-model recipe (cloud-key-free)

Use the shared [command-scoped local model recipe](pinecone-transcription-bridge.md#local-model-recipe)
with the configured instance ID and models validated on the current host.

In the April 2026 measurements, `gemma3:27b` completed within the default 30s
timeout; `qwen2.5:72b` and `qwen3:32b-tuned` timed out on cold load. The recorded
mitigation was pre-warming or `WHATSOUP_API_TIMEOUT_MS=60000` (milliseconds).
Those measurements are historical evidence, not a current model recommendation.

## Open item

The original run left OpenAI L1 transcription unverified because its API key
was absent. Confirm current credential presence without printing its value and
capture a fresh live result before closing this item.
