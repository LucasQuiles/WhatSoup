# OpenAI-Compatible BYO-Key Providers — Current Surfaces and Operator Guidance

Date: 2026-07-04 · Audited source revision: `9a38a643` (all file:line references below are anchored to this commit; refreshed from the 2026-07-03 draft)

## Decision

**Use the existing OpenAI-compatible surfaces; do not add provider IDs for Groq, OpenRouter, or NVIDIA.** Agent-side routing to Groq or OpenRouter is available today through the `openai-api` provider with per-instance `providerConfig` — this is configuration and operator policy, not new provider work. NVIDIA, Cerebras, and per-instance credential isolation are **not** current working recipes (see Blocked/Future). Policy constraints in this note are operator guidance, not runtime enforcement: nothing in WhatSoup stops a config from pointing a production chat instance at a dev-lane endpoint.

## Integration seams (current state)

| Seam | Source (`9a38a643`) | Current capability | Operational implication | Blocked/future |
|---|---|---|---|---|
| Agent HTTP provider | `src/runtimes/agent/providers/openai-api.ts:107-110, 290-304, 350-405` | `providerConfig.baseUrl` endpoint override (default `https://api.openai.com/v1`); SSE streaming with tool-call delta accumulation; managed MCP tool loop | Any OpenAI-compatible endpoint works per instance; streaming + tool-call *parity of the remote endpoint* is unproven until piloted | Per-endpoint feature parity needs pilot evidence |
| API fallback config inheritance | `src/runtimes/agent/fallback-config.ts:19-27` | Fallback entries into `openai-api`/`anthropic-api` inherit the **instance-level** providerConfig | One custom baseUrl per instance; multiple `openai-api` fallback entries all hit the same endpoint | Per-entry providerConfig requires schema/validator/runtime/tests work |
| Fallback model requirement | `src/core/agent-config-validator.ts:519-523` | API-provider fallback entries must set `fallbacks[].model` | The model anchor is `fallbacks[].model` (or legacy `fallbackModel`) — **not** `providerConfig.model`; the runtime supplies the entry model to the session | — |
| providerConfig validation | `src/core/agent-config-validator.ts:614-647, 656-672` | `baseUrl` must be valid http(s) URL; `apiKeyService` must be a known service; `apiKeyService` without `baseUrl` rejected as inert; opencode-cli baseUrl requires a resolvable model (API providers exempt) | Config errors fail loud at load, before any traffic | — |
| Credential service map | `src/lib/provider-key-service.ts:26-66` | Accepted `apiKeyService` values incl. `groq`→`GROQ_API_KEY`, `openrouter`→`OPENROUTER_API_KEY` (also `openai`, `anthropic`, `deepseek`, `minimax`, `glm`, `xai`, `mistral`, `google`, `fireworks-ai`, `togetherai`) | Provider-level keys only; `nvidia`, `cerebras`, and per-instance names like `whatsoup-groq-q` are rejected | Service-map + credential-contract work for new services / per-instance isolation |
| Fallback selection + credential presence | `src/runtimes/agent/runtime.ts:5364-5423, 6003-6044` | Per-window eligibility via keyring presence; `fallback_credential_missing` alert; first-arm pre-flight probes validity async, `fallback_credential_invalid` on 401/403 | Missing keys surface as alerts, not silent failures | — |
| Credential validity probe limitation | `src/runtimes/agent/providers/credential-verify.ts:15-25` | Hardcoded probe URLs for `deepseek`, `minimax`, `openai` only; others fail open | Groq/OpenRouter keys get **presence** checks only — an invalid key is discovered at first use. Health/parity green ≠ endpoint validity | Optional probe entries per new endpoint (must be proven to 401/403 on bad keys) |
| OpenCode custom endpoint | `src/core/provider-mcp-config.ts:123-149`, `src/runtimes/agent/session.ts:187-215, 282-294, 886-894` | `providerConfig.baseUrl` (+ optional `providerId`, `model`, `apiKeyService`) written into opencode.json with `{env:VAR}` interpolation — key value never lands on disk; `-m` omitted, model comes from opencode.json | Second config-only lane for custom endpoints, via the opencode-cli harness | — |
| Chat runtime (env-only) | `src/runtimes/chat/providers/openai.ts:33-65`, `src/runtimes/chat/providers/transcription/openai-whisper.ts:17-24, 70-74`; OpenAI SDK 5.23.2 reads `OPENAI_BASE_URL` | Bare `new OpenAI()` — SDK env defaults apply | `OPENAI_BASE_URL` repoints the WHOLE process, including Whisper voice-note transcription. Too blunt for production chat routing; not recommended | Per-provider baseUrl/key config + Whisper separation requires code |

## Supported current recipes

### Groq as an agent fallback rung

```jsonc
"agentOptions": {
  "provider": "claude-cli",
  "fallbacks": [
    { "provider": "openai-api", "model": "llama-3.3-70b-versatile" }  // model REQUIRED here
  ],
  "providerConfig": {
    "baseUrl": "https://api.groq.com/openai/v1",
    "apiKeyService": "groq"           // key from keyring service "groq" (env GROQ_API_KEY consulted first)
  }
}
```

### OpenRouter as a multi-model aggregation rung

Multiple `openai-api` fallback entries are valid **because they share the one inherited baseUrl** — OpenRouter routes per model ID. This does not enable Groq + NVIDIA + OpenRouter in one instance.

```jsonc
"fallbacks": [
  { "provider": "openai-api", "model": "meta-llama/llama-3.3-70b-instruct" },
  { "provider": "openai-api", "model": "qwen/qwen-2.5-72b-instruct" }
],
"providerConfig": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKeyService": "openrouter"
}
```

