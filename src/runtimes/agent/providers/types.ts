// src/runtimes/agent/providers/types.ts
// Core type definitions for the multi-provider runtime abstraction.

import type { AgentEvent } from '../stream-parser.ts';

// ---------------------------------------------------------------------------
// Enums / union types
// ---------------------------------------------------------------------------

/** Execution model — the primary abstraction axis. */
export type ExecutionMode = 'persistent_session' | 'spawn_per_turn' | 'managed_loop';

/** Transport mechanism used to communicate with the provider. */
export type ProviderTransport = 'subprocess' | 'http';

/** How MCP tools are exposed to the provider. */
export type McpMode = 'config_file' | 'native_bridge' | 'none';

/** How the provider accepts images. */
export type ImageSupport = 'native' | 'startup_only' | 'file_path' | 'base64' | 'none';

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

/** Per-provider timeout configuration for the watchdog. */
export interface WatchdogPolicy {
  /** Milliseconds before the first (soft) warning fires. */
  softMs: number;
  /** Milliseconds before the escalated warning fires. */
  warnMs: number;
  /** Milliseconds before the session is forcibly killed. */
  hardMs: number;
}

// ---------------------------------------------------------------------------
// Provider descriptor — static metadata
// ---------------------------------------------------------------------------

/** Static metadata describing a provider type. */
export interface ProviderDescriptor {
  /** Unique identifier, e.g. 'claude-cli', 'codex-cli', 'openai-api'. */
  id: string;
  /** Human-readable name, e.g. 'Claude Code', 'Codex CLI'. */
  displayName: string;
  /** Transport mechanism. */
  transport: ProviderTransport;
  /** Execution model this provider uses. */
  executionMode: ExecutionMode;
  /** How MCP tools are exposed. */
  mcpMode: McpMode;
  /** How the provider accepts images. */
  imageSupport: ImageSupport;
  /** Whether the provider supports session resume / checkpoint restore. */
  supportsResume: boolean;
  /** Default watchdog timeouts for this provider. */
  defaultWatchdog: WatchdogPolicy;
}

// ---------------------------------------------------------------------------
// Turn request — canonical input before provider-specific encoding
// ---------------------------------------------------------------------------

/** A single part of a multi-part turn. */
export type TurnPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; filePath?: string; base64?: string; caption?: string }
  | { kind: 'audio'; mimeType: string; filePath?: string; transcript?: string }
  | { kind: 'document'; mimeType: string; filePath: string; extractedText?: string; filename?: string };

/** Canonical turn request passed to a provider. */
export interface ProviderTurnRequest {
  /** The role of this turn in the conversation. */
  role: 'user' | 'history_sync' | 'resume_recovery' | 'system_notice';
  /** Key identifying the logical conversation this turn belongs to. */
  conversationKey: string;
  /** Content parts for this turn. */
  parts: TurnPart[];
  /** Optional model override for this specific turn. */
  model?: string;
  /** Arbitrary metadata forwarded to the provider. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Checkpoint — opaque resume/recovery state
// ---------------------------------------------------------------------------

/** Handle to a running provider runtime (process, request, etc.). */
export type RuntimeHandle =
  | { kind: 'pid'; pid: number }
  | { kind: 'request_id'; id: string }
  | { kind: 'none' };

/** Locator for a conversation transcript. */
export type TranscriptLocator =
  | { kind: 'file'; path: string }
  | { kind: 'provider_ref'; ref: string }
  | { kind: 'none' };

/** Serialisable checkpoint for session durability and resume. */
export interface ProviderCheckpoint {
  /** Provider kind identifier matching {@link ProviderDescriptor.id}. */
  providerKind: string;
  /** Execution mode active when this checkpoint was taken. */
  executionMode: ExecutionMode;
  /** Provider-native session / thread ID, if any. */
  conversationRef: string | null;
  /** Handle to the runtime backing this session. */
  runtimeHandle: RuntimeHandle;
  /** Where the conversation transcript can be found. */
  transcriptLocator: TranscriptLocator;
  /** Opaque provider-specific state blob. */
  providerState: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider session — the strategy interface
// ---------------------------------------------------------------------------

/** Options passed when initialising a provider session. */
export interface ProviderSessionOptions {
  /** Working directory for the provider process / context. */
  cwd: string;
  /** System prompt to inject. */
  systemPrompt: string;
  /** Model to use (may be overridden per-turn). */
  model?: string;
  /** Plugin directories to load (CLI providers). */
  pluginDirs?: string[];
  /** Instance name for logging / identification. */
  instanceName: string;
  /** Callback invoked for every event emitted by the provider. */
  onEvent: (event: AgentEvent) => void;
  /** Callback invoked when the provider crashes. */
  onCrash: (info: { exitCode: number | null; signal: string | null }) => void;
}

/**
 * Strategy interface that each provider implements.
 *
 * `SessionManager` holds a `ProviderSession` and delegates turn execution
 * through it. The execution mode (persistent, spawn-per-turn, managed-loop)
 * is an internal concern of the implementation.
 */
export interface ProviderSession {
  /** Static descriptor for this provider type. */
  readonly descriptor: ProviderDescriptor;

