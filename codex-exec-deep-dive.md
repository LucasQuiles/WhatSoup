# Codex CLI `exec` Mode Deep Dive

Date: 2026-04-04
Installed CLI: `codex-cli 0.118.0`
Upstream tag inspected: `openai/codex` `rust-v0.118.0`

## Scope

Investigated:

1. Whether `codex exec` can accept multiple conversational turns on one stdin stream.
2. How `codex exec resume <id>` behaves.
3. What happens to MCP connections across resume.
4. Whether a second stdin message can be sent after the first `exec` turn completes.
5. How context-window limits are handled in exec mode.

## Executive Summary

- `codex exec` is one prompt -> one turn -> one process exit.
- stdin is read as a single blob with `read_to_end`, so it is not a streaming multi-turn channel.
- If a prompt argument is present and stdin is also piped, stdin is appended once inside a `<stdin>...</stdin>` block.
- `codex exec resume <id> "<prompt>"` resumes stored thread history, then starts exactly one new turn with the new prompt.
- `codex exec resume <id>` without a new prompt does not just "re-open" the session; it errors because exec still expects prompt input.
- MCP connections are not preserved across separate `codex exec` processes. A resumed exec reconstructs thread history and initializes a fresh MCP connection manager from config.
- Context-window handling in exec mode is inherited from the shared core session code: pre-turn auto-compaction runs when token usage crosses the model's auto-compact limit, compaction can trim oldest history items if the compact request itself overflows, and hard context-window overflow sets total token usage to the effective model window and emits an error.

## Live Behavior

### Experiment 1: normal `exec` JSONL run

Command:

```bash
codex exec --json --dangerously-bypass-approvals-and-sandbox \
  "Reply with exactly TURN1_OK and nothing else."
```

Observed JSONL:

```json
{"type":"thread.started","thread_id":"019d573b-2af8-7412-8d94-fa7eb9be8ea6"}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"TURN1_OK"}}
{"type":"turn.completed","usage":{"input_tokens":39198,"cached_input_tokens":29824,"output_tokens":614}}
```

Result: one thread bootstrap, one turn, one completion.

### Experiment 2: stdin-only exec blocks until EOF

Command:

```bash
codex exec --json --dangerously-bypass-approvals-and-sandbox -
```

Observed:

- Sent `Reply with exactly STDIN_EOF_OK and nothing else.\n`
- Waited 5 seconds
- No JSONL output yet
- Sent terminal EOF (`Ctrl-D`)
- Only then did `thread.started` and `turn.started` appear
- Final assistant output was `STDIN_EOF_OK`

Result: stdin is buffered until EOF, not consumed message-by-message.

### Experiment 3: second stdin after completion

TTY-backed run:

```bash
codex exec --json --dangerously-bypass-approvals-and-sandbox \
  "Reply with exactly TTY1_OK and nothing else."
```

Observed completion:

```json
{"type":"item.completed","item":{"type":"agent_message","text":"TTY1_OK"}}
{"type":"turn.completed","usage":{"input_tokens":18834,"cached_input_tokens":6528,"output_tokens":87}}
```

After completion, attempted to write a second stdin message into the same process.

Observed tool error:

```text
write_stdin failed: Unknown process id 87982
```

Result: after the first turn completes, the `codex exec` process has already exited. There is no open stdin channel to send a second turn.

### Experiment 4: `exec resume` continuity

First run:

```bash
codex exec --json --dangerously-bypass-approvals-and-sandbox \
  "Remember this exact secret for the next turn: ZETA-42-BLUE. Reply exactly ACK."
```

Observed:

- thread id: `019d573c-a190-70b3-8180-d865388dd788`
- final message: `ACK`

Resume run:

```bash
codex exec resume --json --dangerously-bypass-approvals-and-sandbox \
  019d573c-a190-70b3-8180-d865388dd788 \
  "What secret did I ask you to remember? Reply exactly with the secret."
```

Observed JSONL:

```json
{"type":"thread.started","thread_id":"019d573c-a190-70b3-8180-d865388dd788"}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"ZETA-42-BLUE"}}
{"type":"turn.completed","usage":{"input_tokens":37785,"cached_input_tokens":29440,"output_tokens":137}}
```

