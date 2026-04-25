# WhatSoup v2 — Transport Layer (Spec 1)

| Field | Value |
|---|---|
| Spec | 1 of N for WhatSoup v2 |
| Date | 2026-04-25 |
| Status | Draft, pending implementation-plan |
| Predecessor blueprint | `/Users/q/LAB/AgentSea/blueprint/{08-agentsea-design-proposal,12-delta-map,07-works-and-doesnt}.md` |
| Repo target | `/Users/q/LAB/WhatSoup` (in-place v2; no separate repo) |
| Migration model | Strangler fig, gated by per-instance `transport.useV2` |

---

## 1. Scope and goals

### 1.1 What this spec ships

A transport-layer abstraction (`TransportAdapter` + à-la-carte extension interfaces) plus two adapters: WhatsApp (Baileys, ported behind the seam) and Telegram (Bot API, new). The runtime, MCP tool layer, and durability ledger talk to adapters, not to provider libraries. Spec 1 also delivers the operational scaffolding to run this safely in production: bounded queues with fanout, persistent dedup, structured error envelope with scope/phase, ambiguous-send reconciliation, dead-letter handling, capability-negative coverage, and standardized health/metrics.

### 1.2 What this spec does *not* ship

Identity graph (cross-transport identity joins), automatic retry (no real adapter declares idempotency in Spec 1), console transport-aware UI, BlueBubbles/Signal/Discord/SMS adapters, full per-instance API-key redesign, tool-name cutover beyond aliases. Each becomes its own spec.

### 1.3 Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| L1 | v2 is fork-mode A/B (in-place inside `/Users/q/LAB/WhatSoup`); the `/Users/q/LAB/AgentSea/` directory is archive-only. |
| L2 | v2 ambition = cleaner foundation + audit-fix bake-in + transport abstraction + identity graph + second transport shipped. |
| L3 | Spec 1 = `TransportAdapter` contract + Baileys port behind it + Telegram Bot adapter. |
| L4 | Identity graph deferred to a follow-up spec; Spec 1 keys on `(channel, conversation_id)` only. |
| L5 | Strangler fig migration; both paths coexist until last call site converted. |
| L6 | Capability model: small core interface + à-la-carte extension interfaces; type guards (no runtime "unsupported" exceptions for missing capabilities). |
| L7 | Tool surface migration: aliases now (`whatsapp_send_message` and `conversation.send_message` both functional), full transport-neutral cutover in a follow-up spec. |
| L8 | Architecture style: event-driven adapter, bounded queues, disposable subscription handles. |

---

## 2. Architecture

### 2.1 Module layout

```
src/core/
  transport-refs.ts        ← domain primitives (ChannelId, ConversationRef, ParticipantRef, MessageRef)
  reconciliation.ts        ← auto + suggestion + operator paths
  …existing modules unchanged

src/transport/
  contract/                ← THE SEAM (no provider imports here)
    adapter.ts             core TransportAdapter interface
    capabilities.ts        Capabilities, IdempotencyDeclaration, partial-mode types
    extensions.ts          extension interfaces (à la carte)
    events.ts              InboundMessage, OutboundStatusEvent, …
    commands.ts            OutboundMessage, SendOptions, …
    errors.ts              TransportError + subclasses with scope/phase/caller_kind
    error-codes.ts         stable enum + CI dup/undocumented check
    queue.ts               BoundedQueue<T> with counters
    fanout.ts              FanoutDispatcher (per-subscriber queues + drain)
    subscription.ts        Subscription { dispose() }
    index.ts               re-exports

  baileys/                 ← FIRST ADAPTER (port of existing code)
    adapter.ts             implements TransportAdapter + 9 extensions
    auth.ts                QR / multi-device session lifecycle
    inbound.ts             Baileys events → contract events
    outbound.ts            contract commands → Baileys calls
    media.ts
    typing.ts              SupportsTyping
    presence.ts            SupportsPresence
    legacy/
      internal.ts          private Baileys-internal event re-emitter (compat-shim only)
      baileys-compat.ts    re-emits Baileys-shaped legacy events for non-converted call sites
    index.ts

  telegram/                ← SECOND ADAPTER (new)
    adapter.ts             implements TransportAdapter + Spec-1 extension set
    auth.ts                bot token + getMe verification
    webhook.ts             HTTP receiver (path-secret, body-cap, dedup, redaction)
    inbound.ts
    outbound.ts
    media.ts
    typing.ts              SupportsTyping (sendChatAction)
    keyboards.ts           SupportsInlineKeyboards
    index.ts

  testing/
    in-memory.ts           InMemoryAdapter (all extensions, idempotency: 'simulated')
    minimal-text.ts        MinimalTextAdapter (core only — for capability-negative tests)

  registry.ts              instance config → adapter factory + ownership lock
```

### 2.2 Boundaries and import rules

- **Domain refs** (`ChannelId`, `ConversationRef`, `ParticipantRef`, `MessageRef`, `refToKey`, `msgToKey`) live in `src/core/transport-refs.ts`. They are used by runtime, DB layer, MCP tools, and adapters. The contract module re-exports them so adapters can `import { ConversationRef } from '../contract'`.
- **`src/core/` and runtime/MCP code** may import from `src/transport/contract/`. They **must not** import from `src/transport/baileys/*` or `src/transport/telegram/*`. Enforced by ESLint rule + CI grep.
- **No file outside `src/transport/baileys/` and `src/transport/baileys/legacy/` may import `@whiskeysockets/baileys`.** Enforced by ESLint rule + CI grep.
- **Only `src/transport/baileys/legacy/baileys-compat.ts`** may import from `src/transport/baileys/legacy/internal.ts`. The internal re-emitter is private to the compat shim.

### 2.3 Operational attachment (Spec 1 must include)

- `instance.json` schema additions: `transport.kind: ChannelKind` (`'whatsapp' | 'telegram'`), `transport.useV2: boolean`, adapter-specific config block. The instance's `channel_id` is derived as `makeChannelId(transport.kind, instance_name)` — e.g., the systemd unit `whatsoup@mw-bot.service` running with `transport.kind='whatsapp'` produces `channel_id = 'whatsapp:mw-bot'`. Operators can override via optional `transport.account` if they need an account-name distinct from the instance name. Startup validation fails fast on missing/invalid config (no production "best guess" defaults).
- Fleet exposes a generic `transport-status` route per instance: health enum + reasonCode, current path (`legacy | mixed | contract`), capabilities snapshot, queue depths, subscriber states.
- Console transport-aware UI is **out of scope**. Backend status surfaces are sufficient for operator action.

### 2.4 What stays in the runtime

`src/runtimes/{passive,chat,agent}/` retain their three-codepath split. Their inbound handlers receive `InboundMessage` (contract event) instead of Baileys-shaped objects. `src/core/ingest.ts` consumes `InboundMessage` and produces the existing internal `IngestEvent` shape — that translation is the only seam in the runtime that needs to change. Durability, identity resolution, echo-guard remain on the runtime side; they speak `(channel, conversation_id)` keys.

### 2.5 What the schema gains

#### Additive columns on existing tables

`channel_id` is added (nullable during migration; `NOT NULL` after PR 11) on `messages`, `outbound_ops`, `inbound_events`. `conversation_key` rows stay valid; new code constructs `ConversationRef` from `(channel_id, conversation_key)`. Indexes that include `conversation_key` add `channel_id` as a leading column. Reads include both, not just `COALESCE`.

#### Composite uniqueness — replacing global `message_id UNIQUE`

The current schema has `messages.message_id TEXT UNIQUE` and `inbound_events UNIQUE(message_id)` (`src/core/database.ts:19, 125`). Both were correct for WhatsApp-only because Baileys message keys are globally unique. They are wrong for Telegram, where `message_id` is per-chat — two different Telegram conversations will legitimately produce the same `message_id` and the existing `UNIQUE` will reject the second.

Migration:

- `messages`: drop the column-level `UNIQUE` on `message_id`; add a composite `UNIQUE (channel_id, conversation_key, message_id)`. Existing WhatsApp rows pass the new constraint trivially because their `message_id` was already globally unique within the WhatsApp namespace.
- `inbound_events`: drop `UNIQUE(message_id)`. The dedup invariant moves to a new dedicated table `transport_inbound_dedup` keyed on `(channel_id, inbound_event_key)` (where the adapter derives `inbound_event_key` per provider — Baileys canonical message-key, Telegram `String(update_id)`).

#### New tables

