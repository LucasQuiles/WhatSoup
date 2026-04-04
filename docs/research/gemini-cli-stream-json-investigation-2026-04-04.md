# Gemini CLI Stream-JSON Investigation

Date: 2026-04-04

Environment:
- `gemini 0.33.0`
- `claude 2.1.91 (Claude Code)`
- Workspace: `/home/q/LAB/WhatSoup`

## Executive conclusion

Gemini CLI and Claude Code both emit newline-delimited JSON in streaming mode, but their event schemas are materially different. A shared parser is only realistic at the transport layer (`read one JSON object per line`). A schema-level shared parser would be brittle and should not be reused.

## Commands and key observations

### Gemini: successful headless stream-json

Command:

```bash
gemini --prompt 'What is 2+2? Reply in one word.' --output-format stream-json
```

Observed output:

```json
{"type":"init","timestamp":"2026-04-04T06:40:54.096Z","session_id":"85808b9c-967d-47d8-a23e-4e186c429d40","model":"auto-gemini-3"}
{"type":"message","timestamp":"2026-04-04T06:40:54.098Z","role":"user","content":"What is 2+2? Reply in one word."}
{"type":"message","timestamp":"2026-04-04T06:40:56.467Z","role":"assistant","content":"Four","delta":true}
{"type":"result","timestamp":"2026-04-04T06:40:57.044Z","status":"success","stats":{"total_tokens":12138,"input_tokens":11986,"output_tokens":51,"cached":0,"input":11986,"duration_ms":2948,"tool_calls":0}}
```

Observed event types on wire from successful run:
- `init`
- `message`
- `result`

Observed assistant chunks are emitted as repeated `message` events with `role:"assistant"` and `delta:true`.

### Gemini: tool events in stream-json

Command:

```bash
gemini --prompt 'Describe @/tmp/gemini-test.png in one word.' --output-format stream-json
```

Because `/tmp/gemini-test.png` was outside Gemini's allowed workspace, the `@path` reference was not injected and the model fell back to tool use. Observed additional event types:

- `tool_use`
- `tool_result`

Observed example:

```json
{"type":"tool_use","timestamp":"2026-04-04T06:44:02.536Z","tool_name":"read_file","tool_id":"7uaap32h","parameters":{"file_path":"/tmp/gemini-test.png"}}
{"type":"tool_result","timestamp":"2026-04-04T06:44:03.291Z","tool_id":"7uaap32h","status":"error","output":"Path not in workspace: Attempted path \"/tmp/gemini-test.png\" resolves outside the allowed workspace directories: /home/q/LAB/WhatSoup or the project temp directory: /home/q/.gemini/tmp/whatsoup","error":{"type":"invalid_tool_params","message":"Path not in workspace: Attempted path \"/tmp/gemini-test.png\" resolves outside the allowed workspace directories: /home/q/LAB/WhatSoup or the project temp directory: /home/q/.gemini/tmp/whatsoup"}}
```

### Gemini: declared stream-json vocabulary from source

Local source in `@google/gemini-cli-core/dist/src/output/types.js` declares:

- `init`
- `message`
- `tool_use`
- `tool_result`
- `error`
- `result`

Internal model events are different and are mapped into the stream envelope. `dist/src/core/turn.js` declares lower-level events such as:

- `content`
- `tool_call_request`
- `error`
- `loop_detected`
- `max_session_turns`
- `agent_execution_stopped`
- `agent_execution_blocked`

The non-interactive CLI maps those into the stream-json envelope in `dist/src/nonInteractiveCli.js`.

### Claude: stream-json requirements and observed output

Command without `--verbose` fails:

```bash
claude -p --output-format stream-json 'What is 2+2? Reply in one word.'
```

Error:

```text
Error: When using --print, --output-format=stream-json requires --verbose
```

Working command:

```bash
claude -p --verbose --output-format stream-json 'What is 2+2? Reply in one word.'
```

Observed event types in default environment:
- `system` with subtypes such as `hook_started`, `hook_response`, `hook_progress`, `init`
- `assistant`
- `rate_limit_event`
- `result`

Observed example tail:

```json
{"type":"assistant","message":{"model":"claude-opus-4-6","id":"msg_01UbhkNVnGJ6hP48yFYCUYgL","type":"message","role":"assistant","content":[{"type":"text","text":"Four."}]...},"session_id":"2bb01649-682c-4b25-b002-db5629d072f6","uuid":"720bc52e-1041-4c0f-b7f3-6d4b09749da6"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1775296800,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},"uuid":"9ec31d48-b096-4933-8d56-e93e199148bc","session_id":"2bb01649-682c-4b25-b002-db5629d072f6"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":4225,"duration_api_ms":2589,"num_turns":1,"result":"Four.","stop_reason":"end_turn","session_id":"2bb01649-682c-4b25-b002-db5629d072f6"...}
```

### Claude: bare mode control

Command:

```bash
claude -p --bare --verbose --output-format stream-json 'What is 2+2? Reply in one word.'
```

This still used Claude's own envelope:
- `system`
- `assistant`
- `result`

In this environment it failed authentication in bare mode (`Not logged in · Please run /login`), but the stream format still remained Claude-specific.

## Compatibility assessment

### Similarities

- Both are JSONL / NDJSON streams.
- Both carry a `session_id`.
- Both end with a `result` event.

### Material differences

