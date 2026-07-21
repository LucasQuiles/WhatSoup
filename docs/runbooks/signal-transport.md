# Signal Transport (signal-cli)

This runbook covers operating a WhatSoup instance on the Signal network via
`signal-cli` in JSON-RPC daemon mode.

## Architecture

```
WhatSoup instance
  └─ SignalConnection (src/transport/signal/connection-bridge.ts)
      └─ SignalAdapter (src/transport/signal/adapter.ts)
          └─ SignalCliPort (src/transport/signal/signal-cli-port.ts)
              └─ signal-cli daemon  ←  JSON-RPC 2.0 (NDJSON over UNIX socket or TCP)
```

The adapter depends only on the narrow `SignalPort` interface; the daemon is
the only external process. Inbound envelopes arrive via the daemon's
`receive` RPC (poll mode) and are normalized to the transport contract.

## Prerequisites

1. **signal-cli installed** on the WhatSoup host (or reachable over TCP).
   Tested against signal-cli ≥ 0.13 daemon mode.
2. **A linked Signal account.** Link out-of-band (matches the Twilio
   config-only auth precedent — there is no `pnpm auth` flow for Signal):

   ```bash
   signal-cli -a +15551234567 link
   # prints a tsdevice:/ URI; render it as a QR (e.g. qrencode) and scan
   # from the primary Signal app's Linked Devices screen.
   ```

   Or register a fresh number (`signal-cli -a +1555... register` + `verify`).

