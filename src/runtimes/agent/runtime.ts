// src/runtimes/agent/runtime.ts
// AgentRuntime implements the Runtime interface, tying all agent components together.

import type { Runtime } from '../types.ts';
import type { IncomingMessage, Messenger, RuntimeHealth } from '../../core/types.ts';
import type { Database } from '../../core/database.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import type { AgentEvent } from './stream-parser.ts';
import { createChildLogger } from '../../logger.ts';
import {
  ensureAgentSchema,
  getActiveSession,
  backfillWorkspaceKeys,
  markOrphaned,
  sweepOrphanedSessions,
  getResumableSessionForChat,
} from './session-db.ts';
import { chatJidToWorkspace, provisionWorkspace, writeSandboxArtifacts } from '../../core/workspace.ts';
import { SessionManager, formatAge } from './session.ts';
import { OutboundQueue, type ToolUpdate, type ToolCategory } from './outbound-queue.ts';
import { classifyInput } from './commands.ts';
import { getRecentMessages } from '../../core/messages.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { TurnQueue, type QueuedTurn } from './turn-queue.ts';
import { config } from '../../config.ts';
import { extractPhone } from '../../core/access-list.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ToolRegistry } from '../../mcp/registry.ts';
import { WhatSoupSocketServer } from '../../mcp/socket-server.ts';
import type { SessionContext, ToolDeclaration } from '../../mcp/types.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import { registerMessagingTools } from '../../mcp/tools/messaging.ts';
import { registerMediaTools } from '../../mcp/tools/media.ts';
import { registerChatManagementTools } from '../../mcp/tools/chat-management.ts';
import { registerChatOperationTools } from '../../mcp/tools/chat-operations.ts';
import { registerSearchTools } from '../../mcp/tools/search.ts';
import { registerGroupTools } from '../../mcp/tools/groups.ts';
import { registerCommunityTools } from '../../mcp/tools/community.ts';
import { registerNewsletterTools } from '../../mcp/tools/newsletter.ts';
import { registerBusinessTools } from '../../mcp/tools/business.ts';
import { registerAdvancedTools } from '../../mcp/tools/advanced.ts';
import { registerCallTools } from '../../mcp/tools/calls.ts';
import { registerPresenceTools } from '../../mcp/tools/presence.ts';
import { registerProfileTools } from '../../mcp/tools/profile.ts';
import { startMediaBridge, setMediaBridgeChat, type MediaBridge } from './media-bridge.ts';

const log = createChildLogger('agent-runtime');

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
}

/**
 * Build a structured ToolUpdate from a tool_use event.
 * detail is capped at 80 visible chars.
 * Exported for unit testing.
 */
