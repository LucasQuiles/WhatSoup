# Handoff: Multi-Provider Runtime → Frontend Integration

**From:** L (lab agent) — backend provider abstraction
**To:** Frontend agent — console UI/UX integration
**Date:** 2026-04-04
**Branch:** `main` (pushed, 16 commits)

## What Was Built

A multi-provider runtime abstraction layer enabling WhatSoup instances to use different AI agent backends:

| Provider | CLI | Session Mode | Status |
|---|---|---|---|
| **Claude Code** | `claude` | Persistent stdin/stdout | ✅ Production (existing) |
| **Codex CLI** | `codex app-server` | Persistent JSON-RPC stdio | ✅ Proven (multi-turn memory) |
| **Gemini CLI** | `gemini --acp` | Persistent JSON-RPC stdio | ✅ Proven (quota-limited) |
| **OpenCode** | `opencode run --session` | Spawn-per-turn with resume | ✅ Proven (session continuity) |
| **OpenAI API** | HTTP | Managed loop (SSE) | ✅ Built (not live-tested) |
| **Anthropic API** | HTTP | Managed loop (SSE) | ✅ Built (not live-tested) |

## How Provider Selection Works (Backend)

### Instance Config (`~/.config/whatsoup/instances/<name>/config.json`)

```json
{
  "name": "besbot",
  "type": "agent",
  "agentOptions": {
    "sessionScope": "per_chat",
    "cwd": "~/agents/besbot",
    "provider": "codex-cli",
    "providerConfig": {
      "model": "gpt-5.4"
    }
  }
}
```

- `agentOptions.provider` — string, defaults to `"claude-cli"` when absent (backward compatible)
- `agentOptions.providerConfig` — optional object, provider-specific overrides

### Valid Provider IDs

| ID | Display Name | Type | Notes |
|---|---|---|---|
| `claude-cli` | Claude Code | CLI agent | Default, production |
| `codex-cli` | Codex CLI | CLI agent | Requires ChatGPT or OpenAI API key |
| `gemini-cli` | Gemini CLI | CLI agent | Requires GEMINI_API_KEY |
| `opencode-cli` | OpenCode | CLI agent | Uses OpenAI or Anthropic key |
| `openai-api` | OpenAI API | HTTP API | Direct API, no CLI needed |
| `anthropic-api` | Anthropic API | HTTP API | Direct API, no CLI needed |

### Provider Config Fields (per provider)

```typescript
interface ProviderConfig {
  provider: string;       // Provider ID from table above
  providerConfig?: {
    model?: string;       // Model override (e.g., "gpt-4o", "claude-sonnet-4-6")
    baseUrl?: string;     // API endpoint (API providers only)
    apiKeyService?: string; // Keyring service name for API key
    maxTokens?: number;   // Max output tokens (Anthropic only, default 16384)
    port?: number;        // Server port (OpenCode serve only, default 14096)
    binary?: string;      // CLI binary path override
    watchdog?: {          // Timeout overrides
      softMs?: number;
      warnMs?: number;
      hardMs?: number;
    };
  };
}
```

### Config Exports Available in Runtime

```typescript
// From src/config.ts:
config.agentProvider      // string, defaults to 'claude-cli'
config.agentProviderConfig // Record<string, unknown> | undefined
```

### Validation Rules (in instance-loader.ts)

- `provider` must be a non-empty string when present
- `providerConfig` must be a plain object when present (not array, not null)
- Missing `provider` defaults to `'claude-cli'` — full backward compatibility

## What the Frontend Needs to Do

### 1. Add Provider Selection to AddLineWizard

**File:** `console/src/components/wizard/ConfigStep.tsx`

Currently the wizard has steps: Identity → Link → Model → Config → Review.
The Config step already handles `agentOptions` (cwd, sessionScope, sandboxPerChat, plugins).

Add a **Provider** section to the Config step (or as a new sub-step) for `type: "agent"` instances:

```
Provider:  [Claude Code ▾]  ← dropdown with provider IDs
Model:     [gpt-5.4      ]  ← text input, optional
```

**UI Behavior:**
- Only shown when instance type is `"agent"` (not `"chat"` or `"passive"`)
- Default selection: "Claude Code" (`claude-cli`)
- When provider changes, show provider-specific config fields:
  - `claude-cli`: model, plugins (existing UI already handles this)
  - `codex-cli`: model
  - `gemini-cli`: model
  - `opencode-cli`: model
  - `openai-api`: model, baseUrl, apiKeyService
  - `anthropic-api`: model, baseUrl, maxTokens, apiKeyService

### 2. Add Provider Selection to EditConfigModal

**File:** `console/src/components/EditConfigModal.tsx`

