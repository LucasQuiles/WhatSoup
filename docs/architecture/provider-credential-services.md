# Provider credential services — extension guide

How WhatSoup names, validates, resolves, and probes API-key services for
custom OpenAI-compatible endpoints, and the exact touchpoints for adding a
new service (e.g. `nvidia`). Operator-facing recipes live in
[docs/configuration.md — Custom endpoint](../configuration.md#custom-endpoint-providerconfigbaseurl);
this note is for maintainers changing the surface itself.

## The single source of truth

`SERVICE_ENV_MAP` (`src/lib/provider-key-service.ts`) is the one code-enforced
"known service" list. Its direct consumers:

| Consumer | Effect |
|---|---|
| `src/core/agent-config-validator.ts` (`apiKeyService` rule) | unknown service → config rejected at create/update and at load/discovery |
| `src/core/provider-mcp-config.ts` | service → `{env:VAR}` interpolation in the generated opencode.json (key value never lands on disk) |
| `src/lib/keyring.ts` (`lookupCredential`) | service → mapped env var consulted before the platform keyring |

A service is not a provider ID: `nvidia` would be reached as
`provider: openai-api` + `providerConfig: { baseUrl, apiKeyService: "nvidia" }`;
`PROVIDER_IDS` / `API_PROVIDER_IDS` in the validator stay untouched.

## Adding a service — the full checklist

1. **Map it.** Add `<service>: '<ENV_VAR>'` to `SERVICE_ENV_MAP`. This alone
   wires validation, opencode env interpolation, and keyring lookup.
2. **Reconcile the tests that flip by design.** They are the forcing
   function, and the local push gate runs them (`verify:push:branch`):
   - `tests/lib/provider-key-service.test.ts` — exact-map lock.
   - `tests/core/agent-config-validator-crossfield.test.ts` — `nvidia` and
     `cerebras` are pinned as rejected-until-mapped; unpin only the service
     you mapped.
3. **Decide probe coverage.** `CREDENTIAL_PROBE_DESCRIPTORS` in
   `src/lib/provider-credential-probes.ts` — the single shared map consumed by
   both the arm-time pre-flight (`src/runtimes/agent/providers/credential-verify.ts`)
   and the fleet `/verify` route (`src/fleet/routes/providers.ts`). Qualification
   rule: only an endpoint proven to return 401/403 on a bad key belongs there —
   a mute probe fails open forever, and OpenRouter and NVIDIA serve
   `GET /models` publicly (HTTP 200 with an invalid key). No entry means
   presence-only pre-flight: `fallback_credential_invalid` can never fire for
   the service. If you add a probe, update the descriptor and the
   mapped-but-unprobed lock in
   `tests/runtimes/agent/providers/credential-verify.test.ts`. (Doc-sync note:
   the probe list stated here and in the design note is NOT independently
   guard-enforced — `tests/lib/provider-service-doc-sync.test.ts` parses
   `docs/configuration.md` only. Reconcile this file's mentions by hand.)
4. **Reconcile the hand-maintained doc lists**:
   - `docs/configuration.md` — the env-var table in "Enabling provider
     fallback on a new host" and the probed/no-probe service lists in the
     fallback pre-flight prose. These are guard-enforced by
     `tests/lib/provider-service-doc-sync.test.ts` (runs in the push gate):
     listed entries must match `SERVICE_ENV_MAP` and the behaviorally derived
     probe set, so a stale entry fails the gate rather than drifting.
   - `docs/specs/2026-07-03-openai-compatible-byok-providers-design.md` —
     seam table and Blocked/future section (internal, publication-excluded).
5. **Pilot before fleet use.** The design note's owner-gated pilot gate:
   static validation, credential isolation (no QR-104 warning), one streaming
   turn, one MCP tool-call turn, forced-fallback canary, observed 429
   behavior.

## Traps

- **Key resolution order**
  (`src/runtimes/agent/providers/api-key-resolver.ts`): inline → service
  lookup (mapped env var first, then keyring) → provider-family env fallback
  (`OPENAI_API_KEY` for `openai-api`, `ANTHROPIC_API_KEY` for
  `anthropic-api`). The last hop is the cross-account bleed risk; it logs the
  QR-104 isolation warning when it yields a key.
- **`providerConfig` is instance-scoped** and inherited by API-type fallback
  entries (`src/runtimes/agent/fallback-config.ts`) — one custom `baseUrl`
  per instance; per-entry `providerConfig` is future schema/validator/runtime
  work.
- **`Retry-After` cap** is 10 seconds
  (`src/runtimes/agent/providers/rate-limit-retry.ts`); a longer wait fails
  the turn into the fallback chain.
- **The chat runtime is env-only** (`src/runtimes/chat/providers/openai.ts`):
  `OPENAI_BASE_URL` repoints the whole process, including Whisper voice-note
  transcription — there is no per-provider chat config today.