- **`transport_inbound_dedup(channel_id, inbound_event_key, first_seen_at)` UNIQUE `(channel_id, inbound_event_key)`** — durable inbound dedup. A duplicate insert is a no-op + metric.
- **`transport_diagnostics`** — adapter-emitted diagnostic rows (decryption failures, webhook anomalies). Used by health-threshold logic; never participates in dispatch.
- **`transport_reconciliation_suggestions`** — content-echo matches that didn't reach `success_inferred` confidence; stored for operator review.
- **`transport_audit`** — append-only operator audit trail. Schema: `(id, actor, action, target_table, target_pk, before_json, after_json, created_at)`. `action` enum: `mark_delivered | mark_failed | replay | skip | accept_suggestion | reject_suggestion | stale_lock_recovery`.
- **`inbound_event_delivery(inbound_event_id, subscriber_id, state, attempts, last_error_code, last_error_at, last_attempt_at)` PRIMARY KEY `(inbound_event_id, subscriber_id)`** — per-subscriber delivery state. Allows "subscriber A dead-lettered, subscriber B dispatched" cleanly. `state` enum: `received | dispatched | dead_letter | skipped`. The original `inbound_events.processing_status` (used today for turn recovery, `src/core/database.ts:122`) is **left in place** and continues to track turn-level recovery; it is not the per-subscriber state.
- **Per-subscriber cursor table** `inbound_subscriber_cursor(subscriber_id, channel_id, last_processed_seq, updated_at)` — durable subscribers track their advance through `inbound_events`; restart resumes from cursor.

#### New columns on `outbound_ops`

`correlation_id`, `idempotency_key`, `phase`, `outcome`, `predicted_message_ref`, `contract_version`.

Compatibility with the existing `status` column (currently read directly by legacy code at multiple call sites):

- The `status` column is **dual-written**, not replaced by a view. Every code path that updates `phase`/`outcome` simultaneously updates `status` to the equivalent legacy value via a small adapter helper (`projectStatus(phase, outcome) → status`). Legacy readers continue to read `status` and see correct values throughout the migration.
- A read-only view `outbound_ops_status_v1` exists for documentation and ad-hoc queries — it computes `status` from `(phase, outcome)` for any row a future migration writes without going through the helper. The view is **not** load-bearing for any runtime code path.
- Legacy readers are migrated to read `phase`/`outcome` directly in the same PR that converts the corresponding writer (i.e., reads and writes for a given call site move together). When the last legacy reader is converted, dual-write is retired in a follow-up cleanup PR.
- No new state names like `intent_recorded` or `provider_call_failed` are introduced — those concepts are expressed as `(phase=not_started, outcome=null)` for in-flight, `(phase=not_started, outcome=transient_failure)` for pre-I/O failure, etc.

Two columns that the reconciliation flow depends on:

- **`predicted_message_ref`** is the optimistic `MessageRef` the adapter returned (or attempted to return) for an outbound at `provider_call_started` time. It may differ from the provider's eventually-assigned ref. Reconciliation matches `'outbound-status'` events against this ref; the column may be NULL when the provider doesn't expose a ref pre-ack.
- **`contract_version`** is a small integer (starts at 1) that lets future schema migrations and replay tooling discriminate ledger row shapes.

#### State and outcome enums

- `inbound_event_delivery.state` enum: `received | dispatched | dead_letter | skipped`.
- `outbound_ops.phase` enum: `not_started | provider_call_started | ack_received`.
- `outbound_ops.outcome` enum (NULL while in-flight): `success | transient_failure | permanent_failure | ambiguous | rate_limited | auth_required | success_inferred`.

### 2.6 Strangler ordering (high-level; PR-by-PR in §8)

1. Outbound text send (split into 3 PRs: MCP / runtime / scheduled).
2. Inbound message ingest.
3. Outbound media.
4. Reactions, edits, deletes (+ `SupportsOutboundStatus` for Baileys).
5. Typing, presence.
6. Deep Baileys auth extraction (last; QR/session/credentials move fully behind the adapter).

`connect()` / `disconnect()` and Telegram token verification are day-one concerns of the contract; only the deep extraction of Baileys' auth state machine waits until step 6. The Telegram adapter implementation begins after step 2 lands — it has a working inbound contract to validate against.

---

## 3. Core interface and extensions

### 3.1 Domain types

`ChannelKind` is the transport library / protocol. `ChannelId` is the per-account identity for a particular adapter instance — distinct from `ChannelKind` because we may eventually run multiple WhatsApp accounts (mw-bot, anabot) or multiple Telegram bots (studio-bot, ops-bot) on the same fleet, and locks/dedup/metrics need to discriminate at the account level, not just the protocol level.

```ts
// src/core/transport-refs.ts
export type ChannelKind =
  | 'whatsapp'
  | 'telegram'
  // future: 'imessage' | 'signal' | 'discord' | 'sms'
  ;

// Branded string of the form `${ChannelKind}:${accountName}`.
// Examples: 'whatsapp:mw-bot', 'telegram:studio-bot'.
// Format is enforced by a constructor; raw assignment is a type error.
declare const __channelIdBrand: unique symbol;
export type ChannelId = string & { readonly [__channelIdBrand]: true };

export const makeChannelId = (kind: ChannelKind, account: string): ChannelId => {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(account)) {
    throw new Error(`invalid account segment: ${account}`);
  }
  return `${kind}:${account}` as ChannelId;
};
export const kindOf = (id: ChannelId): ChannelKind => id.split(':', 1)[0] as ChannelKind;
export const accountOf = (id: ChannelId): string => id.slice(id.indexOf(':') + 1);

export interface ConversationRef {
  readonly channel: ChannelId;
  readonly id: string;
}
export interface ParticipantRef {
  readonly channel: ChannelId;
  readonly id: string;
}
export interface MessageRef {
  readonly channel: ChannelId;
  readonly conversation: string;
  readonly id: string;                 // transport_message_id (per-conversation)
}

export const refToKey = (r: ConversationRef): string => `${r.channel}:${r.id}`;
export const msgToKey = (m: MessageRef): string =>
  `${m.channel}:${m.conversation}:${m.id}`;
```

`MessageRef` is the canonical message identity in v2. `(channel, conversation, transport_message_id)` is globally unique even when `transport_message_id` is per-conversation (Telegram). Schema constraints (§2.5) enforce composite uniqueness rather than relying on the existing single-column `messages.message_id UNIQUE` (which is per-account-incompatible and gets dropped during migration).

### 3.2 Capabilities (partial-mode, not booleans)

```ts
// src/transport/contract/capabilities.ts
export interface Capabilities {
  readonly channel: ChannelId;            // per-account, e.g. 'whatsapp:mw-bot'
  readonly kind: ChannelKind;              // 'whatsapp' (derivable via kindOf(channel); duplicated for ergonomics)
  readonly extensions: ReadonlySet<ExtensionName>;
  readonly maxTextLength: number;
  readonly auth: 'qr' | 'token' | 'phone' | 'oauth';

  // Partial modes — adapter declares what it can actually do.
  readonly readReceipts: 'none' | 'conversation' | 'message';
  readonly reactions:    'none' | 'single' | 'multiple';
  readonly media: {
    readonly maxBytes: number;
    readonly mimeAllowlist: ReadonlyArray<string>;
  };
  readonly idempotency: IdempotencyDeclaration;
}

export interface IdempotencyDeclaration {
  readonly sendText:  'none' | 'native' | 'simulated';
  readonly sendMedia: 'none' | 'native' | 'simulated';
  readonly react:     'none' | 'native' | 'simulated';
  readonly editText:  'none' | 'native' | 'simulated';
  readonly delete:    'none' | 'native' | 'simulated';
}

export type ExtensionName =
  | 'media' | 'voice-notes' | 'reactions' | 'edit' | 'delete'
  | 'typing' | 'presence' | 'groups' | 'read-receipts'
  | 'inline-keyboards' | 'outbound-status';
```

In Spec 1, `idempotency` declarations are `'none'` for both BaileysAdapter and TelegramAdapter. `'simulated'` is permitted only for `InMemoryAdapter` (test-only, gated by name). Future adapters that ship `'native'` or `'simulated'` must implement and pass the idempotency conformance tests before the declaration is allowed.

### 3.3 Core `TransportAdapter` interface

