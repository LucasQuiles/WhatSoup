# iMessage Transport (BlueBubbles / imsg)

This runbook covers operating a WhatSoup instance on iMessage via either
supported backend: BlueBubbles Server (HTTP) or the macOS-native `imsg`
daemon.

## Architecture

```
WhatSoup instance
  └─ ImessageConnection (src/transport/imessage/connection-bridge.ts)
      └─ ImessageAdapter (src/transport/imessage/adapter.ts)
          └─ ImessagePort
              ├─ BlueBubblesPort (backend: 'bluebubbles')  ←  BlueBubbles Server REST API
              └─ ImsgPort        (backend: 'imsg')         ←  imsg daemon JSON-RPC (UNIX socket)
```

The adapter depends only on the narrow `ImessagePort` interface; the
`backend` config field selects the port at factory time. Both backends are
macOS-hosted: BlueBubbles Server runs on a Mac signed into iMessage; the
imsg daemon reads `chat.db` and sends via the Messages framework on the
signed-in Mac itself.

## Choosing a backend

| | BlueBubbles (`bluebubbles`) | imsg daemon (`imsg`) |
|---|---|---|
| **Host** | Any Mac (Mac mini/Studio ideal) | The signed-in Mac itself |
| **WhatSoup host** | Any host that can reach the Server's URL | Must run ON the Mac |
| **API** | REST over HTTP(S) | JSON-RPC over UNIX socket |
| **Auth** | Pre-shared Server password (keyring) | Local process trust |
| **Extensions (v1)** | reactions, typing, read receipts | same surface; older daemon builds may lack the bridge methods (`UnsupportedMethod`/501 — the adapter parks the extension) |
| **Recommended for** | Linux/ARM WhatSoup hosts (e.g. pi5) | macOS WhatSoup hosts |

## Prerequisites

### BlueBubbles

1. A Mac signed into iMessage with [BlueBubbles Server](https://bluebubbles.app)
   installed and running.
2. The REST API enabled; note the **server URL** and **password**.
3. Store the password under the exact line-bound keyring service
   `whatsoup-bluebubbles-<line-name>` (for example,
   `whatsoup-bluebubbles-ops-imessage`). WhatSoup resolves it at startup via
   `bluebubblesPasswordService` and never logs it. Services for other providers
   or WhatSoup lines are rejected before lookup.
4. URL reachability from the WhatSoup host. HTTPS is required outside
   loopback; plain HTTP is accepted only for `localhost`, `127.0.0.0/8`, or
   `[::1]`.

### imsg daemon

1. The WhatSoup host IS the Mac signed into iMessage.
2. `imsg` installed and granted Full Disk Access (for `chat.db`).
3. The daemon running before WhatSoup connects:

   ```bash
   imsg daemon --socket /tmp/imsg.sock
   ```

   Run it under launchd; WhatSoup does NOT supervise the daemon.

Both backends use **config-only auth** (matches the Twilio precedent — no
`pnpm auth` flow for iMessage).

## Instance config

The instance's `config.json` (validated by `agent-config-validator.ts`):

```json
{
  "name": "ops-imessage",
  "type": "passive",
  "transport": "imessage",
  "accessMode": "self_only",
  "adminPhones": ["owner@example.com"],
  "imessageConfig": {
    "account": "ops-imessage",
    "backend": "bluebubbles",
    "bluebubblesUrl": "https://bb.example.test",
    "bluebubblesPasswordService": "whatsoup-bluebubbles-ops-imessage",
    "sender": "owner@example.com",
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
| `bluebubblesUrl` | backend=bluebubbles | HTTPS URL of the Server, or HTTP on loopback only; userinfo, query strings, and fragments are rejected |
| `bluebubblesPasswordService` | backend=bluebubbles | Exact line-bound keyring service `whatsoup-bluebubbles-<line-name>` |
| `imsgSocketPath` | no (imsg only) | Default `/tmp/imsg.sock`, must be absolute |
| `inboundMode` | no | `poll` (default and only implemented mode) |
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
| Reactions (tapback: 👍👎❤️‼️❓😂 + remove) | ✅ |
| Typing indicators (composing/stopped) | ✅ |
| Read receipts (per conversation, coalesced GUIDs) | ✅ |
| Remote delete | ❌ iMessage has no remote-delete protocol (documented parity gap) |
| Media attachments | ❌ deferred (adapter declares `media.maxBytes: 0`) |
| Polls | ❌ rejected (WhatsApp-only feature) |
| `webhook` inbound mode | ❌ rejected until an authenticated receiver is implemented |

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
- An older imsg daemon lacking the react/typing/read bridge methods answers
  with `UnsupportedMethod` (501); the adapter parks that extension and the
  transport keeps running.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `imessageConfig is required when transport is "imessage"` | missing config block | add `imessageConfig` to the instance's `config.json` |
| `keyring has no credential for service …` | password not in keyring | store the BlueBubbles password under the configured service name |
| `bluebubbles HTTP error: connect ECONNREFUSED` | Server down / wrong URL / firewall | verify BlueBubbles Server is running and the URL is reachable from this host |
| `HTTP 401` on every call | wrong/expired Server password | update the keyring entry |
| `imsg socket error: ECONNREFUSED` | daemon not running | start `imsg daemon --socket …` (launchd) |
| Sends land, no inbound | wrong `sender` / daemon on a different Mac | `sender` must be the signed-in AppleID of the backend's Mac |

## References

- Port interface: `src/transport/imessage/port.ts`
- Port impls: `src/transport/imessage/bluebubbles-port.ts`, `src/transport/imessage/imsg-port.ts`
- Adapter: `src/transport/imessage/adapter.ts`
- Bridge: `src/transport/imessage/connection-bridge.ts`
- Validator: `src/core/agent-config-validator.ts` (`validateImessageConfig`)
