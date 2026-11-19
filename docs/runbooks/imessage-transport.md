# iMessage Transport (BlueBubbles / imsg)

This runbook covers operating a WhatSoup instance on iMessage via either
supported backend: BlueBubbles Server (HTTP) or macOS-native `imsg rpc`
behind WhatSoup's local UNIX-socket relay.

## Architecture

```
WhatSoup instance
  └─ ImessageConnection (src/transport/imessage/connection-bridge.ts)
      └─ ImessageAdapter (src/transport/imessage/adapter.ts)
          └─ ImessagePort
              ├─ BlueBubblesPort (backend: 'bluebubbles')  ←  BlueBubbles Server REST API
              └─ ImsgPort        (backend: 'imsg')         ←  WhatSoup UNIX relay → imsg rpc stdio
```

The adapter depends only on the narrow `ImessagePort` interface; the
`backend` config field selects the port at factory time. Both backends are
macOS-hosted: BlueBubbles Server runs on a Mac signed into iMessage; the
`imsg rpc` reads `chat.db` and sends via the Messages framework on the
signed-in Mac itself. Upstream exposes NDJSON on standard input/output, so
WhatSoup supervises one provider process per local relay client rather than
assuming an upstream socket daemon exists.

## Choosing a backend

| | BlueBubbles (`bluebubbles`) | imsg RPC relay (`imsg`) |
|---|---|---|
| **Host** | Any Mac (Mac mini/Studio ideal) | The signed-in Mac itself |
| **WhatSoup host** | Any host that can reach the Server's URL | Must run ON the Mac |
| **API** | REST over HTTP(S) | JSON-RPC: WhatSoup UNIX relay to upstream stdio |
| **Auth** | Pre-shared Server password (keyring) | Local process trust |
| **Extensions (v1)** | reactions, typing, read receipts | none advertised until the local IMCore bridge is separately attested |
| **Recommended for** | Linux/ARM WhatSoup hosts (e.g. pi5) | macOS WhatSoup hosts |

## Prerequisites

### BlueBubbles