Result: `exec resume` reuses the same thread id and prior history, but still only runs one new turn for the new prompt.

### Experiment 5: `exec resume` without a new prompt

Command:

```bash
codex exec resume --json --dangerously-bypass-approvals-and-sandbox \
  019d573c-a190-70b3-8180-d865388dd788
```

Observed stderr:

```text
Reading prompt from stdin...
No prompt provided via stdin.
```

Result: `codex exec resume <id>` expects a prompt argument or stdin. It does not just "attach" and wait for later input.

## Source-Level Findings

### stdin behavior

- `exec` CLI prompt docs say stdin is read when no prompt is provided, and appended as `<stdin>` when both prompt and piped stdin are present.
- `read_prompt_from_stdin()` uses `std::io::stdin().read_to_end(&mut bytes)`, which proves stdin is consumed as one whole blob.
- `resolve_root_prompt()` wraps appended stdin into `<stdin>...</stdin>`.

### exec lifecycle

- `run_exec_session()` starts an in-process app-server client.
- It resolves either `thread/start` or `thread/resume`.
- It then issues exactly one `turn/start`.
- On completion it requests `thread/unsubscribe`, then `client.shutdown()`, then exits.

### resume semantics

- `codex exec resume` first resolves a thread id through `thread/list` or accepts a UUID directly.
- It sends `thread/resume`.
- It then still builds prompt items and sends a fresh `turn/start`.
- In the app-server, `thread_resume()` either reattaches to a running thread in the same server process or reconstructs history from rollout / supplied history and spawns a resumed thread.
- `resume_thread_with_history()` just calls `spawn_thread(...)` with prior history.

### MCP across resume

- Session initialization computes effective MCP servers and auth state.
- It creates a new `McpConnectionManager::new(...)` during session init.
- Because `codex exec` always starts a fresh in-process app-server client and shuts it down on exit, separate `exec` processes do not share live MCP connections.
- A resume in a new `exec` process therefore rebuilds MCP connections from config while restoring thread history from rollout.
- The only case where MCP/runtime state is reused is an app-server-local `thread/resume` against an already running thread inside the same server process.

### context window behavior

- Model config overrides can set `model_context_window` and `model_auto_compact_token_limit`.
- Effective context window is `context_window * effective_context_window_percent / 100`; default fallback metadata uses `272000` and `95%`.
- Before a regular turn, `run_pre_sampling_compact()` checks total token usage against the model's auto-compact limit and triggers compaction when exceeded.
- During compaction, if compaction itself hits `ContextWindowExceeded` and there is more than one history item, the oldest item is removed and compaction retries.
- When the session sets total tokens "full", it sets total token usage to the effective model context window and emits token count state.

## Conclusions

- Question 1: you cannot stream multiple conversational messages into one `codex exec` instance over stdin. stdin is single-shot input, fully read to EOF, then one turn runs.
- Question 2: `codex exec resume <id> "<prompt>"` resumes the stored thread and immediately appends one fresh prompt as a new turn. It is not an interactive continuation channel. Without a prompt, it errors.
- Question 3: MCP connections do not survive across separate `exec` processes. Resume restores thread history, not the prior process's live MCP sockets / runtime.
- Question 4: after the first turn completes, the process exits. Attempting to send a second stdin message fails because there is no process left.
- Question 5: exec mode uses the normal Codex session context-window machinery: effective window calculation, token counting, pre-turn auto-compaction, overflow trimming during compaction, and hard context-window error signaling when the request still cannot fit.

## Primary Source Files

- `openai/codex` `rust-v0.118.0`
- `codex-rs/exec/src/cli.rs`
- `codex-rs/exec/src/lib.rs`
- `codex-rs/app-server/src/codex_message_processor.rs`
- `codex-rs/core/src/thread_manager.rs`
- `codex-rs/core/src/codex.rs`
- `codex-rs/core/src/compact.rs`
- `codex-rs/core/src/models_manager/model_info.rs`
