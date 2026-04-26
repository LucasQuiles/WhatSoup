# 2026-04-26 BYOK Memory Config Migration

## Summary

This patch moves WhatSoup memory and Pinecone integration to a BYOK, configuration-first model. Project, key env var, index, namespaces, retrieval profile, and knowledge-search exposure now live under `memory` in `config.json`.

Legacy flat fields still work at runtime. Fleet writes and the migration CLI canonicalize them into `memory.*`.

## Previous State

- `pineconeIndex` was a top-level field.
- `PINECONE_API_KEY` was the only key env var read by Pinecone provider paths.
- WhatsApp memory namespaces were embedded as source literals in routing/export code.
- `knowledge_search` profiles were embedded in `src/mcp/tools/knowledge.ts`.
- No code-level Pinecone project guard existed.
- `pineconeAllowedIndexes` alone could register broad agent knowledge search.
- Operators had no safe, repeatable helper for migrating existing configs.

## Current State

- `memory.pinecone.apiKeyEnv` selects the env var holding the Pinecone key.
- `memory.pinecone.projectId` and `memory.pinecone.expectedHostSuffix` guard against wrong-project index collisions.
- `memory.pinecone.index` is the primary memory/entity index.
- `memory.pinecone.namespaces` controls facts/chunks/summaries/legacy/contact/local-doc/OneDrive namespace names.
- `memory.pinecone.knowledgeProfiles` configures index-specific retrieval behavior.
- `memory.pinecone.knowledgeSearch` gates agent knowledge tool exposure.
- `resolveMemoryConfig()` keeps old configs bootable by projecting legacy aliases into the canonical block.

## Migration Helper

New command:

```bash
npm run migrate-memory-config
```

Default mode is dry-run.

Write one instance:

```bash
npm run migrate-memory-config -- --instance mw-bot --write
```

The helper writes only `config.json`. It does not touch `tokens.env`, `auth/`, `bot.db`, provider keys, keychains, or WhatsApp auth state. Write mode creates a timestamped backup by default.

## Safety Details

- Canonical `memory.*` values win over legacy flat fields.
- `--keep-legacy` can be used for staged rollouts.
- Fleet `PATCH /api/lines/:name/config` deep-merges nested memory patches so partial namespace updates do not destroy sibling settings.
- Fleet create/update writes canonical memory config when old clients still send flat fields.
- Pinecone readiness can return `project_mismatch` when the configured key/index resolves to the wrong project.
- `knowledge_search` is not available to non-sandboxed global agent sessions unless `memory.pinecone.knowledgeSearch.allowGlobalAgentSessions` is explicitly true.

## Validation

Covered by focused tests:

- migration projection and canonical precedence
- CLI dry-run/write behavior and auth-token preservation
- runtime config resolution from canonical and legacy fields
- configurable namespace routing
- Pinecone project mismatch readiness
- fleet config patch canonicalization
- instance-loader preservation of canonical memory config
- agent runtime knowledge-search gate

Verification commands used:

```bash
npm run typecheck
npx vitest run tests/config-memory-migration.test.ts tests/scripts/migrate-memory-config.test.ts tests/config.test.ts tests/runtimes/chat/memory/query-router.test.ts tests/runtimes/chat/context.test.ts tests/runtimes/chat/providers/pinecone-readiness.test.ts tests/runtimes/chat/providers/pinecone.test.ts tests/runtimes/chat/enrichment/fact-export-queue.test.ts tests/fleet/ops-config-patch.test.ts tests/instance-loader.test.ts tests/mcp/register-all.test.ts tests/runtimes/agent/runtime.test.ts --pool=forks
```

## Operator Notes

For existing deployments, deploy code first, dry-run migration second, write third, restart the target instance last.

If readiness reports `project_mismatch`, do not rotate credentials blindly. Check that `memory.pinecone.apiKeyEnv`, the wrapper-exported key, `memory.pinecone.index`, and the configured project guard all describe the same Pinecone project.

## Known Limits

This patch does not migrate auth material, rewrite launchd plists, alter keychain contents, or rename existing Pinecone indexes/namespaces. It creates the config boundary needed for those operations to be planned safely.
