# Multi-Provider Runtime — Revised Spec

**Revision date:** 2026-04-04
**Informed by:** 6 Codex workers, 5 Claude guppies, 1 Claude sonnet, 2 Oracle council members

## Architecture Decision: Execution Mode Strategy, Not CLI-vs-API

Both Codex architecture reviewers independently concluded the same thing: **the primary abstraction boundary should be execution mode, not provider family.**

Three execution modes:
1. **Persistent session** — spawn once, pipe stdin/stdout for multiple turns (Claude Code)
2. **Spawn-per-turn** — new subprocess per user message, resume chains context (Codex exec, Gemini -p)
3. **Managed loop** — no subprocess, we manage the HTTP conversation + tool-calling loop (OpenAI API, Anthropic API, Ollama)

`SessionManager` owns the **logical conversation**. `ProviderSession` (strategy object) owns **how a turn executes**.

## Provider Interface (from Codex reviewers, Oracle-validated)

```typescript
type ExecutionMode = 'persistent_session' | 'spawn_per_turn' | 'managed_loop';
type ProviderTransport = 'subprocess' | 'http';
type McpMode = 'config_file' | 'native_bridge' | 'none';

interface ProviderDescriptor {
  id: string;                        // 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'openai-api' | 'anthropic-api' | 'ollama-api'
  displayName: string;
  transport: ProviderTransport;
  executionMode: ExecutionMode;
  mcpMode: McpMode;
  supportsImages: 'native' | 'startup_only' | 'file_path' | 'base64' | 'none';
  supportsResume: boolean;
}

interface ProviderTurnRequest {
  role: 'user' | 'history_sync' | 'resume_recovery' | 'system_notice';
  conversationKey: string;
  parts: TurnPart[];               // text, image, audio, document — canonical format
  model?: string;
}

interface ProviderCheckpoint {
  providerKind: string;
  executionMode: ExecutionMode;
  conversationRef: string | null;   // provider-native session/thread ID
  runtimeHandle: { kind: 'pid'; pid: number } | { kind: 'request_id'; id: string } | { kind: 'none' };
  transcriptLocator: { kind: 'file'; path: string } | { kind: 'provider_ref'; ref: string } | { kind: 'none' };
  providerState: Record<string, unknown>;  // opaque provider-specific blob
}
```

## Streaming Format Comparison (Oracle-verified)

| Event | Claude | Gemini | Codex |
|---|---|---|---|
| Session start | `{type:"system",subtype:"init",session_id}` | `{type:"init",session_id}` | `{type:"thread.started",thread_id}` |
| Text delta | `{type:"assistant",message:{content:[{type:"text",text}]}}` | `{type:"message",role:"assistant",content,delta:true}` | `{type:"item.completed",item:{type:"agent_message",text}}` |
| Tool start | `{type:"assistant",message:{content:[{type:"tool_use",name,id,input}]}}` | `{type:"tool_use",tool_name,tool_id,parameters}` | `{type:"item.started",item:{type:"command_execution",command}}` |
| Tool result | `{type:"user",message:{content:[{type:"tool_result",tool_use_id,content}]}}` | `{type:"tool_result",tool_id,status,output}` | `{type:"item.completed",item:{type:"command_execution",aggregated_output,exit_code}}` |
| Turn complete | `{type:"result",usage:{input_tokens,output_tokens}}` | `{type:"result",status,stats:{total_tokens,...}}` | `{type:"turn.completed",usage:{input_tokens,cached_input_tokens,output_tokens}}` |
| Compaction | `{type:"system",subtype:"compact_boundary"}` | None observed | None observed |
| Error | Embedded in result | `{type:"error",...}` | `{type:"turn.failed",error:{message}}` |

**Key insight:** Gemini is closest to Claude (same event names, similar structure). Codex is most different (item-based model, no streaming deltas).

All normalize to the existing `AgentEvent` union — the parser is the provider boundary.

## Security Requirements (Oracle-validated, P0)

### S1: Explicit env allowlists for child processes
**Evidence:** `session.ts:161-177` — spawn() has no `env` override; children inherit all parent env vars including OPENAI_API_KEY, PINECONE_API_KEY.
**Fix:** Each provider spawn gets explicit `env: { PATH, HOME, provider-specific-key-only }`.

### S2: Provider-scoped credential namespacing
**Evidence:** `deploy/whatsoup:39-72` — shared keyring entries exported globally.
**Fix:** Keyring entries namespaced: `service=whatsoup_api_key provider=openai instance=lab`.

### S3: Workspace directory permissions
**Evidence:** `workspace.ts:109,149,188` — mkdirSync without mode, defaults to 0755.
**Fix:** Add `{ mode: 0o700 }` to all workspace mkdirSync calls.

