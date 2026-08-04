# WhatSoup MCP Tool API Reference

Complete reference for all 166 MCP tools exposed by WhatSoup. Tools are grouped by module. Each tool lists its scope, replay policy, and parameters extracted from the Zod schema.

> **Conditionally-registered tools.** Of the 166 documented tools, 163 are always registered at startup and 3 are conditionally registered. Conditional tools are tagged `core: false` in their `ToolDeclaration` so that absence on an instance which does not meet the gate is tolerated rather than fatal (see `src/mcp/types.ts`).
>
> **`knowledge_search`** is registered only when all of the following hold:
>
> - `memory.pinecone.allowedIndexes` (or legacy `pineconeAllowedIndexes`) is a non-empty array, and
> - `memory.pinecone.knowledgeSearch.enabled` is not explicitly `false`, and
> - `enableKnowledgeSearch` has not been disabled at the registration call site, and
> - the configured Pinecone API key environment variable is set, and
> - at least one allowed index has a declared knowledge profile and the Pinecone client initializes successfully.
>
> The initial gate lives in `src/mcp/register-all.ts` (the `Knowledge search — only when instance config specifies allowed indexes` block), and the credential/profile gate lives in `src/mcp/tools/knowledge.ts`.
>
> **`emit_heal_result`** is registered only when all of the following hold (declared in `src/runtimes/agent/runtime-tool-registrations.ts`, wired from `AgentRuntime.start()`):
>
> - `config.controlPeers.size > 0` — the instance has at least one configured control-plane peer (e.g. `loops`), and
> - the runtime is not in `sandboxPerChat` mode, and
> - the runtime is not in `sandbox` mode.
>
> The intent is that only the repair-issuing role (Q) exposes `emit_heal_result`; sandboxed repair targets (Loops) do not. Instances that fail any of these gates omit the corresponding tool at runtime; the documented total of 165 reflects the full tool surface available to a fully-configured non-sandboxed Q instance with Pinecone configured.

## Scope and Replay Policy Glossary

**Scope**
- `chat` — available in both global and chat-scoped sessions. Chat-scoped sessions see only `chat`-scope tools.
- `global` — available in global sessions only. Blocked in chat-scoped sessions.

**Target Mode**
- `injected` — `chatJid` is auto-injected from the session in chat-scoped sessions and must NOT be passed by the caller. In global sessions `chatJid` must be supplied explicitly.
- `caller-supplied` — all parameters including any JID must be supplied by the caller.

**Replay Policy**
- `read_only` — safe to replay on recovery; read-only operation.
- `safe` — idempotent write; safe to replay (e.g., set/overwrite).
- `unsafe` — non-idempotent write; must not be replayed automatically (e.g., send message).

