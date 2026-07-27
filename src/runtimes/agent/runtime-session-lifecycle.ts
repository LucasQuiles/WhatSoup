/**
 * Owner-facing session listing, explicit session termination, and the session
 * shutdown batch. AgentRuntime supplies live getters and mutation closures so
 * this leaf never imports the runtime or reaches through its private state.
 */

import type { Database } from '../../core/database.ts';
import { isGroupConversationKey } from '../../core/conversation-key.ts';
import { formatChatRefForOwner } from '../../core/chat-display-name.ts';
import { canonicalizeChatJid } from '../../core/lid-resolver.ts';
import { createChildLogger } from '../../logger.ts';
import { formatAge } from './session.ts';

const log = createChildLogger('agent-runtime');

interface RuntimeSessionStatus {
  active: boolean;
  startedAt: string | null;
  messageCount: number;
}

export interface RuntimeLifecycleSession {
  getStatus(): RuntimeSessionStatus;
  getDbRowId(): number | null;
  shutdown(suspend?: boolean): Promise<void>;
}

export interface RuntimeSessionLifecycleHost<
  TSession extends RuntimeLifecycleSession,
  TTeardown,
> {
  readonly db: Database;
  readonly instanceName: string;
  readonly sessionScope: 'single' | 'shared' | 'per_chat';
  readonly chatSessions: Map<string, TSession>;
  getSession(): TSession | null;
  getActiveChatJid(): string | null;
  resolvePerChatMapKey(chatJid: string): string;
  sendDirect(chatJid: string, text: string, force: boolean): void;
  abortPerChatQueue(mapKey: string): void;
  terminalizePerChatTurn(mapKey: string): Promise<TTeardown>;
  retirePerChatTurn(teardown: TTeardown): Promise<void>;
  deletePerChatSessionAndQueue(mapKey: string, session: TSession): void;
  cleanupPerChatState(mapKey: string): void;
  getGlobalInterruptChatJid(): string | null;
  abortGlobalInterruptQueue(): void;
  terminalizeGlobalTurn(): Promise<TTeardown>;
  shutdownOperationTracker(): void;
  cleanupGlobalAutoCompactState(): void;
  retireGlobalTurn(teardown: TTeardown): Promise<void>;
  clearGlobalSessionRefs(): void;
}

function tokenCount(db: Database, session: RuntimeLifecycleSession): string {
  const dbRowId = session.getDbRowId();
  if (dbRowId === null) return '0';
  const row = db.raw.prepare(
    'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?',
  ).get(dbRowId) as {
    total_input_tokens: number | null;
    total_output_tokens: number | null;
  } | undefined;
  if (!row) return '0';
  const total = (row.total_input_tokens ?? 0) + (row.total_output_tokens ?? 0);
  return total > 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
}

export function runSessionsCommand<
  TSession extends RuntimeLifecycleSession,
  TTeardown,
>(
  host: RuntimeSessionLifecycleHost<TSession, TTeardown>,
  chatJid: string,
): void {
  const entries: string[] = [];
  const requestingKey = host.sessionScope === 'per_chat'
    ? host.resolvePerChatMapKey(chatJid)
    : null;
  if (host.sessionScope === 'per_chat') {
    for (const [mapKey, session] of host.chatSessions) {
      const status = session.getStatus();
      if (!status.active) continue;
      const label = isGroupConversationKey(mapKey) ? 'Group' : 'DM';
      const age = status.startedAt ? formatAge(status.startedAt) : '?';
      const identifier = mapKey === requestingKey
        ? 'Current session'
        : formatChatRefForOwner(host.db, mapKey);
      entries.push(
        `${entries.length + 1}. ${identifier} (${label}) — ${age}, `
        + `${status.messageCount} msgs, ${tokenCount(host.db, session)} tokens`,
      );
    }
  } else {
    const session = host.getSession();
    const status = session?.getStatus();
    if (session && status?.active) {
      const age = status.startedAt ? formatAge(status.startedAt) : '?';
      const activeChatJid = host.getActiveChatJid();
      const requestIsActiveChat = activeChatJid !== null
        && canonicalizeChatJid(chatJid, host.db) === canonicalizeChatJid(activeChatJid, host.db);
      const identifier = requestIsActiveChat
        ? 'Current session'
        : (activeChatJid ? formatChatRefForOwner(host.db, activeChatJid) : 'unknown');
      entries.push(
        `1. ${identifier} — ${age}, ${status.messageCount} msgs, `
        + `${tokenCount(host.db, session)} tokens`,
      );
    }
  }
  host.sendDirect(
    chatJid,
    entries.length > 0
      ? `*Active Sessions (${entries.length})*\n\n${entries.join('\n')}\n\n/kill-session <number> to terminate`
      : '_No active sessions._',
    true,
  );
}

export async function runKillSessionCommand<
  TSession extends RuntimeLifecycleSession,
  TTeardown,