### S4: No full-bypass by default for alternate providers
**Evidence:** Security review recommendation — don't mirror bypassPermissions/--dangerously-bypass-approvals-and-sandbox by default.
**Fix:** Default alternate providers to least-privilege. Full bypass is opt-in per-instance config.

### S5: Per-provider budget controls
**Evidence:** No provider-level rate limiting exists today.
**Fix:** Per-provider requests/min, tokens/min, daily spend cap in config.

## Provider-Specific Spawn Configuration (verified)

| Provider | Binary | Key Flags | Auth | Input | Resume |
|---|---|---|---|---|---|
| Claude Code | `claude` | `--input-format stream-json --output-format stream-json --permission-mode bypassPermissions --system-prompt` | Auto (subscription) | JSONL on persistent stdin | `--resume <id>` |
| Codex CLI | `codex` | `exec --json --dangerously-bypass-approvals-and-sandbox -m MODEL -C CWD` | OPENAI_API_KEY or ChatGPT auth | Prompt as CLI arg (one-shot) | `codex exec resume <id> "<prompt>"` |
| Gemini CLI | `gemini` | `-p --output-format stream-json --yolo -m MODEL` | GEMINI_API_KEY | `-p "prompt"` (one-shot) | `--resume latest` or `--resume <id>` |
| OpenAI API | N/A | N/A | OPENAI_API_KEY from keyring | HTTP POST | We manage state |
| Anthropic API | N/A | N/A | ANTHROPIC_API_KEY from keyring | HTTP POST | We manage state |
| Ollama/local | N/A | N/A | None (localhost) | HTTP POST | We manage state |

## MCP Integration Per Provider (verified)

| Provider | How tools are exposed | Config mechanism |
|---|---|---|
| Claude Code | Write `.mcp.json` to workspace cwd | Auto-discovered by Claude on startup |
| Codex CLI | Write `.mcp.json` to workspace cwd | Same format as Claude (confirmed) |
| Gemini CLI | Write `.mcp.json` or use `gemini mcp` | Similar discovery mechanism |
| API providers | Convert MCP tool registry → function calling format | We call tools directly via our socket server |

## Tool Name Mapping (verified gap)

`runtime.ts:234-323` hardcodes 25+ Claude tool names in `buildToolUpdate()`. Each provider uses different names:

| Display Category | Claude | Codex | Gemini | API |
|---|---|---|---|---|
| reading | Read, LS | (implicit in file ops) | read_file | our MCP tool names |
| modifying | Edit, Write | file_change | edit_file | our MCP tool names |
| running | Bash | command_execution | run_shell_command | our MCP tool names |
| searching | Grep, Glob | (part of commands) | grep, glob | our MCP tool names |
| fetching | WebFetch, WebSearch | web_search | google_web_search | our MCP tool names |

Need: pluggable `ToolNameMapper` per provider.

## Revised Bead Manifest

### Phase 1: Core Abstraction (serialize)
- **B01** Provider interface + execution mode types — REDESIGNED per above
- **B02** Extract Claude provider from SessionManager — UNCHANGED but scope expanded for security (env allowlist)

### Phase 2: Config + Security (parallelize)
- **B03** Config schema with provider selection — EXPANDED with security fields
- **B08** Credential isolation — NEW: env allowlists, keyring namespacing (P0 security)
- **B09** Workspace permissions fix — NEW: 0700 on dirs, socket isolation (P0 security)

### Phase 3: Providers (parallelize after Phase 1)
- **B04** Codex CLI provider — UPDATED: spawn-per-turn model confirmed, `exec resume` for context continuity
- **B10** Gemini CLI provider — NEW: spawn-per-turn, close to Claude format
- **B05** OpenAI-compatible API provider — UNCHANGED
- **B06** Anthropic API provider — UNCHANGED

### Phase 4: Integration (serialize after Phase 3)
- **B07** MCP bridge — UPDATED: per-provider config file generation
- **B11** Media bridge — NEW: file paths vs base64 vs startup flags
- **B12** Tool name mapping — NEW: pluggable display category registry
- **B13** Budget controls — NEW: per-provider rate limiting + spend caps

### Dependency Graph
```
B01 ─┬─ B02 ─┬─ B04 (Codex, spawn-per-turn)
     │       ├─ B10 (Gemini, spawn-per-turn)
     │       ├─ B07 (MCP bridge)
     │       ├─ B11 (Media bridge)
     │       └─ B12 (Tool name mapping)
     ├─ B03 ─── B13 (Budget controls)
     ├─ B05 ─── B06 (Anthropic API)
     ├─ B08 (Credential isolation, P0)
     └─ B09 (Workspace perms fix, P0)
```

## Open Questions
1. Should spawn-per-turn providers use `--resume` on every turn, or start fresh with injected history?
2. Budget controls: hard-kill on overspend, or degrade to cheaper model?
3. Socket auth: random bearer token per workspace, or peer credential validation?