**Sensitive** (R1 admin gate)
- `sensitive: true` — the tool is gated centrally in `ToolRegistry.call` by the
  instance admin predicate (the per-turn `actorJid`), in addition to any
  in-handler `assertAdmin` check (defense in depth). Enforcement is at call
  time, evaluated with the calling turn's actor; the gate is fail-closed
  (missing `actorJid`, no authorizer, an authorizer error, or any non-`true`
  return all deny). The denial reply is visibility-gated (#2974): sessions whose
  `tools/list` shows the tool (global tier, unbound) receive
  `admin_required: tool "<name>" requires an authenticated WhatsApp admin actor`;
  sessions whose listing hides the name (chat-scoped, conversation-bound)
  receive the non-disclosing `Unknown tool: <name>` reply — listing is not the
  gate, but call() must not become an existence oracle where listing already
  conceals. Sensitive tools are still listed in `tools/list` for global sessions
  — listing is not the gate. (The 15 admin-gated substrate tools carry this flag.)

---

## Table of Contents

| Module | Tools |
|--------|------:|
| [messaging.ts](#messagingts) | 9 |
| [media.ts](#mediats) | 3 |
| [chat-management.ts](#chat-managementts) | 10 |
| [chat-operations.ts](#chat-operationsts) | 11 |
| [search.ts](#searchts) | 4 |
| [groups.ts](#groupsts) | 19 |
| [community.ts](#communityts) | 12 |
| [newsletter.ts](#newsletterts) | 19 |
| [business.ts](#businessts) | 13 |
| [profile.ts](#profilets) | 14 |
| [advanced.ts](#advancedts) | 13 |
| [calls.ts](#callsts) | 1 |
| [presence.ts](#presencets) | 3 |
| [voice.ts](#voicets) | 1 |
| [knowledge.ts](#knowledgets) | 1 |
| [retention.ts](#retentionts) | 1 |
| [status.ts](#statusts) | 2 |
| [scheduling.ts](#schedulingts) | 5 |
| [audit.ts](#auditts) | 2 |
| [substrate.ts](#substratets) | 21 |
| [memory-write.ts](#memory-writets) | 1 |
| **Total** | **166** |

> The total above (`166`) reflects the full canonical surface — `165` tools registered from the per-module `src/mcp/tools/*.ts` factories plus `1` (`emit_heal_result`) registered inline (declared in `src/runtimes/agent/runtime-tool-registrations.ts`, wired from `AgentRuntime.start()`). The inline registration is documented below under [runtime-tool-registrations.ts (inline)](#runtime-tool-registrationsts-inline); it is intentionally absent from the module breakdown because it does not live under `src/mcp/tools/`.

---

## messaging.ts

Chat-scoped messaging tools for sending, replying to, reacting to, editing, deleting, pinning, and decorating messages.

> Tools in this module use `targetMode: injected`. In chat-scoped sessions the target chat is auto-injected and caller-supplied `chatJid`/`to` values are ignored. In global sessions `send_message` requires exactly one target: raw `chatJid` or alias `to`.

---

### send_message

Send a text message. In chat-scoped sessions the current chat is injected. In global sessions provide exactly one of `chatJid` or `to`. Supports @name and @number mentions.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatJid | string | global only | Raw WhatsApp chat JID. Mutually exclusive with `to`. |
| to | string | global only | Per-instance chat alias from `chatAliases` / `chat_aliases`. Mutually exclusive with `chatJid`. |
| text | string | required | Message text (supports @name/@number mention syntax) |
| viewOnce | boolean | optional | Send as a view-once message that disappears after viewing |
| link_preview | `"auto"` or `"off"` | optional | Control link preview generation. Defaults to `auto`; `off` suppresses previews. |
| profile | string | optional | Per-instance send profile from `profiles`. Profiles can prepend `prefix`, append `tag`, and provide a default `linkPreview`. |

**Profile order:** target resolution happens first, then the profile decorates text, then the message is sent. If both `link_preview` and the selected profile's `linkPreview` are set, the request-level `link_preview` value wins.

**Target/profile errors:** `chatJid` + `to` returns `chatJid and to are mutually exclusive; provide exactly one`; neither target returns `request body must contain chatJid (raw JID) or to (alias)`; an unknown alias returns `alias not found: <alias>`; an unknown profile returns `unknown profile: <profile>`. MCP returns these as tool error envelopes. The health `/send` route maps the same request errors to HTTP 400.

**Outbound audit:** `send_message` creates one metadata-only `outbound_sends` intent after target/profile preparation, returns its opaque audit receipt, and finalizes the row from typed transport evidence. A normal provider acknowledgement is `submitted`; it is not a recipient-delivery claim. Reply Guarantee Protocol fallbacks and health `/send` attempts use the same table. Use [`read_outbound_sends`](#read_outbound_sends) to inspect recent rows by receipt; destinations, message bodies, fingerprints, exact lengths, provider IDs, and error prose are not stored or returned.

---

### reply_message

Reply to a specific message by its ID.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| messageId | string | required | ID of the message to quote/reply to |
| text | string | required | Reply text |

---

### react_message

React to a message with an emoji. Pass empty string to remove reaction.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| messageId | string | required | ID of the message to react to |
| emoji | string | required | Emoji character; empty string removes the reaction |

---

### edit_message

Edit a message you previously sent.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| messageId | string | required | ID of your outbound message to edit |
| newText | string | required | Replacement text |

---

### delete_message

Delete a message (for everyone). Only works on your own messages unless you are a group admin.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| messageId | string | required | ID of the message to delete |

---

### send_location

Send a location pin to the current chat.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| latitude | number | required | Degrees latitude |
| longitude | number | required | Degrees longitude |
| name | string | optional | Location name label |
| address | string | optional | Street address label |
| viewOnce | boolean | optional | Send as a view-once message that disappears after viewing |

---

### send_contact

Send one or more contact cards to the current chat.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| contacts | array | required | One or more contacts to send (min 1) |
| contacts[].displayName | string | required | Contact display name |
| contacts[].phone | string | required | Phone number (digits, optionally with +) |
| viewOnce | boolean | optional | Send as a view-once message that disappears after viewing |

---

### send_poll

Send a poll to the current chat. Use this for lightweight decisions, surveys, and non-blocking coordination. For a decision that blocks agent progress, prefer `AskUserQuestion` when the provider exposes it; WhatSoup renders that interaction as a WhatsApp poll and routes the vote back into the waiting turn.

For multi-select polls, set `selectableCount` to the maximum number of options the voter may choose. Keep option text concise; send long context in a normal message immediately before the poll.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| question | string | required | Poll question text |
| options | array of string | required | Poll options (2–12 items) |
| selectableCount | number | optional | Whole number from `1` through `options.length`; defaults to `1`. Use values above `1` for multi-select polls. |

---

### pin_message

Pin or unpin a message in the current chat.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| messageId | string | required | ID of the message to pin or unpin |
| pin | boolean | required | `true` to pin, `false` to unpin |
| duration | `"24h"` \| `"7d"` \| `"30d"` | optional | How long to pin for; defaults to `"7d"` |

---

## audit.ts

Outbound send audit read tools. The audit log is per instance because each instance has its own SQLite database.

---

### read_outbound_sends

Read recent outbound send audit rows without returning message text.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| limit | number | optional | Maximum rows to return. Defaults to `50`; values above `100` are clamped to `100`; values below `1` are rejected. |
| auditReceipt | string | optional | Exact opaque receipt: 32 lowercase hexadecimal characters. |

**Return shape**

```json
{
  "outbound_sends": [
    {
      "id": 1,
      "audit_receipt": "0123456789abcdef0123456789abcdef",
      "schema_version": 1,
      "caller": "mcp",
      "target_kind": "alias",
      "outcome_code": "submitted",
      "failure_stage": "ack_received",
      "mutation_state": "acknowledged",
      "evidence_coverage": "typed",
      "logical_attempt_count": 1,
      "provider_submission_count": 1,
      "created_at": "2026-04-26 20:30:00",
      "completed_at": "2026-04-26 20:30:01"
    }
  ]
}
```

Rows use closed outcome, failure-stage, mutation-state, retryability, and evidence-coverage vocabularies. Nullable failure and counter fields are omitted from the MCP projection when the database value is null.

**Non-disclosure invariant:** the audit table stores neither destinations nor content-derived values. The receipt is random per logical attempt and is not derived from the destination, body, alias, profile, provider response, or error.

---

### maintain_outbound_audit

Preview or apply bounded retention to terminal metadata-only outbound audit rows.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |
| **Sensitive** | yes |

| Name | Type | Required | Description |
|------|------|----------|-------------|
| dry_run | boolean | required | `true` reports eligible rows without deleting; `false` applies the configured retention policy. |

The caller cannot override the configured 30-day/10,000-terminal-row policy. The result
reports `dry_run`, `retention_days`, `eligible`, and `deleted`. Unresolved `intent` rows
are never eligible for age or capacity pruning.

---

## substrate.ts

Durable-substrate tools for beads, triggers, entity observations, profiles, and proposal review. Mutation tools are admin-gated against the caller identity.

---

### create_agent_job

Create an agent job bead and schedule trigger. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| prompt | string | required | Agent job prompt/body. |
| title | string | optional | Bead title; defaults to the first 80 prompt characters. |
| schedule | object | required | Schedule spec with `kind`, plus `expr`/`tz` for cron or `fire_at` (unix epoch seconds) for one-shot time. A ms-range `fire_at` is auto-normalized to seconds; a value implausible in either unit is rejected (#1757). |
| report_chat | string | required | JID that receives the trigger report. |
| terminal_at | number | optional | Requested terminal timestamp. |
| metadata | object | optional | Additional bead metadata. |

---

### create_watch

Create a watch bead and poll trigger. Admin only. TTL defaults and caps come from memory watch policy. See [`docs/runbooks/personal-line-watch.md`](runbooks/personal-line-watch.md) for the personal-line watch recipe, the supported trigger kinds, the `dueTriggers()` runtime gap, and a direct-DB workaround for instances that pre-date the ZodRecord serialisation fix.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| title | string | optional | Bead title; defaults to `watch:<source>`. |
| source | `"poll.email"` \| `"poll.url"` \| `"poll.file"` \| `"poll.sqlite"` \| `"poll.pinecone"` \| `"event.message"` | required | Trigger source kind. `poll.shell` was REMOVED (no executor). `poll.url` is gated behind `advanced.enableUrlWatch` — creation is rejected when the flag is off (default). |
| criteria | object | required | Trigger criteria/spec payload. |
| interval_seconds | number | optional | Poll interval. |
| ttl_hours | number | optional | Requested TTL, clamped by policy. |
| report_chat | string | required | JID that receives the trigger report. |
| on_terminal | `"notify"` \| `"silent"` \| `"reopen_bead"` | optional | Terminal behavior. |
| dedupe_key | string | optional | Trigger dedupe key. |

---

### regenerate_vault

Regenerate the Obsidian vault projection from current substrate state. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

None.

**Returns**

Counts for regenerated bead and entity projections.

---

### capture_task

Create a task bead without a trigger. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| title | string | required | Task title. |
| body | string | optional | Task body. |
| due_at | number | optional | Due timestamp. |
| priority | number | optional | Priority from -2 to 2. |
| chat_source_pk | number | optional | Source message primary key. |
| chat_jid | string | optional | Source chat JID. |
| owner_jid | string | optional | Owner JID; defaults to configured memory admin JID. |

---

### capture_observation

Append an entity observation. Append/supersede semantics; existing rows are not mutated. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_ref | object | required | Entity reference by id, JID, canonical name, and/or kind. |
| kind | `"preference"` \| `"fact"` \| `"relation"` \| `"status"` \| `"contact_info"` \| `"note"` \| `"other"` | required | Observation kind. |
| text | string | required | Observation text. |
| confidence | number | required | Confidence from 0 to 1; values below policy are skipped. |
| source_message_pk | number | optional | Source message primary key. |
| supersedes_observation_id | number | optional | Observation superseded by this row. |
| metadata | object | optional | Additional metadata. |

---

### list_beads

List beads with optional filters. `review_overdue` surfaces `status='proposed'` beads whose `review_by_at` deadline has passed (#1773) and overrides any `status` filter with the hardcoded proposed predicate.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| owner_jid | string | optional | Filter by owner JID. |
| kind | `"task"` \| `"project"` \| `"observation"` \| `"agent_job"` \| `"watch"` | optional | Filter by bead kind. |
| status | `"active"` \| `"proposed"` \| `"paused"` \| `"completed"` \| `"cancelled"` \| `"failed"` | optional | Filter by bead status. |
| chat_jid | string | optional | Filter by chat JID. |
| due_before | number | optional | Filter by due timestamp. |
| since | number | optional | Filter by creation/update timestamp. |
| limit | number | optional | Maximum rows, up to 500. |
| review_overdue | boolean | optional | Surface only `status='proposed'` beads past `review_by_at` (overdue for review). Overrides `status` when set. |

---

### get_activity

Return a unified durable-memory timeline of bead events and live entity observations, newest first. Optionally owner-scoped; live-view only (superseded and forgotten observations are excluded). Read only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| owner_jid | string | optional | Restrict the timeline to a single owner JID; omit for all owners. |
| since | number | optional | Only include activity at or after this Unix-seconds cutoff. |
| limit | number | optional | Maximum rows, up to 500 (default 100). |

---

### get_bead

Return a bead and its recent events.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number | required | Bead id. |

---

### update_bead

Update mutable bead fields. Cannot change kind, owner, or status. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number | required | Bead id. |
| fields | object | required | Mutable fields: `title`, `body`, `due_at`, `priority`, and/or `metadata`. |

---

### complete_bead

Transition a bead to completed. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number | required | Bead id. |
| note | string | optional | Completion note. |

---

### cancel_bead

Transition a bead to cancelled. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number | required | Bead id. |
| reason | string | optional | Cancellation reason. |

---

### approve_proposal

Promote a proposed bead to active. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number | required | Bead id. |
| overrides | object | optional | Mutable field overrides applied after approval. |

---

### reject_proposal

Cancel a proposed bead with an optional rejection reason. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number | required | Bead id. |
| reason | string | optional | Rejection reason. |

---

### list_triggers

List triggers with optional filters.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| bead_id | number | optional | Filter by bead id. |
| kind | string | optional | Filter by trigger kind. |
| status | `"active"` \| `"paused"` \| `"expired"` \| `"cancelled"` | optional | Filter by trigger status. |

---

### pause_trigger

Pause a trigger. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number | required | Trigger id. |

---

### extend_trigger

Push a trigger terminal timestamp forward, clamped to policy max. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number | required | Trigger id. |
| until | number | required | New requested terminal timestamp. |

---

### get_profile

Return entity, aliases, live observations, and linked beads.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_ref | object | required | Entity reference by id, JID, canonical name, and/or kind. |

---

### list_entities

List entities with optional kind and text-match filters.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| kind | `"person"` \| `"org"` \| `"project"` \| `"place"` \| `"topic"` \| `"other"` | optional | Entity kind filter. |
| text_match | string | optional | Text search filter. |
| limit | number | optional | Maximum rows, up to 500. |

---

### add_alias

Add an alias to an entity — the write-half of the aliases surface read by `get_profile`. Duplicate `(entity, alias, kind)` rows are ignored. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| entity_ref | object | required | Entity reference by id, JID, canonical name, and/or kind. |
| alias | string | required | Alias text to attach to the entity. |
| alias_kind | `"display_name"` \| `"handle"` \| `"email"` \| `"phone"` \| `"url"` \| `"nickname"` \| `"other"` | required | Alias kind. |
| source | string | optional | Provenance of the alias. |

---

### merge_entities

Merge one entity into another non-destructively. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| from_id | number | required | Source entity id. |
| into_id | number | required | Destination entity id. |

---

### forget_observation

Tombstone an observation with a reason. Admin only.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number | required | Observation id. |
| reason | string | required | Forget reason. |

---

## media.ts

Media sending tool with filesystem boundary enforcement. Supports images, documents, audio, video, and stickers sourced from the local filesystem.

> Uses `targetMode: injected` — see note in messaging section above.

---

### send_media

Send a media file (image, document, audio, video, or sticker) from the local filesystem to the current chat.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| filePath | string | required | Absolute path to the media file on the local filesystem |
| caption | string | optional | Caption text (images, documents, video) |
| filename | string | optional | Override the filename shown to recipients |
| ptt | boolean | optional | Send audio as a voice note (push-to-talk) |
| seconds | number (int) | optional | Duration in seconds for voice notes |
| ptv | boolean | optional | Send video as a round video note (PTV) |
| gifPlayback | boolean | optional | Auto-loop video as a GIF |
| viewOnce | boolean | optional | Image or video disappears after viewing once |
| isAnimated | boolean | optional | Mark a `.webp` sticker as animated |
| mediaType | `"image"` \| `"video"` \| `"audio"` \| `"document"` \| `"sticker"` | optional | Force media type; auto-detected from extension if omitted |

**Supported extensions:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.pdf`, `.doc`, `.docx`, `.xlsx`, `.csv`, `.txt`, `.zip`, `.mp3`, `.ogg`, `.m4a`, `.wav`, `.mp4`, `.mov`, `.webm`

**Limit:** 50 MB. Sandboxed sessions enforce `allowedRoot` filesystem boundary.

---

### download_media

Download media from a received WhatsApp message. Returns the local file path. Uses cached path if media was already downloaded; otherwise downloads from WhatsApp CDN via the raw message data.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message_id | string | required | The message ID to download media from |

**Returns:** `file_path`, `content_type`, `file_size`, `cached` (boolean), and `mime_type` (for fresh downloads).

**Error codes:** `not_found`, `unsupported_type`, `no_raw_message`, `media_expired`, `download_timeout`, `download_failed`.

---

### transcribe_audio

Transcribe an audio/voice message using the shared transcription chain. Downloads the audio if needed, transcribes it, and persists the transcription to both `content` (structured JSON) and `content_text` (FTS-indexed). Returns cached transcription if already transcribed.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message_id | string | required | The audio message ID to transcribe |

**Returns:** `transcription`, `duration`, `cached` (boolean).

**Error codes:** `not_found`, `not_audio`, `no_audio_data`, `media_expired`, `download_failed`, `transcription_failed`.

---

## chat-management.ts

Tools for reading conversation history, managing chat state (archive, pin, mute, read receipts, stars), and forwarding messages.

---

### list_messages

List messages in a WhatsApp conversation (paginated). Use `before_pk` for cursor-based pagination. Returns messages ordered oldest-first within the page.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| conversation_key | string | required | Canonical conversation key (auto-resolved in chat-scoped sessions) |
| limit | number | optional | Page size; defaults to 50 |
| before_pk | number | optional | Cursor: return messages with pk < this value |

---

### get_message_context

Get messages surrounding a specific message in a conversation. Validates that the message belongs to the given `conversation_key`.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message_id | string | required | ID of the target message |
| conversation_key | string | required | Conversation to validate membership against |
| context_size | number | optional | Number of messages to fetch before and after; defaults to 5 |

---

### list_chats

List WhatsApp conversations with their last message timestamp and metadata. Supports optional query filtering, pagination, sort mode, and last-message previews.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| limit | number | optional | Max conversations to return; defaults to 100 and is capped at 1000 |
| page | number | optional | Zero-based page offset applied after sorting; defaults to 0 and is capped at 100000 |
| query | string | optional | Case-insensitive literal substring filter against conversation key, chat JID, chat name, or mapped LID phone JID; `%` and `_` are treated as ordinary characters |
| sort_by | `"last_active"` or `"name"` | optional | Sort mode; defaults to `"last_active"` |
| include_last_message | boolean | optional | Include a compact latest-message preview (`messageId`, `senderName`, `contentPreview`, `contentType`, `timestamp`) for each returned conversation; defaults to false |

`count` is the number of conversations returned on the current page, not the total matching conversation count. A page beyond the available result set returns `chats: []` with `count: 0`.

---

### get_chat

Get details for a single WhatsApp conversation.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| conversation_key | string | required | Canonical conversation key |

---

### forward_message

Forward a WhatsApp message (by `message_id`) to another chat JID.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message_id | string | required | ID of the stored message to forward |
| to_jid | string | required | Recipient chat JID |

---

### archive_chat

Archive or unarchive a WhatsApp chat.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Chat JID |
| archive | boolean | required | `true` to archive, `false` to unarchive |

---

### pin_chat

Pin or unpin a WhatsApp chat.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Chat JID |
| pin | boolean | required | `true` to pin, `false` to unpin |

---

### mute_chat

Mute or unmute a WhatsApp chat. Provide `until` (Unix seconds) for a timed mute.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Chat JID |
| mute | boolean | required | `true` to mute, `false` to unmute |
| until | number | optional | Unix timestamp (seconds) until which to mute; defaults to 8 hours from now |

---

### mark_messages_read

Mark WhatsApp messages as read (send blue ticks) for the given JID.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Chat JID |
| message_ids | array of string | required | Message IDs to mark as read |
| from_me | boolean | optional | Whether the messages were sent by the bot; defaults to `false` |

---

### star_message

Star or unstar WhatsApp messages.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Chat JID |
| message_ids | array of string | required | Message IDs to star or unstar |
| star | boolean | required | `true` to star, `false` to unstar |
| from_me | boolean | optional | Whether the messages were sent by the bot; defaults to `false` |

---

## chat-operations.ts

Tools for chat lifecycle operations: clearing/deleting chats, managing per-message deletion, disappearing messages, events, read state, push name, message history, placeholders, reactions, and receipts.

---

### clear_chat

Clear messages from a WhatsApp chat. Provide the message IDs, `fromMe` flag, and timestamps of the messages to clear.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| messages | array | required | Messages to clear |
| messages[].id | string | required | Message ID |
| messages[].fromMe | boolean | required | Whether the message was sent by the bot |
| messages[].timestamp | number | required | Message timestamp |

---

### delete_chat

Delete an entire WhatsApp chat. Requires the last message key and timestamp.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| last_message_key | object | required | Key of the last message in the chat |
| last_message_key.id | string | required | Message ID |
| last_message_key.fromMe | boolean | required | Whether the message was sent by the bot |
| last_message_timestamp | number | required | Unix timestamp of the last message |

---

### delete_message_for_me

Delete a message for yourself only (not for everyone). The message remains visible to others.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message_id | string | required | Message ID to delete |
| from_me | boolean | required | Whether the message was sent by the bot |
| timestamp | number | required | Message timestamp |

---

### set_disappearing_messages

Enable or disable disappearing messages for a chat. Duration in seconds: 0=off, 86400=24h, 604800=7d, 7776000=90d.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Chat JID |
| duration | number | required | Seconds: 0=off, 86400=24h, 604800=7d, 7776000=90d |

---

### send_event_message

Send a calendar event message to a WhatsApp chat.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | required | Event name/title |
| description | string | optional | Event description |
| start_time | number | required | Unix timestamp in seconds |
| end_time | number | required | Unix timestamp in seconds |
| location | string | optional | Event location text |
| call_link | string | optional | Call link URL for virtual events |

---

### mark_chat_read

Mark a chat as read or unread. Uses `chatModify` for whole-chat read state.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| read | boolean | required | `true` to mark read, `false` to mark unread |
| last_message_key | object | required | Key of the last message in the chat |
| last_message_key.id | string | required | Message ID |
| last_message_key.fromMe | boolean | required | Whether the message was sent by the bot |
| last_message_timestamp | number | required | Unix timestamp of the last message |

---

### update_push_name

Update your WhatsApp push notification name (the name others see).

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | required | New push name |

---

### fetch_message_history

Request WhatsApp to send additional message history. Results arrive via `messaging-history.set` event.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| count | number | required | Number of historical messages to request |
| oldest_message_key | object | optional | Key of the oldest message already held |
| oldest_message_key.remoteJid | string | required (if key provided) | Chat JID |
| oldest_message_key.id | string | required (if key provided) | Message ID |
| oldest_message_key.fromMe | boolean | required (if key provided) | Whether the message was sent by the bot |
| oldest_message_timestamp | number | optional | Timestamp of the oldest message |

---

### request_placeholder_resend

Request resend of a placeholder message (message that failed to decrypt).

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message_key | object | required | Key of the placeholder message |
| message_key.remoteJid | string | required | Chat JID |
| message_key.id | string | required | Message ID |
| message_key.fromMe | boolean | required | Whether the message was sent by the bot |

---

### get_reactions

Get all reactions for a specific message.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message_id | string | required | Message ID to query reactions for |

---

### get_message_receipts

Get delivery/read receipts for a specific message.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message_id | string | required | Message ID to query receipts for |

---

## search.ts

Full-text search (FTS5) tools. `search_messages` and `search_chat_messages` are intentionally separate tools because they carry different scope declarations (`global` vs `chat`), which routes them to different session surfaces.

---

### search_messages

Full-text search across all WhatsApp messages (global). Returns messages matching the query, excluding deleted messages.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | required | FTS5 query string |
| limit | number | optional | Max results; defaults to 20 |

---

### search_chat_messages

Full-text search within a specific WhatsApp conversation. Returns messages matching the query in the given `conversation_key`, excluding deleted messages.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| conversation_key | string | required | Conversation to search within (auto-resolved in chat-scoped sessions) |
| query | string | required | FTS5 query string |
| limit | number | optional | Max results; defaults to 20 |

---

### search_contacts

Search contacts by display name or phone number (global). Returns matching contacts from the contacts table.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | required | Substring to match against display_name, notify_name, canonical_phone, or JID |
| limit | number | optional | Max results; defaults to 20 |

---

### search_messages_advanced

Advanced message search with metadata filters and optional full-text search. When a text `query` is provided, uses FTS5 for ranking (joins `messages_fts`). When absent, filters on metadata only. Supports combining multiple filters.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | optional | FTS text search query. When absent, only metadata filters apply |
| sender_jid | string | optional | Filter by sender JID |
| content_type | string | optional | Filter by content type (`text`, `image`, `audio`, `video`, `document`, `sticker`, `location`, `contact`, `poll`) |
| conversation_key | string | optional | Filter by conversation |
| after | number | optional | Unix timestamp — messages after this time |
| before | number | optional | Unix timestamp — messages before this time |
| has_media | boolean | optional | Filter for messages with (`true`) or without (`false`) downloaded media |
| limit | number | optional | Max results; defaults to 20 |

**Returns:** `messages` array (standard message format via `rowToMessage`) and `total` count.

---

## groups.ts

Group management tools: metadata, participant management, invite links, settings, join approval, and invite messages.

> All tools use `targetMode: caller-supplied` unless otherwise noted.

---

### list_groups

List all WhatsApp groups the bot is a member of.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

No parameters.

---

### get_group_metadata

Get metadata for a WhatsApp group by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |

---

### group_update_subject

Update a WhatsApp group's subject (name).

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |
| subject | string | required | New group name |

---

### group_update_description

Update a WhatsApp group's description. Omit `description` to clear it.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |
| description | string | optional | New description; omit to clear |

---

### group_participants_update

Add, remove, promote, or demote participants in a WhatsApp group.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |
| participants | array of string | required | JIDs of participants to act on |
| action | `"add"` \| `"remove"` \| `"promote"` \| `"demote"` | required | Action to perform |

---

### group_settings_update

Update WhatsApp group settings: announcement mode (only admins can send) or locked (only admins can edit info).

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |
| setting | `"announcement"` \| `"not_announcement"` \| `"locked"` \| `"unlocked"` | required | Setting to apply |

---

### get_group_invite_link

Get the invite link for a WhatsApp group.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |

---

### group_create

Create a new WhatsApp group with a given subject and initial participants.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| subject | string | required | Group name |
| participants | array of string | required | Initial participant JIDs |

---

### group_leave

Leave a WhatsApp group.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | string | required | Group JID |

---

### group_revoke_invite

Revoke the invite link for a WhatsApp group and return the new invite code.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |

---

### group_accept_invite

Accept a WhatsApp group invite by code and return the group JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| code | string | required | Invite code (not the full URL, just the code portion) |

---

### group_get_invite_info

Get group metadata preview from a WhatsApp group invite code.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| code | string | required | Invite code |

---

### group_toggle_ephemeral

Enable or disable disappearing messages in a WhatsApp group. Pass `expiration` in seconds (0 = off).

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |
| expiration | number | required | Disappearing message duration in seconds; 0 = off |

---

### group_member_add_mode

Set whether all members or only admins can add participants to a WhatsApp group.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |
| mode | `"all_member_add"` \| `"admin_add"` | required | Who can add members |

---

### group_join_approval_mode

Enable or disable join approval (admin must approve new members) for a WhatsApp group.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |
| mode | `"on"` \| `"off"` | required | `"on"` to require admin approval |

---

### group_request_participants_list

Get the list of pending join requests for a WhatsApp group.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |

---

### group_request_participants_update

Approve or reject pending join requests for a WhatsApp group.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Group JID |
| participants | array of string | required | JIDs of requesters to act on |
| action | `"approve"` \| `"reject"` | required | Action to perform |

---

### send_group_invite

Send a group invite message to a chat. Works in both chat-scoped and global sessions (`chatJid` required in global sessions).

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| groupJid | string | required | JID of the group being invited to |
| inviteCode | string | required | Group invite code |
| inviteExpiration | number | required | Invite expiration as Unix timestamp |
| groupName | string | required | Display name of the group |
| jpegThumbnail | string | optional | JPEG thumbnail as a string |
| caption | string | optional | Optional message caption |

---

### group_revoke_invite_v4

Revoke a v4 group invite previously sent to a specific participant.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| groupJid | string | required | Group JID |
| invitedJid | string | required | JID of the participant whose invite is being revoked |

---

## community.ts

Community management tools: metadata, creation, group linking, participant management, invite codes, and settings.

> All tools use `scope: global` and `targetMode: caller-supplied`.

---

### community_metadata

Get metadata for a WhatsApp community by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Community JID |

---

### community_create

Create a new WhatsApp community with the given subject and description body.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| subject | string | required | Community name |
| body | string | required | Community description |

---

### community_create_group

Create a new group within a community.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| subject | string | required | New group name |
| participants | array of string | required | Initial participant JIDs |
| parentJid | string | required | Community JID to create the group under |

---

### community_leave

Leave a WhatsApp community.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | string | required | Community JID |

---

### community_link_group

Link an existing group into a community.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| groupJid | string | required | JID of the group to link |
| communityJid | string | required | JID of the community to link into |

---

### community_unlink_group

Unlink a group from a community.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| groupJid | string | required | JID of the group to unlink |
| communityJid | string | required | JID of the community to unlink from |

---

### community_fetch_linked_groups

Fetch all groups linked to a community by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Community JID |

---

### community_participants_update

Add, remove, promote, or demote participants in a WhatsApp community.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Community JID |
| participants | array of string | required | JIDs of participants to act on |
| action | `"add"` \| `"remove"` \| `"promote"` \| `"demote"` | required | Action to perform |

---

### community_invite_code

Get, revoke, or accept a WhatsApp community invite. `action=get` (default) returns the current invite code; `action=revoke` rotates it and returns the new code; `action=accept` joins the community via an invite code (requires `code` param).

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Community JID — required for `get` and `revoke` actions; unused for `accept` |
| action | `"get"` \| `"revoke"` \| `"accept"` | optional | `get` (default): fetch current invite code; `revoke`: rotate and return new code; `accept`: join via invite code |
| code | string | optional | Invite code — required for `action=accept` |

---

### community_settings_update

Update WhatsApp community settings: announcement mode (only admins can send) or locked (only admins can edit info).

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Community JID |
| setting | `"announcement"` \| `"not_announcement"` \| `"locked"` \| `"unlocked"` | required | Setting to apply |

---

### community_fetch_all_participating

Fetch all communities the bot is participating in.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

No parameters.

---

### community_update_metadata

Update a WhatsApp community's subject and/or description. Provide at least one of `subject` or `description`.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Community JID |
| subject | string | optional | New community name |
| description | string | optional | New community description |

---

## newsletter.ts

Newsletter (WhatsApp Channels) management tools: creation, metadata, subscriber management, follow/unfollow, mute, picture, reactions, message fetching, and admin operations.

> All tools use `scope: global` and `targetMode: caller-supplied`.

---

### newsletter_create

Create a new WhatsApp newsletter channel with the given name and optional description.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | required | Newsletter name |
| description | string | optional | Newsletter description |

---

### newsletter_update

Update metadata for a WhatsApp newsletter by JID. Low-level freeform metadata patch.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |
| updates | object (record) | required | Freeform metadata fields to update |

---

### newsletter_metadata

Fetch metadata for a WhatsApp newsletter. Use `type='jid'` with the newsletter JID, or `type='invite'` with the invite code.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| type | `"invite"` \| `"jid"` | required | How to look up the newsletter |
| key | string | required | Newsletter JID (when `type=jid`) or invite code (when `type=invite`) |

---

### newsletter_subscribers

Fetch the subscriber list for a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |

---

### newsletter_follow

Follow (subscribe to) a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |

---

### newsletter_unfollow

Unfollow (unsubscribe from) a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |

---

### newsletter_mute

Mute a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |

---

### newsletter_unmute

Unmute a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |

---

### newsletter_update_name

Update the name/title of a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |
| name | string | required | New newsletter name |

---

### newsletter_update_description

Update the description of a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |
| description | string | required | New description |

---

### newsletter_update_picture

Update the profile picture for a WhatsApp newsletter. Content is base64-encoded image data.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |
| content | string | required | Base64-encoded image data |

---

### newsletter_remove_picture

Remove the profile picture from a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |

---

### newsletter_react_message

React to a newsletter message by server ID. Pass reaction emoji or omit to remove reaction.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |
| serverId | string | required | Server-side message ID |
| reaction | string | optional | Emoji to react with; omit to remove reaction |

---

### newsletter_fetch_messages

Fetch messages from a WhatsApp newsletter. Optionally filter by timestamp (`since`) or cursor (`after`).

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |
| count | number (int, positive) | required | Number of messages to fetch |
| since | number | optional | Filter messages after this Unix timestamp |
| after | number | optional | Cursor offset as a number (message server ID) |

---

### subscribe_newsletter_updates

Subscribe to live updates for a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |

---

### newsletter_admin_count

Get the number of admins for a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |

---

### newsletter_change_owner

Transfer ownership of a WhatsApp newsletter to a new owner JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |
| newOwnerJid | string | required | JID of the new owner |

---

### newsletter_demote

Demote an admin from a WhatsApp newsletter to a regular subscriber.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |
| userJid | string | required | JID of the admin to demote |

---

### newsletter_delete

Permanently delete a WhatsApp newsletter by JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Newsletter JID |

---

## business.ts

Business profile, catalog, product, order, quick reply, and label tools.

> All tools use `scope: global` and `targetMode: caller-supplied`.

---

### get_business_profile

Get the WhatsApp Business profile for a contact JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Contact JID |

---

### update_business_profile

Update the WhatsApp Business profile fields (category, description, email, website, address).

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| category | string | optional | Business category |
| description | string | optional | Business description |
| email | string | optional | Business email address |
| websites | array of string | optional | List of website URLs for the business profile |
| address | string | optional | Business address |

---

### update_cover_photo

Update the WhatsApp Business cover photo. Provide the image as a base64 string.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| photo | string | required | Base64-encoded image data for the cover photo |

---

### remove_cover_photo

Remove a WhatsApp Business cover photo by asset ID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | string | required | Cover photo asset ID to remove |

---

### get_catalog

Get the product catalog for a WhatsApp Business account.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | optional | Business JID; omit to get own catalog |
| limit | number | optional | Max products to return |
| cursor | string | optional | Pagination cursor from a previous response |

---

### get_collections

Get product collections for a WhatsApp Business account.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | optional | Business JID; omit to use own JID |
| limit | number | optional | Max collections to return |

---

### product_create

Create a new product in the WhatsApp Business catalog.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | required | Product name |
| description | string | optional | Product description |
| price | number | optional | Price in smallest currency unit (e.g. cents) |
| currency | string | optional | ISO 4217 currency code, e.g. `USD` |
| retailerId | string | optional | Your internal product/SKU identifier |
| url | string | optional | URL to the product listing |
| images | array of string | optional | List of product image URLs |
| isHidden | boolean | optional | Whether the product is hidden from catalog |

---

### product_update

Update an existing product in the WhatsApp Business catalog by product ID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| productId | string | required | Catalog product ID |
| name | string | optional | New product name |
| description | string | optional | New description |
| price | number | optional | New price in smallest currency unit |
| currency | string | optional | New ISO 4217 currency code |
| retailerId | string | optional | New internal product/SKU identifier |
| url | string | optional | New product listing URL |
| images | array of string | optional | New list of product image URLs |
| isHidden | boolean | optional | Whether the product is hidden |

---

### product_delete

Delete one or more products from the WhatsApp Business catalog.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| productIds | array of string | required | List of product IDs to delete |

---

### get_order_details

Fetch details for a WhatsApp order by order ID and token.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| orderId | string | required | Order ID |
| tokenBase64 | string | required | Order token in base64, received in the order message |

---

### add_or_edit_quick_reply

Add or edit a quick reply shortcut for the WhatsApp Business account.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| shortcut | string | required | Trigger shortcut (e.g. `/hello`) |
| message | string | required | Full message text for the quick reply |
| keywords | array of string | optional | Optional keywords for search |
| count | number | optional | Usage count (for ordering) |

---

### remove_quick_reply

Remove a quick reply shortcut by its timestamp identifier.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| timestamp | string | required | Timestamp identifier of the quick reply to remove |

---

### manage_labels

Manage WhatsApp Business labels. Actions: `add_label`, `add_chat_label`, `remove_chat_label`, `add_message_label`, `remove_message_label`.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| action | `"add_label"` \| `"add_chat_label"` \| `"remove_chat_label"` \| `"add_message_label"` \| `"remove_message_label"` | required | Operation to perform |
| label_id | string | optional | Label ID — required for `add_chat_label`, `remove_chat_label`, `add_message_label`, `remove_message_label` |
| chat_jid | string | optional | Chat JID — required for all actions except standalone `add_label` |
| message_id | string | optional | Message ID — required for `add_message_label` and `remove_message_label` |
| labels | array | optional | Label definitions — required for `add_label` |
| labels[].id | string | required (if labels) | Label ID |
| labels[].name | string | required (if labels) | Label name |
| labels[].color | number | optional | Label color index |

---

## profile.ts

Profile, contact info, privacy settings, and block tools.

> All tools use `scope: global` and `targetMode: caller-supplied`.

---

### get_profile_picture

Get the profile picture URL for a WhatsApp contact or group JID.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Contact or group JID |
| type | `"preview"` \| `"image"` | optional | Resolution; defaults to `"preview"` |

---

### get_contact_status

Fetch a WhatsApp contact's status message.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Contact JID |

---

### check_whatsapp

Check which phone numbers are registered on WhatsApp. Returns JID for each registered number.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| phone_numbers | array of string | required | Phone numbers to check |

---

### block_contact

Block or unblock a WhatsApp contact.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Contact JID |
| action | `"block"` \| `"unblock"` | required | Action to perform |

---

### update_profile_picture

Update the profile picture for a JID (own account or group). Content is base64-encoded image data.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Own account JID or group JID |
| content | string | required | Base64-encoded image content |

---

### remove_profile_picture

Remove the profile picture for a JID (own account or group).

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Own account JID or group JID |

---

### update_profile_status

Update your own WhatsApp profile status (about/bio text).

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| status | string | required | New status text (about/bio) |

---

### update_profile_name

Update your own WhatsApp display name.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | required | New display name |

---

### update_privacy_settings

Update a specific WhatsApp privacy setting.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| setting | `"last_seen"` \| `"online"` \| `"profile_picture"` \| `"status"` \| `"read_receipts"` \| `"groups_add"` \| `"call"` \| `"messages"` \| `"link_previews"` \| `"default_disappearing"` | required | Which privacy setting to update |
| value | string | required | Value for the chosen setting (see table below) |

**Value reference by setting:**

| Setting | Valid values |
|---------|-------------|
| `last_seen` | `"all"`, `"contacts"`, `"contact_blacklist"`, `"none"` |
| `profile_picture` | `"all"`, `"contacts"`, `"contact_blacklist"`, `"none"` |
| `status` | `"all"`, `"contacts"`, `"contact_blacklist"`, `"none"` |
| `online` | `"all"`, `"match_last_seen"` |
| `groups_add` | `"all"`, `"contacts"`, `"contact_blacklist"` |
| `read_receipts` | `"all"`, `"none"` |
| `call` | `"all"`, `"known"` |
| `messages` | `"all"`, `"contacts"` |
| `link_previews` | `"true"`, `"false"` |
| `default_disappearing` | Duration in seconds as string, e.g. `"0"`, `"86400"`, `"604800"`, `"7776000"` |

---

### get_privacy_settings

Fetch all current WhatsApp privacy settings.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

No parameters.

---

### get_blocklist

Fetch the list of blocked contacts. Returns live data when connected, cached DB data otherwise.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

No parameters.

---

### add_or_edit_contact

Add a new contact or edit an existing contact in the WhatsApp address book.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Contact JID |
| firstName | string | optional | First name |
| lastName | string | optional | Last name |
| company | string | optional | Company name |
| phone | string | optional | Phone number |

---

### remove_contact

Remove a contact from the WhatsApp address book.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Contact JID |

---

### fetch_disappearing_duration

Fetch the disappearing message duration for one or more JIDs.

| | |
|---|---|
| **Scope** | `global` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jids | array of string | required | One or more JIDs to query disappearing message duration for (min 1) |

---

## advanced.ts

Advanced and miscellaneous tools: call links, phone number sharing, product messages, device pairing, bot metadata, interactive message types (button/list replies), protocol-level relay, app state resync, and admin utilities.

---

### create_call_link

Create a WhatsApp call link for audio or video calls.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| type | `"audio"` \| `"video"` | required | Type of call link to create |
| event | object | optional | Optional event with `startTime` (Unix seconds) |
| event.startTime | number | required (if event) | Unix timestamp in seconds |
| timeoutMs | number | optional | Optional timeout in milliseconds |

---

### share_phone_number

Share your phone number with a contact via a WhatsApp message.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | JID of the contact to share your phone number with |

---

### request_phone_number

Request a contact to share their phone number with you.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | JID of the contact whose phone number you are requesting |

---

### send_product_message

Send a product catalog message to a WhatsApp chat.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | JID of the recipient chat |
| product | object | required | Product object from the business catalog |
| product.productId | string | required | Catalog product ID |
| product.title | string | optional | Product title override |
| product.description | string | optional | Product description override |
| product.currencyCode | string | optional | Currency code |
| product.priceAmount1000 | number | optional | Price * 1000 (e.g. 9990 = $9.99) |
| product.retailerId | string | optional | Internal retailer ID |
| product.url | string | optional | Product URL |
| product.productImageCount | number | optional | Number of product images |
| product.firstImageId | string | optional | ID of the first product image |
| product.salePriceAmount1000 | number | optional | Sale price * 1000 |

---

### request_pairing_code

Request a pairing code for linking a device by phone number.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| phoneNumber | string | required | Phone number to pair with (international format, e.g. `14155551234`) |
| customCode | string | optional | Optional custom pairing code |

---

### get_bots_list

Retrieve the list of available WhatsApp bots.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

No parameters.

---

### send_button_reply

Send a button reply message to a WhatsApp chat.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| displayText | string | required | Display text of the selected button |
| id | string | required | Button ID that was selected |
| type | number (int) | required | Button type (1 = reply button) |

---

### send_list_reply

Send a list reply message (selected list item) to a WhatsApp chat.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| title | string | required | Title of the list reply |
| listType | number (int) | required | List type (1 = single select) |
| selectedRowId | string | required | ID of the selected row |

---

### send_limit_sharing

Send a limit-sharing message to a WhatsApp chat, restricting content forwarding.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `safe` |

No caller parameters (chatJid is injected).

---

### logout

**WARNING: This will log out the WhatsApp session. You will need to re-authenticate.** Disconnects the current WhatsApp session and invalidates credentials.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| msg | string | optional | Optional logout message |

---

### resync_app_state

Resync one or more WhatsApp app-state collections.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| collections | array of string | required | Collection names to resync. Valid values: `critical_block`, `critical_unblock_low`, `regular_high`, `regular_low`, `regular` |
| isInitialSync | boolean | required | `true` for initial sync, `false` for incremental |

---

### relay_message

Low-level: relay a raw protobuf message to a JID. Use only for advanced protocol operations.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Recipient JID |
| proto | object (record) | required | Raw protobuf message as a JSON object |
| opts | object | optional | Optional relay options |
| opts.messageId | string | optional | Custom message ID |
| opts.participant | string | optional | Participant JID (for group messages) |
| opts.additionalAttributes | object (record) | optional | Extra attributes to attach |
| opts.useUserDevicesCache | boolean | optional | Whether to use the user-devices cache |

---

### reset_enrichment_errors

Reset enrichment errors so failed messages can be re-enriched. Clears `enrichment_processed_at`, `enrichment_error`, and `enrichment_retries`. Pass specific PKs to reset individual messages, or omit to reset all failed messages.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| pks | array of number | optional | Message primary keys to reset; omit to reset all failed messages |

---

## calls.ts

Call handling tools.

---

### reject_call

Reject an incoming WhatsApp call by call ID and caller JID.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| call_id | string | required | Call ID from the incoming call event |
| call_from | string | required | JID of the caller |

---

## presence.ts

Presence tools: send typing indicators and monitor contact presence state.

---

### send_typing

Send a typing indicator to the current chat.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatJid | string | required | JID of the chat to send the typing indicator to (auto-injected in chat-scoped sessions) |
| type | `"composing"` \| `"recording"` \| `"paused"` | required | Presence type to broadcast |

**Returns:** `{ success: true, type }`.

---

### subscribe_presence

Subscribe to presence updates for a WhatsApp contact or group JID. After subscribing, presence status will be available via `get_presence`.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Contact or group JID to subscribe to |

---

### get_presence

Get the cached presence status for a WhatsApp contact JID. Returns `null` if no presence has been received yet.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jid | string | required | Contact JID |

---

## voice.ts

Text-to-speech tool using ElevenLabs API with circuit breaker protection.

> Uses `targetMode: injected` — see note in messaging section above.

---

### send_voice_reply

Synthesize text to speech via ElevenLabs and send as a WhatsApp voice note (PTT). The audio is generated, written to a temp file, and sent as a push-to-talk voice message.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| text | string | required | Text to synthesize and send as a voice note |
| voice_id | string | optional | ElevenLabs voice ID (defaults to instance config) |

**Requires:** `ELEVENLABS_API_KEY` in GNOME Keyring. Circuit breaker trips after 3 consecutive failures (60s recovery window).

---

## knowledge.ts

Pinecone-backed semantic search across configured knowledge base indexes.

---

### knowledge_search

Search company knowledge bases using natural language queries. Results are pre-formatted summaries from Pinecone vector search with reranking.

> **Conditional registration.** This is the only tool that is not always registered. It is registered only when `memory.pinecone.allowedIndexes` (or legacy `pineconeAllowedIndexes`) is non-empty, `memory.pinecone.knowledgeSearch.enabled` is not `false`, the call site has not disabled knowledge search, the configured Pinecone API key environment variable is set, at least one allowed index has a declared knowledge profile, and the Pinecone client initializes successfully. Instances without usable Pinecone configuration will not expose this tool. See `src/mcp/register-all.ts` and `src/mcp/tools/knowledge.ts` for the gates.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| index | string (enum) | required | Pinecone index name to search |
| query | string | required | Natural language search query (2-500 chars) |
| top_k | number | optional | Number of results (1-20) |
| namespace | string | optional | Override default namespace(s) |

**Returns:** `index`, `query`, `results_count`, a structured `results` array containing each result's `id`, numeric `score`, and `entity_type`, plus a human-readable `formatted` summary. Available indexes are dynamically configured per instance. When an index profile defines `minScore`, lower-scoring hits are omitted and an all-low-score search returns zero results.

---

## memory-write.ts

Agent-facing episodic memory write into the configured per-person Pinecone index.

---

### memory_write

Persist a durable memory about the current conversation into the instance's configured Pinecone memory index (`memory.pinecone.index`) via the integrated-embedding upsert path. Intended for agent instances, which do not run the chat-runtime enrichment poller.

> **Conditional registration.** Registered only when a Pinecone API key is available (`memory.pinecone.apiKeyEnv`, default `PINECONE_API_KEY`) and a Pinecone index is configured. `core: false` — absence is tolerated. The configured project guard is enforced by `PineconeMemory.upsert`. See `src/mcp/register-all.ts` and `src/mcp/tools/memory-write.ts`.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| text | string | required | The memory content to persist (1-2000 chars) |
| memory_type | string (enum) | required | user_fact \| group_context \| preference \| correction \| self_fact |
| confidence | number | optional | 0-1 confidence (default 0.8) |
| claim | string | optional | Toulmin claim |
| evidence | string | optional | Toulmin evidence |
| warrant | string | optional | Toulmin warrant |
| contradicts | string | optional | id of a superseded memory |

**Returns on success:** `{ operation_id, status: "written", memory_type }`, where `operation_id` is an opaque correlation reference. The internal record ID is not returned.

**Returns on provider failure:** `{ error: "memory_write failed", code, retryable, operation_id }`, where `code` is a stable memory-operation failure code and no provider exception prose is exposed. The conversation and speaker are derived from the session, never caller-supplied.

---

## retention.ts

On-demand media file cleanup with optional dry-run support.

> Uses `scope: global` and `targetMode: caller-supplied`.

---

### cleanup_media

Scan and delete expired media files (downloads, voice notes, cached thumbnails) from the instance media directories. Files in `media/tmp/` are expired after `tempMaxAgeHours` (default 72 h); files in `media/cache/` after 7 days. Use `dry_run: true` to preview what would be deleted without deleting anything.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| max_age_hours | number | optional | Override temp file max age in hours for this run. Default: uses instance retention config. |
| dry_run | boolean | optional | If `true`, report what would be deleted without deleting. Default: `false`. |

**Returns:** `{ dry_run, deleted, skipped, bytes_freed }`.

---

## status.ts

WhatsApp Status (Stories) tools for posting and listing status updates.

> Uses `scope: global` and `targetMode: caller-supplied`.

---

### post_status

Post a WhatsApp Status update to all known contacts. Supports text statuses and image/video statuses from local files.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| text | string | optional | Text content for a text status. Required if `filePath` is not provided. |
| filePath | string | optional | Absolute path to an image or video file (`.png`, `.jpg`, `.jpeg`, `.gif`, `.mp4`, `.mov`, `.webm`). Required if `text` is not provided. |
| caption | string | optional | Caption to overlay on image/video statuses. Falls back to `text` if omitted. |
| backgroundColor | string | optional | Background color for text statuses (hex string). |
| font | number | optional | Font index for text statuses. |

**Returns:** `{ sent: true, statusType, recipientCount, messageId }`.

**Errors:**

| Code | Condition |
|------|-----------|
| `Error` | Neither `text` nor `filePath` provided |
| `Error` | No status recipients found in contacts table |
| `Error` | WhatsApp is not connected |
| `Error` | File not found or outside allowed workspace root |
| `Error` | File exceeds 50 MB limit |
| `Error` | Unsupported media extension |

---

### list_statuses

List stored WhatsApp Status messages grouped by sender. Optionally mark the returned statuses as read.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| limit | number | optional | Max statuses to return (1–200). Default: 50. |
| sender_jid | string | optional | Filter statuses by sender JID. |
| mark_read | boolean | optional | If `true`, send read receipts for all returned statuses. Default: `false`. |

**Returns:** `{ count, markedRead, senders[] }` where each sender entry contains `senderJid`, `senderName`, `count`, and `statuses[]`.

---

## scheduling.ts

Scheduled message tools: create, list, and cancel messages queued for future delivery.

> Uses `scope: chat` — in chat-scoped sessions `chatJid` is auto-injected for `schedule_message`.

---

### schedule_message

Schedule a text or media message to be sent later. In chat-scoped sessions the current chat is used automatically.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `injected` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatJid | string | required | Target chat JID (auto-injected in chat-scoped sessions). |
| scheduled_at | number (int) | required | UTC Unix timestamp in seconds. Must be in the future. |
| text | string | optional | Text content. Required if `filePath` is not provided. |
| filePath | string | optional | Absolute path to a media file (see supported extensions below). Required if `text` is not provided. |
| caption | string | optional | Caption for image, video, or document media. |
| filename | string | optional | Override filename for document attachments. |
| ptt | boolean | optional | Send audio as a push-to-talk voice note. |
| seconds | number (int) | optional | Audio duration in seconds. |
| ptv | boolean | optional | Send video as a push-to-talk video note. |
| gifPlayback | boolean | optional | Send video with GIF-style auto-play. |
| viewOnce | boolean | optional | Send image or video as view-once. |
| isAnimated | boolean | optional | Mark a WebP sticker as animated. |
| mediaType | `"image"` \| `"video"` \| `"audio"` \| `"document"` \| `"sticker"` | optional | Override the media type inferred from the file extension. |

**Supported file extensions:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.pdf`, `.doc`, `.docx`, `.xlsx`, `.csv`, `.txt`, `.zip`, `.mp3`, `.ogg`, `.m4a`, `.wav`, `.mp4`, `.mov`, `.webm`.

**Returns:** `{ id, chatJid, contentType, scheduledAt, status: "pending" }`.

**Errors:**

| Code | Condition |
|------|-----------|
| `Error` | `scheduled_at` is not a future timestamp |
| `Error` | Neither `text` nor `filePath` provided |
| `Error` | File not found, outside workspace root, too large (> 50 MB), or unsupported extension |

---

### list_scheduled

List scheduled messages. Chat-scoped sessions only see messages for the current conversation.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatJid | string | optional | Filter by target chat JID. |
| limit | number | optional | Max messages to return (1–200). Default: 100. |
| status | `"pending"` \| `"processing"` \| `"failed"` \| `"cancelled"` \| `"sent"` | optional | Filter by status. Default: returns `pending` and `processing` only. |

**Returns:** `{ count, messages[] }` where each message contains `id`, `chatJid`, `contentType`, `payload`, `scheduledAt`, `status`, `createdAt`, `sentAt`, `error`, `retryCount`.

---

### cancel_scheduled

Cancel a pending scheduled message by ID.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number (int) | required | Scheduled message ID (from `schedule_message` or `list_scheduled`). |

**Returns:** `{ cancelled: true, id }`.

**Errors:**

| Code | Condition |
|------|-----------|
| `Error` | Scheduled message ID not found |
| `Error` | Access denied: message belongs to a different conversation (chat-scoped sessions) |
| `Error` | Message is not in `pending` status (already sent, cancelled, processing, or failed) |

---

### get_scheduled

Get details for a single scheduled message by ID.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number (int) | required | Scheduled message ID. |

**Returns:** the scheduled message row as `{ id, chatJid, chatName, contentType, payload, scheduledAt, recurrence, nextRunAt, runCount, status, createdAt, sentAt, error, retryCount }`.

**Errors:**

| Code | Condition |
|------|-----------|
| `Error` | Scheduled message ID not found |
| `Error` | Access denied: message belongs to a different conversation (chat-scoped sessions) |

---

### update_scheduled

Update a pending scheduled message. Can change time, text, or recurrence.

| | |
|---|---|
| **Scope** | `chat` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `safe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number (int) | required | Scheduled message ID. |
| scheduled_at | number (int) | optional | New UTC Unix timestamp in seconds. Must be in the future. |
| text | string | optional | Replacement text payload; changes content type to text. |
| recurrence | string | optional | Replacement 5-field cron expression. |

**Returns:** the updated scheduled message row.

**Errors:**

| Code | Condition |
|------|-----------|
| `Error` | Scheduled message ID not found |
| `Error` | Access denied: message belongs to a different conversation (chat-scoped sessions) |
| `Error` | Message is not in `pending` status |
| `Error` | `scheduled_at` is not a future timestamp |
| `Error` | Cron expression is invalid |
| `Error` | No fields to update |

---

## runtime-tool-registrations.ts (inline)

Control-plane repair tooling declared in `src/runtimes/agent/runtime-tool-registrations.ts` and registered from `AgentRuntime.start()` rather than under `src/mcp/tools/`. Conditional registration: only the repair-issuing role (non-sandboxed Q with at least one configured control peer) exposes this surface; sandboxed repair targets (Loops) do not.

> Uses `scope: global` and `targetMode: caller-supplied`. Tagged `core: false` so absence on instances that fail the gate is tolerated rather than fatal.

---

### emit_heal_result

Signal completion of a repair cycle. Only callable during an active repair session — the call validates that `reportId` matches the runtime's active control report and that a control queue is wired. On `result: 'fixed'` the runtime emits a `HEAL_COMPLETE` control message to the configured `loops` peer; on `result: 'escalate'` it emits `HEAL_ESCALATE` (with the supplied `diagnosis`) instead. The schema lives in [`src/core/heal-protocol.ts`](../src/core/heal-protocol.ts) as `EmitHealResultSchema`.

> **Conditional registration.** Registered only when all of the following hold (gated in `registerRuntimeInlineTools`, `src/runtimes/agent/runtime-tool-registrations.ts`):
>
> - `config.controlPeers.size > 0` — the instance has at least one configured control-plane peer, and
> - the runtime is not in `sandboxPerChat` mode, and
> - the runtime is not in `sandbox` mode.
>
> Instances that fail any of these gates omit this tool at runtime. Tagged `core: false` in the `ToolDeclaration`.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| reportId | string | required | Identifier of the repair report being completed. Must match the runtime's `activeControlReportId`. |
| errorClass | string | required | Normalized error class string (see `normalizeErrorClass` in `src/core/heal-protocol.ts`). |
| result | string (enum) | required | One of `fixed` (repair succeeded — emits `HEAL_COMPLETE`) or `escalate` (repair failed or out of scope — emits `HEAL_ESCALATE`). |
| commitSha | string | optional | Commit SHA of the landed fix when `result: 'fixed'`. Surfaced in the outbound `HEAL_COMPLETE` payload. |
| diagnosis | string | required | Human-readable summary of what was done (for `fixed`) or why the cycle is being escalated (for `escalate`). |

**Returns:** `{ sent: true, reportId, result }` once the corresponding control message has been queued.

**Errors:**

| Code | Condition |
|------|-----------|
| `Error` | No active repair session (`activeControlReportId` is unset) |
| `Error` | `reportId` does not match the runtime's active repair |
| `Error` | Control queue not found |