3. **The daemon running** before WhatSoup connects:

   ```bash
   signal-cli -a +15551234567 daemon --socket /tmp/signalc.sock
   # or TCP: signal-cli -a +15551234567 daemon --tcp 127.0.0.1:7583
   ```

   Run it under your service manager of choice; WhatSoup does NOT supervise
   signal-cli (matches how Twilio's cloud dependency is unsupervised).

## Instance config

`instance.json` (validated by `agent-config-validator.ts`):

```json
{
  "name": "ops-signal",
  "type": "agent",
  "transport": "signal",
  "signalConfig": {
    "account": "ops-signal",
    "phoneNumber": "+15551234567",
    "socketPath": "/tmp/signalc.sock",
    "inboundMode": "poll",
    "pollIntervalMs": 15000,
    "rateLimit": { "messagesPerMinute": 30 }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `account` | yes | Channel account segment (a-z0-9-), e.g. `ops-signal` |
| `phoneNumber` | yes | The linked device's own number, E.164. Needed for selfRef before the first daemon round-trip |
| `socketPath` | no | Default `/tmp/signalc.sock`. Wins over `tcpPort` when both set |
| `tcpPort` / `tcpHost` | no | TCP alternative to the UNIX socket (host defaults `127.0.0.1`) |
| `inboundMode` | no | `poll` (default) or `stream` |
| `pollIntervalMs` | no | Default 15000 (poll mode only) |
| `rateLimit.messagesPerMinute` | no | Default 30; per-destination safety cap |

`signalConfig` on any other transport is rejected as inconsistent;
`transport: "signal"` without `signalConfig` is rejected as missing.

## Identity model

- **Senders surface as UUIDs** (Signal's canonical post-2022 identity).
  JID form in WhatSoup: `<uuid>@signal`.
- **Outbound convenience:** `sendText` accepts E.164; the port resolves via
  signal-cli's recipient resolution. UUID is always accepted.
- **Groups:** base64 V2 group ids (`<groupId>@signal`). Group envelopes
  thread under the group id; the sender field carries the member UUID.
- **Admin phones:** match against the sender's Signal-verified identity
  (UUID or E.164), not caller-supplied strings.

## Capabilities (v1)

| Feature | State |
|---|---|
| Text send/receive (1:1 + group) | ✅ |
| Reactions — outbound (react/unreact) | ✅ |
| Reactions — inbound (peer reacted to a message) | ✅ routed to `on('reaction')` |
| Typing indicators — outbound (composing/stopped) | ✅ |
| Typing indicators — inbound | ✅ typingMessage envelopes routed to `on('presence')`; composing → state='online', STOPPED → state='offline'. (Signal does not expose last-seen timestamps by design; typing is the closest presence signal.) |
| Read receipts — outbound (markRead) | ✅ |
| Read receipts — inbound (peer marked our message read) | ✅ routed to `on('read')`; one `ReadEvent` per timestamp |
| Remote delete — outbound (`deleteMessage(scope:'everyone')`) | ✅ |
| Remote delete — inbound (peer deleted their message) | ✅ routed to `on('delete')`; always `scope:'everyone'` |
| Delivery receipts — inbound | ❌ dropped (durability tracks delivery via sync echoes) |
| Sync echoes — inbound (our own outbound confirmed) | ✅ routed to `on('message')` with `fromMe:true` |
| Media attachments | ✅ `sendMedia` + `fetchAttachment` wired; 100 MB cap, MIME allowlist (image/jpeg, image/png, image/gif, image/webp, video/mp4, video/webm, audio/aac, audio/mp4, audio/mpeg, application/pdf, text/plain); signal-cli `attachments` data-URI array |
| Group metadata (`getGroupMetadata`) | ✅ signal-cli `listGroups -g <groupId>` RPC; mapped to contract `GroupMetadata { conversation, title, memberCount }` |
| Group V2 updates (`on('group-update')`) | ✅ sync envelopes carrying `groupV2UpdateDetails` routed to `GroupUpdateEvent { conversation, kind, at }`; kind taxonomy: metadata/membership/admin |
| Voice notes (`sendVoiceNote`) | ✅ audio/* payloads encoded as signal-cli attachment data URIs; voice-notes extension declared; rejects non-audio MIME + payloads over media size cap |
| Message edit (`editText` + `on('edit')`) | ✅ outbound edits via signal-cli `editTimestamp` param; inbound edits (signal-cli `dataMessage.edit`) routed to `EditEvent { target, newText, at }` |
| Polls | ❌ rejected (WhatsApp-only feature) |

### Capability degradation (unsupported-operation handling)

Operations the transport does not support are not silently dropped — the
`RuntimeConnection` bridge throws `UnsupportedTransportOperationError` (with
`name='UnsupportedTransportOperationError'` and
`code='UNSUPPORTED_TRANSPORT_OPERATION'`), and MCP tool handlers catch it via
`isUnsupportedTransportOperation()` (see
`src/transport/unsupported-operation.ts`) and return a stable tool error:

```json
{ "error": "unsupported_transport", "message": "<operation> is not supported on this transport." }
```

Agent LLMs can key on the `unsupported_transport` code to learn the operation
will never succeed on this transport — they should not retry, and should fall
back to a supported operation (e.g. plain text instead of a voice note).

Tools currently wrapped:

| Tool | Unsupported op | Reason |
|---|---|---|
| `send_message`, `reply_message`, `react_message`, `edit_message`, `delete_message`, `send_location`, `send_contact`, `pin_message` | `sendRaw` | all use the WhatsApp-protocol `sendRaw` envelope shape |
| `send_poll` | `sendPollMessage` | WhatsApp-only poll contract |
| `send_voice_reply` | (none) | routes through `sendVoiceNote`; audio/opus payloads encoded as ptt-style attachments |

Operations that self-degrade without surfacing a tool error:

| Tool | Behaviour on Signal |
|---|---|
| `download_media`, `transcribe_audio` | `download_media` now resolves attachments via `adapter.fetchAttachment(ref)` (reads from `attachmentsDataDir`); `transcribe_audio` still depends on application-layer transcription (no Signal-native transcription) |
| `mark_conversation_read` | the `markRead` adapter method IS supported on Signal; the `getSocket()` null-check path does not fire |

### Inbound envelope routing

`SignalPort.listInboundSince` returns envelopes of all classes the v1 contract
surfaces. The adapter's `handleInboundRecord` routes each by `type`:

| `type` | Routed to | Payload field |
|---|---|---|
| `data` | `on('message')` (InboundMessage) | `body` |
| `sync` | `on('message')` (InboundMessage with `fromMe:true`) | `body` |
| `reaction` | `on('reaction')` (ReactionEvent) | `reaction` |
| `read` | `on('read')` (one ReadEvent per timestamp) | `read` |
| `delete` | `on('delete')` (DeleteEvent with `scope:'everyone'`) | `delete` |

Envelope classes the v1 contract does not surface (typing, call, delivery
receipts) are dropped at the port boundary. All envelope classes share the
timestamp-keyed dedupe set, so a re-delivered envelope never double-emits.

## Health + recovery

- `health.whatsapp` does NOT apply; the generic transport-health block is
  the read path (see the front-end design §8).
- Transient daemon failures (`signal-cli socket error`, `ECONNREFUSED`,
  RPC timeout) classify as **transient** in the bot-errors dispatcher and
  ride the long retry budget; they never burn the permanent dead-letter cap.
   added a reconnect engine to the adapter itself: consecutive
  transient poll failures escalate `reconnectAttempts` and surface via the
  snapshot (see "Reconnect engine" below).
- `signal_cli_unregistered` (daemon reports the account unlinked) is an
  auto-close-protected source: silence is not proof of repair. Re-link
  (`signal-cli link`) and restart the daemon.
- The adapter parks at `auth_required` on unregistered and stops the poll
  loop; transient errors keep the loop alive and log via the bridge's
  error subscriber.

### `health.json` snapshot fields

`getConnectionState()` produces a Signal-specific `ConnectionStateSnapshot`
via `signalConnectionStateSnapshot()` (see
`src/transport/signal/connection-snapshot.ts`). Fields an operator should
know:

| Field | Value for Signal |
|---|---|
| `credentialLifecycle.environment.provider` | `"signal"` (not `"twilio-sms"`) |
| `credentialLifecycle.environment.instance` | the channel instance name (`config.botName`) |
| `credentialLifecycle.environment.lockPath` | daemon target — UNIX socket path or `host:port` |
| `credentialLifecycle.environment.authDir` | `out_of_band_via_signal_cli` (or `signalCliDataDir` when supplied) |
| `credentialLifecycle.currentAuthBond.status` | `"missing"` — credentials live with signal-cli, not in WhatSoup |
| `credentialLifecycle.currentAuthBond.issues` | `["signal_credentials_managed_out_of_band_by_signal_cli"]` |
| `credentialLifecycle.recentEvents` | real accumulated events from the adapter's bounded ring buffer (cap 50). Includes `connect_start`, `connection_open`, `connection_close` (with `reason`), and `device_bond_lost` when the adapter parks at `auth_required` (signal-cli's unlinked-account signal — operator action required) |
| `reconnectAttempts` | consecutive transient poll failures since the last successful poll (resets on success). Drives the reconnect-engine state |
| `reconnectPhase` | `'backoff'` (1–2 failures) or `'cooldown'` (3+). Mirrors WhatsApp's phase taxonomy |
| `firstFailureAt` | ISO timestamp of the first failure in the current run (null when no failures) |

The raw phone number is NEVER emitted into the snapshot. Credential
introspection requires an RPC round-trip to signal-cli; the snapshot does
not perform one, so the auth-bond status is a static declaration, not a
live probe.

#### `device_bond_lost` event

When the signal-cli daemon returns a 401 on a poll (`Unregistered user`,
`NotRegisteredException`, or `UntrustedIdentityException`), the adapter
classifies the error as `AuthRequiredError` and transitions to the
`auth_required` state, stopping the poll loop. That transition is recorded
in `recentEvents` as a `device_bond_lost` event — distinguishing
"daemon unreachable" (transient, will retry) from "this device was
unlinked" (operator must re-link via `signal-cli link` and restart the
daemon). Dashboards keying on `device_bond_lost` for the WhatsApp side
work identically for Signal.

#### Reconnect engine

Consecutive transient poll failures (`ECONNREFUSED`, `ECONNRESET`,
`ETIMEDOUT`, `ENOTFOUND`, `EPIPE`, `EHOSTUNREACH`, `EAI_AGAIN`, or any
HTTP 5xx / `ControllableException`) escalate through the reconnect engine:

| State | Condition | Behavior |
|---|---|---|
| `backoff` | 1–2 consecutive failures | Counter increments, next poll tick retries |
| `cooldown` | 3+ consecutive failures | Counter keeps incrementing |
| `exhausted` (parked) | 10+ consecutive failures (`MAX_RECONNECT_ATTEMPTS`) | Poll timer cleared, lifecycle emits `connection_close` with reason `reconnect-exhausted-after-N-attempts`, operator alert routed via bot-errors dispatcher |

A single successful poll resets `reconnectAttempts`, `firstFailureAt`, and
returns the phase to `backoff`. Constants mirror the WhatsApp side
(`MAX_RECONNECT_ATTEMPTS=10`, `BASE_BACKOFF_MS=1000`, `MAX_BACKOFF_MS=60000`).

**Note on backoff delay:** the current engine tracks state and parks at
exhausted but does NOT insert a `setTimeout`-based exponential delay —
the existing `pollIntervalMs` already spaces retries. Adding real delay
insertion is a future enhancement; the parity gap that matters for ops
dashboards (counters + exhausted state + lifecycle events) is closed.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `signalConfig is required when transport is "signal"` | missing config block | add `signalConfig` to instance.json |
| `signal-cli socket error: ECONNREFUSED` | daemon not running | start `signal-cli daemon --socket …` |
| `Unregistered user` on send | linked session revoked/expired | re-link the device, restart daemon |
| No inbound messages | `receive` timeout too short / wrong account flag | verify daemon was started with `-a <number>` matching `phoneNumber` |
| Sends land but no echoes | sync envelopes filtered | check daemon version ≥ 0.13 (syncMessage support) |

## References

### Local source

- Spec: `~/LAB/oc-re/specs/2026-07-20-signal-and-imessage-transports-spec.md` (§3a
  is the authoritative Signal capability mandate; §3b is the iMessage counterpart)
- Port interface: `src/transport/signal/port.ts`
- Port impl: `src/transport/signal/signal-cli-port.ts`
- Adapter: `src/transport/signal/adapter.ts`
- Bridge: `src/transport/signal/connection-bridge.ts`
- Validator: `src/core/agent-config-validator.ts` (`validateSignalConfig`)

### Parallel example (non-Baileys adapter pattern)

- `src/transport/twilio/adapter.ts:136` — `TwilioSmsAdapter implements
  TransportAdapter, VoiceCapableTransport` with `capabilities.extensions: new Set()`
  (SMS carries no extensions); referenced as the reference shape for capabilities
  declaration + `mapPortError` pattern used here.

### Official documentation consulted (live-fetched, applied mappings)

Sources fetched verbatim from the upstream maintainer (AsamK) and mapped
directly to adapter source lines:

1. **signal-cli(1) man page** — `https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc`
   (raw: `https://raw.githubusercontent.com/AsamK/signal-cli/master/man/signal-cli.1.adoc`,
   content-sha256 `6cc7496bca0243765ec262ad6c12122a28fdbe9e0725e903ee32b6f2f5ee37b1`, 36825 bytes)
