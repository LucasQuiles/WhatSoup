# WhatSoup Twilio Transport — Design Spec

**Status:** DRAFT for review · **Date:** 2026-06-10
**Intended repo home:** `WhatSoup/docs/specs/2026-06-10-twilio-transport-design.md`
(written to a neutral path because the current checkout is a dirty shared worktree on
`chore/ff038-eslint-ring`; implementation will land on a clean dedicated branch).

## 0. Grounding corrections (post-spec code review — supersedes conflicting text below)
After reading the real contract (`src/transport/contract/*`, `src/core/transport-refs.ts`,
`src/transport/testing/minimal-text.ts`), three corrections:
- **Channel model, not extension strings.** `Capabilities.extensions` is a *closed* `ExtensionName`
  enum (`media|voice-notes|reactions|edit|delete|typing|presence|groups|read-receipts|inline-keyboards|outbound-status`)
  — it has **no** `'sms'`/`'voice'`. A Twilio channel is a new **`ChannelKind`**. `ChannelKind` is
  `'whatsapp'|'telegram'` today with `// future: … 'sms'` already noted → **add `'sms'`**.
  `ChannelId` is branded `${kind}:${account}` via `makeChannelId('sms', account)`.
- **Adapter template = `MinimalTextAdapter`** (only Baileys is implemented; Telegram is aspirational).
  Build `Capabilities` exactly like it: `{channel, kind, extensions:new Set(), maxTextLength, auth:'token', readReceipts:'none', reactions:'none', media:{maxBytes,mimeAllowlist}, idempotency:{…}}`.
- **Inbound is the rich `InboundMessage`** (`ref, conversation, sender, fromMe, text, attachments,
  timestamp, inboundEventKey, transportTimestamp, ingestSeq`). Voicemail/transcript → an
  `InboundMessage` with a `'voice'` `AttachmentRef` + `text` = transcript. Delivery status →
  `OutboundStatusEvent`. **Voice is a separate channel-kind concern (Stage 2), not an `extensions` entry.**

The capability/extension phrasing in §4–§6 below is superseded by this section.

## 1. Context & motivation
WhatSoup is a config-first, model-agnostic WhatsApp/agent fleet (TypeScript/ESM, Node 24,
Vitest, Zod, Pino). It already has a `TransportAdapter` seam (Baileys today), a provider
registry with failover (`PROVIDER_IDS` → validator → loader → exhaustive switch → `backupAgent`),
a keyring + per-process credential allowlist, and an enforcement layer
(`eslint.config.fitness.mjs` + `scripts/lib/fitness/registry.ts`: `arch.ring-boundaries`,
`arch.approved-api-client`, `invariant.no-unsafe-type-escapes`, `invariant.fail-closed-scanner`).

This spec adds an **optional, portable Twilio transport** (SMS + Voice) as a peer to Baileys,
mirroring the provider/failover config-first pattern, and **extends the enforcement layer** with
Twilio-specific invariants plus an unattended-agent self-review/escalation contract. The goal is
to make this surface safe for autonomous coding agents to inspect/modify/improve.

## 2. Goals / Non-goals
**Goals**
- A `TransportAdapter` Twilio implementation, opt-in via config, off by default, no host-specific assumptions (portable).
- Config-first end to end: frozen registry → `agent-config-validator` rules → `config.ts` loader/defaults → exhaustive `assertNeverTransport` switch → adapter → mock → tests.
- SMS (two-way) on the existing contract; Voice via a capability-gated extension.
- Enforcement extensions that bind to this surface (credential gate, signature-required, consent/A2P guard, destructive-op gate, config invariants, per-iteration self-review, bounded-repair + escalation).

**Non-goals (deferred)**
- Webhook-driven **live voice AI** (ConversationRelay / `wss` bridge).
- Console/front-end surfacing of Twilio status.
- Outbound marketing/campaign tooling; A2P brand registration flow (separate concern).
- Any host-specific ingress/tunnel solution (operator concern, out of scope).

