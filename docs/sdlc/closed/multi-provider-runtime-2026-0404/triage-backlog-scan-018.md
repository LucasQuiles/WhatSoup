# Multi-Provider Runtime Backlog Scan

Task: `018`  
Date: 2026-04-05  
Scope: `docs/sdlc/active/multi-provider-runtime-2026-0404/beads/B01-B07`

## Conclusion

- `B01-provider-interface`: DONE
- `B02-extract-claude-provider`: PARTIAL
- `B03-config-schema`: PARTIAL
- `B04-codex-provider`: PARTIAL
- `B05-api-provider`: PARTIAL
- `B06-anthropic-api-provider`: PARTIAL
- `B07-mcp-bridge`: PARTIAL

## Evidence

### B01-provider-interface — DONE

Core provider abstraction types exist in `src/runtimes/agent/providers/types.ts`:

- execution/transport/MCP/image modes: `src/runtimes/agent/providers/types.ts:10-20`
- provider descriptor with resume + watchdog policy: `src/runtimes/agent/providers/types.ts:40-58`
- canonical turn request and checkpoint model with transcript locator: `src/runtimes/agent/providers/types.ts:71-115`
- provider session interface: `src/runtimes/agent/providers/types.ts:121-191`
- registry/config interfaces: `src/runtimes/agent/providers/types.ts:197-239`

### B02-extract-claude-provider — PARTIAL

Implemented:

- `ClaudeProvider` exists and implements `ProviderSession`: `src/runtimes/agent/providers/claude.ts:22-31`, `src/runtimes/agent/providers/claude.ts:70-269`
- Claude stdin payload preserved: `src/runtimes/agent/providers/claude.ts:174-211`
- Claude resume + transcript + MCP config are encoded in the provider: `src/runtimes/agent/providers/claude.ts:89-110`, `src/runtimes/agent/providers/claude.ts:214-225`, `src/runtimes/agent/providers/claude.ts:253-281`

Still incomplete:

- Runtime still instantiates the legacy `SessionManager`, not `ClaudeProvider`: `src/runtimes/agent/runtime.ts:1682-1697`
- `SessionManager` still contains Claude-specific binary/args/parser/transcript/stdin logic inline: `src/runtimes/agent/session.ts:217-257`, `src/runtimes/agent/session.ts:260-267`, `src/runtimes/agent/session.ts:300-309`, `src/runtimes/agent/session.ts:1060-1065`
- `ProviderSession`/`ProviderRegistry` types are not used by runtime/session code outside the provider files themselves: `src/runtimes/agent/providers/types.ts:142-209`

### B03-config-schema — PARTIAL

Implemented:

- instance loader validates `agentOptions.provider` / `providerConfig`: `src/instance-loader.ts:148-168`
- resolved config exposes `agentProvider` / `agentProviderConfig` with backward-compatible default: `src/config.ts:228-231`
- runtime passes provider selection into `SessionManager`: `src/runtimes/agent/runtime.ts:450-451`, `src/runtimes/agent/runtime.ts:531-532`, `src/runtimes/agent/runtime.ts:1693-1696`

Still incomplete:

- no runtime provider registry implementation; only an interface exists: `src/runtimes/agent/providers/types.ts:197-209`
- provider selection is still hardcoded through `SessionManager` switch statements rather than registry-created provider implementations: `src/runtimes/agent/session.ts:217-267`

### B04-codex-provider — PARTIAL

Implemented:

- Codex parser exists and maps app-server/legacy events into `AgentEvent`: `src/runtimes/agent/providers/codex-parser.ts:102-193`, `src/runtimes/agent/providers/codex-parser.ts:229-281`
- live session path supports `codex-cli` binary selection and parser dispatch: `src/runtimes/agent/session.ts:217-235`, `src/runtimes/agent/session.ts:260-267`
- Codex persistent app-server init, thread start, resume retry, and turn start are implemented: `src/runtimes/agent/session.ts:557-582`, `src/runtimes/agent/session.ts:625-663`, `src/runtimes/agent/session.ts:1030-1059`
- tests cover Codex parser/lifecycle behavior: `tests/runtimes/agent/parsers/codex-parser.test.ts:1-56`, `tests/runtimes/agent/codex-turn-lifecycle.test.ts:8-105`
- Codex research/documentation exists: `codex-exec-deep-dive.md:4-24`, `codex-exec-deep-dive.md:155-174`

