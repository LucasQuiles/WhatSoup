// src/runtimes/agent/runtime.ts
// AgentRuntime implements the Runtime interface, tying all agent components together.

import type { Runtime } from '../types.ts';
import type { IncomingMessage, Messenger, RuntimeHealth } from '../../core/types.ts';
import type { Database } from '../../core/database.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import type { AgentEvent } from './stream-parser.ts';
import { EmitHealResultSchema } from '../../core/heal-protocol.ts';
import { dequeueNextReport, emitHealReport } from '../../core/heal.ts';
import { sendTracked } from '../../core/durability.ts';
import { emitAlert, clearAlertSource } from '../../lib/emit-alert.ts';
import { createChildLogger } from '../../logger.ts';
import {
  ensureAgentSchema,
  getActiveSession,
  backfillWorkspaceKeys,
  markOrphaned,
  sweepOrphanedSessions,
  getResumableSessionForChat,
  accumulateSessionTokens,
} from './session-db.ts';
import { chatJidToWorkspace, provisionWorkspace, writeSandboxArtifacts, ensurePermissionsSettings } from '../../core/workspace.ts';
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
import { getRecentMessages, updateMediaPath } from '../../core/messages.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { toPersonalJid } from '../../core/jid-constants.ts';
import { TurnQueue, type QueuedTurn } from './turn-queue.ts';
import { config } from '../../config.ts';
import { resolvePhoneFromJid } from '../../core/access-list.ts';
import { isAdminPhone } from '../../lib/phone.ts';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { ToolRegistry } from '../../mcp/registry.ts';
import { WhatSoupSocketServer } from '../../mcp/socket-server.ts';
import type { SessionContext } from '../../mcp/types.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import { registerAllTools } from '../../mcp/register-all.ts';
import { startMediaBridge, setMediaBridgeChat, type MediaBridge } from './media-bridge.ts';
import { generateMcpConfigFile } from './providers/mcp-bridge.ts';
import { extractRawMime } from '../../core/media-mime.ts';
import { jitteredDelay } from '../../core/retry.ts';

const log = createChildLogger('agent-runtime');

/** Tracks workspace media directories already created — avoids redundant mkdirSync calls. */
const createdMediaDirs = new Set<string>();

/** Maximum duration (ms) a control session is allowed to run before force-shutdown. */
const CONTROL_SESSION_TIMEOUT_MS = 15 * 60 * 1000;

/** Max consecutive crashes before auto-respawn gives up and waits for user action. */
const AUTO_RESPAWN_MAX_CRASHES = 3;
/** Base delay (ms) before attempting auto-respawn after a crash. Actual delay uses exponential backoff. */
const AUTO_RESPAWN_BASE_MS = 2_000;
/** Maximum respawn delay (ms) — caps the exponential backoff. */
const AUTO_RESPAWN_MAX_DELAY_MS = 15_000;

