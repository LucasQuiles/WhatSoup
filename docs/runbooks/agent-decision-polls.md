# Agent Decision Polls

This runbook defines the portable contract for using WhatsApp polls as an agent/user decision interface.

## Contract

There are two poll paths with different semantics:

1. `AskUserQuestion` for blocking decisions.
   - Use when the agent cannot safely continue without a user decision.
   - WhatSoup intercepts the tool use only in per-chat DM agent sessions, renders each question as a WhatsApp poll, and injects the selected answer back into the next agent turn.
   - Group chats and shared/global agent sessions fall through to the provider's native behavior by default.
   - Use `multiSelect: true` when the user may choose more than one option.
   - Keep option labels short. Put paragraph-scale context in option descriptions so WhatSoup can send details before the poll.

2. `send_poll` for non-blocking coordination.
   - Use when the poll is a survey, lightweight preference check, brainstorming aid, or coordination signal that does not need to unblock the current agent turn.
   - Set `selectableCount` above `1` for multi-select polls.
   - Do not expect `send_poll` votes to be injected as a tool result. It sends the poll only.

## Agent Guidance

Agents should follow this decision tree:

1. If the user decision blocks the current task and `AskUserQuestion` is available, use `AskUserQuestion`.
2. If the decision is advisory or non-blocking, use `send_poll`.
3. If the provider does not expose `AskUserQuestion`, use `send_poll` and clearly state that the user should vote in the poll, then continue only after observing the follow-up message or poll result through normal message context.
4. Never ask the user to type `I voted`. The runtime waits for the native poll vote; exact option label or option number is only a fallback when WhatsApp vote delivery fails.
5. Put the recommended option first when there is a safe default.
6. Include `Need more context`, `Defer`, `Cancel`, or an equivalent escape hatch when the decision is non-urgent, risky, irreversible, or under-specified.
7. Prefix high-risk irreversible options with `[Risk]` in the label or description so the tradeoff is visible in WhatsApp.

## Default Other Option

For `AskUserQuestion` in per-chat DMs, WhatSoup appends `Other — propose a different option` when all of these are true:

- The effective option list has fewer than 12 options.
- No existing escape hatch label is present.
- The interaction is a DM per-chat session, not a group or shared/global session.

When the user selects the default Other option, the runtime injects a structured follow-up directive instead of treating it as approval. The agent must interview the user, explore their reasoning with 1-2 follow-up questions, then either propose a revised option or re-present the decision with the new option added.

Agents should normally provide at most 11 AskUser options if they want the runtime to append Other. If an option list already has 12 options, the runtime does not exceed WhatsApp's cap and logs that Other was not appended.

Agents should not add their own generic `Other` option unless they need custom wording. Use explicit escape hatches such as `Need more context` when the correct next step is more information rather than a new option.

## Formatting Rules

- Questions: keep under the WhatsApp poll question limit. If context is long, send a normal message first and keep the poll question short.
- Options: 2-12 unique, non-empty labels.
- Long option explanations: send as normal message context or `AskUserQuestion` descriptions, not as poll option labels.
- Multi-select: use `multiSelect: true` for `AskUserQuestion`; use `selectableCount > 1` for `send_poll`.
- Paragraph brainstorming options: use concise labels plus descriptions. The runtime sends full descriptions as companion text when poll option text would be too dense. If native poll send then fails immediately, the fallback avoids repeating details that were already flushed and points the user back to the detail message.

## Recovery Behavior

- Restart durability: pending poll state lives in the runtime's `pendingPollQuestions` map AND is mirrored to the `pending_polls` SQLite table (migration 28). `persistPendingPoll` upserts on every meaningful state change (register, ballot append, mode flip, answer collected); `removePendingPoll` deletes on settle / hard-expiry / cancellation. On `AgentRuntime.start()`, `rehydratePendingPolls` restores live polls with re-armed timers using the remaining time, and drops rows where `hard_closes_at <= now`. Expired-during-downtime polls are notified **per chat, consolidated**: a chat that stranded one poll gets a single-poll notice; a chat that stranded several gets one "N polls expired" notice rather than one message per poll. Persistence errors are logged, swallowed, and counted (`pollPersistenceErrors`, surfaced in health) — the in-memory state remains authoritative, so a misconfigured DB degrades to in-process-only behavior rather than crashing the runtime.
- Nudge timer: every 2 hours without a response, the runtime sends a gentle reminder ("Still waiting on your answer"). No hard expiry — polls persist until answered or the session is cleaned up.
- Decrypt failure: if WhatsApp delivers a poll vote that cannot be decrypted after all bounded JID candidates fail, transport emits `pollVoteFailed`; runtime sends a one-time numbered text fallback and accepts an option number, label, or free-text answer.
- Low-signal replies such as `I voted` do not resolve a pending poll while the native poll path is still active. The user should tap the poll or type the exact option label/number.

## Operational Notes

The `pending_polls` table is bounded in normal operation: rows are deleted on settle, hard-expiry, and cancellation, so steady-state row count tracks the number of genuinely in-flight polls (typically single digits). A row count that grows without settling indicates polls that are never resolving — investigate stuck sessions or a transport that stopped delivering `pollVoteReceived`.

