// src/runtimes/agent/session.ts
// SessionManager owns the Claude Code child process lifecycle.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../core/database.ts';
import type { Messenger } from '../../core/types.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import type { SessionContext } from '../../mcp/types.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { WHATSOUP_OPENCODE_AGENT_ID } from '../../core/provider-mcp-config.ts';
import { createChildLogger } from '../../logger.ts';
import {
  createSession,
  incrementMessageCount,
  resolveResumableAgentSession,
  updateResumedSessionStatus,
  updateSessionId,
  updateSessionStatus,
  updateTranscriptPath,
} from './session-db.ts';
import { parseEvents } from './stream-parser.ts';
import type { AgentEvent } from './stream-parser.ts';
import { parseCodexEvent } from './providers/codex-parser.ts';
import { parseGeminiAcpEvent, buildInitializeRequest, buildSessionNewRequest, buildSessionPromptRequest } from './providers/gemini-acp-parser.ts';
import { createOpenCodeParser, type OpenCodeParser } from './providers/opencode-parser.ts';
import { buildBaseChildEnv, type BuildBaseChildEnvOptions } from './providers/child-env.ts';
import { ProviderBudget, type BudgetConfig } from './providers/budget.ts';
import { watchdogHardMsForProvider } from './providers/watchdog-policy.ts';
import type { ProviderMcpBridge, ProviderSession } from './providers/types.ts';
import { OpenAIApiProvider } from './providers/openai-api.ts';
import { AnthropicApiProvider } from './providers/anthropic-api.ts';
import {
  PROVIDER_IDS,
  isProviderId,
  assertNeverProvider,
  type ProviderId,
} from './providers/index.ts';
import { composeWithExactLineDedup } from './prompt-compose.ts';
import {
  appendProviderCrashPreview,
  buildProviderCrashMetadata,
} from './provider-crash-diagnostics.ts';
import { lookupCredential, resolveProviderKeyService, SERVICE_ENV_MAP } from '../../lib/keyring.ts';
import { resolveApiKey } from '../../lib/api-key-resolver.ts';
import { killSessionTree } from './process-tree.ts';

const log = createChildLogger('session-manager');

const STDIN_WRITE_TIMEOUT_MS = 30_000;

/** Cap on the retained no-newline stdout line (QR-064): a provider streaming a
 * large no-newline blob would grow `stdoutBufferStr` unbounded → parent OOM. The
 * MCP socket MAX_BUF analogue; 16 MiB >> any real event line. */
export const MAX_STDOUT_LINE_BYTES = 16 * 1024 * 1024;
/** @deprecated Use WATCHDOG_SOFT_MS / WATCHDOG_HARD_MS instead. Kept for test backward-compat. */
export const TURN_WATCHDOG_MS = 600_000;

// ─── 3-tier watchdog ────────────────────────────────────────────────────────
// Soft probes notify the user; hard kill terminates the process.
// ALL tiers reset on any agent activity (tool_use, tool_result, assistant_text).
export const WATCHDOG_SOFT_MS  = 600_000;   // 10 min — first soft probe
export const WATCHDOG_WARN_MS  = 1_200_000; // 20 min — second soft probe
export const WATCHDOG_HARD_MS  = 1_800_000; // 30 min — SIGKILL

// Grace after a tool stalls before we SIGKILL the hung stream-json provider. Unlike
// WATCHDOG_HARD_MS this is NOT reset by inbound messages (see recoverStalledOperation).
export const STALLED_OP_KILL_GRACE_MS = 180_000; // 3 min after a tool stalls

/** Human-readable display name for each supported provider. */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'gemini-cli': 'Gemini CLI',
  'opencode-cli': 'OpenCode',
  'anthropic-api': 'Anthropic API',
  'openai-api': 'OpenAI API',
};

/** Exact provider capability matrix for persisted conversation resume. */
export function providerSupportsResume(provider: ProviderId): boolean {
  switch (provider) {
    case 'claude-cli':
    case 'codex-cli':
    case 'opencode-cli':
      return true;
    case 'gemini-cli':
    case 'openai-api':
    case 'anthropic-api':
      return false;
    default:
      return assertNeverProvider(provider, 'session-manager:providerSupportsResume');
  }
}

const POLL_DECISION_GUIDANCE = [
  'Decision polling:',
  '- For bounded user decisions that block progress, use AskUserQuestion when available; WhatSoup sends a WhatsApp poll.',
  '- AskUserQuestion works in both DMs and groups. In groups, first vote resolves by default.',
  '- Use multiSelect: true when the user may choose more than one option; keep labels short; put context in descriptions.',
  '- For non-blocking surveys or lightweight coordination, use send_poll; use selectableCount > 1 for multi-select.',
  '- send_poll supports resolution strategies: first-vote-wins (default), admin-only, admin-wins, majority-after-timeout.',
  '- send_poll supports awaitResult: true to block and wait for the poll result.',
  '- Do not ask the user to type "I voted". Wait for the poll vote, or accept exact option label/number on delivery failure.',
].join('\n');

export interface SessionCrashInfo {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The Claude session ID at the time of crash — useful for attempting --resume recovery. */
  sessionId: string | null;
  /** The agent_sessions DB row ID — useful for resume with existing row. */
  dbRowId: number | null;
  /** Provider that crashed, when known. */
  provider?: string;
  /** Coarse, non-secret crash class derived from provider output. */
  crashClass?: string;
  /** Redacted, bounded stderr preview from the provider process. */
  stderrPreview?: string;
  /** Manager generation captured by the child/provider that emitted this crash. Null for unbound sessions. */
  generationIdentity?: SessionGenerationIdentity | null;
}

export interface SessionGenerationIdentity {
  readonly managerId: string;
  readonly generation: number;
}

