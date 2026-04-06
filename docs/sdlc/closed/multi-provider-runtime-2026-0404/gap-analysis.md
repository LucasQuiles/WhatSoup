# Multi-Provider Gap Analysis

## Provider Capability Matrix

| Capability | Claude Code | Codex CLI | Gemini CLI | OpenCode | Aider | API (OpenAI/Anthropic/Local) |
|---|---|---|---|---|---|---|
| **Non-interactive piped I/O** | Yes (stream-json) | Yes (--json) | Yes (--output-format stream-json) | Yes (--format json, ACP) | Unreliable | N/A (HTTP) |
| **Session resume** | --resume \<id\> | resume \<id\>, --last | --resume | /sessions, /resume | None | We manage state |
| **Sandbox/perms** | --permission-mode | --sandbox + -a flags | --yolo (auto-approve) | permissions config | N/A | N/A |
| **Full bypass** | bypassPermissions | --dangerously-bypass-approvals-and-sandbox | --yolo | permissions.bash: allow all | N/A | N/A |
| **MCP support** | .mcp.json in cwd | .mcp.json + codex mcp add | gemini mcp | mcp config in opencode.json | No native MCP | We call tools directly |
| **System prompt** | --system-prompt flag | Personality + config.toml | Extensions config | Agent prompt files | Convention files | system message in API |
| **Model selection** | --model | -m / --model | -m / --model | Config file only | --model | API parameter |
| **Plugins/skills** | --plugin-dir | Skills in ~/.codex/skills/ | Extensions | Agents/rules | No | N/A |
| **Working directory** | cwd of subprocess | -C / --cd | cwd of subprocess | cwd of subprocess | cwd | N/A |
| **Tool calling** | Internal (file/shell/MCP) | Internal (shell/file/MCP/web) | Internal (shell/file/MCP) | Internal (file/shell/MCP) | File edit only | We implement loop |
| **Web search** | Via MCP/plugins | --search flag | Built-in | Via MCP | No | Depends on model |
| **Media/images** | File paths | -i/--image flag | Unknown | Unknown | No | base64 in API |
| **Token reporting** | result event | turn.completed usage | Unknown | Unknown | No | API response |
| **Context compaction** | compact_boundary event | Auto (no event?) | Auto | Auto (configurable) | No | We manage context |
| **Transcript storage** | ~/.claude/projects/ | ~/.codex/sessions/ | ~/.gemini/ | ~/.opencode/ | No | We store |

## Streaming Format Comparison

### Claude Code stream-json
```
{"type":"system","subtype":"init","session_id":"..."}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"...","name":"Read","input":{}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}}
{"type":"result","usage":{"input_tokens":N,"output_tokens":N}}
{"type":"system","subtype":"compact_boundary"}
```

### Codex CLI --json
```
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_N","type":"command_execution","command":"...","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_N","type":"agent_message","text":"..."}}
{"type":"item.completed","item":{"id":"item_N","type":"command_execution","aggregated_output":"...","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_N","type":"file_change","changes":[{"path":"...","kind":"add"}],"status":"completed"}}
{"type":"item.completed","item":{"id":"item_N","type":"mcp_tool_call","server":"...","tool":"...","result":{...},"status":"completed"}}
{"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
{"type":"turn.failed","error":{"message":"..."}}
```

### Gemini CLI stream-json
Likely similar structure to Claude (uses same `--output-format stream-json` flag name) — needs verification.

### OpenCode --format json
```
{"type":"step_start","sessionID":"...","timestamp":"..."}
{"type":"tool_use","status":"running|completed|error","input":{},"output":"..."}
{"type":"text","content":"..."}
{"type":"error","type":"...","message":"..."}
{"type":"message.part.updated","type":"thinking|reasoning|tool"}
```

## Critical Gaps in Current Spec

### Gap 1: Provider Lifecycle Contract
**Missing:** The provider interface needs to abstract these lifecycle events:
- `onInit(sessionId)` — provider started, here's the session identifier
- `onText(text)` — agent produced text output
- `onToolStart(name, id, input)` — tool execution began
- `onToolEnd(id, output, isError)` — tool execution finished
- `onTurnComplete(tokens?)` — turn finished, optional token usage
- `onCompaction()` — context was compacted (optional, not all providers emit this)
- `onError(message)` — provider-level error

Currently the spec only has `AgentEvent` union — the provider must produce these. But the **input contract** is also missing: how do we send messages TO each provider?

