# BYOK Memory Configuration Migration

Date: 2026-04-26

## Goal

WhatSoup memory must be configuration-first. A deployment should be able to bring its own Pinecone key, project, index, namespaces, retrieval profile, and embed endpoint without patching source code or inheriting another host's assumptions.

The migration has two simultaneous goals:

- Preserve existing instances so deploys do not break memory, auth, or WhatsApp sessions.
- Move all new writes toward a canonical `memory` block so future instances are explicit and portable.

## Previous State

Memory configuration was split across several places:

| Layer | Previous shape | Risk |
|---|---|---|
| Chat memory index | `pineconeIndex` flat field or `PINECONE_INDEX` | Configured per instance, but not grouped with the rest of memory. |
| WhatsApp namespaces | `whatsapp-facts`, `whatsapp-chunks`, `whatsapp-summaries` literals in the query router and export queue | Namespace names were locked to one deployment pattern. |
| Knowledge profiles | Hardcoded `oneplatform-search`, `oneplatform-entities`, and `mw-mind` profiles in `src/mcp/tools/knowledge.ts` | Adding a new customer/project required a code edit. |
| Pinecone API key | Always read from `PINECONE_API_KEY` | No clean BYOK boundary for multiple projects/keys on one host. |
| Pinecone project identity | Not asserted | Same index name in two Pinecone projects could route silently to the wrong project. |
| Agent knowledge tool | Registered from `pineconeAllowedIndexes` only | Non-sandboxed global agent sessions could expose broad search if an index was allowed. |
| Migration path | Manual JSON edits | Easy to delete tokens/auth by operating on the wrong directory. |

The most important structural issue was not just one hardcoded value. It was that project, index, namespace, key source, and retrieval behavior were not treated as one configuration boundary.

## Current State

The canonical shape is:

```json
{
  "memory": {
    "conversation": {
      "recent": 50,
      "extended": 100,
      "extendedWithinMs": 600000
    },
    "retention": {
      "days": 30
    },
    "enrichment": {
      "intervalMs": 60000,
      "batchSize": 200,
      "minConfidence": 0.7,
      "dedupThreshold": 0.95,
      "maxRetries": 3
    },
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
      "searchMode": "entity",
      "allowedIndexes": [],
      "knowledgeSearch": {
        "enabled": true,
        "allowGlobalAgentSessions": false
      },
      "knowledgeProfiles": {
        "mw-mind": {
          "namespace": "",
          "namespaces": ["local-docs", "onedrive", "whatsapp", "whatsapp-contacts", "whatsapp-facts", "whatsapp-chunks", "whatsapp-summaries"],
          "searchMode": "vector",
          "rerank": false,
          "rerankModel": "",
          "topK": 20,
          "rerankTopN": 6,
          "embedUrl": "http://127.0.0.1:8799/embed",
          "description": "Standalone memory index"
        }
      }
    }
  }
}
```

Runtime compatibility remains intact. `resolveMemoryConfig()` projects legacy flat fields into this shape at startup, with canonical `memory.*` values taking precedence. That means an old config with only `"pineconeIndex": "mw-mind"` still boots and resolves to `memory.pinecone.index = "mw-mind"`.

## Mental Model

Treat `memory` as the boundary between a WhatSoup instance and every memory backend it is allowed to use.

Before this migration, a deployment answered these questions in different places:

- Which Pinecone key should this instance use?
- Which Pinecone project should that key resolve to?
- Which index is the primary chat memory index?
- Which namespaces are facts, chunks, summaries, contacts, local docs, or imported archives?
- Which indexes are exposed to agent-side `knowledge_search`?
- Which retrieval profile should each exposed index use?
- Whether a broad agent session is allowed to search shared knowledge at all.

After this migration, those answers live together under `memory`. Source code still contains compatibility defaults so old instances can boot, but those defaults are fallback values. They are not the deployment contract for new instances.

## Resolution Order

For every memory field, WhatSoup resolves values in this order:

1. Canonical `memory.*` value in the instance `config.json`.
2. Legacy flat alias in the same `config.json`.
3. Environment fallback where one exists.
4. Built-in compatibility default.

The first rule is the important one: canonical config wins. This prevents a stale legacy field from overriding a deliberate BYOK setting.

Example:

```json
{
  "pineconeIndex": "old-index",
  "memory": {
    "pinecone": {
      "index": "customer-a-memory"
    }
  }
}
```

Runtime resolves the index as `customer-a-memory`, not `old-index`.

## Before And After Flow

Previous boot flow:

1. Load instance config.
2. Read flat values such as `pineconeIndex` and `pineconeAllowedIndexes`.
3. Fall back to process env such as `PINECONE_INDEX`.
4. Query hardwired namespaces or hardwired knowledge profiles.
5. Trust that the Pinecone key points to the intended project.

Current boot flow:

1. Load instance config.
2. Project any legacy aliases into an in-memory canonical `memory` block.
3. Resolve `memory.pinecone.apiKeyEnv`, project guard, index, namespaces, retrieval profiles, and exposure gates.
4. Runtime paths read the canonical `config.memory` object.
5. Pinecone readiness and `knowledge_search` verify the configured project guard before using an index.

The migration helper performs the same projection on disk, so the config file eventually matches the runtime model.

## BYOK Boundary

`memory.pinecone.apiKeyEnv` is the BYOK boundary. WhatSoup does not need to know the secret value. It only needs to know which environment variable the instance should read.

Examples:

| Deployment | Wrapper exports | Config reads |
|---|---|---|
| Existing mwlab | `PINECONE_API_KEY` from keychain | `memory.pinecone.apiKeyEnv = "PINECONE_API_KEY"` |
| Customer A | `PINECONE_CUSTOMER_A_KEY` from its secret store | `memory.pinecone.apiKeyEnv = "PINECONE_CUSTOMER_A_KEY"` |
| Local test | `PINECONE_SANDBOX_KEY` in a shell | `memory.pinecone.apiKeyEnv = "PINECONE_SANDBOX_KEY"` |

The key remains outside `config.json`. The config points at a secret injection mechanism instead of storing the secret.

### Example: Existing mwlab

mwlab can keep its current keychain/wrapper flow. The wrapper exports `PINECONE_API_KEY`; the instance declares that this is the env var to read and guards that the resolved index belongs to the canonical project.

```json
{
  "memory": {
    "pinecone": {
      "apiKeyEnv": "PINECONE_API_KEY",
      "projectId": "nf9hzvy",
      "expectedHostSuffix": "-nf9hzvy.svc.aped-4627-b74a.pinecone.io",
      "index": "mw-mind"
    }
  }
}
```

No token migration or WhatsApp re-auth is required because the secret source and auth directory stay where they are.

### Example: Customer BYOK

A customer deployment can export a different env var from its own secret store:

```json
{
  "memory": {
    "pinecone": {
      "apiKeyEnv": "CUSTOMER_A_PINECONE_KEY",
      "projectId": "customer-project-id",
      "expectedHostSuffix": "-customer-project-id.svc.aped-4627-b74a.pinecone.io",
      "index": "customer-a-memory",
      "namespaces": {
        "facts": "customer-a-facts",
        "chunks": "customer-a-chunks",
        "summaries": "customer-a-summaries"
      }
    }
  }
}
```

The same WhatSoup build can run both instances on the same host because each instance decides which key env var, project, index, and namespaces it owns.

## Project Guard

Two Pinecone projects can legitimately contain indexes with the same name. The guard fields make that explicit:

- `memory.pinecone.projectId`
- `memory.pinecone.expectedHostSuffix`

Readiness now lists indexes, finds the configured index, and verifies the host. If the host does not match the configured guard, readiness returns `project_mismatch` instead of `ready`.

`knowledge_search` also validates the project guard before querying. This prevents the failure mode where an agent can query an index that happens to have the right name but lives under the wrong project/key.

Guard behavior:

| State | Meaning | Operator action |
|---|---|---|
| `ready` | Configured key can see the configured index and project guard matches. | Proceed. |
| `missing_api_key` | The configured env var is not present. | Fix wrapper/keychain/env injection. Do not edit WhatsApp auth. |
| `index_missing` | Key is valid enough to list indexes, but the configured index is absent. | Check index name or project key. |
| `project_mismatch` | An index with that name exists, but its host does not match `projectId` or `expectedHostSuffix`. | Stop rollout; key/project/index are inconsistent. |
| `error` | Pinecone list/query failed unexpectedly. | Inspect logs/network/Pinecone status. |

## Namespace Routing

The query router still uses deterministic intent buckets:

| Intent | Default order |
|---|---|
| facts | facts, summaries, chunks |
| raw | summaries, chunks, facts |
| hybrid | summaries, facts, chunks |

The names are now supplied by `memory.pinecone.namespaces`, not source literals. A deployment can rename `facts` to `tenant-a-facts`, point `legacy` at an imported archive namespace, or omit non-WhatsApp namespaces from a knowledge profile without editing code.