>(
  host: RuntimeSessionLifecycleHost<TSession, TTeardown>,
  chatJid: string,
  rawIndex: string,
): Promise<void> {
  const targetIndex = /^\d+$/.test(rawIndex.trim()) ? Number(rawIndex.trim()) : NaN;
  if (!Number.isInteger(targetIndex) || targetIndex < 1) {
    host.sendDirect(chatJid, '_Usage: /kill-session <number>_\nRun /sessions first to see the list.', true);
    return;
  }
  if (host.sessionScope === 'per_chat') {
    const activeSessions = [...host.chatSessions].filter(([, session]) => session.getStatus().active);
    if (targetIndex > activeSessions.length) {
      host.sendDirect(chatJid, `_Invalid session number. ${activeSessions.length} active._`, true);
      return;
    }
    const [mapKey, session] = activeSessions[targetIndex - 1];
    host.abortPerChatQueue(mapKey);
    let teardown: TTeardown;
    try {
      teardown = await host.terminalizePerChatTurn(mapKey);
    } catch (err) {
      log.error({ err, mapKey }, 'kill-session: runtime turn queue teardown failed');
      host.sendDirect(
        chatJid,
        '_Session not killed: in-flight turn ownership could not be durably finalized._',
        true,
      );
      return;
    }
    await session.shutdown(false);
    await host.retirePerChatTurn(teardown);
    host.deletePerChatSessionAndQueue(mapKey, session);
    host.cleanupPerChatState(mapKey);
    const label = isGroupConversationKey(mapKey) ? 'Group' : 'DM';
    host.sendDirect(
      chatJid,
      `_Session killed: ${formatChatRefForOwner(host.db, mapKey)} (${label})_`,
      true,
    );
    return;
  }

  const session = host.getSession();
  if (!session?.getStatus().active) {
    host.sendDirect(chatJid, '_No active session to kill._', true);
    return;
  }
  if (targetIndex !== 1) {
    host.sendDirect(chatJid, '_Invalid session number. 1 active._', true);
    return;
  }
  const killedRef = host.getGlobalInterruptChatJid() ?? host.getActiveChatJid();
  host.abortGlobalInterruptQueue();
  let teardown: TTeardown;
  try {
    teardown = await host.terminalizeGlobalTurn();
  } catch (err) {
    log.error({ err }, 'kill-session: singleton/shared runtime turn teardown failed');
    host.sendDirect(
      chatJid,
      '_Session not killed: in-flight turn ownership could not be durably finalized._',
      true,
    );
    return;
  }
  host.shutdownOperationTracker();
  host.cleanupGlobalAutoCompactState();
  await session.shutdown(false);
  await host.retireGlobalTurn(teardown);
  host.clearGlobalSessionRefs();
  host.sendDirect(
    chatJid,
    killedRef
      ? `_Session killed: ${formatChatRefForOwner(host.db, killedRef)}_`
      : '_Session killed._',
    true,
  );
}

export interface OwnedSessionShutdownResult<TSession> {
  failures: unknown[];
  failedPerChatSessions: Map<string, TSession>;
  singletonSessionShutdownFailed: boolean;
}

export async function shutdownOwnedSessions<TSession extends RuntimeLifecycleSession>(
  host: Pick<
    RuntimeSessionLifecycleHost<TSession, unknown>,
    'instanceName' | 'sessionScope' | 'chatSessions' | 'getSession'
  >,
  skipOwners: ReadonlySet<TSession>,
): Promise<OwnedSessionShutdownResult<TSession>> {
  const failures: unknown[] = [];
  const failedPerChatSessions = new Map<string, TSession>();
  let singletonSessionShutdownFailed = false;
  if (host.sessionScope === 'per_chat') {
    const outcomes = await Promise.all(
      [...host.chatSessions].map(async ([chatJid, session]) => {
        const startedAt = Date.now();
        if (skipOwners.has(session)) {
          return { chatJid, session, err: null as unknown, durationMs: Date.now() - startedAt, skipped: true };
        }
        try {
          await session.shutdown();
          return { chatJid, session, err: null as unknown, durationMs: Date.now() - startedAt, skipped: false };
        } catch (err) {
          return { chatJid, session, err, durationMs: Date.now() - startedAt, skipped: false };
        }
      }),
    );
    for (const { chatJid, session, err, durationMs, skipped } of outcomes) {
      if (skipped) {
        failedPerChatSessions.set(chatJid, session);
        log.warn({ chatJid, durationMs }, 'per_chat session retained after route recycle failure');
      } else if (err !== null) {
        failures.push(err);
        failedPerChatSessions.set(chatJid, session);
        log.warn({ err, chatJid, durationMs }, 'per_chat session shutdown failed');
      } else {
        log.debug({ chatJid, durationMs }, 'per_chat session shutdown ok');
      }
    }
  } else {
    const session = host.getSession();
    if (session && skipOwners.has(session)) {
      singletonSessionShutdownFailed = true;
      log.warn(
        { instanceName: host.instanceName },
        'singleton/shared session retained after route recycle failure',
      );
    } else if (session) {
      try {
        await session.shutdown();
      } catch (err) {
        failures.push(err);
        singletonSessionShutdownFailed = true;
        log.warn({ err, instanceName: host.instanceName }, 'session shutdown failed');
      }
    }
  }
  return { failures, failedPerChatSessions, singletonSessionShutdownFailed };
}