```ts
// src/transport/contract/adapter.ts
export interface TransportAdapter {
  readonly capabilities: Capabilities;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  state(): AdapterHealth;

  selfRef(): ParticipantRef;

  sendText(
    target: ConversationRef,
    text: string,
    opts?: SendTextOptions,
  ): Promise<MessageRef>;

  on(event: 'message',  handler: (e: InboundMessage) => void): Subscription;
  on(event: 'state',    handler: (e: AdapterHealth)  => void): Subscription;
  on(event: 'error',    handler: (e: TransportError) => void): Subscription;
}

export type AdapterState =
  | 'starting' | 'connected' | 'degraded' | 'disconnected'
  | 'auth_required' | 'rate_limited' | 'exhausted' | 'stopping';

export interface AdapterHealth {
  readonly state: AdapterState;
  readonly reasonCode?: string;     // e.g. 'queue_overflow', 'telegram_401', 'provider_429'
  readonly since: Date;
}

export interface Subscription { dispose(): void; /* idempotent */ }

export interface SendTextOptions {
  inReplyTo?: MessageRef;
  correlationId?: string;
  idempotencyKey?: string;          // honored only if adapter declares non-'none'
}

export interface InboundMessage {
  readonly ref: MessageRef;
  readonly conversation: ConversationRef;
  readonly sender: ParticipantRef;
  readonly fromMe: boolean;             // true when the sender resolves to the adapter's selfRef
  readonly text: string | null;
  readonly attachments: ReadonlyArray<AttachmentRef>;
  readonly inReplyTo?: MessageRef;
  readonly timestamp: Date;
  readonly inboundEventKey: string;     // canonical dedup key
  readonly transportTimestamp: Date;
  readonly ingestSeq: number;
}

// Adapter-private extension. Never crosses the fanout boundary.
// Used only inside `src/transport/<adapter>/` for debug spelunking.
export interface InboundMessageInternal extends InboundMessage {
  readonly raw: unknown;                // provider-shaped payload
}
```

Six points:

1. `sendText` is the only universally supported send. Anything richer is in an extension.
2. `InboundMessage` carries `attachments: AttachmentRef[]` regardless of media support; a text-only adapter sets `attachments: []` always; `SupportsMedia` adds `fetchAttachment(ref)` to resolve refs to bytes.
3. **The contract `InboundMessage` does NOT carry `raw`.** Adapter code may use `InboundMessageInternal` (with `raw`) inside its own module for debug logging, but the fanout dispatcher strips `raw` before delivering to subscribers. This makes leakage a compile-time error rather than a runtime hostile-log assertion: runtime/MCP code never sees `raw` because the type doesn't expose it.
4. `fromMe` is set by the adapter from provider data (Baileys `key.fromMe`, Telegram `from.is_bot && from.id == botId`). Reconciliation uses this to narrow content-echo matches to actual self-echoes (§5.7).
5. `state()` is a synchronous getter; `'state'` is also an event for transitions.
6. No `listConversations` in core. Some transports have no listing API; conversation existence is discovered via inbound messages.

### 3.4 Extension interfaces (Spec 1 set)

```ts
// src/transport/contract/extensions.ts

export interface SupportsMedia {
  sendMedia(target: ConversationRef, payload: MediaPayload, opts?: SendMediaOptions): Promise<MessageRef>;
  fetchAttachment(ref: AttachmentRef): Promise<MediaBytes>;
}
export interface SupportsVoiceNotes {
  sendVoiceNote(target: ConversationRef, audio: VoicePayload, opts?: SendVoiceOptions): Promise<MessageRef>;
}
export interface SupportsReactions {
  react(target: MessageRef, emoji: string): Promise<void>;
  unreact(target: MessageRef, emoji: string): Promise<void>;
  on(event: 'reaction', handler: (e: ReactionEvent) => void): Subscription;
}
export interface SupportsEdit {
  editText(target: MessageRef, newText: string): Promise<void>;
  on(event: 'edit', handler: (e: EditEvent) => void): Subscription;
}
export interface SupportsDelete {
  deleteMessage(target: MessageRef, scope: 'me' | 'everyone'): Promise<void>;
  on(event: 'delete', handler: (e: DeleteEvent) => void): Subscription;
}
export interface SupportsTyping {
  setTyping(target: ConversationRef, on: boolean): Promise<void>;
}
export interface SupportsPresence {
  on(event: 'presence', handler: (e: PresenceEvent) => void): Subscription;
}
export interface SupportsGroups {
  getGroupMetadata(target: ConversationRef): Promise<GroupMetadata>;
  on(event: 'group-update', handler: (e: GroupUpdateEvent) => void): Subscription;
}
export interface SupportsReadReceipts {
  markRead(target: MessageRef): Promise<void>;
  on(event: 'read', handler: (e: ReadEvent) => void): Subscription;
}
export interface SupportsInlineKeyboards {
  sendWithButtons(target: ConversationRef, text: string, buttons: ReadonlyArray<KeyboardButton>): Promise<MessageRef>;
  on(event: 'button-press', handler: (e: ButtonPressEvent) => void): Subscription;
}
export interface SupportsOutboundStatus {
  on(event: 'outbound-status', handler: (e: OutboundStatusEvent) => void): Subscription;
}

export interface OutboundStatusEvent {
  readonly correlationId: string;
  readonly candidateRef: MessageRef | null;
  readonly status: 'sent' | 'delivered' | 'read' | 'failed';
  readonly providerCode?: string;
  readonly at: Date;
}
```

### 3.5 Adapter extension lists (Spec 1)

| Adapter | Implements |
|---|---|
| `BaileysAdapter` | core, `SupportsMedia`, `SupportsVoiceNotes`, `SupportsReactions`, `SupportsEdit`, `SupportsDelete`, `SupportsTyping`, `SupportsPresence`, `SupportsGroups`, `SupportsReadReceipts`, `SupportsOutboundStatus` |
| `TelegramAdapter` | core, `SupportsMedia`, `SupportsVoiceNotes`, `SupportsReactions`, `SupportsEdit`, `SupportsDelete`, `SupportsTyping`, `SupportsInlineKeyboards`, `SupportsOutboundStatus` (degenerate: synchronous ack via Bot API response) |
| `InMemoryAdapter` | every extension; `idempotency: 'simulated'` |
| `MinimalTextAdapter` | core only; `idempotency: 'none'` |

Telegram does **not** implement `SupportsGroups`, `SupportsPresence`, or `SupportsReadReceipts` in Spec 1. The Telegram supergroup/topic/channel model is materially different from WhatsApp's; capturing it under one extension would force a lowest-common-denominator. Trigger for follow-up: first product use case requiring Telegram group operations beyond send/receive.

### 3.6 Type narrowing at call sites

```ts
function isReactive(a: TransportAdapter): a is TransportAdapter & SupportsReactions {
  return a.capabilities.extensions.has('reactions');
}

async function tryReact(adapter: TransportAdapter, target: MessageRef, emoji: string) {
  if (!isReactive(adapter)) {
    log.info({ channel: adapter.capabilities.channel }, 'react: unsupported on this transport');
    return;
  }
  await adapter.react(target, emoji);  // type-checks: adapter narrowed
}
```

`TransportAdapter` itself never has `react()`. Missing-capability is a compile-time concern. Runtime `UnsupportedCapabilityError` is reserved for misconfigured wiring.

### 3.7 Provider-specific extensions