The configured namespace map is used by:

- chat context routing
- fact export queue defaults
- `mw-mind` `knowledge_search` fan-out order

The source defaults remain `whatsapp-facts`, `whatsapp-chunks`, and `whatsapp-summaries` only for backward compatibility. A production BYOK deployment should set these names explicitly in config, even if it chooses the same values.

## Knowledge Search Isolation

`knowledge_search` is now controlled by three gates:

1. `memory.pinecone.knowledgeSearch.enabled` must not be `false`.
2. `memory.pinecone.allowedIndexes` must include at least one configured profile.
3. Agent runtime must be `sandboxPerChat` or `memory.pinecone.knowledgeSearch.allowGlobalAgentSessions` must be `true`.

The default is conservative: a non-sandboxed global agent session does not get `knowledge_search` just because an index is configured. This matters for shared/per-chat sessions where one global socket or one broad session can serve more than one caller.

Each knowledge profile defines its allowed namespaces. If a caller supplies a `namespace` override outside the profile allowlist, the tool returns an error instead of querying it.

Example profile for a customer-owned docs index:

```json
{
  "memory": {
    "pinecone": {
      "allowedIndexes": ["customer-a-docs"],
      "knowledgeSearch": {
        "enabled": true,
        "allowGlobalAgentSessions": false
      },
      "knowledgeProfiles": {
        "customer-a-docs": {
          "namespace": "",
          "namespaces": ["policies", "runbooks", "product-docs"],
          "searchMode": "text",
          "rerank": true,
          "rerankModel": "pinecone-rerank-v0",
          "topK": 20,
          "rerankTopN": 6,
          "description": "Customer A internal documentation"
        }
      }
    }
  }
}
```

With that config, `knowledge_search` cannot query an unlisted namespace such as `private-archive`, even if the same Pinecone key can technically access it.

## Migration Helper

The pure helper lives at:

```text
src/config-memory-migration.ts
```

The CLI wrapper lives at:

```text
scripts/migrate-memory-config.ts
```

Package command:

```bash
npm run migrate-memory-config
```

Default behavior is dry-run. It prints what would move and does not write files.

Dry-run all instances under the default config root:

```bash
npm run migrate-memory-config
```

Write one instance:

```bash
npm run migrate-memory-config -- --instance mw-bot --write
```

Write a direct config path:

```bash
npm run migrate-memory-config -- --config ~/.config/whatsoup/instances/mw-bot/config.json --write
```

Keep legacy aliases during a staged rollout:

```bash
npm run migrate-memory-config -- --instance mw-bot --write --keep-legacy
```

Emit machine-readable output for deployment automation:

```bash
npm run migrate-memory-config -- --instance mw-bot --json
```

## What The Migrator Changes

It rewrites only `config.json`.

It can move:

| Legacy field | Canonical field |
|---|---|
| `conversationWindow` | `memory.conversation.recent` |
| `conversationWindowExtended` | `memory.conversation.extended` |
| `windowExtensionThresholdMs` | `memory.conversation.extendedWithinMs` |
| `retentionDays` | `memory.retention.days` |
| `enrichmentIntervalMs` | `memory.enrichment.intervalMs` |
| `enrichmentBatchSize` | `memory.enrichment.batchSize` |
| `enrichmentMinConfidence` | `memory.enrichment.minConfidence` |
| `enrichmentDedupThreshold` | `memory.enrichment.dedupThreshold` |
| `enrichmentMaxRetries` | `memory.enrichment.maxRetries` |
| `pineconeApiKeyEnv` | `memory.pinecone.apiKeyEnv` |
| `pineconeProjectId` | `memory.pinecone.projectId` |
| `pineconeExpectedHostSuffix` | `memory.pinecone.expectedHostSuffix` |
| `pineconeIndex` | `memory.pinecone.index` |
| `pineconeSearchMode` | `memory.pinecone.searchMode` |
| `pineconeRerank` | `memory.pinecone.rerank` |
| `pineconeRerankModel` | `memory.pinecone.rerankModel` |
| `pineconeTopK` | `memory.pinecone.topK` |
| `pineconeRerankTopN` | `memory.pinecone.rerankTopN` |
| `pineconeContextTopK` | `memory.pinecone.contextTopK` |
| `pineconeSenderTopK` | `memory.pinecone.senderTopK` |
| `pineconeSelfFactTopK` | `memory.pinecone.selfFactTopK` |
| `pineconeAllowedIndexes` | `memory.pinecone.allowedIndexes` |
| `pineconeKnowledgeSearch` | `memory.pinecone.knowledgeSearch` |
| `pineconeKnowledgeProfiles` | `memory.pinecone.knowledgeProfiles` |
| `pineconeEmbedUrl` | `memory.pinecone.embedUrl` |
| `pineconeNamespace` | `memory.pinecone.namespaces.legacy` |
| `pineconeFactsNamespace` | `memory.pinecone.namespaces.facts` |
| `pineconeChunksNamespace` | `memory.pinecone.namespaces.chunks` |
| `pineconeSummariesNamespace` | `memory.pinecone.namespaces.summaries` |
| `pineconeLegacyNamespace` | `memory.pinecone.namespaces.legacy` |
| `pineconeContactsNamespace` | `memory.pinecone.namespaces.contacts` |
| `pineconeLocalDocsNamespace` | `memory.pinecone.namespaces.localDocs` |
| `pineconeOneDriveNamespace` | `memory.pinecone.namespaces.oneDrive` |

