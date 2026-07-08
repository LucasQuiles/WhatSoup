# Reply Guarantee Protocol

The Reply Guarantee Protocol (RGP) is the reliability layer for the gap between
two different promises:

- WhatSoup already guarantees durable delivery for messages it decides to send.
- WhatSoup also needs to guarantee that every inbound user message produces a
  visible reply or an explicit interruption notice.

The invariant is:

> For every inbound user message, WhatSoup eventually records either a terminal
> echoed outbound response for that turn or a fallback notification delivered to
> the originating chat.

This document records the architecture and its shipped state. All five layers
below are now implemented: the pure transcript parser
(`deploy/hooks/lib/transcript-walk.mjs`), the hook-tier state and MCP client
helpers (`deploy/hooks/lib/rgp-state.mjs`, `deploy/hooks/lib/whatsoup-mcp-call.mjs`),
the Stop hook (`deploy/hooks/stop-ensure-reply.mjs`), the drain daemon
(`deploy/hooks/drain-stuck-replies.mjs`, driven by
`deploy/scripts/reply-guarantee-drain.sh` on the
`whatsoup-reply-guarantee.timer`/`.service` systemd units and the
`com.whatsoup.reply-guarantee.plist` launchd agent), and the runtime watchdog
(`ReplyGuaranteeManager` in `src/core/reply-guarantee.ts`, armed from the agent
runtime). Layer-level status is noted inline below.


> **Rate-limit layering note:** two independent throttles guard the fallback message, both keyed per chat — the in-process watchdog (1 per 15 min, in-memory, resets on restart) and the hook-tier drain (3 per hour, persisted per instance in `fallback-rate-limit.json`). They differ in window, threshold, and persistence; a fallback is sent only when the layer handling that path admits it. Tune them together.

## Current Surface

The existing durability layer remains the source of truth:

- `src/core/durability.ts` owns `inbound_events` and `outbound_ops`.
- `src/core/outbound-sends.ts` owns outbound send audit records.
- Runtime recovery already handles many known failure modes when a message has
  entered the outbound pipeline.

RGP is layered above those journals. It must not create a parallel outbound
state machine, duplicate chat/JID normalization, or write a second audit store.

## Layered Design

RGP is decomposed into independently reviewable layers, all now shipped:

1. Transcript visibility parser (shipped).
   A pure hook-tier helper (`deploy/hooks/lib/transcript-walk.mjs`) reads Claude
   transcript JSONL and decides whether the assistant produced a visible reply
   after the most recent human user turn.

2. Hook-tier state and MCP client helpers (shipped).
   A per-instance queue (`deploy/hooks/lib/rgp-state.mjs`) and a small UNIX-socket
   JSON-RPC client (`deploy/hooks/lib/whatsoup-mcp-call.mjs`). Those helpers stay
   under `deploy/hooks/lib/` because hook processes cannot import runtime
   TypeScript modules.

3. Stop hook (shipped).
   The Stop hook (`deploy/hooks/stop-ensure-reply.mjs`) uses transcript
   visibility to enqueue a fallback intent when a session ends without a visible
   reply, capturing bounded tool-error context for that fallback.

4. Drain daemon (shipped).
   `deploy/hooks/drain-stuck-replies.mjs` retries queued fallback intents when the
   in-session hook could not send immediately. It is driven by
   `deploy/scripts/reply-guarantee-drain.sh` on the
   `whatsoup-reply-guarantee.timer`/`.service` systemd units (and the
   `com.whatsoup.reply-guarantee.plist` launchd agent on macOS).

5. Runtime watchdog (shipped).
   The runtime-owned manager (`ReplyGuaranteeManager` in
   `src/core/reply-guarantee.ts`, armed from the agent runtime) arms per inbound
   event and disarms when the existing durability journal observes a terminal
   echoed outbound response.

6. Assistant-text egress gate (shipped).
   The agent runtime classifies provider `assistant_text` before it reaches the
   WhatsApp outbound queue. High-confidence process narration is suppressed but
   leaves the watchdog armed; high-confidence no-op or send-verification chatter
   is suppressed and disarms the watchdog for the active inbound turn, preventing
   a hidden acknowledgement from being followed by the generic runtime fallback.
   Explicit MCP sends (`send_message`, `reply_message`, media captions) bypass
   this gate because they already carry user-visible send intent.

The runtime watchdog is the root guarantee. Hooks and daemons are recovery
coverage for agent/session boundaries.

## Transcript Visibility

`inspectTranscript(transcriptPath)` walks transcript JSONL records and returns:

- `lastUserIdx`: index of the most recent human user record in parsed records.
- `assistantTextChars`: total trimmed assistant text characters after that user.
- `sendsAfter`: successful WhatsApp send tool results after that user.
- `lastAssistantText`: most recent assistant text snippet after that user.
- `malformedLines`: number of ignored malformed JSONL lines.
- `error`: present when the transcript file could not be read.

A visible reply is present when either:

- Assistant text after the last human user message has at least
  `MIN_ASSISTANT_TEXT_CHARS` trimmed characters.
- A WhatsApp send tool use after that user has a later successful tool result.

Tool-result-only user records are not treated as human turns. Malformed JSONL
lines are ignored so a partial transcript does not crash the Stop hook.

## Boundaries

RGP implementation must keep these boundaries intact:

- Hook helpers may read transcript files and hook-local state only.
- Hook helpers call runtime behavior through the MCP socket; they do not import
  `src/` modules or open SQLite directly.
- Runtime code uses the existing durability, outbound audit, retry, and JID
  normalization helpers.
- Per-instance state is keyed by `WHATSOUP_INSTANCE`; the runtime must emit this
  environment value before hook execution is enabled.
- `WHATSOUP_MCP_SOCKET` is required before a hook can attempt delivery.

## Verification Strategy

Every RGP PR should carry one behavioral idea and its own verification matrix.

For the transcript parser:

- Assistant text after the last human user counts as a reply.
- Successful WhatsApp send tools count as a reply.
- Failed WhatsApp send tools do not count.
- Tool-result-only user messages are ignored.
- Malformed transcript lines are tolerated.

The queue, daemon, runtime watchdog, and their tests have since shipped as
separate layers (see the Layered Design section); runtime watchdog behavior is
covered by `tests/core/reply-guarantee.test.ts`.