## 3. Approved key decisions
- **D1 — Portable optional transport.** Instantiated only when `transport: "twilio"`. Generic; no mini8/Tailscale/account assumptions. Examples use placeholders.
- **D2 — Voice as capability extension.** SMS maps to `sendText()`/`on('message')`. Voice via `VoiceCapableTransport` (`placeCall()`, `on('call')`, `on('voicemail')`), gated by `capabilities.extensions.has('voice')`. **Inbound voicemail → transcribed `InboundMessage`** so agents consume it as text on the existing path. Outbound calls are an explicit gated method, never overloaded onto `sendText`.
- **D3 — Inbound mode is config.** `inboundMode: 'webhook' | 'poll'`, default `webhook` (canonical). `webhook` = signature-validated endpoint, **required for live inbound voice**. `poll` = zero-ingress; lists Messages/Recordings on an interval (SMS + recorded voicemail-after-the-fact). Operator picks per deployment.

## 4. Architecture & ring placement
- Lives in `src/transport/twilio/` (Ring: *transport* — below `core`, consumed by `runtimes`). `arch.ring-boundaries` governs it automatically; no new ring needed.
- Implements existing `src/transport/contract/adapter.ts` `TransportAdapter`; consumers (`runtimes/agent`, `runtimes/chat`) unchanged.
- A new optional `VoiceCapableTransport` interface in `src/transport/contract/voice.ts` (extends nothing; queried via capabilities). `TwilioAdapter implements TransportAdapter, VoiceCapableTransport`.
- Selected by an exhaustive `switch (config.transport)` in the connection factory (`src/main.ts`), with `assertNeverTransport`.

## 5. Config schema (mirror provider registry)
- `src/transport/registry.ts` — `export const TRANSPORT_IDS = Object.freeze(['baileys','twilio'] as const)`, `isTransportId`, `assertNeverTransport`.
- `src/transport/twilio/types.ts` — `TwilioConfig` interface + `DEFAULT_TWILIO_CONFIG`.
- Instance config gains optional `transport?: TransportId` (default `'baileys'`) and `twilioConfig?`.

```jsonc
{
  "transport": "twilio",
  "twilioConfig": {
    "accountSid": "AC…",                 // SID prefix-validated
    "authTokenService": "twilio-auth",   // keyring service name (never inline token)
    "phoneNumber": "+1…",                // E.164-validated
    "messagingServiceSid": "MG…",        // optional; preferred sender if present
    "inboundMode": "webhook",            // 'webhook' | 'poll'
    "webhookUrl": "https://…/twilio",    // required iff inboundMode=webhook
    "pollIntervalMs": 15000,             // used iff inboundMode=poll
    "capabilities": { "sms": true, "voice": false, "voiceTranscription": false },
    "rateLimit": { "smsPerMinute": 30, "callsPerMinute": 5 },
    "failover": { "enabled": false }     // backupAgent-shaped proof block
  }
}
```

**Validation rules** (in `src/core/agent-config-validator.ts`, run at load/create/patch/discovery):
- `transport ∈ TRANSPORT_IDS`.
- if `transport==='twilio'`: `twilioConfig` is an object; `accountSid` matches `^AC[0-9a-f]{32}$`; `phoneNumber` is E.164 (`^\+[1-9]\d{6,14}$`); `authTokenService` non-empty string.
- `messagingServiceSid` (if present) matches `^MG[0-9a-f]{32}$`.
- `inboundMode ∈ {webhook,poll}`; if `webhook`, `webhookUrl` is required and `https`; if `poll`, `pollIntervalMs ≥ 5000`.
- **Coherence**: `capabilities.voice===true` with `inboundMode==='poll'` ⇒ live inbound voice unsupported → must set `voiceTranscription` (recorded-only) or `inboundMode==='webhook'`. Validator errors with the exact remediation.
- No inline `authToken` / `accountSid`-with-secret permitted (fail-closed; credential gate).

## 6. TransportAdapter implementation (`src/transport/twilio/adapter.ts`)
- `capabilities`: `{ media:false, 'voice-notes':false, reactions:false, edit:false, delete:false, extensions: Set(['sms', ...(voice?['voice']:[])]) }`.
- `connect()`: resolve token via `lookupCredential(authTokenService)`; validate with a cheap GET (`/Accounts/{sid}`); set health; if webhook mode, register signature-validated routes on the WhatSoup HTTP server; if poll mode, start the poll loop.
- `sendText(target,text,opts)`: `messages.create({ To, From|MessagingServiceSid, Body })` → `MessageRef{ jid: message.sid }`. Consent/A2P guard runs first (§8).
- `on('message')`: inbound SMS (webhook or poll) → `InboundMessage`.
- `disconnect()`, `state()` (maps to `AdapterState`), `selfRef()`.