- Gemini uses flat event records like `message`, `tool_use`, `tool_result`.
- Claude uses a different top-level vocabulary: `system`, `assistant`, `rate_limit_event`, `result`.
- Gemini assistant deltas are plain `message` events with `delta:true`.
- Claude assistant content is nested under `assistant.message.content[]`.
- Claude can emit large initialization payloads and hook lifecycle events before any answer content.
- Claude stream-json requires `--verbose`; Gemini does not.

### Recommendation

Do not share a schema-level parser.

Reasonable shared layer:
- NDJSON reader
- generic event dispatcher

Provider-specific layers should handle:
- event type vocabulary
- assistant content extraction
- tool event normalization
- result/error semantics
- session metadata

## Session lifecycle

### Gemini

Non-interactive runs are persisted and resumable.

Observed:

```bash
gemini --list-sessions
```

Output:

```text
Available sessions for this project (1):
  1. What is 2+2? Reply in one word. (Just now) [85808b9c-967d-47d8-a23e-4e186c429d40]
```

Resume worked and reused the same `session_id`:

```bash
gemini --resume latest --prompt 'What did you answer previously? Reply in one word.' --output-format stream-json
```

Observed `session_id` remained `85808b9c-967d-47d8-a23e-4e186c429d40`.

Persisted storage:
- Docs say `~/.gemini/tmp/<project_hash>/chats/`
- Local files observed at `~/.gemini/tmp/whatsoup/chats/session-*.json`

Observed persisted session file includes full message history and token counters:
- `~/.gemini/tmp/whatsoup/chats/session-2026-04-04T06-40-85808b9c.json`

### Claude

Resume also worked:

```bash
claude -p --resume 2bb01649-682c-4b25-b002-db5629d072f6 'What did you answer previously? Reply in one word.'
```

Output:

```text
Four.
```

Persisted storage observed:
- `~/.claude/projects/-home-q-LAB-WhatSoup/2bb01649-682c-4b25-b002-db5629d072f6.jsonl`

Important parser hazard on resumed Claude stream:
- some `system.hook_started` events used a transient `session_id`
- later `system.init`, `assistant`, and `result` used the original resumed `session_id`

So even within one Claude resumed run, `session_id` can be inconsistent across event classes in this environment.

## MCP configuration location and format

### Gemini

Docs state settings precedence includes:
- user: `~/.gemini/settings.json`
- project: `.gemini/settings.json`
- system: `/etc/gemini-cli/settings.json` on Linux

Gemini MCP config lives inside `settings.json` under top-level `mcpServers`.

Shape:

```json
{
  "mcpServers": {
    "serverName": {
      "command": "path/to/server",
      "args": ["--arg1", "value1"],
      "env": {
        "API_KEY": "$MY_API_TOKEN"
      },
      "cwd": "./server-directory",
      "timeout": 30000,
      "trust": false
    }
  }
}
```

Other supported transport keys include `url` and `httpUrl`, plus `headers`, `includeTools`, and `excludeTools`.

Local state at investigation time:
- `gemini mcp list` returned `No MCP servers configured.`
- local `~/.gemini/settings.json` contained no `mcpServers`

### Claude

In this environment the active global MCP registry is `~/.mcp.json` with top-level `mcpServers`.

Observed local file:

```json
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "/home/q/.local/bin/playwright-mcp",
      "args": []
    },
    "render": {
      "type": "http",
      "url": "https://mcp.render.com/sse",
      "headers": {
        "Authorization": "Bearer ..."
      }
    }
  }
}
```

Claude CLI also supports explicit overrides with:
- `--mcp-config <configs...>`
- `--strict-mcp-config`

## Media / image passing

### Gemini

Gemini supports prompt-level `@path` references. Local source shows `handleAtCommand()` preprocesses `@...` references before model execution and injects referenced file content into `processedQueryParts`.

For images, local source and tests show they become `inlineData` parts with MIME type and base64 payload.

Direct proof from persisted session file:
- `~/.gemini/tmp/whatsoup/chats/session-2026-04-04T06-44-9ff510af.json`

That file contains:

```json
{
  "text": "Describe @gemini-test.png in one word."
},
{
  "inlineData": {
    "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW0QAAAAASUVORK5CYII=",
    "mimeType": "image/png"
  }
}
```

Important caveats:
- paths outside Gemini's allowed workspace are not injected and may trigger tool use instead
- the workspace image probe hit an API-side `400 INVALID_ARGUMENT` (`Unable to process input image`) and then surfaced a terminal quota error in the final `result`

So the syntax is supported, but image success still depends on workspace access and backend acceptance.

### Claude

For the image test, Claude did not use prompt-level inline media injection. It attempted a `Read` tool call on `/tmp/gemini-test.png` and then stopped on permissions:

```json
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/gemini-test.png"}}]...}}
```

Then:

```text
I need permission to read that file. Could you grant access so I can view the image?
```

No equivalent Gemini-style prompt preprocessing was observed for Claude from CLI help or runtime behavior here.

## Bottom line

Gemini `stream-json` is not close enough to Claude `stream-json` to share one semantic parser.

Safe to share:
- line reader
- JSON decoder
- maybe a provider-independent internal event model after explicit normalization

Not safe to share directly:
- event name handling
- assistant chunk extraction
- tool event extraction
- result/error handling
- session lifecycle assumptions