When both canonical and legacy values exist, canonical values win. This lets an operator add `memory.pinecone.projectId` without a stale flat field taking precedence.

## Migration Algorithm

The helper is intentionally mechanical:

1. Parse `config.json` as JSON.
2. Deep-clone the config in memory.
3. Copy each recognized legacy field into its canonical `memory.*` path only if the canonical path is absent.
4. Merge `pineconeNamespaces` into `memory.pinecone.namespaces` without overwriting existing canonical namespace keys.
5. In write mode, optionally remove the legacy flat fields from the file.
6. Create a timestamped `config.json.bak-*` backup unless `--no-backup` is passed.
7. Write a temporary file and rename it over `config.json`.

The helper does not infer secrets, call Pinecone, or validate live credentials. That separation is deliberate: config shape migration should be deterministic and safe to run before the service has network access.

## What The Migrator Does Not Change

The migrator does not touch:

- `tokens.env`
- `auth/`
- `bot.db`
- keychains
- provider API keys
- WhatsApp pairing credentials
- launchd plists
- SQLite migrations

That is deliberate. Auth material is a separate operational tier. Config migration should not force a WhatsApp QR scan or a provider re-auth.

## Deployment Validation Checklist

Before restart:

- `npm run migrate-memory-config -- --instance <name>` shows only expected `config.json` moves.
- The configured `memory.pinecone.apiKeyEnv` matches the wrapper or service manager environment.
- The configured `memory.pinecone.projectId` and `expectedHostSuffix` match the target Pinecone project.
- Namespaces are tenant/project-specific when isolation matters.
- `memory.pinecone.allowedIndexes` is empty unless agent-side `knowledge_search` is intentionally exposed.
- If `allowedIndexes` is non-empty, each index has a matching `knowledgeProfiles` entry.
- Non-sandboxed agent instances leave `allowGlobalAgentSessions` unset or `false` unless broad search is explicitly intended.

After restart:

- `/health` reports Pinecone readiness as `ready` or disabled as expected.
- Logs do not show `project_mismatch`.
- A controlled chat memory lookup returns records from the expected namespace family.
- A `knowledge_search` call against an unallowed namespace returns an error instead of results.

## Safe Deployment Flow

1. Deploy code.
2. Dry-run the target instance:

   ```bash
   npm run migrate-memory-config -- --instance mw-bot
   ```

3. Inspect the proposed moves.
4. Write with backup:

   ```bash
   npm run migrate-memory-config -- --instance mw-bot --write
   ```

5. Confirm auth files were not touched:

   ```bash
   ls -ld ~/.config/whatsoup/instances/mw-bot/auth
   stat ~/.config/whatsoup/instances/mw-bot/tokens.env
   ```

6. Restart only the target service when ready.
7. Check `/health` and logs for Pinecone readiness. A `project_mismatch` state means the configured key/project/index combination is inconsistent; it is not an auth failure.

## Rollback

Every write creates `config.json.bak-<timestamp>` unless `--no-backup` is passed.

Rollback is just replacing `config.json` with the backup and restarting the instance. Auth state remains in place because the migrator never touched it.

## Remaining Work

This change makes memory configuration-first inside WhatSoup. It does not yet solve every memory isolation concern:

- Existing host-level Claude Code `CLAUDE.md` and plugin inheritance are separate from Pinecone memory config.
- Obsidian integration remains out of scope.
- Existing live indexes may still need naming cleanup and namespace consolidation.
- External wrappers still have to export the configured BYOK env var.

Those are operational hardening tasks on top of this config boundary.