- **Monitoring**: `GET /health` exposes `sqlite.pending_polls_total` (live row count) and `runtime.agent.pollPersistenceErrors` (cumulative count of swallowed persist/remove/rehydrate failures since process start). A nonzero and climbing `pollPersistenceErrors` means the DB mirror is failing while the in-memory map stays authoritative — polls still work for the current process lifetime but will not survive a restart. Check disk space, DB file permissions, and schema version.
- **Inspection**: `sqlite3 <db-path> "SELECT map_key, chat_jid, source, resolution, datetime(closes_at/1000,'unixepoch') AS closes, datetime(hard_closes_at/1000,'unixepoch') AS hard_closes FROM pending_polls ORDER BY created_at;"` lists every persisted poll with its soft/hard expiry. The runtime DB (bot.db) follows the data-root layout under `$XDG_DATA_HOME/whatsoup/instances/<name>/` (default `~/.local/share/whatsoup/instances/<name>/bot.db`). `pending_polls` is a table inside bot.db.
- **Pruning**: manual deletion is rarely needed — `rehydratePendingPolls` self-prunes `hard_closes_at <= now` rows on every start. To force a clean slate without a restart, deleting rows directly is safe: the in-memory map is authoritative for the running process and the table is a mirror, so a stray delete only loses restart-survivability for that poll, not the live poll itself.
- **Growth after long downtime**: a process that was down past many polls' hard expiry will, on next start, delete all expired rows and emit one consolidated "expired" notice per affected chat (not per poll). The `rehydratePendingPolls: completed` log line reports `restored`, `expired`, and `chatsNotified` counts.

## Trigger Matrix

| Scope | `AskUserQuestion` poll bridge | Default Other | `send_poll` | Group voting |
| --- | --- | --- | --- | --- |
| Per-chat DM | Blocking, correlated, answer injected | Auto-appended when under cap and no escape hatch | Available, non-blocking | Not applicable |
| Per-chat group | Blocking, correlated via voter policy, answer injected (default `first-vote-wins`) | Auto-appended when under cap and no escape hatch | Available; `awaitResult: true` blocks; `resolution` selects strategy | 4 strategies shipped: `first-vote-wins`, `admin-only`, `admin-wins`, `majority-after-timeout` |
| Shared/global session | Falls through to provider-native behavior | Not applied | Available, non-blocking | Not applicable |

Group polls support the four resolution strategies via `send_poll`'s `resolution` parameter, or via the instance-level `agentOptions.pollDefaults.defaultStrategy` config for `AskUserQuestion`. Each strategy:

- **`first-vote-wins`** (default): first valid ballot resolves. Same semantics as DMs.
- **`admin-only`**: only group admins (per Baileys `groupMetadata.participants`) count; non-admin votes are silently ignored.
- **`admin-wins`**: any vote is recorded, but an admin vote resolves immediately; if no admin votes by `timeoutMs`, the recorded majority resolves on timeout.
- **`majority-after-timeout`**: all votes are collected; resolution occurs only when `timeoutMs` elapses, then the highest-count option wins (with first-recorded tie-break).

`timeoutMs` is bounded to `[1_000, 86_400_000]` (1 s – 24 h) at both the MCP schema layer (`z.number().int().min(1000).max(86_400_000)`) and the runtime handler (defense in depth). Values outside the range are rejected by validation. The `AskUserQuestion` path also clamps `instanceConfig.defaultTimeoutMs` to the same bounds. Soft expiry fires at `pending.timeoutMs`; hard expiry at `pending.timeoutMs * 2`. DM polls in admin-related strategies degrade silently to `first-vote-wins` (DMs have no admin concept).

## Portability Layers

- Session prompt: `SessionManager.buildSystemPrompt()` injects decision-polling guidance into every agent provider session.
- MCP schema: `send_poll` advertises descriptions in `tools/list` so provider-native tool planners can see the usage contract.
- Runtime bridge: `AgentRuntime` intercepts `AskUserQuestion` in per-chat DM sessions and sends tracked WhatsApp polls.
- Sandbox diagnostics: provisioned workspaces install `deploy/hooks/poll-interaction-lint.mjs` as a fail-open `PostToolUse` hook that records poll-friction findings to `~/.claude/session-env/<session-id>/poll-interaction-lint.jsonl`.
- Project instructions: this runbook and `CLAUDE.md` provide portable guidance to agents that read project files rather than session prelude text.

## Portable Verification

Run `npm run guard:agent-decision-polls` after changing prompt text, `send_poll`, AskUser handling, workspace provisioning, hooks, or this runbook. The guard verifies the protocol is still represented across runtime prompts, MCP schemas, sandbox diagnostics, documentation, and release verification chains.

For release claims, also run the relevant targeted tests and `npm run guard:test-integrity`; a missing or skipped integrity scan is inconclusive, not clean.

## Known Limits

- `AskUserQuestion` poll correlation is per-chat DM only. Shared/global agent sessions and groups fall through to their provider's native behavior.
- `send_poll` is not a blocking request/response protocol.
- Implicit prose-to-poll conversion is intentionally not part of this contract. It is too prone to false positives unless a future spec defines exact trigger syntax and verification gates.
- WhatsApp poll option text has tight practical limits. For paragraph-scale brainstorming, rely on companion text and concise labels rather than trying to pack full paragraphs into poll values.