2. **signal-cli-jsonrpc(5) man page** — `https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc`
   (raw: `https://raw.githubusercontent.com/AsamK/signal-cli/master/man/signal-cli-jsonrpc.5.adoc`,
   content-sha256 `4f019164b87d6a4d742dda10ceb5348970581460eba36b31a88f958386e13191`)

| Phase | Doc field (verbatim from upstream) | Applied at |
|---|---|---|
| 1 (reactions) | man §sendReaction: `-e emoji -a target-author -t target-timestamp -r remove` | `port.ts:217` `ReactSignalArgs`; `adapter.ts:797` `react()` |
| 1 (read receipts) | man §sendReceipt: `-t target-timestamp --type read\|viewed` | `port.ts:231` `SendReadReceiptArgs`; `adapter.ts:865` `markRead()` |
| 1 (delete) | man §remoteDelete: `-t target-timestamp` | `adapter.ts:897` `deleteMessage(scope:'everyone')` |
| 5 (media) | man §send `--attachment`: "Data URI encoded attachments must follow RFC 2397 ... `data:<MIME-TYPE>;filename=<FILENAME>;base64,<BASE64 ENCODED DATA>`" | `port.ts:31-35` `SendSignalArgs.attachments`; `adapter.ts:545` `data:${mime};filename=${filename};base64,...` |
| 6 (groups) | man §listGroups: `-d detailed -g group-id`; jsonrpc(5) `listGroups` returns `{id,name,members,admins,groupInviteLink}` | `signal-cli-port.ts:515` `getGroupMetadata()`; member normalization at `signal-cli-port.ts:534-537` accepts both bare string and `{number,uuid}` shapes |
| 6 (group updates) | jsonrpc(5) envelope shape `syncMessage` with `groupV2UpdateDetails` | `port.ts:103` doc; `adapter.ts` `on('group-update')` overload + `emitGroupUpdateEvent` |
| 7 (presence) | man §sendTyping: "Indicator will be shown for 15 seconds unless a typing STOP message is sent first"; man §updateConfiguration: `--typing-indicators {true,false}` | `port.ts:110-126` `InboundTyping` + `typingMessage` doc; `signal-cli-port.ts:354-359` `normalizeEnvelope` typing branch; `adapter.ts` `emitPresenceEvent` (composing→online, STOPPED→offline) |
| 8 (voice-notes) | man §send `--attachment` (data URI accepts any MIME) — supersedes the spec §3a deferral that claimed "Signal voice is opus-only" | `adapter.ts:630` `sendVoiceNote()`; data-URI encoding at `adapter.ts:680-681` |
| 9 (edit) | man §send `--edit-timestamp`: "Specify the timestamp of a previous message with the recipient or group to send an edited message" — supersedes the spec §3a deferral that claimed "edit is beta in upstream" | `port.ts:38-42` `SendSignalArgs.editTimestamp`; `signal-cli-port.ts:438-442` param forwarding; `adapter.ts:703` `editText()`; inbound via `dataMessage.edit` at `signal-cli-port.ts:178` |

### Parallel-adapter pattern (other examples)

- `src/transport/twilio/adapter.ts` — Twilio SMS adapter, no extensions
  (`capabilities.extensions: new Set()` at line 206). Used as the non-Baileys
  reference for the capabilities + `mapPortError` pattern this adapter follows.
- `src/transport/baileys/adapter.ts` — Baileys (WhatsApp) adapter, the richest
  extension surface in the repo. Used as the reference for `SupportsMedia`,
  `SupportsVoiceNotes`, `SupportsReactions`, `SupportsReadReceipts`,
  `SupportsTyping`, `SupportsDelete` implementations against a multi-feature
  transport.

### Spec → implementation delta

The spec §3a line 83 defers `edit` and `voice-notes` ("Signal voice is opus-only;
edit is beta in upstream — both marked future"). This adapter supersedes both
deferrals because the consulted signal-cli man page shows both are first-class
in the JSON-RPC interface (`--edit-timestamp` is documented as a normal `send`
param; `--attachment` accepts any MIME including `audio/*`). If the operator
prefers to honor the spec's deferral literally, the two methods can be no-op'd
to throw `UnsupportedTransportOperationError` without affecting the other 7
phases; their tests would need GREEN→RED expectations flipped.
