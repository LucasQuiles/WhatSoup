# WhatSoup MCP Tool API Reference

Complete reference for all 127 MCP tools exposed by WhatSoup. Tools are grouped by module. Each tool lists its scope, replay policy, and parameters extracted from the Zod schema.

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

---

## Table of Contents

| Module | Tools |
|--------|------:|
| [messaging.ts](#messagingts) | 9 |
| [media.ts](#mediats) | 1 |
| [chat-management.ts](#chat-managementts) | 10 |
| [chat-operations.ts](#chat-operationsts) | 11 |
| [search.ts](#searchts) | 3 |
| [groups.ts](#groupsts) | 19 |
| [community.ts](#communityts) | 12 |
| [newsletter.ts](#newsletterts) | 19 |
| [business.ts](#businessts) | 13 |
| [profile.ts](#profilets) | 14 |
| [advanced.ts](#advancedts) | 13 |
| [calls.ts](#callsts) | 1 |
| [presence.ts](#presencets) | 2 |
| **Total** | **127** |

---

## messaging.ts

Chat-scoped messaging tools for sending, replying to, reacting to, editing, deleting, pinning, and decorating messages.

> All tools in this module use `targetMode: injected`. In chat-scoped sessions `chatJid` is auto-injected and must not be passed. In global sessions `chatJid` must be supplied.

---

### send_message

Send a text message to the current chat. Supports @name and @number mentions.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| text | string | required | Message text (supports @name/@number mention syntax) |
| viewOnce | boolean | optional | Send as a view-once message that disappears after viewing |

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

Send a poll to the current chat.

| | |
|---|---|
| **Scope** | `chat` |
| **Replay Policy** | `unsafe` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| question | string | required | Poll question text |
| options | array of string | required | Poll options (2–12 items) |
| selectableCount | number | optional | Number of options voters may select; defaults to 1 |

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

List all WhatsApp conversations with their last message timestamp and metadata. Returns conversations ordered by most recent activity.

| | |
|---|---|
| **Scope** | `global` |
| **Target Mode** | `caller-supplied` |
| **Replay Policy** | `read_only` |

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| limit | number | optional | Max conversations to return; defaults to 100 |

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

Presence monitoring tools: subscribe to presence updates and read cached presence state.

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
