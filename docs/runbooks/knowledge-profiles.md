# Knowledge Profiles — Fleet Memory Configuration

Reference for configuring `memory.pinecone` in per-bot `config.json` files.
Covers the host-suffix guard, `allowedIndexes`, and `knowledgeProfiles` for
per-principal bots whose Pinecone project is separate from the mw-only built-ins.

---

## Background

The bot's knowledge search tool (`knowledge_search`) queries Pinecone indexes
that are declared in `memory.pinecone.allowedIndexes`. For each index name in
that list, a matching entry in `memory.pinecone.knowledgeProfiles` (or a
built-in profile) must exist. Nothing rejects a missing one at config load:
when the knowledge tools register, an index with no matching profile is
skipped with an `Unknown index in memory.pinecone.allowedIndexes — skipping`
warning, and if none remain the tool is not registered.

Built-in profiles (`oneplatform-search`, `oneplatform-entities`, `mw-mind`)
are defined in `src/config.ts:defaultKnowledgeProfiles`. They target the
mw-dedicated Pinecone project. Per-principal bots use separate Pinecone
projects and must declare custom profiles.

---

## Project guard — expectedHostSuffix

The `memory.pinecone.expectedHostSuffix` field guards against a bot querying
the wrong Pinecone project. Before any query is executed, the runtime fetches
the index host and verifies it ends with the configured suffix.

```json
"memory": {
  "pinecone": {
    "expectedHostSuffix": "-example-project.svc.example-region.pinecone.io"
  }
}
```

**If you set `projectId`, use the short slug, not the project UUID.** The
guard matches it as a host segment (`host.includes("-<projectId>.")`,
`matchesPineconeProjectGuard` in `src/lib/pinecone-project-guard.ts`), and
the host URL embeds the short slug, so a UUID never matches. When both
fields are set, both must match, and a matching `projectId` alone also
satisfies the runtime guard. The suffix above is a placeholder: take your
own from the host of any index in the project (the Pinecone console shows
it), starting at the hyphen before the short slug. A suffix is the simplest
guard. Keep its leading `-`:
for agent and chat instances, the instance-config checker
(`scripts/check-instance-config.ts`) expects the
`-<slug>.svc.<env>.pinecone.io` shape and reports a `memory.pinecone` block
without `expectedHostSuffix`, even when `projectId` is set.

`pineconeReadiness` checks the resolved guard. Each field comes from
`memory.pinecone`, else from `PINECONE_PROJECT_ID` or
`PINECONE_EXPECTED_HOST_SUFFIX`; when neither field resolves, the operator
instance is held to its built-in default project and an unnamed instance
to no guard. Readiness reports `disabled` first when the index name is
empty or the API key is missing. Otherwise it reports `project_mismatch`
when a named instance other than the operator instance has no resolved
guard, when the index host does not end with the suffix, or when the host
does not contain the `projectId` as that segment. In each of these
`project_mismatch` cases the memory provider refuses its guarded Pinecone
calls (they report `project_guard_failed` or throw `PINECONE_UNAVAILABLE`).
The chat runtime and the `memory_write` tool make those calls. Two other
searches resolve the same guard but do not refuse a missing one: when the
index host does not match, `knowledge_search` returns a tool error and the
Pinecone watch search (`createPineconeWatchSearch`) throws, and when no
guard resolves, both search unchecked. Readiness alone therefore does not
show that these searches were refused. On a chat instance, memory
consolidation does not start unless readiness is `ready`, while
enrichment, which needs only an index name, is still enabled. This
is the correct fail-safe: a wrong-project query returns unrelated data, which
is worse than no data.

---

## Worked example: rb-bot (RBLab project)

**Pinecone project:** RBLab (project id 921d6052, internal reference only)  
**Index host suffix:** `-example-project.svc.example-region.pinecone.io`\
**Indexes created:** `claude`, `codex`, `whatsapp-bot`, `rb-mind`

`~/.config/whatsoup/instances/rb-bot/config.json` (memory.pinecone block):