1. A Mac signed into iMessage with [BlueBubbles Server](https://bluebubbles.app)
   installed and running.
2. The REST API enabled; note the **server URL** and **password**.
3. Store the password in the keyring under a service name of your choice
   (e.g. `imessage-bb-pw`) — WhatSoup resolves it at startup via
   `bluebubblesPasswordService` and never logs it.
4. URL reachability from the WhatSoup host (`https://` recommended outside
   localhost).

### imsg RPC relay

1. The WhatSoup host IS the Mac signed into iMessage.
2. [`imsg`](https://github.com/openclaw/imsg) v0.13.2 installed, with Full
   Disk Access for `chat.db` and Automation permission for Messages.app sends.
   The relay rejects unrecognized versions before opening its socket.
3. Create a private directory owned by the signed-in GUI user, then start the
   relay as that user before WhatSoup connects:

   ```bash
   install -d -m 700 "$HOME/Library/Application Support/WhatSoup"
   npm run imsg:relay -- \
     --socket "$HOME/Library/Application Support/WhatSoup/imsg.sock" \
     --imsg-bin /opt/homebrew/bin/imsg
   ```

   Run this command under a per-user LaunchAgent, not as root. The relay pins
   the provider version, exposes a `0600` socket, accepts one client, forwards
   bounded NDJSON without logging frame bodies or provider stderr, and reaps
   `imsg rpc` when the client disconnects. It passes only an allowlisted
   process environment to the provider.

Both backends use **config-only auth** (matches the Twilio precedent — no
`npm run auth` flow for iMessage).

## Instance config

`instance.json` (validated by `agent-config-validator.ts`):

```json
{
  "name": "ops-imessage",
  "type": "agent",
  "transport": "imessage",
  "imessageConfig": {
    "account": "ops-imessage",
    "backend": "bluebubbles",
    "bluebubblesUrl": "https://bb.example.test",
    "bluebubblesPasswordService": "imessage-bb-pw",
    "sender": "<your-appleid-email>",
    "inboundMode": "poll",
    "pollIntervalMs": 15000,
    "rateLimit": { "messagesPerMinute": 30 }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `account` | yes | Channel account segment (a-z0-9-) |
| `backend` | yes | `'imsg'` or `'bluebubbles'` |
| `sender` | yes | Our own identity — AppleID email or E.164 |
| `bluebubblesUrl` | backend=bluebubbles | http(s) URL of the Server |
| `bluebubblesPasswordService` | backend=bluebubbles | Keyring service name for the Server password |
| `imsgSocketPath` | no (imsg only) | UNIX path exposed by the WhatSoup relay; default `/tmp/imsg.sock`, but an owner-only Application Support directory is recommended |
| `inboundMode` | no | `poll` (default). `webhook` is **not implemented**: the config validator accepts it for bluebubbles, but the adapter throws at construction for any mode other than `poll` |
| `pollIntervalMs` | no | Default 15000 |
| `rateLimit.messagesPerMinute` | no | Default 30; per-destination safety cap |

`imessageConfig` on any other transport is rejected as inconsistent;
`transport: "imessage"` without `imessageConfig` is rejected as missing.

## Identity model

- **Senders surface as AppleID email or E.164** (the AppleID-verified
  identity). JID form in WhatSoup: `<address>@imessage`.
- **Groups:** chat GUIDs — `iMessage;+;chatXXX` (group) vs
  `iMessage;-;<address>` (DM form, constructed by the port for 1:1 sends).
  Group envelopes thread under the chat GUID; the sender field carries the
  member address.
- **Message ids:** provider GUIDs on both backends, surfaced as
  `MessageRef.id`. The imsg `chat.db` ROWID serves as the poll cursor and
  keys and orders the port's inbound queue; it is not a message id. The
  exception is an imsg send reply whose `guid` is missing or empty: the
  port then uses a non-empty string `message_id`, else a safe-integer `id`,
  stringified.

## Capabilities (v1)

| Feature | State |
|---|---|
| Text send/receive (1:1 + group) | ✅ |
| Reactions — outbound (tapback: 👍👎❤️‼️❓😂 + remove) | ✅ BlueBubbles; not advertised for imsg without IMCore attestation |
| Reactions — inbound (tapback surfacing) | ✅ BlueBubbles (`associatedMessageGuid` + documented numeric `associatedMessageType`; named compatibility values are also tolerated); ❌ imsg RPC relay (needs relay-side reaction surfacing) |
| Typing indicators — outbound (composing/stopped) | ✅ BlueBubbles; not advertised for imsg without IMCore attestation |
| Typing indicators — inbound | ❌ deferred (BlueBubbles surfaces typing only via socket/SSE push events, not in `/message/query`; needs webhook/socket mode) |
| Read receipts — outbound (per conversation; `markRead` sends the one target message GUID) | ✅ BlueBubbles; not advertised for imsg without IMCore attestation |
| Read receipts — inbound | ✅ BlueBubbles (`dateRead` on outbound messages; piggybacked on the inbound poll — see below); imsg: not advertised (`readReceipts: 'none'`), although the imsg port does parse the relay's `date_read` on outbound records and the adapter's emission path is not backend-gated, so a relay that supplies it produces `ReadEvent`s |
| Remote delete | ❌ iMessage has no remote-delete protocol (documented parity gap) |
| Media attachments | ❌ deferred (adapter declares `media.maxBytes: 0`) |
| Polls | ❌ rejected (WhatsApp-only feature) |
| `webhook` inbound mode | ❌ not implemented; validation-only (the adapter supports only `poll`) |

## Inbound envelope routing

`ImessageAdapter.handleInboundRecord` (src/transport/imessage/adapter.ts) routes
by the `kind` discriminator on `InboundImessage`:

| `kind` | Listener | Notes |
|---|---|---|
| `text` | `message` (InboundMessage) | body !== null |
| `reaction` | `reaction` (ReactionEvent) | requires `reactionTargetGuid`; the BlueBubbles port populates `reactionEmoji`/`reactionRemove`/`reactionTargetGuid` from `associatedMessageGuid`+`associatedMessageType` |
| other | dropped | typing/call events have no v1 contract event |

Read receipts are NOT routed by `kind`. They ride on the `dateRead` field of
outbound (`fromMe: true`) text records and are checked before the `seen`
dedup guard. See [Inbound read receipts](#inbound-read-receipts) below.

Accepted envelope classes share the `seen` dedupe set (keyed by `guid`);
redelivery never double-emits. Malformed reaction payloads are rejected before
dedupe admission, so a corrected same-GUID redelivery remains processable.
Disposed or non-connected adapters drop silently.

### Inbound read receipts

iMessage read receipts are **state on an existing record**, not a separate
envelope. When the peer reads an outbound message, the backend updates the
`dateRead` field on the original `fromMe: true` message record in place.

**Outbound marking vs inbound observation** — these are separate flows:

| Direction | Mechanism | Method |
|---|---|---|
| Outbound (we mark peer's messages read) | `markRead()` → `sendReadReceipts` → BlueBubbles `POST /chat/{guid}/read` | `SupportsReadReceipts.markRead()` |
| Inbound (peer reads our messages) | `dateRead` field on outbound records, observed via the inbound poll | `handleInboundRecord` → `maybeEmitReadReceipt` → `listeners.read` |

The inbound path piggybacks on the existing `/message/query` cursor poll:
when an outbound record is fetched with `dateRead` set, the adapter checks
the `emittedReadReceipts` set (in-memory dedup of the GUIDs of the 5,000
most recently emitted receipts; older entries are evicted) and a
time filter (`dateRead > sessionStartedAt`, restart-safe dedup; the
timestamp is frozen at connect, so mid-session reads always pass) before
emitting a `ReadEvent`.

**Limitation**: the cursor-based poll is forward-only (ROWID advancing).
Messages read AFTER the cursor advances past their ROWID are not re-fetched,
so their read transition is not observed. Full coverage requires a
streaming/webhook inbound mode. This limitation is documented in
`adapter.ts` at `maybeEmitReadReceipt`.

### Reaction envelope shapes

Per the authoritative BlueBubbles
[`MessageResponse`](https://github.com/BlueBubblesApp/bluebubbles-server#message-response)
type, `/message/query` surfaces inbound tapback reactions as separate message
records with two fields:

- **`associatedMessageGuid: string | null`** — set to the reacted-to
  message's GUID on tapback envelopes; null on plain messages. Text-part
  reactions may qualify it as `p:<index>/<guid>`; the port strips that
  qualifier before emitting the target `MessageRef`.
- **`associatedMessageType: number | null`** — the documented API shape uses
  the iMessage chat.db numeric code. The parser also accepts the named
  reaction vocabulary used by `/message/react` as a defensive compatibility
  path.

The iMessage chat.db `SUBMESSAGES_TYPE_TABLE` codes the parser accepts:

| Code range | Meaning |
|---|---|
| `2000`-`2005` | tapback add: love, like, dislike, laugh, emphasize, question (in that order) |
| `3000`-`3005` | tapback removal counterparts (same emoji ordering) |
| `0`, null, anything else | not a reaction: parsed as an ordinary message (kind `text` when it has text, otherwise kind `other`, for which the adapter emits no message or reaction event) |

The port (`reactionTypeToEmoji` in `bluebubbles-port.ts`) emits a
`ReactionEvent` with the canonical tapback emoji + `removed` flag for codes
in the valid ranges. Removal events retain the emoji being removed rather
than replacing it with an empty string. Non-integer numeric values (NaN,
2000.5, etc.) and out-of-range codes (1999, 2006, 4000, negative numbers)
are handled the same way: `reactionTypeToEmoji` returns `null` and the record
is parsed as an ordinary message. With text it becomes kind `text` and goes
through normal message handling; without text it becomes kind `other`, for
which the adapter emits no message or reaction event. The adapter checks an
outbound record for a read receipt before it checks the kind, so an
outbound `other` record can still emit a read receipt.

**Outbound symmetry note:** the OUTBOUND `/message/react` endpoint uses
string reaction kinds (`'love'`, `'-like'`, etc.) — see
`EMOJI_TO_REACTION_TYPE`. The parser accepts the same names inbound so both
BlueBubbles response representations round-trip through one mapping.

## Health + recovery

- The adapter classifies backend failures (`mapPortError` and
  `isImessageTransient` in `adapter.ts`), rather than the bot-errors
  dispatcher. These map to `TransientProviderError`, which is marked
  retryable: a BlueBubbles answer with a 5xx status other than 501 (the
  port keeps the status of any non-2xx answer as `HttpError`), a
  BlueBubbles request that the HTTP client rejects, for example when no
  answer arrives within 30 seconds (only that rejection becomes a 503
  `TransportError`), a BlueBubbles answer that is not valid JSON or a send
  answer without a message GUID (`MalformedResponse`, 502), an imsg send
  answer with neither a message id nor `ok: true` (502), and imsg socket
  failures and RPC timeouts before the request was written.
  `UnsupportedMethod` is permanent.
- An imsg send whose request was already written maps to
  `SendAmbiguousError` instead: a socket error, end or close, or an RPC
  timeout after the write (the port reports `RequestAbortedAfterWrite`).
  So do an internal RPC error (`-32603`) on a send and a send acknowledged
  with `ok: true` but no message id. Treat each of these as unknown
  delivery and do not retry it: a retry could duplicate the message.
- A submitted send whose answer was lost or unusable may already have
  been delivered, whatever class the adapter gives it. For BlueBubbles,
  that is a rejected or timed-out request, a 5xx answer other than 501, a
  `POST /message/text` answer that is not valid JSON or has no GUID (all
  transient), or an answer whose body could not be read, which the adapter
  classes as permanent. For imsg, it is a 502 send answer. On either
  backend, corroborate delivery in the conversation before you resend such
  a send.
- The bot-errors dispatcher does not classify iMessage provider errors.
  When a delivery of its own fails, it first checks for an
  `AmbiguousSendOutcome` raised after its JSON-RPC request went out and
  holds that delivery (`hold_ambiguous_send`) instead of requeuing it,
  before any signature check. Any other failure is counted as a permanent
  attempt, and its error text is then checked against the generic
  transport signatures (`_TRANSIENT_TRANSPORT_SIGNATURES` in
  `bot-errors-dispatcher.py`, which include `connection lost` and
  `connection closed`). A match is requeued with that attempt rolled back
  only while the separate transient budget
  (`BOT_ERRORS_TRANSIENT_MAX_ATTEMPTS`) lasts; once it is spent, the
  failure takes the permanent path: further retries with backoff, an email
  fallback that can start at the third permanent attempt, and a dead
  letter only when the permanent budget
  (`BOT_ERRORS_DELIVERY_MAX_ATTEMPTS`) is spent.
- No iMessage source is auto-close-protected today: the dispatcher's
  `AUTOCLOSE_PROTECTED_SOURCES` set in `bot-errors-dispatcher.py` names no
  BlueBubbles or iMessage source, and neither `bluebubbles_connection_lost`
  nor `imessage_device_delinked` is emitted anywhere in the code.
- BlueBubbles HTTP 401 = bad/expired Server password → check the keyring
  entry for `bluebubblesPasswordService`.
- The imsg backend advertises no reaction, typing, or read-receipt extension
  until its IMCore bridge is separately attested. Its port still fails a
  direct unsupported method call closed without disconnecting unrelated text
  send/receive operations.

## Troubleshooting

An imsg `send` response with JSON-RPC internal-error code `-32603` does not
prove that nothing was sent. The port reports `SendRpcOutcomeUnknown`, mapped
to `transport.send_ambiguous` at `provider_call_started`. Sends enter `maybe_sent`;
without delivery corroboration, recovery preserves their uncertain effect and
quarantines them instead of recording deterministic non-delivery. Numeric and string forms
of the code are accepted. Read-operation errors and deterministic invalid-request,
method-not-found and invalid-params refusals keep their existing classification.

The typed `transport.send_ambiguous` result prevents automatic durable replay even
when a caller declares `replayPolicy: safe` or `read_only`: that label does not
prove provider deduplication. Existing matching delivery evidence may still
confirm the send. Socket-to-SQLite tests prove one send across database reopen
and pending drain for these policies, not a real process kill or the complete
turn-finalizer/supervisor lifecycle. Typed ambiguity atomically persists an
`unsafe` replay policy that older recovery code understands. Pre-connect recovery
applies the same policy to historical typed `maybe_sent` rows, while retaining
immutable corroborated proof. Before rollback, require successful pre-connect
recovery and qualification of the target version. Rows already reset to `pending`
by older recovery, or written after the last successful upgrade recovery, are
outside that historical-row protection.
Service-route qualification remains separate: this mapping does not force
iMessage, prevent upstream bridge/AppleScript fallback or prove delivery. See
[#3841](https://github.com/LucasQuiles/WhatSoup/issues/3841) and
[#3844](https://github.com/LucasQuiles/WhatSoup/issues/3844), plus the
[`transport.send_ambiguous` runbook](transport-error-send-ambiguous.md).

| Symptom | Likely cause | Fix |
|---|---|---|
| `imessageConfig is required when transport is "imessage"` | missing config block | add `imessageConfig` to instance.json |
| `keyring has no credential for service …` | password not in keyring | store the BlueBubbles password under the configured service name |
| `bluebubbles HTTP error: connect ECONNREFUSED` | Server down / wrong URL / firewall | verify BlueBubbles Server is running and the URL is reachable from this host |
| `HTTP 401` on every call | wrong/expired Server password | update the keyring entry |
| `imsg socket error: ECONNREFUSED` | relay not running or wrong path | start `npm run imsg:relay -- --socket … --imsg-bin …` as the signed-in GUI user |
| Relay rejects startup | unsupported imsg version or unsafe occupied socket path | install the pinned imsg version; remove only a verified stale same-user socket, never a regular file or symlink |
| Sends land, no inbound | wrong `sender` / relay on a different Mac | `sender` must be the signed-in AppleID of the backend's Mac |

## References

- Spec: `2026-07-20-signal-and-imessage-transports-spec.md` (internal spec, tracked outside this repository)
- Port interface: `src/transport/imessage/port.ts`
- Port impls: `src/transport/imessage/bluebubbles-port.ts`, `src/transport/imessage/imsg-port.ts`
- imsg relay: `src/transport/imessage/imsg-rpc-relay.ts`, `scripts/imsg-rpc-relay.ts`
- Adapter: `src/transport/imessage/adapter.ts`
- Bridge: `src/transport/imessage/connection-bridge.ts`
- Validator: `src/core/agent-config-validator.ts` (`validateImessageConfig`)
