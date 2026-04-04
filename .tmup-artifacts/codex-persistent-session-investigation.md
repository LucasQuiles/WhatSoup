# Codex Persistent Session Investigation

Date: 2026-04-04
Workspace: `/home/q/LAB/WhatSoup`
Installed wrapper package: `@openai/codex` 0.87.0
Observed native binary version from runtime: `v0.118.0`

## Question

What is the correct way to run Codex as a persistent subprocess with multiple turns, comparable to Claude Code's stream-json mode?

## Short Answer

Use `codex app-server`, not plain `codex`.

- `codex` without a subcommand is an interactive TUI. It rejects piped stdin in non-TTY mode.
- `codex app-server` exposes a persistent JSON-RPC protocol over `stdio://` by default and can also listen on `ws://IP:PORT`.
- A single long-lived `codex app-server` subprocess can hold one connection, create or resume a thread, and run multiple turns on that thread.

## Evidence

### 1. Plain interactive CLI is not pipe-friendly

Command:

```bash
printf 'hello\n' | codex
```

Observed:

```text
Error: stdin is not a terminal
```

Same result with:

```bash
printf 'hello\nworld\n' | codex --no-alt-screen
```

This means the regular interactive CLI does not support a machine-friendly stdin pipe protocol.

### 2. Interactive CLI does accept terminal input when attached to a PTY

Running `codex --no-alt-screen` inside a PTY produced the normal TUI and accepted typed input.

Observed UI fragments included:

```text
OpenAI Codex (v0.118.0)
model: gpt-5.4 xhigh
directory: ~/LAB/WhatSoup
› hello
```

This confirms the TUI reads terminal input, but it is a screen-oriented interface with terminal escape sequences, not a stable automation protocol.

### 3. `app-server` advertises persistent transports

`codex app-server --help` shows:

- `--listen <URL>`
- supported values: `stdio://` (default), `ws://IP:PORT`
- websocket auth flags for non-loopback listeners:
  - `--ws-auth`
  - `--ws-token-file`
  - `--ws-shared-secret-file`
  - `--ws-issuer`
  - `--ws-audience`

Also `codex --help` shows:

- `--remote <ADDR>`: connect TUI to a remote app-server websocket endpoint
- `resume` and `fork` commands for interactive sessions

### 4. `app-server` protocol is raw JSON-RPC over stdio, not `Content-Length` framed

Generated protocol artifacts:

```bash
codex app-server generate-json-schema --out /tmp/codex-app-schema
codex app-server generate-ts --out /tmp/codex-app-ts
```

The generated types include:

- `ClientRequest`
- `ServerRequest`
- `ServerNotification`
- `JSONRPCRequest`
- `JSONRPCResponse`

The request/notification surface includes:

- `initialize`
- `thread/start`
- `thread/resume`
- `thread/fork`
- `turn/start`
- `turn/steer`
- `turn/interrupt`

Live framing test results:

- Sending a raw JSON object followed by `\n` worked.
- Sending an LSP-style `Content-Length: ...` envelope failed with:

```text
Failed to deserialize JSONRPCMessage: expected value at line 1 column 1
```

So the stdio transport expects raw JSON-RPC messages directly on the stream. Newline-delimited JSON worked in practice.

### 5. One `app-server` subprocess handled multiple requests and multiple turns

Single-process test sequence:

1. Start `codex app-server --listen stdio://`
2. Send `initialize`
3. Send `thread/start`
4. Send first `turn/start` with prompt: remember `BANANA`, reply `READY`
5. Wait for completion
6. Send second `turn/start` on the same `threadId`
7. Ask for the remembered token

Observed results on the same connection:

- first turn final text: `READY`
- second turn final text: `BANANA`

This confirms both:

- the subprocess remains usable across multiple requests
- thread state persists across turns on that same app-server connection

## Relevant Protocol Details

From generated TypeScript:

- `ThreadStartParams` creates a thread and includes `ephemeral`, `experimentalRawEvents`, and `persistExtendedHistory`
- `ThreadResumeParams` can resume by `threadId`, `history`, or `path`
- `TurnStartParams` takes `threadId` and `input`
- `TurnSteerParams` takes `threadId`, `expectedTurnId`, and new `input`
- `TurnInterruptParams` takes `threadId` and `turnId`

Server notifications include:

- `thread/started`
- `thread/status/changed`
- `turn/started`
- `item/agentMessage/delta`
- `turn/completed`

Server-initiated requests include approval and user-input callbacks such as:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`

Implication: an unattended client should either:

- set policies that avoid interactive approvals, or
- implement responses for those server requests.

## Conclusion

For a persistent Codex agent process, the closest equivalent to Claude Code's stream-json mode is:

```bash
codex app-server --listen stdio://
```

or a websocket listener via:

```bash
codex app-server --listen ws://127.0.0.1:PORT
```

Do not try to automate plain `codex` by piping stdin. It is TTY-only and intended for human terminal interaction.