### Gap 2: Input Protocol Differences
**Missing bead.** Each provider accepts input differently:
- Claude: JSONL on stdin `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
- Codex: Command-line argument to `codex exec`, or stdin pipe (not JSONL — raw text)
- Gemini: `-p "prompt"` flag for non-interactive
- OpenCode: `opencode run "prompt"` or stdin
- API: HTTP POST request body

The current session.ts `sendTurn()` writes Claude-specific JSONL to stdin. This must be abstracted.

### Gap 3: Per-Provider Spawn Configuration
**Partially covered by B03 but needs expansion.** Provider-specific spawn config:

| Provider | Binary | Critical Flags | Env Vars |
|---|---|---|---|
| Claude | `claude` | --input-format stream-json --output-format stream-json --permission-mode bypassPermissions --system-prompt | None required |
| Codex | `codex` | exec --json --dangerously-bypass-approvals-and-sandbox -m MODEL -C CWD | OPENAI_API_KEY |
| Gemini | `gemini` | -p --output-format stream-json --yolo -m MODEL | GEMINI_API_KEY |
| OpenCode | `opencode` | run --format json | Provider-specific API keys |

**User requirement:** "Codex agents spawned from our session should generally mirror our access, permissions, etc." — This means the bypass/full-auto flags are mandatory, and MCP servers from the parent session should be inherited.

### Gap 4: Resume Semantics Per Provider
**Not addressed.** Each provider has fundamentally different resume:
- Claude: `--resume <sessionId>` flag, detects failure by exit code 1 without init event
- Codex: `codex exec resume <sessionId>` subcommand, or `codex resume --last`
- Gemini: `--resume` flag
- OpenCode: `/sessions` interactive command (not suitable for non-interactive)
- API: We manage conversation history ourselves

The provider interface needs: `supportsResume(): boolean` and `buildResumeArgs(sessionId): string[]`

### Gap 5: MCP Server Inheritance
**Not addressed.** User wants providers to inherit parent session's MCP access:
- Claude: Write `.mcp.json` to working directory (current behavior)
- Codex: Write `.mcp.json` to working directory (same format? needs verification) OR use `codex mcp add`
- Gemini: Different MCP config mechanism
- OpenCode: `opencode.json` with `mcp` section
- API: We expose tools directly via function calling — no MCP config file needed

The MCP bridge (B07) needs provider-specific config file generation, not just Claude's `.mcp.json`.

### Gap 6: Workspace/Sandbox Per Provider
**Not addressed.** Per-chat sandbox isolation currently relies on Claude's `.claude/` directory:
- `settings.json` — Claude-specific
- `sandbox-policy.json` — Claude-specific
- `CLAUDE.md` symlink — Claude-specific

Other providers need equivalent workspace setup:
- Codex: `~/.codex/config.toml` profiles, `--sandbox workspace-write --add-dir <path>`
- Gemini: Extensions config
- OpenCode: `opencode.json` permissions section

### Gap 7: Media Passthrough Format
**Not addressed.** Different providers accept media differently:
- Claude: File path in text `[Image: /path/to/file.png]`
- Codex: `--image /path/to/file.png` flag (repeatable) — BUT only on initial exec, not mid-conversation
- Gemini: Unknown
- API: base64-encoded in content array `{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}`

Mid-conversation image handling is problematic for CLI providers that only accept images as startup flags.

### Gap 8: System Prompt Template System
**Not addressed.** Current system prompt hardcodes "Claude Code agent running over WhatsApp" and "bypassPermissions mode." Each provider needs:
- Provider-appropriate identity/capability description
- Provider-appropriate permission model reference
- Working directory context
- Custom instructions file support (all providers can use this)

### Gap 9: Watchdog Timer Parameterization
**Not addressed.** Current timers (10m soft, 20m warn, 30m hard) are calibrated for Claude Code. Other providers may be faster or slower:
- API providers: Much faster responses, shorter timeouts appropriate
- Local LLMs: Potentially slower, longer timeouts needed
- Codex: Similar to Claude, comparable timeouts

Provider config should include optional watchdog overrides.

### Gap 10: Tool Update Display Mapping
**Not addressed.** The outbound queue shows tool activity to users. Current mapping is Claude-specific:
- `buildToolUpdate(toolName, toolInput)` formats Claude tool names (Read, Write, Bash, etc.)
- Codex uses different tool names: `command_execution`, `file_change`, `mcp_tool_call`
- API providers: function names from our MCP registry

The display layer needs a provider-specific tool name → user-friendly name mapping.

### Gap 11: Concurrent Turn Handling
**Not addressed as provider-specific.** Claude Code accepts multiple stdin writes and queues them internally. Other providers may not:
- Codex `exec`: One prompt per invocation (no mid-conversation stdin)
- Gemini `-p`: One prompt per invocation
- API: We control the loop, so we control queuing

For CLI providers that don't support mid-conversation stdin, we need a "spawn-per-turn" strategy vs "persistent session" strategy.

### Gap 12: Authentication Per Provider
**Not addressed.** Each provider needs different credentials:
- Claude: Anthropic API key (auto-configured)
- Codex: OpenAI API key or ChatGPT auth
- Gemini: Google AI API key
- OpenCode: Depends on configured provider
- API direct: API key from GNOME Keyring via `secret-tool lookup service <name>`

Provider config needs `apiKeyService` field mapping to keyring service names.

## Revised Bead Recommendations

### New beads needed:
- **B08-input-protocol** — Abstract how messages are sent TO providers (stdin JSONL vs spawn-per-turn vs HTTP)
- **B09-workspace-isolation** — Abstract per-chat sandbox setup across providers
- **B10-system-prompt-templates** — Provider-specific prompt templates
- **B11-media-bridge** — Provider-specific media passthrough (file paths vs flags vs base64)

### Beads that need scope expansion:
- **B01** — Provider interface must include input protocol, resume contract, media handling, watchdog config
- **B03** — Config schema needs auth, watchdog overrides, provider-specific flags
- **B04** — Codex provider must handle spawn-per-turn model (no persistent stdin) and `--dangerously-bypass-approvals-and-sandbox`
- **B07** — MCP bridge needs per-provider config file generation (not just `.mcp.json`)