/**
 * Prepare a plain-text content string for the agent runtime from any message type.
 *
 * Media files (images, audio, video, documents, stickers) are saved to disk so the
 * agent can use its Read tool to view them. The agent receives the file path in brackets.
 * Audio is also transcribed via Whisper so the agent gets the text without having to
 * open the file. Non-downloadable types (location, contact, poll) return descriptive text.
 *
 * Requires OPENAI_API_KEY in the environment for audio transcription (Whisper).
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
    if (dotIdx > 0) ext = content.substring(dotIdx + 1).toLowerCase();
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
    mkdirSync(mediaDestDir, { recursive: true, mode: 0o700 });
    createdMediaDirs.add(mediaDestDir);
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
  private readonly db: Database;
  private readonly messenger: Messenger;
  private readonly instanceName: string;
  private readonly shared: boolean;
  private readonly sessionScope: SessionScope;
  private readonly cwd: string | undefined;
  private readonly instructionsPath: string | undefined;
  private readonly sandbox: SandboxPolicy | undefined;
  private readonly model: string | undefined;
  private readonly sandboxPerChat: boolean;
  private readonly pluginDirs: string[];
  private readonly enabledPlugins: Record<string, boolean> | undefined;
  private readonly agentProvider: string;
  private readonly agentProviderConfig: Record<string, unknown> | undefined;
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
  private workspaceResources: Map<string, { socketPath: string; workspacePath: string; socketServer: WhatSoupSocketServer | null; mediaBridge: MediaBridge | null }> = new Map();
  private turnQueue: TurnQueue;
  private currentTurnChatJid: string | null = null;

  // NOTE: turnHadVisibleOutput is only tracked in the non-per-chat handleEvent path.
  // Spawn-per-turn providers route through handleEventWithContext which does not
  // use this flag. The "(no response)" fallback only exists in handleEvent.
  private turnHadVisibleOutput = false;
  private turnChain: Promise<void> = Promise.resolve();

  // Crash tracking — survives session map deletions for accurate health reporting.
  // Incremented on every crash, decremented on successful session spawn (capped at 0).
  // lastCrashAt gives operators context to interpret a stale count.
  private recentCrashCount = 0;
  private lastCrashAt: string | null = null;

  /** Maps toolId → toolName for the current turn, so tool_result errors can reference the tool. */
  private activeToolNames = new Map<string, string>();

  private recordCrash(): void {
    this.recentCrashCount++;
    this.lastCrashAt = new Date().toISOString();
  }

  // Tracks inbound seq for the current turn (single/shared mode)
  private currentInboundSeq: number | undefined;
  // Tracks inbound seq per chat key (per_chat mode — chats are concurrent)
  // FIFO queue: push on dispatch, shift on result to prevent race when turns overlap.
  private perChatInboundSeqQueue: Map<string, number[]> = new Map();

  // Startup notification deferred until after WA connects
  private pendingStartupMessage: { chatJid: string; text: string } | null = null;

  // Tracks the most recent turn text per chat (keyed by workspaceKey or chatJid).
  // Used to replay a message when session resume fails and the turn was lost.
  private pendingTurnText: Map<string, string> = new Map();

  // Set of mapKeys for which handleResumeFailed is currently managing context
  // injection + pending-turn replay. Used to suppress context injection in any
  // concurrent sendTurnToSession call for the same chat, preventing double injection.
  private resumeFailedHandling: Set<string> = new Set();

  // Global socket server (non-sandboxPerChat mode)
  private globalSocketServer: WhatSoupSocketServer | null = null;

  private durability: DurabilityEngine | null = null;

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
    this.instructionsPath = options?.instructionsPath;
    this.sandbox = options?.sandbox;
    this.model = options?.model;
    this.sandboxPerChat = options?.sandboxPerChat ?? false;
    this.pluginDirs = options?.pluginDirs ?? [];
    this.enabledPlugins = options?.enabledPlugins;
    this.agentProvider = config.agentProvider;
    this.agentProviderConfig = config.agentProviderConfig;

    this.registry = new ToolRegistry();
    this.registerAllTools();

    this.turnQueue = new TurnQueue();
    this.turnQueue.setProcessor((turn) => this.processTurn(turn));
  }

  private registerAllTools(): void {
    registerAllTools(this.registry, this.messenger as ConnectionManager, this.db);
  }

  /** Create and configure an OutboundQueue with shared settings (durability, toolUpdateMode). */
  private createOutboundQueue(chatJid: string): OutboundQueue {
    const q = new OutboundQueue(this.messenger, chatJid);
    if (this.durability) q.setDurability(this.durability);
    q.setToolUpdateMode(config.toolUpdateMode);
    return q;
  }

  setDurability(engine: DurabilityEngine): void {
    this.durability = engine;
    this.registry.setDurability(engine);
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

    // Shared-mode outbound queues (keyed by raw chatJid)
    for (const [key, q] of this.outboundQueues) {
      try {
        if (toConversationKey(key) === conversationKey) {
          q.updateDeliveryJid(newJid);
        }
      } catch (err) {
        log.debug({ err, key }, 'JID parsing failed during session resume — skipping');
      }
    }

    // Single-mode queue
    if (this.queue) {
      this.queue.updateDeliveryJid(newJid);
    }
  }

  async start(): Promise<void> {
    ensureAgentSchema(this.db);

    // Write sandbox policy and hook settings when sandbox config is present
    if (this.sandbox) {
      const cwd = this.cwd ?? homedir();
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
    }

    // Ensure settings.json has a permissions block — safety net for instances
    // without sandbox config. Prevents Claude Code's "sensitive file" blocks.
    {
      const cwd = this.cwd ?? homedir();
      const claudeDir = join(cwd, '.claude');
      ensurePermissionsSettings(claudeDir, 'agent', this.enabledPlugins);
    }

    // Start global WhatSoup socket server (non-sandboxPerChat mode only)
    if (!this.sandboxPerChat) {
      const agentCwd = this.cwd ?? homedir();
      const claudeDir = join(agentCwd, '.claude');
      mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
      const socketPath = join(claudeDir, 'whatsoup.sock');

      const globalSession: SessionContext = { tier: 'global' };
      this.globalSocketServer = new WhatSoupSocketServer(socketPath, this.registry, globalSession);
      this.globalSocketServer.start();
      log.info({ socketPath }, 'global WhatSoup socket server started');

      // Write .mcp.json so Claude Code discovers the whatsoup MCP server
      const mcpServerScript = resolve(
        new URL('.', import.meta.url).pathname,
        '../../../deploy/mcp/whatsoup-proxy.ts',
      );
      const mcpConfig = generateMcpConfigFile('claude-cli', socketPath, mcpServerScript);
      writeFileSync(join(agentCwd, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));
      log.info({ agentCwd }, 'wrote .mcp.json for whatsoup');
    }

    // sandboxPerChat: backfill workspace keys for legacy rows
    if (this.sandboxPerChat) {
      backfillWorkspaceKeys(this.db, this.cwd ?? homedir());
    }

    // Sweep stale sessions for all per_chat modes (including Q's non-sandboxed per_chat).
    // Cross-references agent_sessions with session_checkpoints to safely identify which
    // processes to keep and which to reap. Only kills PIDs verified as owned children.
    if (this.sessionScope === 'per_chat' || this.sandboxPerChat) {
      const classified = classifyActiveSessions(this.db, this.durability!);
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

    // per_chat (non-sandboxed): proactively resume sessions that were active or suspended
    // (graceful shutdown) when we last ran. This lets agents pick up mid-conversation instead
    // of waiting for the user to send a message after a service restart.
    // sandboxPerChat is excluded — its resume path requires workspace provisioning which happens lazily.
    if (this.sessionScope === 'per_chat' && !this.sandboxPerChat && this.durability) {
      const resumableCheckpoints = this.durability.getResumableCheckpoints();
      for (const cp of resumableCheckpoints) {
        const full = this.durability.getSessionCheckpoint(cp.conversation_key);
        if (!full?.session_id) continue;

        // Derive chatJid from conversation_key — for DMs, append @lid; for groups, use as-is
        const chatJid = cp.conversation_key.includes('_at_')
          ? cp.conversation_key.replace('_at_', '@')
          : `${cp.conversation_key}@lid`;

        if (this.chatSessions.has(chatJid)) continue; // already created by sweep or prior iteration

        log.info({ conversationKey: cp.conversation_key, sessionId: full.session_id, chatJid }, 'proactive per_chat resume on startup');

        // Create session + queue (same as ensureSessionAndQueueSync but with resume)
        const session = this.createSessionManager({
          chatJid,
          cwd: this.cwd,
          onEvent: (event) => this.handleEventPerChat(chatJid, event),
          onCrash: (info) => this.handlePerChatCrash(chatJid, chatJid, info),
          notifyUser: (msg) => {
            const s = this.chatSessions.get(chatJid);
            if (s && !s.getStatus().active) {
              this.chatSessions.delete(chatJid);
              this.chatQueues.get(chatJid)?.abortTurn();
              this.chatQueues.delete(chatJid);
            }
            this.handleCrashNotify(msg, chatJid);
          },
        });
        this.chatSessions.set(chatJid, session);
        const perChatQ = this.createOutboundQueue(chatJid);
        this.chatQueues.set(chatJid, perChatQ);

        // Attempt resume, then send a continuation turn so the agent picks up
        // where it left off without requiring the user to send "proceed".
        session.spawnSession(full.session_id).then(async () => {
          // Small delay to let the init event propagate (confirms resume succeeded)
          await new Promise(r => setTimeout(r, 1_000));
          if (!session.getStatus().active) return; // resume failed, onResumeFailed handles it
          try {
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
    if (prior?.session_id && prior?.chat_jid) {
      // Capture narrowed values before closures — TypeScript does not propagate
      // if-guard narrowing into lambdas, so prior.chat_jid inside the closure
      // would remain typed as string | null even though we've checked it.
      const resumeChatJid: string = prior.chat_jid;
      const resumeSessionId: string = prior.session_id;

      log.info({ sessionId: resumeSessionId, chatJid: resumeChatJid }, 'resuming prior session');
      this.activeChatJid = resumeChatJid;
      this.session = this.createSessionManager({
        chatJid: resumeChatJid,
        cwd: this.cwd,
        onEvent: (event) => this.handleEvent(event),
        onResumeFailed: () => this.handleResumeFailed(resumeChatJid),
        onCrash: (info) => {
          this.recordCrash();
          this.getActiveQueue()?.abortTurn();
          this.turnHadVisibleOutput = false;
          // Mark inbound event failed so it doesn't stay stuck in processing
          if (this.durability && this.currentInboundSeq !== undefined) {
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

      if (this.shared) {
        const q = this.createOutboundQueue(resumeChatJid);
        this.outboundQueues.set(resumeChatJid, q);
      } else {
        const q = this.createOutboundQueue(resumeChatJid);
        this.queue = q;
      }

      await this.session.spawnSession(resumeSessionId, prior.id);

      // Defer notification until after WA connects (sending here causes a fatal crash)
      const age = formatAge(prior.started_at);
      this.pendingStartupMessage = {
        chatJid: resumeChatJid,
        text: `_Resuming session_ from *${age}*. Send a message to continue, or /new to start fresh.`,
      };
    }

    // Register emit_heal_result MCP tool (once, for control-plane repair completion).
    // Only on non-sandboxed instances (Q) — sandboxed instances (Loops) are repair targets, not repairers.
    if (config.controlPeers.size > 0 && !this.sandboxPerChat && !this.sandbox) {
      this.registry.register({
        name: 'emit_heal_result',
        description: 'Signal completion of a repair cycle. Only callable during an active repair session.',
        schema: EmitHealResultSchema,
        scope: 'global',
        targetMode: 'caller-supplied',
        replayPolicy: 'unsafe',
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
            }));
          }

          return { sent: true, reportId: parsed.reportId, result: parsed.result };
        },
      });
    }

    log.info('AgentRuntime started');
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
    this.turnChain = this.turnChain
      .then(() => this._handleMessageInner(msg))
      .catch((err) => {
        log.error(
          { err, messageId: msg.messageId, chatJid: msg.chatJid },
          'unhandled error in message processing',
        );
        // Mark inbound event as failed so it doesn't stay stuck in 'processing'
        if (this.durability && msg.inboundSeq !== undefined) {
          this.durability.markInboundFailed(msg.inboundSeq);
        }
        // Notify user of failure
        this.sendDirect(msg.chatJid, 'Something went wrong processing that message. Try again?');
      });
  }

  private async _handleMessageInner(msg: IncomingMessage): Promise<void> {
    let content = msg.content;
    const chatJid = msg.chatJid;
    if (this.sandboxPerChat) {
      await this.ensureSessionAndQueue(chatJid);
      // Relocate media files from global temp dir into user's workspace
      // so the agent can read them within its sandbox-allowed paths.
      if (content) {
        const { workspacePath } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);
        content = relocateMediaToWorkspace(content, workspacePath);
        msg.content = content;
      }
    } else {
      this.ensureSessionAndQueueSync(chatJid);
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
            ? (this.sandboxPerChat
                ? this.chatSessions.get(chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey)
                : this.chatSessions.get(chatJid))
            : this.session;
          // Abort the old queue — clears timers and typing heartbeat before discarding.
          // Use getQueueForChat (map-based) instead of getActiveQueue (shared-field-based).
          this.getQueueForChat(chatJid)?.abortTurn();
          // Create a fresh queue before spawning so stale output from the old session
          // can never leak into the new session's delivery channel.
          if (this.sandboxPerChat && this.sessionScope === 'per_chat') {
            // sandboxPerChat: replace session+queue keyed by workspaceKey; workspace resources survive
            const { workspaceKey } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);
            this.chatSessions.delete(workspaceKey);
            const q1 = this.createOutboundQueue(chatJid);
            this.chatQueues.set(workspaceKey, q1);
          } else if (this.shared) {
            const q2 = this.createOutboundQueue(chatJid);
            this.outboundQueues.set(chatJid, q2);
          } else if (this.sessionScope === 'per_chat') {
            // non-sandboxPerChat per_chat: keyed by raw chatJid
            this.chatSessions.delete(chatJid);
            const q3 = this.createOutboundQueue(chatJid);
            this.chatQueues.set(chatJid, q3);
          } else {
            const q4 = this.createOutboundQueue(chatJid);
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
            ? (this.sandboxPerChat
                ? this.chatSessions.get(chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey)
                : this.chatSessions.get(chatJid))
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
            '*/help* — show this help\n' +
            '_Any other message is forwarded to Claude Code._\n' +
            'Other slash commands (e.g. `/compact`) are passed directly to Claude Code.';
          this.sendDirect(chatJid, helpText);
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
      // per_chat: enqueue inbound seq keyed by chat before sending turn
      const mapKey = this.sandboxPerChat
        ? chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey
        : chatJid;
      const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
      if (msg.inboundSeq !== undefined) seqQueue.push(msg.inboundSeq);
      this.perChatInboundSeqQueue.set(mapKey, seqQueue);
      this.getQueueForChat(chatJid)?.setInboundSeq(msg.inboundSeq);
      await this.sendTurnPerChat(chatJid, text);
    } else {
      // single mode: store inbound seq on runtime + queue
      this.currentInboundSeq = msg.inboundSeq;
      this.queue?.setInboundSeq(msg.inboundSeq);
      await this.sendTurnNonShared(chatJid, text);
    }
  }

  /**
   * Process a single turn from the TurnQueue (shared mode).
   * Sets currentTurnChatJid so event routing knows where to send output.
   */
  private async processTurn(turn: QueuedTurn): Promise<void> {
    const { chatJid, senderJid, senderName, text, isGroup } = turn;

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

    // Thread inbound seq into the outbound queue so ops can link back
    this.getActiveQueue()?.setInboundSeq(turn.inboundSeq);

    try {
      await this.session!.sendTurn(prefixedText);
    } catch (err) {
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('STDIN_WRITE_TIMEOUT')) {
        log.warn({ chatJid }, 'stdin write timed out — notifying user');
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
  ): Promise<void> {
    // Derive mapKey for sandboxPerChat coordination (used to suppress duplicate
    // context injection when handleResumeFailed is already handling recovery).
    const mapKeyForChat = this.sandboxPerChat
      ? chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey
      : undefined;

    const wasInactive = !session.getStatus().active;
    if (wasInactive) {
      // Shut down old session first to prevent zombie processes.
      // Without this, spawnSession() overwrites this.child, orphaning the old
      // process and its DB row. Mirrors handleNew() pattern.
      await session.shutdown();
      await session.spawnSession();
      // Successful spawn after a crash — decay the crash counter
      if (this.recentCrashCount > 0) this.recentCrashCount--;

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
    const queue = this.getQueueForChat(chatJid);
    if (queue) queue.indicateTyping();

    try {
      await session.sendTurn(text);
    } catch (err) {
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('STDIN_WRITE_TIMEOUT')) {
        log.warn({ chatJid }, 'stdin write timed out — notifying user');
        this.sendDirect(chatJid, 'Agent is not responding — try /new to start a fresh session.');
      } else {
        throw err;
      }
    }
  }

  /**
   * Send a turn in non-shared (legacy) mode.
   */
  private async sendTurnNonShared(chatJid: string, text: string): Promise<void> {
    await this.sendTurnToSession(this.session!, chatJid, text);
  }

  /**
   * Send a turn in per_chat mode — each chat has its own session.
   * Serializes within a chat but runs concurrently across chats.
   */
  private async sendTurnPerChat(chatJid: string, text: string): Promise<void> {
    // When sandboxPerChat=true maps are keyed by workspaceKey, not raw chatJid
    const mapKey = this.sandboxPerChat
      ? chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey
      : chatJid;

    // Store the turn text so it can be replayed if a session resume fails
    // before the agent can process it.
    this.pendingTurnText.set(mapKey, text);

    const session = this.chatSessions.get(mapKey);
    if (!session) {
      log.warn({ chatJid, mapKey }, 'no active session for chat — spawning new session');
      // Instead of silently dropping, initialize session and queue so message is handled
      if (this.sandboxPerChat) {
        await this.ensureSessionAndQueue(chatJid);
      } else {
        this.ensureSessionAndQueueSync(chatJid);
      }
      const retrySession = this.chatSessions.get(mapKey);
      if (!retrySession) {
        log.error({ chatJid, mapKey }, 'failed to create session for chat — message dropped');
        this.pendingTurnText.delete(mapKey);
        if (this.durability && this.perChatInboundSeqQueue.get(mapKey)?.[0] !== undefined) {
          this.durability.markInboundFailed(this.perChatInboundSeqQueue.get(mapKey)![0]);
        }
        this.sendDirect(chatJid, 'Something went wrong starting a session. Try sending your message again.');
        return;
      }
      await this.sendTurnToSession(retrySession, chatJid, text);
      return;
    }
    await this.sendTurnToSession(session, chatJid, text);
  }

  /**
   * Handle events from a per_chat session — routes to that chat's outbound queue.
   * Resolves queue and session locally from the mapKey to avoid mutating shared
   * instance fields that another concurrent chat could overwrite.
   */
  private handleEventPerChat(mapKey: string, event: AgentEvent): void {
    const queue = this.chatQueues.get(mapKey);
    if (!queue) return;
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
    this.handleEventWithContext(event, queue, session, conversationKey, inboundSeq);
  }

  /**
   * Core event handler that operates on explicitly-passed queue and session
   * references rather than shared instance fields. Used by handleEventPerChat
   * so concurrent per_chat events do not overwrite each other's context.
   */
  private handleEventWithContext(event: AgentEvent, queue: IOutboundQueue, session: SessionManager | null, conversationKey?: string, inboundSeq?: number): void {
    switch (event.type) {
      case 'init':
        log.debug({ sessionId: event.sessionId }, 'session init');
        break;

      case 'assistant_text':
        session?.tickWatchdog();
        queue.enqueueText(event.text);
        break;

      case 'tool_use':
        session?.trackToolStart(event.toolId);
        session?.tickWatchdog();
        this.activeToolNames.set(event.toolId, event.toolName);
        queue.enqueueToolUpdate(buildToolUpdate(event.toolName, event.toolInput ?? {}));
        break;

      case 'compact_boundary':
        session?.tickWatchdog();
        queue.indicateTyping();
        queue.enqueueText(
          'Context compacted — older details summarized. Restate any important context I should carry forward.',
        );
        break;

      case 'tool_result':
        session?.trackToolEnd(event.toolId);
        session?.tickWatchdog();
        if (event.isError) {
          const toolName = this.activeToolNames.get(event.toolId) ?? 'unknown';
          const errorPreview = event.content.length > 200 ? event.content.slice(0, 200) + '...' : event.content;
          log.warn({ toolId: event.toolId, toolName, error: errorPreview }, 'tool error reported by agent');
          queue.enqueueToolUpdate(classifyToolError(toolName, event.content));
        }
        this.activeToolNames.delete(event.toolId);
        break;

      case 'result':
        session?.clearTurnWatchdog();
        this.activeToolNames.clear();
        if (event.text) {
          queue.enqueueResultText(event.text);
        }
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
          const rowId = session?.getDbRowId() ?? null;
          if (rowId !== null) {
            accumulateSessionTokens(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
          }
        }
        if (this.durability && conversationKey) {
          this.durability.upsertSessionCheckpoint(conversationKey, {
            activeTurnId: null,
            ...(inboundSeq !== undefined && { lastInboundSeq: inboundSeq }),
            ...(queue.getLastOpId() !== undefined && { lastFlushedOutboundId: queue.getLastOpId() }),
          });
        }
        if (this.durability && inboundSeq !== undefined) {
          this.durability.completeInbound(inboundSeq, 'response_sent');
        }
        // Defense-in-depth: mark last op terminal so echo auto-complete fires if
        // the process crashes after send but before completeInbound runs.
        queue.markLastTerminal();
        queue.flush().catch((err) => log.error({ err }, 'flush failed'));
        break;

      case 'token_usage':
        // Record token usage without triggering turn completion.
        // Codex emits thread/tokenUsage/updated mid-turn; the actual turn
        // completion comes from turn/completed → type:'result'.
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
          const rowId = session?.getDbRowId() ?? null;
          if (rowId !== null) {
            accumulateSessionTokens(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
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
      if (this.recentCrashCount > 0 && healthStatus === 'healthy') {
        healthStatus = 'degraded';
      }
      return {
        status: healthStatus,
        details: {
          activeSessions,
          lastSessionStatus,
          lastSessionStartedAt,
          sessionCount: sessions.length,
          recentCrashes: this.recentCrashCount,
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

    const syntheticJid = 'control@heal.internal';

    // Use a workspace at <cwd>/heal/ for the control session
    const controlCwd = this.cwd ? join(this.cwd, 'heal') : join(homedir(), 'heal');
    mkdirSync(controlCwd, { recursive: true, mode: 0o700 });

    // Create or reuse control session
    if (!this.controlSession) {
      this.controlSession = this.createSessionManager({
        chatJid: syntheticJid,
        cwd: controlCwd,
        onEvent: (event) => this.handleEventPerChat('control@heal.internal', event),
        onCrash: (_info) => {
          log.warn('control session crashed');
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
      this.chatQueues.set('control@heal.internal', controlQueue);
      this.chatSessions.set('control@heal.internal', this.controlSession);
    }

    // Spawn session if not active
    if (!this.controlSession.getStatus().active) {
      await this.controlSession.spawnSession();
    }

    // Format the turn
    const turn = `[REPAIR REQUEST — report_id: ${reportId}]\n${payload}`;

    try {
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
          }));
        }
      }, CONTROL_SESSION_TIMEOUT_MS);
    } catch (err) {
      log.error({ err, reportId }, 'failed to send repair turn to control session');
      if (this.controlSessionTimeout) {
        clearTimeout(this.controlSessionTimeout);
        this.controlSessionTimeout = null;
      }
      this.activeControlReportId = null;
    }
  }

  /** Return the ControlQueue for the control session, or null if none exists. */
  getControlQueue(): ControlQueue | null {
    return (this.chatQueues.get('control@heal.internal') as ControlQueue) ?? null;
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
    log.info('AgentRuntime shutting down');

    // Shutdown per_chat sessions
    if (this.sessionScope === 'per_chat') {
      for (const [chatJid, session] of this.chatSessions) {
        try { await session.shutdown(); } catch (err) { log.warn({ err, chatJid }, 'per_chat session shutdown failed'); }
      }
      for (const [chatJid, queue] of this.chatQueues) {
        try { await queue.shutdown(); } catch (err) { log.warn({ err, chatJid }, 'per_chat queue shutdown failed'); }
      }
      this.chatSessions.clear();
      this.chatQueues.clear();
    }

    if (this.session && this.sessionScope !== 'per_chat') await this.session.shutdown();

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

    // Stop global socket server
    if (this.globalSocketServer) {
      this.globalSocketServer.stop();
      this.globalSocketServer = null;
    }

    // Stop workspace-scoped socket servers and media bridges (sandboxPerChat)
    for (const [, res] of this.workspaceResources) {
      if (res.socketServer) res.socketServer.stop();
      if (res.mediaBridge) res.mediaBridge();  // MediaBridge handle is a cleanup function
    }
    this.workspaceResources.clear();

    log.info('AgentRuntime shut down');
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

  /**
   * Get the outbound queue for a specific chatJid (shared mode).
   * Falls back to single queue (non-shared mode).
   */
  private getQueueForChat(chatJid: string): IOutboundQueue | null {
    if (this.sessionScope === 'per_chat') {
      if (this.sandboxPerChat) {
        const { workspaceKey } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);
        return this.chatQueues.get(workspaceKey) ?? null;
      }
      return this.chatQueues.get(chatJid) ?? null;
    }
    if (this.shared) {
      return this.outboundQueues.get(chatJid) ?? null;
    }
    return this.queue;
  }

  private sendDirect(chatJid: string, text: string): void {
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
    onEvent: (event: AgentEvent) => void;
    onCrash: (info: SessionCrashInfo) => void;
    notifyUser: (msg: string) => void;
    onResumeFailed?: () => void;
  }): SessionManager {
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
      instructionsPath: this.instructionsPath,
      model: this.model,
      pluginDirs: this.pluginDirs,
      provider: this.agentProvider,
      providerConfig: this.agentProviderConfig,
    });
    if (this.durability) {
      session.setDurability(this.durability);
    }
    return session;
  }

  /**
   * Async variant of session/queue initialization for sandboxPerChat mode.
   * Called only when sandboxPerChat=true so the async/await overhead doesn't
   * affect the microtask ordering of existing non-sandboxPerChat tests.
   */
  private async ensureSessionAndQueue(chatJid: string): Promise<void> {
    // sandboxPerChat: each chat gets an isolated workspace; map keyed by workspaceKey
    const { workspaceKey, workspacePath } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);

    if (!this.chatSessions.has(workspaceKey)) {
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

        this.workspaceResources.set(workspaceKey, { socketPath, workspacePath, socketServer, mediaBridge });
      }

      // Check for resumable session
      const resumable = getResumableSessionForChat(this.db, workspaceKey);

      // Create SessionManager with workspace-scoped cwd
      const session = this.createSessionManager({
        chatJid,
        cwd: workspacePath,  // scoped cwd instead of this.cwd
        onEvent: (event) => this.handleEventPerChat(workspaceKey, event),
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
          }
          this.handleCrashNotify(msg, chatJid);
        },
        onResumeFailed: () => this.handleResumeFailed(chatJid),
      });
      this.chatSessions.set(workspaceKey, session);
      const chatQ = this.createOutboundQueue(chatJid);
      this.chatQueues.set(workspaceKey, chatQ);

      // Spawn with resume if available — fall back to fresh session if resume fails
      if (resumable) {
        try {
          await session.spawnSession(resumable.session_id, resumable.id);
        } catch (err) {
          log.warn({ err, workspaceKey, sessionId: resumable.session_id }, 'resume threw — spawning fresh session');
          await session.spawnSession();
        }
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

    // sandboxPerChat: do NOT set this.session/this.queue shared fields.
    // All per_chat code paths look up from chatSessions/chatQueues maps directly.
  }

  /**
   * Synchronous session/queue initialization for non-sandboxPerChat mode.
   * Kept synchronous to preserve microtask ordering in existing code paths.
   */
  private ensureSessionAndQueueSync(chatJid: string): void {
    if (this.sessionScope === 'per_chat') {
      // per_chat: independent session + queue per raw chatJid
      if (!this.chatSessions.has(chatJid)) {
        const session = this.createSessionManager({
          chatJid,
          cwd: this.cwd,
          onEvent: (event) => this.handleEventPerChat(chatJid, event),
          onCrash: (info) => this.handlePerChatCrash(chatJid, chatJid, info),
          notifyUser: (msg) => {
            // Only remove session from map if it's actually dead (crash/exit).
            // Watchdog warnings fire on ACTIVE sessions — removing those breaks
            // event routing and causes cascading false-idle notifications.
            const s = this.chatSessions.get(chatJid);
            if (s && !s.getStatus().active) {
              this.chatSessions.delete(chatJid);
              this.chatQueues.get(chatJid)?.abortTurn();
              this.chatQueues.delete(chatJid);
            }
            this.handleCrashNotify(msg, chatJid);
          },
        });
        this.chatSessions.set(chatJid, session);
        const perChatQ = this.createOutboundQueue(chatJid);
        this.chatQueues.set(chatJid, perChatQ);
      }
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
        onEvent: (event) => this.handleEvent(event),
        onCrash: (info) => {
          this.recordCrash();
          this.getActiveQueue()?.abortTurn();
          this.turnHadVisibleOutput = false;
          // Mark inbound event failed so it doesn't stay stuck in processing
          if (this.durability && this.currentInboundSeq !== undefined) {
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
      if (this.shared) {
        this.ensureOutboundQueue(chatJid);
      } else {
        const singletonQ = this.createOutboundQueue(chatJid);
        this.queue = singletonQ;
      }
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
      const q = this.createOutboundQueue(chatJid);
      this.outboundQueues.set(chatJid, q);
    }
  }

  private handlePerChatCrash(mapKey: string, chatJid?: string, info?: SessionCrashInfo): void {
    this.recordCrash();
    this.chatQueues.get(mapKey)?.abortTurn();
    const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
    const inboundSeq = seqQueue[0];
    if (this.durability && inboundSeq !== undefined) {
      this.durability.markInboundFailed(inboundSeq);
      seqQueue.shift();
    }
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
    if (this.recentCrashCount <= AUTO_RESPAWN_MAX_CRASHES && info?.sessionId) {
      const session = this.chatSessions.get(mapKey);
      if (session) {
        const sessionId = info.sessionId;
        const dbRowId = info.dbRowId;
        log.info({ mapKey, sessionId, attempt: this.recentCrashCount }, 'scheduling auto-respawn');
        setTimeout(() => {
          // Verify the session is still in the map and still inactive
          const current = this.chatSessions.get(mapKey);
          if (!current || current !== session || current.getStatus().active) return;

          log.info({ mapKey, sessionId }, 'auto-respawn: attempting resume');
          session.spawnSession(sessionId, dbRowId ?? undefined).then(async () => {
            await new Promise(r => setTimeout(r, 1_000));
            if (!session.getStatus().active) return;
            clearAlertSource(this.instanceName, 'agent_respawn_failed');
            try {
              await session.sendTurn('[System: session resumed after crash — continue where you left off]');
              log.info({ mapKey }, 'sent continuation turn after auto-respawn');
            } catch (err) {
              log.warn({ err, mapKey }, 'failed to send continuation turn after auto-respawn');
            }
          }).catch((err) => {
            log.warn({ err, mapKey, sessionId }, 'auto-respawn resume failed — will retry on next message');
          });
        }, jitteredDelay(AUTO_RESPAWN_BASE_MS, this.recentCrashCount - 1, AUTO_RESPAWN_MAX_DELAY_MS));
      }
    } else if (this.recentCrashCount > AUTO_RESPAWN_MAX_CRASHES) {
      log.error({ mapKey, crashes: this.recentCrashCount }, 'auto-respawn exhausted — emitting alert');
      emitAlert(
        this.instanceName,
        'agent_respawn_failed',
        `whatsoup@${this.instanceName} agent respawn exhausted (${this.recentCrashCount} crashes)`,
        `Chat: ${mapKey}, Last exit: code=${info?.exitCode ?? '?'} signal=${info?.signal ?? 'none'}`,
      );
    }
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
        }).catch(() => {});
      })
      .catch((err) => {
        if (mapKey) this.resumeFailedHandling.delete(mapKey);
        log.error({ err }, 'failed to spawn fresh session after resume failure');
      });
  }

  private handleEvent(event: AgentEvent): void {
    // Route to current turn's chat in shared mode, or the single queue in non-shared mode
    const queue = this.shared
      ? (this.currentTurnChatJid ? this.outboundQueues.get(this.currentTurnChatJid) ?? null : null)
      : this.queue;

    if (!queue) return;

    switch (event.type) {
      case 'init':
        log.debug({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, sessionId: event.sessionId }, 'session init');
        break;

      case 'assistant_text':
        this.session?.tickWatchdog();
        queue.enqueueText(event.text);
        this.turnHadVisibleOutput = true;
        break;

      case 'tool_use':
        this.session?.trackToolStart(event.toolId);
        this.session?.tickWatchdog();
        this.activeToolNames.set(event.toolId, event.toolName);
        queue.enqueueToolUpdate(buildToolUpdate(event.toolName, event.toolInput ?? {}));
        break;

      // @check CHK-023
      // @traces REQ-005.AC-05
      case 'compact_boundary':
        this.session?.tickWatchdog();
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
        if (event.isError) {
          const toolName = this.activeToolNames.get(event.toolId) ?? 'unknown';
          const errorPreview = event.content.length > 200 ? event.content.slice(0, 200) + '...' : event.content;
          log.warn({
            chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
            toolId: event.toolId,
            toolName,
            error: errorPreview,
          }, 'tool error reported by agent');
          queue.enqueueToolUpdate(classifyToolError(toolName, event.content));
        }
        this.activeToolNames.delete(event.toolId);
        break;

      case 'result':
        this.session?.clearTurnWatchdog();
        this.activeToolNames.clear();
        // Render result.text if present (e.g. terminal context-limit errors)
        if (event.text) {
          queue.enqueueResultText(event.text);
          this.turnHadVisibleOutput = true;
        }
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
          const rowId = this.session?.getDbRowId() ?? null;
          if (rowId !== null) {
            accumulateSessionTokens(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
          }
        }
        // If nothing visible was emitted this turn, send an explicit fallback
        if (!this.turnHadVisibleOutput) {
          queue.enqueueText('_(no response)_');
        }
        this.turnHadVisibleOutput = false;
        this.currentTurnChatJid = null;
        if (this.durability && this.activeChatJid) {
          const conversationKey = toConversationKey(this.activeChatJid);
          this.durability.upsertSessionCheckpoint(conversationKey, {
            activeTurnId: null,
            ...(this.currentInboundSeq !== undefined && { lastInboundSeq: this.currentInboundSeq }),
            ...(queue.getLastOpId() !== undefined && { lastFlushedOutboundId: queue.getLastOpId() }),
          });
        }
        if (this.durability && this.currentInboundSeq !== undefined) {
          this.durability.completeInbound(this.currentInboundSeq, 'response_sent');
          this.currentInboundSeq = undefined;
        }
        // Defense-in-depth: mark last op terminal so echo auto-complete fires if
        // the process crashes after send but before completeInbound runs.
        queue.markLastTerminal();
        queue.flush().catch((err) => log.error({ err }, 'flush failed'));
        break;

      case 'token_usage':
        // Record token usage without triggering turn completion (non-per-chat path).
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
          const rowId = this.session?.getDbRowId() ?? null;
          if (rowId !== null) {
            accumulateSessionTokens(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
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
}
