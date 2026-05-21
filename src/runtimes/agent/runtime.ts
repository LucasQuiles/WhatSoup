// src/runtimes/agent/runtime.ts
// AgentRuntime implements the Runtime interface, tying all agent components together.

import type { AgentCommandRequest, AgentCommandResult, Runtime } from '../types.ts';
import type { IncomingMessage, Messenger, RuntimeHealth } from '../../core/types.ts';
import type { Database } from '../../core/database.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import type { AgentEvent } from './stream-parser.ts';
import { EmitHealResultSchema } from '../../core/heal-protocol.ts';
import { dequeueNextReport, emitHealReport } from '../../core/heal.ts';
import { sendTracked } from '../../core/durability.ts';
import {
  createAuditedReplyGuaranteeSender,
  DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS,
  ReplyGuaranteeManager,
} from '../../core/reply-guarantee.ts';
import { emitAlert, clearAlertSource } from '../../lib/emit-alert.ts';
import { createChildLogger } from '../../logger.ts';
import {
  ensureAgentSchema,
  getActiveSession,
  backfillWorkspaceKeys,
  markOrphaned,
  getResumableSessionForChat,
  accumulateSessionTokens,
  insertTokenEvent,
  accumulateTokensWithEvent,
  backfillSessionProvider,
  getSessionTokenSnapshot,
  markSessionCompacted,
} from './session-db.ts';
import { chatJidToWorkspace, provisionWorkspace, writePrivateFileSync, writeSandboxArtifacts, ensurePermissionsSettings } from '../../core/workspace.ts';
import { classifyActiveSessions } from './session-classifier.ts';
import { SessionManager, formatAge, type SessionCrashInfo } from './session.ts';
import {
  OutboundQueue,
  type IOutboundQueue,
  type ToolUpdate,
  type ToolCategory,
} from './outbound-queue.ts';
import { ControlQueue } from './control-queue.ts';
import { classifyInput } from './commands.ts';
import { getRecentMessages, getMessagesSince, updateMediaPath, updateTranscription } from '../../core/messages.ts';
import { toConversationKey, isGroupConversationKey } from '../../core/conversation-key.ts';
import { createChatResolver } from '../../core/chats-resolver.ts';
import { createOutboundSendsWriter } from '../../core/outbound-sends.ts';
import { toPersonalJid, isGroupJid } from '../../core/jid-constants.ts';
import { canonicalizeChatJid } from '../../core/lid-resolver.ts';
import { TurnQueue, type QueuedTurn } from './turn-queue.ts';
import { config } from '../../config.ts';
import { resolvePhoneFromJid } from '../../core/access-list.ts';
import { isAdminPhone } from '../../lib/phone.ts';
import { matchImperative, extractImperativeTarget } from '../../core/substrate/inline-extractor.ts';
import { createBead } from '../../core/substrate/beads.ts';
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { ToolRegistry } from '../../mcp/registry.ts';
import { WhatSoupSocketServer } from '../../mcp/socket-server.ts';
import type { SessionContext } from '../../mcp/types.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import { registerAllTools } from '../../mcp/register-all.ts';
import { startMediaBridge, setMediaBridgeChat, type MediaBridge } from './media-bridge.ts';
import { createProviderMcpBridge, generateMcpConfigFile } from './providers/mcp-bridge.ts';
import { extractRawMime } from '../../core/media-mime.ts';
import { jitteredDelay } from '../../core/retry.ts';
import { synthesizeSpeech } from '../chat/providers/elevenlabs.ts';
import { writeTempFile } from '../../core/media-download.ts';
import { OperationTracker } from './operation-tracker.ts';
import type { ProgressEvent } from './operation-tracker.ts';

const log = createChildLogger('agent-runtime');

/** Tracks workspace media directories already created — avoids redundant mkdirSync calls. */
const MAX_MEDIA_DIRS = 5_000;
const createdMediaDirs = new Set<string>();

function rememberCreatedMediaDir(mediaDestDir: string): void {
  createdMediaDirs.add(mediaDestDir);
  if (createdMediaDirs.size > MAX_MEDIA_DIRS) {
    const oldest = createdMediaDirs.values().next().value;
    if (oldest !== undefined) {
      createdMediaDirs.delete(oldest);
    }
  }
}

/** Test-only helpers for LEAK-10 coverage. */
export function __resetCreatedMediaDirsForTests(): void {
  createdMediaDirs.clear();
}

/** Test-only helpers for LEAK-10 coverage. */
export function __rememberCreatedMediaDirForTests(mediaDestDir: string): void {
  rememberCreatedMediaDir(mediaDestDir);
}

/** Test-only helpers for LEAK-10 coverage. */
export function __getCreatedMediaDirsSizeForTests(): number {
  return createdMediaDirs.size;
}

/** Test-only helpers for LEAK-10 coverage. */
export function __hasCreatedMediaDirForTests(mediaDestDir: string): boolean {
  return createdMediaDirs.has(mediaDestDir);
}

/** Maximum duration (ms) a control session is allowed to run before force-shutdown. */
const CONTROL_SESSION_TIMEOUT_MS = 15 * 60 * 1000;

/** Max consecutive crashes before auto-respawn gives up and waits for user action. */
const AUTO_RESPAWN_MAX_CRASHES = 3;
/** Base delay (ms) before attempting auto-respawn after a crash. Actual delay uses exponential backoff. */
const AUTO_RESPAWN_BASE_MS = 2_000;
/** Maximum respawn delay (ms) — caps the exponential backoff. */
const AUTO_RESPAWN_MAX_DELAY_MS = 15_000;
/** Periodic runtime health stats emission interval. */
const HEALTH_STATS_INTERVAL_MS = 60_000;
const SHARED_QUEUE_IDLE_MS = 60 * 60 * 1000;
const SHARED_QUEUE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const GLOBAL_TOOL_SCOPE_KEY = '__global__';
const GLOBAL_CRASH_SCOPE_KEY = '__global__';
const SILENT_COMPACT_TTL_MS = 5 * 60 * 1000;
const AUTO_COMPACT_TIMEOUT_MS = 2 * 60 * 1000;
const AUTO_COMPACT_TIMEOUT_BACKOFF_MS = 15 * 60 * 1000;

class AgentCommandRuntimeError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'AgentCommandRuntimeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Prepare a plain-text content string for the agent runtime from any message type.
 *
 * Media files (images, audio, video, documents, stickers) are saved to disk so the
 * agent can use its Read tool to view them. The agent receives the file path in brackets.
 * Audio is also transcribed via the shared transcription chain so the agent gets the text without having to
 * open the file. Non-downloadable types (location, contact, poll) return descriptive text.
 *
 * OpenAI is used when configured; local faster-whisper and whisper.cpp fallbacks are used when installed.
 */
