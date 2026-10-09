# Reply Guarantee Protocol

The Reply Guarantee Protocol (RGP) is reliability coverage for the gap between
two different concerns:

- WhatSoup already guarantees durable delivery for messages it decides to send.
- Reply-required agent turns need liveness and session-boundary recovery when no
  visible output appears.

The scoped invariant is:

> A reply-required turn that reaches an agent/session boundary without visible
> output leaves a durable fallback intent for the originating chat; live runtime
> completion is decided separately from exact persisted turn and delivery evidence.

This is not a universal claim that every inbound must echo a reply. Immutable turn
finalization can record `finalized_replied`, `finalized_no_reply_policy`,
`failed_terminal`, or `transferred_to_recovery_owner`. Only the first is a proved
reply; intentional suppression, failure, and recovery ownership stay explicit.

This document records the architecture and its shipped state. All six layers
below are now implemented: the pure transcript parser
(`deploy/hooks/lib/transcript-walk.mjs`), the hook-tier state and MCP client
helpers (`deploy/hooks/lib/rgp-state.mjs`, `deploy/hooks/lib/whatsoup-mcp-call.mjs`),
the Stop hook (`deploy/hooks/stop-ensure-reply.mjs`), the drain daemon
(`deploy/hooks/drain-stuck-replies.mjs`, driven by
`deploy/scripts/reply-guarantee-drain.sh` on the
`whatsoup-reply-guarantee.timer`/`.service` systemd units and the
`com.whatsoup.reply-guarantee.plist` launchd agent), and the runtime watchdog
(`ReplyGuaranteeManager` in `src/core/reply-guarantee.ts`, armed from the agent
runtime), plus the runtime assistant-text egress gate. Layer-level status is
noted inline below.


> **Rate-limit wiring:** the in-process watchdog limits its typing-only liveness nudge to 1 per 15 min per chat (in-memory, reset on restart). `rgp-state.mjs` defines `checkAndRecordRateLimit` for a persisted 3-per-hour fallback limit, but the Stop hook and drain do not call it in source revision `59cc562bc` (2026-10-06). That fallback limit is not currently enforced by these callers. Wiring and validating it remains an implementation gap; the runtime nudge is never delivery or terminal proof.

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
   under `deploy/hooks/lib/` to keep hook state separate from runtime business
   logic. `rgp-state.mjs` imports shared filesystem and process-lock utilities
   from `src/lib/`.

3. Stop hook (shipped).
   The Stop hook (`deploy/hooks/stop-ensure-reply.mjs`) uses transcript
   visibility to enqueue a fallback intent when a session ends without a visible
   reply, capturing bounded tool-error context for that fallback.

