# Fallback Continuity and Headless Provider Integrity

**Date:** 2026-08-07

**Status:** Approved for implementation

## Problem

The affected agent's primary-provider failure correctly selected the configured OpenCode fallback, but the fallback process was terminated before it could answer. On the target macOS host, the non-interactive OpenCode launcher uses `script(1)` to obtain a pseudo-terminal and emits the literal prefix `^D` followed by two backspace bytes before the first JSONL record. The pseudo-terminal also merges OpenCode's `--print-logs` stderr diagnostics into stdout. The runtime treated both surfaces as malformed provider JSON and tore down the session after emitting partial text. GUI shells bypass the wrapper, so interactive tests did not exercise the launchd/SSH execution path.

The transition also exposed user-continuity defects. Fresh-session history is returned chronologically by `getRecentMessages` and then reversed, producing newest-first context. The active inbound message can also appear once in recent history and again as the explicit user turn. Provider-native session and tool state cannot be transferred between different providers, so the only portable handoff is a truthful, bounded application-context envelope plus durable turn and delivery evidence.

## Goals

- Accept the single, observed `script(1)` startup artifact at the OpenCode JSONL boundary without weakening malformed-stream handling.
- Prove that the configured fallback can complete a real headless JSONL turn with the service-visible credentials and command path.
- Preserve chronological recent history and include the active user request exactly once in a fresh-session handoff.
- Declare a replay successful only after the provider reaches a terminal result and the outbound reply reaches terminal WhatsApp delivery evidence.
- Provide fleet-usable checks that distinguish GUI, SSH, and launchd-like environments.
- Keep operational OpenCode prompts out of same-host process arguments.
- Apply a recoverable host repair, replay the unanswered admin request, and retain verification receipts.

## Non-goals

- Transfer opaque provider-native session state or tool state across vendors.
- Ignore arbitrary garbage, terminal control sequences, or malformed JSONL.
- Treat credential-file presence, CLI help output, or a zero exit code alone as a successful model canary.
- Automatically mutate every fleet host in this change. The repository change supplies the portable implementation and rollout checks; host promotion remains an observed operation.

## Design

### 1. Bounded JSONL normalization

The OpenCode parser will recognize only the exact observed prefix, `^D\b\b`, and only before a JSON object on the first non-blank record handled after parser creation or reset. It will remove that prefix before `JSON.parse`. At the session boundary, the existing closed OpenCode diagnostic grammar (`timestamp=... level=TRACE|DEBUG|INFO|WARN|ERROR`) is also recognized on PTY-merged stdout, with or without the exact startup prefix, and treated as watchdog liveness rather than provider JSON. All other malformed input remains a `parse_error`.

This keeps stream integrity fail-closed while accommodating the known pseudo-terminal startup artifact. Parser reset also resets eligibility for first-record normalization.

### 2. Functional headless canary

The daily provider inventory will retain compatibility and credential-presence checks and add an opt-in OpenCode functional probe. The probe uses the runtime's effective fallback model and inherited provider settings, including the selected execution profile and auto-approval flag, while excluding the primary endpoint route. It invokes modern-run JSON mode with `--print-logs --log-level INFO`, supplies the fixed canary through stdin, and gives the child only system essentials plus the selected model credential. It captures stdout/stderr without printing secrets, accepts only the closed diagnostic grammar outside JSONL, and requires the ordered record sequence `step_start` → exact combined text `OK` → terminal `step_finish(reason=stop)`, with no later provider event.

On macOS, the probe requires the generated instance LaunchAgent PATH to equal
the currently loaded `launchctl` environment and resolves the provider binary
only through the launcher's effective ordered PATH. The launcher and health
checker share `deploy/lib/runtime-path.sh`, so the `$HOME/.local/bin` and pinned
Node prefixes applied after launchd start are part of the canary's binary
selection too. Explicit health-only command overrides cannot select a
different binary. Every compatibility and functional subprocess
receives the same positive environment allowlist and runs from the configured
agent cwd (or `HOME`, matching the runtime when cwd is absent). Modern
`fallbacks[]` entries are probed individually in order with runtime model and
custom credential-service precedence. Credential resolution mirrors the
runtime registry and lookup order, including OpenCode's auth store as the
terminal fallback. WhatSoup key files and OpenCode auth files are read with
bounded, no-symlink, current-user/private-file checks before a value can be
projected into the child environment. A sandbox-per-chat or dynamic egress
configuration that the standalone canary cannot reproduce fails closed instead
of producing false-green provider evidence.

