# Task 007 Review: Provider Interface Hierarchy

## Verdict

**changes-requested**

The provider layer should not be modeled as a thin rename of the current Claude `SessionManager`. The existing runtime has hard dependencies on provider-specific lifecycle, event semantics, workspace provisioning, resume behavior, and media handling. Those contracts need to be explicit in the interface, or Codex/Gemini/API backends will fit poorly and regress crash recovery.

## Findings

### Finding 1: The common contract must be capability-driven, not `spawnSession() + sendTurn()`
- Severity: high
- Confidence: high
- Evidence:
  - `src/runtimes/agent/session.ts:39-52`
  - `src/runtimes/agent/session.ts:134-178`
  - `src/runtimes/agent/runtime.ts:1144-1207`
  - `src/runtimes/chat/providers/types.ts:7-25`
- Impact:
  - The current agent path assumes a persistent subprocess with stdin/stdout, while chat providers already use a single `generate()` HTTP contract. A single monolithic provider interface will either leak Claude assumptions into HTTP providers or become a bag of nullable methods.
- Recommendation:
  - Use a discriminated hierarchy by `interactionModel` and `transport`, with shared modules for input encoding, event normalization, resume, MCP integration, media, and watchdog policy.

### Finding 2: Runtime logic depends on normalized semantic events, not raw provider events
- Severity: high
- Confidence: high
- Evidence:
  - `src/runtimes/agent/stream-parser.ts:4-13`
  - `src/runtimes/agent/stream-parser.ts:41-166`
  - `src/runtimes/agent/runtime.ts:1260-1338`
- Impact:
  - The watchdog, outbound queue, token accounting, and tool-status UX all key off semantic events such as `init`, `assistant_text`, `tool_use`, `tool_result`, `compact_boundary`, and `result`. Codex CLI and Gemini CLI emit different raw event shapes, so the provider boundary must normalize them before the runtime sees them.
- Recommendation:
  - Define a provider parser contract that emits canonical events such as `session.started`, `assistant.delta`, `tool.started`, `tool.completed`, `turn.completed`, and `session.resume-rejected`.

### Finding 3: Input/media handling must preserve canonical turn content before provider encoding
- Severity: high
- Confidence: high
- Evidence:
  - `src/runtimes/agent/runtime.ts:67-156`
  - `src/runtimes/agent/runtime.ts:1155-1184`
  - `src/runtimes/agent/runtime.ts:2002-2071`
  - `src/runtimes/chat/providers/types.ts:1-12`
- Impact:
  - Agent sessions currently receive plain-text turns with file-path references, recovery prefixes, and workspace-local media paths. Chat API providers already accept structured inline images. If the common interface only accepts `text: string`, API providers lose fidelity and CLI providers keep owning too much content transformation logic.
- Recommendation:
  - Introduce a canonical `ProviderTurnRequest` with structured parts plus an explicit `input` encoder module per provider.

### Finding 4: MCP config and outbound media are workspace/runtime concerns, not universal provider behavior
- Severity: medium
- Confidence: high
- Evidence:
  - `src/core/workspace.ts:52-60`
  - `src/core/workspace.ts:183-239`
  - `src/runtimes/agent/runtime.ts:1694-1744`
- Impact:
  - Only sandboxed CLI workspaces currently need `.mcp.json`, hook settings, a chat-scoped socket server, and the Unix media bridge. Direct HTTP providers may not need any local MCP artifacts at all. Treating MCP/media as mandatory provider behavior will overfit subprocess agents and complicate API backends.
- Recommendation:
  - Keep workspace artifact generation behind optional provider modules/capabilities, and let the runtime own socket/media-bridge lifecycles.

### Finding 5: Resume and watchdog policy need explicit provider contracts
- Severity: medium
- Confidence: high
- Evidence:
  - `src/runtimes/agent/session.ts:19-28`
  - `src/runtimes/agent/session.ts:385-475`
  - `src/runtimes/agent/runtime.ts:1978-2078`
  - `tests/runtimes/agent/session.test.ts:387-466`
- Impact:
  - The current runtime distinguishes stdin write timeout, soft/warn/hard idle probes, crash notification, and Claude-specific resume rejection. Those are not interchangeable across persistent CLI, spawn-per-turn CLI, and HTTP providers.
- Recommendation:
  - Add a `resume` contract with opaque checkpoints and failure classification, and a `watchdog` contract that separates startup, write/request, idle-activity, and hard-stop policies.

