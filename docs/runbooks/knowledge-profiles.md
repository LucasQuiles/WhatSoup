# Knowledge Profiles — Fleet Memory Configuration

Reference for configuring `memory.pinecone` in per-bot `config.json` files.
Covers the host-suffix guard, `allowedIndexes`, and `knowledgeProfiles` for
per-principal bots whose Pinecone project is separate from the mw-only built-ins.

---

## Background

The bot's knowledge search tool (`knowledge_search`) queries Pinecone indexes
that are declared in `memory.pinecone.allowedIndexes`. For each index name in
that list, a matching entry in `memory.pinecone.knowledgeProfiles` (or a
built-in profile) must exist — the config validator enforces this.

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
    "expectedHostSuffix": "qkdgrnz.svc.aped-4627-b74a.pinecone.io"
  }
}
```

**Do not set `projectId`** (the UUID form). The host URL embeds a short slug,
not the project UUID, so `host.endsWith(projectId)` would never match. Use
the suffix from the Pinecone console's index host field.

Setting a wrong or missing suffix causes `pineconeReadiness` to report
`project_mismatch` and the memory layer is disabled for that instance. This
is the correct fail-safe: a wrong-project query returns unrelated data, which
is worse than no data.

---

## Worked example: rb-bot (RBLab project)

**Pinecone project:** RBLab (project id 921d6052, internal reference only)  
**Index host suffix:** `qkdgrnz.svc.aped-4627-b74a.pinecone.io`  
**Indexes created:** `claude`, `codex`, `whatsapp-bot`, `rb-mind`

`~/.config/whatsoup/instances/rb-bot/config.json` (memory.pinecone block):

```json
"memory": {
  "pinecone": {
    "apiKeyEnv": "PINECONE_API_KEY",
    "expectedHostSuffix": "qkdgrnz.svc.aped-4627-b74a.pinecone.io",
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
| `namespace` | string | yes | Primary namespace; use `""` to query the default |
| `namespaces` | string[] | yes | Additional namespaces searched in order |
| `searchMode` | `"entity"` \| `"text"` \| `"vector"` | yes | `entity` = structured records; `text` = BM25; `vector` = dense embedding |
| `rerank` | boolean | yes | Enable Pinecone rerank pass |
| `rerankModel` | string | yes | e.g. `"pinecone-rerank-v0"`; `""` when `rerank: false` |
| `topK` | number | yes | Initial candidate fetch count |
| `rerankTopN` | number | yes | Results returned after rerank |
| `description` | string | yes | Human-readable label shown in tool listing |
| `embedUrl` | string | no | Override embed endpoint; required for `vector` mode if non-standard |

An index name in `allowedIndexes` that references a built-in profile name
(`oneplatform-search`, `oneplatform-entities`, `mw-mind`) is rejected by the
config validator for non-mw bots — those profiles target the mw project's
host. Declare a custom profile with the same index name to override.

---

## Provisioning a new bot memory layer

1. Create a Pinecone project in the console for the bot's principal (e.g., MLLab, EWLab).
2. Note the index host suffix from any index's host URL (everything from the short slug onward).
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