**Voice (`VoiceCapableTransport`)**
- `placeCall(target, { say?: string, twiml?: string })` → call SID; consent/A2P guard first; gated by `capabilities.voice`.
- `on('voicemail', handler)`: recorded inbound call → fetch recording + (if `voiceTranscription`) transcript → emit as `InboundMessage` with media/transcript so the agent path is unchanged.
- Live inbound answer requires `inboundMode==='webhook'` (Twilio fetches TwiML on call); in `poll` mode, Twilio-hosted TwiML answers out-of-band and WhatSoup ingests recordings.

## 7. Credentials & security
- Tokens **only** via keyring (`src/lib/keyring.ts`) / env fallback through `resolveApiKey`. Never inline, never logged, never on argv.
- Extend the per-process credential allowlist (`buildChildEnv`) so `TWILIO_AUTH_TOKEN` is never leaked to child processes implicitly.

## 8. Agent-safety enforcement extensions (the envelope)
New **fitness rules** (`scripts/lib/fitness/registry.ts`, ESLint-ring) + config/runtime invariants — coordinate with active `chore/ff038-eslint-ring`:
- `transport.twilio-credential-gate` — token/SID never logged/argv/child-env without allowlist (extends `fail-closed-scanner`).
- `transport.webhook-signature-required` — any inbound Twilio webhook handler must call signature validation; missing ⇒ BLOCKING.
- `invariant.no-outbound-without-consent` — outbound `messages.create`/`calls.create` must pass through a consent/A2P state check (encodes STOP/30034/quiet-hours); call-sites lacking it ⇒ BLOCKING.
- `transport.destructive-op-gate` — number release, subaccount close, function delete, brand/campaign mutation require an explicit `ALLOW_TWILIO_MUTATIONS` env gate (mirrors `ALLOW_M365_MUTATIONS`); ungated ⇒ BLOCKING.
- Config-invariant guards (E.164 / SID prefixes / https / mode-capability coherence) — surfaced at validate-time with remediation text.
- **Per-iteration self-review artifact** (`docs/runbooks/twilio-self-review.md` template + a guard): unattended agents touching `src/transport/twilio/**` must emit a block — *changed · invariant-preserved · checks-passed · checks-failed · residual-risk · decision(continue|retry|rollback|escalate)*. A `guard:twilio-self-review` check **fails the iteration if absent or malformed**.
- **Bounded-repair + escalation**: agents may auto-repair only within `src/transport/twilio/**` + its tests. **Must stop & escalate** on: a destructive Twilio op, an `[UNVERIFIED]`/`[TIP]` KB fact used as ground truth, missing creds, A2P/consent ambiguity, or N consecutive failing checks (N configurable; default 2).

Every check emits **what failed / why it matters / where (file:line) / remediation path** — consistent with existing fitness-rule output.

## 9. Failover, health, error mapping
- Health via existing `AdapterState` (`connected`/`degraded`/`rate_limited`/`auth_required`/`exhausted`).
- Twilio→`TransportError`: 429/20429→`RateLimitedError`; 20003→`AuthRequiredError`; 30xxx→`PermanentProviderError`; transient 5xx→`TransientProviderError`.
- `failover` block is `backupAgent`-shaped (proof: differentCredential/differentMachine, `enabled:false` default). Diagnostic/readiness only in v1 (no auto-routing), mirroring `backupAgent`.

## 10. Testing strategy
- `src/transport/twilio/testing/mock.ts` — in-memory Twilio client double (no network), mirroring existing test doubles.
- `tests/transport/twilio/adapter.test.ts` — send/receive SMS, placeCall, voicemail→InboundMessage, health transitions, error mapping, consent-guard blocking, mode-coherence validation. Real Vitest, real sockets/SQLite per WhatSoup convention.
- `tests/config.test.ts` additions — twilio config resolution + every validator rule.
- New fitness rules get fixture tests under the fitness registry's test pattern.