## Recommended TypeScript Contract

```ts
/**
 * Canonical provider IDs supported by WhatSoup's multi-backend agent runtime.
 */
export type ProviderId =
  | 'claude-cli'
  | 'codex-cli'
  | 'gemini-cli'
  | 'openai-api'
  | 'anthropic-api'
  | 'ollama-api';

/**
 * Transport used to talk to the provider implementation.
 */
export type ProviderTransport = 'subprocess' | 'http';

/**
 * High-level lifecycle model exposed by a provider.
 */
export type InteractionModel =
  | 'persistent-session'
  | 'spawn-per-turn'
  | 'http-client';

/**
 * Role of a synthetic turn injected by the runtime.
 */
export type TurnRole =
  | 'user'
  | 'history-sync'
  | 'resume-recovery'
  | 'system-notice';

/**
 * Shared metadata describing a provider implementation.
 */
export interface ProviderDescriptor {
  /** Stable identifier used in config, persistence, and logs. */
  id: ProviderId;
  /** User-facing provider label. */
  displayName: string;
  /** Delivery transport used by the provider. */
  transport: ProviderTransport;
  /** Session model used by the provider. */
  interactionModel: InteractionModel;
}

/**
 * Structured content part before provider-specific encoding.
 * CLI backends may project media to workspace paths, while HTTP providers may inline it.
 */
export type TurnPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'image';
      mimeType: string;
      base64?: string;
      filePath?: string;
      caption?: string;
    }
  | {
      kind: 'audio';
      mimeType: string;
      base64?: string;
      filePath?: string;
      transcript?: string;
    }
  | {
      kind: 'document';
      mimeType: string;
      filePath: string;
      extractedText?: string;
      filename?: string;
    };

/**
 * Canonical turn payload used by the runtime before provider-specific encoding.
 */
export interface ProviderTurnRequest {
  /** Logical role of the turn, including runtime-injected recovery/history turns. */
  role: TurnRole;
  /** Canonical conversation identifier used by WhatSoup. */
  conversationKey: string;
  /** Delivery JID currently bound to the conversation. */
  deliveryJid: string;
  /** Ordered structured parts that make up the turn payload. */
  parts: TurnPart[];
  /** Provider/model override for the specific turn, if needed. */
  model?: string;
  /** Arbitrary runtime metadata for logging, tracing, or future persistence. */
  metadata?: Record<string, unknown>;
}

/**
 * Opaque checkpoint material persisted by the runtime for resume/recovery.
 */
export interface ProviderCheckpoint {
  /** Provider-native session identifier, thread identifier, or equivalent. */
  nativeSessionId?: string | null;
  /** Native thread or conversation identifier for APIs that distinguish it from session id. */
  nativeThreadId?: string | null;
  /** Local transcript/artifact path if the provider writes one. */
  transcriptPath?: string | null;
  /** Live process id for subprocess-backed providers. */
  pid?: number | null;
  /** Additional provider-specific data needed for resume. */
  metadata?: Record<string, unknown>;
}

/**
 * Shared execution context owned by the runtime.
 */
export interface ProviderRuntimeContext {
  /** Working directory used for subprocesses or workspace-local artifacts. */
  cwd: string;
  /** Optional path to repo-local instructions to include in the provider prompt. */
  instructionsPath?: string;
  /** Instance name for human-readable prompt shaping and logs. */
  instanceName: string;
  /** Chat-scoped MCP tool names available in the workspace. */
  chatScopedToolNames: string[];
  /** Optional sandbox settings inherited from instance config. */
  sandbox?: {
    allowedTools: string[];
    allowedMcpTools?: string[];
    allowedPaths: string[];
    bash: { enabled: boolean; pathRestricted?: boolean };
  };
  /** Whether the runtime is provisioning an isolated workspace per chat. */
  sandboxPerChat: boolean;
}

/**
 * Provider-declared capabilities. The runtime should branch on these instead of
 * probing for nullable methods or inferring behavior from the provider id.
 */
export interface ProviderCapabilities {
  /** Whether the provider can consume streaming output. */
  supportsStreaming: boolean;
  /** Whether the provider can resume a prior conversation/session. */
  supportsResume: boolean;
  /** Whether tool lifecycle events are surfaced by the provider. */
  supportsToolEvents: boolean;
  /** Whether the provider expects a workspace-local MCP config. */
  supportsMcpWorkspace: boolean;
  /** How inbound media should be projected before encoding a turn. */
  mediaInputMode: 'workspace-paths' | 'inline-base64' | 'remote-url' | 'none';
  /** How outbound media is expected to be sent from provider-directed actions. */
  mediaOutputMode: 'mcp-bridge' | 'provider-native' | 'none';
}

/**
 * Provider-specific watchdog policy consumed by the runtime.
 * HTTP providers may ignore subprocess-only fields.
 */
export interface ProviderWatchdogConfig {
  /** Max time to wait for a subprocess or request stream to become active. */
  startupTimeoutMs?: number;
  /** Max time to wait for a stdin write callback or request body handoff. */
  inputWriteTimeoutMs?: number;
  /** First idle warning threshold after a turn has started. */
  idleSoftMs?: number;
  /** Second idle warning threshold after a turn has started. */
  idleWarnMs?: number;
  /** Hard upper bound for a single turn. */
  hardTimeoutMs: number;
  /** Kill signal for subprocess-backed providers when the hard timeout is exceeded. */
  killSignal?: NodeJS.Signals;
}

/**
 * Encoded turn payload returned by a provider input protocol.
 */
export type EncodedTurnPayload =
  | {
      kind: 'stdin-jsonl';
      lines: string[];
    }
  | {
      kind: 'argv';
      args: string[];
      stdinText?: string;
    }
  | {
      kind: 'http-body';
      body: unknown;
      headers?: Record<string, string>;
    };

/**
 * Provider-owned input encoder. This isolates Claude/Codex/Gemini/API request
 * shapes from the canonical runtime turn representation.
 */
export interface ProviderInputProtocol {
  /** Encode a canonical turn into the provider's transport-specific payload. */
  encodeTurn(turn: ProviderTurnRequest, checkpoint?: ProviderCheckpoint | null): EncodedTurnPayload;
}

/**
 * Normalized event stream consumed by AgentRuntime.
 * Providers should hide raw backend event names behind this union.
 */
export type ProviderEvent =
  | {
      type: 'session.started';
      checkpoint: ProviderCheckpoint;
    }
  | {
      type: 'session.resume-rejected';
      reason: 'expired' | 'missing' | 'unsupported' | 'unknown';
      detail?: string;
    }
  | {
      type: 'assistant.delta';
      text: string;
    }
  | {
      type: 'tool.started';
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool.completed';
      toolCallId: string;
      isError: boolean;
      content: string;
    }
  | {
      type: 'status.compacted';
    }
  | {
      type: 'turn.completed';
      text: string | null;
      stopReason?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
      };
      checkpoint?: ProviderCheckpoint;
    }
  | {
      type: 'provider.warning';
      code: string;
      message: string;
      raw?: unknown;
    }
  | {
      type: 'provider.raw';
      raw: unknown;
    };

/**
 * Stateful parser for provider output streams. The chunk type is intentionally
 * generic so stdout buffers and HTTP streaming frames can use the same shape.
 */
export interface ProviderStreamParser<TChunk = string | Buffer> {
  /** Push a transport chunk into the parser and emit zero or more canonical events. */
  push(chunk: TChunk): ProviderEvent[];
  /** Flush buffered state when the stream closes. */
  finish(): ProviderEvent[];
}

/**
 * Resume behavior for a provider. The runtime persists checkpoints opaquely and
 * asks the provider to interpret them later.
 */
export interface ProviderResumeContract {
  /** Whether resume is supported at all. */
  supported: boolean;
  /** Build the resume inputs for a new execution attempt. */
  buildResumeCheckpoint?(checkpoint: ProviderCheckpoint): ProviderCheckpoint;
  /**
   * Classify a failed resume attempt using provider-specific signals such as exit
   * codes, missing startup events, or HTTP error payloads.
   */
  classifyResumeFailure?(input: {
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    eventsSeen: ProviderEvent[];
    rawError?: unknown;
  }): 'expired' | 'missing' | 'unsupported' | 'transient' | 'unknown';
}

/**
 * Request used to build a subprocess invocation.
 */
export interface ProviderSpawnRequest {
  /** Runtime context, including cwd and sandbox/workspace details. */
  runtime: ProviderRuntimeContext;
  /** Optional checkpoint to resume from. */
  checkpoint?: ProviderCheckpoint | null;
  /** Optional model override for the spawned process. */
  model?: string;
}

/**
 * Spawn settings for CLI-backed providers.
 */
export interface ProviderSpawnConfig {
  /** Executable name or absolute path. */
  command: string;
  /** Final argument vector after provider-specific encoding. */
  args: string[];
  /** Environment overrides required by the provider. */
  env?: Record<string, string | undefined>;
  /** Working directory for the child process. */
  cwd: string;
  /** Stdio contract the runtime should expect. */
  stdio: ['pipe', 'pipe', 'pipe'] | 'pipe';
}

/**
 * Optional workspace artifacts written before a provider turn/session starts.
 * The runtime remains responsible for writing files and starting socket servers.
 */
export interface ProviderWorkspaceArtifacts {
  /** Files to write into the workspace prior to execution. */
  files: Array<{
    relativePath: string;
    content: string;
  }>;
  /** Environment variables that should be threaded to the process or request. */
  env?: Record<string, string>;
}

/**
 * Provider-owned MCP config generation hook.
 */
export interface ProviderMcpConfigGenerator {
  /** Build workspace-local config files needed for tool access, if any. */
  buildWorkspaceArtifacts(runtime: ProviderRuntimeContext): ProviderWorkspaceArtifacts | null;
}

/**
 * Provider-owned media policy. The runtime uses this to decide whether to project
 * media into workspace files, inline it as base64, or skip unsupported parts.
 */
export interface ProviderMediaStrategy {
  /** Normalize inbound WhatsApp-derived media before turn encoding. */
  prepareTurnParts(turn: ProviderTurnRequest, runtime: ProviderRuntimeContext): Promise<ProviderTurnRequest>;
}

/**
 * Common provider base shared by all backends.
 */
export interface BaseAgentProvider {
  /** Static metadata used for selection and capability checks. */
  descriptor: ProviderDescriptor;
  /** Explicit capability declaration for branching in the runtime. */
  capabilities: ProviderCapabilities;
  /** Transport-agnostic input encoder. */
  input: ProviderInputProtocol;
  /** Resume policy and failure classification. */
  resume: ProviderResumeContract;
  /** Optional MCP/workspace artifact generator. */
  mcp: ProviderMcpConfigGenerator;
  /** Media preparation policy. */
  media: ProviderMediaStrategy;
  /** Watchdog thresholds that should wrap executions from this provider. */
  watchdog: ProviderWatchdogConfig;
}

/**
 * Persistent subprocess provider. Example: Claude Code with long-lived stdin/stdout.
 */
export interface PersistentCliProvider extends BaseAgentProvider {
  descriptor: ProviderDescriptor & {
    transport: 'subprocess';
    interactionModel: 'persistent-session';
  };
  /** Build the child-process invocation for the session start or resume. */
  buildSpawnConfig(request: ProviderSpawnRequest): ProviderSpawnConfig;
  /** Create a parser for stdout chunks emitted by the live child process. */
  createParser(): ProviderStreamParser<Buffer | string>;
}

/**
 * Spawn-per-turn subprocess provider. Example: Codex or Gemini launched fresh per turn.
 */
export interface SpawnPerTurnCliProvider extends BaseAgentProvider {
  descriptor: ProviderDescriptor & {
    transport: 'subprocess';
    interactionModel: 'spawn-per-turn';
  };
  /** Build the child-process invocation for a single turn execution. */
  buildSpawnConfig(request: ProviderSpawnRequest): ProviderSpawnConfig;
  /** Create a parser for stdout chunks emitted by the one-shot child process. */
  createParser(): ProviderStreamParser<Buffer | string>;
}

/**
 * Direct HTTP provider. Example: OpenAI, Anthropic, or Ollama chat/completions APIs.
 */
export interface HttpApiProvider extends BaseAgentProvider {
  descriptor: ProviderDescriptor & {
    transport: 'http';
    interactionModel: 'http-client';
  };
  /** Create a parser for HTTP streaming frames or synthetic events from non-streaming calls. */
  createParser(): ProviderStreamParser<string | Uint8Array>;
}

/**
 * Final discriminated union consumed by the runtime.
 */
export type AgentProvider =
  | PersistentCliProvider
  | SpawnPerTurnCliProvider
  | HttpApiProvider;
```

## Notes For Implementation

- The runtime should own process start/kill, queueing, durability, socket-server lifecycle, and media-bridge lifecycle.
- Providers should own only provider-specific encoding, parsing, resume semantics, and workspace artifacts.
- Existing persistence currently leaks Claude naming (`claude_pid`, transcript assumptions), so an implementation pass should budget a follow-up rename/generalization before multiple backends are fully wired.