4. Drain daemon and durability observer (shipped).
   `deploy/hooks/drain-stuck-replies.mjs` retries queued fallback intents when the
   in-session hook could not send immediately. It is driven by
   `deploy/scripts/reply-guarantee-drain.sh` on the
   `whatsoup-reply-guarantee.timer`/`.service` systemd units (and the
   `com.whatsoup.reply-guarantee.plist` launchd agent on macOS). The same wrapper
   independently runs `deploy/scripts/reply-guarantee-observer.py`, which opens
   each instance database with SQLite URI `mode=ro` so committed WAL frames remain
   visible. It reports `active-breach`, `recovery-debt`, `clear`, or
   `inconclusive` without replaying or modifying durable rows. Historical failed
   terminals and continuity candidates are recovery debt with no runtime-health
   impact; only stale open inbound or recovery work is an operational breach.
   A turn an operator cancelled with `/stop` (`operator_cancelled`) is a
   requested outcome, not debt, so its failed terminal is not counted.
   A continuity candidate whose inbound is a synthetic scheduled-job turn
   (message id `agentjob-*`, case-sensitive) owes no user a reply, so it is
   reported as `syntheticContinuityCandidates` and not counted as debt (#3754).
   `failedTerminalWithEchoEvidence` is a subset of failed-terminal debt, not an
   additional replay count; it exposes contradictory delivery evidence that
   must be reconciled before any targeted repair.
   An `active-breach` names no owner. To attribute each stale `processing` row,
   run the operator script `scripts/inbound-ownership-snapshot.ts` (#3560). It
   reads through the same normal read-only mode and classifies each row as
   `deferred`, `queued`, `executing` or `no_owner` (never healthy), optionally
   joined with a captured provider-execution gate state. See runbook §8, "Who
   owns a stale `processing` inbound".

   `staleOpenInbounds` counts the open inbounds (`pending`, `processing` or
   `turn_done`) whose `received_at` text sorts before `datetime(now,
   -threshold)` and that have no terminal record. Every alert latch reads that
   count and the other `counts` fields only.
   Each conclusive observation also carries `progressDiagnostics`, which a
   page can cite but which never changes the state, an alert latch, a
   `--clear` or the exit code (R46). Inconclusive observations omit it. The
   diagnostics are read only after every instance's base observation is
   complete, in the same instance order, each on a read-only connection of
   its own, so they never delay a base read. Each result joins its
   observation before anything is printed or emitted.
   - **Available.** `{"available": true, "staleRows", "staleChats",
     "staleRowsWithRecentSend"}`, read by one SQL statement over the
     `staleOpenInbounds` predicate, copied verbatim:
     - `staleRows`: the number of rows in that set;
     - `staleChats`: the number of distinct `conversation_key` values among
       them;
     - `staleRowsWithRecentSend`: the rows in that set with at least one
       `outbound_ops` row whose `source_inbound_seq` is the row's `seq`,
       whose status is `submitted` or `echoed`, and whose send time
       `COALESCE(datetime(echoed_at), datetime(submitted_at))` is after
       `received_at`, no later than now, and no earlier than now minus the
       stale threshold. The send time is the first of the two that parses as
       a time, so a malformed `echoed_at` falls back to `submitted_at`; a
       send with neither does not count. The stale set keeps base's text
       comparison of `received_at`; the send bounds compare
       `datetime()`-normalised values. Because the send time prefers
       `echoed_at`, a send echoed after `now` but before the diagnostics read
       drops out of `staleRowsWithRecentSend`, even if it was submitted
       inside the window; this affects the diagnostics only.
   - **What they do not say.** The fields make no claim about queue
     position. In `single` and `shared` session scope one queue serves every
     chat, so several stale chats can sit behind one stuck turn. Sends with no
     source inbound never count: the "Queued behind the current task"
     receipt, startup, admin and health notices. `outbound_ops` records no
     message role, so a command reply sent through the chat queue while a row
     is the active turn is tied to that row and counts as a recent send; that
     is one reason these fields never page.
   - **Time bound.** The diagnostics of each instance have a 2 s wall-clock
     budget, counted from before their schema check. Before each diagnostic
     statement the busy timeout is set to the budget that remains, so a lock
     wait ends by the deadline; an SQLite progress handler interrupts
     statement work once the budget is spent; and a result that arrives after
     the budget, a missing column included, is discarded. The diagnostics add
     at most about the budget plus one progress-check interval per conclusive
     instance, before anything is emitted; instances run one after another.
     The bound is cooperative, not strict:
     - the cap applies to each lock wait, not to each statement, so a
       statement that SQLite prepares again after a schema change can wait
       again for up to the same remaining budget;
     - neither mechanism covers a blocking file read inside one SQLite VM
       instruction, or SQLite's own retry loop when it starts a WAL read,
       which can back off for up to about 10 s before it fails. Base's own
       reads carry the same exposure to both.
   - **Unavailable.** `{"available": false, "reason": ...}` with one fixed
     reason code:
     - `diagnostic_columns_missing`: the database lacks
       `inbound_events.conversation_key`, `outbound_ops.submitted_at` or
       `outbound_ops.echoed_at`;
     - `diagnostic_failed`: a diagnostic statement failed within the budget,
       the database path is no longer a regular file or has become a
       symlink, or opening the diagnostics connection, setting `query_only`
       on it or closing it failed;
     - `diagnostic_budget_exceeded`: the diagnostics ran past the budget,
       whether waiting for a lock or working; any values are discarded;
     - `diagnostic_count_changed`: `staleRows` differs from
       `staleOpenInbounds`, which the base observation read earlier on its
       own connection; the later instances' base observations and the
       earlier instances' diagnostics run in between. This is a count check
       only: a write between the two reads that leaves the count unchanged is
       not detected.

5. Runtime watchdog (shipped).
   The runtime-owned manager (`ReplyGuaranteeManager` in
   `src/core/reply-guarantee.ts`, armed from the agent runtime) arms per inbound
   event and emits a rate-bounded typing-only liveness nudge after sustained
   silence. It never completes the inbound row: immutable turn finalization owns
   terminal CAS, delivery proof, recovery transfer, and disarm.

6. Assistant-text egress gate (shipped).
   The agent runtime classifies provider `assistant_text` before it reaches the
   WhatsApp outbound queue. High-confidence process narration is suppressed but
   leaves the watchdog armed; high-confidence no-op or send-verification chatter
   is recorded as intentional suppression, and the terminal finalizer then
   disarms the watchdog only after the no-reply policy terminal commits.
   Explicit MCP sends (`send_message`, `reply_message`, media captions) bypass
   this gate because they already carry user-visible send intent.

Immutable turn finalization is the terminal authority for live runtime turns.
The runtime watchdog is only a rate-bounded liveness monitor: a successful
typing nudge is neither user-visible delivery nor terminal proof, and an open
inbound remains monitored until durable terminal state disarms it. The Stop
hook and drain daemon provide actual fallback-notice recovery at agent/session
boundaries where live finalization cannot finish. A fallback intent or attempted
send is not relabeled as an echoed reply; outbound delivery evidence retains its
own status until transport reconciliation proves what happened.

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
- Hook helpers call runtime behavior through the MCP socket. Shared `src/lib/`
  filesystem and process-lock utilities are imported by `rgp-state.mjs`; hooks
  must not import runtime business logic or open the instance SQLite database.
- The scheduled durability observer is not a hook helper. It may read the
  canonical per-instance database, but only through normal SQLite read-only mode;
  it must not use `immutable=1`, copy a live main file without its WAL/SHM
  sidecars, write rows, or automatically replay broad failed-row cohorts.
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

The full six-layer implementation and its tests have since shipped (see the
Layered Design section). Runtime watchdog behavior, including fail-closed typing
adapter failures and continued monitoring of open inbound rows, is covered by
`tests/core/reply-guarantee.test.ts`.

The scheduled observer has a separate acceptance boundary in
`deploy/scripts/tests/test_reply_guarantee_observer.py`: it proves visibility of
an uncheckpointed WAL commit, active-versus-debt classification, schema and user
context failures as inconclusive, content-free evidence, per-instance alert
ownership, and fail-closed preservation of both drain and observer exit states.
BOT ERRORS emissions are transition-latched in the shared private state root. A
source is only latched after the emitter accepts the event, so rejected alerts
and clears retry on the next observation. Repeated identical observations stay
quiet, and an inconclusive scan never clears a previously latched breach or debt
signal.