## 11. Files touched
**Created:** `src/transport/registry.ts`, `src/transport/contract/voice.ts`, `src/transport/twilio/{types,adapter,inbound-poll,webhook-routes,consent-guard}.ts`, `src/transport/twilio/testing/mock.ts`, tests mirror, `docs/runbooks/twilio-transport.md`, `docs/runbooks/twilio-self-review.md`, fitness rules + fixtures.
**Modified:** `src/config.ts` (loader/defaults), `src/instance-loader.ts` (InstanceConfig fields), `src/core/agent-config-validator.ts` (rules), `src/main.ts` (transport switch), `src/transport/contract/capabilities.ts` (sms/voice extensions), `src/runtimes/agent/session.ts` (credential allowlist), `scripts/lib/fitness/registry.ts` (+rules), `docs/configuration.md` (Twilio section). Per PR discipline, runbook + config docs co-update in the same change.

## 12. Assumptions register
- A1: WhatSoup runs an HTTP server we can mount signature-validated Twilio routes on (health server exists). *Validate by reading the health-server module before webhook impl.*
- A2: `TransportAdapter` consumers don't assume Baileys-specifics that break for SMS. *Validate via the in-memory/minimal-text doubles + a Twilio mock conformance test.*
- A3: The `twilio` npm SDK is acceptable as an `arch.approved-api-client` entry (else use raw fetch). *Decide at impl; add to approved list with rationale.*
- A4: `ff038-eslint-ring` will land the ring/fitness infra this extends. *Coordinate; rebase onto it.*
- A5: Voicemail transcription uses Twilio's transcription (or a configured STT). *Confirm provider at impl; config-gate it.*

## 13. Validation rules / acceptance criteria
- `npm run typecheck` + `typecheck:all` clean; exhaustive switches compile (no `assertNever` reachable).
- `npm run guard:lint:src` clean incl. new fitness rules; ring-boundaries unviolated.
- `npm test` green incl. new adapter/config/fitness tests.
- A WhatSoup instance with `transport:"twilio"` (poll mode, SMS) sends + receives in a mock test; consent-guard blocks an unconsented send; mode-coherence validator rejects `voice+poll` without `voiceTranscription`.
- Self-review guard fails an iteration missing the artifact.
- Docs (`configuration.md` + runbooks) updated; no doc-drift guard failures.

## 14. Decomposition / open questions
- **In this spec:** SMS+Voice transport (webhook+poll, recorded voice), enforcement extensions, mock/tests/docs.
- **Delivered in stage 1 (PR #731):** SMS send + poll-mode inbound, config validation/loading, runtime factory + bridge, mock/tests/docs. The remaining spec scope was decomposed into later stages (see the stage 1 plan's decomposition section).
- **Delivered in stage 2 (this branch):** webhook inbound + signature validation (`TwilioWebhookServer`, `webhook-payloads.ts`), recorded voice + transcription (`contract/voice.ts`, `VoiceCapableTransport`, `placeCall`, voicemail TwiML + transcription webhook), `handleInboundRecord`/`handleTranscript` shared pipeline, bridge voice-attachment mapping + webhook server lifecycle, config validator webhook/voice unlock.
- **Deferred from stage 2:** outbound-status events (stage 1 confirms delivery via the inbound `fromMe` echo path; webhook status callbacks not built). Voicemail audio download (transcript text only; recording SID available but audio fetch not implemented). Live conversational voice (ConversationRelay/wss).
- **Deferred to stage 3 (enforcement envelope):** `transport.twilio-credential-gate`, `transport.webhook-signature-required`, `invariant.no-outbound-without-consent` (`consent-guard.ts`), `transport.destructive-op-gate`, the per-iteration self-review artifact + guard (`docs/runbooks/twilio-self-review.md`), and adding `twilio` to `arch.approved-api-client`. None of these are active on this branch.
- **Dropped as unnecessary:** the §7 `buildChildEnv` credential-allowlist extension — Twilio auth is keyring-only with no `SERVICE_ENV_MAP` entry, so the token never enters `process.env` and there is nothing to block.
- **Deferred (unchanged):** live voice AI (ConversationRelay/wss), console UI, A2P brand-registration tooling, failover auto-routing.
- **Open:** (Q1) approve `twilio` SDK vs raw fetch for `approved-api-client`? (Q2) transcription provider for voicemail (Twilio vs configured STT)? (Q3) should the webhook routes live in the transport or a shared HTTP module? — resolve during planning.
