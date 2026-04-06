# Bead: B03-config-schema
**Status:** pending
**Type:** implement
**Runner:** sonnet-implementer
**Dependencies:** [B01]
**Scope:** src/config.ts, src/runtimes/agent/runtime.ts
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/multi-provider-runtime-2026-0404/beads/B03-decision-trace.md
**Deterministic checks:** []
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
Add provider configuration to the instance config schema. The config should support:

```json
{
  "agentOptions": {
    "provider": "claude",
    "providerConfig": {
      "binary": "claude",
      "model": "sonnet",
      "pluginDirs": []
    }
  }
}
```

For API providers:
```json
{
  "agentOptions": {
    "provider": "openai-api",
    "providerConfig": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o",
      "apiKeyService": "openai"
    }
  }
}
```

For local LLMs:
```json
{
  "agentOptions": {
    "provider": "openai-api",
    "providerConfig": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "llama3",
      "apiKeyService": null
    }
  }
}
```

Default to `"provider": "claude"` when not specified (backward compatible).

## Output
- Updated config.ts with provider schema
- runtime.ts reads provider config and passes to session manager
- Provider registry that maps provider names to implementations
