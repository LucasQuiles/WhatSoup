# Pinecone and Transcription Bridge Setup

This runbook covers a configurable deployment that combines WhatSoup memory
extraction, Pinecone-backed knowledge search, optional local transcription, and
optional local vector embedding. Names in this file are placeholders; keep
project IDs, index names, namespace names, service names, and secret-store paths
owned by each deployment.

## Secret Injection

Store provider keys in the operator's secret store, then export them through a
service manager or a narrow wrapper that only projects the required values into
the runtime process environment. Do not write key values into `config.json`,
plist files, shell history, logs, or tracked docs.

This is a compatibility deployment path, not a reason to broaden process
inheritance. Agent child processes should receive only the provider variables
they are explicitly allowed to use; review
`docs/security-review-provider-permission-inheritance-2026-04-04.md` before
reusing wrapper-exported secrets across providers or instances.

For macOS Keychain, prefer the Keychain Access app or a deployment-owned helper
that accepts the secret through a private prompt or stdin. Avoid examples that
place real keys in command arguments, because process listings and shell history
can expose them. The stored item should use these attributes:

```text
keychain: ~/.config/<deployment>-secrets.keychain-db
account: <account>
service: pinecone
```

Verify wrapper injection without printing the secret:

```bash
~/.local/bin/with-pinecone-env python3 - <<'PY'
import os
print('PINECONE_ENV_OK' if os.environ.get('PINECONE_API_KEY') else 'PINECONE_ENV_MISSING')
PY
```

For BYOK deployments, the wrapper may export a tenant-specific environment
variable. Match that name in `memory.pinecone.apiKeyEnv`, and keep the variable
scoped to the instance process rather than a global shell profile.

## Launch Wrapper

Keep the Pinecone wrapper before the Node invocation for any instance that uses
Pinecone memory or `knowledge_search`:

```bash
~/.local/bin/with-pinecone-env \
  /opt/homebrew/bin/node /path/to/WhatSoup/src/bootstrap.ts <instance>
```

The wrapper must not print secrets, write temporary secret files, or export
unrelated provider credentials. If the instance starts agent subprocesses,
validate the child-provider env allowlist before enabling `knowledge_search`.

Reload launchd after plist edits:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.whatsoup.<instance>.plist >/dev/null 2>&1 || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.whatsoup.<instance>.plist
```

## Instance Config

Use the canonical BYOK memory block:

```json
"memory": {
  "pinecone": {
    "apiKeyEnv": "PINECONE_API_KEY",
    "projectId": "<pinecone-project-id>",
    "expectedHostSuffix": "-<pinecone-project-id>.svc.<environment>.pinecone.io",
    "index": "<memory-index>",
    "namespaces": {
      "facts": "<facts-namespace>",
      "chunks": "<chunks-namespace>",
      "summaries": "<summaries-namespace>",
      "legacy": "<legacy-message-namespace>",
      "contacts": "<contacts-namespace>",
      "localDocs": "<local-docs-namespace>",
      "oneDrive": "<onedrive-namespace>"
    },
    "embedUrl": "http://127.0.0.1:8799/embed",
    "allowedIndexes": []
  }
}
```

`embedUrl` can also be set per profile under
`memory.pinecone.knowledgeProfiles.<index>.embedUrl`. If neither config field is
set, WhatSoup reads `KNOWLEDGE_EMBED_URL`, then the deprecated
`MW_MIND_EMBED_URL` alias, then the local development default. This matches the
current runtime resolution order in `src/config.ts`; vector-mode knowledge
queries then call the resolved profile `embedUrl` from `src/mcp/tools/knowledge.ts`.

Keep `memory.pinecone.allowedIndexes` empty until the agent should expose
`knowledge_search`. If an index is added later, the agent still needs either
`agentOptions.sessionScope: "per_chat"` with `agentOptions.sandboxPerChat: true`,
or `memory.pinecone.knowledgeSearch.allowGlobalAgentSessions: true`; the default
is fail-closed for non-sandboxed global sessions.

Legacy fields such as `pineconeIndex` and `pineconeAllowedIndexes` are still
read at runtime, but new writes should be canonical. Migrate without touching
auth:

```bash
cd ~/LAB/WhatSoup
npm run migrate-memory-config -- --instance <instance>
npm run migrate-memory-config -- --instance <instance> --write
```

The migration helper rewrites only `config.json` and creates a
`config.json.bak-*` backup by default. It does not touch `auth/`, `tokens.env`,
`bot.db`, keychains, or provider secret stores, so a successful config migration
should not require a WhatsApp QR re-auth.

`tokens.env` is mentioned here only as an existing health-token compatibility
file. New deployments should prefer scoped keyring-backed health tokens where
the platform supports them; file-backed health tokens must remain outside the
repo, mode `0600`, and owned by the instance operator.

## Local Transcription Bootstrap

Run from the deployment checkout:

```bash
cd ~/LAB/WhatSoup
bash scripts/install-transcription-deps.sh
```

This installs:

- Homebrew `ffmpeg`
- Homebrew `whisper-cpp`
- Homebrew Python
- dedicated venv at `~/.local/share/whatsoup/transcription-venv`
- faster-whisper cache under `~/.local/share/whatsoup/models/faster-whisper`
- whisper.cpp model under `~/.local/share/whatsoup/models/whisper.cpp/`

## Database Migration Trigger

Schema migrations run when a runtime opens its writable `bot.db`. Fleet opens
instance DBs read-only and does not run migrations.

For a missing table or old schema version:

```bash
sqlite3 ~/.local/share/whatsoup/instances/<instance>/bot.db \
  "SELECT MAX(version) FROM schema_migrations"

launchctl kickstart -k gui/$(id -u)/com.whatsoup.<instance>

sqlite3 ~/.local/share/whatsoup/instances/<instance>/bot.db \
  "SELECT MAX(version) FROM schema_migrations"
```

Do not restart the instance while a manual bridge run or backfill is writing to
the same DB.

## Backfill Enrichment Strict Mode

Operator-invoked retroactive enrichment of messages with
`enrichment_processed_at IS NULL`:

```bash
npm run backfill-enrichment -- --strict --provider {anthropic|openai} --instance <instance> --run-id <id>
```

`--strict` is fail-closed. If extraction or validation raises a structured
error, the script:

- leaves the affected messages retry-eligible
- records the failure in `BackfillSummary.failedBatches[]`
- writes a distinct strict-failure marker
- exits with code `6` when strict failures exist

Exit code taxonomy:

| Code | Meaning |
|---|---|
| `0` | Success, or dry run |
| `2` | Unhandled exception |
| `3` | `bot.db` missing |
| `4` | Accounting-invariant failure or argument parse error |
| `5` | Provider config error |
| `6` | Strict-mode fail-closed validation/extraction failure |

For provider-call failures, check network, provider status, local model health,
and `WHATSOUP_API_TIMEOUT_MS`.

## Local Model Recipe

```bash
OPENAI_API_KEY="ollama-placeholder" \
OPENAI_BASE_URL="http://localhost:11434/v1" \
EXTRACTION_MODEL=<local-extraction-model> \
VALIDATION_MODEL=<local-validation-model> \
WHATSOUP_API_TIMEOUT_MS=60000 \
  npm run backfill-enrichment -- --strict --provider openai --instance <instance>
```

The OpenAI-compatible SDK path requires a non-empty API key value, so use a
non-secret placeholder when routing through a local endpoint. Keep the
assignment command-scoped as shown; do not store placeholder or real provider
keys in persistent shell profiles unless that is an explicit local policy.
