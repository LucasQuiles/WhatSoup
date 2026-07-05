# Twilio SMS Transport

Operator runbook for the optional, config-gated Twilio SMS transport. It runs
an instance over SMS instead of WhatsApp: outbound text via the Twilio
Messages API, inbound text via REST polling. It is **off by default** — an
instance uses it only when its `config.json` sets `transport: "twilio"` with a
`twilioConfig` block.

**Scope (stage 2):** outbound text, poll-mode inbound text, webhook-mode inbound
text with signature validation, and recorded voicemail with transcription. Live
conversational voice remains deferred. Several surfaces that exist for WhatsApp
(media, polls, scheduled sends, typing, read receipts) are rejected or no-oped
on SMS — the full list is in [Current limitations](#current-limitations).
Automated tests are mock-based and do not prove live deliverability.

## How it works

- `src/transport/registry.ts` — transport ID registry: `baileys` (default) and
  `twilio`. Unknown IDs are rejected at config validation and again at the
  factory switch (`assertNeverTransport`).
- `src/transport/factory.ts` — `createConnection(config)` returns the Baileys
  `ConnectionManager` for `baileys`, or a `TwilioConnection` (bridge) wrapping
  `TwilioSmsAdapter` + `SdkTwilioSmsPort` for `twilio`. The twilio arm throws
  at startup if `twilioConfig` is missing.
- `src/transport/twilio/adapter.ts` — send path, inbound poll loop, health
  state, typed error mapping.
- `src/transport/twilio/twilio-port.ts` — the only file that touches the
  `twilio` npm SDK. Lazily constructs the client on first use, resolving the
  auth token from the OS keyring at that point. Error messages and stacks are
  scrubbed of the token before they propagate.
- `src/transport/twilio/connection-bridge.ts` — adapts the SMS adapter to the
  `RuntimeConnection` surface the rest of WhatSoup consumes. Operations with
  no SMS equivalent reject with `UnsupportedTransportOperationError`.
- `src/core/agent-config-validator.ts` — `validateTransportConfig` /
  `validateTwilioConfig` enforce every rule listed below at load, create,
  patch, and discovery time.
- `src/config.ts` — `resolveTwilioSmsConfig` applies defaults
  (`inboundMode: 'poll'`, `pollIntervalMs: 15000`,
  `rateLimit.smsPerMinute: 30`).

## Configuration reference

Full example (`config.json` for the instance — values below are deliberately
fake placeholders in the validated shapes):

```json
{
  "name": "sms-agent",
  "type": "agent",
  "accessMode": "allowlist",
  "adminPhones": ["15555550100"],
  "transport": "twilio",
  "twilioConfig": {
    "account": "sms-agent",
    "accountSid": "AC00000000000000000000000000000000",
    "authTokenService": "twilio-sms-agent",
    "phoneNumber": "+15550001111",
    "inboundMode": "poll",
    "pollIntervalMs": 15000,
    "rateLimit": { "smsPerMinute": 30 }
  },
  "agentOptions": {
    "sessionScope": "per_chat",
    "cwd": "~/workspace/sms-agent"
  }
}
```

Per-field notes (validation rules are exact — see
`src/core/agent-config-validator.ts`):

| Field | Required | Default | Validation / behaviour |
|-------|----------|---------|------------------------|
| `transport` (top level) | no | `baileys` | Must be `baileys` or `twilio` when present. `twilioConfig` is **required** when `twilio`, and **rejected** when the transport is anything else. |
| `twilioConfig.account` | yes | — | Channel account segment used to build the channel ID (`sms:<account>`). Must match `^[a-z][a-z0-9-]{0,63}$` (lowercase, starts with a letter). Pick a stable name; changing it changes the channel identity. |
| `twilioConfig.accountSid` | yes | — | Must match `^AC[0-9a-f]{32}$` — hex must be **lowercase**. |
| `twilioConfig.authTokenService` | yes | — | Keyring **service name**, not the token itself. Non-empty, no whitespace, max 128 chars. See [Credentials](#credentials-keyring). |
| `twilioConfig.phoneNumber` | XOR | — | E.164 sender (`^\+[1-9]\d{6,14}$`). Exactly **one** of `phoneNumber` or `messagingServiceSid` must be set — both or neither is rejected. |
| `twilioConfig.messagingServiceSid` | XOR | — | Must match `^MG[0-9a-f]{32}$` (lowercase hex). Used as the sender instead of `phoneNumber`. Caveat: with no `phoneNumber`, inbound polling uses a single unfiltered SDK call — it lists all messages on the Twilio account in both directions (`twilio-port.ts` makes two targeted calls only when `phoneNumber` is configured). |
| `twilioConfig.inboundMode` | no | `poll` | `'poll'` (REST polling) or `'webhook'` (signature-validated HTTP listener). Unknown values are rejected. |
| `twilioConfig.webhook.publicBaseUrl` | webhook-mode | — | Public HTTPS base URL Twilio posts to (`https://` required, no trailing slash; the validator strips one if present). Twilio computes signatures over the full public URL; this **must match exactly**. |
| `twilioConfig.webhook.listenPort` | webhook-mode | — | Port the local listener binds (integer `[1, 65535]`; must not equal `healthPort` when both are set). Bind address defaults to `127.0.0.1` — you MUST front it with an HTTPS-terminating proxy or tunnel. |
| `twilioConfig.webhook.listenAddress` | no | `127.0.0.1` | Override the local bind address. Default keeps the listener off public interfaces; the HTTPS proxy handles public TLS. |
| `twilioConfig.voice.enabled` | no | `false` | Enable voicemail flow (`true` requires `inboundMode:'webhook'` and a `phoneNumber`). |
| `twilioConfig.voice.voicemailMaxLengthSec` | no | `120` | Max recording length in seconds (`[5, 600]`). |
| `twilioConfig.voice.voicemailGreeting` | no | built-in | Custom `<Say>` greeting text (≤ 500 chars). |
| `twilioConfig.pollIntervalMs` | no | `15000` | Integer in `[5000, 86400000]`. Floor protects against rate-limit storms; the 24h ceiling catches typos that would silently disable inbound. Also the inbound *lookback window* at connect (see below). |
| `twilioConfig.rateLimit.smsPerMinute` | no | `30` | Integer in `[1, 600]`. Enforced per destination as a sliding one-minute window in the adapter's `sendText` path (validation runs first; the limiter never sees an invalid send). Over-cap sends are **delayed (FIFO queue per destination), never rejected**. In-process, in-memory only — a restart resets the window, and multiple processes sending from the same number each enforce their own independent cap. See [Current limitations](#current-limitations). |

The `transport` and `twilioConfig` fields are also documented in the
instance.json schema in [`docs/configuration.md`](../configuration.md).

## Credentials (keyring)

`authTokenService` is a **service name** resolved through
`lookupCredential()` in `src/lib/keyring.ts` the first time the transport
talks to Twilio (lazy — not at startup). Supported backends:

- **macOS:** Keychain via the `security` CLI. Lookup is
  `security find-generic-password -s <service> -a <os-username> -w`, where the
  account is the OS user running the WhatSoup process. Provision with:

  ```bash
  security add-generic-password -s twilio-sms-agent -a "$USER" -w
  # paste the auth token at the prompt
  ```

- **Linux:** GNOME Keyring via `secret-tool`. Lookup is
  `secret-tool lookup service <service>`. Provision with:

  ```bash
  secret-tool store --label="Twilio auth token (sms-agent)" service twilio-sms-agent
  ```

- **Environment fallback:** does **not** apply to Twilio. `lookupCredential`
  only falls back to env vars for service names listed in `SERVICE_ENV_MAP`
  (`src/lib/keyring.ts`), and there is no Twilio entry. On a host with no
  usable keyring backend the lookup returns null and the transport fails
  closed (see [Auth failure behaviour](#auth-failure-behaviour)).

The token is never written to config, never logged, and is scrubbed from SDK
error messages and stack traces (`twilio-port.ts` `scrubAndRethrow`).

## SMS identity model

Core conversation identity requires JID-shaped ids, so the bridge synthesises
an `@sms` domain (`connection-bridge.ts`):

- Inbound chat/sender JIDs: `<E.164>@sms` (e.g. `+15550002222@sms`).
- Conversation keys: `<E.164>_at_sms` (the default-domain branch of
  `toConversationKey` in `src/core/conversation-key.ts`).
- The instance's own `botJid` is `<sender>@sms` (the configured `phoneNumber`,
  or the `messagingServiceSid` when no phone number is set).

Because WhatsApp keys derive from `@s.whatsapp.net` / `@lid` / `@g.us`
domains, SMS conversation keys **cannot collide** with WhatsApp keys for the
same phone number.

Inbound SMS are always direct messages: `isGroup: false`, no sender name, no
mentions, `contentType: 'text'`.

## Inbound delivery semantics

- Polling starts at `connect()` with a cursor of `now - pollIntervalMs` (a
  lookback window so messages that arrived just before connect are not lost).
- Delivery is **at-least-once**. The port's `listInboundSince` boundary is
  inclusive, and the adapter deduplicates by message SID with a bounded set of
  **1000 SIDs** (oldest evicted first, trimmed per accepted record). A restart that
  replays inside the lookback window, or an eviction at very high volume, can
  re-emit a message — replay protection is best-effort, not exactly-once.
- The cursor advances to the maximum `sentAt` seen (not wall-clock now), which
  protects against clock skew at the cost of re-listing the boundary message
  (covered by SID dedupe).
- Overlapping ticks are prevented (a slow poll skips the next tick rather than
  double-listing).
- Outbound messages sent by the bot are now included in the poll results
  (`fromMe: true`). The adapter emits them with `fromMe: true`, and ingest
  calls `durability.matchEcho` to transition the corresponding submitted
  outbound op to `echoed`. This closes the conversation window gap where
  the chat runtime lost bot replies, and prevents durability from
  indefinitely parking ops as `submitted → maybe_sent → quarantined`.

Latency note: inbound latency is bounded by `pollIntervalMs` (default 15s) in
poll mode. In webhook mode, delivery is near-real-time (Twilio posts within
seconds). Both modes share one deduplication set; a SID seen via one path will
not be re-emitted by the other.

## Auth failure behaviour

- **At connect:** `connect()` verifies credentials with an account fetch.
  Failure throws a typed error (`AuthRequiredError` for 401/Twilio code 20003,
  `RateLimitedError` for 429/20429, `PermanentProviderError` otherwise), which
  fails startup — `main.ts` logs `failed to start` (fatal) and shuts down. A
  missing keyring entry surfaces here as
  `Twilio auth token not found in keyring for service "<name>"`.
- **During polling:** an auth failure **stops the poll loop permanently** and
  parks adapter health in `auth_required` (`adapter.ts` `pollOnceInner`).
  There is no automatic retry — fix the credential and **restart the
  instance**. Transient and rate-limit poll errors keep the loop running at
  the normal cadence.
- **Log signal:** the bridge subscribes to the adapter's `error` channel and
  logs every background transport error through the `twilio-bridge` child
  logger (structured fields: `code`, `operation`, `correlationId`,
  `retryable`). A poll-time auth failure therefore produces an error log line
  in addition to the health endpoint flipping to `disconnected`. If inbound
  goes quiet, check the logs for `twilio transport error` and re-verify the
  keyring entry.
- The health endpoint reports `connected`/`disconnected` only — the bridge
  maps every non-connected adapter state (including `auth_required`) to
  `disconnected`, with the reason code in `lastDisconnectReason`. There is no
  `reconnecting` granularity for SMS.

## Current limitations

Each item below is verified against the code on this branch.

- **Voicemail audio download is not implemented.** Inbound voice delivers
  transcript text only. The recording SID is available as
  `attachments[0].id` (type `'voice'`) and in the `inboundEventKey`, but
  fetching the audio file from `RecordingUrl` is out of stage-2 scope.
- **Live conversational voice remains deferred.** `ConversationRelay`/WebSocket
  voice AI is not built; only asynchronous voicemail transcription is wired.
- **The enforcement envelope from the design spec is absent (stage 3).**
  No fitness rules (`transport.twilio-credential-gate`,
  `transport.webhook-signature-required`,
  `invariant.no-outbound-without-consent`, `transport.destructive-op-gate`),
  no consent guard, and no per-iteration self-review artifact/guard exist on
  this branch. Do not assume an invariant layer is active when working under
  `src/transport/twilio/`.
- **`rateLimit.smsPerMinute` is enforced, not merely validated — with
  per-process caveats.** `SmsRateLimiter`
  (`src/transport/twilio/sms-rate-limiter.ts`) enforces it per destination as
  a sliding one-minute window at the adapter's `sendText` seam, reserving a
  slot *after* request validation (invalid sends never consume a slot) and
  *before* the port call. Over-cap sends are **delayed — queued FIFO per
  destination — never rejected**; callers do not see a throttling failure.
  The cap is in-process, in-memory state only: a restart resets it, and it
  is **not** shared across multiple processes sending from the same Twilio
  number — each process enforces its own independent cap, so N processes
  together allow up to N× the configured rate. Surviving restarts or
  coordinating across processes would require a persistent store, which is
  not implemented.
- **The webhook listener binds `127.0.0.1` by default.** Operators MUST
  front it with an HTTPS-terminating reverse proxy or tunnel whose public URL
  exactly matches `webhook.publicBaseUrl`. Twilio signature validation is
  computed over the full public URL — any mismatch causes 403 rejections.
- **Webhook auth-token lookup shells the OS keyring on every request.** The
  `getAuthToken` thunk calls `lookupCredential` per-signature-validation.
  At Twilio SMS/voice rates this is fine; it would be a bottleneck at
  high-frequency webhook traffic.
- **`sendMedia`, `sendRaw`, and `sendPollMessage` reject** with
  `UnsupportedTransportOperationError` (`connection-bridge.ts`). This means
  MCP `send_media`, voice-note synthesis, and `send_poll` fail at runtime on
  an SMS instance.
- **The message scheduler cannot deliver on SMS instances.** Scheduled *text*
  rows go through `sendRaw` and scheduled *media* rows through `sendMedia`
  (`src/core/scheduler.ts`), both of which reject. Each affected row fails
  per-row: the scheduler retries it up to `maxRetries` and then marks it
  `failed`. There is no special terminal-failure routing for
  unsupported-transport errors yet — they burn the normal retry budget first.
- **No outbound-status events.** The adapter's `extensions` set is empty;
  delivery confirmation uses the inbound echo path instead (the bot's own
  sends arrive as `fromMe: true` records via polling and settle durability
  through `matchEcho`).
- **No instance-type gate.** The validator does not restrict
  `transport: "twilio"` by instance type, so a `type: "agent"` SMS instance
  starts normally — but its MCP media/poll tools reject at runtime (above).
  A validator gate is a deferred follow-up.
- **Baileys still loads eagerly.** `factory.ts` imports the Baileys-backed
  `ConnectionManager` at module load regardless of the selected transport, so
  the WhatsApp dependency tree is loaded even for SMS-only instances.
- **No typing indicators, read receipts, reactions, or presence.** `setTyping`
  is a no-op; mark-read no-ops (no socket); capabilities advertise none of
  these.
- **At-least-once inbound** with bounded dedupe (see
  [Inbound delivery semantics](#inbound-delivery-semantics)) — downstream
  consumers should treat the message SID or recording SID (`inboundEventKey`)
  as the idempotency key.

## Webhook mode

When `inboundMode: 'webhook'`, `TwilioWebhookServer` binds a local `node:http`
listener and forwards valid Twilio POSTs into the adapter's shared inbound
pipeline. The signature gate runs before any routing or business logic.

### 403 / 503 fail-closed table

| Condition | Response | Forwarded? |
|-----------|----------|------------|
| Valid signature | 204 / 200 (TwiML) | Yes |
| Missing `X-Twilio-Signature` header | 403 | No |
| Bad signature | 403 | No |
| Auth token unavailable (keyring null) | 503 | No |
| Parse error (missing required field) | 400 with field name | No |
| Unknown path | 404 | — |
| Non-POST on known path | 405 | — |

### Port-collision rule

`webhook.listenPort` must differ from `healthPort` when both are set. The
validator enforces this at config load time (`twilioConfig.webhook.listenPort`
field error).

### Config example (webhook mode)

```json
"transport": "twilio",
"twilioConfig": {
  "account": "sms-agent",
  "accountSid": "AC00000000000000000000000000000000",
  "authTokenService": "twilio-sms-agent",
  "phoneNumber": "+15550001111",
  "inboundMode": "webhook",
  "webhook": {
    "publicBaseUrl": "https://sms-relay.example.test",
    "listenPort": 8443
  },
  "voice": {
    "enabled": true,
    "voicemailMaxLengthSec": 120,
    "voicemailGreeting": "You have reached the SMS agent. Please leave a message after the beep."
  }
}
```

Point your HTTPS proxy/tunnel at `127.0.0.1:<listenPort>`. Register
`https://sms-relay.example.test/twilio/sms` as the webhook URL in the Twilio
console (messaging → phone number → webhook field). For voice, register
`https://sms-relay.example.test/twilio/voice`.

## Voicemail (recorded voice)

When `voice.enabled: true` and `inboundMode: 'webhook'`:

1. Twilio routes an inbound call to `/twilio/voice`.
2. The server responds with TwiML: `<Say>` the configured greeting, then
   `<Record transcribe="true" transcribeCallback="…/twilio/voice/transcription" …>`.
3. When Twilio finishes transcribing, it POSTs to `/twilio/voice/transcription`.
4. A successful transcription is emitted as an `InboundMessage`:
   - `text`: the transcript text.
   - `attachments[0]`: `{ id: recordingSid, kind: 'voice', mime: 'audio/mpeg' }`.
   - `inboundEventKey`: the recording SID (dedupe key).
   - `contentType`: `'audio'` (the bridge maps the voice attachment).
5. The agent receives the transcript as text; the recording SID is available
   for reference but audio download is not implemented (stage-2 scope).

Dedupe uses the recording SID (shared with the SMS SID set) — a transcription
callback retried by Twilio will not re-emit.

`placeCall(target, opts?)` is also available via the `VoiceCapableTransport`
contract: it calls `calls.create` and requires `phoneNumber` to be set (a
`messagingServiceSid`-only config cannot originate calls). The validator
enforces this as a coherence rule.

## Compliance (US sending)

US outbound SMS can be blocked at the account level until toll-free
verification or A2P 10DLC campaign registration is approved by Twilio. While
verification is pending, sends may fail with permanent provider errors
(surfaced as `PermanentProviderError` with the Twilio error code) even though
the transport, config, and credentials are all correct.

The automated test suite is **mock-based and does not prove live
deliverability**. Treat any live send testing as a separately-approved
activity — do not point a real number at a contact list to "smoke test" the
transport.

## Ops

Run the focused test subset:

```bash
npx vitest run --pool=forks \
  tests/transport/twilio/ \
  tests/transport/factory.test.ts \
  tests/config.twilio.test.ts \
  tests/core/agent-config-validator-transport.test.ts
```

What to expect on failure:

- **Bad config** — the instance refuses to start with a field-specific
  validation error (e.g. `twilioConfig.accountSid must match AC[0-9a-f]{32}
  (hex must be lowercase)` or `twilioConfig: set exactly one of phoneNumber or
  messagingServiceSid, not both`).
- **Missing keyring entry / bad token at startup** — fatal `failed to start`
  log with the typed auth error; the process shuts down.
- **Token revoked while running** — outbound sends throw `AuthRequiredError`
  to their caller; the poll loop stops (with a `twilio transport error` log
  line) and health goes `disconnected` (see
  [Auth failure behaviour](#auth-failure-behaviour)). Fix the keyring entry,
  then restart the instance.