Transport-specific surfaces (Telegram inline keyboards, future iMessage tapbacks, future Discord slash commands) live in **namespaced extension interfaces** (`SupportsInlineKeyboards` is intentionally generic; provider-specific quirks like Telegram-only behaviors are documented in the adapter's own type narrowing). There is **no** generic `sendSpecific(payload: unknown)` escape hatch in the core.

---

## 4. Data flow

### 4.1 Single-source-of-truth and fanout

There is one Baileys subscriber per instance: the `BaileysAdapter`. Legacy code that hasn't been converted yet does not subscribe to Baileys directly — it subscribes (via `legacy/baileys-compat.ts`) to a private `BaileysAdapter.internal.on(…)` API that re-emits Baileys-shaped legacy events. The compat shim never imports anything from `src/transport/contract/`.

Inside the contract path, fanout is **non-blocking, per-subscriber**:

```ts
// adapter ingress  ─┐
//                   ├─→ subscriber #1 queue → drain loop (await handler)
//                   ├─→ subscriber #2 queue → drain loop (await handler)
//                   └─→ subscriber #N queue → drain loop (await handler)

class FanoutDispatcher {
  private subs = new Map<string, SubscriberState>();

  enqueue(event: InboundEvent) {
    for (const sub of this.subs.values()) {
      if (sub.suspended) { metrics.dropped_for_suspended.inc(); continue; }
      const enqueued = sub.queue.tryEnqueue(event);
      if (!enqueued) {
        metrics.subscriber_overflow.inc({ subscriber_id: sub.id });
        sub.consecutiveOverflows += 1;
        if (sub.consecutiveOverflows >= OVERFLOW_THRESHOLD) suspend(sub, 'overflow');
      }
    }
  }
}
```

Ordering is guaranteed **per subscriber, not globally**. A slow or throwing subscriber records a handler-failure metric; it never delays or starves any other subscriber.

### 4.2 Inbound — WhatsApp

```
WhatsApp wire
   ↓ Baileys library events
BaileysAdapter.inbound translation (ConversationRef, MessageRef, redaction)
   ↓
BoundedQueue<InboundEvent> (per adapter; counters: enqueued/dequeued/dropped/overflowed/oldest_age_ms)
   ↓
Adapter event loop (try/catch boundary; throws never crash the loop)
   ↓
FanoutDispatcher → per-subscriber queues + drain loops
   ↓                                        ↓ (during migration)
src/core/ingest.ts                  legacy/baileys-compat.ts
ingestInbound(InboundMessage)       (subscribes to BaileysAdapter.internal,
   ↓                                 NOT to InboundMessage; re-emits
durability.recordInbound()          Baileys-shaped legacy events)
   ↓
runtime dispatch (passive | chat | agent)
```

### 4.3 Inbound — Telegram

```
Telegram server
   ↓ HTTPS POST /webhook
src/transport/telegram/webhook.ts
  • verify path-secret (per-instance, 32-byte random) — wrong secret → 401, no parse, redact
  • cap body size — over cap → 413, no parse
  • reject non-POST methods → 405
  • assert update_id monotonicity (counter increments on out-of-order)
   ↓
TelegramAdapter.inbound translation
  • inboundEventKey = String(update_id)
  • populate ConversationRef from chat_id, MessageRef from message_id
  • file_id → AttachmentRef (lazy fetch via SupportsMedia)
   ↓
[Same queue + fanout shape as 4.2]
```

### 4.4 Inbound idempotency (durable dedup)

Every inbound event has an adapter-derived `inboundEventKey`. Adapter-specific derivations:

| Adapter | `inboundEventKey` derivation |
|---|---|
| Baileys (WhatsApp) | canonical Baileys message-key (`fromMe || remoteJid || id` composite) |
| Telegram | `String(update_id)` |
| InMemory | test-supplied UUID |

`transport_inbound_dedup` enforces `UNIQUE (channel_id, inbound_event_key)`. Duplicate inbound events are acked and counted but **never re-dispatched**. Telegram webhook returns 200 OK on duplicate (Telegram resends are real and benign).

### 4.5 Durable-before-dispatch rule

Message-class inbound events (`message`, `edit`, `delete`, `outbound-status`) are written to `inbound_events` **before** runtime dispatch. If persistence fails, the event is not delivered to subscribers because recovery would otherwise double-process. Lossy events (`presence`, `typing`, `reaction`, `read`) skip persistence and dispatch directly.

### 4.6 Loss policy by event type

| Event class | Overflow behavior |
|---|---|
| `message`, `edit`, `delete`, `outbound-status` (durable) | Adapter health → `degraded:queue_overflow`. Telegram webhook returns 5xx (provider retries). Baileys: backpressure on consumer; persisted events stay `received` and replay by cursor. **Never silently dropped.** |
| `presence`, `typing`, `read`, `reaction` (lossy) | Drop-oldest, increment metric, log once per window. |

### 4.7 Ordering contract

Per-conversation order is preserved when the provider gives sufficient sequence data (`ingestSeq` monotonic per conversation). No global ordering guarantee. Out-of-order events are accepted with `transportTimestamp`, `ingestSeq`, and an observability counter (`out_of_order_inbound`).

### 4.8 Outbound flow

```
Agent runtime / MCP tool / scheduled job
   ↓
adapter.sendText(target, text, opts)
   ↓
generate correlationId (if caller didn't); honor opts.idempotencyKey only if adapter declares !== 'none'
   ↓
create outbound_ops row with phase='not_started', outcome=NULL — durable hook before any I/O
   ↓
phase advances: not_started → provider_call_started → ack_received
   • Failure with phase 'not_started' → TransientProviderError(retryable=true)
   • Failure with phase 'provider_call_started' and not yet 'ack_received' → SendAmbiguousError
   ↓
update outbound_ops with outcome (success | transient_failure | permanent_failure | ambiguous | rate_limited | auth_required)
   ↓
return MessageRef OR throw TransportError subclass
```

**No fallback send path.** Converted outbound calls never fall back to the legacy Baileys path after failure. Fallbacks are only allowed before provider I/O starts and only to a semantically equivalent implementation that cannot duplicate sends. **`SendAmbiguousError` is never auto-retried.**

### 4.9 Webhook hardening (Telegram)

- Path-secret verified before JSON parse.
- Body size cap (default 1 MB) before parse.
- Non-POST methods rejected.
- Per-source rate limit (default 100 req/s per remote IP).
- Logs only redacted metadata (no token, no path-secret, no body content at warn/error).
- 2xx returned for processed (or duplicate) updates; 5xx returned only when retry is useful (durable-event overflow / DB persistence failure).

### 4.10 Outbound ledger timing

`outbound_ops` lifecycle uses two columns — `phase` and `outcome` — and does **not** introduce new state-name values (`intent_recorded`, `provider_call_failed`, etc.) that would conflict with the existing `status` column.

- A row is created with `phase = 'not_started'`, `outcome = null` **before any provider I/O begins**. This is the durable hook for reconciliation even if the process dies mid-send.
- `phase` advances `not_started → provider_call_started → ack_received` as the call progresses.
- On terminal completion, `outcome` is set to one of `success | transient_failure | permanent_failure | ambiguous | rate_limited | auth_required` (or `success_inferred` when set later by reconciliation).
- The existing `status` column remains and is computed from `(phase, outcome)` via a SQL view for callers that haven't been migrated. New code reads `phase`/`outcome` directly.
- On next process start, recovery finds rows where `phase = 'provider_call_started'` and `outcome IS NULL` older than threshold and marks them `outcome = 'ambiguous'`.

### 4.11 Migration observability

While `transport.useV2` is enabled, each instance reports `transport-status: legacy | mixed | contract`. CI grep blocks new direct Baileys imports outside `src/transport/baileys/` and `src/transport/baileys/legacy/`.

### 4.12 Structured data-flow logs

Each hop logs `{ correlationId, channelId, conversationKey, operation, eventKind, subscriber, outcome, durationMs }`. **Never logged**: raw provider payload, message text at warn/error, tokens, headers, large buffers.

---

## 5. Error handling, retry, reconciliation

### 5.1 Error envelope

```ts
export interface TransportErrorPayload {
  readonly code: string;             // from stable enum/registry; CI-checked
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly providerCode?: string;
  readonly channelId: ChannelId;
  readonly operation: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly scope: 'request' | 'conversation' | 'channel' | 'provider' | 'runtime';
  readonly phase?: 'not_started' | 'provider_call_started' | 'ack_received';
  readonly callerKind?: 'internal' | 'mcp' | 'tool' | 'reconciliation';
}

export abstract class TransportError extends Error { abstract readonly payload: TransportErrorPayload; }
```

### 5.2 Error classes

| Class | Default `retryable` | Typical scopes |
|---|---|---|
| `UnsupportedCapabilityError` | false | `runtime` (internal) or `request` (mcp/tool) |
| `PayloadTooLargeError` | false | `request` |
| `ConversationNotFoundError` | false | `conversation` |
| `AuthRequiredError` | false | `provider` |
| `RateLimitedError` | true (provider-driven retry) | `provider` |
| `TransientProviderError` | true | `request`/`provider` (network, 5xx, pre-I/O timeout) |
| `PermanentProviderError` | false | `request`/`conversation`/`channel`/`provider` |
| `SendAmbiguousError` | false | `request` (mid-flight; never auto-retried) |

### 5.3 Per-error response policy

| Error class | Health transition | Operator alert | Auto-retry | Ledger outcome |
|---|---|---|---|---|
| `AuthRequiredError` | → `auth_required` | HIGH | Never | `auth_required` |
| `RateLimitedError` | → `rate_limited` | MEDIUM if duration > 5min | Never (Spec 1) | `rate_limited` |
| `TransientProviderError` | none unless N consecutive → `degraded` | LOW isolated; HIGH if 5+ in 60s | Never (Spec 1) | `transient_failure` |
| `PermanentProviderError` | none unless `scope: 'channel'` or `'provider'` → `degraded` | scope-driven (request: none; conversation/channel: MEDIUM; provider: HIGH) | Never | `permanent_failure` |
| `SendAmbiguousError` | none | HIGH | Never (forbidden) | `ambiguous` |
| `PayloadTooLargeError` | none | none — caller-visible | Never | `permanent_failure` |
| `ConversationNotFoundError` | none | LOW (identity diagnostic) | Never | `permanent_failure` |
| `UnsupportedCapabilityError` | none | HIGH if `caller_kind: 'internal'`; none if `'mcp'`/`'tool'` | Never | `bug` |

Health transitions out of `auth_required` / `rate_limited` / `degraded` happen on the next successful operation OR via explicit operator clear. `exhausted` requires explicit operator action to clear.

### 5.4 Operation phase tracking

Every mutating operation records phase advances on its `outbound_ops` row before transitioning:

```ts
type OperationPhase = 'not_started' | 'provider_call_started' | 'ack_received';
```

- Failure with phase `'not_started'` → `TransientProviderError(retryable=true)`.
- Failure with phase `'provider_call_started'` and not yet `'ack_received'` → `SendAmbiguousError`.

### 5.5 Timeout policy

| Operation | Default timeout | Pre-I/O class | Mid-flight class |
|---|---|---|---|
| `sendText` | 10s | `TransientProviderError(retryable=true)` | `SendAmbiguousError` |
| `sendMedia` / `sendVoiceNote` | 60s | transient | ambiguous |
| `react` / `unreact` | 10s | transient | ambiguous |
| `editText` | 10s | transient | ambiguous |
| `deleteMessage` | 10s | transient | ambiguous |
| `markRead` | 5s | transient | silently degraded (read receipts are non-critical) |
| `setTyping` | 5s | silently degraded | silently degraded |
| `fetchAttachment` | 30s | transient | transient (idempotent read) |

### 5.6 Fallback boundary

Mutating actions (`sendText`, `sendMedia`, `sendVoiceNote`, `react`, `editText`, `deleteMessage`) **always throw a structured error**. There is no `degradeOnFailure` opt-in for mutations; returning `null` from a send path is too easy to mishandle. `degradeOnFailure` exists only for `setTyping`, `markRead`, and presence emission — silent no-op + debug log on failure.

### 5.7 Reconciliation (auto + suggestion + operator)

Auto-reconciliation paths in priority order:

1. **`'outbound-status'` event** matching `correlationId` within window → ledger `outcome: success`. Only auto path that produces full success.
2. **Self-echo content match** — the inbound stream produces an `InboundMessage` with `fromMe === true`, sender resolving to the adapter's `selfRef()`, the same conversation, content matching the ambiguous row, and within the time-window — with no other ambiguous row competing for the same content → `outcome: success_inferred`. Never silently upgraded to `success`. Peer messages with matching text are **never** auto-reconciliation evidence.
3. **Self-echo content match with multiple competing rows** → operator suggestion only; row stays `ambiguous`. Suggestion stored in `transport_reconciliation_suggestions`; operator can accept (writes `success_inferred` + audit row) or reject (no ledger change, audit row). Peer-text matches that resemble our content are ignored entirely (not even surfaced as suggestions).
4. **Operator action** `mark_delivered` / `mark_failed` writes ledger + audit row.
5. **Unresolved after 24h** appears in daily digest.

`mark_retry` is implemented behind a feature flag and remains disabled in Spec 1 because no real adapter declares idempotency.

### 5.8 Subscriber dispatch and dead-letter

A persisted inbound event whose drain to a particular subscriber repeatedly fails (default 5 attempts) transitions the corresponding row in `inbound_event_delivery (inbound_event_id, subscriber_id)` to `state = 'dead_letter'`, with `attempts`, `last_error_code`, `last_error_at` populated, and an `operator_action_required` flag. The original `inbound_events` row is unchanged — only the per-subscriber delivery row transitions, which lets "subscriber A dead-lettered, subscriber B dispatched" coexist on the same event. On process restart, recovery skips delivery rows in `dead_letter` state for that subscriber; operator replay route resets `attempts=0` and transitions the delivery row back to `received` (with audit row); operator skip route transitions it to `skipped` (with audit row), never re-dispatched. Per-subscriber cursors in `inbound_subscriber_cursor` advance past skipped/dead-lettered delivery rows after operator action.

### 5.9 Admission control

If durable event persistence is unhealthy, adapters stop accepting new durable inbound events where possible: Telegram returns retryable 5xx; Baileys transitions adapter to `degraded:db_persistence` and logs backpressure. Lossy events continue to be accepted with drop-oldest semantics.

### 5.10 Adapter ownership lock

One live adapter per `(instance, channel_id)`. Startup creates a lockfile (under `~/.local/state/whatsoup/locks/`) so two processes cannot consume/send on the same account concurrently. Stale-lock recovery: on startup, if the lockfile exists but the recorded PID is gone, the new process logs a warning, removes the stale lock, and proceeds. Audit row written for stale-lock recoveries.

### 5.11 Sensitive-field denylist

Pino root logger redacts known secret-name fields globally regardless of which module emits them: `token`, `authorization`, `cookie`, `secret`, `rootKey`, `chainKey`, `identityKey`, `webhookSecret`, `qr`, `auth`. Buffer redaction applies for any property containing `Buffer` data > 64 bytes.

### 5.12 Health reason codes

Health transitions emit `{ state, reasonCode }`. Examples: `degraded:queue_overflow`, `auth_required:telegram_401`, `rate_limited:provider_429`, `degraded:decrypt_threshold`, `degraded:db_persistence`. Every reason code must have a runbook entry; CI fails if a new reason code lacks one.

### 5.13 Structured error logs

```
{ errorCode, errorClass, scope, phase, retryable, channelId, operation, correlationId, providerCode, outcome }
```

Never logged: raw message text, provider payloads, tokens, headers, large buffers.

### 5.14 Metrics

- `inbound_event_count{channel,kind}`
- `send_latency_ms{channel,operation}` (histogram)
- `send_failures{channel,operation,errorCode,scope,phase}`
- `reconnects{channel,reason}`
- `auth_failures{channel}`
- `queue_depth{adapter,subscriber}`
- `dropped_events{channel,kind,reason}`
- `provider_rate_limits{channel,retry_after_bucket}`
- `webhook_failures{channel,reason}`
- `decryption_failures{channel}`
- `subscriber_failures{subscriber_id,channel}`
- `subscriber_overflow{subscriber_id}`
- `subscriber_suspensions{subscriber_id,reason}`
- `dead_letter_count{subscriber_id,channel}`
- `ambiguous_sends{channel,operation}`
- `reconciliation_outcomes{path,outcome}`
- `unsupported_calls{caller_kind,channel,operation}`
- `outbound_intent_count`, `outbound_success_count`, `outbound_failure_count`, `outbound_ambiguous_count`

---

## 6. Testing

### 6.1 Test adapters

- **`InMemoryAdapter`** — implements every extension; declares `idempotency: 'simulated'`. Test-only injection methods (`injectInbound`, `injectAuthLoss`, `injectRateLimit`, `injectAmbiguousFailure`, `injectProviderError`) and assertions (`outboundCaptured`, `pendingAmbiguous`).
- **`MinimalTextAdapter`** — implements core only; for capability-negative tests.

### 6.2 Conformance suite (`tests/transport/contract/conformance.test.ts`)

Parameterized over `[BaileysAdapter, TelegramAdapter, InMemoryAdapter]`. 20 assertions C1–C20 covering lifecycle, capabilities shape, sendText behavior, error envelope completeness, redaction, idempotency declarations, dispose idempotency, listener-growth, subscriber concurrency, ambiguous classification, pre-I/O classification, extension reachability. Adding a 4th adapter later is gated on passing this suite.

### 6.3 Hostile-log redaction (`tests/transport/contract/redaction.test.ts`)

- Direct error classes — every `TransportError` subclass with hostile payloads.
- Translated provider errors — `BaileysError` with cipher buffers, `undici` fetch errors with bot token in failed URL, Telegram webhook `JSON.parse` errors on bodies containing path-secret, OAuth/auth flow leakage.
- Nested `Error.cause` chains recursively walked.
- Logged through the production Pino instance (not a mock).

Failure: any token, key, raw buffer hex > 64 bytes, Authorization header value, QR payload, or webhook secret in serialized output fails the build.

### 6.4 Migration safety (`tests/transport/baileys/legacy-compat.test.ts`)

- M1 — Compat shim subscribes to `BaileysAdapter.internal.on(…)` and emits Baileys-shaped legacy events. Shape match against pre-migration golden recordings. Compat shim never imports from `src/transport/contract/`.
- M2 — Converted call sites do NOT cause legacy ingest path to fire.
- M3 — Non-converted call sites still fire the legacy path through the compat shim.
- M4 — Import-boundary CI grep finds zero `@whiskeysockets/baileys` imports outside designated paths.
- M5 — `transport.useV2` change requires instance restart to take effect; mid-process mutation does not affect running adapter.
- M6 — Per-instance `transport-status: legacy | mixed | contract` correctly reported as call sites convert.

### 6.5 Outbound state machine (`tests/transport/contract/outbound-state.test.ts`)

- O1 — Successful send: row created with `phase=not_started, outcome=null` before I/O; phase advances `not_started → provider_call_started → ack_received`; outcome set to `success` on terminal.
- O2 — Pre-I/O failure: phase remains `not_started`; outcome set to `transient_failure`. No `provider_call_failed` state name is used.
- O3 — Mid-flight failure: phase advances to `provider_call_started`, ack never received before timeout; outcome set to `ambiguous`.
- O4 — Process-killed mid-send (simulated): on next process start, recovery finds rows where `phase = 'provider_call_started'` and `outcome IS NULL` older than threshold and marks `outcome = 'ambiguous'`.
- O5 — Repeated `idempotencyKey` against `idempotency: 'simulated'` adapter (InMemory): second call returns the same `MessageRef`, no duplicate ledger row. Repeated `idempotencyKey` against `'none'` adapter: second call produces a second ledger row. Duplicate `correlationId` is logged as a runtime warning ("trace collision") and never used as a dedup signal.

### 6.6 Reconciliation (`tests/transport/contract/reconciliation.test.ts`)

- R1 — `'outbound-status'` event with matching `correlationId` within window upgrades ambiguous → `success`.
- R2 — Same event arriving outside window does NOT upgrade; metric records the late-status.
- R3 — Self-echo (`fromMe === true`, sender resolves to `selfRef()`) matching ambiguous row content with no competing rows → `success_inferred`, never `success`. Peer message with same text and no other signal: row stays `ambiguous`, no suggestion produced.
- R4 — Self-echo with two competing ambiguous rows → operator suggestion only; both rows stay `ambiguous`. Multiple peer messages with matching text never produce suggestions.
- R5 — Operator `mark_delivered` / `mark_failed` writes ledger + audit row.
- R6 — Unresolved rows older than 24h appear in daily-digest query.
- R7 — Reconciliation never auto-retries a send.
- R8 — Operator accepts content-echo suggestion → row → `success_inferred` + audit row.
- R9 — Operator rejects suggestion → row stays `ambiguous` + audit row.

### 6.7 Telegram webhook (`tests/transport/telegram/webhook.test.ts`)

- T1 — Valid Update with correct path-secret enqueues.
- T2 — Wrong/missing secret → 401, no enqueue, secret redacted in error path.
- T3 — Body over cap → 413, no parse.
- T4 — Non-POST → 405.
- T5 — Duplicate `(channel_id, update_id)` → 200 acked, no re-enqueue, metric increments.
- T6 — Out-of-order `update_id` accepted with `transportTimestamp`/`ingestSeq`; counter increments.
- T7 — Webhook 2xx for processed/duplicate; 5xx only when retry is useful.

### 6.8 Baileys port (`tests/transport/baileys/adapter.test.ts`)

- B1 — `sendText` through new adapter behaviorally matches legacy `Baileys.sendMessage()` for the same input (against in-memory Baileys mock).
- B2 — `messages.upsert` from mock produces an `InboundMessage` matching pre-migration golden recording (`text`, `sender`, `conversation`, `inReplyTo` fields).
- B3 — Decryption failures surface as `decryption_failure` event + persisted diagnostic row + redacted logs. Adapter health transitions to `degraded:decrypt_threshold` only after threshold (default 5 in window). **Not** thrown from `sendText`.
- B4 — Auth-loss event transitions adapter to `auth_required` and emits operator-alert HIGH.
- B5 — Queue-depth metric reflects synthetic burst. Durable burst → adapter `degraded:queue_overflow` + persisted rows + replay-on-recovery. Lossy burst → drop-oldest + metric.

### 6.9 Subscriber lifecycle (`tests/transport/contract/subscriber-lifecycle.test.ts`)

- S1 — `dispose()` returns immediately even mid-event-dispatch; subscriber sees no further events.
- S2 — N runtime starts/stops with same adapter — listener count returns to baseline.
- S3 — Re-armed subscribers resume per event-class:
  - Lossy queues (presence/typing/reaction): from current tail. Pre-suspension events are gone.
  - Durable queues (message/edit/delete/outbound-status): from per-subscriber cursor in `inbound_events`. Operator may explicitly skip dead-lettered rows or schedule a replay range.

### 6.10 Dead-letter (`tests/transport/contract/dead-letter.test.ts`)

- DL1 — N consecutive subscriber failures transition the matching `inbound_event_delivery (inbound_event_id, subscriber_id)` row to `state='dead_letter'` with full metadata; the parent `inbound_events` row is unchanged. A second subscriber on the same `inbound_event_id` still sees `state='dispatched'` and is not affected.
- DL2 — Restart skips `dead_letter` rows for that subscriber; other subscribers see the event.
- DL3 — Operator replay resets `attempts=0`, transitions to `received`, audit row.
- DL4 — Operator skip transitions to `skipped`, audit row, never re-dispatched.
- DL5 — Per-subscriber cursors advance past skipped/dead-lettered rows.

### 6.11 Loss policy by event type

- LP1 — Burst of 10× capacity messages → no silent drop, durable persistence, replay on recovery.
- LP2 — Burst of 10× capacity typing/presence → drop-oldest, metric, log once per window.
- LP3 — Overflow on durable kind → adapter health → `degraded:queue_overflow` + alert.

### 6.12 Capability-negative (using `MinimalTextAdapter`)

- N1 — Type guards `isReactive`, `isMediaCapable`, `isTypingCapable`, etc. all return `false`.
- N2 — MCP tool registry hides reaction/media/etc. tools when only `MinimalTextAdapter` is active.
- N3 — Forced internal call to a missing extension method (bypassing type guard) throws `UnsupportedCapabilityError(scope='runtime', caller_kind='internal')`; pages HIGH.
- N4 — Forced MCP call to a missing capability returns `UnsupportedCapabilityError(scope='request', caller_kind='mcp')`; no page; metric records request shape.

### 6.13 Health transitions

- H1 — `auth_required` enters on auth-loss, exits on next successful op or operator clear; alert HIGH.
- H2 — `rate_limited` enters on 429-equivalent, exits when `retry_after_ms` elapses + successful op; alert MEDIUM if duration > 5min.
- H3 — `degraded` enters on threshold breach (queue/decrypt/transient); exits after N successful ops.
- H4 — `exhausted` enters on permanent provider stop; never auto-exits without operator action.
- H5 — Every emitted reason code has a runbook entry; test fails if not.

### 6.14 Stale-lock recovery

- LK1 — Lockfile present with dead PID → next startup detects, logs warning, removes lock, proceeds; audit row written.
- LK2 — Lockfile present with live PID → next startup fails with clear error.
- LK3 — Concurrent startup race (two processes start simultaneously) → only one acquires the lock; other fails fast.

### 6.15 Chaos tests

- Burst inbound (capacity × 10).
- Subscriber timeouts under load.
- Provider 429 storms.
- Webhook replay (Telegram resends same `update_id` 5×).
- Process kill during `provider_call_started` phase.
- Hostile-payload log injection.
- DB write failures during durable event persistence.

### 6.16 Out of scope for Spec 1 testing

- Real Telegram traffic to `api.telegram.org` (live integration is a manual smoke run before promotion).
- Real WhatsApp traffic (live behavioral tests are part of staging promotion).
- Cross-instance / cross-process behavior, **except** the ownership-lock LK1–LK3 tests, which intentionally exercise concurrent-startup / stale-PID / dead-PID scenarios because the lock is a hard safety rail.
- Identity-graph behavior.

---

## 7. Cross-cutting hardening register

Applies across all sections:

1. **Startup validation** — fail fast on missing/invalid `transport.kind`, `channel_id`, secrets, webhook path, queue caps, capability config. No "best guess" defaults in production.
2. **Adapter ownership lock** — one live adapter per `(instance, channel_id)`; lockfile + stale-lock recovery.
3. **Stable error codes** — enum/registry, not ad-hoc strings; CI fails on duplicate or undocumented codes.
4. **Alert deduping** — operator alerts rate-limited and grouped by `{channelId, errorCode, scope}`.
5. **Safe rollback rule** — rollback to legacy path only at process restart and only for call sites not mid-operation; no runtime fallback after provider I/O starts.
6. **Event-schema versioning** — every inbound/outbound ledger row includes `contract_version`.
7. **Per-subscriber cursors** — durable subscribers track cursor state in SQLite; restart resumes from cursor; dead-letter blocks poison-event loops.
8. **Admission control** — durable event persistence unhealthy → adapters stop accepting new durable inbound events where possible.
9. **Payload limits at boundary** — contract validates text length, media size, MIME allowlist, attachment-path safety, unsupported rich payloads before provider calls.
10. **Sensitive-field denylist** — Pino root redacts globally.
11. **Structured observability only** — IDs and counts at info/warn/error; debug text logging requires explicit local-dev config.
12. **Health reason codes** — `enum + reasonCode` model; runbook entry required.
13. **Fallback boundary** — fallback/degrade only valid for typing/read/presence/optional pings; user-visible mutations always return success/error/ambiguous.
14. **Operator audit trail** — every operator reconcile/replay/re-arm/mark action writes audit row with actor, timestamp, target, before/after.
15. **Chaos tests** — bake in the scenarios listed in 6.15.
16. **Runbook hooks** — every health transition and unreconciled state maps to a runbook action; no alert without an operator response path.

---

## 8. Migration plan (PR-by-PR)

15 PRs total. Foundation 0a→0b→0c/0d sequential. After PR 3, the WA strangler lane (5/6/8) and Telegram lane (4/7/9) parallelize. PR 11 lands only after the 7-day post-PR-10 stability window passes.

### Dependency graph

```
PR 0a (contract + adapters)
   ↓
PR 0b (schema)
   ↓
PR 0c (config/registry/lock)     PR 0d (observability/redaction/codes)
   ↓                                 ↓
   └──────────┬──────────────────────┘
              ↓
         PR 1 (Baileys shell)
              ↓
        PR 2a (MCP send_message)
              ↓
        PR 2b (runtime outbound)
              ↓
        PR 2c (scheduled/system sends)
              ↓
         PR 3 (inbound) ──────────────┐
              ↓                       ↓
         PR 5 (media)         PR 4 (Telegram foundation)
              ↓                       ↓
         PR 6 (react/edit/delete +    PR 7 (Telegram text)
              outbound-status +
              suggestion path)
              ↓                       ↓
         PR 8 (typing/presence)   PR 9 (Telegram media + ext parity)
              ↓                       ↓
              └──────────┬────────────┘
                         ↓
                    PR 10 (deep auth)
                         ↓
                  [7-day stability window]
                         ↓
                    PR 11 (cleanup)
```

### Per-PR contracts

Every PR includes:

- Conformance suite passing for adapters it touches.
- Hostile-log redaction suite re-run.
- Runbook entry for any new health transition / unreconciled state introduced.
- Audit-trail rows for any new operator surface.
- Written rollback procedure.
- `transport-status` reporting accurate path (legacy/mixed/contract).
- Operator routes ship in the PR that first creates the corresponding ledger rows — never earlier.

### PR summaries

| PR | Scope |
|---|---|
| **0a** | Contract types (refs, capabilities, errors, events, commands, fanout, queue, subscription); InMemoryAdapter + MinimalTextAdapter; conformance + capability-negative + subscriber-lifecycle tests against in-memory only. **Behavior-neutral.** |
| **0b** | Schema migration: `channel_id` columns (nullable + backfill — see backfill mechanics below); drop `messages.message_id UNIQUE` and `inbound_events UNIQUE(message_id)`; add composite `UNIQUE (channel_id, conversation_key, message_id)` on `messages`; new tables `transport_inbound_dedup` UNIQUE `(channel_id, inbound_event_key)`, `transport_diagnostics`, `transport_reconciliation_suggestions`, `transport_audit`, `inbound_event_delivery` (per-subscriber state) PRIMARY KEY `(inbound_event_id, subscriber_id)`, `inbound_subscriber_cursor`; `outbound_ops` columns `correlation_id`, `idempotency_key`, `phase`, `outcome`, `predicted_message_ref`, `contract_version`; dual-write helper `projectStatus(phase, outcome) → status` plus the read-only `outbound_ops_status_v1` view. Reversible (backwards migration restores original constraints from a backup table). |

**`channel_id` backfill mechanics.** SQLite migrations cannot read `instance.json`. Backfill happens in two parts:

1. **DDL migration** (pure SQL, idempotent): adds `channel_id TEXT` as nullable on the affected tables. No row-level data movement.
2. **Backfill step** (TypeScript, runs once at startup right after the migration completes, before the adapter starts): the migration runner reads the active instance's `transport.kind` and `instance_name` (and optional `transport.account` override) from the loaded config, computes `channel_id = makeChannelId(kind, account ?? instance_name)`, and runs `UPDATE … SET channel_id = ? WHERE channel_id IS NULL` against the four tables. The backfill is wrapped in a transaction with a row-count check; if any row remains NULL after the update, startup fails with a clear error and a runbook hook ("backfill skipped some rows; investigate before proceeding").

The DDL migration is reversible (drop the column). The backfill is data — re-running is a no-op because all rows already have `channel_id`. PR 11 changes the column to `NOT NULL` only after the post-PR-10 stability window confirms backfill correctness across all instances.
| **0c** | `instance.json` schema; startup validation; `registry.ts` + ownership lock; `transport-status` route; ESLint + CI grep blocking direct Baileys imports. |
| **0d** | Pino root denylist; error-code registry + CI dup/undocumented check; alert deduping; structured-log shape contract; hostile-log redaction tests at production-Pino level. |
| **1** | BaileysAdapter shell + lifecycle + `BaileysAdapter.internal` private re-emitter. Sends throw `UnsupportedCapability` until PR 2a. Conformance C1–C4 + B4 + redaction. |
| **2a** | Convert MCP `whatsapp_send_message` to `BaileysAdapter.sendText`; add `conversation.send_message` alias (shared impl); outbound-ops new-shape writes begin; ambiguous-outbound query route. |
| **2b** | Convert runtime outbound queue (echo replies, agent-initiated sends) to adapter when `useV2`. |
| **2c** | Convert scheduled/system sends (heal alerts, status pings) to adapter when `useV2`. |
| **3** | Inbound message ingest conversion. Compat shim subscribes to `BaileysAdapter.internal`; `src/core/ingest.ts` learns `InboundMessage`; fanout dispatcher wired into runtime; durable-before-dispatch. Dead-letter routes ship here. Conformance C8–C16 + B2/B3/B5 + DL1–DL5 + LP1–LP3 + S1–S3. |
| **4** | TelegramAdapter foundation: shell, webhook (path-secret + body-cap + monotonicity + redaction), `getMe` token verify. T1–T7 + redaction. Telegram webhook status routes. |
| **5** | Strangler step 3: outbound media. BaileysAdapter `sendMedia` / `sendVoiceNote`; payload limits + MIME allowlist enforced at boundary. |
| **6** | Strangler step 4: reactions, edits, deletes; BaileysAdapter `SupportsOutboundStatus` from message-ack; reconciliation auto path R1; suggestion path R3/R4/R8/R9; reconciliation-suggestion routes ship here. |
| **7** | TelegramAdapter outbound text + inbound text + `'outbound-status': 'sent'` synchronous from Bot-API 200; ambiguous from mid-flight failure. Full conformance C1–C20 against TelegramAdapter. |
| **8** | Strangler step 5: typing + presence. BaileysAdapter both; TelegramAdapter `SupportsTyping` only. Capability-negative for Telegram presence. |
| **9** | TelegramAdapter `SupportsMedia` / `SupportsVoiceNotes` / `SupportsReactions` / `SupportsEdit` / `SupportsDelete` / `SupportsInlineKeyboards`. file_id ↔ AttachmentRef. |
| **10** | Deep Baileys auth extraction. BaileysAdapter takes ownership of `creds`/`keys`/session storage. Legacy auth code paths in `src/runtimes/*` removed. CI grep finds zero violating Baileys imports. |
| **11** | Cleanup. **Lands only after 7-day post-PR-10 stability passes.** Delete `legacy/baileys-compat.ts` + `legacy/internal.ts`; remove `transport.useV2` flag (no-op if present, logged warning); set `channel_id` `NOT NULL`; deprecate (don't remove) `whatsapp_*` tool aliases; `transport-status` continues exposing channel health. |

### PR 10 rollback posture

After the 7-day stability window, rollback returns to the normal revert/forward-fix posture. The pre-PR-10 commit tag is preserved as recovery knowledge; the legacy auth code is no longer maintained but a revert is recoverable from the tag if a previously-undetected regression surfaces.

---

## 9. Deliverables checklist

### 9.1 Code surface

- [ ] `src/core/transport-refs.ts` complete.
- [ ] `src/transport/contract/` complete (adapter, capabilities with partial modes, errors with scope/phase/caller_kind, events, commands, queue, fanout, subscription, error-code registry).
- [ ] `src/transport/baileys/` complete; `legacy/internal.ts` + `legacy/baileys-compat.ts` deleted by PR 11.
- [ ] `src/transport/telegram/` complete for the Spec-1 extension set (`SupportsTyping`, `SupportsMedia`, `SupportsVoiceNotes`, `SupportsReactions`, `SupportsEdit`, `SupportsDelete`, `SupportsInlineKeyboards`, `SupportsOutboundStatus`). `SupportsGroups`, `SupportsPresence`, `SupportsReadReceipts` explicitly out.
- [ ] `src/transport/testing/in-memory.ts` and `src/transport/testing/minimal-text.ts`.
- [ ] `src/transport/registry.ts` with adapter ownership lock + stale-lock recovery.
- [ ] `src/core/reconciliation.ts` with auto + suggestion + operator paths.

### 9.2 Schema

- [ ] `channel_id` nullable after PR 0b, populated by the post-DDL backfill step (TypeScript, reads active instance config, fails startup if any row remains NULL); `NOT NULL` after PR 11 once the post-PR-10 stability window confirms backfill correctness. Backfill format `'<kind>:<account-or-instance-name>'`.
- [ ] `messages.message_id` global `UNIQUE` dropped; composite `UNIQUE (channel_id, conversation_key, message_id)` added.
- [ ] `inbound_events UNIQUE(message_id)` dropped; dedup invariant lives in `transport_inbound_dedup`.
- [ ] `inbound_event_delivery(inbound_event_id, subscriber_id, …)` PRIMARY KEY `(inbound_event_id, subscriber_id)` with state enum `received | dispatched | dead_letter | skipped`. Existing `inbound_events.processing_status` left in place for turn recovery.
- [ ] `inbound_subscriber_cursor` per-subscriber durable cursor table.
- [ ] `transport_inbound_dedup` UNIQUE `(channel_id, inbound_event_key)`.
- [ ] `transport_diagnostics`.
- [ ] `transport_reconciliation_suggestions`.
- [ ] `outbound_ops` columns: `correlation_id`, `idempotency_key`, `phase`, `outcome`, `predicted_message_ref`, `contract_version`. Existing `status` retained; SQL view `outbound_ops_status_v1` exposes legacy shape.
- [ ] `outbound_ops.outcome` enum: `success | transient_failure | permanent_failure | ambiguous | rate_limited | auth_required | success_inferred`. `phase` enum: `not_started | provider_call_started | ack_received`.
- [ ] `transport_audit` table populated on every reconcile/replay/skip/re-arm/stale-lock-recovery action (actor, timestamp, target row, action, before/after).

### 9.3 Config

- [ ] `instance.json` schema: `transport.kind`, adapter-specific config; `transport.useV2` (removed by PR 11).
- [ ] Startup validation fails fast.
- [ ] Transport secrets/tokens are per-instance and loaded via the existing three-tier secret chain (env → keyring → keychain).
- [ ] Telegram requires `transport.webhook_url` + valid TLS path in production; absent/invalid → fail-fast. Long-polling fallback exists for `NODE_ENV !== 'production'` only.

### 9.4 Fleet routes

- [ ] `transport-status` per-instance.
- [ ] Ambiguous-outbound query + reconcile (`mark_delivered`, `mark_failed`).
- [ ] `mark_retry` ships disabled (returns "unsupported" while no real adapter declares `idempotency !== 'none'`).
- [ ] Dead-letter query + replay/skip.
- [ ] Reconciliation-suggestion query + accept/reject.
- [ ] Operator audit-trail query.
- [ ] Telegram webhook health metrics surfaced.

### 9.5 Observability

- [ ] Pino root denylist active and asserted via redaction tests.
- [ ] Structured-log shape contract for transport-layer hops.
- [ ] All metrics from §5.14 emitted.
- [ ] Health enum + reasonCode emitted on every transition.
- [ ] Alert deduping by `{channelId, errorCode, scope}`.

### 9.6 Tests

- [ ] Conformance C1–C20 parameterized over Baileys/Telegram/InMemory — all green.
- [ ] Hostile-log redaction including translated provider errors + nested `cause` — all green.
- [ ] Migration safety M1–M6 — all green.
- [ ] Outbound state-machine O1–O5 — all green.
- [ ] Reconciliation R1–R9 — all green.
- [ ] Telegram webhook T1–T7 — all green.
- [ ] Baileys port B1–B5 — all green.
- [ ] Subscriber lifecycle S1–S3 — all green.
- [ ] Dead-letter DL1–DL5 — all green.
- [ ] Loss-policy LP1–LP3 — all green.
- [ ] Capability-negative N1–N4 — all green.
- [ ] Health-transition H1–H5 — all green.
- [ ] Stale-lock LK1–LK3 — all green.
- [ ] Chaos tests from §6.15 — all green.

### 9.7 Documentation

- [ ] This spec at `docs/superpowers/specs/2026-04-25-transport-layer-design.md`.
- [ ] One runbook entry per new health transition, reasonCode, and unreconciled state. No alert without a runbook hook.
- [ ] `docs/configuration.md` updated with `transport.kind` and adapter config.
- [ ] `docs/runbook.md` updated with operator actions for ambiguous-outbound, dead-letter, reconciliation-suggestion, stale-lock recovery.
- [ ] `docs/durability.md` updated with the new state machine and ledger columns.

### 9.8 Operator surfaces

- [ ] CLI / route to list pending ambiguous sends per instance.
- [ ] CLI / route to list dead-lettered inbound events per instance.
- [ ] CLI / route to list reconciliation suggestions.
- [ ] Daily digest of unresolved ambiguous rows older than 24h.
- [ ] Audit trail readable per actor + per target row.

### 9.9 Acceptance for spec close-out

1. PRs 0a–10 merged.
2. 7-day post-PR-10 stability window passes with no PR-10-attributable incidents.
3. PR 11 (cleanup) merged.
4. `transport-status` for every prod instance reports `contract`.
5. CI grep finds zero `@whiskeysockets/baileys` imports outside `src/transport/baileys/`.
6. Hostile-log suite re-run against latest serializer config and passes.
7. Runbook has a hook for every alert reason code in the alert registry.

---

## 10. Open questions, non-goals, what triggers Spec 2

### 10.1 Out-of-scope (non-goals for Spec 1)

- Identity graph (cross-transport identity joins) — Spec 2.
- Auto-retry — until first adapter ships proven idempotency support.
- Console transport-aware UI.
- Cross-instance inbox / per-identity views — depends on identity graph.
- Multi-tenant SaaS or shared identity DB across operators.
- BlueBubbles / Signal / Discord / SMS adapters — each its own spec.
- Tool surface rename / deprecation cutover beyond aliases.
- WhatsApp business-API support (vs. Baileys multi-device).
- Cross-instance error correlation; replay-after-replay batch tooling.

### 10.2 Open questions (acceptable to leave open)

- **Telegram `SupportsGroups` shape.** Trigger: first product use case requiring Telegram group operations beyond send/receive.
- **`SupportsOutboundStatus` granularity.** May need finer states (`'queued'`, `'rejected'`); add via extension expansion.
- **Channel-level operator audit.** Currently per-row; add when first useful.
- **Adapter ownership lock under restart races.** Spec 1 covers unit-tests; integration in real prod conditions is part of staging promotion.

### 10.3 Triggers for Spec 2 (identity graph)

Any of:

- Need to answer "who is this on Telegram?" with cross-channel identity without manual operator linking.
- Same person inbox-overlaps across two instances and confuses operators.
- Agent runtime needs to address a person across transports ("send the followup on whichever channel they used most recently").
- A third transport adapter is being considered, and per-transport identity has produced enough operator pain to warrant the lift.

### 10.4 What Spec 1 is *not* a foundation for (anti-scope-creep)

- Not an excuse to refactor `src/runtimes/` or `src/core/ingest.ts` beyond consuming `InboundMessage`.
- Not the place to land multi-provider LLM frontend work (separate handoff).
- Not the place to land substrate slice-1 (separate branch, separate merge).
- Does not block dedup-consolidation work (separate handoff).