interface ShutdownKillTimerEntry {
  readonly generation: SessionGenerationIdentity | null;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface SessionManagerOptions {
  db: Database;
  messenger: Messenger;
  chatJid: string;
  onEvent: (event: AgentEvent) => void;
  instanceName?: string;
  onResumeFailed?: () => void;
  onCrash?: (info: SessionCrashInfo) => void;
  notifyUser?: (msg: string) => void;
  cwd?: string;
  configRoot?: string;
  configSystemPrompt?: string;
  instructionsPath?: string;
  model?: string;
  pluginDirs?: string[];
  allowM365Mutations?: boolean;
  provider?: string;
  providerConfig?: Record<string, unknown>;
  mcpBridge?: ProviderMcpBridge;
  mcpSessionContext?: SessionContext;
  whatsoupInstance?: string;
  whatsoupMcpSocket?: string;
  handoffSystemBlock?: () => string | null;
  routingSystemBlock?: () => string | null;
}

/**
 * Build an explicit environment for Claude Code child processes.
 *
 * Security rationale: spawn() with no `env` option inherits process.env in full.
 * For a multi-provider system this is a security hole — Codex would receive
 * Anthropic's key, Gemini would receive OpenAI's key, etc. By constructing an
 * explicit allowlist we ensure each subprocess only gets the credentials it needs.
 *
 * Extend this function when adding new providers: each provider should only receive
 * its own credentials plus the system essentials below.
 */
// Services whose model prefix resolved to no SERVICE_ENV_MAP entry — warned
// once per service per process so spawn-per-turn providers don't spam logs.
const warnedUnmappedKeyServices = new Set<string>();

export function buildChildEnv(
  provider: string = 'claude-cli',
  baseOpts?: BuildBaseChildEnvOptions,
  model?: string,
  providerConfig?: Record<string, unknown>,
): NodeJS.ProcessEnv {
  if (!isProviderId(provider)) {
    throw new Error(
      `[session-manager:buildChildEnv] unknown provider id: ${JSON.stringify(provider)}. ` +
        `Valid: ${PROVIDER_IDS.join(', ')}.`,
    );
  }

  const env = buildBaseChildEnv(baseOpts);

  // Provider-specific credentials — each provider only receives the keys it needs.
  // W-4: keys are resolved via resolveApiKey() (keyring-first, env-fallback)
  // rather than read directly from process.env. This removes the direct env
  // reads flagged by tests/scripts/secret-env-read-guard.test.ts and ensures
  // keyring-stored keys are forwarded to children even when the parent env is
  // empty. See docs/security-handoffs/2026-05-09-env-secret-exposure.md Phase D.
  switch (provider) {
    case 'claude-cli':
      // OPENAI_API_KEY is allowed for this provider's auxiliary features (Whisper).
      // ANTHROPIC_API_KEY is deliberately excluded — Claude uses subscription auth.
      {
        const openaiKey = resolveApiKey({ service: 'openai', envVar: 'OPENAI_API_KEY' });
        if (openaiKey) env.OPENAI_API_KEY = openaiKey;
      }
      break;
    case 'codex-cli':
      {
        const openaiKey = resolveApiKey({ service: 'openai', envVar: 'OPENAI_API_KEY' });
        if (openaiKey) env.OPENAI_API_KEY = openaiKey;
      }
      break;
    case 'gemini-cli':
      if (process.env.GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (process.env.GOOGLE_API_KEY) env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
      break;
    case 'opencode-cli': {
      // OpenCode reads from its own config or standard API keys
      {
        const openaiKey = resolveApiKey({ service: 'openai', envVar: 'OPENAI_API_KEY' });
        if (openaiKey) env.OPENAI_API_KEY = openaiKey;
        const anthropicKey = resolveApiKey({ service: 'anthropic', envVar: 'ANTHROPIC_API_KEY' });
        if (anthropicKey) env.ANTHROPIC_API_KEY = anthropicKey;
      }
      // Forward the fleet fallback trio keys (deepseek/minimax/glm) from the
      // standard keychain so `opencode run -m minimax/...` / `deepseek/...` /
      // `glm/...` can auth (opencode's catalog still allows other models
      // mid-session) — PLUS the session's configured model prefix key (via the
      // shared resolver) so a primary/fallback outside the trio (e.g.
      // openai/gpt-4o) can auth too. The Set dedupes overlapping services.
      // lookupCredential resolves env → keychain; SERVICE_ENV_MAP is the single
      // source of truth for the service→env-var mapping (no second copy).
      const services = new Set<string>(['deepseek', 'minimax', 'glm']);
      const warnUnmapped = (service: string, source: string): void => {
        if (warnedUnmappedKeyServices.has(service)) return;
        warnedUnmappedKeyServices.add(service);
        log.warn(
          { provider, model, service, source },
          `[session-manager:buildChildEnv] ${source} resolves to key service "${service}" but SERVICE_ENV_MAP has no entry for it — no API key env var will be forwarded to the child. Register the service in SERVICE_ENV_MAP (src/lib/keyring.ts) to enable forwarding.`,
        );
      };
      // Custom-endpoint auth lane: the opencode.json provider block references
      // the endpoint key as `{env:<ENVVAR>}` for the service named by
      // providerConfig.apiKeyService — inject that service's key on top of the
      // defaults so the interpolation resolves inside the child.
      const endpointServiceRaw = providerConfig?.['apiKeyService'];
      const endpointService =
        typeof endpointServiceRaw === 'string' && endpointServiceRaw.trim() !== ''
          ? endpointServiceRaw
          : undefined;
      const endpointServiceMapped = endpointService !== undefined && Boolean(SERVICE_ENV_MAP[endpointService]);
      if (endpointService) {
        if (endpointServiceMapped) services.add(endpointService);
        else warnUnmapped(endpointService, 'providerConfig.apiKeyService');
      }
      const modelService = resolveProviderKeyService(provider, model);
      if (modelService) {
        if (SERVICE_ENV_MAP[modelService]) {
          services.add(modelService);
        } else if (!endpointServiceMapped) {
          // A mapped explicit endpoint key service already covers auth — a
          // bare custom-endpoint model id has no meaningful prefix, so the
          // unmapped-prefix warning would be misleading noise there.
          warnUnmapped(modelService, 'model prefix');
        }
      }
      for (const svc of services) {
        const key = lookupCredential(svc);
        if (key) env[SERVICE_ENV_MAP[svc]!] = key;
      }
      break;
    }
    case 'openai-api':
    case 'anthropic-api':
      throw new Error(
        `[session-manager:buildChildEnv] ${provider} is a managed-loop provider and does not spawn a child process`,
      );
    default:
      return assertNeverProvider(provider, 'session-manager:buildChildEnv');
  }

  // Excluded (all providers): PINECONE_API_KEY (parent MCP only),
  // WHATSOUP_HEALTH_TOKEN (parent-only auth token)

  return env;
}

// ─── Provider switch resolvers ──────────────────────────────────────────────
// These functions encode the per-provider runtime contract for spawning a
// CLI subprocess. They are extracted from SessionManager so they can be
// covered by unit tests without instantiating the full manager. Each switch
// is exhaustive on {@link ProviderId} via {@link assertNeverProvider} — adding
// a new provider in providers/index.ts surfaces a TS compile error here
// until every switch is updated, eliminating the silent-Claude-alias bug
// closed by #447.

/** Resolve the executable name for a CLI-backed provider. */
function resolveProviderBinary(provider: ProviderId): string {
  switch (provider) {
    case 'claude-cli': return 'claude';
    case 'codex-cli': return 'codex';
    case 'gemini-cli': return 'gemini';
    case 'opencode-cli': return 'opencode';
    case 'openai-api':
    case 'anthropic-api':
      // Managed-loop providers do not spawn a subprocess. Reaching this
      // branch indicates a logic error in the caller (it should have
      // routed via createManagedProviderSession).
      throw new Error(
        `[session-manager:resolveProviderBinary] ${provider} is a managed-loop provider and does not spawn a binary`,
      );
    default:
      return assertNeverProvider(provider, 'session-manager:resolveProviderBinary');
  }
}

/**
 * Return the CLI binary name for `provider`, or `null` for managed-loop
 * providers that do not spawn a child process (`openai-api`, `anthropic-api`).
 *
 * Exported for use by the binary pre-flight in
 * `src/runtimes/agent/providers/binary-preflight.ts`. Unknown provider IDs
 * throw (defence in depth — callers should validate with `isProviderId` first).
 */
export function getProviderBinary(provider: string): string | null {
  if (!isProviderId(provider)) {
    throw new Error(
      `[session-manager:getProviderBinary] unknown provider id: ${JSON.stringify(provider)}. ` +
        `Valid: ${PROVIDER_IDS.join(', ')}.`,
    );
  }
  // Managed-loop providers have no binary.
  if (provider === 'openai-api' || provider === 'anthropic-api') return null;
  return resolveProviderBinary(provider);
}

/**
 * Whether an opencode-cli session routes through a custom endpoint configured
 * in opencode.json. The config writer (mergeOpencodeConfig) merges a provider
 * block for `providerConfig.baseUrl` and points opencode.json's top-level
 * `model` at it (`<providerId>/<model>`). An explicit `-m <model>` argv would
 * override that file-level routing and send the turn to opencode's own
 * catalog instead — so sessions with a baseUrl must omit `-m` and let
 * opencode resolve the model from the config file.
 */
export function opencodeUsesConfigModel(providerConfig: Record<string, unknown> | undefined): boolean {
  const baseUrl = providerConfig?.['baseUrl'];
  return typeof baseUrl === 'string' && baseUrl.trim() !== '';
}

/** Resolve the argv for a CLI-backed provider. */
function resolveProviderArgs(
  provider: ProviderId,
  systemPrompt: string,
  _cwd: string,
  resumeSessionId: string | undefined,
  model: string | undefined,
  pluginDirs: string[],
  providerConfig?: Record<string, unknown>,
): string[] {
  switch (provider) {
    case 'claude-cli': {
      // providerConfig-driven claude-cli flags. Absorbed from fleet hosts that
      // had patched these in locally; every value is optional and defaults to
      // the prior behavior EXCEPT the system-prompt flag (see below).
      const permissionMode = typeof providerConfig?.['permissionMode'] === 'string'
        ? providerConfig['permissionMode']
        : 'bypassPermissions';
      // Default to --append-system-prompt (additive: keeps the provider CLI's
      // base prompt and adds WhatSoup's) — the fleet's behavior. Set
      // providerConfig.rawSystemPrompt=true to REPLACE the base prompt instead.
      const promptFlag = providerConfig?.['rawSystemPrompt'] === true
        ? '--system-prompt'
        : '--append-system-prompt';
      const tools = providerConfig?.['tools'];
      const toolArgs = tools === undefined
        ? []
        : Array.isArray(tools)
          ? ['--tools', ...(tools.length === 0 ? [''] : tools.map(String))]
          : ['--tools', String(tools)];
      const mcpConfigs = providerConfig?.['mcpConfig'];
      const mcpConfigArgs = mcpConfigs === undefined
        ? []
        : Array.isArray(mcpConfigs)
          ? ['--mcp-config', ...mcpConfigs.map(String)]
          : ['--mcp-config', String(mcpConfigs)];
      const settingSources = typeof providerConfig?.['settingSources'] === 'string'
        ? ['--setting-sources', providerConfig['settingSources']]
        : [];
      const effort = typeof providerConfig?.['effort'] === 'string'
        ? ['--effort', providerConfig['effort']]
        : [];
      const agents = providerConfig?.['agents'];
      const agentArgs = agents === undefined || agents === ''
        ? []
        : ['--agents', typeof agents === 'string' ? agents : JSON.stringify(agents)];
      const fallbackModel = providerConfig?.['fallbackModel'];
      const fallbackModelArgs = fallbackModel === undefined || fallbackModel === ''
        ? []
        : ['--fallback-model', Array.isArray(fallbackModel) ? fallbackModel.map(String).join(',') : String(fallbackModel)];

      return [
        '-p', '--verbose',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--permission-mode', permissionMode,
        promptFlag, systemPrompt,
        ...(providerConfig?.['disableSlashCommands'] === true ? ['--disable-slash-commands'] : []),
        ...(providerConfig?.['strictMcpConfig'] === true ? ['--strict-mcp-config'] : []),
        ...(providerConfig?.['noSessionPersistence'] === true ? ['--no-session-persistence'] : []),
        ...toolArgs,
        ...mcpConfigArgs,
        ...settingSources,
        ...effort,
        ...agentArgs,
        ...fallbackModelArgs,
        ...(model ? ['--model', model] : []),
        ...pluginDirs.flatMap((dir) => ['--plugin-dir', dir]),
        ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      ];
    }
    case 'codex-cli':
      return [
        'app-server',
        '--listen', 'stdio://',
        ...(model ? ['--model', model] : []),
      ];
    case 'gemini-cli':
      return ['--acp'];
    case 'opencode-cli':
      return [
        'run',
        '--format', 'json',
        '--pure',
        '--agent', WHATSOUP_OPENCODE_AGENT_ID,
        ...(model && !opencodeUsesConfigModel(providerConfig) ? ['-m', model] : []),
      ];
    case 'openai-api':
    case 'anthropic-api':
      throw new Error(
        `[session-manager:resolveProviderArgs] ${provider} is a managed-loop provider and has no argv`,
      );
    default:
      return assertNeverProvider(provider, 'session-manager:resolveProviderArgs');
  }
}

/** Resolve the line-parser for a CLI-backed provider's stdout stream. */
type ProviderEventParser = (line: string) => AgentEvent[];

function singleEventEnvelope(event: AgentEvent | null): AgentEvent[] {
  return event === null ? [] : [event];
}

function resolveProviderParser(
  provider: ProviderId,
  openCodeParser: OpenCodeParser,
): ProviderEventParser {
  switch (provider) {
    case 'claude-cli': return parseEvents;
    case 'codex-cli': return (line: string) => singleEventEnvelope(parseCodexEvent(line));
    case 'gemini-cli': return (line: string) => singleEventEnvelope(parseGeminiAcpEvent(line));
    case 'opencode-cli': return (line: string) => singleEventEnvelope(openCodeParser.parse(line));
    case 'openai-api':
    case 'anthropic-api':
      throw new Error(
        `[session-manager:resolveProviderParser] ${provider} is a managed-loop provider and has no stdout parser`,
      );
    default:
      return assertNeverProvider(provider, 'session-manager:resolveProviderParser');
  }
}

/**
 * Test-only handle exposing the provider switch resolvers. Tests use this
 * to verify the fail-fast behavior of every switch without standing up a
 * full SessionManager (which would need a real DB, messenger, etc.). Not
 * part of the public runtime API — production code must use the SessionManager
 * methods, which apply the upstream `assertKnownProvider` guard first.
 */
export const __provider_switch_for_test = {
  getProviderBinary(provider: string): string {
    if (!isProviderId(provider)) {
      throw new Error(
        `[session-manager:test] unknown provider id: ${JSON.stringify(provider)}. ` +
          `Valid: ${PROVIDER_IDS.join(', ')}.`,
      );
    }
    return resolveProviderBinary(provider);
  },
  getProviderArgs(
    provider: string,
    systemPrompt: string,
    cwd: string,
    resumeSessionId: string | undefined,
    model: string | undefined,
    pluginDirs: string[],
    providerConfig?: Record<string, unknown>,
  ): string[] {
    if (!isProviderId(provider)) {
      throw new Error(
        `[session-manager:test] unknown provider id: ${JSON.stringify(provider)}. ` +
          `Valid: ${PROVIDER_IDS.join(', ')}.`,
      );
    }
    return resolveProviderArgs(provider, systemPrompt, cwd, resumeSessionId, model, pluginDirs, providerConfig);
  },
  getParser(provider: string): ProviderEventParser {
    if (!isProviderId(provider)) {
      throw new Error(
        `[session-manager:test] unknown provider id: ${JSON.stringify(provider)}. ` +
          `Valid: ${PROVIDER_IDS.join(', ')}.`,
      );
    }
    // Construct a fresh parser for the OpenCode case — tests don't need the
    // per-session statefulness, just shape-check that a function is returned.
    return resolveProviderParser(provider, createOpenCodeParser());
  },
};

export class SessionManager {
  private static readonly SHUTDOWN_GRACE_MS = 5_000;
  private static readonly SPAWN_FAILURE_KILL_TIMEOUT_MS = 1_000;
  private readonly db: Database;
  private readonly messenger: Messenger;
  private readonly chatJid: string;
  private readonly conversationKey: string;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly instanceName: string;
  private configuredCwd: string | undefined;
  private readonly configRoot: string | undefined;
  private readonly configSystemPrompt: string | undefined;
  private readonly instructionsPath: string | undefined;
  private readonly model: string | undefined;
  private readonly pluginDirs: string[];
  private readonly allowM365Mutations: boolean | undefined;
  private readonly provider: string;
  private readonly providerConfig: Record<string, unknown> | undefined;
  private readonly mcpBridge: ProviderMcpBridge | undefined;
  private readonly mcpSessionContext: SessionContext | undefined;
  private readonly whatsoupInstance: string | undefined;
  private readonly whatsoupMcpSocket: string | undefined;
  private readonly handoffSystemBlock: (() => string | null) | undefined;
  private readonly routingSystemBlock: (() => string | null) | undefined;

  private systemPrompt: string = '';

  private child: ReturnType<typeof spawn> | null = null;
  private managedProviderSession: ProviderSession | null = null;
  private dbRowId: number | null = null;
  private sessionId: string | null = null;
  private active = false;
  private stdoutChunks: Buffer[] = [];
  private stdoutBufferStr = '';
  private startedAt: string | null = null;
  private messageCount: number = 0;
  private lastMessageAt: string | null = null;
  private watchdogSoft: ReturnType<typeof setTimeout> | null = null;
  private watchdogWarn: ReturnType<typeof setTimeout> | null = null;
  private watchdogHard: ReturnType<typeof setTimeout> | null = null;
  /**
   * Synchronous ownership token for the provider request boundary. Watchdog
   * timers are deliberately separate: provider activity rearms those timers,
   * but only an admitted terminal result or a proven-dead provider may release
   * this token.
   */
  private providerTurnInFlight = false;
  private nextProviderTurnToken = 0;
  private activeProviderTurnToken: number | null = null;
  private providerTurnTerminalPromise: Promise<void> = Promise.resolve();
  private providerTurnTerminalResolve: (() => void) | null = null;
  /** Bounded kill timer for a stalled tool; armed by recoverStalledOperation. */
  private stalledOpKill: ReturnType<typeof setTimeout> | null = null;
  private pendingToolIds: Set<string> = new Set();
  /** Codex app-server thread ID for persistent sessions. */
  private codexThreadId: string | null = null;
  /** Monotonic counter for Codex JSON-RPC request IDs. */
  private codexRequestSeq = 0;
  /** Gemini ACP session ID captured from session/new response. */
  private geminiSessionId: string | null = null;
  /** Monotonic counter for Gemini ACP JSON-RPC request IDs. */
  private geminiRequestSeq = 0;
  /**
   * Deferred promise that resolves when the provider's init event fires
   * (i.e. codexThreadId or geminiSessionId is captured). Replaces busy-wait
   * polling loops with an event-driven ready signal.
   */
  private providerReadyPromise: Promise<void> | null = null;
  private providerReadyResolve: (() => void) | null = null;
  /** Session ID passed to --resume, cleared once the process exits. */
  private resumeAttemptId: string | null = null;
  /** Prevents cleanup shutdown from repainting an already-terminal durable lifecycle as resumable. */
  private durableFailureClosed = false;
  /** JSON-RPC request ID of the thread/start call when resuming a Codex thread.
   *  Used to detect error responses and trigger fallback to a fresh thread. */
  private codexResumeThreadStartReqId: string | null = null;
  /** Called instead of the crash message when a --resume attempt is rejected. */
  private readonly onResumeFailed: (() => void) | undefined;
  /** Called when the session crashes unexpectedly (not for resume failures). */
  private readonly onCrash: ((info: SessionCrashInfo) => void) | undefined;
  /**
   * Optional override for crash notification delivery. When provided, the crash
   * message is passed to this callback (allowing the runtime to route it through
   * the outbound queue so it arrives after any buffered turn output). When absent,
   * falls back to a direct messenger.send call.
   */
  private readonly notifyUser: ((msg: string) => void) | undefined;

  private lastCrashNotifiedAt: number | null = null;
  private static readonly CRASH_NOTIFY_COOLDOWN_MS = 60_000;
  private readonly childGenerations = new WeakMap<
    ReturnType<typeof spawn>,
    SessionGenerationIdentity | null
  >();
  private readonly childTreeMarkers = new WeakMap<ReturnType<typeof spawn>, string>();
  private readonly shutdownKillTimers = new Map<
    ReturnType<typeof spawn>,
    ShutdownKillTimerEntry
  >();
  private crashStderrPreview = '';
  private resolveGenerationOwnership: (() => SessionGenerationIdentity | null) | null = null;
  private managedProviderGeneration: SessionGenerationIdentity | null = null;

  private durability: DurabilityEngine | null = null;

  /** Per-session OpenCode parser — avoids shared module-level state across chats. */
  private readonly openCodeParser: OpenCodeParser = createOpenCodeParser();

  /** Per-provider budget enforcement — null means unlimited (no budget config). */
  private budget: ProviderBudget | null = null;

  constructor(opts: SessionManagerOptions) {
    this.db = opts.db;
    this.messenger = opts.messenger;
    this.chatJid = opts.chatJid;
    this.conversationKey = toConversationKey(opts.chatJid);
    this.onEvent = opts.onEvent;
    this.instanceName = opts.instanceName ?? 'personal';
    this.onResumeFailed = opts.onResumeFailed;
    this.onCrash = opts.onCrash;
    this.notifyUser = opts.notifyUser;
    this.configuredCwd = opts.cwd;
    this.configRoot = opts.configRoot;
    this.configSystemPrompt = opts.configSystemPrompt;
    this.instructionsPath = opts.instructionsPath;
    this.model = opts.model;
    this.pluginDirs = opts.pluginDirs ?? [];
    this.allowM365Mutations = opts.allowM365Mutations;
    this.provider = opts.provider ?? 'claude-cli';
    // Fail-fast on unknown provider IDs (#447). The shared validator blocks
    // these at config-load time, but direct instantiation (tests, programmatic
    // callers) must still surface the error here — otherwise the old silent
    // alias to Claude semantics returns.
    if (!isProviderId(this.provider)) {
      throw new Error(
        `[session-manager] unknown provider id: ${JSON.stringify(this.provider)}. ` +
          `Valid: ${PROVIDER_IDS.join(', ')}.`,
      );
    }
    this.providerConfig = opts.providerConfig;
    this.mcpBridge = opts.mcpBridge;
    this.mcpSessionContext = opts.mcpSessionContext;
    this.whatsoupInstance = opts.whatsoupInstance;
    this.whatsoupMcpSocket = opts.whatsoupMcpSocket;
    this.handoffSystemBlock = opts.handoffSystemBlock;
    this.routingSystemBlock = opts.routingSystemBlock;

    // Initialize budget enforcement if configured
    const budgetConfig = opts.providerConfig?.budget as BudgetConfig | undefined;
    if (budgetConfig) {
      this.budget = new ProviderBudget(opts.provider ?? 'claude-cli', budgetConfig);
    }
  }

  updateMcpActorJid(actorJid: string): void {
    if (this.mcpSessionContext) {
      this.mcpSessionContext.actorJid = actorJid;
    }
  }

  // ─── Provider helpers ─────────────────────────────────────────────────────

  /** Whether this provider uses a spawn-per-turn model (vs. long-running stdin pipe). */
  private get isSpawnPerTurn(): boolean {
    // Claude CLI, Codex app-server, and Gemini ACP are persistent subprocesses.
    // HTTP API providers are managed-loop sessions and never spawn a child.
    // Others (opencode) still spawn per turn.
    return !this.isManagedLoopProvider
      && this.provider !== 'claude-cli'
      && this.provider !== 'codex-cli'
      && this.provider !== 'gemini-cli';
  }

  private get isManagedLoopProvider(): boolean {
    return this.provider === 'openai-api' || this.provider === 'anthropic-api';
  }

  private createManagedProviderSession(): ProviderSession {
    switch (this.provider) {
      case 'openai-api':
        return new OpenAIApiProvider(this.providerConfig);
      case 'anthropic-api':
        return new AnthropicApiProvider(this.providerConfig);
      default:
        throw new Error(`Provider "${this.provider}" is not a managed-loop provider.`);
    }
  }

  private getProviderBinary(): string {
    const provider = this.assertKnownProvider('getProviderBinary');
    return resolveProviderBinary(provider);
  }

  private getProviderArgs(systemPrompt: string, cwd: string, resumeSessionId?: string): string[] {
    const provider = this.assertKnownProvider('getProviderArgs');
    return resolveProviderArgs(provider, systemPrompt, cwd, resumeSessionId, this.model, this.pluginDirs, this.providerConfig);
  }

  buildSystemPrompt(): string {
    const cwd = this.configuredCwd ?? homedir();
    const displayName = PROVIDER_DISPLAY_NAMES[this.provider] ?? this.provider;
    const transportPrelude = [
      `You are "${this.instanceName}", a personal ${displayName} agent running over WhatsApp.`,
      'Your responses are sent as WhatsApp messages — keep them concise.',
      'You have full access to the local machine via bypassPermissions mode.',
      `Working directory: ${cwd}`,
      POLL_DECISION_GUIDANCE,
    ].join('\n');
    const sources = [transportPrelude];

    const handoffBlock = this.handoffSystemBlock?.();
    if (handoffBlock) {
      sources.push(handoffBlock);
    }

    // NL routing prompt contract (slice 3). The callback is only wired when
    // agentOptions.nlRouting is on, so flag-off prompts stay byte-identical.
    const routingBlock = this.routingSystemBlock?.();
    if (routingBlock) {
      sources.push(routingBlock);
    }

    if (this.configSystemPrompt) {
      sources.push(this.configSystemPrompt);
    }

    if (this.instructionsPath) {
      const fullInstructionsPath = join(cwd, this.instructionsPath);
      let instructionsContent: string;
      try {
        instructionsContent = readFileSync(fullInstructionsPath, 'utf8');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read instructionsPath "${fullInstructionsPath}": ${message}`);
      }
      if (instructionsContent) {
        sources.push(instructionsContent);
      }
    }

    const systemPrompt = composeWithExactLineDedup(sources);
    if (systemPrompt.trim().length === 0) {
      throw new Error('Failed to build system prompt: composed prompt is empty');
    }
    return systemPrompt;
  }

  private getParser(): ProviderEventParser {
    const provider = this.assertKnownProvider('getParser');
    return resolveProviderParser(provider, this.openCodeParser);
  }

  /**
   * Narrow `this.provider` to {@link ProviderId} at runtime, throwing if the
   * field was somehow set to an unknown ID (defense in depth — the validator
   * blocks this at config-load time, but tests / direct instantiation can
   * bypass the validator). Closes #447 silent-alias hazard.
   */
  private assertKnownProvider(context: string): ProviderId {
    if (!isProviderId(this.provider)) {
      throw new Error(
        `[session-manager:${context}] unknown provider id: ${JSON.stringify(this.provider)}. ` +
          `Valid: ${PROVIDER_IDS.join(', ')}.`,
      );
    }
    return this.provider;
  }

  private resetStdoutBuffers(): void {
    this.stdoutChunks = [];
    this.stdoutBufferStr = '';
  }

  private sameGeneration(
    left: SessionGenerationIdentity | null,
    right: SessionGenerationIdentity | null,
  ): boolean {
    if (left === null || right === null) return left === right;
    return left.managerId === right.managerId && left.generation === right.generation;
  }

  private clearShutdownKillTimer(
    child: ReturnType<typeof spawn>,
    generation: SessionGenerationIdentity | null,
  ): void {
    const entry = this.shutdownKillTimers.get(child);
    if (!entry || !this.sameGeneration(entry.generation, generation)) return;
    clearTimeout(entry.timer);
    this.shutdownKillTimers.delete(child);
  }

  private armShutdownKillTimer(child: ReturnType<typeof spawn>): void {
    const generation = this.childGenerations.get(child) ?? null;
    const timer = setTimeout(() => {
      const entry = this.shutdownKillTimers.get(child);
      if (
        !entry ||
        entry.timer !== timer ||
        !this.sameGeneration(entry.generation, generation)
      ) return;

      this.shutdownKillTimers.delete(child);
      void this.killChildTree(child, 'SIGKILL').then(() => {
        log.warn({ pid: child.pid ?? null, chatJid: this.chatJid }, 'child did not exit after SIGTERM, sent SIGKILL');
      }).catch((err) => {
        log.debug({ err, pid: child.pid ?? null, chatJid: this.chatJid }, 'child exited before SIGKILL escalation');
      });
    }, SessionManager.SHUTDOWN_GRACE_MS);
    this.shutdownKillTimers.set(child, { generation, timer });
  }

  private killChildTree(
    child: ReturnType<typeof spawn>,
    signal: NodeJS.Signals,
  ): Promise<void> {
    let generationMarker = this.childTreeMarkers.get(child);
    if (generationMarker === undefined) {
      const generation = this.childGenerations.get(child) ?? null;
      generationMarker = generation === null
        ? `unbound:${randomUUID()}`
        : `${generation.managerId}:${generation.generation}:${randomUUID()}`;
      this.childTreeMarkers.set(child, generationMarker);
    }
    return killSessionTree(child, signal, {
      generationMarker,
      termGraceMs: SessionManager.SHUTDOWN_GRACE_MS,
    });
  }

  private materializeStdoutChunks(): void {
    if (this.stdoutChunks.length === 0) return;
    const bufferedChunk = this.stdoutChunks.length === 1
      ? this.stdoutChunks[0]
      : Buffer.concat(this.stdoutChunks);
    this.stdoutBufferStr += bufferedChunk.toString('utf8');
    this.stdoutChunks = [];
  }

  private extractCompleteStdoutLines(): string[] {
    this.materializeStdoutChunks();
    const lines = this.stdoutBufferStr.split('\n');
    this.stdoutBufferStr = lines.pop() ?? '';
    // QR-064: drop a runaway no-newline buffer past the cap (never a valid
    // newline-terminated event) to bound parent memory.
    if (this.stdoutBufferStr.length > MAX_STDOUT_LINE_BYTES) {
      log.warn({ sessionId: this.sessionId, provider: this.provider, bytes: this.stdoutBufferStr.length, cap: MAX_STDOUT_LINE_BYTES }, 'provider stdout line exceeded cap — dropping runaway no-newline buffer');
      this.stdoutBufferStr = '';
    }
    return lines;
  }

  private appendStdoutChunk(chunk: Buffer): string[] {
    this.stdoutChunks.push(chunk);
    return this.extractCompleteStdoutLines();
  }

  private drainBufferedStdoutLines(): string[] {
    this.materializeStdoutChunks();
    if (this.stdoutBufferStr.trim() === '') {
      this.stdoutBufferStr = '';
      return [];
    }
    const lines = this.stdoutBufferStr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    this.stdoutBufferStr = '';
    return lines;
  }

  private handleProviderEvent(event: AgentEvent): void {
    // Debug: log all events for non-Claude providers
    if (this.provider !== 'claude-cli') {
      log.debug({ provider: this.provider, eventType: event.type, sessionId: event.type === 'init' ? event.sessionId : undefined, dbRowId: this.dbRowId }, 'handleProviderEvent');
    }

    if (event.type === 'init' && this.dbRowId !== null) {
      this.sessionId = event.sessionId;
      log.info({ provider: this.provider, chatJid: this.chatJid, sessionId: event.sessionId }, 'provider: captured sessionId');
      updateSessionId(this.db, this.dbRowId, event.sessionId);

      // Codex app-server: capture threadId from thread/started notification
      if (this.provider === 'codex-cli' && event.sessionId) {
        this.codexThreadId = event.sessionId;
        this.codexResumeThreadStartReqId = null; // resume succeeded, clear tracking
        log.info({ chatJid: this.chatJid, codexThreadId: this.codexThreadId }, 'codex: captured threadId');
      }

      // Gemini ACP: capture sessionId from session/new response
      if (this.provider === 'gemini-cli' && event.sessionId) {
        this.geminiSessionId = event.sessionId;
        log.info({ chatJid: this.chatJid, geminiSessionId: this.geminiSessionId }, 'gemini: captured sessionId');
      }

      // Resolve the provider-ready promise for Codex/Gemini persistent sessions
      if (this.providerReadyResolve) {
        this.providerReadyResolve();
        this.providerReadyResolve = null;
      }

      if (this.provider === 'claude-cli') {
        const transcriptPath = join(
          homedir(),
          '.claude',
          'projects',
          `-home-${userInfo().username}`,
          `${event.sessionId}.jsonl`,
        );
        updateTranscriptPath(this.db, this.dbRowId, transcriptPath);
      }

      if (this.durability) {
        this.durability.upsertSessionCheckpoint(this.conversationKey, {
          sessionId: this.sessionId,
        });
      }
    }

    // Record token usage for budget tracking on result and token_usage events
    if ((event.type === 'result' || event.type === 'token_usage') && this.budget) {
      const { inputTokens, outputTokens } = event;
      if (inputTokens !== undefined || outputTokens !== undefined) {
        this.budget.recordUsage(
          { input: inputTokens, output: outputTokens },
          this.chatJid,
        );
      }
    }

    this.onEvent(event);
  }

  /**
   * Write a JSON-RPC request to a Codex app-server child process.
   * Uses newline-delimited JSON (nd-JSON) framing.
   */
  private sendCodexRequest(
    child: ReturnType<typeof spawn>,
    method: string,
    params: Record<string, unknown>,
  ): string {
    const id = `ws-${++this.codexRequestSeq}`;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params, id });
    child.stdin!.write(msg + '\n');
    log.debug({ method, id, chatJid: this.chatJid }, 'codex: sent JSON-RPC request');
    return id;
  }

  /**
   * Write a JSON-RPC response to a Codex app-server server-initiated request
   * (e.g. auto-approving tool execution).
   */
  private sendCodexResponse(
    child: ReturnType<typeof spawn>,
    id: unknown,
    result: unknown,
  ): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
    child.stdin!.write(msg + '\n');
    log.debug({ id, chatJid: this.chatJid }, 'codex: sent JSON-RPC response');
  }

  /**
   * Handle Codex app-server server-initiated requests (approval callbacks).
   * Auto-approves all requests since we run in full-access mode.
   */
  private handleCodexServerRequest(parsed: Record<string, unknown>): void {
    if (!this.child) return;
    const id = parsed['id'];
    const method = String(parsed['method'] ?? '');

    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval' ||
      method === 'applyPatchApproval' ||
      method === 'execCommandApproval'
    ) {
      log.info({ method, id, chatJid: this.chatJid }, 'codex: auto-approving server request');
      this.sendCodexResponse(this.child, id, { decision: 'approved' });
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      // Cannot provide interactive input; deny gracefully
      log.warn({ method, id, chatJid: this.chatJid }, 'codex: denying user input request (non-interactive)');
      this.sendCodexResponse(this.child, id, { input: '' });
      return;
    }

    log.warn({ method, id, chatJid: this.chatJid }, 'codex: unhandled server request');
  }

  private buildSpawnPerTurnPrompt(text: string): string {
    if (!this.systemPrompt) return text;

    return [
      'System instructions:',
      this.systemPrompt,
      '',
      'User message:',
      text,
    ].join('\n');
  }

  private buildSpawnPerTurnArgs(cwd: string, text: string): string[] {
    const prompt = this.buildSpawnPerTurnPrompt(text);

    switch (this.provider) {
      // codex-cli and gemini-cli are now persistent, not spawn-per-turn.

      case 'opencode-cli': {
        // Custom endpoint (providerConfig.baseUrl): the model is resolved from
        // opencode.json's top-level `model` (written by the config merge), so
        // `-m` must be omitted — see opencodeUsesConfigModel.
        const modelArgs =
          this.model && !opencodeUsesConfigModel(this.providerConfig)
            ? ['-m', this.model]
            : [];
        if (this.sessionId && !this.sessionId.startsWith('opencode-cli-')) {
          // Resume previous session for multi-turn memory
          log.info({ chatJid: this.chatJid, provider: this.provider, sessionId: this.sessionId }, 'opencode: resuming session');
          return [
            'run',
            '--format', 'json',
            '--pure',
            '--agent', WHATSOUP_OPENCODE_AGENT_ID,
            '--session', this.sessionId,
            ...modelArgs,
            prompt,
          ];
        }
        log.info({ chatJid: this.chatJid, provider: this.provider }, 'opencode: fresh session');
        return [
          'run',
          '--format', 'json',
          '--pure',
          '--agent', WHATSOUP_OPENCODE_AGENT_ID,
          ...modelArgs,
          prompt,
        ];
      }

      default:
        return this.getProviderArgs('', cwd);
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Return the agent_sessions DB row ID for the current session, or null if not yet created. */
  getDbRowId(): number | null {
    return this.dbRowId;
  }

  trackToolStart(toolId: string): void {
    this.pendingToolIds.add(toolId);
  }

  trackToolEnd(toolId: string): void {
    this.pendingToolIds.delete(toolId);
  }

  get hasPendingTools(): boolean {
    return this.pendingToolIds.size > 0;
  }

  setDurability(engine: DurabilityEngine): void {
    this.durability = engine;
  }

  private updateCheckpointStatus(
    sessionStatus: string,
    exactSessionId: string | null = this.sessionId ?? this.resumeAttemptId,
  ): void {
    if (!this.durability) return;
    if (
      exactSessionId !== null
      && typeof this.durability.updateSessionCheckpointsStatusBySessionId === 'function'
    ) {
      this.durability.updateSessionCheckpointsStatusBySessionId(
        exactSessionId,
        sessionStatus,
      );
      return;
    }
    this.durability.upsertSessionCheckpoint(this.conversationKey, { sessionStatus });
  }

  private persistSessionLifecycleStart(
    pid: number,
    cwd: string,
    resumeSessionId: string | undefined,
    existingRowId: number | undefined,
  ): number {
    if (
      this.durability
      && resumeSessionId === undefined
      && typeof this.durability.beginFreshSessionLifecycle === 'function'
    ) {
      return this.durability.beginFreshSessionLifecycle({
        pid,
        cwd,
        chatJid: this.chatJid,
        workspaceKey: this.conversationKey,
        provider: this.provider,
        conversationKey: this.conversationKey,
      });
    }
    if (
      this.durability
      && resumeSessionId !== undefined
      && typeof this.durability.reactivateSessionLifecycle === 'function'
    ) {
      return this.durability.reactivateSessionLifecycle({
        ...(existingRowId === undefined ? {} : { agentSessionRowId: existingRowId }),
        providerSessionId: resumeSessionId,
        provider: this.provider,
        pid,
      });
    }

    const rowId = existingRowId === undefined
      ? createSession(
          this.db,
          pid,
          cwd,
          this.chatJid,
          this.conversationKey,
          this.provider,
        )
      : existingRowId;
    if (existingRowId !== undefined) {
      if (resumeSessionId === undefined) {
        updateSessionStatus(this.db, rowId, 'active');
      } else {
        updateResumedSessionStatus(
          this.db,
          rowId,
          resumeSessionId,
          this.provider,
          'active',
        );
      }
    }
    if (this.durability) {
      if (
        resumeSessionId === undefined
        && typeof this.durability.beginFreshSessionCheckpoint === 'function'
      ) {
        this.durability.beginFreshSessionCheckpoint(
          this.conversationKey,
          pid || undefined,
        );
      } else {
        this.updateCheckpointStatus('active', resumeSessionId ?? null);
      }
    }
    return rowId;
  }

  private resetFailedSessionStart(preservedChild: ReturnType<typeof spawn> | null = null): void {
    this.completeProviderTurn();
    this.active = false;
    this.child = preservedChild;
    this.managedProviderSession = null;
    this.managedProviderGeneration = null;
    this.dbRowId = null;
    this.sessionId = null;
    this.resetStdoutBuffers();
    this.startedAt = null;
    this.messageCount = 0;
    this.lastMessageAt = null;
    this.pendingToolIds.clear();
    this.codexThreadId = null;
    this.codexRequestSeq = 0;
    this.geminiSessionId = null;
    this.geminiRequestSeq = 0;
    this.providerReadyPromise = null;
    this.providerReadyResolve = null;
    this.resumeAttemptId = null;
    this.codexResumeThreadStartReqId = null;
  }

  private retireUnsupportedResume(
    providerSessionId: string,
    existingRowId: number,
  ): void {
    if (
      this.durability
      && typeof this.durability.retireSessionLifecycle === 'function'
    ) {
      this.durability.retireSessionLifecycle({
        agentSessionRowId: existingRowId,
        providerSessionId,
        provider: this.provider,
      });
    } else {
      updateResumedSessionStatus(
        this.db,
        existingRowId,
        providerSessionId,
        this.provider,
        'ended',
      );
      this.updateCheckpointStatus('ended', providerSessionId);
    }
    this.durableFailureClosed = true;
  }

  private closeDurableFailureLifecycle(
    exactSessionId: string | null,
    exactRowId: number | null,
    rowStatus: 'crashed' | 'resume_failed' = 'crashed',
  ): void {
    if (
      exactRowId !== null
      && this.durability
      && typeof this.durability.closeSessionLifecycleFailure === 'function'
    ) {
      this.durability.closeSessionLifecycleFailure({
        agentSessionRowId: exactRowId,
        providerSessionId: exactSessionId,
        provider: this.provider,
        conversationKey: this.conversationKey,
        agentStatus: rowStatus,
      });
    } else {
      if (exactRowId !== null) {
        if (exactSessionId === null) {
          updateSessionStatus(this.db, exactRowId, rowStatus);
        } else {
          updateResumedSessionStatus(
            this.db,
            exactRowId,
            exactSessionId,
            this.provider,
            rowStatus,
          );
        }
      }
      this.updateCheckpointStatus('orphaned', exactSessionId);
    }
    this.durableFailureClosed = true;
  }

  bindGenerationOwnership(resolve: () => SessionGenerationIdentity | null): void {
    this.resolveGenerationOwnership = resolve;
  }

  private isCurrentPersistentChild(
    child: ReturnType<typeof spawn>,
    captured: SessionGenerationIdentity | null,
  ): boolean {
    if (this.child !== child) return false;
    return this.isCurrentGeneration(captured);
  }

  private isCurrentGeneration(captured: SessionGenerationIdentity | null): boolean {
    if (this.resolveGenerationOwnership === null) return captured === null;
    if (captured === null) return false;
    const current = this.resolveGenerationOwnership();
    return current?.managerId === captured.managerId && current.generation === captured.generation;
  }

  private isCurrentManagedProviderSession(
    providerSession: ProviderSession | null,
    generationIdentity: SessionGenerationIdentity | null,
  ): boolean {
    return providerSession !== null &&
      this.active &&
      this.managedProviderSession === providerSession &&
      this.sameGeneration(this.managedProviderGeneration, generationIdentity) &&
      this.isCurrentGeneration(generationIdentity);
  }

  private async killFailedSpawnAndWait(child: ReturnType<typeof spawn>): Promise<void> {
    if (
      typeof child.exitCode === 'number' ||
      (child.signalCode !== null && child.signalCode !== undefined)
    ) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const exited = new Promise<void>((resolve, reject) => {
      child.on('exit', () => {
        if (timeout !== null) clearTimeout(timeout);
        timeout = null;
        resolve();
      });
      timeout = setTimeout(() => {
        timeout = null;
        reject(new Error(`Timed out waiting for failed spawn process ${child.pid ?? 'unknown'} to exit`));
      }, SessionManager.SPAWN_FAILURE_KILL_TIMEOUT_MS);
    });

    try {
      await Promise.all([
        this.killChildTree(child, 'SIGKILL'),
        exited,
      ]);
    } catch (err) {
      if (timeout !== null) clearTimeout(timeout);
      throw err;
    }
  }

  async spawnSession(resumeSessionId?: string, existingRowId?: number): Promise<void> {
    this.db.assertWritableCompatibility();
    if (this.active && (this.child !== null || this.managedProviderSession !== null)) {
      return;
    }
    const provider = this.assertKnownProvider('spawnSession');
    let resolvedRowId = existingRowId;
    if (resumeSessionId !== undefined) {
      resolvedRowId = resolveResumableAgentSession(this.db, {
        provider,
        providerSessionId: resumeSessionId,
        ...(existingRowId === undefined ? {} : { agentSessionRowId: existingRowId }),
        workspaceKey: this.conversationKey,
      }).id;
    }
    if (resumeSessionId !== undefined && !providerSupportsResume(provider)) {
      this.retireUnsupportedResume(resumeSessionId, resolvedRowId!);
      throw new Error(`Provider '${provider}' does not support persisted session resume`);
    }
    this.durableFailureClosed = false;

    const cwd = this.configuredCwd ?? homedir();

    const systemPrompt = this.buildSystemPrompt();

    if (this.isManagedLoopProvider) {
      const providerSession = this.createManagedProviderSession();
      const managedGeneration = this.resolveGenerationOwnership?.() ?? null;

      this.managedProviderSession = providerSession;
      this.managedProviderGeneration = managedGeneration;
      this.active = true;
      this.resetStdoutBuffers();
      this.crashStderrPreview = '';
      this.startedAt = new Date().toISOString();
      this.messageCount = 0;
      this.lastMessageAt = null;
      this.systemPrompt = systemPrompt;
      this.configuredCwd = cwd;
      this.resumeAttemptId = null;

      try {
        this.dbRowId = this.persistSessionLifecycleStart(
          0,
          cwd,
          resumeSessionId,
          resolvedRowId,
        );
      } catch (err) {
        log.error({ err, chatJid: this.chatJid, provider: this.provider }, 'session: failed to persist managed provider');
        this.resetFailedSessionStart();
        throw err;
      }

      try {
        await providerSession.initialize({
          cwd,
          systemPrompt,
          model: this.model,
          pluginDirs: this.pluginDirs,
          allowM365Mutations: this.allowM365Mutations,
          instanceName: this.instanceName,
          onEvent: (event) => {
            if (!this.isCurrentManagedProviderSession(providerSession, managedGeneration)) return;
            this.handleProviderEvent(event);
          },
          onCrash: ({ exitCode, signal, provider, crashClass, stderrPreview }) => {
            if (!this.isCurrentManagedProviderSession(providerSession, managedGeneration)) {
              log.debug({
                chatJid: this.chatJid,
                managerId: managedGeneration?.managerId ?? null,
                generation: managedGeneration?.generation ?? null,
              }, 'managed provider crash dropped — superseded generation');
              return;
            }
            const crashedSessionId = this.sessionId;
            const crashedDbRowId = this.dbRowId;
            this.closeDurableFailureLifecycle(
              crashedSessionId ?? resumeSessionId ?? null,
              crashedDbRowId,
            );
            this.completeProviderTurn();
            this.active = false;
            this.managedProviderSession = null;
            this.managedProviderGeneration = null;
            this.sessionId = null;
            this.onCrash?.({
              exitCode,
              signal: signal as NodeJS.Signals | null,
              sessionId: crashedSessionId,
              dbRowId: crashedDbRowId,
              generationIdentity: managedGeneration,
              ...this.buildCrashMetadata(crashClass, stderrPreview, provider ?? this.provider),
            });
          },
          mcpBridge: this.mcpBridge,
        });
      } catch (err) {
        log.error({ err, chatJid: this.chatJid, provider: this.provider }, 'managed provider failed to initialize');
        this.closeDurableFailureLifecycle(
          this.sessionId ?? resumeSessionId ?? null,
          this.dbRowId,
        );
        this.completeProviderTurn();
        this.active = false;
        this.managedProviderSession = null;
        this.managedProviderGeneration = null;
        this.dbRowId = null;
        this.sessionId = null;
        this.startedAt = null;
        this.messageCount = 0;
        this.lastMessageAt = null;
        throw err;
      }

      this.updateCheckpointStatus('active', this.sessionId ?? resumeSessionId ?? null);

      log.info({
        provider: this.provider,
        chatJid: this.chatJid,
        cwd,
        rowId: this.dbRowId,
        existingRowId: resolvedRowId ?? null,
        resumeSessionId: resumeSessionId ?? null,
      }, 'managed-loop provider session initialized');
      return;
    }

    // Spawn-per-turn providers (codex, gemini, opencode) should NOT eagerly spawn
    // at session init — they spawn a fresh process per sendTurn() with the prompt as CLI arg.
    // Mark active and return; the first sendTurn() will spawn the actual process.
    if (this.isSpawnPerTurn) {
      this.active = true;
      this.startedAt = new Date().toISOString();
      this.systemPrompt = systemPrompt;
      this.configuredCwd = cwd;
      this.crashStderrPreview = '';
      this.sessionId = resumeSessionId ?? null;
      try {
        this.dbRowId = this.persistSessionLifecycleStart(
          0,
          cwd,
          resumeSessionId,
          resolvedRowId,
        );
      } catch (err) {
        log.error({ err, chatJid: this.chatJid, provider: this.provider }, 'session: failed to persist spawn-per-turn provider');
        this.resetFailedSessionStart();
        throw err;
      }
      log.info({
        provider: this.provider,
        chatJid: this.chatJid,
        cwd,
        rowId: this.dbRowId,
        existingRowId: resolvedRowId ?? null,
        resumeSessionId: resumeSessionId ?? null,
      }, 'spawn-per-turn session armed');
      // Emit a synthetic init event so the runtime knows the session is ready
      this.onEvent({
        type: 'init',
        sessionId: resumeSessionId ?? `${this.provider}-${Date.now()}`,
      });
      return;
    }

    const binary = this.getProviderBinary();
    const args = this.getProviderArgs(systemPrompt, cwd, resumeSessionId);

    const child = spawn(binary, args, {
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Security: explicit env allowlist prevents credential leakage to child processes.
      // Without this, Node.js inherits process.env in full — meaning ALL secrets
      // (PINECONE_API_KEY, WHATSOUP_HEALTH_TOKEN, etc.) would flow into every subprocess.
      // Each provider only receives the credentials it actually needs.
      env: buildChildEnv(
        this.provider,
        {
          allowM365Mutations: this.allowM365Mutations,
          whatsoupInstance: this.whatsoupInstance,
          whatsoupMcpSocket: this.whatsoupMcpSocket,
          configRoot: this.configRoot,
        },
        this.model,
        this.providerConfig,
      ),
    });

    const childGeneration = this.resolveGenerationOwnership?.() ?? null;
    this.childGenerations.set(child, childGeneration);
    this.childTreeMarkers.set(
      child,
      childGeneration === null
        ? `unbound:${randomUUID()}`
        : `${childGeneration.managerId}:${childGeneration.generation}:${randomUUID()}`,
    );
    this.child = child;
    this.active = true;
    this.resetStdoutBuffers();
    this.crashStderrPreview = '';
    this.startedAt = new Date().toISOString();
    this.messageCount = 0;
    this.lastMessageAt = null;
    this.resumeAttemptId = resumeSessionId ?? null;

    // Persist the exact row/checkpoint lifecycle after spawn. If this fails the
    // detached child must be reaped before the manager can be considered reset.
    const pid = child.pid ?? 0;
    try {
      this.dbRowId = this.persistSessionLifecycleStart(
        pid,
        cwd,
        resumeSessionId,
        resolvedRowId,
      );
    } catch (err) {
      log.error({ err, pid, chatJid: this.chatJid, existingRowId: resolvedRowId ?? null }, 'session: failed to persist spawned child lifecycle');
      let cleanupError: unknown = null;
      try {
        await this.killFailedSpawnAndWait(child);
      } catch (killErr) {
        cleanupError = killErr;
        log.warn({ err: killErr, pid, chatJid: this.chatJid }, 'session: failed to kill child after db persistence error');
      }
      this.resetFailedSessionStart(cleanupError === null ? null : child);
      if (cleanupError !== null) {
        throw new AggregateError([err, cleanupError], 'Session spawn persistence and child cleanup both failed');
      }
      throw err;
    }

    log.info({ pid, rowId: this.dbRowId, wasResume: resumeSessionId !== undefined, resumeSessionId: resumeSessionId ?? null, provider: this.provider, binary }, `spawned ${binary} process`);

    // Create deferred ready promise for providers that need async init
    if (this.provider === 'codex-cli' || this.provider === 'gemini-cli') {
      this.providerReadyPromise = new Promise<void>((resolve) => {
        this.providerReadyResolve = resolve;
      });
    }

    // Codex app-server: send initialize + thread/start after spawn
    if (this.provider === 'codex-cli') {
      this.codexThreadId = null;
      this.codexRequestSeq = 0;
      this.sendCodexRequest(child, 'initialize', {
        clientInfo: { name: 'WhatSoup', title: null, version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      const threadStartParams: Record<string, unknown> = {
        cwd,
        approvalPolicy: 'never' as const,
        sandbox: 'danger-full-access' as const,
        persistExtendedHistory: true,
        ...(systemPrompt ? { baseInstructions: systemPrompt } : {}),
      };
      // Resume: if a stored thread ID was provided, include it in thread/start
      // so the app-server resumes the existing conversation history.
      if (resumeSessionId) {
        threadStartParams.threadId = resumeSessionId;
        log.info({ chatJid: this.chatJid, resumeThreadId: resumeSessionId }, 'codex: attempting thread resume');
      }
      const threadStartId = this.sendCodexRequest(child, 'thread/start', threadStartParams);
      if (resumeSessionId) {
        this.codexResumeThreadStartReqId = threadStartId;
      }
    }

    // Gemini ACP: send initialize + session/new after spawn
    if (this.provider === 'gemini-cli') {
      this.geminiSessionId = null;
      this.geminiRequestSeq = 0;
      const initReq = buildInitializeRequest(++this.geminiRequestSeq);
      child.stdin!.write(initReq);
      const sessionReq = buildSessionNewRequest(++this.geminiRequestSeq, cwd, [], systemPrompt || undefined);
      child.stdin!.write(sessionReq);
      log.info({ chatJid: this.chatJid }, 'gemini: sent initialize + session/new');
    }

    // Handle spawn errors (e.g. claude binary not in PATH, out of resources)
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (!this.isCurrentPersistentChild(child, childGeneration)) return;
      this.completeProviderTurn();
      const failedSessionId = this.sessionId ?? this.resumeAttemptId;
      this.closeDurableFailureLifecycle(failedSessionId, this.dbRowId);
      this.resumeAttemptId = null;
      if (err.code === 'ENOENT') {
        // Binary not installed — configuration error, not a crash
        this.active = false;
        this.child = null;
        this.sessionId = null;
        log.error({ err, chatJid: this.chatJid, binary }, 'claude binary not found (ENOENT)');
        this.notifyUser?.(`_${this.getProviderBinary()} is not installed. Check your provider configuration._`);
        // Do NOT call onCrash — this is not a transient failure
        return;
      }
      log.error({ err, chatJid: this.chatJid }, 'claude process spawn error');
      this.active = false;
      this.child = null;
      this.sessionId = null;
      // Notify user — without this, spawn failures are silent and the chat goes dead
      this.notifyUser?.('_Agent failed to start — will retry on your next message._');
      this.onCrash?.({
        exitCode: null,
        signal: null,
        sessionId: null,
        dbRowId: null,
        generationIdentity: childGeneration,
        ...this.buildCrashMetadata('spawn_error', err.message),
      });
    });

    // Pipe stdout through line parser — use provider-specific parser
    const parse = this.getParser();
    child.stdout.on('data', (chunk: Buffer) => {
      if (!this.isCurrentPersistentChild(child, childGeneration)) {
        log.debug({
          chatJid: this.chatJid,
          pid: child.pid ?? null,
          managerId: childGeneration?.managerId ?? null,
          generation: childGeneration?.generation ?? null,
        }, 'persistent child stdout dropped — superseded generation');
        return;
      }
      const lines = this.appendStdoutChunk(chunk);
      for (const line of lines) {
        if (!this.active || !this.isCurrentPersistentChild(child, childGeneration)) return;
        // Codex app-server: intercept server-initiated requests (approval callbacks)
        // before they reach the parser. These have both 'id' and 'method'.
        if (this.provider === 'codex-cli' && line[0] === '{' && line.includes('"jsonrpc"')) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg['jsonrpc'] === '2.0' && msg['id'] !== undefined && typeof msg['method'] === 'string') {
              this.handleCodexServerRequest(msg);
              continue;
            }
            // Detect error response to a resume thread/start request.
            // When the app-server rejects a threadId, it returns an error
            // response instead of a result — clear the stale ID and retry fresh.
            if (
              msg['jsonrpc'] === '2.0' &&
              msg['id'] !== undefined &&
              msg['error'] !== undefined &&
              this.codexResumeThreadStartReqId !== null &&
              String(msg['id']) === this.codexResumeThreadStartReqId
            ) {
              const errorObj = msg['error'] as Record<string, unknown>;
              const errorMsg = typeof errorObj === 'object' && errorObj !== null
                ? String((errorObj as Record<string, unknown>)['message'] ?? 'unknown')
                : String(errorObj);
              log.warn({ chatJid: this.chatJid, reqId: msg['id'], error: errorMsg }, 'codex: thread resume rejected — retrying with fresh thread');
              this.codexResumeThreadStartReqId = null;
              // Clear the stale thread ID so it won't be retried again
              if (this.dbRowId !== null) {
                updateSessionId(this.db, this.dbRowId, '');
              }
              // Send a fresh thread/start without threadId
              this.sendCodexRequest(child, 'thread/start', {
                cwd: this.configuredCwd ?? homedir(),
                approvalPolicy: 'never' as const,
                sandbox: 'danger-full-access' as const,
                persistExtendedHistory: true,
                ...(this.systemPrompt ? { baseInstructions: this.systemPrompt } : {}),
              });
              continue;
            }
          } catch {
            // Fall through to normal parsing
          }
        }

        for (const event of parse(line)) {
          if (!this.active || !this.isCurrentPersistentChild(child, childGeneration)) return;
          this.handleProviderEvent(event);
          if (!this.active || !this.isCurrentPersistentChild(child, childGeneration)) return;
        }
      }
    });

    // Log stderr but don't act on it
    child.stderr.on('data', (chunk: Buffer) => {
      if (!this.isCurrentPersistentChild(child, childGeneration)) {
        log.debug({
          chatJid: this.chatJid,
          pid: child.pid ?? null,
          managerId: childGeneration?.managerId ?? null,
          generation: childGeneration?.generation ?? null,
        }, 'persistent child stderr dropped — superseded generation');
        return;
      }
      const nextPreview = appendProviderCrashPreview(this.crashStderrPreview, chunk);
      if (nextPreview === this.crashStderrPreview) return;
      this.crashStderrPreview = nextPreview;
      if (!this.crashStderrPreview) return;
      log.warn({
        provider: this.provider,
        chatJid: this.chatJid,
        pid: child.pid ?? null,
        stderrPreview: this.crashStderrPreview.slice(-500),
      }, 'claude stderr');
    });

    // Handle unexpected exit
    child.on('exit', (code, signal) => {
      // Ignore exit events from superseded child processes.
      // This prevents a race where /new kills P1 and spawns P2, then P1's
      // delayed SIGTERM exit fires against P2's active state.
      const superseded = this.child !== child;
      this.clearShutdownKillTimer(child, childGeneration);
      if (superseded) return;

      if (!this.active) {
        // Clean shutdown — the caller retains its local child reference while
        // process-tree proof finishes, but this manager must not retain an
        // already-exited exact child handle. Pointer identity above prevents a
        // stale generation from clearing a replacement child.
        this.child = null;
        return;
      }

      if (!this.isCurrentPersistentChild(child, childGeneration)) return;

      this.clearStalledOpKill();

      // Drain any buffered stdout lines before crash processing.
      // The process may have written final output that was not yet newline-terminated.
      const bufferedLines = this.drainBufferedStdoutLines();
      if (bufferedLines.length > 0) {
        for (const line of bufferedLines) {
          if (!this.active || !this.isCurrentPersistentChild(child, childGeneration)) return;
          for (const event of parse(line)) {
            if (!this.active || !this.isCurrentPersistentChild(child, childGeneration)) return;
            this.handleProviderEvent(event);
            if (!this.active || !this.isCurrentPersistentChild(child, childGeneration)) return;
          }
        }
      }

      // Detect resume failure: --resume was used, Claude exited code 1, and
      // no init event arrived (session_id was never set). This means the saved
      // session ID was expired/unknown to Claude's backend.
      const attemptedSessionId = this.resumeAttemptId;
      const wasResumeAttempt = attemptedSessionId !== null;
      const initReceived = this.sessionId !== null;
      const isResumeFail = wasResumeAttempt && code === 1 && !initReceived;

      this.resumeAttemptId = null;

      if (isResumeFail) {
        log.warn({ code, rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, wasResumeAttempt, initReceived }, 'claude resume failed — session expired');
        this.closeDurableFailureLifecycle(
          this.sessionId ?? attemptedSessionId,
          this.dbRowId,
          'resume_failed',
        );
      } else {
        log.warn({ exitCode: code, signal, rowId: this.dbRowId, chatJid: this.chatJid, sessionId: this.sessionId, wasResumeAttempt, initReceived }, 'claude process exited unexpectedly');
        this.closeDurableFailureLifecycle(
          this.sessionId ?? attemptedSessionId,
          this.dbRowId,
        );
      }

      // Capture before clearing — onCrash handlers need these for auto-resume
      const crashedSessionId = this.sessionId;
      const crashedDbRowId = this.dbRowId;

      this.completeProviderTurn();
      this.active = false;
      this.child = null;
      this.sessionId = null;

      if (isResumeFail) {
        // Let the runtime handle notification + fresh spawn
        this.onResumeFailed?.();
      } else {
        // Allow the runtime to clean up the outbound queue (clears typing heartbeat).
        // onCrash does NOT send 'paused' — the composing indicator times out naturally,
        // acting as a soft signal to the user that the session is in trouble.
        this.onCrash?.({
          exitCode: code,
          signal,
          sessionId: crashedSessionId,
          dbRowId: crashedDbRowId,
          generationIdentity: childGeneration,
          ...this.buildCrashMetadata(),
        });
        this.notifyUnexpectedExit(code, signal, childGeneration);
      }
    });
  }

  private notifyUnexpectedExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    generationIdentity: SessionGenerationIdentity | null,
  ): void {
    // Exit code 0 = normal shutdown (e.g. /new, graceful stop) — skip notification entirely.
    if (code === 0 && !signal) {
      log.info({ rowId: this.dbRowId }, 'session exited cleanly (code 0) — no crash notification');
      return;
    }

    const reason = signal
      ? `terminated by signal ${signal}`
      : `exited with code ${code}`;
    const msg = `Agent session ended (${reason}). Send any message to start a new session.`;
    const chatJid = this.chatJid;
    setImmediate(() => {
      if (!this.isCurrentGeneration(generationIdentity)) return;
      const now = Date.now();
      const rateLimited =
        this.lastCrashNotifiedAt !== null &&
        now - this.lastCrashNotifiedAt < SessionManager.CRASH_NOTIFY_COOLDOWN_MS;
      if (rateLimited) {
        log.warn({ rowId: this.dbRowId }, 'crash notification suppressed (rate limited)');
        return;
      }
      this.lastCrashNotifiedAt = now;
      if (this.notifyUser) {
        this.notifyUser(msg);
        return;
      }
      this.messenger
        .sendMessage(chatJid, msg)
        .catch((err) => log.error({ err }, 'failed to send crash notice'));
    });
  }

  clearTurnWatchdog(): void {
    clearTimeout(this.watchdogSoft ?? undefined);
    clearTimeout(this.watchdogWarn ?? undefined);
    clearTimeout(this.watchdogHard ?? undefined);
    this.watchdogSoft = null;
    this.watchdogWarn = null;
    this.watchdogHard = null;
    this.pendingToolIds.clear();
  }

  /**
   * Release the exact provider request owner after its terminal result has been
   * admitted, or after the owning provider has been proven dead.
   */
  completeProviderTurn(expectedToken?: number): void {
    if (
      expectedToken !== undefined
      && this.activeProviderTurnToken !== expectedToken
    ) return;
    const resolveTerminal = this.providerTurnTerminalResolve;
    this.providerTurnInFlight = false;
    this.activeProviderTurnToken = null;
    this.providerTurnTerminalResolve = null;
    resolveTerminal?.();
    this.clearTurnWatchdog();
  }

  /** Wait for the exact request that currently owns this provider lane. */
  waitForProviderTurnToTerminalize(): Promise<void> {
    return this.providerTurnTerminalPromise;
  }

  /**
   * Reset all watchdog tiers — call on ANY agent activity (tool_use, tool_result,
   * assistant_text, compact_boundary) so that only truly stalled sessions are killed.
   */
  tickWatchdog(): void {
    if (!this.active || (this.child === null && this.managedProviderSession === null)) return;
    this.clearStalledOpKill(); // provider progress cancels the stalled-op kill (NOT cleared by inbound nudges)
    this.clearTurnWatchdog();
    this.armWatchdog();
  }

  /**
   * Called by the operation tracker when a tool exceeds its stall threshold. Interrupts
   * are impossible for stream-json providers, so the only recovery is to kill the hung
   * process. We arm a bounded kill timer rather than rely on the 30-min hard watchdog
   * alone, because that timer is reset by every inbound message (writeToSession) — so
   * re-prompting a hung session would postpone the kill indefinitely. This timer ignores
   * inbound messages; provider progress (tickWatchdog) cancels it.
   */
  recoverStalledOperation(toolId: string, toolName: string): void {
    if (!this.active || this.child === null) return;
    const ctx = { toolId, toolName, pid: this.child.pid, sessionId: this.sessionId };
    if (this.stalledOpKill !== null) {
      log.warn({ ...ctx, action: 'already-armed' }, 'operation stalled — kill already armed');
      return;
    }
    log.warn({ ...ctx, graceMs: STALLED_OP_KILL_GRACE_MS, action: 'arm-kill' }, 'operation stalled — arming stalled-operation kill');
    this.stalledOpKill = setTimeout(() => this.handleStalledOpKill(toolId, toolName), STALLED_OP_KILL_GRACE_MS);
  }

  private clearStalledOpKill(): void {
    if (this.stalledOpKill !== null) {
      clearTimeout(this.stalledOpKill);
      this.stalledOpKill = null;
    }
  }

  /**
   * SIGKILL a provider whose tool stalled past STALLED_OP_KILL_GRACE_MS. The exit handler
   * then emits the crash notice and the runtime auto-respawns on the next message.
   */
  private handleStalledOpKill(toolId: string, toolName: string): void {
    this.stalledOpKill = null;
    if (!this.active || this.child === null) return;
    log.warn(
      { sessionId: this.sessionId, pid: this.child.pid, toolId, toolName, reason: 'stalled_operation' },
      'stalled-operation kill fired — SIGKILL hung provider',
    );
    this.notifyUser?.('_A tool call stalled and was terminated. Send your message again to retry._');
    const child = this.child;
    void this.killChildTree(child, 'SIGKILL').catch((err) => {
      log.error({ err, pid: child.pid ?? null, chatJid: this.chatJid }, 'failed to reap stalled provider process tree');
    });
  }

  /**
   * Probe provider liveness when no events have been received for an extended period
   * (thinking stall). Sends a newline to stdin as a keepalive check — if the provider
   * is alive, it will produce some event in response. If no response comes within
   * the recovery grace period, the hard watchdog backstop will handle termination.
   */
  probeLiveness(): void {
    if (!this.active || this.child === null) return;
    log.warn({ pid: this.child.pid, sessionId: this.sessionId }, 'probing liveness — no events received');
    try {
      this.child.stdin?.write('\n');
    } catch (err) {
      log.error({ err }, 'failed to send liveness probe');
    }
  }

  private armWatchdog(
    managedProviderSession = this.managedProviderSession,
    managedProviderGeneration = this.managedProviderGeneration,
  ): void {
    // Only the hard backstop remains — soft/warn probes are replaced by the operation tracker.
    // The timeout honors the provider's descriptor (API providers: 10 min; CLI providers: 30 min)
    // instead of a single hardcoded constant (L1-F1).
    const watchdog = setTimeout(
      () => this.handleWatchdogHard(managedProviderSession, managedProviderGeneration, watchdog),
      watchdogHardMsForProvider(this.provider),
    );
    this.watchdogHard = watchdog;
  }

  private handleWatchdogHard(
    managedProviderSession = this.managedProviderSession,
    managedProviderGeneration = this.managedProviderGeneration,
    expectedWatchdog?: ReturnType<typeof setTimeout>,
  ): void {
    if (expectedWatchdog !== undefined && this.watchdogHard !== expectedWatchdog) return;
    this.watchdogHard = null;
    if (!this.active) return;

    const inactivityMinutes = Math.round(watchdogHardMsForProvider(this.provider) / 60_000);
    const terminationNotice = `_Session terminated after ${inactivityMinutes} minutes of inactivity — restarting._`;

    if (managedProviderSession !== null) {
      const accepted = this.crashManagedProviderSession(
        'managed provider turn watchdog fired',
        undefined,
        managedProviderSession,
        managedProviderGeneration,
      );
      if (accepted && this.isCurrentGeneration(managedProviderGeneration)) {
        log.warn({ sessionId: this.sessionId, provider: this.provider, reason: 'turn_watchdog' }, 'turn watchdog fired — killing stalled managed provider session');
        this.notifyUser?.(terminationNotice);
      }
      return;
    }

    if (this.managedProviderSession !== null) return;

    if (this.child === null) return;
    log.warn({ sessionId: this.sessionId, pid: this.child?.pid, reason: 'turn_watchdog' }, 'turn watchdog fired — killing stalled Claude process');
    // Notify user with a specific message before the kill — the generic crash
    // notice ("Agent session crashed") follows via the exit handler, but this
    // message explains WHY it was terminated.
    this.notifyUser?.(terminationNotice);
    const child = this.child;
    void this.killChildTree(child, 'SIGKILL').catch((err) => {
      log.error({ err, pid: child.pid ?? null, chatJid: this.chatJid }, 'failed to reap watchdog provider process tree');
    });
  }

  private crashManagedProviderSession(
    reason: string,
    err?: unknown,
    providerSession = this.managedProviderSession,
    generationIdentity = this.managedProviderGeneration,
  ): boolean {
    const crashedSessionId = this.sessionId;
    const crashedDbRowId = this.dbRowId;
    if (!this.isCurrentManagedProviderSession(providerSession, generationIdentity)) {
      log.debug({
        chatJid: this.chatJid,
        managerId: generationIdentity?.managerId ?? null,
        generation: generationIdentity?.generation ?? null,
        reason,
      }, 'managed provider crash dropped — superseded generation');
      return false;
    }

    this.completeProviderTurn();
    this.active = false;
    this.managedProviderSession = null;
    this.managedProviderGeneration = null;
    this.sessionId = null;

    if (providerSession !== null) {
      try {
        providerSession.kill();
      } catch (killErr) {
        log.debug({ err: killErr, provider: this.provider, chatJid: this.chatJid }, 'managed provider kill failed during crash cleanup');
      }
    }

    this.closeDurableFailureLifecycle(crashedSessionId, crashedDbRowId);

    log.warn({ err, provider: this.provider, chatJid: this.chatJid, sessionId: crashedSessionId, dbRowId: crashedDbRowId, reason }, 'managed provider session crashed');
    const errText = err instanceof Error ? `${err.name}: ${err.message}` : err === undefined ? undefined : String(err);
    const extraText = [reason, errText].filter(Boolean).join('\n');
    const fallbackClass = reason.includes('watchdog') ? 'provider_turn_watchdog' : 'managed_provider_error';
    this.onCrash?.({
      exitCode: null,
      signal: null,
      sessionId: crashedSessionId,
      dbRowId: crashedDbRowId,
      generationIdentity,
      ...this.buildCrashMetadata(fallbackClass, extraText),
    });
    return true;
  }

  private buildCrashMetadata(
    fallbackClass?: string,
    extraText?: string,
    provider = this.provider,
  ): Pick<SessionCrashInfo, 'provider' | 'crashClass' | 'stderrPreview'> {
    return buildProviderCrashMetadata({
      provider,
      existingPreview: this.crashStderrPreview,
      extraText,
      fallbackClass,
    });
  }

  /** Write a user message turn to the agent — via stdin (Claude) or spawn-per-turn (others). */
  async sendTurn(text: string): Promise<void> {
    this.db.assertWritableCompatibility();
    if (!this.active) {
      throw new Error('No active session. Call spawnSession() first.');
    }

    // Persistent provider streams do not expose a request identifier that can
    // be carried through every event. Acquire synchronously, before the first
    // await, so even a blocked stdin write cannot admit a second request.
    if (this.providerTurnInFlight) {
      throw new Error('PROVIDER_TURN_IN_FLIGHT: wait for the current provider request to terminalize');
    }

    // Budget enforcement: check rate/spend limits before dispatching the turn
    if (this.budget) {
      const check = this.budget.checkBudget(this.chatJid);
      if (!check.allowed) {
        log.warn({ chatJid: this.chatJid, reason: check.reason }, 'sendTurn throttled by budget');
        this.onEvent({ type: 'result', text: `_Throttled: ${check.reason}_` });
        return;
      }
    }

    // Reject deterministic configuration/state failures before taking the
    // request token. No provider boundary can have accepted work yet.
    if (this.isManagedLoopProvider && this.managedProviderSession === null) {
      throw new Error('Managed provider session is not initialized. Call spawnSession() first.');
    }
    if (!this.isManagedLoopProvider && !this.isSpawnPerTurn) {
      const child = this.child;
      if (child === null) {
        throw new Error('No active session. Call spawnSession() first.');
      }
      const generation = this.childGenerations.get(child) ?? null;
      if (!this.isCurrentPersistentChild(child, generation)) {
        throw new Error('Session generation was superseded before turn dispatch.');
      }
      if (!child.stdin) {
        throw new Error('Child process stdin is not available');
      }
    }

    this.providerTurnInFlight = true;
    const providerTurnToken = ++this.nextProviderTurnToken;
    this.activeProviderTurnToken = providerTurnToken;
    this.providerTurnTerminalPromise = new Promise<void>((resolve) => {
      this.providerTurnTerminalResolve = resolve;
    });

    if (this.isManagedLoopProvider) {
      // Pre-dispatch validation above proves this is non-null.
      if (this.managedProviderSession === null) throw new Error('Managed provider session is not initialized.');
      const providerSession = this.managedProviderSession;
      const generationIdentity = this.managedProviderGeneration;

      this.clearTurnWatchdog();
      this.armWatchdog(providerSession, generationIdentity);
      try {
        await providerSession.sendTurn({
          role: 'user',
          conversationKey: this.conversationKey,
          parts: [{ kind: 'text', text }],
          ...(this.model ? { model: this.model } : {}),
        });
      } catch (err) {
        const accepted = this.crashManagedProviderSession(
          'managed provider turn failed',
          err,
          providerSession,
          generationIdentity,
        );
        if (accepted && this.isCurrentGeneration(generationIdentity)) {
          this.notifyUser?.('Agent provider request failed — send any message to start a new session.');
        }
        throw err;
      }

      if (!this.isCurrentManagedProviderSession(providerSession, generationIdentity)) {
        throw new Error('Managed provider session ended before the turn completed.');
      }

      if (this.dbRowId !== null) {
        incrementMessageCount(this.db, this.dbRowId);
      }
      this.messageCount += 1;
      this.lastMessageAt = new Date().toISOString();
      return;
    }

    let persistentTurnChild: ReturnType<typeof spawn> | null = null;
    let persistentTurnGeneration: SessionGenerationIdentity | null = null;
    if (this.isSpawnPerTurn) {
      // Clear any partial JSON from the previous turn before spawning a new process.
      // Without this, leftover bytes in the buffer can corrupt the next turn's output.
      this.resetStdoutBuffers();
      this.crashStderrPreview = '';

      // Reset provider-specific parser state so the next turn's first step_start
      // is correctly recognized as an init event.
      if (this.provider === 'opencode-cli') {
        this.openCodeParser.reset();
      }

      // Spawn-per-turn providers: kill any existing process and spawn a new one
      // with the user prompt appended as a CLI argument.
      if (this.child) {
        const child = this.child;
        try {
          await this.killChildTree(child, 'SIGTERM');
        } catch (err) {
          this.completeProviderTurn(providerTurnToken);
          log.error({ err, pid: child.pid ?? null, chatJid: this.chatJid }, 'failed to reap replaced provider process tree');
          throw new Error('Cannot replace provider while prior process-tree cleanup is inconclusive', {
            cause: err,
          });
        }
        this.child = null;
      }

      const cwd = this.configuredCwd ?? homedir();

      let args: string[];
      let binary: string;
      let parse: ProviderEventParser;
      try {
        args = this.buildSpawnPerTurnArgs(cwd, text);
        binary = this.getProviderBinary();
        parse = this.getParser();
      } catch (err) {
        this.completeProviderTurn(providerTurnToken);
        throw err;
      }
      let sawResult = false;
      let boundarySettled = false;

      const dispatchSpawnPerTurnEvent = (event: AgentEvent): void => {
        if (this.activeProviderTurnToken !== providerTurnToken) return;
        if (event.type === 'result') sawResult = true;
        this.handleProviderEvent(event);
      };

      const child = (() => {
        try {
          return spawn(binary, args, {
            cwd,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: buildChildEnv(
              this.provider,
              {
                allowM365Mutations: this.allowM365Mutations,
                whatsoupInstance: this.whatsoupInstance,
                whatsoupMcpSocket: this.whatsoupMcpSocket,
                configRoot: this.configRoot,
              },
              this.model,
              this.providerConfig,
            ),
          });
        } catch (err) {
          this.completeProviderTurn(providerTurnToken);
          throw err;
        }
      })();

      const childGeneration = this.resolveGenerationOwnership?.() ?? null;
      this.childGenerations.set(child, childGeneration);
      this.childTreeMarkers.set(
        child,
        childGeneration === null
          ? `unbound:${randomUUID()}`
          : `${childGeneration.managerId}:${childGeneration.generation}:${randomUUID()}`,
      );
      this.child = child;

      // Spawn-per-turn providers receive their prompt as CLI args, not stdin.
      // Close stdin immediately so providers that read stdin (like Codex exec's
      // read_to_end()) don't block waiting for EOF.
      child.stdin.end();

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (!this.isCurrentPersistentChild(child, childGeneration) || boundarySettled) return;
        if (
          this.activeProviderTurnToken !== null
          && this.activeProviderTurnToken !== providerTurnToken
        ) return;
        boundarySettled = true;
        this.completeProviderTurn(providerTurnToken);
        // Release the pessimistic budget reservation — response will never arrive
        this.budget?.cancelPending();
        const failedSessionId = this.sessionId ?? this.resumeAttemptId;
        this.closeDurableFailureLifecycle(failedSessionId, this.dbRowId);
        this.resumeAttemptId = null;
        this.sessionId = null;

        if (err.code === 'ENOENT') {
          // Binary not installed — configuration error, not a transient crash
          this.active = false;
          this.child = null;
          log.error({ err, chatJid: this.chatJid, provider: this.provider, binary }, 'provider binary not found (ENOENT)');
          this.notifyUser?.(`_${this.getProviderBinary()} is not installed. Check your provider configuration._`);
          // Do NOT call onCrash — this is not a transient failure
          return;
        }
        log.error({ err, chatJid: this.chatJid, provider: this.provider }, 'provider process spawn error');
        this.active = false;
        this.child = null;
        this.notifyUser?.('_Agent failed to start — will retry on your next message._');
        this.onCrash?.({
          exitCode: null,
          signal: null,
          sessionId: null,
          dbRowId: null,
          generationIdentity: childGeneration,
          ...this.buildCrashMetadata('spawn_error', err.message),
        });
      });

      child.stdout.on('data', (chunk: Buffer) => {
        if (!this.isCurrentPersistentChild(child, childGeneration)) return;
        if (this.activeProviderTurnToken !== providerTurnToken) return;
        const lines = this.appendStdoutChunk(chunk);
        for (const line of lines) {
          if (
            !this.active
            || !this.isCurrentPersistentChild(child, childGeneration)
            || this.activeProviderTurnToken !== providerTurnToken
          ) return;
          for (const event of parse(line)) {
            if (
              !this.active
              || !this.isCurrentPersistentChild(child, childGeneration)
              || this.activeProviderTurnToken !== providerTurnToken
            ) return;
            dispatchSpawnPerTurnEvent(event);
            if (
              !this.active
              || !this.isCurrentPersistentChild(child, childGeneration)
              || this.activeProviderTurnToken !== providerTurnToken
            ) return;
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (!this.isCurrentPersistentChild(child, childGeneration)) return;
        if (this.activeProviderTurnToken !== providerTurnToken) return;
        const nextPreview = appendProviderCrashPreview(this.crashStderrPreview, chunk);
        if (nextPreview === this.crashStderrPreview) return;
        this.crashStderrPreview = nextPreview;
        if (!this.crashStderrPreview) return;
        log.warn({
          provider: this.provider,
          chatJid: this.chatJid,
          pid: child.pid ?? null,
          stderrPreview: this.crashStderrPreview.slice(-500),
        }, 'provider stderr');
      });

      // For spawn-per-turn, classify the turn only after the process and all of
      // its stdio streams have closed. This makes the final unterminated record
      // part of the same atomic boundary decision.
      child.on('close', (code, signal) => {
        const superseded = this.child !== child;
        this.clearShutdownKillTimer(child, childGeneration);
        if (superseded) return;
        if (
          this.activeProviderTurnToken !== null
          && this.activeProviderTurnToken !== providerTurnToken
        ) return;
        if (!this.active) {
          boundarySettled = true;
          this.child = null;
          return;
        }
        if (!this.isCurrentPersistentChild(child, childGeneration)) return;

        this.clearStalledOpKill();

        // Drain buffered output
        const bufferedLines = this.drainBufferedStdoutLines();
        if (bufferedLines.length > 0) {
          drainBufferedEvents:
          for (const line of bufferedLines) {
            if (
              !this.active
              || !this.isCurrentPersistentChild(child, childGeneration)
            ) {
              boundarySettled = true;
              return;
            }
            if (this.activeProviderTurnToken !== providerTurnToken) break drainBufferedEvents;
            for (const event of parse(line)) {
              if (
                !this.active
                || !this.isCurrentPersistentChild(child, childGeneration)
              ) {
                boundarySettled = true;
                return;
              }
              if (this.activeProviderTurnToken !== providerTurnToken) break drainBufferedEvents;
              if (this.provider !== 'claude-cli') {
                log.debug({ provider: this.provider, eventType: event.type }, 'spawn-per-turn close drain');
              }
              dispatchSpawnPerTurnEvent(event);
            }
          }
        }

        if (!this.active || !this.isCurrentPersistentChild(child, childGeneration)) {
          boundarySettled = true;
          return;
        }

        if (boundarySettled) return;
        boundarySettled = true;
        this.clearTurnWatchdog();
        this.child = null;

        const exitedWithError = (code !== 0 && code !== null) || signal !== null;
        const missingTerminalResult = code === 0 && signal === null && !sawResult;
        if (exitedWithError || missingTerminalResult) {
          this.completeProviderTurn(providerTurnToken);
          const crashedSessionId = this.sessionId;
          const crashedDbRowId = this.dbRowId;
          this.closeDurableFailureLifecycle(
            crashedSessionId ?? this.resumeAttemptId,
            crashedDbRowId,
          );
          this.resumeAttemptId = null;
          this.active = false;
          this.sessionId = null;
          // Release pessimistic budget reservation if the turn crashed without a result event
          this.budget?.cancelPending();
          if (missingTerminalResult) {
            log.warn({
              exitCode: code,
              signal,
              provider: this.provider,
              chatJid: this.chatJid,
              reason: 'provider_terminal_result_missing',
            }, 'provider turn process closed without terminal result');
          } else {
            log.warn({ exitCode: code, signal, provider: this.provider, chatJid: this.chatJid }, 'provider turn process exited with error');
          }
          this.onCrash?.({
            exitCode: code,
            signal,
            sessionId: crashedSessionId,
            dbRowId: crashedDbRowId,
            generationIdentity: childGeneration,
            ...(missingTerminalResult
              ? this.buildCrashMetadata(
                  'provider_stream_corrupt',
                  'provider process closed before a terminal result event',
                )
              : this.buildCrashMetadata()),
          });
          if (missingTerminalResult) {
            this.notifyUser?.('_Agent provider ended before completing the turn. Send your message again to retry._');
          } else {
            this.notifyUnexpectedExit(code, signal, childGeneration);
          }
        } else {
          // The exact per-turn child has fully closed, so its process tree can
          // no longer emit provider events. Release ownership even when the
          // runtime rejected the observed result before calling the normal
          // terminal API; otherwise a clean code-0 close leaves the lane armed
          // forever with no watchdog or child left to recover it.
          this.completeProviderTurn(providerTurnToken);
        }
      });
    } else {
      // Persistent process: pipe turns via stdin (JSONL for Claude, JSON-RPC for Codex/Gemini)
      if (this.child === null) {
        this.completeProviderTurn();
        throw new Error('No active session. Call spawnSession() first.');
      }
      persistentTurnChild = this.child;
      persistentTurnGeneration = this.childGenerations.get(persistentTurnChild) ?? null;
      if (!this.isCurrentPersistentChild(persistentTurnChild, persistentTurnGeneration)) {
        this.completeProviderTurn();
        throw new Error('Session generation was superseded before turn dispatch.');
      }

      let payload: string;

      // Gemini ACP: wait for sessionId from session/new response, then write session/prompt
      if (this.provider === 'gemini-cli') {
        if (!this.geminiSessionId) {
          if (!this.providerReadyPromise) {
            this.completeProviderTurn();
            throw new Error('Gemini provider ready promise not initialized. Call spawnSession() first.');
          }
          let timer: ReturnType<typeof setTimeout> | null = null;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Gemini sessionId not captured after 15s.')), 15_000);
          });
          try {
            await Promise.race([this.providerReadyPromise, timeout]);
          } catch (err) {
            this.completeProviderTurn();
            throw err;
          } finally {
            if (timer !== null) clearTimeout(timer);
          }
          if (!this.isCurrentPersistentChild(persistentTurnChild, persistentTurnGeneration)) {
            this.completeProviderTurn();
            throw new Error('Session generation was superseded before turn dispatch.');
          }
          if (!this.geminiSessionId) {
            this.completeProviderTurn();
            throw new Error('Gemini sessionId not captured after 15s.');
          }
        }
        if (!this.isCurrentPersistentChild(persistentTurnChild, persistentTurnGeneration)) {
          this.completeProviderTurn();
          throw new Error('Session generation was superseded before turn dispatch.');
        }
        payload = buildSessionPromptRequest(++this.geminiRequestSeq, this.geminiSessionId, text);
      } else if (this.provider === 'codex-cli') {
        // Codex app-server: wait for threadId from thread/started response
        // (spawnSession sends initialize + thread/start, response arrives async on stdout)
        if (!this.codexThreadId) {
          if (!this.providerReadyPromise) {
            this.completeProviderTurn();
            throw new Error('Codex provider ready promise not initialized. Call spawnSession() first.');
          }
          let timer: ReturnType<typeof setTimeout> | null = null;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Codex threadId not captured after 15s. app-server may have failed to initialize.')), 15_000);
          });
          try {
            await Promise.race([this.providerReadyPromise, timeout]);
          } catch (err) {
            this.completeProviderTurn();
            throw err;
          } finally {
            if (timer !== null) clearTimeout(timer);
          }
          if (!this.isCurrentPersistentChild(persistentTurnChild, persistentTurnGeneration)) {
            this.completeProviderTurn();
            throw new Error('Session generation was superseded before turn dispatch.');
          }
          if (!this.codexThreadId) {
            this.completeProviderTurn();
            throw new Error('Codex threadId not captured after 15s. app-server may have failed to initialize.');
          }
        }
        const id = `ws-${++this.codexRequestSeq}`;
        payload = JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/start',
          params: {
            threadId: this.codexThreadId,
            input: [{ type: 'text', text, text_elements: [] }],
          },
          id,
        });
      } else {
        // Claude-cli: stream-json user message
        payload = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
        });
      }

      const stdin = persistentTurnChild.stdin;
      if (!stdin) {
        this.completeProviderTurn();
        throw new Error('Child process stdin is not available');
      }

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            const framedPayload = payload.endsWith('\n') ? payload : `${payload}\n`;
            stdin.write(framedPayload, 'utf8', (err) => {
              if (err) reject(err);
              else resolve();
            });
          }),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error('STDIN_WRITE_TIMEOUT: agent not reading input')),
              STDIN_WRITE_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (writeErr) {
        try {
          // A callback error or timeout cannot prove whether the provider
          // accepted the bytes. End the exact session and await process-tree
          // proof before reopening the lane; resuming could duplicate a turn.
          await this.shutdown(false);
        } catch (shutdownErr) {
          throw new AggregateError(
            [writeErr, shutdownErr],
            'Provider stdin write failed and exact process-tree teardown was inconclusive',
          );
        }
        throw writeErr;
      } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      }
    }

    if (
      persistentTurnChild !== null &&
      !this.isCurrentPersistentChild(persistentTurnChild, persistentTurnGeneration)
    ) {
      throw new Error('Session generation was superseded before turn completion.');
    }

    if (this.dbRowId !== null) {
      incrementMessageCount(this.db, this.dbRowId);
    }
    this.clearTurnWatchdog(); // clear any previous watchdog before arming a new one
    this.armWatchdog();
    this.messageCount += 1;
    this.lastMessageAt = new Date().toISOString();
  }

  /** Kill the current session and spawn a fresh one. */
  async handleNew(): Promise<void> {
    await this.shutdown(false); // user-initiated: mark ended, not suspended
    await this.spawnSession();
  }

  /** Return lightweight status without touching the DB. */
  getStatus(): {
    active: boolean;
    pid: number | null;
    sessionId: string | null;
    startedAt: string | null;
    messageCount: number;
    lastMessageAt: string | null;
    turnInFlight: boolean;
    durableFailureClosed: boolean;
  } {
    return {
      active: this.active,
      pid: this.child?.pid ?? null,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt,
      durableFailureClosed: this.durableFailureClosed,
      turnInFlight: this.providerTurnInFlight,
    };
  }

  getProviderId(): string {
    return this.provider;
  }

  /** Model ref this session was spawned with (undefined = provider default). */
  getModelRef(): string | undefined {
    return this.model;
  }

  /**
   * Kill child process and mark session.
   * @param suspend - true (default) = suspended (bot shutdown, resumable);
   *                  false = ended (user chose /new, not resumable).
   */
  async shutdown(suspend = true): Promise<void> {
    this.clearTurnWatchdog();
    this.clearStalledOpKill();
    this.active = false; // Suppress crash notification for clean shutdown

    const currentPid = this.child?.pid ?? null;
    const closingSessionId = this.sessionId ?? this.resumeAttemptId;

    // Kill the child only if one is running
    if (this.child !== null) {
      const terminatedSessionId = this.sessionId;
      const child = this.child;
      try {
        const treeCleanup = this.killChildTree(child, 'SIGTERM');
        this.armShutdownKillTimer(child);
        await treeCleanup;
      } catch (err) {
        try {
          this.closeDurableFailureLifecycle(closingSessionId, this.dbRowId);
        } catch (persistenceErr) {
          throw new AggregateError(
            [err, persistenceErr],
            'Child termination and durable failure closure both failed',
          );
        }
        throw err;
      }
      this.child = null;
      log.info({ chatJid: this.chatJid, sessionId: terminatedSessionId, pid: currentPid }, 'claude process terminated');
    }

    if (this.managedProviderSession !== null) {
      const providerSession = this.managedProviderSession;
      try {
        await providerSession.shutdown(suspend ? 'suspend' : 'end');
      } catch (err) {
        try {
          this.closeDurableFailureLifecycle(closingSessionId, this.dbRowId);
        } catch (persistenceErr) {
          throw new AggregateError(
            [err, persistenceErr],
            'Managed provider termination and durable failure closure both failed',
          );
        }
        throw err;
      }
      this.managedProviderSession = null;
      this.managedProviderGeneration = null;
      log.info({ chatJid: this.chatJid, sessionId: this.sessionId, provider: this.provider }, 'managed provider session terminated');
    }

    // Persist graceful state only after provider/process termination succeeds.
    // A failed persistence leaves the row identity attached so shutdown can be retried.
    if (!this.durableFailureClosed) {
      const lifecycleStatus = suspend ? 'suspended' : 'ended';
      if (
        this.dbRowId !== null
        && this.durability
        && typeof this.durability.closeSessionLifecycle === 'function'
      ) {
        this.durability.closeSessionLifecycle({
          agentSessionRowId: this.dbRowId,
          providerSessionId: closingSessionId,
          provider: this.provider,
          conversationKey: this.conversationKey,
          status: lifecycleStatus,
        });
      } else {
        if (this.dbRowId !== null) {
          if (closingSessionId === null) {
            updateSessionStatus(this.db, this.dbRowId, lifecycleStatus);
          } else {
            updateResumedSessionStatus(
              this.db,
              this.dbRowId,
              closingSessionId,
              this.provider,
              lifecycleStatus,
            );
          }
        }
        this.updateCheckpointStatus(lifecycleStatus, closingSessionId);
      }
      log.info({
        rowId: this.dbRowId,
        chatJid: this.chatJid,
        sessionId: closingSessionId,
        pid: currentPid,
      }, suspend ? 'session: suspended' : 'session: ended');
    }

    this.sessionId = null;
    this.dbRowId = null;
    this.startedAt = null;
    this.messageCount = 0;
    this.lastMessageAt = null;
    this.codexThreadId = null;
    this.codexResumeThreadStartReqId = null;
    this.providerReadyPromise = null;
    this.providerReadyResolve = null;
    // Only a fully successful teardown (process proof plus lifecycle closure)
    // may reopen a lane closed by an ambiguous provider write.
    this.completeProviderTurn();
  }
}

/**
 * Format the age of a session for human-readable display.
 * @param isoUtcString - ISO UTC timestamp string (e.g. from started_at)
 */
export function formatAge(isoUtcString: string): string {
  const ms = Date.now() - new Date(isoUtcString).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}