export function buildToolUpdate(toolName: string, input: Record<string, unknown>): ToolUpdate {
  const str = (key: string): string => String(input[key] ?? '');

  /** Make a path repo-relative and middle-truncate to 80 chars. */
  function shortPath(p: string): string {
    const rel = p.replace(/^\/home\/q\/LAB\/WhatSoup\//, '');
    if (rel.length <= 80) return rel;
    const half = 38;
    return rel.slice(0, half) + '…' + rel.slice(-(80 - half - 1));
  }

  /** End-truncate a string to 80 chars. */
  function trunc(s: string): string {
    return s.length <= 80 ? s : s.slice(0, 79) + '…';
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
    case 'ToolSearch':
      return { category: 'skill', detail: `\`${trunc(str('query') || 'tools')}\`` };
    default: {
      // MCP tools: "mcp__<server>__<tool-name>" → human-readable monospace tool name
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const rawTool = parts[parts.length - 1] ?? toolName;
        const tool = rawTool.replace(/[-_]/g, ' ');
        return { category: 'other', detail: `\`${trunc(tool)}\`` };
      }
      return { category: 'other', detail: `\`${trunc(toolName)}\`` };
    }
  }
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
  private readonly registry: ToolRegistry;

  // single mode: one session, one queue
  private session: SessionManager | null = null;
  private queue: OutboundQueue | null = null;
  private activeChatJid: string | null = null;

  // shared mode: single session, per-chat outbound queues + global turn queue
  private outboundQueues: Map<string, OutboundQueue> = new Map();

  // per_chat mode: independent session + queue per chatJid
  // When sandboxPerChat=true, maps are keyed by workspaceKey; when false, keyed by raw chatJid.
  private chatSessions: Map<string, SessionManager> = new Map();
  private chatQueues: Map<string, OutboundQueue> = new Map();
  private workspaceResources: Map<string, { socketPath: string; workspacePath: string; socketServer: WhatSoupSocketServer | null; mediaBridge: MediaBridge | null }> = new Map();
  private turnQueue: TurnQueue;
  private currentTurnChatJid: string | null = null;

  private turnHadVisibleOutput = false;
  private turnChain: Promise<void> = Promise.resolve();

  // Crash tracking — survives session map deletions for accurate health reporting.
  // Incremented on every crash, decremented on successful session spawn (capped at 0).
  // lastCrashAt gives operators context to interpret a stale count.
  private recentCrashCount = 0;
  private lastCrashAt: string | null = null;

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

  // Global socket server (non-sandboxPerChat mode)
  private globalSocketServer: WhatSoupSocketServer | null = null;

  private durability: DurabilityEngine | null = null;

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

    this.registry = new ToolRegistry();
    this.registerAllTools();

    this.turnQueue = new TurnQueue();
    this.turnQueue.setProcessor((turn) => this.processTurn(turn));
  }

  private registerAllTools(): void {
    const connection = this.messenger as ConnectionManager;
    const getSock = () => connection.getSocket();
    const register = (tool: ToolDeclaration) => {
      try {
        this.registry.register(tool);
      } catch (err) {
        log.error({ err, tool: tool.name }, 'failed to register tool');
      }
    };

    // Messaging & media (take ToolRegistry + deps directly)
    try { registerMessagingTools(this.registry, { connection, db: this.db.raw }); } catch (err) { log.error({ err }, 'registerMessagingTools failed'); }
    try { registerMediaTools(this.registry, { connection }); } catch (err) { log.error({ err }, 'registerMediaTools failed'); }

    // DB-dependent tools
    try { registerChatManagementTools(this.db, getSock, register); } catch (err) { log.error({ err }, 'registerChatManagementTools failed'); }
    try { registerChatOperationTools(this.db, getSock, register); } catch (err) { log.error({ err }, 'registerChatOperationTools failed'); }
    try { registerSearchTools(this.db, register); } catch (err) { log.error({ err }, 'registerSearchTools failed'); }

    // Socket-only tools
    try { registerGroupTools(getSock, register); } catch (err) { log.error({ err }, 'registerGroupTools failed'); }
    try { registerCommunityTools(getSock, register); } catch (err) { log.error({ err }, 'registerCommunityTools failed'); }
    try { registerNewsletterTools(getSock, register); } catch (err) { log.error({ err }, 'registerNewsletterTools failed'); }
    try { registerBusinessTools(getSock, register); } catch (err) { log.error({ err }, 'registerBusinessTools failed'); }
    try { registerAdvancedTools(getSock, register, this.db); } catch (err) { log.error({ err }, 'registerAdvancedTools failed'); }
    try { registerCallTools(getSock, register); } catch (err) { log.error({ err }, 'registerCallTools failed'); }
    try { registerProfileTools(getSock, this.db, register); } catch (err) { log.error({ err }, 'registerProfileTools failed'); }

    // Presence needs the shared presenceCache from ConnectionManager
    try { registerPresenceTools(getSock, connection.presenceCache, register); } catch (err) { log.error({ err }, 'registerPresenceTools failed'); }

    log.info({ toolCount: this.registry.listTools({ tier: 'global' }).length }, 'all tools registered');
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
      mkdirSync(claudeDir, { recursive: true });

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

    // Start global WhatSoup socket server (non-sandboxPerChat mode only)
    if (!this.sandboxPerChat) {
      const agentCwd = this.cwd ?? homedir();
      const claudeDir = join(agentCwd, '.claude');
      mkdirSync(claudeDir, { recursive: true });
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
      const mcpConfig = {
        mcpServers: {
          'whatsoup': {
            command: 'node',
            args: ['--experimental-strip-types', mcpServerScript],
            env: { WHATSOUP_SOCKET: socketPath },
          },
        },
      };
      writeFileSync(join(agentCwd, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));
      log.info({ agentCwd }, 'wrote .mcp.json for whatsoup');
    }

    // sandboxPerChat: backfill workspace keys for legacy rows and sweep orphaned sessions
    if (this.sandboxPerChat) {
      backfillWorkspaceKeys(this.db, this.cwd ?? homedir());
      const activeSessions = sweepOrphanedSessions(this.db);
      for (const { id, claude_pid } of activeSessions) {
        try { process.kill(claude_pid, 0); } catch { markOrphaned(this.db, id); }
      }
    }

    // Attempt to resume a prior active session.
    // Skipped for per_chat mode (all variants) — resumption is lazy on first message per chat.
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
        onCrash: () => {
          this.recordCrash();
          this.getActiveQueue()?.abortTurn();
          this.turnHadVisibleOutput = false;
          // Mark inbound event failed so it doesn't stay stuck in processing
          if (this.durability && this.currentInboundSeq !== undefined) {
            this.durability.markInboundFailed(this.currentInboundSeq);
            this.currentInboundSeq = undefined;
          }
        },
        notifyUser: (msg) => this.handleCrashNotify(msg),
      });

      if (this.shared) {
        const q = new OutboundQueue(this.messenger, resumeChatJid);
        if (this.durability) q.setDurability(this.durability);
        this.outboundQueues.set(resumeChatJid, q);
      } else {
        const q = new OutboundQueue(this.messenger, resumeChatJid);
        if (this.durability) q.setDurability(this.durability);
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

    log.info('AgentRuntime started');
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const content = msg.content;
    if (content === null || content.trim() === '') return;
    this.turnChain = this.turnChain
      .then(() => this._handleMessageInner(msg))
      .catch(() => {});
  }

  private async _handleMessageInner(msg: IncomingMessage): Promise<void> {
    const content = msg.content;
    const chatJid = msg.chatJid;
    if (this.sandboxPerChat) {
      await this.ensureSessionAndQueue(chatJid);
    } else {
      this.ensureSessionAndQueueSync(chatJid);
    }
    const classified = classifyInput(content as string);

    if (classified.type === 'local') {
      switch (classified.command) {
        case 'new':
          // Shared mode: /new is admin-only
          if (this.shared && !config.adminPhones.has(extractPhone(msg.senderJid))) {
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
            const q1 = new OutboundQueue(this.messenger, chatJid);
            if (this.durability) q1.setDurability(this.durability);
            this.chatQueues.set(workspaceKey, q1);
          } else if (this.shared) {
            const q2 = new OutboundQueue(this.messenger, chatJid);
            if (this.durability) q2.setDurability(this.durability);
            this.outboundQueues.set(chatJid, q2);
          } else if (this.sessionScope === 'per_chat') {
            // non-sandboxPerChat per_chat: keyed by raw chatJid
            this.chatSessions.delete(chatJid);
            const q3 = new OutboundQueue(this.messenger, chatJid);
            if (this.durability) q3.setDurability(this.durability);
            this.chatQueues.set(chatJid, q3);
          } else {
            const q4 = new OutboundQueue(this.messenger, chatJid);
            if (this.durability) q4.setDurability(this.durability);
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
    const phone = extractPhone(senderJid);
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
  private async sendTurnToSession(session: SessionManager, chatJid: string, text: string): Promise<void> {
    if (!session.getStatus().active) {
      await session.spawnSession();
      // Successful spawn after a crash — decay the crash counter
      if (this.recentCrashCount > 0) this.recentCrashCount--;
    }

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
    const session = this.chatSessions.get(mapKey);
    if (!session) {
      log.warn({ chatJid }, 'no active session for chat — message dropped');
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
    }
    this.handleEventWithContext(event, queue, session, conversationKey, inboundSeq);
  }

  /**
   * Core event handler that operates on explicitly-passed queue and session
   * references rather than shared instance fields. Used by handleEventPerChat
   * so concurrent per_chat events do not overwrite each other's context.
   */
  private handleEventWithContext(event: AgentEvent, queue: OutboundQueue, session: SessionManager | null, conversationKey?: string, inboundSeq?: number): void {
    switch (event.type) {
      case 'init':
        log.debug({ sessionId: event.sessionId }, 'session init');
        break;

      case 'assistant_text':
        session?.tickWatchdog();
        queue.enqueueText(event.text);
        break;

      case 'tool_use':
        session?.tickWatchdog();
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
        session?.tickWatchdog();
        if (event.isError) {
          const errorPreview = event.content.length > 200 ? event.content.slice(0, 200) + '...' : event.content;
          log.warn({ toolId: event.toolId, error: errorPreview }, 'tool error reported by agent');
          queue.enqueueToolUpdate({ category: 'error', detail: 'Tool Error' });
        }
        break;

      case 'result':
        session?.clearTurnWatchdog();
        if (event.text) {
          queue.enqueueText(event.text);
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
      for (const s of sessions) {
        if (s.getStatus().active) activeSessions++;
      }
      let healthStatus: RuntimeHealth['status'] = 'healthy';
      if (sessions.length > 0 && activeSessions === 0) {
        healthStatus = 'degraded';
      }
      // Crash counter survives session map deletions — if sessions have been crashing
      // recently but were cleaned up before this health check, recentCrashCount captures it.
      if (this.recentCrashCount > 0 && healthStatus === 'healthy') {
        healthStatus = 'degraded';
      }
      return {
        status: healthStatus,
        details: {
          sessionCount: sessions.length,
          activeSessions,
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
  private getActiveQueue(): OutboundQueue | null {
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
  private getQueueForChat(chatJid: string): OutboundQueue | null {
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
    onCrash: () => void;
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
      const socketPath = provisionWorkspace({
        workspacePath,
        instanceCwd: this.cwd ?? homedir(),
        sandbox: this.sandbox!,
        hookPath,
        mcpServerPath,
        sendMediaServerPath,
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
        onCrash: () => this.handlePerChatCrash(workspaceKey),
        notifyUser: (msg) => {
          this.chatSessions.delete(workspaceKey);
          this.chatQueues.get(workspaceKey)?.abortTurn();
          this.chatQueues.delete(workspaceKey);
          this.handleCrashNotify(msg, chatJid);
        },
      });
      this.chatSessions.set(workspaceKey, session);
      const chatQ = new OutboundQueue(this.messenger, chatJid);
      if (this.durability) chatQ.setDurability(this.durability);
      this.chatQueues.set(workspaceKey, chatQ);

      // Spawn with resume if available
      if (resumable) {
        await session.spawnSession(resumable.session_id, resumable.id);
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
          onCrash: () => this.handlePerChatCrash(chatJid),
          notifyUser: (msg) => {
            // Remove crashed session so next message spawns a fresh one
            this.chatSessions.delete(chatJid);
            this.chatQueues.get(chatJid)?.abortTurn();
            this.chatQueues.delete(chatJid);
            this.handleCrashNotify(msg, chatJid);
          },
        });
        this.chatSessions.set(chatJid, session);
        const perChatQ = new OutboundQueue(this.messenger, chatJid);
        if (this.durability) perChatQ.setDurability(this.durability);
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
        onCrash: () => {
          this.recordCrash();
          this.getActiveQueue()?.abortTurn();
          this.turnHadVisibleOutput = false;
          // Mark inbound event failed so it doesn't stay stuck in processing
          if (this.durability && this.currentInboundSeq !== undefined) {
            this.durability.markInboundFailed(this.currentInboundSeq);
            this.currentInboundSeq = undefined;
          }
        },
        notifyUser: (msg) => this.handleCrashNotify(msg),
      });
      if (this.shared) {
        this.ensureOutboundQueue(chatJid);
      } else {
        const singletonQ = new OutboundQueue(this.messenger, chatJid);
        if (this.durability) singletonQ.setDurability(this.durability);
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
      const q = new OutboundQueue(this.messenger, chatJid);
      if (this.durability) q.setDurability(this.durability);
      this.outboundQueues.set(chatJid, q);
    }
  }

  private handlePerChatCrash(mapKey: string): void {
    this.recordCrash();
    this.chatQueues.get(mapKey)?.abortTurn();
    const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
    const inboundSeq = seqQueue[0];
    if (this.durability && inboundSeq !== undefined) {
      this.durability.markInboundFailed(inboundSeq);
      seqQueue.shift();
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

    // Defensive guard: this callback is only registered in single/shared mode (line ~391),
    // but protect against future refactors that might wire it in per_chat mode where
    // this.session is intentionally null.
    if (!this.session) {
      log.warn({ chatJid }, 'handleResumeFailed: no session — skipping');
      return;
    }

    const msg = '_Previous session expired_ — starting fresh. Send a message to begin.';

    if (this.pendingStartupMessage !== null) {
      // WA not yet connected: override the deferred startup message so the
      // user sees the correct status once the connection comes up.
      this.pendingStartupMessage = { chatJid, text: msg };
    } else {
      // WA already connected: send immediately.
      this.sendDirect(chatJid, msg);
    }

    // Spawn a clean session — no resume ID, user sends first message to activate.
    this.session!
      .spawnSession()
      .then(async () => {
        // context injection wrapped in turnChain to preserve serialization
        this.turnChain = this.turnChain.then(async () => {
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
              await this.session!.sendTurn(`[CONTEXT RECOVERY — prior session expired]\n${lines}`);
            }
          } catch (err) {
            log.warn({ err, chatJid }, 'context recovery failed — starting blank session');
          }
        }).catch(() => {});
      })
      .catch((err) => log.error({ err }, 'failed to spawn fresh session after resume failure'));
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
        this.session?.tickWatchdog();
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
        this.session?.tickWatchdog();
        if (event.isError) {
          const errorPreview = event.content.length > 200 ? event.content.slice(0, 200) + '...' : event.content;
          log.warn({
            chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
            toolId: event.toolId,
            error: errorPreview,
          }, 'tool error reported by agent');
          queue.enqueueToolUpdate({ category: 'error', detail: 'Tool Error' });
        }
        break;

      case 'result':
        this.session?.clearTurnWatchdog();
        // Render result.text if present (e.g. terminal context-limit errors)
        if (event.text) {
          queue.enqueueText(event.text);
          this.turnHadVisibleOutput = true;
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

      case 'ignored':
      case 'unknown':
      case 'parse_error':
        log.debug({ event }, 'ignored/unknown/parse_error event');
        break;
    }
  }
}