```json
"memory": {
  "pinecone": {
    "apiKeyEnv": "PINECONE_API_KEY",
    "expectedHostSuffix": "-example-project.svc.example-region.pinecone.io",
    "index": "whatsapp-bot",
    "allowedIndexes": ["whatsapp-bot", "claude", "codex", "rb-mind"],
    "knowledgeSearch": {
      "enabled": true,
      "allowGlobalAgentSessions": false
    },
    "knowledgeProfiles": {
      "whatsapp-bot": {
        "namespace": "",
        "namespaces": ["facts", "chunks", "summaries", "contacts"],
        "searchMode": "vector",
        "rerank": true,
        "rerankModel": "pinecone-rerank-v0",
        "topK": 20,
        "rerankTopN": 6,
        "description": "rb-bot WhatsApp conversation memory"
      },
      "claude": {
        "namespace": "",
        "namespaces": ["plans", "sessions"],
        "searchMode": "text",
        "rerank": false,
        "rerankModel": "",
        "topK": 10,
        "rerankTopN": 5,
        "description": "agent session history and plans"
      },
      "codex": {
        "namespace": "",
        "namespaces": ["sessions"],
        "searchMode": "text",
        "rerank": false,
        "rerankModel": "",
        "topK": 10,
        "rerankTopN": 5,
        "description": "Codex session history"
      },
      "rb-mind": {
        "namespace": "",
        "namespaces": ["facts", "chunks", "summaries", "contacts", "localDocs"],
        "searchMode": "vector",
        "rerank": true,
        "rerankModel": "pinecone-rerank-v0",
        "topK": 20,
        "rerankTopN": 6,
        "description": "Rachel's personal knowledge base"
      }
    }
  }
}
```

---

## KnowledgeProfileConfig schema reference

Each entry in `knowledgeProfiles` must satisfy:

| Field | Type | Required | Notes |
|---|---|---|---|
| `namespace` | string | yes | Primary namespace; use `""` to query the default. Searched only when `namespaces` is empty; otherwise it only widens the `namespace` override allowlist |
| `namespaces` | string[] | yes | Namespaces searched in order. For the instance's own memory index (`memory.pinecone.index`), the default namespace `__default__`, where `memory_write` writes, is always searched as well. Memory namespaces of that index are scoped to the calling conversation (this chat first; held to the group boundary in groups and, by default, to the chat itself in a non-admin contact's direct chat); document namespaces are merged in by relevance. See [Memory recall scope](../configuration.md#memory-recall-scope) |
| `searchMode` | `"entity"` \| `"text"` \| `"vector"` | yes | `entity` = structured records; `text` = BM25; `vector` = dense embedding |
| `rerank` | boolean | yes | Enable Pinecone rerank pass |
| `rerankModel` | string | yes | e.g. `"pinecone-rerank-v0"`; `""` when `rerank: false` |
| `topK` | number | yes | Initial candidate fetch count |
| `rerankTopN` | number | yes | Results returned after rerank |
| `minScore` | number | no | Finite score floor applied to ranked hits; an all-low-score result returns zero hits. |
| `description` | string | yes | Human-readable label shown in tool listing |
| `embedUrl` | string | no | Override embed endpoint; required for `vector` mode if non-standard |

An index name in `allowedIndexes` that references an undeclared built-in profile
(`oneplatform-search`, `oneplatform-entities`, `mw-mind`) produces a deprecation
warning in `src/config.ts` (expiry metadata: 2026-10-26); this check does not
reject the configuration and is not limited to non-mw instances. Declare a
custom profile with the same index name to bind retrieval to the intended
project. Project routing guards still apply independently.

---

## Provisioning a new bot memory layer

1. Create a Pinecone project in the console for the bot's principal (e.g., MLLab, EWLab).
2. Note the index host suffix from any index's host URL: everything from the hyphen before the short slug onward, for example `-example-project.svc.example-region.pinecone.io`.
3. Create required indexes (`whatsapp-bot` minimum; add `claude`/`codex`/`<name>-mind` as needed).
4. Install the API key:
   - Preferred: `security add-generic-password -s pinecone -a <username> -w <key>` at a GUI session.
   - Interim (SSH-only hosts): write key to `~/.config/pinecone/api_key` (mode 600) and inject via plist `bash -c "export PINECONE_API_KEY=$(cat $HOME/.config/pinecone/api_key); exec ..."`.
5. Add `expectedHostSuffix` and `allowedIndexes` + `knowledgeProfiles` to `config.json`.
6. Restart the bot and, with the health bearer token, verify `memory.readiness.state` in the authenticated `/health` diagnostic.

---

## Fleet readiness status (2026-06-11)

| Bot | Host | Project | Status |
|---|---|---|---|
| rb-bot | mini7 | RBLab | READY |
| ml-bot | mini8 | MLLab | project_mismatch — guard blocks, memory off |
| ew-bot | mini9 | EWLab | project_mismatch — guard blocks, memory off |

ml-bot and ew-bot activation is intentionally deferred until owner confirmation
(memory layer changes bot behavior). See OBJECTIVES row 18.