Operator obligations for OpenRouter with real chat traffic (dated 2026-07-04, [provider-logging docs](https://openrouter.ai/docs/guides/privacy/provider-logging)): disable "allow training providers" in account settings (separate toggles for paid vs free models) — downstream providers have their own data policies; OpenRouter's table flags DeepSeek, NVIDIA, OpenInference, Poolside, Stealth as may-train.

### OpenCode custom endpoint (by analogy to the existing `glm` pattern)

`agentOptions.provider: "opencode-cli"` with `providerConfig: { baseUrl, providerId, model, apiKeyService }` — generated into opencode.json with `{env:...}` key interpolation (`provider-mcp-config.ts:123-149`). A model is required (validator rejects an inert endpoint). The operator's global `~/.config/opencode/opencode.json` `glm` block is the working reference; do not mutate it as part of this note.

### Chat runtime (documented caveat, not a recipe)

`OPENAI_BASE_URL` in a chat instance's environment repoints the entire process (SDK 5.23.2 env default), including Whisper transcription and the `FALLBACK_MODEL` retry path. Dev experimentation only; production chat routing to alternate endpoints needs per-provider config work.

## Credential handling — operator caveats

- Resolution order for a configured service: mapped provider env var, then keyring/file (`lookupCredential`), and `resolveApiKey` can final-fallback to `OPENAI_API_KEY` (`api-key-resolver.ts`). An env var like `GROQ_API_KEY` set process-wide **shadows** the keyring entry.
- Treat the log warning `apiKeyService configured but keyring lookup missed — falling back to env var` (QR-104) as a **failed isolation check** during pilots, not harmless noise: it means the instance is running on the global `OPENAI_API_KEY`, possibly the wrong account.
- Keys never belong in config files or argv; the opencode lane's `{env:VAR}` interpolation exists precisely so values never land on disk.

## Blocked / future work (code, not docs)

1. **NVIDIA (`https://integrate.api.nvidia.com/v1`) and Cerebras**: `apiKeyService: "nvidia"` / `"cerebras"` fail validation — absent from `SERVICE_ENV_MAP`. Needs service-map entries, an endpoint-specific pilot, and optionally a credential validity probe (only endpoints proven to 401/403 on bad keys qualify).
2. **Per-instance credential names** (`whatsoup-<provider>-<instance>`): rejected by the validator today; needs a dynamic service-name policy or a changed credential lookup contract. Not solvable by documentation.
3. **Per-entry providerConfig** (Groq + NVIDIA + OpenRouter in one chain): fallback-entry schema, validator, runtime selection, health surfaces, and tests.
4. **Chat runtime per-provider baseUrl/key** with Whisper separation.

## Policy lanes (operator guidance, dated 2026-07-04)

Verified against primary sources on 2026-07-04; treat as dated guidance, not permanent fact.

- **Production chat traffic (third-party personal data):** Groq with Zero Data Retention enabled ([your-data docs](https://console.groq.com/docs/your-data): no training on inputs/outputs, no default retention); Gemini **paid** tier where appropriate; OpenRouter only with no-training routing controls and provider selection discipline.
- **Dev/test/non-personal data only:** NVIDIA API catalog free tier ([Trial ToS](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf): trial/internal-testing only, production use and personal-information upload barred), Gemini unpaid tier ([terms](https://ai.google.dev/gemini-api/terms): content used for improvement; "do not submit … personal information"), DeepSeek direct, and similar free/bulk lanes.

## Owner-gated pilot gate

Config shapes in this note were statically validated against `validateInstanceConfig` at `9a38a643` on 2026-07-04: both recipes accepted verbatim; `apiKeyService: "nvidia"`, `"whatsoup-groq-q"`, a model-less `openai-api` fallback entry, and `apiKeyService` without `baseUrl` all rejected with the errors described above. That is config-shape evidence only — no live endpoint has been exercised today. Before any fleet instance relies on it, one dev agent instance must pass, with results recorded (endpoint, model, service, source revision, date):

1. **Static gate:** `validateInstanceConfig` accepts the pilot config; a mutation with `apiKeyService: "nvidia"` is rejected (proves the gate is live).
2. Intended service credential present — no QR-104 fallback warning in logs.
3. One live streaming turn succeeds.
4. One MCP tool-call turn succeeds.
5. Forced fallback window serves a reply and emits expected health/notice fields (`fallback_active`, notice dedup).
6. 429/timeout behavior observed (note: `Retry-After` honored only up to 10s — `rate-limit-retry.ts:1`; longer waits fail the turn into the chain), or explicitly marked untested.

### Observed endpoint behavior (2026-07-03, no credentials, invalid test key)

- Config-load surface driven live on 2026-07-03: `npm run guard:instance-config -- --root <tree>` accepted both recipes verbatim and rejected the NVIDIA anti-recipe with the SERVICE_ENV_MAP error. The guard also enforces the per-host health-port band `[9090, 9098]` — pilot instance configs must use in-band ports.
- `POST chat/completions` with an invalid key → clean HTTP 401 on all three: Groq (`{"error":{...,"code":"invalid_api_key"}}`), OpenRouter (`{"error":{"message":"Missing Authentication header","code":401}}`), NVIDIA (`{"status":401,"title":"Unauthorized"}`). All three would qualify for a future `credential-verify.ts` probe **only via chat/completions**.
- `GET /models` discriminates keys **only on Groq** (401). OpenRouter and NVIDIA serve `/models` publicly (HTTP 200 with full OpenAI-shape model list even with an invalid key) — a `/models`-style probe there would fail open and never detect a bad key.
