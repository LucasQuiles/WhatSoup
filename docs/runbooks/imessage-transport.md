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
| `inboundMode` | no | `poll` (default) or `webhook` (**bluebubbles only**) |
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
- **Message ids:** provider GUIDs (BlueBubbles) or stringified `chat.db`
  ROWIDs (imsg), surfaced as `MessageRef.id`.

## Capabilities (v1)

| Feature | State |
|---|---|
| Text send/receive (1:1 + group) | ✅ |
| Reactions (tapback: 👍👎❤️‼️❓😂 + remove) | ✅ BlueBubbles; not advertised for imsg without IMCore attestation |
| Typing indicators (composing/stopped) | ✅ BlueBubbles; not advertised for imsg without IMCore attestation |
| Read receipts (per conversation, coalesced GUIDs) | ✅ BlueBubbles; not advertised for imsg without IMCore attestation |
| Remote delete | ❌ unsupported by both v1 ports |
| Media attachments | ❌ deferred (adapter declares `media.maxBytes: 0`) |
| Polls | ❌ rejected (WhatsApp-only feature) |
| `webhook` inbound mode | BlueBubbles only |

## Health + recovery

- Transient backend failures (`bluebubbles http error`,
  `bluebubbles connection lost`, `imsg socket error`, `imsg rpc timeout`)
  classify as **transient** in the bot-errors dispatcher and ride the long
  retry budget; they never burn the permanent dead-letter cap.
- `bluebubbles_connection_lost` and `imessage_device_delinked` are
  auto-close-protected sources: a dead backend means the monitoring path
  itself is down — silence is not proof of repair.
- BlueBubbles HTTP 401 = bad/expired Server password → check the keyring
  entry for `bluebubblesPasswordService`.
- The imsg backend advertises no reaction, typing, or read-receipt extension
  until its IMCore bridge is separately attested. Its port still fails a
  direct unsupported method call closed without disconnecting unrelated text
  send/receive operations.

## Troubleshooting

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
