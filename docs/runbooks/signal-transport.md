# Signal Transport

WhatSoup connects to Signal through a separately managed `signal-cli` JSON-RPC
daemon. The daemon owns Signal credentials and identity keys; WhatSoup stores
only its endpoint and the account's public E.164 identity.

## Start signal-cli

Install a current `signal-cli` release, link or register the account using its
documented out-of-band flow, and run a single-account daemon in manual receive
mode. This boundary was verified against `signal-cli` v0.14.4.1. Manual mode is
required because WhatSoup drains inbound envelopes with bounded `receive` calls.

UNIX socket:

```bash
install -d -m 0700 /run/user/1000/whatsoup
umask 0077
signal-cli -a +15551234567 daemon \
  --receive-mode=manual \
  --ignore-attachments \
  --ignore-stories \
  --ignore-avatars \
  --ignore-stickers \
  --socket /run/user/1000/whatsoup/signal.sock
```

TCP loopback endpoint:

```bash
signal-cli -a +15551234567 daemon \
  --receive-mode=manual \
  --ignore-attachments \
  --ignore-stories \
  --ignore-avatars \
  --ignore-stickers \
  --tcp 127.0.0.1:7583
```

These daemon flags are required while Signal media is unsupported. The
JSON-RPC `receive` call cannot override the daemon's media-download policy; if
the flags are omitted, unsupported inbound media can still consume disk in
signal-cli's data directory even though WhatSoup discards it.

WhatSoup does not start or supervise this process. Put the UNIX socket in a
private `0700` directory and use a restrictive umask. TCP is plaintext and
WhatSoup accepts only a loopback host; never expose it to another machine.

## Configure the instance

Configure exactly one explicit endpoint. Missing and dual endpoints fail
closed so an instance cannot silently attach to the wrong local daemon.

```json
{
  "name": "ops-signal",
  "type": "agent",
  "transport": "signal",
  "signalConfig": {
    "account": "ops-signal",
    "phoneNumber": "+15551234567",
    "socketPath": "/run/user/1000/whatsoup/signal.sock",
    "inboundMode": "poll",
    "pollIntervalMs": 15000,
    "rateLimit": { "messagesPerMinute": 30 }
  }
}
```

For TCP, replace `socketPath` with `tcpPort` and optionally `tcpHost`; an
explicit host must be `127.0.0.1`, `::1`, or `localhost`.
`inboundMode` accepts only `poll`; `stream` fails validation because no tested
streaming implementation exists. The per-conversation rate limit is enforced
before the provider call.

No provider password, registration PIN, or identity key belongs in
`instance.json`. Those remain in signal-cli's own credential store.

## Identity and capabilities

- Direct participants use E.164 or UUID identities with the synthetic
  `@signal` suffix inside WhatSoup.
- Inbound identities use the provider E.164 when it is exposed and otherwise
  fall back to UUID. Configure an admin with the exact identity the daemon
  emits under that contact's Signal phone-number privacy setting: E.164 when
  visible, UUID when private. WhatSoup does not infer a private UUID↔phone map,
  so changing that privacy setting can change the conversation/admin identity.
- V2 group IDs are base64 and share that suffix. Group traffic is keyed by the
  group ID while the sender remains the member UUID.
- Text send/receive works for direct and group conversations.
- Typing, direct-message read receipts, and remote delete use native signal-cli
  operations.
- Reactions fail closed until message references carry the target author
  separately from the conversation. Group read receipts also fail closed until
  the sender can be resolved separately from the group.
- Media, voice notes, and Signal polls are not exposed by this foundation.

## Health and recovery

Connection failure rejects every pending JSON-RPC request immediately and
invalidates the cached socket. The next operation creates a fresh connection;
WhatSoup never automatically retries an ambiguous send.

Inbound polling passes a provider-side `maxMessages` bound (500 in the runtime
poller) before signal-cli drains its manual receive queue. The boundary is not
durable at-least-once delivery: a process crash after signal-cli drains a batch
but before WhatSoup persists it can lose that batch. The composite envelope key
prevents duplicates only for records WhatSoup actually observes.

At connect, WhatSoup calls the account-bound `listDevices` command to prove the
daemon can use its local account store. The command cannot expose the daemon's
self E.164, so the operator must ensure `phoneNumber` equals the daemon `-a`
identity. An unregistered-account response emits the protected
`signal_cli_unregistered` alert source. Repair the account through signal-cli's
out-of-band flow, restart the daemon, and reconnect the instance. Signal-scoped
socket error/close/end/write and RPC-timeout messages use the transport retry
budget. An unrelated service's `ECONNREFUSED` or timeout is not classified as a
Signal recovery event.

The automated boundary test uses a hermetic local JSON-RPC server. A live
provider send/receive remains unproven unless an operator separately authorizes
disposable Signal credentials.

## Troubleshooting

| Symptom | Check |
|---|---|
| `signalConfig is required` | Add a `signalConfig` block to the Signal instance. |
| `signal-cli socket error` | Confirm the daemon and configured endpoint are available. |
| `signal_cli_unregistered` | Re-link or register using signal-cli; do not place credentials in WhatSoup config. |
| No inbound messages | Confirm the daemon uses `--receive-mode=manual` and the configured account matches. |
| A send returns no timestamp | Treat it as failed; WhatSoup requires signal-cli's canonical timestamp. |

See the [signal-cli JSON-RPC manual](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc)
and [signal-cli command manual](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc)
for provider commands and current prerequisites.