Any malformed first record—including the observed PTY artifact—fails with a distinct stream-integrity classification. A timeout or missing terminal record is inconclusive/failing, never success. Dry-run inputs provide deterministic test fixtures. Fleet profiles may enable this probe before a host is declared fallback-ready.

### 3. Context envelope

Fresh fallback sessions receive one provider-boundary input with:

- `applicationContext`: recent messages in chronological order, redacted and formatted by the existing context formatter;
- `userText`: the current inbound request exactly as accepted by the durable turn path.

The context assembler removes the current inbound record when its normalized content, sender, and newest position identify it as the active turn. It does not globally collapse legitimate repeated messages. The explicit user turn remains the authoritative request.

The handoff notice will not claim that provider-native context transferred. It can claim only that bounded recent chat context and the pending user request were supplied.

### 4. Replay completion contract

The operational replay follows this state sequence:

1. Resolve the admin identity and destination.
2. Record the last inbound sequence and outbound operation state.
3. Inject the authorized replay through the admin-side transport or a documented inbound recovery surface—not as an outbound agent message.
4. Observe fallback selection and a terminal provider result.
5. Observe the complete response persisted as outbound messages.
6. Observe terminal WhatsApp echo/delivery state for every response operation.
7. Only then report the replay as answered.

If the provider exits, the process restarts, or delivery remains non-terminal, the replay stays open and is not described as successful.

### 5. Host rollout and receipts

The target host receives a backed-up, minimal wrapper repair only after the repository tests define the accepted stream behavior. Validation runs in three surfaces: direct non-interactive SSH, a launchd-like minimal environment, and an interactive/PTY invocation when available. Credential values are never printed.

The portable repository change is committed on an isolated branch, verified with focused suites and repository gates, pushed over the SSH Git remote, and promoted through the repository's required branch workflow. The original dirty main worktree and its untracked files remain untouched.

### 6. Operational prompt privacy

OpenCode accepts its run message from non-TTY stdin when no positional message
is supplied. WhatSoup therefore keeps operational system instructions,
application context, and user text out of argv, writes the composed turn to the
child's stdin once, and closes the stream. This preserves the existing JSONL
stdout/stderr contract while removing chat content from routine same-user
process inspection. The bounded model-usability probe remains separate because
its fixed prompt contains no user or instance context.

The fleet functional canary follows the same stdin contract, making a
PATH-shadowing wrapper that drops stdin a pre-traffic failure instead of a
version-only pass. OpenCode's generated configuration also denies the
current-chat `whatsoup_send_message` tool globally and on the selected headless
agent, where agent permissions otherwise take precedence. Assistant text is
the live turn's single delivery owner. The OpenCode prompt requires bounded
work to finish in the owned turn and leaves interrupted-turn recovery to the
durable runtime.

## Failure handling

- Unknown control prefixes remain fatal parser errors.
- A functional canary with masked, missing, truncated, or non-terminal output is not clean evidence.
- Context assembly failure falls back to the pure user turn and logs the loss; it never blocks the user's request.
- A live replay is never attempted until the sending identity is proven, because sending from the agent line would reverse the message direction.
- Live wrapper replacement is recoverable from its timestamped backup.
- A fallback answer plus a current-chat send tool call is not a clean single response; the terminal echo and every same-turn outbound operation are inspected separately.

## Verification

- Parser unit tests cover exact first-record normalization, reset behavior, and fail-closed later/unknown corruption.
- Health-check tests cover valid ordered JSONL, exact canary text, terminal-last enforcement, recognized PTY-merged diagnostics, PTY-corrupted JSONL, timeout, runtime-inherited fallback settings, exact instance and wrapper-effective PATH/cwd use (including a `$HOME/.local/bin` collision), full credential-registry parity, OpenCode auth-store fallback, private-file refusal, positive credential allowlisting, and credential-missing behavior.
- Session tests prove PTY-merged diagnostic stdout advances watchdog liveness without becoming a provider event.
- Runtime tests prove chronological context and single occurrence of the current user request.
- Session tests prove operational context and user text are absent from OpenCode argv and written to stdin in order.
- Config tests prove the OpenCode current-chat text-send deny survives scalar, sibling, and stale-allow permission shapes.
- Focused test files, TypeScript checks, publication/repository guards, and the branch push gate run before promotion.
- Host canaries capture exit status and structural JSONL evidence on each execution surface.
- Replay verification captures the new inbound sequence, fallback session/provider terminal state, complete outbound text, and terminal echo/delivery rows.