The edit modal already has a "Config" tab that shows `agentOptions`. Add provider selection to the agent options section:

```
Agent Options
├── Working Directory: [~/agents/besbot]
├── Session Scope:     [per_chat ▾]
├── Provider:          [Codex CLI ▾]     ← NEW
├── Model:             [gpt-5.4  ]       ← NEW (from providerConfig)
└── Plugins:           [✓ Superpowers ...]
```

### 3. Show Provider in Instance List / Dashboard

**File:** `console/src/components/LineTags.tsx` or `ModeBadge.tsx`

Show the active provider as a badge/tag on each instance card:

```
besbot  [agent] [codex-cli]  ● healthy
lab     [agent] [claude-cli] ● healthy
loops   [chat]               ● healthy
```

For `type: "agent"` instances, show the provider badge. For `type: "chat"`, no provider badge needed.

### 4. API Surface

**Existing fleet API endpoints that handle config:**

| Endpoint | Method | What it does |
|---|---|---|
| `GET /api/lines/:name` | GET | Returns instance details including `config` |
| `PATCH /api/lines/:name/config` | PATCH | Updates instance config (merges into existing) |
| `POST /api/lines` | POST | Creates new instance (AddLineWizard) |

The `config` object flows through as-is — the frontend just needs to include `agentOptions.provider` and `agentOptions.providerConfig` in the config payload. No new backend endpoints needed.

**Example PATCH to switch provider:**
```json
PATCH /api/lines/besbot/config
{
  "agentOptions": {
    "provider": "codex-cli",
    "providerConfig": { "model": "gpt-5.4" }
  }
}
```

**Important:** Changing the provider requires a service restart to take effect. The frontend should show a "Restart required" notice after changing provider config.

### 5. Health Endpoint Enhancement

The health endpoint (`GET /health` on instance health port) should expose the active provider. Currently it returns:

```json
{
  "status": "healthy",
  "instance": { "name": "besbot", "mode": "agent" }
}
```

**Suggested enhancement** (backend work, not frontend):
```json
{
  "status": "healthy",
  "instance": { "name": "besbot", "mode": "agent", "provider": "codex-cli" }
}
```

This would let the dashboard show the actual running provider vs the configured one.

## Key Files to Read

| File | What's There |
|---|---|
| `src/runtimes/agent/providers/types.ts` | All TypeScript types — ProviderDescriptor, ProviderConfig, execution modes |
| `src/config.ts:230-231` | Where `agentProvider` and `agentProviderConfig` are exported |
| `src/instance-loader.ts:37-39,148-160` | Validation rules for provider fields |
| `console/src/components/wizard/ConfigStep.tsx` | Existing agent options UI — add provider here |
| `console/src/components/EditConfigModal.tsx` | Existing edit UI — add provider here |
| `console/src/components/AddLineWizard.tsx` | Wizard flow — may need provider in Review step |

## Design Decisions Already Made (Don't Revisit)

1. **Provider ID is a string, not an enum** — allows custom/future providers without code changes
2. **Default is `claude-cli`** — backward compatible, existing instances work without config changes
3. **providerConfig is `Record<string, unknown>`** — flexible per-provider config without shared schema
4. **Provider change requires restart** — no hot-swap (agent session holds provider state)
5. **CLI providers need the binary installed** — the UI should NOT install binaries; show error if missing

## What's NOT Built Yet (Out of Scope for Frontend)

1. **Provider registry API** — no endpoint to list available providers. Hardcode the list in the frontend for now.
2. **Binary availability check** — no API to check if `codex`/`gemini`/`opencode` is installed. Could be added to health endpoint.
3. **API key management** — provider API keys come from GNOME Keyring, not from the UI. The UI can show which keyring service is needed but can't set keys.
4. **Hot provider switching** — changing provider requires restart. The UI should make this clear.
5. **Provider-specific monitoring** — no per-provider metrics/dashboard yet.

## Test Coverage

- 178 provider unit tests (parsers, budget, mapping, bridges, conformance, anti-duplication, hardening)
- 3057 full regression tests
- 0 failures
- Anti-duplication enforcement tests prevent re-introducing code duplication
- Hardening tests verify security invariants (env allowlists, file permissions)

## Quick Start for Frontend Dev

1. Read `console/src/components/wizard/ConfigStep.tsx` — this is where provider selection goes
2. The `agentOptions` object in `formData` already flows to/from the API
3. Add `provider` and `providerConfig` fields to the form
4. Use a `<SelectInput>` for provider selection (see existing `sessionScope` dropdown for pattern)
5. Conditionally render `providerConfig` fields based on selected provider
6. Show provider badge in instance list via `LineTags.tsx` or `ModeBadge.tsx`
