# Twilio SMS Transport

Operator runbook for the optional, config-gated Twilio SMS transport. It runs
an instance over SMS instead of WhatsApp: outbound text via the Twilio
Messages API, inbound text via REST polling. It is **off by default** — an
instance uses it only when its `config.json` sets `transport: "twilio"` with a
`twilioConfig` block.

**Scope honesty up front:** stage 1 ships *outbound text + poll-mode inbound
text only*. Webhook inbound and voice are later stages. Several surfaces that
exist for WhatsApp (media, polls, scheduled sends, typing, read receipts) are
rejected or no-oped on SMS — the full list is in
[Current limitations](#current-limitations). Automated tests are mock-based
and do not prove live deliverability.

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
| `twilioConfig.messagingServiceSid` | XOR | — | Must match `^MG[0-9a-f]{32}$` (lowercase hex). Used as the sender instead of `phoneNumber`. Caveat: with no `phoneNumber`, inbound polling does **not** filter by destination number — it lists all inbound messages on the Twilio account (`twilio-port.ts` only sets the `to` filter when `phoneNumber` is configured). |
| `twilioConfig.inboundMode` | no | `poll` | Only `'poll'` is accepted. `'webhook'` is rejected with `webhook inbound is not yet supported; use inboundMode:'poll'`. Any other value is also rejected. |
| `twilioConfig.pollIntervalMs` | no | `15000` | Integer in `[5000, 86400000]`. Floor protects against rate-limit storms; the 24h ceiling catches typos that would silently disable inbound. Also the inbound *lookback window* at connect (see below). |
| `twilioConfig.rateLimit.smsPerMinute` | no | `30` | Integer in `[1, 600]`. **Config-only today** — see [Current limitations](#current-limitations). |

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
  **1000 SIDs** (oldest evicted first, after each batch). A restart that
  replays inside the lookback window, or an eviction at very high volume, can
  re-emit a message — replay protection is best-effort, not exactly-once.
- The cursor advances to the maximum `sentAt` seen (not wall-clock now), which
  protects against clock skew at the cost of re-listing the boundary message
  (covered by SID dedupe).
- Overlapping ticks are prevented (a slow poll skips the next tick rather than
  double-listing).
- Outbound messages echoed by Twilio are filtered out (`direction ===
  'inbound'` filter in `twilio-port.ts`), so the bot does not ingest its own
  sends.

Latency note: inbound latency is bounded by `pollIntervalMs` (default 15s).
This is a polling transport; there is no push path in stage 1.

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

- **Text only, poll only.** Outbound is `sendText` (max 1600 chars, empty
  rejected); inbound is poll-mode text with no attachments. Webhook inbound
  and voice are **later stages** — the validator rejects
  `inboundMode: 'webhook'` today.
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
- **`rateLimit.smsPerMinute` is validated config with no enforcement.** No
  code consumes it on the send path yet. Do not rely on it to cap outbound
  volume; it exists so configs written today stay valid when the limiter
  lands.
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
  consumers should treat the message SID (`inboundEventKey`) as the
  idempotency key.

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
