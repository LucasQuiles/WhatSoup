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
| Reactions (tapback-style, single per user) | ✅ |
| Typing indicators (composing/stopped) | ✅ |
| Read receipts (per message timestamp) | ✅ |
| Remote delete (`delete-for-everyone`) | ✅ |
| Media attachments | ❌ deferred (adapter declares `media.maxBytes: 0`) |
| Polls | ❌ rejected (WhatsApp-only feature) |

## Health + recovery

- `health.whatsapp` does NOT apply; the generic transport-health block is
  the read path (see the front-end design §8).
- Transient daemon failures (`signal-cli socket error`, `ECONNREFUSED`,
  RPC timeout) classify as **transient** in the bot-errors dispatcher and
  ride the long retry budget; they never burn the permanent dead-letter cap.
- `signal_cli_unregistered` (daemon reports the account unlinked) is an
  auto-close-protected source: silence is not proof of repair. Re-link
  (`signal-cli link`) and restart the daemon.
- The adapter parks at `auth_required` on unregistered and stops the poll
  loop; transient errors keep the loop alive and log via the bridge's
  error subscriber.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `signalConfig is required when transport is "signal"` | missing config block | add `signalConfig` to instance.json |
| `signal-cli socket error: ECONNREFUSED` | daemon not running | start `signal-cli daemon --socket …` |
| `Unregistered user` on send | linked session revoked/expired | re-link the device, restart daemon |
| No inbound messages | `receive` timeout too short / wrong account flag | verify daemon was started with `-a <number>` matching `phoneNumber` |
| Sends land but no echoes | sync envelopes filtered | check daemon version ≥ 0.13 (syncMessage support) |

## References

- Spec: `~/LAB/oc-re/specs/2026-07-20-signal-and-imessage-transports-spec.md`
- Port interface: `src/transport/signal/port.ts`
- Port impl: `src/transport/signal/signal-cli-port.ts`
- Adapter: `src/transport/signal/adapter.ts`
- Bridge: `src/transport/signal/connection-bridge.ts`
- Validator: `src/core/agent-config-validator.ts` (`validateSignalConfig`)
