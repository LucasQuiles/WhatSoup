# SP9 Broadcast Lists — Proof Test Result

**Date:** 2026-04-04
**Baileys version:** `@whiskeysockets/baileys` v7.0.0-rc.9
**Status:** GATE FAILED — SP9 deferred

---

## What Was Searched

Exhaustive static analysis of all compiled Baileys implementation files under
`node_modules/@whiskeysockets/baileys/lib/`, specifically:

```
grep -rn "broadcast" lib/ | grep -v lib/Types/
```

Files inspected in detail:
- `lib/Socket/messages-send.js` — primary send path
- `lib/Socket/messages-recv.js` — receive path
- `lib/Utils/messages.js` — message generation utilities
- `lib/Utils/generate-wa-message.js` — WAMessage construction
- `lib/Utils/decode-wa-message.js` — inbound decode
- `lib/Utils/process-message.js` — message processing
- `lib/WABinary/jid-utils.js` — JID helpers
- `lib/WABinary/constants.js` — binary protocol constants
- `lib/WAM/constants.js` — WAM telemetry constants
- `lib/Types/Message.d.ts` — type declarations (excluded from search)

---

## What Was Found

### The type declaration exists — the implementation does not consume it

`lib/Types/Message.d.ts:243` declares:

```typescript
/** if it is broadcast */
broadcast?: boolean;
```

This is part of `MiscMessageGenerationOptions`. The field exists in the TypeScript
type contract and is passed through to `generateWAMessage` via spread (`...options`
at `messages-send.js:916`). However, **no implementation code reads `options.broadcast`
or `broadcast` from the generated message options in any send path**.

### Full inventory of "broadcast" in implementation files

| File | Line | Content | Classification |
|------|------|---------|----------------|
| `Socket/messages-send.js` | 407 | `const statusJid = 'status@broadcast'` | JID constant — unrelated to options flag |
| `Utils/decode-wa-message.js` | 130 | `peer_broadcast` / `other_broadcast` | Inbound message type classification only |
| `Utils/decode-wa-message.js` | 163 | `broadcast: isJidBroadcast(from)` | Sets field on received message struct — not send path |
| `Utils/process-message.js` | 73 | Comment about broadcast JIDs | Comment only |
| `WABinary/jid-utils.js` | 5, 68–73 | `STORIES_JID`, `isJidBroadcast`, `isJidStatusBroadcast` | JID predicate utilities |
| `WABinary/constants.js` | 1068 | `'broadcast'` in binary token list | Wire-protocol token table, not options handling |
| `WAM/constants.js` | 18158–18159 | `broadcastMsgsReceived`, `broadcastMsgsSent` | Telemetry metric names only |

### The send path does not branch on `broadcast: true`

In `messages-send.js`, the `sendMessage` function (line 882) spreads `options` into
`generateWAMessage` and then calls `relayMessage` with this explicit destructuring:

```javascript
await relayMessage(jid, fullMsg.message, {
    messageId: fullMsg.key.id,
    useCachedGroupMetadata: options.useCachedGroupMetadata,
    additionalAttributes,
    statusJidList: options.statusJidList,
    additionalNodes
});
```

`options.broadcast` is never forwarded to `relayMessage`. The `relayMessage` function
signature (line 402) does not accept a `broadcast` parameter. There is no conditional
branch anywhere in the send path that checks for a broadcast flag to alter routing,
encryption, or delivery behavior.

### The only working broadcast mechanism is `status@broadcast`

Status/Stories posting works because Baileys has a dedicated code path for
`jid === 'status@broadcast'` (the `isStatus` branch in `relayMessage`). This is a
special JID with its own sender-key group management — it is not a generic "broadcast
to multiple recipients" mechanism.

Sending to a list JID (e.g. `12345@broadcast`) would be treated by `relayMessage` as
an unknown server type — neither `g.us` (group) nor `status@broadcast` nor `newsletter`
— and would fall through to individual-device fanout, which is not how broadcast lists
work on the WhatsApp wire protocol.

### No CHANGELOG

No `CHANGELOG.md` exists in the package. The README confirms v7.0.0 introduced breaking
changes and redirects to an external migration guide (https://whiskey.so/migrate-latest)
with no broadcast list documentation found.

---

## Verdict: `broadcast: true` is vestigial

The `broadcast?: boolean` field in `MiscMessageGenerationOptions` is a type-only
artifact. It was declared in the type contract but never wired into any send-path logic
in v7.0.0-rc.9. Passing `broadcast: true` to `sendMessage` has no effect on message
routing or delivery.

**There is no Baileys API for sending to WhatsApp broadcast lists.** The protocol
would require:
1. Fetching the broadcast list membership from WhatsApp servers
2. Using the broadcast list JID format (`<id>@broadcast`) with proper sender-key setup
3. Encoding the message with the broadcast list group identity

None of this is exposed or implemented in the current Baileys build.

---

## Recommendation: CUT SP9

Per the gate condition in the Phase 2 spec:

> SP9 implementation only proceeds if the proof harness confirms reliable delivery.
> This gate is checked manually before writing the implementation plan.

The gate has failed. `broadcast: true` does not work. No alternative broadcast list
send path exists in Baileys v7.0.0-rc.9.

**Decision: Cut SP9 from Sprint B.** Do not implement `send_broadcast` tool.

If broadcast list support is needed in the future, the correct path is:
- Wait for upstream Baileys to implement the broadcast list wire protocol
- Or implement it directly by reverse-engineering WhatsApp Web's broadcast list
  message construction (significant effort, high protocol risk)

SP8 (Status/Stories via `status@broadcast`) is unaffected — that path works and
should proceed on its own merits.