export async function prepareContentForAgent(msg: IncomingMessage, db?: Database, messageId?: string): Promise<string> {
  const { contentType, content } = msg;

  // Text messages: use as-is
  if (contentType === 'text') {
    return content ?? '';
  }

  // Build download function from rawMessage
  const downloadFn = msg.rawMessage
    ? async () => {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        return downloadMediaMessage(msg.rawMessage as any, 'buffer', {}) as Promise<Buffer>;
      }
    : null;

  const { downloadMedia, writeTempFile } = await import('../../core/media-download.ts');

  // Map content type to mime and extension
  const mimeMap: Record<string, { mime: string; ext: string }> = {
    image: { mime: 'image/jpeg', ext: 'jpg' },
    sticker: { mime: 'image/webp', ext: 'webp' },
    audio: { mime: 'audio/ogg', ext: 'ogg' },
    video: { mime: 'video/mp4', ext: 'mp4' },
    document: { mime: 'application/octet-stream', ext: 'bin' },
  };

  const typeInfo = mimeMap[contentType];

  // For non-downloadable types, return descriptive text
  if (!typeInfo || !downloadFn) {
    if (contentType === 'location') return content ? `[Location: ${content}]` : '[Location shared]';
    if (contentType === 'contact') return content ? `[Contact: ${content}]` : '[Contact shared]';
    if (contentType === 'poll') return content ? `[Poll: ${content}]` : '[Poll]';
    return content || `[${contentType} message received]`;
  }

  // For documents, try to extract the real MIME type from the raw WhatsApp message
  let downloadMime = typeInfo.mime;
  if (contentType === 'document') {
    downloadMime = extractRawMime(msg.rawMessage, 'document') ?? typeInfo.mime;
  }

  // Download the file
  const result = await downloadMedia(downloadFn, downloadMime);
  if (!result) {
    return `[${contentType} — download failed]${content ? '\n' + content : ''}`;
  }

  // For documents, try to preserve the original extension from the filename
  let ext = typeInfo.ext;
  if (contentType === 'document' && content) {
    const dotIdx = content.lastIndexOf('.');
    if (dotIdx > 0) ext = content.substring(dotIdx + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin';
  }

  // Save to disk — do NOT clean up immediately; agent needs time to read the file
  const filePath = writeTempFile(result.buffer, ext);

  // Persist media path to database for MCP access
  if (db && messageId) {
    try {
      updateMediaPath(db, messageId, filePath);
    } catch (err) {
      createChildLogger('agent:media').warn({ err, messageId }, 'Failed to persist media_path');
    }
  }

  switch (contentType) {
    case 'audio': {
      const { transcribeAudio } = await import('../chat/providers/whisper.ts');
      const transcript = await transcribeAudio(result.buffer, result.mimeType);

      // Persist transcription to DB for MCP access and FTS search
      if (db && messageId && transcript && !transcript.includes('transcription unavailable')) {
        try {
          updateTranscription(db, messageId, transcript);
        } catch (err) {
          createChildLogger('agent:transcription').warn({ err, messageId }, 'Failed to persist transcription');
        }
      }

      return `[Voice note transcription]: ${transcript}\n[Audio file: ${filePath}]`;
    }
    case 'image':
      return content ? `[Image: ${filePath}]\n${content}` : `[Image: ${filePath}]`;
    case 'sticker':
      return `[Sticker: ${filePath}]`;
    case 'video':
      return content ? `[Video: ${filePath}]\n${content}` : `[Video: ${filePath}]`;
    case 'document': {
      const { extractDocumentText } = await import('../chat/media/documents.ts');
      const text = await extractDocumentText(result.buffer, result.mimeType, content ?? 'document');
      return `[Document: ${filePath}]\n${text}`;
    }
    default:
      return content || `[${contentType}: ${filePath}]`;
  }
}

/**
 * Relocate media files from the global temp dir into the user's workspace.
 * Rewrites file paths in the content string so the agent can read them
 * within its sandbox-allowed directory.
 */
function relocateMediaToWorkspace(content: string, workspacePath: string): string {
  const mediaTmpDir = config.mediaDir;
  if (!mediaTmpDir || !content.includes(mediaTmpDir)) return content;

  const mediaDestDir = join(workspacePath, 'media');
  if (!createdMediaDirs.has(mediaDestDir)) {
    try {
      mkdirSync(mediaDestDir, { recursive: true, mode: 0o700 });
      rememberCreatedMediaDir(mediaDestDir);
    } catch (err) {
      log.warn({ err, mediaDestDir }, 'failed to create workspace media directory');
      return content;
    }
  }

  // Match file paths from the global media temp dir
  const regex = new RegExp(mediaTmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[\\w.-]+', 'g');
  return content.replace(regex, (match) => {
    const destPath = join(mediaDestDir, basename(match));
    try {
      copyFileSync(match, destPath);
      return destPath;
    } catch {
      return match; // keep original path if copy fails
    }
  });
}

export interface SandboxPolicy {
  allowedPaths: string[];
  allowedTools: string[];
  allowedMcpTools?: string[];
  bash: { enabled: boolean };
}

export type SessionScope = 'single' | 'shared' | 'per_chat';

export interface AgentRuntimeOptions {
  shared?: boolean;
  /** Session scope: 'single' (one chat), 'shared' (one session, many chats), 'per_chat' (one session per chat). */
  sessionScope?: SessionScope;
  cwd?: string;
  configSystemPrompt?: string;
  instructionsPath?: string;
  sandbox?: SandboxPolicy;
  /** Claude model identifier to pass via --model flag (e.g. 'claude-opus-4-6[1m]'). */
  model?: string;
  /** When true, each chat gets an isolated workspace directory with its own Claude config. Requires sessionScope 'per_chat'. */
  sandboxPerChat?: boolean;
  /** Plugin directories to pass via --plugin-dir to the claude subprocess. */
  pluginDirs?: string[];
  /** Per-instance plugin enablement. Written to project settings.json to override global. */
  enabledPlugins?: Record<string, boolean>;
  /** Per-instance opt-in for propagating ALLOW_M365_MUTATIONS when fail-closed mode is enabled. */
  allowM365Mutations?: boolean;
  /** Automatically run a silent /compact after this many input tokens since the last compact. */
  autoCompactInputTokens?: number;
  /** Reply Guarantee timeout override for tests and tightly controlled deployments. */
  replyGuaranteeTimeoutMs?: number;
}

/**
 * Build a structured ToolUpdate from a tool_use event.
 * detail is capped at 80 visible chars.
 * Exported for unit testing.
 */
export function buildToolUpdate(toolName: string, input: Record<string, unknown>): ToolUpdate {
  const str = (key: string): string => String(input[key] ?? '');

  /** Strip home-dir prefixes, make relative, and middle-truncate to 80 chars. */
  function shortPath(p: string): string {
    // Strip any /home/<user>/ prefix to avoid leaking absolute paths
    const rel = p.replace(/^\/home\/[^/]+\//, '~/').replace(/^~\/LAB\/[^/]+\//, '');
    if (rel.length <= 80) return rel;
    const half = 38;
    return rel.slice(0, half) + '…' + rel.slice(-(80 - half - 1));
  }

  /** End-truncate a string to 160 chars (fits WhatsApp status lines without mid-word cuts). */
  function trunc(s: string): string {
    return s.length <= 160 ? s : s.slice(0, 159) + '…';
  }

  switch (toolName) {
    case 'Read': {
      const p = shortPath(str('file_path'));
      const limit = input['limit'];
      const offset = input['offset'];
      const startLine = Number(offset ?? 1);
      const endLine = limit != null ? startLine + Number(limit) - 1 : '?';
      const range = (limit != null || offset != null) ? `\n→ \`(L${startLine}-L${endLine})\`` : '';
      return { category: 'reading', detail: trunc(`\`${p}\`${range}`) };
    }
    case 'Edit':
    case 'Write':
      return { category: 'modifying', detail: `\`${shortPath(str('file_path'))}\`` };
    case 'Glob': {
      const scope = str('path');
      const pat = trunc(str('pattern'));
      // Two-line format keeps backtick pairs closed even with long patterns/paths
      const detail = scope ? `\`${pat}\`\n→ \`${shortPath(scope)}\`` : `\`${pat}\``;
      return { category: 'searching', detail };
    }
    case 'Grep': {
      const scope = str('glob') || str('path');
      const pat = trunc(str('pattern'));
      const detail = scope ? `\`${pat}\`\n→ \`${shortPath(scope)}\`` : `\`${pat}\``;
      return { category: 'searching', detail };
    }
    case 'Bash': {
      const desc = str('description');
      // Human-readable descriptions stay plain; raw commands get monospace
      if (desc) return { category: 'running', detail: trunc(desc) };
      const firstLine = str('command').split('\n').find((l) => l.trim()) ?? str('command');
      return { category: 'running', detail: `\`${trunc(firstLine)}\`` };
    }
    case 'Agent': {
      const type = str('subagent_type') || 'agent';
      const label = type.replace(/-/g, ' ');
      const desc = str('description') || trunc(str('prompt'));
      return { category: 'agent', detail: trunc(`${label}: ${desc}`) };
    }
    case 'WebFetch': {
      const url = str('url').replace(/^https?:\/\//, '').replace(/\?.*$/, '');
      return { category: 'fetching', detail: trunc(`\`${url}\``) };
    }
    case 'WebSearch':
      return { category: 'fetching', detail: trunc(`\`${str('query')}\``) };
    case 'Skill':
      return { category: 'skill', detail: `\`${trunc(str('skill') || 'skill')}\`` };
    case 'TodoWrite':
      return { category: 'planning', detail: 'Updating todos' };
    case 'TaskCreate':
      return { category: 'planning', detail: trunc(str('subject') || 'Creating task') };
    case 'TaskUpdate':
      return { category: 'planning', detail: `Updating task ${str('taskId')}` };
    case 'TaskList':
    case 'TaskGet':
      return { category: 'planning', detail: 'Checking tasks' };
    case 'ToolSearch':
      return { category: 'skill', detail: `\`${trunc(str('query') || 'tools')}\`` };
    case 'LS':
      return { category: 'reading', detail: `\`${shortPath(str('path') || '.')}\`` };
    case 'NotebookEdit':
    case 'NotebookRead':
      return { category: 'modifying', detail: `\`${shortPath(str('notebook'))}\`` };
    case 'LSP':
      return { category: 'searching', detail: trunc(str('command') || 'language server') };
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return { category: 'planning', detail: toolName === 'EnterPlanMode' ? 'Planning' : 'Executing plan' };
    case 'SendMessage':
      return { category: 'agent', detail: trunc(`→ ${str('to')}`) };
    case 'AskUserQuestion':
      return { category: 'other', detail: 'Asking a question' };
    default: {
      // MCP tools: "mcp__<server>__<tool-name>" → human-readable monospace tool name
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const rawTool = parts[parts.length - 1] ?? toolName;

        // Friendly labels for tools that shouldn't expose internals to users
        if (rawTool === 'knowledge_search') {
          const query = trunc(str('query') || '');
          return { category: 'searching', detail: query ? `Checking my notes on ${query}` : 'Checking my notes' };
        }

        const tool = rawTool.replace(/[-_]/g, ' ');
        return { category: 'other', detail: `\`${trunc(tool)}\`` };
      }
      return { category: 'other', detail: `\`${trunc(toolName)}\`` };
    }
  }
}

/**
 * Rewrite common technical error messages into casual, user-friendly language.
 * Returns null if no rewrite matches (use the original).
 */
function humanizeError(_toolName: string, text: string): string | null {
  const lower = text.toLowerCase();

  // File too large to read
  if (lower.includes('exceeds maximum allowed tokens') || lower.includes('content too large'))
    return '_that file was a bit long, reading just the parts I need_';
  // File not found
  if (lower.includes('no such file') || lower.includes('file not found') || lower.includes('enoent'))
    return '_file not found, looking for the right path_';
  // Command not found
  if (lower.includes('command not found'))
    return '_command not found, trying another approach_';
  // Timeout
  if (lower.includes('timed out') || lower.includes('timeout'))
    return '_that took too long, retrying_';
  // Network / connection errors
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('fetch failed'))
    return '_connection failed, will retry_';
  // No matches found (grep/glob)
  if (lower.includes('no matches found') || lower.includes('no files found'))
    return '_no results, refining search_';
  // Git conflicts
  if (lower.includes('merge conflict'))
    return '_merge conflict detected, resolving_';
  // Rate limit / overloaded
  if (lower.includes('rate limit') || lower.includes('overloaded') || lower.includes('429'))
    return '_rate limited, waiting a moment_';
  // Syntax/parse errors
  if (lower.includes('syntax error'))
    return '_syntax error, fixing_';
  // Disk / storage
  if (lower.includes('enospc') || lower.includes('no space left'))
    return '_disk full, freeing space_';
  // Process / memory
  if (lower.includes('enomem') || lower.includes('out of memory') || lower.includes('killed'))
    return '_out of memory, scaling down_';
  // Invalid JSON / parse
  if (lower.includes('unexpected token') || lower.includes('json parse') || lower.includes('invalid json'))
    return '_got malformed data, retrying_';
  // String replacement not found (Edit tool)
  if (lower.includes('not found in file') || lower.includes('old_string'))
    return '_text not found in file, re-reading to get the right context_';
  // Git push / pull errors
  if (lower.includes('rejected') && lower.includes('push'))
    return '_push rejected, pulling latest changes first_';
  // Max context / token budget
  if (lower.includes('context window') || lower.includes('max_tokens') || lower.includes('context length'))
    return '_hitting context limits, compacting_';
  // Exit code (generic — keep it brief)
  if (/^exit code \d+$/i.test(text.trim()))
    return `_exited with error, continuing_`;

  return null;
}

/**
 * Detect provider usage-limit / quota-exceeded messages that should NOT be
 * forwarded to WhatsApp.  When a Claude Code session hits its usage cap it
 * emits a human-readable message like "You're out of extra usage · resets …".
 * Forwarding this to a group chat can trigger other agents to respond, which
 * spawns new sessions that also hit the cap → infinite flood.
 *
 * Returns `true` when the text looks like a provider usage-limit notice.
 */
export function isUsageLimitMessage(text: string): boolean {
  const lower = text.toLowerCase();
  if (
    lower.includes('out of extra usage') ||
    lower.includes('usage limit reached') ||
    lower.includes('usage cap reached') ||
    lower.includes("you've reached your usage limit") ||
    lower.includes('you have reached your usage limit') ||
    lower.includes('you have hit your usage limit') ||
    lower.includes('claude usage limit')
  ) {
    return true;
  }

  const resetPattern = /\b(claude\s+)?(will\s+be\s+available|resets?|come\s+back)\s+(at\s+|in\s+)?\d{1,2}(:\d{2})?\s*(am|pm)\b/i;
  return resetPattern.test(text) && (
    lower.includes('usage limit') ||
    lower.includes('usage cap') ||
    lower.includes('plan limit') ||
    lower.includes('quota exceeded')
  );
}

/**
 * Classify a tool_result error as either a blocked tool (permission/hook denial),
 * cancelled, or a genuine execution error. Returns an appropriate ToolUpdate with
 * user-friendly messaging.
 */
export function classifyToolError(toolName: string, content: string): ToolUpdate {
  // Strip internal XML-like tags from Claude error content
  const cleaned = content
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/<\/?error>/g, '')
    .trim();

  const lower = cleaned.toLowerCase();

  const isCancelled =
    lower.startsWith('cancelled') ||
    lower.includes('tool call cancelled') ||
    lower.includes('was cancelled');

  const isBlocked =
    lower.includes('not allowed') ||
    lower.includes('permission denied') ||
    lower.includes('blocked by') ||
    lower.includes('hook blocked') ||
    lower.includes('denied by') ||
    lower.includes('not permitted') ||
    lower.includes('is not in the allow') ||
    lower.includes('disallowed');

  const category = isCancelled ? 'cancelled' : isBlocked ? 'blocked' : 'error';

  // Try human-friendly rewrite first (only for errors, not blocked/cancelled)
  if (category === 'error' && toolName !== 'unknown') {
    const humanized = humanizeError(toolName, cleaned);
    if (humanized) return { category, detail: humanized };
  }

  // Fallback: technical detail
  const firstLine = cleaned.split('\n')[0] ?? cleaned;
  const simplified = firstLine
    .replace(/^Cancelled:\s*parallel tool call\s+\S+\(.*$/, 'Cancelled')
    .replace(/^Exit code (\d+)$/, 'exit code $1');
  const reason = simplified.length > 100 ? simplified.slice(0, 99) + '…' : simplified;

  const humanName = toolName === 'unknown' ? '' : toolName;
  const detail = humanName ? `${humanName} — ${reason}` : reason;

  return { category, detail };
}

export class AgentRuntime implements Runtime {
  private static readonly WORKSPACE_IDLE_MS = 30 * 60 * 1000;
  private static readonly WORKSPACE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

  private readonly db: Database;
  private readonly messenger: Messenger;
  private readonly instanceName: string;
  private readonly shared: boolean;
  private readonly sessionScope: SessionScope;
  private readonly cwd: string | undefined;
  private readonly configSystemPrompt: string | undefined;
  private readonly instructionsPath: string | undefined;
  private readonly sandbox: SandboxPolicy | undefined;
  private readonly model: string | undefined;
  private readonly sandboxPerChat: boolean;
  private readonly pluginDirs: string[];
  private readonly enabledPlugins: Record<string, boolean> | undefined;
  private readonly allowM365Mutations: boolean | undefined;
  private readonly autoCompactInputTokens: number | undefined;
  private readonly agentProvider: string;
  private readonly agentProviderConfig: Record<string, unknown> | undefined;
  private readonly replyGuaranteeTimeoutMs: number;
  private readonly registry: ToolRegistry;

  // single mode: one session, one queue
  private session: SessionManager | null = null;
  private queue: IOutboundQueue | null = null;
  private activeChatJid: string | null = null;

  // shared mode: single session, per-chat outbound queues + global turn queue
  private outboundQueues: Map<string, IOutboundQueue> = new Map();

  // per_chat mode: independent session + queue per chatJid
  // When sandboxPerChat=true, maps are keyed by workspaceKey; when false, keyed by raw chatJid.
  private chatSessions: Map<string, SessionManager> = new Map();
  private chatQueues: Map<string, IOutboundQueue> = new Map();

  // Operation tracker: per-session progress reporting & stall detection
  // Parallels session storage — single/shared uses operationTracker, per_chat uses operationTrackers map.
  private operationTracker: OperationTracker | null = null;
  private operationTrackers: Map<string, OperationTracker> = new Map();
  private workspaceResources: Map<string, {
    socketPath: string;
    workspacePath: string;
    socketServer: WhatSoupSocketServer | null;
    mediaBridge: MediaBridge | null;
    lastActivity: number;
  }> = new Map();
  private globalMcpSocketPath: string | null = null;
  private replyGuarantee: ReplyGuaranteeManager | null = null;
  private turnQueue: TurnQueue;
  private currentTurnChatJid: string | null = null;

  // NOTE: turnHadVisibleOutput is only tracked in the non-per-chat handleEvent path.
  // Spawn-per-turn providers route through handleEventWithContext which does not
  // use this flag. The "(no response)" fallback only exists in handleEvent.
  private turnHadVisibleOutput = false;
  private turnChain: Promise<void> = Promise.resolve();
  private healthStatsTimer: ReturnType<typeof setInterval> | null = null;
  private workspaceSweepTimer: ReturnType<typeof setInterval> | null = null;
  private queueSweepTimer: ReturnType<typeof setInterval> | null = null;
  private pendingRespawnTimers = new Set<ReturnType<typeof setTimeout>>();
  private silentCompactScopes = new Map<string, ReturnType<typeof setTimeout>>();
  private compactBoundaryScopes = new Set<string>();
  private autoCompactCooldownUntil = new Map<string, number>();
  private autoCompactWaiters = new Map<string, {
    promise: Promise<void>;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * Post-turn event gate — tracks mapKeys where a 'result' event has been
   * processed but no new user message has arrived yet. Events arriving while
   * the gate is active are SDK-injected artifacts (system-reminders that
   * trigger phantom model output) and must be suppressed.
   *
   * Set: on 'result' event in handleEventWithContext
   * Cleared: in sendTurnPerChat when the next user message initiates a turn
   */
  private postTurnGate = new Set<string>();

  // Crash tracking — keyed by per-chat mapKey for per_chat runtimes and by a
  // single global key for single/shared mode. Counts survive session map deletions
  // so health reporting can surface recent failures until a successful respawn decays them.
  private perChatCrashCount = new Map<string, number>();
  private lastCrashAt: string | null = null;

  /** Maps toolScopeKey → (toolId → toolName) so tool_result errors stay isolated per session scope. */
  private activeToolNames = new Map<string, Map<string, string>>();
  private nextToolScopeOrdinal = 0;

  private recordCrash(mapKey: string): number {
    const count = (this.perChatCrashCount.get(mapKey) ?? 0) + 1;
    this.perChatCrashCount.set(mapKey, count);
    this.lastCrashAt = new Date().toISOString();
    return count;
  }

  private getCrashCount(mapKey: string): number {
    return this.perChatCrashCount.get(mapKey) ?? 0;
  }

  private getRecentCrashCount(): number {
    let total = 0;
    for (const count of this.perChatCrashCount.values()) {
      total += count;
    }
    return total;
  }

  private decrementCrashCount(mapKey: string): void {
    const count = this.perChatCrashCount.get(mapKey) ?? 0;
    if (count <= 1) {
      this.perChatCrashCount.delete(mapKey);
      return;
    }
    this.perChatCrashCount.set(mapKey, count - 1);
  }

  private getCrashScopeKey(chatJid: string): string {
    if (this.sessionScope !== 'per_chat') {
      return GLOBAL_CRASH_SCOPE_KEY;
    }
    return this.sandboxPerChat
      ? chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey
      : chatJid;
  }

  private createToolScopeKey(scopeBase: string): string {
    this.nextToolScopeOrdinal += 1;
    return `${scopeBase}#${this.nextToolScopeOrdinal}`;
  }

  private getToolNames(toolScopeKey: string): Map<string, string> {
    let names = this.activeToolNames.get(toolScopeKey);
    if (!names) {
      names = new Map<string, string>();
      this.activeToolNames.set(toolScopeKey, names);
    }
    return names;
  }

  private clearToolNames(toolScopeKey: string): void {
    this.activeToolNames.delete(toolScopeKey);
  }

  private beginSilentCompact(scopeKey: string): void {
    this.clearSilentCompact(scopeKey);
    const timer = setTimeout(() => {
      this.silentCompactScopes.delete(scopeKey);
    }, SILENT_COMPACT_TTL_MS);
    timer.unref?.();
    this.silentCompactScopes.set(scopeKey, timer);
  }

  private isSilentCompact(scopeKey?: string): boolean {
    return scopeKey !== undefined && this.silentCompactScopes.has(scopeKey);
  }

  private clearSilentCompact(scopeKey?: string): void {
    if (scopeKey === undefined) return;
    const timer = this.silentCompactScopes.get(scopeKey);
    if (timer) clearTimeout(timer);
    this.silentCompactScopes.delete(scopeKey);
  }

  private finishAutoCompact(scopeKey: string): void {
    const waiter = this.autoCompactWaiters.get(scopeKey);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.autoCompactWaiters.delete(scopeKey);
    waiter.resolve();
  }

  private consumeCompactBoundary(scopeKey: string): boolean {
    const hadBoundary = this.compactBoundaryScopes.has(scopeKey);
    this.compactBoundaryScopes.delete(scopeKey);
    return hadBoundary;
  }

  private maybeStartAutoCompact(session: SessionManager | null, mapKey?: string): void {
    if (this.autoCompactInputTokens === undefined || session === null) return;
    if (this.sessionScope === 'shared') return;
    if (!session.getStatus().active) return;

    const rowId = session.getDbRowId();
    if (rowId === null) return;

    const snapshot = getSessionTokenSnapshot(this.db, rowId);
    if (!snapshot) return;

    const inputSinceCompact = Math.max(0, snapshot.totalInputTokens - snapshot.lastCompactInputTokens);
    if (inputSinceCompact < this.autoCompactInputTokens) return;

    const scopeKey = mapKey ?? GLOBAL_TOOL_SCOPE_KEY;

    // Rollout bootstrap: existing sessions that already accumulated past the
    // threshold before this knob was enabled would otherwise fire /compact
    // on their very next turn — a fleet-wide enable could trigger a compact
    // storm. Detect by lastCompactInputTokens=0 + totalInputTokens at or
    // above threshold (matches the outer gate's >= semantics), advance the
    // baseline once silently, and let the natural threshold cycle take over.
    //
    // Side effect to be aware of: a brand-new session whose first turn
    // happens to cross the threshold (large file ingestion, very low
    // threshold) will also take this path and silently skip its first real
    // compact. Same anti-storm behaviour; documented in docs/runbook.md.
    if (snapshot.lastCompactInputTokens === 0 && snapshot.totalInputTokens >= this.autoCompactInputTokens) {
      markSessionCompacted(this.db, rowId);
      log.info({
        scopeKey,
        rowId,
        totalInputTokens: snapshot.totalInputTokens,
        lastCompactInputTokens: snapshot.lastCompactInputTokens,
        threshold: this.autoCompactInputTokens,
      }, 'auto compact baseline initialised for existing session');
      return;
    }

    if (this.autoCompactWaiters.has(scopeKey) || this.isSilentCompact(scopeKey)) return;

    const cooldownUntil = this.autoCompactCooldownUntil.get(scopeKey);
    if (cooldownUntil !== undefined) {
      if (Date.now() < cooldownUntil) return;
      this.autoCompactCooldownUntil.delete(scopeKey);
    }

    let resolveWaiter!: () => void;
    const timer = setTimeout(() => {
      log.error(
        { scopeKey, rowId, timeoutMs: AUTO_COMPACT_TIMEOUT_MS, backoffMs: AUTO_COMPACT_TIMEOUT_BACKOFF_MS },
        'auto compact timed out',
      );
      this.clearSilentCompact(scopeKey);
      this.finishAutoCompact(scopeKey);
      this.autoCompactCooldownUntil.set(scopeKey, Date.now() + AUTO_COMPACT_TIMEOUT_BACKOFF_MS);
    }, AUTO_COMPACT_TIMEOUT_MS);
    timer.unref?.();

    const promise = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
    this.autoCompactWaiters.set(scopeKey, { promise, resolve: resolveWaiter, timer });
    this.beginSilentCompact(scopeKey);

    log.info({
      scopeKey,
      rowId,
      inputSinceCompact,
      threshold: this.autoCompactInputTokens,
    }, 'auto compact triggered');

    void session.sendTurn('/compact').catch((err) => {
      log.warn({ err, scopeKey, rowId }, 'auto compact send failed');
      this.clearSilentCompact(scopeKey);
      this.finishAutoCompact(scopeKey);
    });
  }

  private assertNoActiveUserTurn(scopeKey: string): void {
    if (this.sessionScope === 'per_chat') {
      if ((this.perChatInboundSeqQueue.get(scopeKey)?.length ?? 0) > 0) {
        throw new AgentCommandRuntimeError(
          'turn_in_progress',
          'agent command rejected because the target chat already has a turn in progress',
          409,
        );
      }
      return;
    }

    if (this.currentInboundSeq !== undefined || this.currentTurnChatJid !== null) {
      throw new AgentCommandRuntimeError(
        'turn_in_progress',
        'agent command rejected because the agent already has a turn in progress',
        409,
      );
    }
  }

  private getOpenFileDescriptorCount(): number | null {
    try {
      return readdirSync('/proc/self/fd').length;
    } catch (err) {
      log.debug({ err }, 'failed to count open file descriptors');
      return null;
    }
  }

  private logHealthStats(): void {
    const memoryUsage = process.memoryUsage();

    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
      chatSessions: this.chatSessions.size,
      chatQueues: this.chatQueues.size,
      outboundQueues: this.outboundQueues.size,
      workspaceResources: this.workspaceResources.size,
      fdCount: this.getOpenFileDescriptorCount(),
      memoryUsage: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers,
      },
      recentCrashCount: this.getRecentCrashCount(),
      lastCrashAt: this.lastCrashAt,
    }, 'agent runtime health stats');
  }

  private startHealthStatsTimer(): void {
    if (this.healthStatsTimer) return;
    this.healthStatsTimer = setInterval(() => this.logHealthStats(), HEALTH_STATS_INTERVAL_MS);
    this.healthStatsTimer.unref?.();
  }

  private startQueueSweepTimer(): void {
    if (!this.shared || this.queueSweepTimer) return;
    this.queueSweepTimer = setInterval(() => this.sweepIdleQueues(), SHARED_QUEUE_SWEEP_INTERVAL_MS);
    this.queueSweepTimer.unref?.();
  }

  private startWorkspaceSweepTimer(): void {
    if (!this.sandboxPerChat || this.workspaceSweepTimer) return;
    this.workspaceSweepTimer = setInterval(
      () => this.sweepIdleWorkspaces(),
      AgentRuntime.WORKSPACE_SWEEP_INTERVAL_MS,
    );
    this.workspaceSweepTimer.unref?.();
  }

  private sweepIdleQueues(): void {
    if (!this.shared) return;

    const now = Date.now();
    for (const [chatJid, queue] of this.outboundQueues) {
      const lastActivity = typeof queue.lastActivity === 'number' ? queue.lastActivity : now;
      const idleMs = now - lastActivity;
      if (idleMs <= SHARED_QUEUE_IDLE_MS) continue;
      if (chatJid === this.currentTurnChatJid) continue;
      if (queue.hasPendingWork?.() === true) continue;

      log.debug({ chatJid, idleMs }, 'evicting idle outbound queue');
      void queue.shutdown().catch((err) => {
        log.warn({ err, chatJid }, 'idle outbound queue shutdown failed');
      });
      this.outboundQueues.delete(chatJid);
    }
  }

  private sweepIdleWorkspaces(): void {
    if (!this.sandboxPerChat) return;

    const now = Date.now();
    for (const [workspaceKey, res] of this.workspaceResources) {
      const session = this.chatSessions.get(workspaceKey);
      if (session?.getStatus().active) {
        res.lastActivity = now;
        continue;
      }

      const idleMs = now - res.lastActivity;
      if (idleMs <= AgentRuntime.WORKSPACE_IDLE_MS) continue;

      log.info({ workspaceKey, idleMs }, 'evicting idle workspace resources');

      if (res.socketServer) {
        try {
          res.socketServer.stop();
        } catch (err) {
          log.warn({ err, workspaceKey, socketPath: res.socketPath }, 'idle workspace socket server stop failed');
        }
      }
      if (res.mediaBridge) {
        try {
          res.mediaBridge();
        } catch (err) {
          log.warn({ err, workspaceKey, workspacePath: res.workspacePath }, 'idle workspace media bridge stop failed');
        }
      }

      this.workspaceResources.delete(workspaceKey);
    }
  }

  private touchWorkspaceActivity(mapKey: string | undefined): void {
    if (mapKey === undefined) return;
    const res = this.workspaceResources.get(mapKey);
    if (res) {
      res.lastActivity = Date.now();
    }
  }

  // Tracks inbound seq for the current turn (single/shared mode)
  private currentInboundSeq: number | undefined;
  // Tracks inbound seq per chat key (per_chat mode — chats are concurrent)
  // FIFO queue: push on dispatch, shift on result to prevent race when turns overlap.
  private perChatInboundSeqQueue: Map<string, number[]> = new Map();

  // Startup notification deferred until after WA connects
  private pendingStartupMessage: { chatJid: string; text: string } | null = null;

  // Voice reply state (SP4) — tracks inbound contentType and accumulated assistant text per turn.
  // Per-chat mode uses Maps keyed by mapKey; single/shared mode uses scalar fields.
  private currentTurnInboundContentType: string | null = null;
  private currentTurnAssistantText = '';
  private currentTurnAssistantItemText: Map<string, string> = new Map();
  private perChatTurnContentType: Map<string, string> = new Map();
  private perChatTurnText: Map<string, string> = new Map();
  private perChatAssistantItemText: Map<string, Map<string, string>> = new Map();

  // Tracks the most recent turn text per chat (keyed by workspaceKey or chatJid).
  // Used to replay a message when session resume fails and the turn was lost.
  private pendingTurnText: Map<string, string> = new Map();

  // ---------------------------------------------------------------------------
  // Image coalescing — batch rapid image sends into a single turn
  // ---------------------------------------------------------------------------
  // When multiple images arrive for the same chat within IMAGE_COALESCE_MS,
  // they're collected and sent as one combined turn to avoid hitting Claude's
  // per-image dimension limits in multi-image sessions.
  private static readonly IMAGE_COALESCE_MS = 3_000;
  private static readonly MAX_COALESCE_BATCH = 20;
  private imageCoalesceBuffers: Map<string, {
    texts: string[];
    timer: ReturnType<typeof setTimeout>;
    msg: IncomingMessage;
    inboundSeqs: number[];
  }> = new Map();

  // Set of mapKeys for which handleResumeFailed is currently managing context
  // injection + pending-turn replay. Used to suppress context injection in any
  // concurrent sendTurnToSession call for the same chat, preventing double injection.
  private resumeFailedHandling: Set<string> = new Set();

  // Global socket server (non-sandboxPerChat mode)
  private globalSocketServer: WhatSoupSocketServer | null = null;

  private durability: DurabilityEngine | null = null;

  private getPerChatAssistantItemMap(mapKey: string): Map<string, string> {
    const existing = this.perChatAssistantItemText.get(mapKey);
    if (existing) return existing;
    const created = new Map<string, string>();
    this.perChatAssistantItemText.set(mapKey, created);
    return created;
  }

  private markImageCoalesceSeqsSkipped(mapKey: string, inboundSeqs: number[], reason: string): void {
    if (!this.durability) return;
    for (const seq of inboundSeqs) {
      try {
        this.replyGuarantee?.disarm(seq);
        this.durability.markInboundSkipped(seq, reason);
      } catch (err) {
        log.warn({ err, mapKey, seq, reason }, 'failed to mark image coalesce seq skipped');
      }
    }
  }

  private markImageCoalesceSeqFailed(mapKey: string, seq: number): void {
    if (!this.durability) return;
    try {
      this.replyGuarantee?.disarm(seq);
      this.durability.markInboundFailed(seq);
    } catch (err) {
      log.warn({ err, mapKey, seq }, 'failed to mark image coalesce representative seq failed');
    }
  }

  private abortImageCoalesceBuffer(mapKey: string, reason: string): boolean {
    const imgBuf = this.imageCoalesceBuffers.get(mapKey);
    if (!imgBuf) return false;
    clearTimeout(imgBuf.timer);
    this.imageCoalesceBuffers.delete(mapKey);
    this.markImageCoalesceSeqsSkipped(mapKey, imgBuf.inboundSeqs, reason);
    return true;
  }

  /**
   * Remove all per-chat auxiliary state for a given map key.
   * Call this whenever a session is removed from chatSessions.
   */
  private cleanupPerChatState(mapKey: string): void {
    this.perChatCrashCount.delete(mapKey);
    this.perChatInboundSeqQueue.delete(mapKey);
    this.perChatTurnContentType.delete(mapKey);
    this.perChatTurnText.delete(mapKey);
    this.perChatAssistantItemText.delete(mapKey);
    this.pendingTurnText.delete(mapKey);
    this.resumeFailedHandling.delete(mapKey);
    this.postTurnGate.delete(mapKey);
    this.compactBoundaryScopes.delete(mapKey);
    this.autoCompactCooldownUntil.delete(mapKey);
    this.finishAutoCompact(mapKey);
    this.clearSilentCompact(mapKey);
    // Cancel any pending image coalesce buffer
    this.abortImageCoalesceBuffer(mapKey, 'cleanup_aborted');
    // Clean up operation tracker for this chat
    const tracker = this.operationTrackers.get(mapKey);
    if (tracker) {
      tracker.shutdown();
      this.operationTrackers.delete(mapKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Image coalescing methods
  // ---------------------------------------------------------------------------

  /**
   * Buffer an image turn. If more images arrive within IMAGE_COALESCE_MS,
   * they're appended. When the timer fires (or a non-image message arrives),
   * all buffered images are sent as a single combined turn.
   *
   * Seq/state setup is deferred to flush time — only the representative
   * turn gets a seq entry, preventing desync with the shift-one-per-turn
   * logic in handleEventPerChat.
   */
  private async coalesceImageTurn(mapKey: string, chatJid: string, text: string, msg: IncomingMessage): Promise<void> {
    const existing = this.imageCoalesceBuffers.get(mapKey);
    if (existing) {
      // More images arriving — append and reset timer
      existing.texts.push(text);
      if (msg.inboundSeq !== undefined) existing.inboundSeqs.push(msg.inboundSeq);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => void this.flushImageCoalesce(mapKey), AgentRuntime.IMAGE_COALESCE_MS);
      if (existing.texts.length >= AgentRuntime.MAX_COALESCE_BATCH) {
        log.warn({
          mapKey,
          bufferedCount: existing.texts.length,
          maxBatch: AgentRuntime.MAX_COALESCE_BATCH,
        }, 'image coalesce batch limit reached — flushing immediately');
        await this.flushImageCoalesce(mapKey);
        return;
      }
      log.info({ mapKey, bufferedCount: existing.texts.length }, 'image coalesced into batch');
    } else {
      // First image — start the coalesce window
      const timer = setTimeout(() => void this.flushImageCoalesce(mapKey), AgentRuntime.IMAGE_COALESCE_MS);
      this.imageCoalesceBuffers.set(mapKey, {
        texts: [text],
        timer,
        msg,
        inboundSeqs: msg.inboundSeq !== undefined ? [msg.inboundSeq] : [],
      });
      log.info({ mapKey }, 'image coalesce window opened');
    }
  }

  /**
   * Flush the image coalesce buffer for a chat — send all buffered images
   * as a single combined turn. Returns a Promise so callers can await it
   * to prevent concurrent turn injection.
   *
   * Durability: only the LAST inboundSeq is pushed onto perChatInboundSeqQueue
   * (the representative seq for this combined turn). Earlier seqs are marked
   * skipped with reason 'coalesced_image' via durability engine.
   */
  private async flushImageCoalesce(mapKey: string): Promise<void> {
    if (this.resumeFailedHandling.has(mapKey)) {
      const aborted = this.abortImageCoalesceBuffer(mapKey, 'resume_failed');
      if (aborted) {
        log.warn({ mapKey }, 'image coalesce flush skipped during resume-failed recovery');
      }
      return;
    }

    const entry = this.imageCoalesceBuffers.get(mapKey);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.imageCoalesceBuffers.delete(mapKey);

    const { texts, msg, inboundSeqs } = entry;
    const chatJid = msg.chatJid;
    const count = texts.length;
    const representativeSeq = inboundSeqs.length > 0 ? inboundSeqs[inboundSeqs.length - 1] : undefined;
    let queuedRepresentativeSeq = false;

    try {
      // Mark all-but-last inbound seqs as coalesced (they won't get their own turn)
      if (inboundSeqs.length > 1) {
        this.markImageCoalesceSeqsSkipped(mapKey, inboundSeqs.slice(0, -1), 'coalesced_image');
      }

      // Push only the representative (last) seq onto the per-chat queue
      const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
      if (representativeSeq !== undefined) {
        seqQueue.push(representativeSeq);
        queuedRepresentativeSeq = true;
      }
      this.perChatInboundSeqQueue.set(mapKey, seqQueue);
      this.getQueueForChat(chatJid, mapKey)?.setInboundSeq(representativeSeq);

      // Set state for this turn
      this.perChatTurnContentType.set(mapKey, 'image');
      this.perChatTurnText.set(mapKey, '');
      this.perChatAssistantItemText.delete(mapKey);

      // Combine all image references into one turn
      let combinedText: string;
      if (count === 1) {
        combinedText = texts[0];
      } else {
        combinedText = `[${count} images received]\n${texts.join('\n')}`;
        log.info({ mapKey, imageCount: count, coalescedSeqs: inboundSeqs.length - 1 }, 'flushing coalesced image batch as single turn');
      }

      await this.sendTurnPerChat(chatJid, combinedText, mapKey, msg.senderJid);
    } catch (err) {
      if (representativeSeq !== undefined) {
        if (queuedRepresentativeSeq) {
          const seqQueue = this.perChatInboundSeqQueue.get(mapKey);
          const idx = seqQueue?.indexOf(representativeSeq) ?? -1;
          if (seqQueue && idx >= 0) seqQueue.splice(idx, 1);
          if (seqQueue?.length === 0) this.perChatInboundSeqQueue.delete(mapKey);
        }
        this.markImageCoalesceSeqFailed(mapKey, representativeSeq);
      }
      this.pendingTurnText.delete(mapKey);
      this.perChatTurnContentType.delete(mapKey);
      this.perChatTurnText.delete(mapKey);
      this.perChatAssistantItemText.delete(mapKey);
      log.error({ err, mapKey, imageCount: count }, 'failed to send coalesced image turn');
    }
  }

  private normalizeAssistantTextForDelivery(
    event: Extract<AgentEvent, { type: 'assistant_text' }>,
    mapKey?: string,
  ): string | null {
    if (!event.itemId) return event.text;

    const itemMap = mapKey !== undefined
      ? this.getPerChatAssistantItemMap(mapKey)
      : this.currentTurnAssistantItemText;

    const prior = itemMap.get(event.itemId) ?? '';

    if (!event.complete) {
      itemMap.set(event.itemId, prior + event.text);
      return event.text;
    }

    itemMap.delete(event.itemId);
    if (!prior) return event.text;
    if (event.text === prior) return null;
    if (event.text.startsWith(prior)) return event.text.slice(prior.length);
    return event.text;
  }

  // ─── Control session (self-healing repair) ────────────────────────────────
  private activeControlReportId: string | null = null;
  private controlSession: SessionManager | null = null;
  private controlSessionTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(db: Database, messenger: Messenger, instanceName?: string, options?: AgentRuntimeOptions) {
    this.db = db;
    this.messenger = messenger;
    this.instanceName = instanceName ?? 'personal';
    this.sessionScope = options?.sessionScope ?? (options?.shared ? 'shared' : 'single');
    this.shared = this.sessionScope === 'shared';
    this.cwd = options?.cwd;
    this.configSystemPrompt = options?.configSystemPrompt;
    this.instructionsPath = options?.instructionsPath;
    this.sandbox = options?.sandbox;
    this.model = options?.model;
    this.sandboxPerChat = options?.sandboxPerChat ?? false;
    this.pluginDirs = options?.pluginDirs ?? [];
    this.enabledPlugins = options?.enabledPlugins;
    this.allowM365Mutations = options?.allowM365Mutations;
    this.autoCompactInputTokens =
      typeof options?.autoCompactInputTokens === 'number' &&
      Number.isFinite(options.autoCompactInputTokens) &&
      options.autoCompactInputTokens > 0
        ? Math.floor(options.autoCompactInputTokens)
        : undefined;
    this.replyGuaranteeTimeoutMs = options?.replyGuaranteeTimeoutMs ?? DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS;
    this.agentProvider = config.agentProvider;
    this.agentProviderConfig = config.agentProviderConfig;

    this.registry = new ToolRegistry();
    this.registerAllTools();

    this.turnQueue = new TurnQueue({
      maxDepth: config.agentMaxQueueDepth,
      onReject: (turn) => {
        log.warn({ chatJid: turn.chatJid, senderJid: turn.senderJid },
          'turn rejected — agent queue full');
      },
    });
    this.turnQueue.setProcessor((turn) => this.processTurn(turn));
  }

  private registerAllTools(): void {
    const allowGlobalKnowledgeSearch = (config as {
      memory?: { pinecone?: { knowledgeSearch?: { allowGlobalAgentSessions?: boolean } } };
    }).memory?.pinecone?.knowledgeSearch?.allowGlobalAgentSessions === true;
    registerAllTools(this.registry, this.messenger as ConnectionManager, this.db, {
      enableKnowledgeSearch: this.sandboxPerChat || allowGlobalKnowledgeSearch,
    });
  }

  /** Create and configure an OutboundQueue with shared settings (durability, toolUpdateMode). */
  private createOutboundQueue(chatJid: string, reason: string): OutboundQueue {
    const q = new OutboundQueue(this.messenger, chatJid);
    if (this.durability) q.setDurability(this.durability);
    q.setToolUpdateMode(config.toolUpdateMode);
    q.setToolUpdateRedirectJid(config.toolUpdateRedirectJid);
    q.setTextAggregateDelayMs(config.textAggregateDelayMs);
    log.debug({
      chatJid,
      reason,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
      hasDurability: this.durability !== null,
    }, 'created outbound queue');
    return q;
  }

  setDurability(engine: DurabilityEngine): void {
    this.durability = engine;
    this.registry.setDurability(engine);
    this.replyGuarantee?.shutdown();
    this.replyGuarantee = new ReplyGuaranteeManager({
      durability: engine,
      timeoutMs: this.replyGuaranteeTimeoutMs,
      sendFallback: createAuditedReplyGuaranteeSender({
        messenger: this.messenger,
        resolver: createChatResolver({ db: this.db.raw }),
        auditWriter: createOutboundSendsWriter({ db: this.db.raw, line: this.instanceName }),
      }),
    });
    // Propagate to any already-created outbound queues
    if (this.queue) this.queue.setDurability(engine);
    for (const q of this.outboundQueues.values()) q.setDurability(engine);
    for (const q of this.chatQueues.values()) q.setDurability(engine);
  }

  /**
   * Update delivery JID for active sessions and queues when a LID→phone
   * mapping changes. Iterates per-chat queues and socket servers keyed
   * by conversationKey (sandboxPerChat mode) or raw chatJid.
   */
  handleJidAliasChanged(conversationKey: string, newJid: string): void {
    // Per-chat queues (sandboxPerChat or per_chat mode)
    const queue = this.chatQueues.get(conversationKey);
    if (queue) {
      queue.updateDeliveryJid(newJid);
      log.info({ conversationKey, newJid }, 'updated delivery JID on outbound queue');
    }

    // Per-chat socket servers
    const res = this.workspaceResources.get(conversationKey);
    if (res?.socketServer) {
      res.socketServer.updateDeliveryJid(newJid);
      log.info({ conversationKey, newJid }, 'updated delivery JID on socket server');
    }

    // Shared-mode outbound queues (keyed by canonical JID — may need re-key)
    for (const [key, q] of this.outboundQueues) {
      try {
        if (toConversationKey(key) === conversationKey) {
          q.updateDeliveryJid(newJid);
          // Re-key from old LID-based key to canonical phone JID
          const canonical = canonicalizeChatJid(newJid, this.db);
          if (key !== canonical) {
            this.outboundQueues.delete(key);
            this.outboundQueues.set(canonical, q);
            log.info({ oldKey: key, newKey: canonical }, 'shared-mode: re-keyed outbound queue after LID resolution');
          }
        }
      } catch (err) {
        log.debug({ err, key }, 'JID parsing failed during session resume — skipping');
      }
    }

    // Single-mode queue
    if (this.queue) {
      this.queue.updateDeliveryJid(newJid);
    }

    // Re-key per_chat maps: if a session is stored under a LID-based key,
    // migrate it to the canonical phone JID now that the mapping is known.
    // All co-keyed maps must be migrated atomically.
    if (this.sessionScope === 'per_chat' && !this.sandboxPerChat) {
      const lidKey = `${conversationKey}@lid`;
      if (this.chatSessions.has(lidKey)) {
        const canonical = canonicalizeChatJid(newJid, this.db);
        if (canonical !== lidKey && !this.chatSessions.has(canonical)) {
          // Migrate session
          const session = this.chatSessions.get(lidKey)!;
          this.chatSessions.delete(lidKey);
          this.chatSessions.set(canonical, session);

          // Migrate queue
          const chatQueue = this.chatQueues.get(lidKey);
          if (chatQueue) {
            chatQueue.updateDeliveryJid(newJid);
            this.chatQueues.delete(lidKey);
            this.chatQueues.set(canonical, chatQueue);
          }

          // Migrate all co-keyed per-chat maps
          const seqQueue = this.perChatInboundSeqQueue.get(lidKey);
          if (seqQueue) {
            this.perChatInboundSeqQueue.delete(lidKey);
            this.perChatInboundSeqQueue.set(canonical, seqQueue);
          }
          const pending = this.pendingTurnText.get(lidKey);
          if (pending !== undefined) {
            this.pendingTurnText.delete(lidKey);
            this.pendingTurnText.set(canonical, pending);
          }
          const crashCount = this.perChatCrashCount.get(lidKey);
          if (crashCount !== undefined) {
            this.perChatCrashCount.delete(lidKey);
            this.perChatCrashCount.set(canonical, crashCount);
          }
          const contentType = this.perChatTurnContentType.get(lidKey);
          if (contentType !== undefined) {
            this.perChatTurnContentType.delete(lidKey);
            this.perChatTurnContentType.set(canonical, contentType);
          }
          const turnText = this.perChatTurnText.get(lidKey);
          if (turnText !== undefined) {
            this.perChatTurnText.delete(lidKey);
            this.perChatTurnText.set(canonical, turnText);
          }
          const itemText = this.perChatAssistantItemText.get(lidKey);
          if (itemText) {
            this.perChatAssistantItemText.delete(lidKey);
            this.perChatAssistantItemText.set(canonical, itemText);
          }
          if (this.resumeFailedHandling.has(lidKey)) {
            this.resumeFailedHandling.delete(lidKey);
            this.resumeFailedHandling.add(canonical);
          }
          const imageBuffer = this.imageCoalesceBuffers.get(lidKey);
          if (imageBuffer) {
            clearTimeout(imageBuffer.timer);
            imageBuffer.timer = setTimeout(
              () => void this.flushImageCoalesce(canonical),
              AgentRuntime.IMAGE_COALESCE_MS,
            );
            imageBuffer.msg = { ...imageBuffer.msg, chatJid: newJid };
            this.imageCoalesceBuffers.delete(lidKey);
            this.imageCoalesceBuffers.set(canonical, imageBuffer);
          }
          this.cleanupPerChatState(lidKey);
          log.info({ lidKey, canonical, newJid }, 'per_chat: re-keyed session and all maps after LID resolution');
        }
      }
    }
  }

  async start(): Promise<void> {
    ensureAgentSchema(this.db);
    backfillSessionProvider(this.db, this.agentProvider ?? 'claude-cli');

    // Write sandbox policy and hook settings when sandbox config is present
    if (this.sandbox) {
      const cwd = this.cwd ?? homedir();
      try {
        const claudeDir = join(cwd, '.claude');
        mkdirSync(claudeDir, { recursive: true, mode: 0o700 });

        // Resolve allowedPaths to absolute paths before writing
        const resolvedPolicy = {
          ...this.sandbox,
          allowedPaths: this.sandbox.allowedPaths.map(p =>
            p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p),
          ),
        };
        const hookPath = resolve(
          new URL('.', import.meta.url).pathname,
          '../../../deploy/hooks/agent-sandbox.sh',
        );
        writeSandboxArtifacts(claudeDir, resolvedPolicy, hookPath);
        log.info({ cwd, hookPath }, 'wrote sandbox-policy.json and settings.json');
      } catch (err) {
        log.error({ err, cwd }, 'failed to initialize sandbox artifacts');
        throw err;
      }
    }

    // Ensure settings.json has a permissions block — safety net for instances
    // without sandbox config. Prevents Claude Code's "sensitive file" blocks.
    {
      const cwd = this.cwd ?? homedir();
      try {
        const claudeDir = join(cwd, '.claude');
        ensurePermissionsSettings(claudeDir, 'agent', this.enabledPlugins);
      } catch (err) {
        log.error({ err, cwd }, 'failed to ensure permissions settings during startup');
        throw err;
      }
    }

    // Start global WhatSoup socket server (non-sandboxPerChat mode only)
    if (!this.sandboxPerChat) {
      const agentCwd = this.cwd ?? homedir();
      try {
        const claudeDir = join(agentCwd, '.claude');
        mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
        const socketPath = join(claudeDir, 'whatsoup.sock');

        const globalSession: SessionContext = { tier: 'global' };
        this.globalSocketServer = new WhatSoupSocketServer(socketPath, this.registry, globalSession);
        this.globalSocketServer.start();
        this.globalMcpSocketPath = socketPath;
        log.info({ socketPath }, 'global WhatSoup socket server started');

        // Write .mcp.json so Claude Code discovers the whatsoup MCP server
        const mcpServerScript = resolve(
          new URL('.', import.meta.url).pathname,
          '../../../deploy/mcp/whatsoup-proxy.ts',
        );
        const mcpConfig = generateMcpConfigFile('claude-cli', socketPath, mcpServerScript);
        writePrivateFileSync(join(agentCwd, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));
        log.info({ agentCwd }, 'wrote .mcp.json for whatsoup');
      } catch (err) {
        if (this.globalSocketServer) {
          try {
            this.globalSocketServer.stop();
          } catch (stopErr) {
            log.warn({ err: stopErr, agentCwd }, 'failed to clean up global socket server after startup error');
          }
          this.globalSocketServer = null;
        }
        this.globalMcpSocketPath = null;
        log.error({ err, agentCwd }, 'failed to initialize global MCP socket resources');
        throw err;
      }
    }

    // sandboxPerChat: backfill workspace keys for legacy rows
    if (this.sandboxPerChat) {
      backfillWorkspaceKeys(this.db, this.cwd ?? homedir());
    }

    // Sweep stale sessions for all per_chat modes (including Q's non-sandboxed per_chat).
    // Cross-references agent_sessions with session_checkpoints to safely identify which
    // processes to keep and which to reap. Only kills PIDs verified as owned children.
    if (this.sessionScope === 'per_chat' || this.sandboxPerChat) {
      if (!this.durability) {
        log.warn('durability engine not set — skipping active session classification');
      } else {
        const classified = classifyActiveSessions(this.db, this.durability);
        for (const session of classified) {
          switch (session.classification) {
            case 'stale_dead':
              markOrphaned(this.db, session.id);
              break;
            case 'stale_live':
              log.warn({
                id: session.id,
                pid: session.claudePid,
                conversationKey: session.conversationKey,
                reason: session.reason,
              }, 'reaping stale session');
              try { process.kill(session.claudePid, 'SIGTERM'); } catch { /* already gone */ }
              markOrphaned(this.db, session.id);
              break;
            case 'ambiguous':
              log.warn({
                id: session.id,
                pid: session.claudePid,
                conversationKey: session.conversationKey,
                reason: session.reason,
              }, 'ambiguous session — not touching');
              break;
            // authoritative_live: leave alone
          }
        }
      }
    }

    // per_chat (non-sandboxed): proactively resume sessions that were active or suspended
    // (graceful shutdown) when we last ran. This lets agents pick up mid-conversation instead
    // of waiting for the user to send a message after a service restart.
    // sandboxPerChat is excluded — its resume path requires workspace provisioning which happens lazily.
    if (this.sessionScope === 'per_chat' && !this.sandboxPerChat && this.durability) {
      const resumableCheckpoints = this.durability.getResumableCheckpoints();
      for (const cp of resumableCheckpoints) {
        const full = this.durability.getSessionCheckpoint(cp.conversation_key);
        if (!full?.session_id) continue;

        // AE1: Skip group conversations — groups should not be proactively resumed.
        // Agents in groups are orchestrated via @mentions. Proactive resume bypasses
        // the ingest pipeline's sibling filter (access-policy.ts:121-124), causing
        // unsolicited messages. Group sessions start fresh on the next @mention.
        if (isGroupConversationKey(cp.conversation_key)) {
          log.info({ conversationKey: cp.conversation_key }, 'skipping proactive resume — group chat');
          this.durability.upsertSessionCheckpoint(cp.conversation_key, { sessionStatus: 'ended' });
          continue;
        }

        // Skip stale sessions — don't resume conversations that have been inactive for over 60 minutes.
        // Without this, every restart tries to resurrect days-old sessions and fires unsolicited messages.
        const RESUME_MAX_AGE_MS = 60 * 60 * 1000;
        if (full.updated_at) {
          const age = Date.now() - new Date(full.updated_at + 'Z').getTime();
          if (age > RESUME_MAX_AGE_MS) {
            log.info({ conversationKey: cp.conversation_key, ageMinutes: Math.round(age / 60_000) }, 'skipping proactive resume — session too stale');
            this.durability.upsertSessionCheckpoint(cp.conversation_key, { sessionStatus: 'ended' });
            continue;
          }
        }

        // Derive chatJid from conversation_key — for DMs, append @lid; for groups, use as-is
        const chatJid = cp.conversation_key.includes('_at_')
          ? cp.conversation_key.replace('_at_', '@')
          : `${cp.conversation_key}@lid`;

        const initialMapKey = this.resolvePerChatMapKey(chatJid);
        if (this.chatSessions.has(initialMapKey)) continue; // already created by sweep or prior iteration

        log.info({ conversationKey: cp.conversation_key, sessionId: full.session_id, chatJid, mapKey: initialMapKey }, 'proactive per_chat resume on startup');

        // Create session + queue (same as ensureSessionAndQueueSync but with resume)
        const toolScopeKey = this.createToolScopeKey(initialMapKey);
        let session!: SessionManager;
        const resolveSessionMapKey = () => this.findMapKeyForSession(session, initialMapKey);
        session = this.createSessionManager({
          chatJid,
          cwd: this.cwd,
          onEvent: (event) => {
            const mapKey = resolveSessionMapKey();
            if (!mapKey) {
              log.debug({ initialMapKey, chatJid, eventType: event.type }, 'event dropped — session key missing for per-chat callback');
              return;
            }
            this.handleEventPerChat(mapKey, event, toolScopeKey);
          },
          onCrash: (info) => {
            const mapKey = resolveSessionMapKey() ?? initialMapKey;
            this.handlePerChatCrash(mapKey, chatJid, info);
          },
          notifyUser: (msg) => {
            const mapKey = resolveSessionMapKey();
            if (mapKey) {
              const s = this.chatSessions.get(mapKey);
              if (s && !s.getStatus().active) {
                this.chatSessions.delete(mapKey);
                this.chatQueues.get(mapKey)?.abortTurn();
                this.chatQueues.delete(mapKey);
                this.cleanupPerChatState(mapKey);
              }
            }
            this.handleCrashNotify(msg, chatJid);
          },
        });
        this.chatSessions.set(initialMapKey, session);
        const perChatQ = this.createOutboundQueue(chatJid, 'startup proactive per-chat resume');
        this.chatQueues.set(initialMapKey, perChatQ);

        // Wire operation tracker for this proactively-resumed per-chat session
        const startupTracker = this.createOperationTracker(session, () => this.chatQueues.get(initialMapKey));
        if (startupTracker) this.operationTrackers.set(initialMapKey, startupTracker);

        // Attempt resume, then inject any messages the agent missed during
        // downtime and send a continuation turn so the agent picks up where it
        // left off without requiring the user to send "proceed".
        const checkpointUpdatedAt = full.updated_at
          ? Math.floor(new Date(full.updated_at + 'Z').getTime() / 1000)
          : undefined;
        session.spawnSession(full.session_id).then(async () => {
          // Small delay to let the init event propagate (confirms resume succeeded)
          await new Promise(r => setTimeout(r, 1_000));
          if (!session.getStatus().active) return; // resume failed, onResumeFailed handles it
          try {
            // Inject messages that arrived while the service was down.
            // Without this, the agent resumes with stale context — it has no
            // awareness of messages sent during the downtime window.
            if (checkpointUpdatedAt) {
              await this.injectMissedMessages(session, chatJid, checkpointUpdatedAt);
            }
            await session.sendTurn('[System: session resumed after service restart — continue where you left off]');
            log.info({ chatJid }, 'sent continuation turn after proactive resume');
          } catch (err) {
            log.warn({ err, chatJid }, 'failed to send continuation turn after resume');
          }
        }).catch((err) => {
          log.warn({ err, chatJid, sessionId: full.session_id }, 'proactive resume failed — will retry on next message');
        });
      }
    }

    // Attempt to resume a prior active session.
    // Skipped for per_chat mode (all variants) — per_chat resume is handled above (proactive) or lazily.
    // Without this guard, per_chat + !sandboxPerChat would set this.session to a stale session
    // that no subsequent handleMessage call routes to (they use chatSessions maps instead).
    const prior = (this.sandboxPerChat || this.sessionScope === 'per_chat') ? null : getActiveSession(this.db);

    // AE2: Staleness check for shared/single mode — match per_chat's 60-minute threshold.
    let priorSession = prior;

    // Guard: chat_jid may be null for legacy session rows
    if (priorSession && !priorSession.chat_jid) {
      log.info('skipping shared/single resume — no chat_jid on session row');
      priorSession = null;
    }

    if (priorSession && this.durability) {
      const ck = toConversationKey(priorSession.chat_jid!);
      const checkpoint = this.durability.getSessionCheckpoint(ck);
      if (checkpoint?.updated_at) {
        const ageMs = Date.now() - new Date(checkpoint.updated_at + 'Z').getTime();
        if (ageMs > 60 * 60 * 1000) {
          log.info({ chatJid: priorSession.chat_jid, ageMinutes: Math.round(ageMs / 60_000) },
            'skipping shared/single resume — session too stale');
          this.durability.upsertSessionCheckpoint(ck, { sessionStatus: 'ended' });
          priorSession = null;
        }
      } else {
        // No checkpoint or updated_at absent — cannot verify freshness, skip resume
        log.info({ chatJid: priorSession?.chat_jid }, 'skipping shared/single resume — no checkpoint or no updated_at');
        priorSession = null;
      }
    }

    // AE2 fallback: when durability is absent, use started_at directly
    if (priorSession && !this.durability && priorSession.started_at) {
      const ageMs = Date.now() - new Date(priorSession.started_at).getTime();
      if (ageMs > 60 * 60 * 1000) {
        log.info({ chatJid: priorSession.chat_jid, ageMinutes: Math.round(ageMs / 60_000) },
          'skipping shared/single resume — stale (no durability)');
        priorSession = null;
      }
    }

    if (priorSession?.session_id && priorSession?.chat_jid) {
      // Capture narrowed values before closures — TypeScript does not propagate
      // if-guard narrowing into lambdas, so priorSession.chat_jid inside the closure
      // would remain typed as string | null even though we've checked it.
      const resumeChatJid: string = priorSession.chat_jid;
      const resumeSessionId: string = priorSession.session_id;
      const isGroupChat = isGroupJid(resumeChatJid);

      // ── C1/C2/I2: Hoist group check before spawn/queue creation ──────────
      if (isGroupChat && !this.shared) {
        // Single mode + group: session can't serve DMs, skip entirely (Bug I2 fix —
        // previously spawned a full subprocess then immediately killed it).
        log.info({ chatJid: resumeChatJid, sessionId: resumeSessionId }, 'skipping single-mode resume — group chat');
      } else {
        log.info({ sessionId: resumeSessionId, chatJid: resumeChatJid }, 'resuming prior session');
        this.activeChatJid = resumeChatJid;
        this.session = this.createSessionManager({
          chatJid: resumeChatJid,
          cwd: this.cwd,
          onEvent: (event) => this.handleEvent(event),
          onResumeFailed: () => this.handleResumeFailed(resumeChatJid),
          onCrash: (info) => {
            this.recordCrash(GLOBAL_CRASH_SCOPE_KEY);
            this.getActiveQueue()?.abortTurn();
            this.cleanupSharedCrashTurnState();
            // Mark inbound event failed so it doesn't stay stuck in processing
            if (this.durability && this.currentInboundSeq !== undefined) {
              this.replyGuarantee?.disarm(this.currentInboundSeq);
              this.durability.markInboundFailed(this.currentInboundSeq);
              this.currentInboundSeq = undefined;
            }
            if (config.controlPeers.size > 0) {
              try {
                emitHealReport(this.db, this.messenger, this.durability, {
                  type: 'crash',
                  chatJid: resumeChatJid,
                  exitCode: info.exitCode ?? undefined,
                  signal: info.signal ?? undefined,
                }, this.activeControlReportId);
              } catch (err) {
                log.warn({ err }, 'failed to emit heal report for session crash');
              }
            }
          },
          notifyUser: (msg) => this.handleCrashNotify(msg),
        });

        // Bug C2 fix: Do NOT create a group-keyed queue for shared mode — it would
        // remain as a stale entry in outboundQueues since no startup message is sent.
        // The queue is created on-demand via ensureOutboundQueue when a real message arrives.
        if (!isGroupChat) {
          if (this.shared) {
            const q = this.createOutboundQueue(resumeChatJid, 'startup resume shared');
            this.outboundQueues.set(canonicalizeChatJid(resumeChatJid, this.db), q);
          } else {
            const q = this.createOutboundQueue(resumeChatJid, 'startup resume single');
            this.queue = q;
          }
        }

        // Wire operation tracker for resumed single/shared session
        this.operationTracker = this.createOperationTracker(this.session, () => this.getActiveQueue());

        // Bug C1 fix: Wrap spawnSession in try/catch — every other call site does this.
        // If spawn fails (bad session ID, corrupted state, claude-cli not found), clean up
        // gracefully instead of crashing the runtime.
        try {
          await this.session.spawnSession(resumeSessionId, priorSession.id);
        } catch (err) {
          log.warn({ err, sessionId: resumeSessionId, chatJid: resumeChatJid }, 'spawnSession failed during resume — cleaning up');
          this.operationTracker?.shutdown();
          this.operationTracker = null;
          this.session = null;
          this.activeChatJid = null;
          if (this.shared) {
            this.outboundQueues.delete(canonicalizeChatJid(resumeChatJid, this.db));
          } else {
            this.queue = null;
          }
          // Fall through — runtime continues without a resumed session
        }

        // Defer notification until after WA connects (sending here causes a fatal crash)
        if (this.session) {
          if (isGroupChat) {
            // Shared mode + group: session stays alive (serves DMs too), just no unsolicited group message.
            log.info({ chatJid: resumeChatJid }, 'suppressing startup message — shared-mode group chat');
          } else {
            const age = formatAge(priorSession.started_at);
            this.pendingStartupMessage = {
              chatJid: resumeChatJid,
              text: `_Resuming session_ from *${age}*. Send a message to continue, or /new to start fresh.`,
            };
          }
        }
      }
    }

    // Register emit_heal_result MCP tool (once, for control-plane repair completion).
    // Only on non-sandboxed instances (Q) — sandboxed instances (Loops) are repair targets, not repairers.
    // Tagged `core: false` because this registration is conditional on configured control peers;
    // see `src/mcp/types.ts` for the contract — non-core tools must tolerate absence on instances
    // that do not meet the gate (no control peers, sandbox mode, or per-chat sandbox).
    if (config.controlPeers.size > 0 && !this.sandboxPerChat && !this.sandbox) {
      this.registry.register({
        name: 'emit_heal_result',
        description: 'Signal completion of a repair cycle. Only callable during an active repair session.',
        schema: EmitHealResultSchema,
        scope: 'global',
        targetMode: 'caller-supplied',
        replayPolicy: 'unsafe',
        core: false,
        handler: async (params) => {
          const parsed = EmitHealResultSchema.parse(params);

          // Validate: must match active repair
          if (!this.activeControlReportId) {
            throw new Error('No active repair session');
          }
          if (parsed.reportId !== this.activeControlReportId) {
            throw new Error(`No active repair for reportId ${parsed.reportId}. Active: ${this.activeControlReportId}`);
          }

          const controlQueue = this.getControlQueue();
          if (!controlQueue) {
            throw new Error('Control queue not found');
          }

          // Determine target JID (Loops)
          const loopsPhone = [...config.controlPeers.entries()].find(([name]) => name === 'loops')?.[1];
          const loopsJid = loopsPhone ? toPersonalJid(loopsPhone) : null;

          if (parsed.result === 'fixed') {
            if (loopsJid) {
              await controlQueue.sendControlMessage(loopsJid, 'HEAL_COMPLETE', {
                reportId: parsed.reportId,
                errorClass: parsed.errorClass,
                result: 'fixed',
                commitSha: parsed.commitSha,
                diagnosis: parsed.diagnosis,
              }, this.durability ?? undefined);
            }
          } else {
            // escalate
            if (loopsJid) {
              await controlQueue.sendControlMessage(loopsJid, 'HEAL_ESCALATE', {
                reportId: parsed.reportId,
                errorClass: parsed.errorClass,
                diagnosis: parsed.diagnosis,
              }, this.durability ?? undefined);
            }
            // Also DM admin
            const adminPhone = [...config.adminPhones][0];
            if (adminPhone) {
              const adminJid = toPersonalJid(adminPhone);
              await sendTracked(this.messenger, adminJid,
                `[HEAL_ESCALATE] Repair for ${parsed.errorClass} escalated.\n\n${parsed.diagnosis}`,
                this.durability ?? undefined, { replayPolicy: 'safe' });
            }
          }

          // Resolve pending_heal_reports row (Type 3 cleanup)
          try {
            this.db.raw.prepare(
              "UPDATE pending_heal_reports SET state = 'resolved' WHERE report_id = ?",
            ).run(parsed.reportId);
          } catch { /* best-effort */ }

          // Clear hard timeout (normal completion path)
          if (this.controlSessionTimeout) {
            clearTimeout(this.controlSessionTimeout);
            this.controlSessionTimeout = null;
          }

          // Clear single-flight slot
          this.clearControlReport();

          // Dequeue next report if any
          const next = dequeueNextReport(this.db);
          if (next) {
            const context = next.context ? JSON.parse(next.context) : {};
            void this.handleControlTurn(next.report_id, JSON.stringify({
              ...context,
              reportId: next.report_id,
              errorClass: next.error_class,
            })).catch(err => {
              log.error({ err, reportId: next.report_id }, 'unhandled error in handleControlTurn');
            });
          }

          return { sent: true, reportId: parsed.reportId, result: parsed.result };
        },
      });
    }

    this.startHealthStatsTimer();
    this.startWorkspaceSweepTimer();
    this.startQueueSweepTimer();

    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
      sandboxed: this.sandbox !== undefined,
    }, 'AgentRuntime started');
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    // Process media messages (transcription, text extraction, etc.) before routing.
    // For text messages this is a no-op. For all other types we attempt to convert
    // to a plain-text representation suitable for the stream-json agent protocol.
    if (msg.contentType !== 'text') {
      try {
        msg.content = await prepareContentForAgent(msg, this.db, msg.messageId);
      } catch (err) {
        log.warn(
          { err, contentType: msg.contentType, messageId: msg.messageId },
          'media processing failed — using fallback label',
        );
        msg.content = `[${msg.contentType} message — processing failed]`;
      }
    }

    const content = msg.content;
    if (content === null || content.trim() === '') {
      log.warn(
        { messageId: msg.messageId, contentType: msg.contentType },
        'empty content after media processing — skipping',
      );
      // Mark inbound event as skipped so it doesn't stay stuck in 'processing'
      if (this.durability && msg.inboundSeq !== undefined) {
        this.durability.markInboundSkipped(msg.inboundSeq, 'empty_content');
      }
      return;
    }

    // Substrate slice 1: inline imperative extractor.
    // Gate on sender identity (admin-only), not deliveryJid. For any admin-authored
    // message containing an explicit imperative (remind/schedule/watch/track/...),
    // persist a proposed task bead immediately so the intent survives even if the
    // agent turn fails downstream. The bead lands as status='proposed' so a
    // drowsy or misfired match doesn't silently commit real work to the task list.
    try {
      const senderPhone = resolvePhoneFromJid(msg.senderJid, this.db);
      if (isAdminPhone(senderPhone, config.adminPhones)) {
        const hit = matchImperative(content);
        if (hit) {
          const target = extractImperativeTarget(content);
          const title = target && target.length > 0 ? target.slice(0, 200) : content.slice(0, 120);
          // review_by_at ensures proposals don't accumulate forever; the slice-4
          // sweep (or an operator) converts unreviewed rows to cancelled past this
          // horizon. Default is config.memory.sweep.reviewByDays * 86400 seconds.
          const reviewByAt = Math.floor(Date.now() / 1000) + config.memory.sweep.reviewByDays * 86400;
          createBead(this.db.raw, {
            kind: 'task',
            title,
            body: content,
            ownerJid: config.memory.adminJid || (senderPhone ?? msg.senderJid),
            chatJid: msg.chatJid,
            sourceMessagePk: null,
            status: 'proposed',
            confidence: 0.7,
            proposalReason: `inline imperative: ${hit.verb}`,
            reviewByAt,
            actor: 'inline',
          });
          log.info(
            { verb: hit.verb, messageId: msg.messageId, chatJid: msg.chatJid, reviewByAt },
            'inline imperative persisted as proposed bead',
          );
        }
      }
    } catch (err) {
      // Classify DB errors: unrecoverable ones (disk full, readonly, corrupt)
      // indicate infrastructure failure — surface them to the operator by
      // emitting alert and marking the inbound failed. Everything else
      // (extractor bugs, constraint errors on malformed extraction output)
      // is swallowed with a warn so a substrate bug doesn't drop the user's
      // message. Per spec §8.4 / INV-7: observability is a product surface.
      const msgText = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown })?.code;
      const codeStr = typeof code === 'string' ? code : '';
      const isUnrecoverable =
        /SQLITE_(FULL|READONLY|CORRUPT|IOERR|CANTOPEN|NOTADB)/i.test(msgText) ||
        /SQLITE_(FULL|READONLY|CORRUPT|IOERR|CANTOPEN|NOTADB)/i.test(codeStr);
      if (isUnrecoverable) {
        log.error(
          { err, messageId: msg.messageId, code: codeStr || 'unknown' },
          'inline extractor hook hit unrecoverable DB error — surfacing to operator',
        );
        emitAlert(
          this.instanceName,
          'substrate-inline-hook',
          `Unrecoverable DB error in inline extractor: ${msgText}`,
          `messageId=${msg.messageId} chatJid=${msg.chatJid} code=${codeStr || 'unknown'}`,
        );
        if (this.durability && msg.inboundSeq !== undefined) {
          this.replyGuarantee?.disarm(msg.inboundSeq);
          this.durability.markInboundFailed(msg.inboundSeq);
        }
        // Propagate so the outer turn-chain handler notifies the user and
        // the fleet supervisor sees the PID enter recovery rather than
        // silently continuing past disk-full conditions.
        throw err;
      }
      log.warn({ err, messageId: msg.messageId }, 'inline extractor hook failed (continuing)');
    }

    this.turnChain = this.turnChain
      .then(() => this._handleMessageInner(msg))
      .catch((err) => {
        log.error(
          { err, messageId: msg.messageId, chatJid: msg.chatJid },
          'unhandled error in message processing',
        );
        // Mark inbound event as failed so it doesn't stay stuck in 'processing'
        if (this.durability && msg.inboundSeq !== undefined) {
          this.replyGuarantee?.disarm(msg.inboundSeq);
          this.durability.markInboundFailed(msg.inboundSeq);
        }
        // Notify user of failure
        this.sendDirect(msg.chatJid, 'Something went wrong processing that message. Try again?');
      });
  }

  private async _handleMessageInner(msg: IncomingMessage): Promise<void> {
    let content = msg.content;
    const chatJid = msg.chatJid;
    const perChatMapKey = this.sessionScope === 'per_chat'
      ? this.resolvePerChatMapKey(chatJid)
      : undefined;

    // Substrate slice 1: propagate sender identity to every MCP session so
    // admin-gated substrate tools can distinguish the caller from the target
    // chat. In groups, msg.chatJid IS the group JID; without this propagation
    // admin gating would compare against the group JID and always reject.
    //
    // Two cases to cover:
    //   1. Global socket (single / shared / non-sandbox per_chat modes) —
    //      always active when !sandboxPerChat; update unconditionally.
    //   2. Per-chat sockets — only populated in workspaceResources when
    //      sandboxPerChat=true (async ensureSessionAndQueue path). The
    //      synchronous per_chat-without-sandbox path uses the global socket
    //      above and never allocates a per-chat socket, so the `workspaceResources`
    //      lookup here is only reachable under sandboxPerChat=true.
    this.globalSocketServer?.updateActorJid(msg.senderJid);
    if (this.sandboxPerChat) {
      await this.ensureSessionAndQueue(chatJid, msg.senderJid);
      const key = perChatMapKey ?? this.resolvePerChatMapKey(chatJid);
      const res = this.workspaceResources.get(key);
      res?.socketServer?.updateActorJid(msg.senderJid);
      // Relocate media files from global temp dir into user's workspace
      // so the agent can read them within its sandbox-allowed paths.
      if (content) {
        const { workspacePath } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);
        content = relocateMediaToWorkspace(content, workspacePath);
        msg.content = content;
      }
    } else if (this.sessionScope === 'per_chat') {
      this.ensureSessionAndQueueSync(chatJid, perChatMapKey!, msg.senderJid);
    } else {
      this.ensureSessionAndQueueSync(chatJid, undefined, msg.senderJid);
    }
    const classified = classifyInput(content as string);

    if (classified.type === 'local') {
      switch (classified.command) {
        case 'new':
          // Shared mode: /new is admin-only
          if (this.shared && !isAdminPhone(resolvePhoneFromJid(msg.senderJid, this.db), config.adminPhones)) {
            // @check CHK-067 // @traces REQ-012.AC-06
            return;
          }
          // Capture session ref before branches may delete it from the map.
          // In per_chat mode, this.session is NOT reliable (shared field race),
          // so we look up the correct session from the per-chat maps.
          const sessionForNew = this.sessionScope === 'per_chat'
            ? this.chatSessions.get(perChatMapKey!)
            : this.session;
          log.info({
            chatJid,
            sessionScope: this.sessionScope,
            shared: this.shared,
            sandboxPerChat: this.sandboxPerChat,
          }, 'resetting session and queue for /new');
          // Abort the old queue — clears timers and typing heartbeat before discarding.
          // Use getQueueForChat (map-based) instead of getActiveQueue (shared-field-based).
          this.getQueueForChat(chatJid, perChatMapKey)?.abortTurn();
          // Create a fresh queue before spawning so stale output from the old session
          // can never leak into the new session's delivery channel.
          if (this.sandboxPerChat && this.sessionScope === 'per_chat') {
            // sandboxPerChat: replace session+queue keyed by workspaceKey; workspace resources survive
            const { workspaceKey } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);
            this.chatSessions.delete(workspaceKey);
            const q1 = this.createOutboundQueue(chatJid, '/new sandbox per-chat replacement');
            this.chatQueues.set(workspaceKey, q1);
          } else if (this.shared) {
            const q2 = this.createOutboundQueue(chatJid, '/new shared replacement');
            this.outboundQueues.set(chatJid, q2);
          } else if (this.sessionScope === 'per_chat') {
            // non-sandboxPerChat per_chat: keyed by canonical chat key
            this.chatSessions.delete(perChatMapKey!);
            const q3 = this.createOutboundQueue(chatJid, '/new per-chat replacement');
            this.chatQueues.set(perChatMapKey!, q3);
          } else {
            const q4 = this.createOutboundQueue(chatJid, '/new single replacement');
            this.queue = q4;
          }
          // NOTE: sessionForNew was captured before the map delete above. handleNew()
          // signals the old session to reset. Any async events from the dying session
          // arrive with the old workspaceKey — handleEventPerChat tolerates missing
          // queue entries (returns early). The next message triggers ensureSessionAndQueue
          // which creates a fresh session+queue in the map. This is a narrow window
          // inherited from the original design, not a regression from the race fix.
          await sessionForNew?.handleNew();
          // Reset turn flag — stale value from the old session must not suppress the
          // _(no response)_ fallback if the first new-session turn has no visible text.
          this.turnHadVisibleOutput = false;
          this.sendDirect(chatJid, '*Starting new session* ✓');
          break;

        case 'status': {
          // Look up session from per-chat maps (not the shared field) to avoid race.
          const sessionForStatus = this.sessionScope === 'per_chat'
            ? this.chatSessions.get(perChatMapKey!)
            : this.session;
          const status = sessionForStatus?.getStatus();
          let text: string;
          if (status?.active) {
            const sessionShort = status.sessionId
              ? status.sessionId.slice(0, 8) + '...'
              : 'pending';
            const started = status.startedAt ? formatAge(status.startedAt) : 'unknown';
            const lastActivity = status.lastMessageAt
              ? formatAge(status.lastMessageAt)
              : 'none';
            text =
              '*Session active*\n' +
              `PID: \`${status.pid ?? 'unknown'}\`\n` +
              `Session: \`${sessionShort}\`\n` +
              `Started: ${started}\n` +
              `Messages: ${status.messageCount}\n` +
              `Last activity: ${lastActivity}`;
          } else {
            text = '_No active session._ Send a message to start one.';
          }
          this.sendDirect(chatJid, text);
          break;
        }

        case 'help': {
          const helpText =
            '*/new* — start a fresh session\n' +
            '*/status* — show current session status\n' +
            '*/sessions* — list all active sessions _(admin)_\n' +
            '*/kill-session <N>* — terminate a session by number _(admin)_\n' +
            '*/help* — show this help\n' +
            '_Any other message is forwarded to Claude Code._\n' +
            'Other slash commands (e.g. `/compact`) are passed directly to Claude Code.';
          this.sendDirect(chatJid, helpText);
          break;
        }

        case 'sessions': {
          // Admin-only
          if (!isAdminPhone(resolvePhoneFromJid(msg.senderJid, this.db), config.adminPhones)) {
            return;
          }
          const entries: string[] = [];
          let idx = 1;
          if (this.sessionScope === 'per_chat') {
            for (const [mapKey, sess] of this.chatSessions) {
              const st = sess.getStatus();
              if (!st.active) continue;
              const isGrp = isGroupConversationKey(mapKey);
              const label = isGrp ? 'Group' : 'DM';
              const ageStr = st.startedAt ? formatAge(st.startedAt) : '?';
              const dbRowId = sess.getDbRowId();
              let tkStr = '0';
              if (dbRowId !== null) {
                const tokenRow = this.db.raw.prepare(
                  'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?'
                ).get(dbRowId) as { total_input_tokens: number | null; total_output_tokens: number | null } | undefined;
                if (tokenRow) {
                  const tkTotal = (tokenRow.total_input_tokens ?? 0) + (tokenRow.total_output_tokens ?? 0);
                  tkStr = tkTotal > 1000 ? `${(tkTotal / 1000).toFixed(1)}k` : String(tkTotal);
                }
              }
              entries.push(`${idx}. ${mapKey} (${label}) — ${ageStr}, ${st.messageCount} msgs, ${tkStr} tokens`);
              idx++;
            }
          } else {
            const st = this.session?.getStatus();
            if (st?.active) {
              const ageStr = st.startedAt ? formatAge(st.startedAt) : '?';
              const dbRowId = this.session?.getDbRowId() ?? null;
              let tkStr = '0';
              if (dbRowId !== null) {
                const tokenRow = this.db.raw.prepare(
                  'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?'
                ).get(dbRowId) as { total_input_tokens: number | null; total_output_tokens: number | null } | undefined;
                if (tokenRow) {
                  const tkTotal = (tokenRow.total_input_tokens ?? 0) + (tokenRow.total_output_tokens ?? 0);
                  tkStr = tkTotal > 1000 ? `${(tkTotal / 1000).toFixed(1)}k` : String(tkTotal);
                }
              }
              entries.push(`1. ${this.activeChatJid ?? 'unknown'} — ${ageStr}, ${st.messageCount} msgs, ${tkStr} tokens`);
            }
          }
          const sessionsText = entries.length > 0
            ? `*Active Sessions (${entries.length})*\n\n${entries.join('\n')}\n\n/kill-session <number> to terminate`
            : '_No active sessions._';
          this.sendDirect(chatJid, sessionsText, true);
          break;
        }

        case 'kill-session': {
          // Admin-only
          if (!isAdminPhone(resolvePhoneFromJid(msg.senderJid, this.db), config.adminPhones)) {
            return;
          }
          const targetIdx = parseInt(classified.args ?? '', 10);
          if (isNaN(targetIdx) || targetIdx < 1) {
            this.sendDirect(chatJid, '_Usage: /kill-session <number>_\nRun /sessions first to see the list.', true);
            break;
          }
          if (this.sessionScope === 'per_chat') {
            const activeSessions = [...this.chatSessions.entries()].filter(([, s]) => s.getStatus().active);
            if (targetIdx > activeSessions.length) {
              this.sendDirect(chatJid, `_Invalid session number. ${activeSessions.length} active._`, true);
              break;
            }
            const [mapKey, targetSession] = activeSessions[targetIdx - 1];
            this.chatQueues.get(mapKey)?.abortTurn();
            this.chatSessions.delete(mapKey);
            this.chatQueues.delete(mapKey);
            this.cleanupPerChatState(mapKey);
            await targetSession.shutdown(false);
            const killLabel = isGroupConversationKey(mapKey) ? 'Group' : 'DM';
            this.sendDirect(chatJid, `_Session killed: ${mapKey} (${killLabel})_`, true);
          } else {
            if (!this.session?.getStatus().active) {
              this.sendDirect(chatJid, '_No active session to kill._', true);
              break;
            }
            this.getActiveQueue()?.abortTurn();
            this.operationTracker?.shutdown();
            this.operationTracker = null;
            await this.session.shutdown(false);
            this.session = null;
            this.queue = null;
            this.activeChatJid = null;
            this.sendDirect(chatJid, '_Session killed._', true);
          }
          break;
        }
      }
      return;
    }

    // forwarded or message — enqueue as turn (shared) or send directly (non-shared)
    const text = classified.text;

    if (this.shared) {
      // @check CHK-062 // @traces REQ-012.AC-01
      // @check CHK-063 // @traces REQ-012.AC-04
      // Track inbound contentType for voice reply (SP4)
      this.currentTurnInboundContentType = msg.contentType;
      this.currentTurnAssistantText = '';
      this.currentTurnAssistantItemText.clear();
      this.turnQueue.enqueue({
        chatJid,
        senderJid: msg.senderJid,
        senderName: msg.senderName ?? null,
        text,
        isGroup: msg.isGroup,
        groupName: msg.isGroup ? chatJid : undefined,
        inboundSeq: msg.inboundSeq,
      });
    } else if (this.sessionScope === 'per_chat') {
      const mapKey = perChatMapKey!;

      // Image coalescing: batch rapid image sends into a single turn.
      // For coalesced images, defer seq/state setup until flush time — only
      // the representative turn gets a seq entry, preventing desync.
      if (msg.contentType === 'image') {
        await this.coalesceImageTurn(mapKey, chatJid, text, msg);
      } else {
        // Flush any pending image buffer first (text message after images = done uploading).
        // Await to prevent concurrent turn injection with the text turn below.
        await this.flushImageCoalesce(mapKey);

        // per_chat: enqueue inbound seq keyed by chat before sending turn
        const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
        if (msg.inboundSeq !== undefined) seqQueue.push(msg.inboundSeq);
        this.perChatInboundSeqQueue.set(mapKey, seqQueue);
        this.getQueueForChat(chatJid, mapKey)?.setInboundSeq(msg.inboundSeq);
        this.replyGuarantee?.arm({ inboundSeq: msg.inboundSeq, chatJid });
        // Track inbound contentType for voice reply (SP4)
        this.perChatTurnContentType.set(mapKey, msg.contentType);
        this.perChatTurnText.set(mapKey, '');
        this.perChatAssistantItemText.delete(mapKey);
        await this.sendTurnPerChat(chatJid, text, mapKey, msg.senderJid);
      }
    } else {
      // single mode: store inbound seq on runtime + queue
      this.currentInboundSeq = msg.inboundSeq;
      this.queue?.setInboundSeq(msg.inboundSeq);
      this.replyGuarantee?.arm({ inboundSeq: msg.inboundSeq, chatJid });
      // Track inbound contentType for voice reply (SP4)
      this.currentTurnInboundContentType = msg.contentType;
      this.currentTurnAssistantText = '';
      this.currentTurnAssistantItemText.clear();
      await this.sendTurnNonShared(chatJid, text, msg.senderJid);
    }
  }

  /**
   * Process a single turn from the TurnQueue (shared mode).
   * Sets currentTurnChatJid so event routing knows where to send output.
   */
  private async processTurn(turn: QueuedTurn): Promise<void> {
    const { chatJid, senderJid, senderName, text, isGroup } = turn;

    // Clear post-turn gate — legitimate new user turn begins (shared mode)
    this.postTurnGate.delete(GLOBAL_TOOL_SCOPE_KEY);

    // Ensure outbound queue exists for this chat
    this.ensureOutboundQueue(chatJid);

    if (!this.session!.getStatus().active) {
      await this.session!.spawnSession();
    }

    // Build context prefix
    // @check CHK-064 // @traces REQ-012.AC-02
    const phone = resolvePhoneFromJid(senderJid, this.db);
    const displayName = senderName ?? phone;
    const prefix = isGroup
      ? `[Group: ${chatJid} — ${displayName}]`
      : `[DM from ${displayName} (${phone})]`;
    const prefixedText = `${prefix}\n${text}`;

    // Track which chat this turn belongs to for event routing
    // @check CHK-065 // @traces REQ-012.AC-03
    this.currentTurnChatJid = chatJid;
    this.currentInboundSeq = turn.inboundSeq;
    this.turnHadVisibleOutput = false;
    this.replyGuarantee?.arm({ inboundSeq: turn.inboundSeq, chatJid });

    // Thread inbound seq into the outbound queue so ops can link back
    this.getActiveQueue()?.setInboundSeq(turn.inboundSeq);

    try {
      this.updateSessionActorJid(this.session!, senderJid);
      await this.session!.sendTurn(prefixedText);
    } catch (err) {
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('STDIN_WRITE_TIMEOUT')) {
        const status = this.session?.getStatus() ?? { sessionId: null, pid: null };
        log.warn({
          chatJid,
          sessionId: status.sessionId,
          pid: status.pid,
        }, 'stdin write timed out — notifying user');
        this.sendDirect(chatJid, 'Agent is not responding — try /new to start a fresh session.');
      } else {
        throw err;
      }
    }
    // currentTurnChatJid is cleared in handleEvent('result')
  }

  /**
   * Shared helper: spawn session if needed, send the turn, and handle the
   * STDIN_WRITE_TIMEOUT error consistently across all non-shared modes.
   */
  private async sendTurnToSession(
    session: SessionManager,
    chatJid: string,
    text: string,
    mapKey?: string,
    actorJid?: string,
  ): Promise<void> {
    this.updateSessionActorJid(session, actorJid);
    // Derive mapKey for sandboxPerChat coordination (used to suppress duplicate
    // context injection when handleResumeFailed is already handling recovery).
    const mapKeyForChat = this.sandboxPerChat
      ? chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey
      : undefined;
    const crashScopeKey = this.getCrashScopeKey(chatJid);
    const autoCompact = this.autoCompactWaiters.get(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
    if (autoCompact) await autoCompact.promise;

    const wasInactive = !session.getStatus().active;
    if (wasInactive) {
      // Flush any buffered output from the dying session before shutting down.
      // Without this, text in the 2-second stream debounce buffer is lost when
      // the child process is killed, because the stream parser stops emitting events.
      const queue = this.getQueueForChat(chatJid, mapKey);
      if (queue) await queue.flush();

      // Shut down old session first to prevent zombie processes.
      // Without this, spawnSession() overwrites this.child, orphaning the old
      // process and its DB row. Mirrors handleNew() pattern.
      await session.shutdown();
      await session.spawnSession();
      // Successful spawn after a crash — decay the crash counter
      this.decrementCrashCount(crashScopeKey);

      // Inject recent chat history so the agent has conversational context.
      // This runs on every fresh session spawn (not just resume failures),
      // giving the agent awareness of what's been discussed recently.
      // Skipped when handleResumeFailed manages its own context recovery to
      // avoid sending two context blocks to the same fresh session.
      const resumeFailedOwnsContext = mapKeyForChat !== undefined && this.resumeFailedHandling.has(mapKeyForChat);
      if (!resumeFailedOwnsContext) {
        try {
          const convKey = toConversationKey(chatJid);
          const recent = getRecentMessages(this.db, convKey, 20);
          if (recent.length > 0) {
            const lines = recent
              .reverse()
              .map(
                (m) =>
                  `[${this.formatRecoveryTimestamp(m.timestamp)}] ${m.senderName ?? m.senderJid}: ${m.content ?? '[media]'}`,
              )
              .join('\n');
            await session.sendTurn(`[Recent chat context — read before responding]\n${lines}`);
          }
        } catch (err) {
          log.warn({ err, chatJid }, 'chat context injection failed — proceeding without context');
        }
      }
    }

    // Assert typing immediately so the user sees the indicator while the agent thinks.
    // Without this, there's a visible gap between message receipt and first tool call.
    const queue = this.getQueueForChat(chatJid, mapKey);
    if (queue) queue.indicateTyping();

    try {
      await session.sendTurn(text);
    } catch (err) {
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('STDIN_WRITE_TIMEOUT')) {
        const status = session.getStatus();
        log.warn({
          chatJid,
          sessionId: status.sessionId,
          pid: status.pid,
        }, 'stdin write timed out — notifying user');
        this.sendDirect(chatJid, 'Agent is not responding — try /new to start a fresh session.');
      } else {
        throw err;
      }
    }
  }

  /**
   * Send a turn in non-shared (legacy) mode.
   */
  private async sendTurnNonShared(chatJid: string, text: string, actorJid: string): Promise<void> {
    // Clear post-turn gate for shared session scope
    this.postTurnGate.delete(GLOBAL_TOOL_SCOPE_KEY);
    this.currentTurnChatJid = chatJid;
    this.turnHadVisibleOutput = false;
    await this.sendTurnToSession(this.session!, chatJid, text, undefined, actorJid);
  }

  /**
   * Send a turn in per_chat mode — each chat has its own session.
   * Serializes within a chat but runs concurrently across chats.
   */
  private async sendTurnPerChat(
    chatJid: string,
    text: string,
    mapKey: string = this.resolvePerChatMapKey(chatJid),
    actorJid?: string,
  ): Promise<void> {
    // Clear post-turn gate — legitimate new user turn begins
    this.postTurnGate.delete(mapKey);

    // When sandboxPerChat=true maps are keyed by workspaceKey, not raw chatJid
    // Store the turn text so it can be replayed if a session resume fails
    // before the agent can process it.
    this.pendingTurnText.set(mapKey, text);

    const session = this.chatSessions.get(mapKey);
    if (!session) {
      log.warn({ chatJid, mapKey }, 'no active session for chat — spawning new session');
      // Instead of silently dropping, initialize session and queue so message is handled
      if (this.sandboxPerChat) {
        await this.ensureSessionAndQueue(chatJid, actorJid);
      } else {
        this.ensureSessionAndQueueSync(chatJid, mapKey, actorJid);
      }
      const retrySession = this.chatSessions.get(mapKey);
      if (!retrySession) {
        log.error({ chatJid, mapKey }, 'failed to create session for chat — message dropped');
        this.pendingTurnText.delete(mapKey);
        if (this.durability && this.perChatInboundSeqQueue.get(mapKey)?.[0] !== undefined) {
          const failedSeq = this.perChatInboundSeqQueue.get(mapKey)![0];
          this.replyGuarantee?.disarm(failedSeq);
          this.durability.markInboundFailed(failedSeq);
        }
        this.sendDirect(chatJid, 'Something went wrong starting a session. Try sending your message again.');
        return;
      }
      await this.sendTurnToSession(retrySession, chatJid, text, mapKey, actorJid);
      return;
    }
    await this.sendTurnToSession(session, chatJid, text, mapKey, actorJid);
  }

  private updateSessionActorJid(session: SessionManager, actorJid: string | undefined): void {
    if (!actorJid) return;
    const maybeSession = session as SessionManager & { updateMcpActorJid?: (actorJid: string) => void };
    maybeSession.updateMcpActorJid?.(actorJid);
  }

  /**
   * Handle events from a per_chat session — routes to that chat's outbound queue.
   * Resolves queue and session locally from the mapKey to avoid mutating shared
   * instance fields that another concurrent chat could overwrite.
   */
  private handleEventPerChat(mapKey: string, event: AgentEvent, toolScopeKey: string): void {
    const queue = this.chatQueues.get(mapKey);
    if (!queue) {
      log.debug({ mapKey, eventType: event.type }, 'event dropped — no queue for chat');
      return;
    }
    const session = this.chatSessions.get(mapKey) ?? null;
    // Use queue.targetChatJid — mapKey may be a workspaceKey (not a raw JID) when sandboxPerChat=true
    const conversationKey = toConversationKey(queue.targetChatJid);
    const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
    const inboundSeq = seqQueue[0]; // peek — don't shift yet
    if (event.type === 'result') {
      // Consume the seq for this completed turn
      seqQueue.shift();
      // Turn completed successfully — clear pending replay text
      this.pendingTurnText.delete(mapKey);
    }
    this.handleEventWithContext(event, queue, session, conversationKey, inboundSeq, mapKey, toolScopeKey);
  }

  /**
   * Core event handler that operates on explicitly-passed queue and session
   * references rather than shared instance fields. Used by handleEventPerChat
   * so concurrent per_chat events do not overwrite each other's context.
   */
  private handleEventWithContext(event: AgentEvent, queue: IOutboundQueue, session: SessionManager | null, conversationKey?: string, inboundSeq?: number, mapKey?: string, toolScopeKey: string = mapKey ?? GLOBAL_TOOL_SCOPE_KEY): void {
    const tracker = this.getTracker(mapKey);
    switch (event.type) {
      case 'init':
        log.debug({ sessionId: event.sessionId }, 'session init');
        break;

      case 'assistant_text':
        session?.tickWatchdog();
        tracker?.onAnyActivity();
        // Post-turn gate: suppress assistant_text events that arrive after a result
        // but before the next user message. These are model reactions to SDK-injected
        // system-reminders (e.g., TodoWrite) and must not trigger typing or outbound messages.
        if (mapKey !== undefined && this.postTurnGate.has(mapKey)) {
          log.info({ mapKey, textPreview: event.text.slice(0, 200) }, 'post-turn gate: suppressed phantom assistant_text');
          break;
        }
        if (this.isSilentCompact(mapKey)) break;
        {
          const normalizedText = this.normalizeAssistantTextForDelivery(event, mapKey);
          if (!normalizedText) break;
          // Suppress usage-limit messages — don't flood WhatsApp with them
          if (isUsageLimitMessage(normalizedText)) {
            log.warn({ chatJid: queue.targetChatJid, textPreview: normalizedText.slice(0, 300) }, 'suppressed usage-limit message from assistant_text');
            break;
          }
          queue.enqueueStreamingText(normalizedText);
          // Accumulate assistant text for voice reply (SP4)
          if (mapKey !== undefined) {
            this.perChatTurnText.set(mapKey, (this.perChatTurnText.get(mapKey) ?? '') + normalizedText);
          }
        }
        break;

      case 'tool_use':
        session?.trackToolStart(event.toolId);
        session?.tickWatchdog();
        // Post-turn gate: suppress phantom tool_use events (same rationale as assistant_text)
        if (mapKey !== undefined && this.postTurnGate.has(mapKey)) {
          log.info({ mapKey, toolName: event.toolName }, 'post-turn gate: suppressed phantom tool_use');
          break;
        }
        if (this.isSilentCompact(mapKey)) break;
        this.getToolNames(toolScopeKey).set(event.toolId, event.toolName);
        {
          const toolUpdate = buildToolUpdate(event.toolName, event.toolInput ?? {});
          queue.enqueueToolUpdate(toolUpdate);
          tracker?.onToolStart(event.toolId, event.toolName, toolUpdate.category);
        }
        break;

      case 'compact_boundary':
        session?.tickWatchdog();
        tracker?.onAnyActivity();
        this.compactBoundaryScopes.add(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
        if (this.isSilentCompact(mapKey)) {
          log.info({ chatJid: queue.targetChatJid }, 'silent agent compact boundary observed');
          break;
        }
        queue.indicateTyping();
        queue.enqueueText(
          'Context compacted — older details summarized. Restate any important context I should carry forward.',
        );
        break;

      case 'tool_result':
        session?.trackToolEnd(event.toolId);
        session?.tickWatchdog();
        tracker?.onToolEnd(event.toolId);
        // Note: tool_result is NOT gated. Phantom tool_use is already blocked,
        // so phantom tool_result cannot arrive. Gating tool_result would break
        // legitimate session-replacement scenarios where two sessions share a mapKey.
        if (this.isSilentCompact(mapKey)) break;
        const toolNames = this.activeToolNames.get(toolScopeKey);
        if (event.isError) {
          const toolName = toolNames?.get(event.toolId) ?? 'unknown';
          const errorPreview = event.content.length > 200 ? event.content.slice(0, 200) + '...' : event.content;
          log.warn({ toolId: event.toolId, toolName, error: errorPreview }, 'tool error reported by agent');
          queue.enqueueToolUpdate(classifyToolError(toolName, event.content));
        }
        toolNames?.delete(event.toolId);
        if (toolNames && toolNames.size === 0) {
          this.activeToolNames.delete(toolScopeKey);
        }
        break;

      case 'result': {
        const wasSilentCompact = this.isSilentCompact(mapKey);
        const compactScopeKey = mapKey ?? GLOBAL_TOOL_SCOPE_KEY;
        const hadCompactBoundary = this.consumeCompactBoundary(compactScopeKey);
        session?.clearTurnWatchdog();
        tracker?.onTurnComplete();
        this.clearToolNames(toolScopeKey);
        // Activate post-turn gate — suppress any SDK-injected events until next user turn
        if (mapKey !== undefined) {
          this.postTurnGate.add(mapKey);
        }
        if (event.text) {
          // Suppress usage-limit messages — log and skip instead of forwarding
          if (isUsageLimitMessage(event.text)) {
            log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed usage-limit message from result — session will be killed');
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq,
              conversationKey,
              mapKey,
            });
            session?.shutdown();
            break;
          }
          if (!wasSilentCompact) {
            queue.enqueueResultText(event.text);
            // Accumulate result text for voice reply (SP4)
            if (mapKey !== undefined) {
              this.perChatTurnText.set(mapKey, (this.perChatTurnText.get(mapKey) ?? '') + event.text);
            }
          }
        }
        if (mapKey !== undefined) {
          this.perChatAssistantItemText.delete(mapKey);
        }
        this.touchWorkspaceActivity(mapKey);
        const rowId = session?.getDbRowId() ?? null;
        const lastOpId = queue.getLastOpId();
        if (this.durability) {
          this.durability.completeTurn({
            ...((event.inputTokens !== undefined || event.outputTokens !== undefined) && rowId !== null
              ? {
                  sessionTokens: {
                    dbRowId: rowId,
                    inputTokens: event.inputTokens ?? 0,
                    outputTokens: event.outputTokens ?? 0,
                  },
                }
              : {}),
            ...(conversationKey
              ? {
                  checkpoint: {
                    conversationKey,
                    fields: {
                      activeTurnId: null,
                      ...(inboundSeq !== undefined && { lastInboundSeq: inboundSeq }),
                      ...(lastOpId !== undefined && { lastFlushedOutboundId: lastOpId }),
                    },
                  },
                }
              : {}),
            ...(inboundSeq !== undefined
              ? {
                  inbound: {
                    seq: inboundSeq,
                    terminalReason: 'response_sent',
                  },
                }
              : {}),
            ...(lastOpId !== undefined ? { lastOpId } : {}),
          });
          this.replyGuarantee?.disarm(inboundSeq);
          if (lastOpId !== undefined) {
            queue.clearLastOpId();
          }
        } else {
          if ((event.inputTokens !== undefined || event.outputTokens !== undefined) && rowId !== null) {
            accumulateTokensWithEvent(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
          }
          // Defense-in-depth: mark last op terminal so echo auto-complete fires if
          // the process crashes after send but before completeInbound runs.
          queue.markLastTerminal();
        }
        // Only advance the compact baseline when the SDK actually emitted a
        // compact_boundary on this turn. wasSilentCompact alone means "we
        // suppressed user-facing chrome for an auto-trigger"; it does not
        // prove the /compact succeeded. A failed compact must not reset the
        // baseline, otherwise auto-compact silently disables itself for
        // another full threshold's worth of tokens. The waiter still
        // unblocks in either case so the next user turn is not stuck behind
        // a failed compact.
        if (hadCompactBoundary && rowId !== null) {
          markSessionCompacted(this.db, rowId);
        }
        if (wasSilentCompact || hadCompactBoundary) {
          this.finishAutoCompact(compactScopeKey);
        } else {
          this.maybeStartAutoCompact(session, mapKey);
        }
        {
          // Capture voice reply context before flush (SP4)
          const chatJidForVoice = queue.targetChatJid;
          const inboundContentType = mapKey !== undefined ? (this.perChatTurnContentType.get(mapKey) ?? null) : null;
          const responseText = !wasSilentCompact && mapKey !== undefined ? (this.perChatTurnText.get(mapKey) ?? '') : '';
          // Clean up per-chat voice state
          if (mapKey !== undefined) {
            this.perChatTurnContentType.delete(mapKey);
            this.perChatTurnText.delete(mapKey);
          }
          queue.flush()
            .then(() => {
              // Send voice reply after text is delivered (non-fatal, SP4)
              if (
                chatJidForVoice &&
                responseText &&
                config.voiceReply !== 'never' &&
                (config.voiceReply === 'always' || inboundContentType === 'audio')
              ) {
                return this._sendVoiceReply(chatJidForVoice, responseText);
              }
            })
            .catch((err) => log.error({ err }, 'flush or voice reply failed'));
        }
        if (wasSilentCompact) this.clearSilentCompact(mapKey);
        break;
      }

      case 'token_usage':
        // Record token usage without triggering turn completion.
        // Codex emits thread/tokenUsage/updated mid-turn; the actual turn
        // completion comes from turn/completed → type:'result'.
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
          const rowId = session?.getDbRowId() ?? null;
          if (rowId !== null) {
            accumulateTokensWithEvent(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
          }
        }
        break;

      case 'ignored':
      case 'unknown':
      case 'parse_error':
        log.debug({ event }, 'ignored/unknown/parse_error event');
        break;
    }
  }

  /** Pop and return the pending startup notification (set during resume), or null. */
  popStartupMessage(): { chatJid: string; text: string } | null {
    const msg = this.pendingStartupMessage;
    this.pendingStartupMessage = null;
    return msg;
  }

  getHealthSnapshot(): RuntimeHealth {
    if (this.sessionScope === 'per_chat') {
      const sessions = [...this.chatSessions.values()];
      let activeSessions = 0;
      let lastSessionStatus: string | null = null;
      let lastSessionStartedAt: string | null = null;
      let mostRecentStartMs = -1;
      for (const s of sessions) {
        const st = s.getStatus();
        if (st.active) activeSessions++;
        // Track the most recently started session for lastSession* fields
        if (st.startedAt) {
          const startMs = new Date(st.startedAt).getTime();
          if (startMs > mostRecentStartMs) {
            mostRecentStartMs = startMs;
            lastSessionStatus = st.active ? 'active' : 'idle';
            lastSessionStartedAt = st.startedAt;
          }
        }
      }
      let healthStatus: RuntimeHealth['status'] = 'healthy';
      // For per_chat: idle sessions (all inactive) are normal — not degraded.
      // Only degrade if we have sessions that SHOULD be active but aren't
      // (indicated by recent crashes, not by inactivity).
      // Crash counter survives session map deletions — if sessions have been crashing
      // recently but were cleaned up before this health check, recentCrashCount captures it.
      const recentCrashCount = this.getRecentCrashCount();
      if (recentCrashCount > 0 && healthStatus === 'healthy') {
        healthStatus = 'degraded';
      }
      return {
        status: healthStatus,
        details: {
          activeSessions,
          lastSessionStatus,
          lastSessionStartedAt,
          sessionCount: sessions.length,
          recentCrashes: recentCrashCount,
          lastCrashAt: this.lastCrashAt,
        },
      };
    }

    const status = this.session?.getStatus();
    // If a session exists but its child process is not active, it has crashed
    const healthStatus: RuntimeHealth['status'] =
      this.session !== null && status?.active === false ? 'degraded' : 'healthy';
    return {
      status: healthStatus,
      details: {
        active: status?.active ?? false,
        pid: status?.pid ?? null,
        sessionId: status?.sessionId ?? null,
      },
    };
  }

  /**
   * Inject a repair turn into the control session for self-healing.
   * Single-flight: if a repair is already in-flight the call returns immediately;
   * the caller (heal.ts) is responsible for queuing subsequent reports.
   */
  async handleControlTurn(reportId: string, payload: string): Promise<void> {
    const syntheticJid = 'control@heal.internal';
    try {
      // Only non-sandboxed instances (Q) can run repairs
      if (this.sandboxPerChat || this.sandbox) {
        log.warn({ reportId }, 'handleControlTurn called on sandboxed instance — ignoring');
        return;
      }
      // Single-flight gate
      if (this.activeControlReportId) {
        log.info(
          { reportId, activeReportId: this.activeControlReportId },
          'repair slot occupied — report will be queued by caller',
        );
        return;
      }

      this.activeControlReportId = reportId;

      // Use a workspace at <cwd>/heal/ for the control session
      const controlCwd = this.cwd ? join(this.cwd, 'heal') : join(homedir(), 'heal');
      mkdirSync(controlCwd, { recursive: true, mode: 0o700 });

      // Create or reuse control session
      if (!this.controlSession) {
        const toolScopeKey = this.createToolScopeKey('control@heal.internal');
        this.controlSession = this.createSessionManager({
          chatJid: syntheticJid,
          cwd: controlCwd,
          onEvent: (event) => this.handleEventPerChat('control@heal.internal', event, toolScopeKey),
          onCrash: (info) => {
            log.warn({
              exitCode: info.exitCode,
              signal: info.signal,
              sessionId: info.sessionId,
              reportId: this.activeControlReportId ?? reportId,
            }, 'control session crashed');
            if (this.controlSessionTimeout) {
              clearTimeout(this.controlSessionTimeout);
              this.controlSessionTimeout = null;
            }
            this.activeControlReportId = null;
          },
          notifyUser: () => {},
          onResumeFailed: () => {},
        });

        // Use ControlQueue instead of OutboundQueue so output is not forwarded as WhatsApp messages
        const controlQueue = new ControlQueue(syntheticJid, this.messenger);
        this.chatQueues.set(syntheticJid, controlQueue);
        this.chatSessions.set(syntheticJid, this.controlSession);

        // Wire operation tracker for control session
        const controlTracker = this.createOperationTracker(this.controlSession, () => this.chatQueues.get(syntheticJid));
        if (controlTracker) this.operationTrackers.set(syntheticJid, controlTracker);
      }

      // Spawn session if not active
      if (!this.controlSession.getStatus().active) {
        await this.controlSession.spawnSession();
      }

      // Format the turn
      const turn = `[REPAIR REQUEST — report_id: ${reportId}]\n${payload}`;

      await this.controlSession.sendTurn(turn);
      // Start hard timeout — if the control session doesn't resolve within 15 minutes,
      // force-escalate and shut it down to prevent resource exhaustion.
      this.controlSessionTimeout = setTimeout(() => {
        log.warn({ reportId }, 'control session timed out after 15 minutes — force-escalating');

        // Send HEAL_ESCALATE to Loops so its heal state is updated
        const controlQueue = this.getControlQueue();
        const loopsPhone = [...config.controlPeers.entries()].find(([name]) => name === 'loops')?.[1];
        if (controlQueue && loopsPhone) {
          const loopsJid = toPersonalJid(loopsPhone);
          controlQueue.sendControlMessage(loopsJid, 'HEAL_ESCALATE', {
            reportId,
            errorClass: 'timeout',
            diagnosis: 'Repair session timed out after 15 minutes without resolution',
          }, this.durability ?? undefined).catch(err =>
            log.error({ err, reportId }, 'failed to send HEAL_ESCALATE on timeout'));
        }

        // DM admin
        const adminPhone = [...config.adminPhones][0];
        if (adminPhone) {
          const adminJid = toPersonalJid(adminPhone);
          sendTracked(this.messenger, adminJid,
            `[HEAL_ESCALATE] Repair for report ${reportId} timed out after 15 minutes.`,
            this.durability ?? undefined, { replayPolicy: 'safe' })
            .catch(err => log.error({ err }, 'failed to DM admin on timeout'));
        }

        if (this.controlSession) {
          void this.controlSession.shutdown().catch(() => {});
        }
        this.clearControlReport();

        // Dequeue next report if any
        const next = dequeueNextReport(this.db);
        if (next) {
          const context = next.context ? JSON.parse(next.context) : {};
          void this.handleControlTurn(next.report_id, JSON.stringify({
            ...context,
            reportId: next.report_id,
            errorClass: next.error_class,
          })).catch(err => {
            log.error({ err, reportId: next.report_id }, 'unhandled error in handleControlTurn');
          });
        }
      }, CONTROL_SESSION_TIMEOUT_MS);
    } catch (err) {
      log.error({ err, reportId }, 'control session failed to start — releasing slot');
      if (this.controlSessionTimeout) {
        clearTimeout(this.controlSessionTimeout);
        this.controlSessionTimeout = null;
      }

      this.activeControlReportId = null;
      const controlSession = this.controlSession;
      this.controlSession = null;
      this.chatSessions.delete(syntheticJid);
      this.chatQueues.delete(syntheticJid);
      if (controlSession) {
        try {
          await controlSession.shutdown();
        } catch (shutdownErr) {
          log.warn({ shutdownErr, reportId }, 'failed to shutdown control session during error cleanup');
        }
      }
    }
  }

  async handleAgentCommand(request: AgentCommandRequest): Promise<AgentCommandResult> {
    if (request.command !== 'compact') {
      throw new AgentCommandRuntimeError(
        'unsupported_command',
        `unsupported agent command: ${String(request.command)}`,
        400,
      );
    }

    const silent = request.silent === true;

    if (this.sessionScope === 'per_chat') {
      if (!request.chatJid) {
        throw new AgentCommandRuntimeError(
          'chat_jid_required',
          'chatJid is required for per_chat agent commands',
          400,
        );
      }

      const mapKey = this.resolvePerChatMapKey(request.chatJid);
      this.assertNoActiveUserTurn(mapKey);
      const session = this.chatSessions.get(mapKey);
      if (!session) {
        throw new AgentCommandRuntimeError(
          'session_not_found',
          `no agent session exists for ${request.chatJid}`,
          404,
        );
      }
      if (!session.getStatus().active) {
        throw new AgentCommandRuntimeError(
          'session_inactive',
          `agent session for ${request.chatJid} is not active`,
          409,
        );
      }

      if (silent) this.beginSilentCompact(mapKey);
      try {
        await session.sendTurn('/compact');
      } catch (err) {
        if (silent) this.clearSilentCompact(mapKey);
        throw err;
      }

      return { ok: true, command: 'compact', chatJid: request.chatJid, silent };
    }

    const session = this.session;
    if (!session) {
      throw new AgentCommandRuntimeError('session_not_found', 'no agent session exists', 404);
    }
    if (!session.getStatus().active) {
      throw new AgentCommandRuntimeError('session_inactive', 'agent session is not active', 409);
    }

    this.assertNoActiveUserTurn(GLOBAL_TOOL_SCOPE_KEY);
    const targetChatJid = request.chatJid ?? this.activeChatJid;
    if (!targetChatJid || (this.shared && !request.chatJid)) {
      throw new AgentCommandRuntimeError(
        'chat_jid_required',
        'chatJid is required for shared agent commands and for single agent commands without an active chat',
        400,
      );
    }
    if (this.shared) {
      this.ensureOutboundQueue(targetChatJid);
    } else if (!this.queue) {
      throw new AgentCommandRuntimeError('session_queue_not_found', 'agent session has no active outbound queue', 409);
    }

    if (silent) this.beginSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
    this.currentTurnChatJid = targetChatJid;
    try {
      await session.sendTurn('/compact');
    } catch (err) {
      if (silent) this.clearSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
      this.currentTurnChatJid = null;
      throw err;
    }

    return { ok: true, command: 'compact', chatJid: targetChatJid, silent };
  }

  /** Return the ControlQueue for the control session, or null if none exists. */
  getControlQueue(): ControlQueue | null {
    return (this.chatQueues.get('control@heal.internal') as unknown as ControlQueue) ?? null;
  }

  /** Report ID currently being repaired, or null if no repair is in-flight. */
  get currentControlReportId(): string | null {
    return this.activeControlReportId;
  }

  /** Clear the in-flight repair slot so the next report can be dispatched. */
  clearControlReport(): void {
    this.activeControlReportId = null;
  }

  async shutdown(): Promise<void> {
    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
    }, 'AgentRuntime shutting down');
    const startedAt = Date.now();

    if (this.controlSessionTimeout) {
      clearTimeout(this.controlSessionTimeout);
      this.controlSessionTimeout = null;
    }

    if (this.healthStatsTimer) {
      clearInterval(this.healthStatsTimer);
      this.healthStatsTimer = null;
    }
    if (this.workspaceSweepTimer) {
      clearInterval(this.workspaceSweepTimer);
      this.workspaceSweepTimer = null;
    }
    if (this.queueSweepTimer) {
      clearInterval(this.queueSweepTimer);
      this.queueSweepTimer = null;
    }
    for (const timer of this.pendingRespawnTimers) {
      clearTimeout(timer);
    }
    this.pendingRespawnTimers.clear();
    for (const timer of this.silentCompactScopes.values()) {
      clearTimeout(timer);
    }
    this.silentCompactScopes.clear();
    this.postTurnGate.clear();
    for (const waiter of this.autoCompactWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.autoCompactWaiters.clear();
    this.compactBoundaryScopes.clear();
    this.replyGuarantee?.shutdown();
    this.replyGuarantee = null;

    // Shutdown per_chat sessions
    if (this.sessionScope === 'per_chat') {
      const perChatKeys = new Set<string>([
        ...this.chatSessions.keys(),
        ...this.chatQueues.keys(),
        ...this.imageCoalesceBuffers.keys(),
      ]);
      for (const [chatJid, session] of this.chatSessions) {
        try { await session.shutdown(); } catch (err) { log.warn({ err, chatJid }, 'per_chat session shutdown failed'); }
      }
      for (const [chatJid, queue] of this.chatQueues) {
        try { await queue.shutdown(); } catch (err) { log.warn({ err, chatJid }, 'per_chat queue shutdown failed'); }
      }
      this.chatSessions.clear();
      this.chatQueues.clear();
      for (const mapKey of perChatKeys) {
        this.cleanupPerChatState(mapKey);
      }
    }

    if (this.session && this.sessionScope !== 'per_chat') {
      try {
        await this.session.shutdown();
      } catch (err) {
        log.warn({ err, instanceName: this.instanceName }, 'session shutdown failed');
      }
    }

    if (this.shared) {
      // Shutdown all per-chat outbound queues
      for (const [chatJid, queue] of this.outboundQueues) {
        try {
          await queue.shutdown();
        } catch (err) {
          log.warn({ err, chatJid }, 'queue shutdown failed — pending messages may be lost');
        }
      }
      this.outboundQueues.clear();
    } else {
      if (this.queue) {
        try {
          await this.queue.shutdown();
        } catch (err) {
          log.warn({ err }, 'queue shutdown failed — pending messages may be lost');
        }
      }
      this.queue = null;
    }

    this.session = null;
    this.activeChatJid = null;
    this.currentTurnChatJid = null;

    // Shutdown all operation trackers
    this.operationTracker?.shutdown();
    this.operationTracker = null;
    for (const tracker of this.operationTrackers.values()) {
      tracker.shutdown();
    }
    this.operationTrackers.clear();

    // Stop global socket server
    if (this.globalSocketServer) {
      try {
        this.globalSocketServer.stop();
        log.debug({ instanceName: this.instanceName }, 'global socket server stopped');
      } catch (err) {
        log.warn({ err, instanceName: this.instanceName }, 'global socket server stop failed');
      }
      this.globalSocketServer = null;
      this.globalMcpSocketPath = null;
    }

    // Stop workspace-scoped socket servers and media bridges (sandboxPerChat)
    let workspaceSocketServersStopped = 0;
    let workspaceMediaBridgesStopped = 0;
    for (const [conversationKey, res] of this.workspaceResources) {
      if (res.socketServer) {
        try {
          res.socketServer.stop();
          workspaceSocketServersStopped += 1;
        } catch (err) {
          log.warn({ err, conversationKey, socketPath: res.socketPath }, 'workspace socket server stop failed');
        }
      }
      if (res.mediaBridge) {
        try {
          res.mediaBridge();  // MediaBridge handle is a cleanup function
          workspaceMediaBridgesStopped += 1;
        } catch (err) {
          log.warn({ err, conversationKey, workspacePath: res.workspacePath }, 'workspace media bridge stop failed');
        }
      }
    }
    log.info({
      workspaceResourcesStopped: this.workspaceResources.size,
      workspaceSocketServersStopped,
      workspaceMediaBridgesStopped,
    }, 'workspace resources stopped in shutdown');
    this.workspaceResources.clear();

    for (const mapKey of [...this.imageCoalesceBuffers.keys()]) {
      this.abortImageCoalesceBuffer(mapKey, 'cleanup_aborted');
    }

    this.outboundQueues.clear();
    this.chatSessions.clear();
    this.chatQueues.clear();
    this.perChatCrashCount.clear();
    this.activeToolNames.clear();
    this.perChatInboundSeqQueue.clear();
    this.currentTurnInboundContentType = null;
    this.currentTurnAssistantText = '';
    this.currentTurnAssistantItemText.clear();
    this.perChatTurnContentType.clear();
    this.perChatTurnText.clear();
    this.perChatAssistantItemText.clear();
    this.pendingTurnText.clear();
    this.resumeFailedHandling.clear();
    this.imageCoalesceBuffers.clear();

    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
      durationMs: Date.now() - startedAt,
    }, 'AgentRuntime shut down');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Get the currently-active outbound queue.
   * In shared mode: the queue for the current turn's chat (or null if no turn in flight).
   * In non-shared mode: the single queue.
   */
  private getActiveQueue(): IOutboundQueue | null {
    if (this.sessionScope === 'per_chat') {
      // per_chat mode: this.queue is NOT set (shared field removed to fix race).
      // Callers in per_chat mode should use getQueueForChat(chatJid) instead.
      return null;
    }
    if (this.shared) {
      const jid = this.currentTurnChatJid ?? this.activeChatJid;
      return jid ? (this.outboundQueues.get(jid) ?? null) : null;
    }
    return this.queue;
  }

  private resolvePerChatMapKey(chatJid: string): string {
    if (this.sandboxPerChat) {
      return chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey;
    }
    return canonicalizeChatJid(chatJid, this.db);
  }

  private findMapKeyForSession(session: SessionManager | undefined, fallbackMapKey?: string): string | null {
    if (session) {
      for (const [mapKey, currentSession] of this.chatSessions) {
        if (currentSession === session) return mapKey;
      }
    }
    if (fallbackMapKey && this.chatSessions.has(fallbackMapKey)) {
      return fallbackMapKey;
    }
    return null;
  }

  /**
   * Get the outbound queue for a specific chatJid (shared mode).
   * Falls back to single queue (non-shared mode).
   */
  private getQueueForChat(chatJid: string, mapKey?: string): IOutboundQueue | null {
    if (this.sessionScope === 'per_chat') {
      return this.chatQueues.get(mapKey ?? this.resolvePerChatMapKey(chatJid)) ?? null;
    }
    if (this.shared) {
      return this.outboundQueues.get(chatJid) ?? null;
    }
    return this.queue;
  }

  /**
   * Create an OperationTracker for a session and wire its callbacks to the
   * appropriate queue and session methods. Returns null if tracking is disabled.
   */
  private createOperationTracker(
    session: SessionManager,
    resolveQueue: () => IOutboundQueue | null | undefined,
  ): OperationTracker | null {
    if (!config.operationTracker?.enabled) return null;
    return new OperationTracker(
      this.instanceName,
      config.operationTracker,
      {
        onProgress: (event: ProgressEvent) => {
          const q = resolveQueue();
          if (q) q.enqueueProgressUpdate(event, this.instanceName);
        },
        onStalled: (toolId: string, toolName: string) => {
          session.recoverStalledOperation(toolId, toolName);
        },
        onThinkingStalled: () => {
          session.probeLiveness();
        },
      },
    );
  }

  /** Resolve the operation tracker for a given mapKey (per_chat) or the singleton (single/shared).
   *  Always checks the per-key map first — control sessions store their tracker there even in
   *  single/shared scope, so the map lookup must precede the singleton fallback to prevent
   *  control session stalls from triggering recovery on the main session's process. */
  private getTracker(mapKey?: string): OperationTracker | null {
    if (mapKey !== undefined) {
      const perKeyTracker = this.operationTrackers.get(mapKey);
      if (perKeyTracker) return perKeyTracker;
    }
    if (this.sessionScope === 'per_chat') return null;
    return this.operationTracker;
  }

  private sendDirect(chatJid: string, text: string, bypassEchoGuard = false): void {
    if (bypassEchoGuard) {
      // Bypass queue entirely — direct send for admin responses
      this.messenger.sendMessage(chatJid, text).catch((err) =>
        log.error({ err }, 'sendDirect bypass failed'),
      );
      return;
    }
    const queue = this.getQueueForChat(chatJid);
    if (queue) {
      queue.enqueueText(text);
    } else {
      this.messenger.sendMessage(chatJid, text).catch((err) =>
        log.error({ err }, 'sendDirect fallback failed'),
      );
    }
  }

  /**
   * Construct a SessionManager with all instance-level fields pre-filled.
   * Callers supply only the variable parts: chatJid, cwd, and the three callbacks.
   */
  private createSessionManager(opts: {
    chatJid: string;
    cwd: string | undefined;
    actorJid?: string;
    onEvent: (event: AgentEvent) => void;
    onCrash: (info: SessionCrashInfo) => void;
    notifyUser: (msg: string) => void;
    onResumeFailed?: () => void;
    mcpSocketPath?: string;
  }): SessionManager {
    const conversationKey = toConversationKey(opts.chatJid);
    const providerToolSession: SessionContext =
      this.sandboxPerChat || this.sessionScope === 'per_chat'
        ? {
            tier: 'chat-scoped',
            conversationKey,
            deliveryJid: opts.chatJid,
            ...(opts.actorJid ? { actorJid: opts.actorJid } : {}),
            ...(opts.cwd ? { allowedRoot: opts.cwd } : {}),
          }
        : {
            tier: 'global',
            ...(opts.actorJid ? { actorJid: opts.actorJid } : {}),
            ...(!this.shared ? { conversationKey } : {}),
          };

    const session = new SessionManager({
      db: this.db,
      messenger: this.messenger,
      chatJid: opts.chatJid,
      onEvent: opts.onEvent,
      instanceName: this.instanceName,
      onResumeFailed: opts.onResumeFailed,
      onCrash: opts.onCrash,
      notifyUser: opts.notifyUser,
      cwd: opts.cwd,
      configSystemPrompt: this.configSystemPrompt,
      instructionsPath: this.instructionsPath,
      model: this.model,
      pluginDirs: this.pluginDirs,
      allowM365Mutations: this.allowM365Mutations,
      provider: this.agentProvider,
      providerConfig: this.agentProviderConfig,
      mcpBridge: createProviderMcpBridge(this.registry, providerToolSession),
      mcpSessionContext: providerToolSession,
      whatsoupInstance: this.instanceName,
      whatsoupMcpSocket: opts.mcpSocketPath ?? this.globalMcpSocketPath ?? undefined,
    });
    if (this.durability) {
      session.setDurability(this.durability);
    }
    return session;
  }

  private cleanupFailedSandboxWorkspace(workspaceKey: string): void {
    const queue = this.chatQueues.get(workspaceKey);
    if (queue) {
      try {
        queue.abortTurn();
      } catch (err) {
        log.warn({ err, workspaceKey }, 'failed to abort queued turn during workspace cleanup');
      }
      this.chatQueues.delete(workspaceKey);
    }

    this.chatSessions.delete(workspaceKey);
    this.cleanupPerChatState(workspaceKey);

    const res = this.workspaceResources.get(workspaceKey);
    if (!res) return;

    if (res.socketServer) {
      try {
        res.socketServer.stop();
      } catch (err) {
        log.warn({ err, workspaceKey }, 'failed to stop socket server during workspace cleanup');
      }
    }
    if (res.mediaBridge) {
      try {
        res.mediaBridge();
      } catch (err) {
        log.warn({ err, workspaceKey }, 'failed to stop media bridge during workspace cleanup');
      }
    }

    this.workspaceResources.delete(workspaceKey);
  }

  /**
   * Async variant of session/queue initialization for sandboxPerChat mode.
   * Called only when sandboxPerChat=true so the async/await overhead doesn't
   * affect the microtask ordering of existing non-sandboxPerChat tests.
   */
  private async ensureSessionAndQueue(chatJid: string, actorJid?: string): Promise<void> {
    // sandboxPerChat: each chat gets an isolated workspace; map keyed by workspaceKey
    const { workspaceKey, workspacePath } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);

    if (!this.chatSessions.has(workspaceKey)) {
      try {
        // Provision workspace (deterministic rewrite of control files)
        const hookPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/hooks/agent-sandbox.sh');
        const mcpServerPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/mcp/whatsoup-proxy.ts');
        const sendMediaServerPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/mcp/send-media-server.ts');
        const chatScopedToolNames = this.registry.getChatScopedToolNames();
        const socketPath = provisionWorkspace({
          workspacePath,
          instanceCwd: this.cwd ?? homedir(),
          sandbox: this.sandbox!,
          hookPath,
          mcpServerPath,
          sendMediaServerPath,
          chatScopedToolNames,
        });

        // Start chat-scoped WhatSoup socket server + media bridge for this workspace if not already running
        if (!this.workspaceResources.has(workspaceKey)) {
          let socketServer: WhatSoupSocketServer | null = null;
          let mediaBridge: MediaBridge | null = null;
          try {
            const chatSession: SessionContext = {
              tier: 'chat-scoped',
              conversationKey: workspaceKey,
              deliveryJid: chatJid,
              ...(actorJid ? { actorJid } : {}),
              allowedRoot: workspacePath,
            };
            socketServer = new WhatSoupSocketServer(socketPath, this.registry, chatSession);
            socketServer.start();
            log.info({ socketPath, workspaceKey }, 'chat-scoped WhatSoup socket server started');
          } catch (err) {
            log.warn({ err, socketPath }, 'failed to start WhatSoup socket server for workspace');
          }

          // Start media bridge — allows Claude Code subprocess to send media via Unix socket.
          // The bridge socket lives at .claude/media-bridge.sock alongside whatsoup.sock.
          const mediaBridgeSocketPath = join(workspacePath, '.claude', 'media-bridge.sock');
          try {
            mediaBridge = startMediaBridge(mediaBridgeSocketPath, this.messenger, workspacePath);
            setMediaBridgeChat(mediaBridge, chatJid);
            log.info({ mediaBridgeSocketPath, workspaceKey }, 'media bridge started');
          } catch (err) {
            log.warn({ err, mediaBridgeSocketPath }, 'failed to start media bridge for workspace');
          }

          this.workspaceResources.set(workspaceKey, {
            socketPath,
            workspacePath,
            socketServer,
            mediaBridge,
            lastActivity: Date.now(),
          });
        }

        // Check for resumable session
        const resumable = getResumableSessionForChat(this.db, workspaceKey);

        // Create SessionManager with workspace-scoped cwd
        const toolScopeKey = this.createToolScopeKey(workspaceKey);
        const session = this.createSessionManager({
          chatJid,
          cwd: workspacePath,  // scoped cwd instead of this.cwd
          actorJid,
          mcpSocketPath: socketPath,
          onEvent: (event) => this.handleEventPerChat(workspaceKey, event, toolScopeKey),
          onCrash: (info) => this.handlePerChatCrash(workspaceKey, chatJid, info),
          notifyUser: (msg) => {
            // Only remove session from map if it's actually dead (crash/exit).
            // Watchdog warnings fire on ACTIVE sessions — removing those breaks
            // event routing and causes cascading false-idle notifications.
            const s = this.chatSessions.get(workspaceKey);
            if (s && !s.getStatus().active) {
              this.chatSessions.delete(workspaceKey);
              this.chatQueues.get(workspaceKey)?.abortTurn();
              this.chatQueues.delete(workspaceKey);
              this.cleanupPerChatState(workspaceKey);
            }
            this.handleCrashNotify(msg, chatJid);
          },
          onResumeFailed: () => this.handleResumeFailed(chatJid),
        });
        log.info({ chatJid, workspaceKey, workspacePath }, 'created sandbox per-chat session manager');
        this.chatSessions.set(workspaceKey, session);
        const chatQ = this.createOutboundQueue(chatJid, 'sandbox per-chat session init');
        this.chatQueues.set(workspaceKey, chatQ);

        // Wire operation tracker for this sandbox session
        const tracker = this.createOperationTracker(session, () => this.chatQueues.get(workspaceKey));
        if (tracker) this.operationTrackers.set(workspaceKey, tracker);

        // Spawn with resume if available — fall back to fresh session if resume fails
        if (resumable) {
          try {
            await session.spawnSession(resumable.session_id, resumable.id);
          } catch (err) {
            log.warn({ err, workspaceKey, sessionId: resumable.session_id }, 'resume threw — spawning fresh session');
            try {
              await session.spawnSession();
            } catch (spawnErr) {
              log.error({ err: spawnErr, workspaceKey }, 'fresh spawn also failed — cleaning up workspace');
              throw spawnErr;
            }
          }
        }
      } catch (err) {
        this.cleanupFailedSandboxWorkspace(workspaceKey);
        throw err;
      }
    }

    // Update delivery JID on existing queue (handles JID variant changes)
    this.chatQueues.get(workspaceKey)?.updateDeliveryJid(chatJid);

    // Update delivery JID on the chat-scoped socket server and media bridge
    const res = this.workspaceResources.get(workspaceKey);
    if (res?.socketServer) {
      res.socketServer.updateDeliveryJid(chatJid);
    }
    if (res?.mediaBridge) {
      setMediaBridgeChat(res.mediaBridge, chatJid);
    }
    if (res) {
      res.lastActivity = Date.now();
    }

    // sandboxPerChat: do NOT set this.session/this.queue shared fields.
    // All per_chat code paths look up from chatSessions/chatQueues maps directly.
  }

  /**
   * Synchronous session/queue initialization for non-sandboxPerChat mode.
   * Kept synchronous to preserve microtask ordering in existing code paths.
   */
  private ensureSessionAndQueueSync(
    chatJid: string,
    initialMapKey: string = this.resolvePerChatMapKey(chatJid),
    actorJid?: string,
  ): void {
    if (this.sessionScope === 'per_chat') {
      // per_chat: independent session + queue per canonical chat key
      if (!this.chatSessions.has(initialMapKey)) {
        const toolScopeKey = this.createToolScopeKey(initialMapKey);
        let session!: SessionManager;
        const resolveSessionMapKey = () => this.findMapKeyForSession(session, initialMapKey);
        session = this.createSessionManager({
          chatJid,
          cwd: this.cwd,
          actorJid,
          onEvent: (event) => {
            const mapKey = resolveSessionMapKey();
            if (!mapKey) {
              log.debug({ initialMapKey, chatJid, eventType: event.type }, 'event dropped — session key missing for per-chat callback');
              return;
            }
            this.handleEventPerChat(mapKey, event, toolScopeKey);
          },
          onCrash: (info) => {
            const mapKey = resolveSessionMapKey() ?? initialMapKey;
            this.handlePerChatCrash(mapKey, chatJid, info);
          },
          notifyUser: (msg) => {
            // Only remove session from map if it's actually dead (crash/exit).
            // Watchdog warnings fire on ACTIVE sessions — removing those breaks
            // event routing and causes cascading false-idle notifications.
            const mapKey = resolveSessionMapKey();
            if (mapKey) {
              const s = this.chatSessions.get(mapKey);
              if (s && !s.getStatus().active) {
                this.chatSessions.delete(mapKey);
                this.chatQueues.get(mapKey)?.abortTurn();
                this.chatQueues.delete(mapKey);
                this.cleanupPerChatState(mapKey);
              }
            }
            this.handleCrashNotify(msg, chatJid);
          },
        });
        log.info({ chatJid, mapKey: initialMapKey, sessionScope: this.sessionScope }, 'created per-chat session manager');
        this.chatSessions.set(initialMapKey, session);
        const perChatQ = this.createOutboundQueue(chatJid, 'per-chat session init');
        this.chatQueues.set(initialMapKey, perChatQ);

        // Wire operation tracker for this per-chat session
        const tracker = this.createOperationTracker(session, () => this.chatQueues.get(initialMapKey));
        if (tracker) this.operationTrackers.set(initialMapKey, tracker);
      }
      this.chatQueues.get(initialMapKey)?.updateDeliveryJid(chatJid);
      // per_chat mode: do NOT set this.session/this.queue shared fields.
      // /status, /new, and crash handlers look up from chatSessions/chatQueues maps directly.
      return;
    }

    // single/shared: singleton session
    if (!this.session) {
      this.activeChatJid = chatJid;
      this.session = this.createSessionManager({
        chatJid,
        cwd: this.cwd,
        actorJid,
        onEvent: (event) => this.handleEvent(event),
        onCrash: (info) => {
          this.recordCrash(GLOBAL_CRASH_SCOPE_KEY);
          this.getActiveQueue()?.abortTurn();
          this.cleanupSharedCrashTurnState();
          // Mark inbound event failed so it doesn't stay stuck in processing
          if (this.durability && this.currentInboundSeq !== undefined) {
            this.replyGuarantee?.disarm(this.currentInboundSeq);
            this.durability.markInboundFailed(this.currentInboundSeq);
            this.currentInboundSeq = undefined;
          }
          if (config.controlPeers.size > 0) {
            try {
              emitHealReport(this.db, this.messenger, this.durability, {
                type: 'crash',
                chatJid,
                exitCode: info.exitCode ?? undefined,
                signal: info.signal ?? undefined,
              }, this.activeControlReportId);
            } catch (err) {
              log.warn({ err }, 'failed to emit heal report for session crash');
            }
          }
        },
        notifyUser: (msg) => this.handleCrashNotify(msg),
      });
      log.info({ chatJid, shared: this.shared, sessionScope: this.sessionScope }, 'created shared/single session manager');
      if (this.shared) {
        this.ensureOutboundQueue(chatJid);
      } else {
        const singletonQ = this.createOutboundQueue(chatJid, 'single session init');
        this.queue = singletonQ;
      }

      // Wire operation tracker for single/shared session
      this.operationTracker = this.createOperationTracker(this.session, () => this.getActiveQueue());
    } else if (this.shared) {
      this.ensureOutboundQueue(chatJid);
    }
  }

  /**
   * Ensure a per-chat outbound queue exists for the given JID (shared mode).
   * @check CHK-066 // @traces REQ-012.AC-05
   */
  private ensureOutboundQueue(chatJid: string): void {
    if (!this.outboundQueues.has(chatJid)) {
      const q = this.createOutboundQueue(chatJid, 'shared ensureOutboundQueue');
      this.outboundQueues.set(chatJid, q);
    }
  }

  private handlePerChatCrash(mapKey: string, chatJid?: string, info?: SessionCrashInfo): void {
    this.recordCrash(mapKey);
    const crashCount = this.getCrashCount(mapKey);
    this.chatQueues.get(mapKey)?.abortTurn();
    // Shutdown operation tracker for this crashed session
    this.operationTrackers.get(mapKey)?.shutdown();
    const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
    const inboundSeq = seqQueue[0];
    if (this.durability && inboundSeq !== undefined) {
      this.replyGuarantee?.disarm(inboundSeq);
      this.durability.markInboundFailed(inboundSeq);
      seqQueue.shift();
    }
    this.cleanupPerChatCrashTurnState(mapKey);
    if (config.controlPeers.size > 0 && chatJid) {
      try {
        emitHealReport(this.db, this.messenger, this.durability, {
          type: 'crash',
          chatJid,
          exitCode: info?.exitCode ?? undefined,
          signal: info?.signal ?? undefined,
        }, this.activeControlReportId);
      } catch (err) {
        log.warn({ err }, 'failed to emit heal report for session crash');
      }
    }

    // Auto-respawn: if we haven't hit the crash limit, try to resume the session
    // after a short delay. This lets the agent continue mid-conversation without
    // requiring the user to send a new message.
    if (crashCount <= AUTO_RESPAWN_MAX_CRASHES && info?.sessionId) {
      const session = this.chatSessions.get(mapKey);
      if (session) {
        const sessionId = info.sessionId;
        const dbRowId = info.dbRowId;
        const crashedAtSec = Math.floor(Date.now() / 1000);
        const delayMs = jitteredDelay(AUTO_RESPAWN_BASE_MS, crashCount - 1, AUTO_RESPAWN_MAX_DELAY_MS);
        log.info({ mapKey, sessionId, attempt: crashCount, delayMs }, 'scheduling auto-respawn');
        const timer = setTimeout(() => {
          this.pendingRespawnTimers.delete(timer);
          // Verify the session is still in the map and still inactive
          const current = this.chatSessions.get(mapKey);
          if (!current || current !== session || current.getStatus().active) return;

          log.info({ mapKey, sessionId }, 'auto-respawn: attempting resume');
          session.spawnSession(sessionId, dbRowId ?? undefined).then(async () => {
            await new Promise(r => setTimeout(r, 1_000));
            if (!session.getStatus().active) return;
            clearAlertSource(this.instanceName, 'agent_respawn_failed');
            try {
              // Inject messages that arrived during the crash window
              if (chatJid) {
                await this.injectMissedMessages(session, chatJid, crashedAtSec);
              }
              await session.sendTurn('[System: session resumed after crash ��� continue where you left off]');
              log.info({ mapKey }, 'sent continuation turn after auto-respawn');
            } catch (err) {
              log.warn({ err, mapKey }, 'failed to send continuation turn after auto-respawn');
            }
          }).catch((err) => {
            log.warn({ err, mapKey, sessionId }, 'auto-respawn resume failed — will retry on next message');
          });
        }, delayMs);
        this.pendingRespawnTimers.add(timer);
      }
    } else if (crashCount > AUTO_RESPAWN_MAX_CRASHES) {
      log.error({ mapKey, crashes: crashCount }, 'auto-respawn exhausted — emitting alert');
      emitAlert(
        this.instanceName,
        'agent_respawn_failed',
        `whatsoup@${this.instanceName} agent respawn exhausted (${crashCount} crashes)`,
        `Chat: ${mapKey}, Last exit: code=${info?.exitCode ?? '?'} signal=${info?.signal ?? 'none'}`,
      );
    }
  }

  private cleanupSharedCrashTurnState(): void {
    this.activeToolNames.clear();
    this.turnHadVisibleOutput = false;
    this.currentTurnChatJid = null;
    this.currentTurnInboundContentType = null;
    this.currentTurnAssistantText = '';
    this.currentTurnAssistantItemText.clear();
    // Shutdown operation tracker on crash (timers must be cleared)
    this.operationTracker?.shutdown();
    this.operationTracker = null;
    // If a compact_boundary was already observed before the crash, the SDK
    // produced a fresh compacted context — persist the baseline before
    // dropping the flag, so the next turn doesn't immediately re-fire
    // /compact against a stale lastCompactInputTokens.
    this.persistBaselineIfBoundaryObserved(GLOBAL_TOOL_SCOPE_KEY, this.session?.getDbRowId() ?? null);
    this.consumeCompactBoundary(GLOBAL_TOOL_SCOPE_KEY);
    this.finishAutoCompact(GLOBAL_TOOL_SCOPE_KEY);
    this.clearSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
  }

  private cleanupPerChatCrashTurnState(mapKey: string): void {
    this.activeToolNames.clear();
    this.turnHadVisibleOutput = false;
    this.currentTurnChatJid = null;
    this.perChatTurnContentType.delete(mapKey);
    this.perChatTurnText.delete(mapKey);
    this.perChatAssistantItemText.delete(mapKey);
    // Persist baseline first if compact_boundary was observed — see
    // cleanupSharedCrashTurnState for rationale.
    this.persistBaselineIfBoundaryObserved(mapKey, this.chatSessions.get(mapKey)?.getDbRowId() ?? null);
    this.consumeCompactBoundary(mapKey);
    this.finishAutoCompact(mapKey);
    this.clearSilentCompact(mapKey);
  }

  /**
   * On crash cleanup, if compact_boundary was already observed for `scopeKey`
   * (the SDK emitted boundary but the `result` event never landed), persist
   * the baseline now. Otherwise the next turn re-fires /compact against a
   * stale lastCompactInputTokens — one redundant compact per
   * crash-during-compact.
   */
  private persistBaselineIfBoundaryObserved(scopeKey: string, rowId: number | null): void {
    if (rowId === null) return;
    if (!this.compactBoundaryScopes.has(scopeKey)) return;
    markSessionCompacted(this.db, rowId);
    log.info({ scopeKey, rowId }, 'auto compact baseline persisted on crash cleanup (compact_boundary observed pre-crash)');
  }

  /**
   * Routes a crash notification through the outbound queue so it arrives after
   * any partial turn output that was already enqueued before the crash.
   * Falls back to a direct send if the queue is gone.
   */
  private handleCrashNotify(msg: string, chatJid?: string): void {
    // In per_chat mode, chatJid MUST be passed — this.queue is not set.
    // In single/shared mode, chatJid is optional (falls back to shared fields).
    const queue = chatJid ? this.getQueueForChat(chatJid) : this.queue;
    if (queue) {
      queue.enqueueText(msg);
      queue.flush().catch((err) => log.error({ err }, 'flush after crash failed'));
    } else {
      const target = chatJid ?? this.activeChatJid;
      if (target) {
        this.messenger
          .sendMessage(target, msg)
          .catch((err) => log.error({ err }, 'crash notice fallback send failed'));
      }
    }
  }

  private formatRecoveryTimestamp(unixMs: number): string {
    const d = new Date(unixMs * 1000); // timestamps are unix seconds
    return d.toTimeString().slice(0, 5); // HH:MM
  }

  /**
   * Inject messages the agent missed during downtime into a resumed session.
   * Uses `sinceUnixSec` (typically the checkpoint's updated_at) to fetch only
   * messages that arrived after the session was last active.
   * Returns true if any context was injected.
   */
  private async injectMissedMessages(
    session: SessionManager,
    chatJid: string,
    sinceUnixSec: number,
  ): Promise<boolean> {
    try {
      const convKey = toConversationKey(chatJid);
      const missed = getMessagesSince(this.db, convKey, sinceUnixSec, 30);
      if (missed.length === 0) return false;

      const lines = missed
        .map(
          (m) =>
            `[${this.formatRecoveryTimestamp(m.timestamp)}] ${m.senderName ?? m.senderJid}: ${m.content ?? '[media]'}`,
        )
        .join('\n');
      await session.sendTurn(`[Recent chat context — read before responding]\n${lines}`);
      log.info({ chatJid, messageCount: missed.length, sinceUnixSec }, 'injected missed messages after resume');
      return true;
    } catch (err) {
      log.warn({ err, chatJid }, 'missed message injection failed — agent continues without context');
      return false;
    }
  }

  /**
   * Called by SessionManager when a --resume attempt is rejected by Claude
   * (exit code 1, no init event). Sends a clear status message and spawns a
   * fresh session so the user can continue without manual intervention.
   */
  private handleResumeFailed(chatJid: string): void {
    log.warn({ chatJid }, 'resume failed — spawning fresh session');

    // Resolve the correct session and mapKey — sandboxPerChat uses the per-chat map,
    // single/shared mode uses the shared this.session field.
    let session: SessionManager | undefined;
    let mapKey: string | undefined;
    if (this.sandboxPerChat) {
      const ws = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);
      mapKey = ws.workspaceKey;
      session = this.chatSessions.get(mapKey);
    } else {
      session = this.session ?? undefined;
    }
    if (mapKey) this.abortImageCoalesceBuffer(mapKey, 'resume_failed');
    if (!session) {
      log.warn({ chatJid }, 'handleResumeFailed: no session — skipping');
      return;
    }

    // Pending-turn replay only applies to sandboxPerChat (per_chat) mode.
    // sendTurnPerChat sets pendingTurnText[mapKey] before calling sendTurnToSession,
    // so if a resume fails mid-send the turn text is available for replay.
    // single/shared mode uses sendTurnNonShared → sendTurnToSession directly and never
    // populates pendingTurnText, so mapKey is undefined here and pendingText will
    // always be undefined — which is correct, as no turn is in-flight at resume time.
    const pendingText = mapKey ? this.pendingTurnText.get(mapKey) : undefined;

    if (!pendingText) {
      // No pending message — notify user to resend
      const msg = '_Previous session expired_ — starting fresh. Send a message to begin.';
      if (this.pendingStartupMessage !== null) {
        this.pendingStartupMessage = { chatJid, text: msg };
      } else {
        this.sendDirect(chatJid, msg);
      }
    }

    // Mark this mapKey as owned by handleResumeFailed before spawning
    // so that any concurrent sendTurnToSession call for the same chat skips its own
    // context injection (preventing double context blocks on the fresh session).
    if (mapKey) this.resumeFailedHandling.add(mapKey);

    // Spawn a clean session and replay the pending turn if one exists.
    // The `pendingText && mapKey` guard below is a no-op for single/shared mode
    // (mapKey is always undefined) — replay is sandboxPerChat-only by design.
    session
      .spawnSession()
      .then(async () => {
        // Re-check the session reference after spawn — race condition guard. The crash
        // callback (notifyUser) may have deleted it from chatSessions during spawn.
        // Continuing with an orphaned reference would send turns to a dead session.
        if (mapKey) {
          const currentSession = this.chatSessions.get(mapKey);
          if (!currentSession || currentSession !== session) {
            log.warn({ chatJid, mapKey }, 'handleResumeFailed: session was replaced or removed during spawn — aborting replay');
            this.resumeFailedHandling.delete(mapKey);
            return;
          }
        }

        // context injection + replay wrapped in turnChain to preserve serialization
        this.turnChain = this.turnChain.then(async () => {
          // Clear the resumeFailedHandling flag once we are inside the chain —
          // the context injection below is about to run, after which concurrent
          // sendTurnToSession calls may inject normally.
          if (mapKey) this.resumeFailedHandling.delete(mapKey);

          try {
            const recent = getRecentMessages(this.db, toConversationKey(chatJid), 30);
            if (recent.length > 0) {
              const lines = recent
                .reverse()
                .map(
                  (m) =>
                    `[${this.formatRecoveryTimestamp(m.timestamp)}] ${m.senderName ?? m.senderJid}: ${m.content ?? '[media]'}`,
                )
                .join('\n');
              await session.sendTurn(`[CONTEXT RECOVERY — prior session expired]\n${lines}`);
            }
          } catch (err) {
            log.warn({ err, chatJid }, 'context recovery failed — starting blank session');
          }

          // Replay the pending turn that was lost during the failed resume
          if (pendingText && mapKey) {
            log.info({ chatJid, mapKey, textPreview: pendingText.slice(0, 80) }, 'replaying pending turn after resume failure');
            try {
              await session.sendTurn(pendingText);
            } catch (err) {
              log.warn({ err, chatJid }, 'pending turn replay failed');
              this.pendingTurnText.delete(mapKey);
            }
          }
        }).catch((err) => {
          log.error({ err, chatJid, mapKey }, 'context recovery turn failed after resume failure');
        });
      })
      .catch((err) => {
        if (mapKey) this.resumeFailedHandling.delete(mapKey);
        log.error({ err }, 'failed to spawn fresh session after resume failure');
      });
  }

  /**
   * Synthesize the agent's text response via ElevenLabs and send as a PTT voice note.
   * Non-fatal — called after the text response has already been delivered. (SP4)
   */
  private async _sendVoiceReply(chatJid: string, responseText: string): Promise<void> {
    try {
      const voiceResult = await synthesizeSpeech(responseText, {
        voiceId: config.elevenlabs.defaultVoiceId,
        modelId: config.elevenlabs.defaultModel,
        stability: config.elevenlabs.stability,
        similarityBoost: config.elevenlabs.similarityBoost,
      });

      const voicePath = writeTempFile(voiceResult.buffer, 'mp3');
      const { readFileSync } = await import('node:fs');
      const voiceBuffer = readFileSync(voicePath);

      await (this.messenger as ConnectionManager).sendMedia(chatJid, {
        type: 'audio',
        buffer: voiceBuffer,
        mimetype: 'audio/mpeg',
        ptt: true,
        seconds: voiceResult.duration,
      });

      log.info({ chatJid, duration: voiceResult.duration }, 'voice reply sent');
    } catch (err) {
      // Non-fatal: text response was already sent. Log and continue.
      log.warn({ err, chatJid }, 'voice reply failed — text response already sent');
    }
  }

  private handleEvent(event: AgentEvent): void {
    // Route to current turn's chat in shared mode, or the single queue in non-shared mode
    const queue = this.shared
      ? (this.currentTurnChatJid ? this.outboundQueues.get(this.currentTurnChatJid) ?? null : null)
      : this.queue;

    if (!queue) return;

    const tracker = this.operationTracker;

    switch (event.type) {
      case 'init':
        log.debug({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, sessionId: event.sessionId }, 'session init');
        break;

      case 'assistant_text':
        this.session?.tickWatchdog();
        tracker?.onAnyActivity();
        // Post-turn gate: suppress phantom assistant_text (same as handleEventWithContext)
        if (this.postTurnGate.has(GLOBAL_TOOL_SCOPE_KEY)) {
          log.info({ textPreview: event.text.slice(0, 200) }, 'post-turn gate: suppressed phantom assistant_text (shared)');
          break;
        }
        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) break;
        {
          const normalizedText = this.normalizeAssistantTextForDelivery(event);
          if (!normalizedText) break;
          // Suppress usage-limit messages — don't flood WhatsApp with them
          if (isUsageLimitMessage(normalizedText)) {
            log.warn({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, textPreview: normalizedText.slice(0, 300) }, 'suppressed usage-limit message from assistant_text');
            break;
          }
          queue.enqueueStreamingText(normalizedText);
          this.turnHadVisibleOutput = true;
          // Accumulate text for voice reply (SP4)
          this.currentTurnAssistantText += normalizedText;
        }
        break;

      case 'tool_use':
        this.session?.trackToolStart(event.toolId);
        this.session?.tickWatchdog();
        // Post-turn gate: suppress phantom tool_use (same as handleEventWithContext)
        if (this.postTurnGate.has(GLOBAL_TOOL_SCOPE_KEY)) {
          log.info({ toolName: event.toolName }, 'post-turn gate: suppressed phantom tool_use (shared)');
          break;
        }
        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) break;
        this.getToolNames(GLOBAL_TOOL_SCOPE_KEY).set(event.toolId, event.toolName);
        {
          const toolUpdate = buildToolUpdate(event.toolName, event.toolInput ?? {});
          queue.enqueueToolUpdate(toolUpdate);
          tracker?.onToolStart(event.toolId, event.toolName, toolUpdate.category);
        }
        break;

      // @check CHK-023
      // @traces REQ-005.AC-05
      case 'compact_boundary':
        this.session?.tickWatchdog();
        tracker?.onAnyActivity();
        this.compactBoundaryScopes.add(GLOBAL_TOOL_SCOPE_KEY);
        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) {
          log.info({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid }, 'silent agent compact boundary observed');
          break;
        }
        // Start the composing indicator so the user sees activity during compaction,
        // then send the notification. The indicator stays alive via the heartbeat
        // until the turn's result event fires flush().
        queue.indicateTyping();
        queue.enqueueText(
          'Context compacted — older details summarized. Restate any important context I should carry forward.',
        );
        this.turnHadVisibleOutput = true;
        break;

      case 'tool_result':
        this.session?.trackToolEnd(event.toolId);
        this.session?.tickWatchdog();
        tracker?.onToolEnd(event.toolId);
        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) break;
        const toolNames = this.activeToolNames.get(GLOBAL_TOOL_SCOPE_KEY);
        if (event.isError) {
          const toolName = toolNames?.get(event.toolId) ?? 'unknown';
          const errorPreview = event.content.length > 200 ? event.content.slice(0, 200) + '...' : event.content;
          log.warn({
            chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
            toolId: event.toolId,
            toolName,
            error: errorPreview,
          }, 'tool error reported by agent');
          queue.enqueueToolUpdate(classifyToolError(toolName, event.content));
        }
        toolNames?.delete(event.toolId);
        if (toolNames && toolNames.size === 0) {
          this.activeToolNames.delete(GLOBAL_TOOL_SCOPE_KEY);
        }
        break;

      case 'result': {
        const wasSilentCompact = this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
        const hadCompactBoundary = this.consumeCompactBoundary(GLOBAL_TOOL_SCOPE_KEY);
        this.session?.clearTurnWatchdog();
        tracker?.onTurnComplete();
        this.clearToolNames(GLOBAL_TOOL_SCOPE_KEY);
        // Activate post-turn gate — suppress any SDK-injected events until next user turn
        this.postTurnGate.add(GLOBAL_TOOL_SCOPE_KEY);
        // Render result.text if present (e.g. terminal context-limit errors)
        if (event.text) {
          // Suppress usage-limit messages — log and kill session instead of forwarding
          if (isUsageLimitMessage(event.text)) {
            log.warn({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed usage-limit message from result — session will be killed');
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq: this.currentInboundSeq,
              conversationKey: toConversationKey(queue.targetChatJid),
              clearCurrentInboundSeq: true,
            });
            this.session?.shutdown();
            break;
          }
          if (!wasSilentCompact) {
            queue.enqueueResultText(event.text);
            this.turnHadVisibleOutput = true;
            // Accumulate result text for voice reply (SP4)
            this.currentTurnAssistantText += event.text;
          }
        }
        this.currentTurnAssistantItemText.clear();
        const rowId = this.session?.getDbRowId() ?? null;
        const lastOpId = queue.getLastOpId();
        // If nothing visible was emitted this turn, send an explicit fallback
        if (!this.turnHadVisibleOutput && !wasSilentCompact) {
          queue.enqueueText('_(no response)_');
        }
        this.turnHadVisibleOutput = false;
        this.currentTurnChatJid = null;
        if (this.durability) {
          this.durability.completeTurn({
            ...((event.inputTokens !== undefined || event.outputTokens !== undefined) && rowId !== null
              ? {
                  sessionTokens: {
                    dbRowId: rowId,
                    inputTokens: event.inputTokens ?? 0,
                    outputTokens: event.outputTokens ?? 0,
                  },
                }
              : {}),
            ...(this.activeChatJid
              ? {
                  checkpoint: {
                    conversationKey: toConversationKey(this.activeChatJid),
                    fields: {
                      activeTurnId: null,
                      ...(this.currentInboundSeq !== undefined && { lastInboundSeq: this.currentInboundSeq }),
                      ...(lastOpId !== undefined && { lastFlushedOutboundId: lastOpId }),
                    },
                  },
                }
              : {}),
            ...(this.currentInboundSeq !== undefined
              ? {
                  inbound: {
                    seq: this.currentInboundSeq,
                    terminalReason: 'response_sent',
                  },
                }
              : {}),
            ...(lastOpId !== undefined ? { lastOpId } : {}),
          });
          this.replyGuarantee?.disarm(this.currentInboundSeq);
          if (this.currentInboundSeq !== undefined) {
            this.currentInboundSeq = undefined;
          }
          if (lastOpId !== undefined) {
            queue.clearLastOpId();
          }
        } else {
          if ((event.inputTokens !== undefined || event.outputTokens !== undefined) && rowId !== null) {
            accumulateTokensWithEvent(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
          }
          // Defense-in-depth: mark last op terminal so echo auto-complete fires if
          // the process crashes after send but before completeInbound runs.
          queue.markLastTerminal();
        }
        // Only advance the compact baseline when the SDK actually emitted a
        // compact_boundary. wasSilentCompact alone means "we suppressed
        // user-facing chrome for an auto-trigger" and doesn't prove /compact
        // succeeded — advancing on it silently disables auto-compact for
        // another threshold's worth of tokens. See the per_chat handler for
        // the parallel gate.
        if (hadCompactBoundary && rowId !== null) {
          markSessionCompacted(this.db, rowId);
        }
        if (wasSilentCompact || hadCompactBoundary) {
          this.finishAutoCompact(GLOBAL_TOOL_SCOPE_KEY);
        } else {
          this.maybeStartAutoCompact(this.session);
        }
        {
          // Capture voice reply context before flush (SP4)
          const chatJidForVoice = this.shared ? this.currentTurnChatJid : this.activeChatJid;
          const inboundContentType = this.currentTurnInboundContentType;
          const responseText = wasSilentCompact ? '' : this.currentTurnAssistantText;
          // Reset per-turn voice state
          this.currentTurnInboundContentType = null;
          this.currentTurnAssistantText = '';
          queue.flush()
            .then(() => {
              // Send voice reply after text is delivered (non-fatal, SP4)
              if (
                chatJidForVoice &&
                responseText &&
                config.voiceReply !== 'never' &&
                (config.voiceReply === 'always' || inboundContentType === 'audio')
              ) {
                return this._sendVoiceReply(chatJidForVoice, responseText);
              }
            })
            .catch((err) => log.error({ err }, 'flush or voice reply failed'));
        }
        if (wasSilentCompact) this.clearSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
        break;
      }

      case 'token_usage':
        // Record token usage without triggering turn completion (non-per-chat path).
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
          const rowId = this.session?.getDbRowId() ?? null;
          if (rowId !== null) {
            accumulateTokensWithEvent(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
          }
        }
        break;

      case 'ignored':
      case 'unknown':
      case 'parse_error':
        log.debug({ event }, 'ignored/unknown/parse_error event');
        break;
    }
  }

  private cleanupUsageLimitTurn(
    queue: IOutboundQueue,
    opts: {
      inboundSeq?: number;
      conversationKey?: string;
      mapKey?: string;
      clearCurrentInboundSeq?: boolean;
    } = {},
  ): void {
    const { inboundSeq, conversationKey, mapKey, clearCurrentInboundSeq = false } = opts

    this.activeToolNames.clear()
    this.currentTurnChatJid = null
    this.turnHadVisibleOutput = false

    this.currentTurnInboundContentType = null
    this.currentTurnAssistantText = ''
    this.currentTurnAssistantItemText.clear()

    if (mapKey !== undefined) {
      this.perChatTurnContentType.delete(mapKey)
      this.perChatTurnText.delete(mapKey)
      this.perChatAssistantItemText.delete(mapKey)
    }

    if (this.durability && conversationKey) {
      this.durability.upsertSessionCheckpoint(conversationKey, {
        activeTurnId: null,
        ...(inboundSeq !== undefined && { lastInboundSeq: inboundSeq }),
        ...(queue.getLastOpId() !== undefined && { lastFlushedOutboundId: queue.getLastOpId() }),
      })
    }
    if (this.durability && inboundSeq !== undefined) {
      this.durability.completeInbound(inboundSeq, 'response_sent')
    }
    this.replyGuarantee?.disarm(inboundSeq)
    if (clearCurrentInboundSeq) {
      this.currentInboundSeq = undefined
    }

    queue.flush().catch((err) => log.error({ err }, 'usage-limit cleanup flush failed'))
  }
}