  /**
   * Initialise the provider session.
   *
   * - **persistent_session**: spawns the subprocess.
   * - **spawn_per_turn**: prepares state but does not spawn yet.
   * - **managed_loop**: initialises the HTTP client.
   *
   * If `checkpoint` is provided the implementation should attempt to resume
   * from that state.
   */
  initialize(opts: ProviderSessionOptions, checkpoint?: ProviderCheckpoint): Promise<void>;

  /**
   * Send a turn to the provider.
   *
   * - **persistent_session**: writes to stdin.
   * - **spawn_per_turn**: spawns a new process with this turn.
   * - **managed_loop**: sends an HTTP request and runs the tool loop.
   *
   * Events flow through the `opts.onEvent` callback supplied at init.
   * Resolves when the turn is complete.
   */
  sendTurn(request: ProviderTurnRequest): Promise<void>;

  /** Get the current checkpoint state for durability / resume. */
  getCheckpoint(): ProviderCheckpoint;

  /** Check whether the session is active and healthy. */
  isActive(): boolean;

  /** Gracefully shut down the session. */
  shutdown(reason: 'suspend' | 'end'): Promise<void>;

  /** Force-kill the session (watchdog hard timeout). */
  kill(): void;

  /** Build the environment variable allowlist for child processes. */
  buildEnv(): NodeJS.ProcessEnv;

  /** Generate MCP config for this provider, if applicable. */
  generateMcpConfig?(socketPath: string): Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

/** Factory function that creates a {@link ProviderSession} instance. */
export type ProviderFactory = () => ProviderSession;

/** Registry of available providers. */
export interface ProviderRegistry {
  /** Register a provider factory under the given id. */
  register(id: string, factory: ProviderFactory): void;
  /** Create a new session for the provider identified by `id`. */
  create(id: string): ProviderSession;
  /** List descriptors for all registered providers. */
  list(): ProviderDescriptor[];
  /** Check whether a provider with the given id is registered. */
  has(id: string): boolean;
}

// ---------------------------------------------------------------------------
// Provider config — per-instance configuration (from config.json)
// ---------------------------------------------------------------------------

/** Provider configuration block in an instance's config.json. */
export interface ProviderConfig {
  /** Provider identifier — maps to the registry. Defaults to 'claude-cli'. */
  provider: string;
  /** Provider-specific configuration overrides. */
  providerConfig?: {
    /** CLI binary path or name override. */
    binary?: string;
    /** Model override. */
    model?: string;
    /** Keyring service name for API key lookup. */
    apiKeyService?: string;
    /** API endpoint (for HTTP providers). */
    baseUrl?: string;
    /** Plugin directories (CLI providers). */
    pluginDirs?: string[];
    /** Watchdog timeout overrides. */
    watchdog?: Partial<WatchdogPolicy>;
    /** Max tokens for API response (HTTP providers). Defaults vary by provider. */
    maxTokens?: number;
    /** Provider-specific extras. */
    [key: string]: unknown;
  };
}
