# Gemini CLI Persistent/ACP Session Investigation

Date: 2026-04-04
Workspace: `/home/q/LAB/WhatSoup`
Final tested version: `gemini 0.36.0`

## Scope

Investigated:

- `gemini --acp`
- default interactive `gemini` without `-p`
- whether piped stdin can be used with interactive mode
- whether ACP uses newline-delimited JSON over stdio for bidirectional turns

## Key Findings

1. `gemini --acp` is the only mode that behaves like a machine-oriented persistent subprocess over stdio.
2. ACP transport is newline-delimited JSON in both directions.
3. ACP supports bidirectional multi-turn sessions with:
   - request: `initialize`
   - request: `session/new`
   - request: `session/prompt`
   - notification: `session/update`
4. Default `gemini` without `-p` is a persistent interactive TTY UI, not a clean stdio protocol.
5. Piping stdin into plain `gemini` switches it into one-shot non-interactive behavior.
6. `gemini -i ...` with piped stdin is explicitly rejected.
7. In this environment, ACP stdout is not clean JSON-only output. Protocol frames are mixed with non-JSON startup/log lines, so a strict "every line is JSON" parser will break unless logs are suppressed or filtered.

## Evidence

### 1. CLI surface

Observed after auto-update:

- `gemini --help` still states: interactive by default, `-p/--prompt` for headless, `-i/--prompt-interactive`, and `--acp`.
- `gemini --version` ended at `0.36.0`.

Note: the first interactive launch auto-updated Gemini from `0.33.0` to `0.36.0`. Conclusions below are based on the post-update `0.36.0` behavior.

### 2. Interactive mode without `-p`

Running `gemini --screen-reader` under a PTY stayed resident and presented a live prompt:

- `> Type your message or @path/to/file`

Source confirms that when `config.isInteractive()` is true, Gemini starts the interactive UI and returns instead of reading stdin for one-shot execution:

- `bundle/gemini.js:14279`

### 3. Piped stdin does not keep plain Gemini interactive

Command:

```bash
printf 'What is 2+2?\n' | GEMINI_API_KEY="$GEMINI_API_KEY" gemini
```

Observed:

- returned `2 + 2 is 4.`
- exited immediately

Source confirms that non-TTY stdin is read only in the non-interactive path:

- `bundle/gemini.js:14290`

### 4. `-i/--prompt-interactive` rejects piped stdin

Command:

```bash
printf 'ignored stdin\n' | GEMINI_API_KEY="$GEMINI_API_KEY" gemini -i 'Say hello'
```

Observed:

- exit code `42`
- error: `The --prompt-interactive flag cannot be used when input is piped from stdin.`

Source:

- `bundle/gemini.js:14054`

### 5. ACP uses nd-JSON over stdio

Bundled source defines ACP stdio transport with explicit newline framing:

- `bundle/gemini.js:10788`
- each outgoing message is `JSON.stringify(message) + "\n"`
- incoming stream is split on `\n` and each non-empty line is `JSON.parse(...)`

Gemini wires ACP mode to that transport here:

- `bundle/gemini.js:12182`

ACP method names visible in the bundle:

- `initialize`
- `session/new`
- `session/prompt`
- `session/update`

See:

- `bundle/gemini.js:9896`
- `bundle/gemini.js:9911`

### 6. Live ACP handshake and multi-turn proof

Using a local Node harness with `stdio: ['pipe', 'pipe', 'pipe']`, I sent:

1. `initialize`
2. `session/new`
3. `session/prompt` with slash command `/memory list`

Observed responses included:

- initialize result with `protocolVersion: 1`
- session/new result with a `sessionId`
- async `session/update` notification with `available_commands_update`
- async `session/update` notification with `agent_message_chunk` for `/memory list`
- final `session/prompt` result with `stopReason: "end_turn"`

This proves ACP supports persistent bidirectional turns over stdio.

### 7. ACP stdout contamination

In the same plain-pipe ACP harness, stdout also emitted non-JSON lines such as:

- `Ignore file not found: /home/q/LAB/WhatSoup/.geminiignore, continue without it.`
- `Hook registry initialized with 0 hook entries`
- `Hook system initialized successfully`

So although ACP framing itself is newline-delimited JSON, Gemini stdout was not protocol-only in this environment.

## Recommendation

Use `gemini --acp` as the persistent subprocess.

Do not use plain interactive `gemini` for machine control unless you are intentionally driving a PTY UI.

Implementation guidance:

1. Spawn `gemini --acp` with pipes.
2. Send newline-delimited JSON-RPC requests on stdin.
3. Read stdout line-by-line.
4. Treat lines beginning with valid JSON objects as protocol frames.
5. Be prepared to ignore or separately log non-JSON stdout lines unless you find a reliable way to suppress them.
6. Maintain session state via `sessionId` returned from `session/new`.

## Minimal ACP shape

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/home/q/LAB/WhatSoup","mcpServers":[]}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<session-id>","prompt":[{"type":"text","text":"/memory list"}]}}
```

Expected async notifications:

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<session-id>","update":{...}}}
```

## Caveats

- A real model prompt through ACP returned `500` with `You have exhausted your daily quota on this model.` during testing.
- That quota issue did not block verification of the persistent ACP session mechanics because slash-command turns still exercised the `session/prompt` RPC and `session/update` notification flow.
