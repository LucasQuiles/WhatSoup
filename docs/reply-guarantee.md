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

This document records the architecture target. The first shipped piece is the
pure transcript parser in `deploy/hooks/lib/transcript-walk.mjs`; hook
execution, queue state, daemons, and runtime watchdogs are intentionally split
into later PRs.

## Current Surface

The existing durability layer remains the source of truth:

- `src/core/durability.ts` owns `inbound_events` and `outbound_ops`.
- `src/core/outbound-sends.ts` owns outbound send audit records.
- Runtime recovery already handles many known failure modes when a message has
  entered the outbound pipeline.

RGP is layered above those journals. It must not create a parallel outbound
state machine, duplicate chat/JID normalization, or write a second audit store.

## Layered Design

RGP is decomposed into independently reviewable layers:

1. Transcript visibility parser.
   A pure hook-tier helper reads Claude transcript JSONL and decides whether the
   assistant produced a visible reply after the most recent human user turn.

2. Hook-tier state and MCP client helpers.
   Later hook PRs will need a per-instance queue and a small UNIX-socket JSON-RPC
   client. Those helpers stay under `deploy/hooks/lib/` because hook processes
   cannot import runtime TypeScript modules.

3. Stop and PostToolUse hooks.
   The Stop hook will use transcript visibility to enqueue a fallback intent when
   a session ends without a visible reply. The PostToolUse hook will capture
   bounded tool-error context for that fallback.

4. Drain daemon.
   A daemon will retry queued fallback intents when the in-session hook could not
   send immediately.

5. Runtime watchdog.
   The runtime-owned manager will arm per inbound event and disarm when the
   existing durability journal observes a terminal echoed outbound response.

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

Later PRs add queue, daemon, runtime, and integration tests without widening the
scope of this parser PR.
