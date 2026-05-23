# Agent Decision Polls

This runbook defines the portable contract for using WhatsApp polls as an agent/user decision interface.

## Contract

There are two poll paths with different semantics:

1. `AskUserQuestion` for blocking decisions.
   - Use when the agent cannot safely continue without a user decision.
   - WhatSoup intercepts the tool use in per-chat agent sessions, renders each question as a WhatsApp poll, and injects the selected answer back into the waiting turn.
   - Use `multiSelect: true` when the user may choose more than one option.
   - Keep option labels short. Put paragraph-scale context in option descriptions so WhatSoup can send details before the poll.

2. `send_poll` for non-blocking coordination.
   - Use when the poll is a survey, lightweight preference check, or coordination aid that does not need to unblock the current agent turn.
   - Set `selectableCount` above `1` for multi-select polls.
   - Do not expect `send_poll` votes to be injected as a tool result. It sends the poll only.

## Agent Guidance

Agents should follow this decision tree:

1. If the user decision blocks the current task and `AskUserQuestion` is available, use `AskUserQuestion`.
2. If the decision is advisory or non-blocking, use `send_poll`.
3. If the provider does not expose `AskUserQuestion`, use `send_poll` and clearly state that the user should vote in the poll, then continue only after observing the follow-up message or poll result through normal message context.
4. Never ask the user to type `I voted`. The runtime waits for the native poll vote; exact option label or option number is only a fallback when WhatsApp vote delivery fails.

## Formatting Rules

- Questions: keep under the WhatsApp poll question limit. If context is long, send a normal message first and keep the poll question short.
- Options: 2-12 unique, non-empty labels.
- Long option explanations: send as normal message context or `AskUserQuestion` descriptions, not as poll option labels.
- Multi-select: use `multiSelect: true` for `AskUserQuestion`; use `selectableCount > 1` for `send_poll`.

## Portability Layers

- Session prompt: `SessionManager.buildSystemPrompt()` injects decision-polling guidance into every agent provider session.
- MCP schema: `send_poll` advertises descriptions in `tools/list` so provider-native tool planners can see the usage contract.
- Runtime bridge: `AgentRuntime` intercepts `AskUserQuestion` in per-chat sessions and sends tracked WhatsApp polls.
- Sandbox diagnostics: provisioned workspaces install `deploy/hooks/poll-interaction-lint.mjs` as a fail-open `PostToolUse` hook that records poll-friction findings to `~/.claude/session-env/<session-id>/poll-interaction-lint.jsonl`.
- Project instructions: this runbook and `CLAUDE.md` provide portable guidance to agents that read project files rather than session prelude text.

## Portable Verification

Run `npm run guard:agent-decision-polls` after changing prompt text, `send_poll`, AskUser handling, workspace provisioning, hooks, or this runbook. The guard verifies the protocol is still represented across runtime prompts, MCP schemas, sandbox diagnostics, documentation, and release verification chains.

For release claims, also run the relevant targeted tests and `npm run guard:test-integrity`; a missing or skipped integrity scan is inconclusive, not clean.

## Known Limits

- `AskUserQuestion` poll correlation is per-chat only. Shared/global agent sessions fall through to their provider's native behavior.
- `send_poll` is not a blocking request/response protocol.
- Implicit prose-to-poll conversion is intentionally not part of this contract. It is too prone to false positives unless a future spec defines exact trigger syntax and verification gates.
