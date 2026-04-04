# OpenCode Persistent Session Investigation

Date: 2026-04-04
Environment: `/home/q/LAB/WhatSoup`
Local version: `opencode 1.3.13`

## Conclusion

OpenCode can be used as a persistent agent in two practical ways:

1. Run a long-lived headless server with `opencode serve --hostname 127.0.0.1 --port 4096`.
2. Send turns either:
   - directly over HTTP (`POST /session`, `POST /session/:id/message`), or
   - through the CLI attached to that server (`opencode run --attach http://127.0.0.1:4096 ...`).

Persistent state is real:

- `--session <id>` resumes a specific session.
- `--continue` resumes the most recent session and preserved prior context in testing.
- Session data survived a full `serve` restart and remained visible via both HTTP and `opencode session list`.

## Local CLI Surface

Observed from `opencode --help` and `opencode run --help`:

- Top-level commands include `attach`, `serve`, `web`, `session`, and `run`.
- `opencode run --help` includes:
  - `--attach`
  - `--port`
  - `--session`
  - `--continue`
  - `--fork`
  - `--format json`
- `opencode attach --help` also supports `--session`, `--continue`, `--fork`, and `--password`.
- `opencode serve --help` exposes `--port`, `--hostname`, `--mdns`, and `--cors`.

## HTTP Server Test

Started server:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Verified health:

```json
{"healthy":true,"version":"1.3.13"}
```

Created a session:

```bash
curl -X POST http://127.0.0.1:4096/session \
  -H 'content-type: application/json' \
  -d '{"title":"persistent-session-investigation"}'
```

Observed session ID:

```text
ses_2a8306bf7ffePnTLmtzfrX8wAx
```

Sent turns over HTTP without requiring an assistant reply:

```bash
curl -X POST http://127.0.0.1:4096/session/ses_2a8306bf7ffePnTLmtzfrX8wAx/message \
  -H 'content-type: application/json' \
  -d '{"noReply":true,"parts":[{"type":"text","text":"first api turn"}]}'
```

Returned persisted user message:

```json
{
  "info": {
    "role": "user",
    "sessionID": "ses_2a8306bf7ffePnTLmtzfrX8wAx"
  },
  "parts": [
    {
      "type": "text",
      "text": "first api turn"
    }
  ]
}
```

Confirmed per-message model selection is accepted on the HTTP API:

```bash
curl -X POST http://127.0.0.1:4096/session/ses_2a8306bf7ffePnTLmtzfrX8wAx/message \
  -H 'content-type: application/json' \
  -d '{"noReply":true,"model":{"providerID":"opencode","modelID":"qwen3.6-plus-free"},"parts":[{"type":"text","text":"second api turn with explicit model"}]}'
```

Returned stored model:

```json
{
  "info": {
    "model": {
      "providerID": "opencode",
      "modelID": "qwen3.6-plus-free"
    }
  }
}
```

## Attach and Continue Tests

Used the existing server-backed session with CLI attach mode:

```bash
opencode run \
  --attach http://127.0.0.1:4096 \
  --session ses_2a8306bf7ffePnTLmtzfrX8wAx \
  --model opencode/qwen3.6-plus-free \
  --format json \
  "How many user messages are already in this session before this one? Reply with only the number."
```

Observed assistant reply:

```json
{"type":"text","part":{"text":"2"}}
```

Then resumed with `--continue`:

```bash
opencode run \
  --attach http://127.0.0.1:4096 \
  --continue \
  --model opencode/qwen3.6-plus-free \
  --format json \
  "What number did you answer in the previous assistant reply? Reply with only that number."
```

Observed assistant reply:

```json
{"type":"text","part":{"text":"2"}}
```

This confirms `--continue` preserved state from the prior attached session.

## Persistence Across Restart

After stopping `opencode serve` and starting it again on the same port, the same session ID was still returned by:

```bash
curl http://127.0.0.1:4096/session
opencode session list --format json
```

This indicates sessions are persisted on disk rather than only in server memory.

## Documentation Cross-Check

Official docs used:

- CLI docs: https://opencode.ai/docs/cli/
- Server docs: https://opencode.ai/docs/server/

Docs confirm:

- `opencode serve` is a headless HTTP server.
- `opencode run --attach http://localhost:4096 ...` is a supported reuse pattern.
- Server APIs include session and message endpoints such as:
  - `POST /session`
  - `POST /session/:id/message`
  - `GET /session`
  - `GET /event`

## Notable Discrepancies

1. Docs describe `GET /doc` as an HTML OpenAPI page, but this local 1.3.13 server returned JSON and only exposed 8 global/auth paths in the live spec, not the full session/message surface documented on the website.
2. Docs use `localhost:4096` in examples, but local CLI help reports a default `--port` of `0`. If the team needs a stable attach target, pass `--port` explicitly.

## Recommendation

For a persistent agent process:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Then choose one client mode:

- HTTP automation:
  - create or resume sessions with `/session`
  - send turns with `/session/:id/message`
- CLI automation:
  - target a specific session with `opencode run --attach http://127.0.0.1:4096 --session <id> ...`
  - resume the most recent one with `opencode run --attach http://127.0.0.1:4096 --continue ...`

If this is going into production or orchestration scripts, set `OPENCODE_SERVER_PASSWORD` before starting the server because the default server is unsecured.