Still incomplete:

- no `src/runtimes/agent/providers/codex.ts` provider implementation file
- Codex logic is embedded in `SessionManager` rather than behind the provider interface: `src/runtimes/agent/session.ts:217-267`, `src/runtimes/agent/session.ts:557-582`, `src/runtimes/agent/session.ts:1030-1059`

### B05-api-provider — PARTIAL

Implemented:

- `OpenAIApiProvider` exists with managed-loop SSE parsing and tool-call accumulation: `src/runtimes/agent/providers/openai-api.ts:23-32`, `src/runtimes/agent/providers/openai-api.ts:69-187`, `src/runtimes/agent/providers/openai-api.ts:230-340`
- MCP bridge has OpenAI tool-definition conversion helper: `src/runtimes/agent/providers/mcp-bridge.ts:74-89`

Still incomplete:

- provider is not wired into runtime/session selection; `SessionManager` has no `openai-api` branch and falls back to Claude CLI behavior for unknown providers: `src/runtimes/agent/runtime.ts:1682-1697`, `src/runtimes/agent/session.ts:217-257`
- tool execution is still placeholder-only (`"Tool execution not yet wired"`): `src/runtimes/agent/providers/openai-api.ts:146-177`
- no `api-loop.ts` shared implementation file
- no GNOME Keyring `secret-tool lookup service <name>` retrieval; provider reads `OPENAI_API_KEY` directly from environment: `src/runtimes/agent/providers/openai-api.ts:98-100`, `src/runtimes/agent/providers/openai-api.ts:237-248`

### B06-anthropic-api-provider — PARTIAL

Implemented:

- `AnthropicApiProvider` exists with Anthropic Messages SSE parsing and tool-use accumulation: `src/runtimes/agent/providers/anthropic-api.ts:22-31`, `src/runtimes/agent/providers/anthropic-api.ts:67-193`, `src/runtimes/agent/providers/anthropic-api.ts:234-340`
- bridge has Anthropic tool-definition conversion helper: `src/runtimes/agent/providers/mcp-bridge.ts:91-103`

Still incomplete:

- provider is not wired into runtime/session selection; `SessionManager` has no `anthropic-api` branch and still routes through CLI switches: `src/runtimes/agent/runtime.ts:1682-1697`, `src/runtimes/agent/session.ts:217-257`
- tool execution is placeholder-only (`"Tool execution not yet wired"`): `src/runtimes/agent/providers/anthropic-api.ts:147-184`
- bead called for reuse of shared `api-loop.ts`, but that file does not exist
- provider reads `ANTHROPIC_API_KEY` from environment directly instead of a keyring lookup path: `src/runtimes/agent/providers/anthropic-api.ts:99-100`, `src/runtimes/agent/providers/anthropic-api.ts:241-256`

### B07-mcp-bridge — PARTIAL

Implemented:

- provider-aware MCP helper exists: config generation + OpenAI/Anthropic conversion + strategy selection: `src/runtimes/agent/providers/mcp-bridge.ts:44-123`
- tests cover bridge helper behavior: `tests/runtimes/agent/providers/mcp-bridge.test.ts:10-59`

Still incomplete:

- runtime still hardcodes global `.mcp.json` generation to `claude-cli`: `src/runtimes/agent/runtime.ts:643-650`
- sandbox workspace provisioning still writes a fixed Claude-style `.mcp.json` shape directly, not provider-aware output: `src/core/workspace.ts:207-226`
- API providers do not execute tools through the MCP socket server yet; both return placeholder tool results instead: `src/runtimes/agent/providers/openai-api.ts:146-177`, `src/runtimes/agent/providers/anthropic-api.ts:147-184`
- `generateMcpConfigFile`/`getMcpStrategy` are largely unwired outside the single hardcoded Claude callsite: `src/runtimes/agent/runtime.ts:648`, `src/runtimes/agent/providers/mcp-bridge.ts:44-123`
