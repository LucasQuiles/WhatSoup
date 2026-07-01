// src/transport/connection.ts
// ConnectionManager — Baileys-backed WhatsApp connection with typed event emission.

import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { arch, freemem, hostname, loadavg, platform, release, totalmem, uptime as osUptime } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WAMessage,
  isJidGroup,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { shortHash } from '../lib/short-hash.ts';
import { appendPrivateJsonLineSync, readFreshMarkerSync, writePrivateJsonMarkerSync } from '../lib/private-fs.ts';

import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../lib/emit-alert.ts';
import type { BotErrorsCriticalAssetDiagnostic } from '../lib/bot-errors-outbox.ts';
import { WhatSoupError } from '../errors.ts';
import { normalizeUnixTimestampSeconds, nowUnixSec } from '../fleet/time-utils.ts';
import type { Messenger, IncomingMessage, OutboundMedia, SendOptions, SubmissionReceipt, TypingState } from '../core/types.ts';
import { toConversationKey } from '../core/conversation-key.ts';
import { bareNumber, isLidJid } from '../core/jid-constants.ts';
import type { IdentityStore, GuardMode } from '../core/outbound-identity/types.ts';
import { applyOutboundIdentityGuard } from '../core/outbound-identity/guard.ts';
import { formatMentions, buildLidMappings, ContactsDirectory } from '../core/mentions.ts';
import { PresenceCache } from './presence-cache.ts';
import { jitteredDelay } from '../core/retry.ts';
import { decideDisconnectAction } from './auth-disconnect-policy.ts';
import { isBaileysEncryptedTmpEnoent } from './baileys-media-errors.ts';
import { AuthBondGuard, type AuthBondSnapshot } from './auth-bond.ts';
import { createAtomicCredsSaver } from './atomic-auth-save.ts';
import { installThirdPartyConsoleRedaction } from './third-party-console-redaction.ts';
import { jidPattern } from '../lib/redaction-patterns.ts';
import { baileysVersionLabel, resolveBaileysVersion } from './baileys-version.ts';
import { PollVoteDecryptor } from './poll-vote-decryptor.ts';

export type { IncomingMessage } from '../core/types.ts';

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;
export type ConnectionLifecycleState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'cooldown'
  | 'shutting_down';

export interface ConnectionRecentDisconnects {
  windowMs: number;
  count: number;
  lastAt: string | null;
  lastReason: string | null;
  lastStatusCode: number | null;
  byReason: Record<string, number>;
}

export interface ConnectionStateSnapshot {
  state: ConnectionLifecycleState;
  connected: boolean;
  reconnectAttempts: number;
  reconnectPhase: 'backoff' | 'cooldown' | 'retry' | null;
  stateChangedAt: string;
  firstFailureAt: string | null;
  lastPingAt: string | null;
  lastPongAt: string | null;
  lastDisconnectReason: string | null;
  lastStatusCode: number | null;
  recentDisconnects: ConnectionRecentDisconnects;
  authBond?: AuthBondSnapshot;
  credentialLifecycle: CredentialLifecycleSnapshot;
}

export type CredentialLifecycleEventName =
  | 'connect_start'
  | 'auth_restore_succeeded'
  | 'auth_restore_failed'
  | 'auth_preflight_invalid'
  | 'baileys_version'
  | 'socket_created'
  | 'qr_required'
  | 'connection_open'
  | 'connection_close'
  | 'creds_update_saved'
  | 'creds_update_failed'
  | 'auth_snapshot_scheduled'
  | 'auth_snapshot_skipped'
  | 'auth_snapshot_captured'
  | 'auth_snapshot_failed'
  | 'device_bond_lost';

export interface CredentialLifecycleEvent {
  at: string;
  event: CredentialLifecycleEventName;
  state: ConnectionLifecycleState;
  reconnectAttempts: number;
  reconnectPhase: 'backoff' | 'cooldown' | 'retry';
  statusCode?: number;
  reason?: string;
  conflictType?: string | null;
  reconnectDecision?: string;
  lastDisconnectDiagnostic?: unknown;
  baileysVersion?: string;
  authBondStatus?: AuthBondSnapshot['status'];
  authBondIssues?: string[];
  authDirMode?: string | null;
  authDirMtime?: string | null;
  credsMode?: string | null;
  credsMtime?: string | null;
  credsSize?: number | null;
  credsHash?: string | null;
  identityHash?: string | null;
  treeHash?: string | null;
  latestBackup?: string | null;
  latestBackupAt?: string | null;
  latestBackupReason?: string | null;
  lastCaptureError?: string | null;
  lastCaptureDeferredAt?: string | null;
  lastCaptureDeferredReason?: string | null;
  lastCaptureDeferredAgeMs?: number | null;
  lastRestoreError?: string | null;
  note?: string;
}

export interface CredentialLifecycleEnvironment {
  instance: string;
  host: string;
  pid: number;
  nodeVersion: string;
  platform: string;
  arch: string;
  release: string;
  processUptimeSeconds: number;
  osUptimeSeconds: number;
  loadavg: number[];
  memory: {
    freeBytes: number;
    totalBytes: number;
  };
  authDir: string;
  stateRoot: string | null;
  dataRoot: string | null;
  lockPath: string;
  healthPort: number;
  provider: string;
}

export interface CredentialLifecycleAuthBondDigest {
  status: AuthBondSnapshot['status'];
  issues: string[];
  authDir: Pick<AuthBondSnapshot['authDir'], 'path' | 'exists' | 'mode' | 'size' | 'mtime'>;
  creds: Pick<AuthBondSnapshot['creds'], 'path' | 'exists' | 'mode' | 'size' | 'mtime'> & {
    hash: string | null;
    identityHash: string | null;
  };
  treeHash: string | null;
  backup: Pick<
    AuthBondSnapshot['backup'],
    | 'root'
    | 'latest'
    | 'latestAt'
    | 'latestReason'
    | 'latestTreeHash'
    | 'lastCaptureAt'
    | 'lastCaptureReason'
    | 'lastCaptureError'
    | 'lastCaptureDeferredAt'
    | 'lastCaptureDeferredReason'
    | 'lastCaptureDeferredAgeMs'
    | 'lastRestoreAt'
    | 'lastRestoreSource'
    | 'lastRestoreError'
  >;
}

export interface CredentialLifecycleSnapshot {
  version: 1;
  redaction: {
    version: 1;
    policy: string;
  };
  environment: CredentialLifecycleEnvironment;
  currentAuthBond: CredentialLifecycleAuthBondDigest;
  latestBaileysVersion: string | null;
  connectStartedAt: string | null;
  lastOpenAt: string | null;
  lastCloseAt: string | null;
  lastQrAt: string | null;
  lastCredsUpdateAt: string | null;
  lastCredsUpdateFailedAt: string | null;
  lastAuthSnapshotAt: string | null;
  lastAuthSnapshotFailedAt: string | null;
  credsUpdateCount: number;
  authSnapshotCaptureCount: number;
  authSnapshotFailureCount: number;
  lastDisconnectDiagnostic: unknown | null;
  recentEvents: CredentialLifecycleEvent[];
}

/** Maximum time to wait for a send operation before aborting. */
const SEND_TIMEOUT_MS = 30_000;

/** Wrap a promise with a timeout. Rejects with a descriptive error if it takes too long. */
function withSendTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(
      () => reject(new WhatSoupError(`${operation} timed out after ${SEND_TIMEOUT_MS / 1000}s`, 'SEND_TIMEOUT')),
      SEND_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle!));
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function resolveTypingState(state: TypingState): 'composing' | 'recording' | 'paused' {
  if (state === true) return 'composing';
  if (state === false) return 'paused';
  return state;
}

function mediaUpload(media: OutboundMedia): Buffer | { stream: Readable } | { url: string } {
  if (media.stream !== undefined) return { stream: media.stream };
  if (media.url !== undefined) return { url: media.url };
  return media.buffer;
}

function canReplayMediaSend(media: OutboundMedia): boolean {
  return media.buffer !== undefined;
}

function summarizePath(path: string): string {
  try {
    const st = statSync(path);
    return [
      `exists=true`,
      `mode=${(st.mode & 0o777).toString(8)}`,
      `size=${st.size}`,
      `mtime=${st.mtime.toISOString()}`,
    ].join(' ');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    return `exists=false error=${code}`;
  }
}

function compactJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) return 'null';
    return encoded.length > 1600 ? `${encoded.slice(0, 1600)}...<truncated>` : encoded;
  } catch {
    return '<unserializable>';
  }
}

function shortHashOrNull(value: string | null | undefined): string | null {
  return value ? value.slice(0, 20) : null;
}

function isSensitiveDiagnosticKey(key: string): boolean {
  return /(?:token|secret|password|passphrase|pairing|customcode|authorization|bearer|cookie|apikey|api_key|privatekey|private_key|clientsecret|client_secret|accesstoken|access_token|refreshtoken|refresh_token|credential|creds|authstate|auth_state|keydata|advsecretkey|signedidentitykey|noisekey|signalkeys|sessionrecord|senderkey|senderkeymemory|appstatesynckey)/i.test(key);
}

function redactDiagnosticString(value: string): string {
  return value
    .replace(jidPattern(), (match) => `<jid:${shortHash(match, 20)}>`)
    .replace(/\b\d{10,16}\b/g, (match) => `<number:${shortHash(match, 20)}>`)
    .replace(
      /\b(token|secret|password|passphrase|pairing|authorization|bearer|api[_-]?key)\b\s*[:=]?\s*["']?[A-Za-z0-9._~+/=-]{6,}["']?/gi,
      (_match, label: string) => `${label} <redacted>`,
    );
}

/**
 * Auth-bond issue strings come from hardenPrivateTree as `code`, `code:rel`, or
 * `code:rel:errorMessage`. `rel` is a Baileys session filename that embeds a contact
 * JID/phone, and `errorMessage` can carry an absolute auth path. The detail is NEVER
 * emitted raw into the durable bond event: keep the diagnostic code (the triage signal)
 * and replace all detail with a stable short hash for correlating repeats.
 */
function redactAuthBondIssue(issue: string): string {
  const sep = issue.indexOf(':');
  if (sep === -1) return issue;
  return `${issue.slice(0, sep)}:<redacted:${shortHash(issue.slice(sep + 1), 16)}>`;
}

function redactDiagnosticValue(value: unknown, key = '', depth = 0): unknown {
  if (key && isSensitiveDiagnosticKey(key)) return '<redacted>';
  if (typeof value === 'string') return redactDiagnosticString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= 6) return '<max-depth>';
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactDiagnosticString(value.message),
      stack: value.stack ? redactDiagnosticString(value.stack) : undefined,
    };
    for (const childKey of Object.getOwnPropertyNames(value)) {
      if (childKey === 'name' || childKey === 'message' || childKey === 'stack') continue;
      out[childKey] = redactDiagnosticValue((value as unknown as Record<string, unknown>)[childKey], childKey, depth + 1);
    }
    return out;
  }
  if (Array.isArray(value)) {
    const redacted = value.slice(0, 30).map(item => redactDiagnosticValue(item, '', depth + 1));
    if (value.length > redacted.length) redacted.push(`<truncated:${value.length - redacted.length}>`);
    return redacted;
  }

  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    out[childKey] = redactDiagnosticValue(childValue, childKey, depth + 1);
  }
  const entryCount = Object.keys(value as Record<string, unknown>).length;
  if (entryCount > 80) out['<truncated_keys>'] = entryCount - 80;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractStreamErrorConflictType(lastDisconnect: unknown): string | null | undefined {
  const error = isRecord(lastDisconnect) ? lastDisconnect.error : undefined;
  const data = isRecord(error) ? error.data : undefined;
  if (data === undefined) return undefined;

  let sawStreamError = false;

  const visit = (value: unknown, depth = 0): string | null | undefined => {
    if (depth > 8) return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!isRecord(value)) return undefined;

    const tag = typeof value.tag === 'string' ? value.tag : '';
    const attrs = isRecord(value.attrs) ? value.attrs : {};
    if (tag === 'stream:error') sawStreamError = true;
    if (tag === 'conflict') {
      return typeof attrs.type === 'string' ? attrs.type : null;
    }

    const content = value.content;
    const childFound = visit(content, depth + 1);
    if (childFound !== undefined) return childFound;
    return undefined;
  };

  const found = visit(data);
  if (found !== undefined) return found;
  return sawStreamError ? null : undefined;
}

function formatReconnectDecision(action: ReturnType<typeof decideDisconnectAction>): string {
  return `${action.type}:${action.reason}`;
}

type AuthBondClearCandidate = {
  operation: string;
  messageId: string;
  submittedAt: number;
};

type AuthBondSendProof = {
  source: 'receipt_update' | 'own_message_echo';
  messageId: string;
  confirmedAt: number;
  recipientJid?: string;
};

// ---------------------------------------------------------------------------
// Typed transport events
// ---------------------------------------------------------------------------

export interface TransportEvents {
  contactsUpsert: (contacts: Array<{ id: string; name?: string; notify?: string }>) => void;
  contactsUpdate: (updates: Array<{ id: string; notify?: string; name?: string }>) => void;
  messageEdited: (messageId: string, newContent: string) => void;
  messageDeleted: (messageIds: string[]) => void;
  chatCleared: (jid: string) => void;
  presenceUpdate: (jid: string, status: string, lastSeen?: number) => void;
  callReceived: (callId: string, callFrom: string) => void;
  groupParticipantsUpdate: (data: {
    groupJid: string;
    author: string;
    participants: string[];
    action: 'add' | 'remove' | 'promote' | 'demote';
  }) => void;
  jidAliasChanged: (conversationKey: string, newJid: string) => void;
  /** L3: LID↔phone pair discovered from message key participant/participantAlt. */
  lidPairDiscovered: (participant: string, participantAlt: string) => void;
  historySyncComplete: () => void;
  exhausted: () => void;
  reactionReceived: (data: {
    messageId: string;
    conversationKey: string;
    senderJid: string;
    reaction: string;
  }) => void;
  receiptUpdate: (data: {
    messageId: string;
    recipientJid: string;
    type: string;
  }) => void;
  mediaUpdate: (updates: Array<{ key: { id: string }; update: Record<string, unknown> }>) => void;
  chatsUpsert: (chats: Array<{ id: string; [key: string]: unknown }>) => void;
  chatsUpdate: (updates: Array<{ id: string; [key: string]: unknown }>) => void;
  chatsDelete: (jids: string[]) => void;
  historyMessages: (messages: unknown[]) => void;
  groupsUpsert: (groups: Array<{ id: string; subject?: string; [key: string]: unknown }>) => void;
  groupsUpdate: (updates: Array<{ id: string; [key: string]: unknown }>) => void;
  groupJoinRequest: (data: { groupJid: string; requesterJid: string; requestId: string }) => void;
  blocklistSet: (blocklist: string[]) => void;
  blocklistUpdate: (data: { blocklist: string[]; type: 'add' | 'remove' }) => void;
  newsletterReaction: (data: unknown) => void;
  newsletterView: (data: unknown) => void;
  newsletterParticipantsUpdate: (data: unknown) => void;
  newsletterSettingsUpdate: (data: unknown) => void;
  labelsEdit: (labels: Array<{ id: string; name: string; color?: number; predefinedId?: string }>) => void;
  labelsAssociation: (data: { labelId: string; type: string; chatJid?: string; messageId?: string; operation?: 'add' | 'remove' }) => void;
  decryptionFailure: (data: {
    messageId: string;
    chatJid: string;
    senderJid: string;
    errorMessage: string;
    rawKey: { remoteJid: string; id: string; fromMe: boolean };
    timestamp: number;
  }) => void;
  /** Poll vote received — decoded option names from a poll we sent. */
  pollVoteReceived: (data: {
    pollMessageId: string;
    chatJid: string;
    voterJid: string;
    selectedOptions: string[];
  }) => void;
  /** Poll vote decryption failed after all bounded JID candidates were exhausted. */
  pollVoteFailed: (data: {
    pollMessageId: string;
    chatJid: string;
    reason: string;
  }) => void;
}

// Typed event emitter augmentation
export declare interface ConnectionManager {
  on<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this;
  emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>): boolean;
  off<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this;
  once<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this;
}

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

export class ConnectionManager extends EventEmitter implements Messenger {
  private sock: WhatsAppSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private shuttingDown = false;
  private reconnectPhase: 'backoff' | 'cooldown' | 'retry' = 'backoff';
  private firstFailureAt: number | null = null;
  // Tracks the first of a run of consecutive keepalive failures. Unlike firstFailureAt
  // (the disconnect-driven exhaustion clock, reset on every open), this is cleared ONLY by
  // a successful pong — so a connect→open→keepalive-fail loop, which bypasses
  // scheduleReconnect via gracefulReconnect, still trips the exhaustion path.
  private keepaliveFailureFirstAt: number | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveInFlight = false;
  private gracefulReconnectInFlight = false;
  private exhaustionCycles = 0;
  private restartRequiredTimestamps: number[] = [];
  private lastPingAt: number | null = null;
  private lastPongAt: number | null = null;
  private lastDisconnectReason: string | null = null;
  private lastStatusCode: number | null = null;
  private recentDisconnects: Array<{ at: number; reason: string; statusCode: number | null }> = [];
  private lastDisconnectDiagnostic: unknown | null = null;
  private loggedOutAlertEmitted = false;
  private unclassified401ReconnectSpent = false;
  private localAuthAlertEmitted = false;
  private pendingAuthBondClearSends = new Map<string, AuthBondClearCandidate>();
  private confirmedAuthBondSendProofs = new Map<string, AuthBondSendProof>();
  private connectionState: ConnectionLifecycleState = 'disconnected';
  private stateChangedAt = Date.now();
  private latestBaileysVersion: string | null = null;
  private connectStartedAt: number | null = null;
  private lastOpenAt: number | null = null;
  private lastCloseAt: number | null = null;
  private lastQrAt: number | null = null;
  private lastCredsUpdateAt: number | null = null;
  private lastCredsUpdateFailedAt: number | null = null;
  private lastAuthSnapshotAt: number | null = null;
  private lastAuthSnapshotFailedAt: number | null = null;
  private credsUpdateCount = 0;
  private authSnapshotCaptureCount = 0;
  private authSnapshotFailureCount = 0;
  private authSnapshotSettledTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSettledAuthSnapshotAttemptAt: number | null = null;
  private credentialLifecycleEvents: CredentialLifecycleEvent[] = [];
  private readonly authBond = new AuthBondGuard({
    authDir: config.authDir,
    stateRoot: config.stateRoot,
    instanceName: config.botName,
    captureBlockReason: () => this.loggedOutAlertEmitted
      ? 'loggedOut/device-bond-lost state active; refusing to snapshot possibly poisoned credentials'
      : null,
  });
  private static readonly RECENT_DISCONNECT_WINDOW_MS = 10 * 60 * 1000;
  private static readonly MAX_FAILURE_DURATION_MS = 30 * 60 * 1000;
  private static readonly COOLDOWN_MS = 5 * 60 * 1000;
  private static readonly KEEPALIVE_INTERVAL_MS = 30_000;
  private static readonly KEEPALIVE_TIMEOUT_MS = 10_000;
  private static readonly AUTH_BOND_CLEAR_PROOF_TTL_MS = 10 * 60 * 1000;
  private static readonly AUTH_BOND_SETTLED_SNAPSHOT_DELAY_MS = 60_000;
  private static readonly AUTH_BOND_SETTLED_SNAPSHOT_MIN_INTERVAL_MS = 5 * 60_000;
  private static readonly CREDENTIAL_LIFECYCLE_EVENT_LIMIT = 40;

  private readonly log = createChildLogger('connection');

  /** The bot's own JID (phone@s.whatsapp.net) — populated on connection open. */
  botJid: string | null = null;

  /** The bot's own LID (number@lid) — used for @mention matching in groups. */
  botLid: string | null = null;

  private selfMentionRegexJid: RegExp | null = null;
  private selfMentionRegexLid: RegExp | null = null;

  /** Callback invoked for every parsed incoming message. Set by the conversation layer. */
  onMessage: ((msg: IncomingMessage) => void) | null = null;

  /** Contacts directory built from incoming messages — maps names → phone numbers for @mention resolution. */
  readonly contactsDir = new ContactsDirectory();

  /** In-memory cache of the most recent presence status per JID. */
  readonly presenceCache = new PresenceCache();

  private identityStore: IdentityStore | null = null;
  private identityMode: GuardMode = 'log-only';

  setIdentityStore(store: IdentityStore, mode: GuardMode): void {
    this.identityStore = store;
    this.identityMode = mode;
  }

  /** When true, incoming calls are automatically rejected via sock.rejectCall(). */
  autoRejectCalls = false;

  // ---------------------------------------------------------------------------
  // Poll vote tracking + decryption — owned by PollVoteDecryptor.
  // botJid/botLid are read through thunks (late-bound on connection open).
  // Instantiated after `this.log` above so the decryptor shares the same logger.
  // ---------------------------------------------------------------------------
  private readonly pollVoteDecryptor = new PollVoteDecryptor({
    log: this.log,
    emit: {
      pollVoteReceived: (data) => { this.emit('pollVoteReceived', data); },
      pollVoteFailed: (data) => { this.emit('pollVoteFailed', data); },
    },
    getBotJid: () => this.botJid,
    getBotLid: () => this.botLid,
  });

  /** Expose the raw Baileys socket for MCP tools. Returns null when disconnected. */
  getSocket(): WhatsAppSocket | null {
    return this.sock;
  }

  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_BACKOFF_MS = 1_000;
  private static readonly MAX_BACKOFF_MS = 60_000;

  constructor() {
    super();
    // authDir is sourced from config — no constructor parameters needed
    this.on('exhausted', () => {
      void this.handleExhausted();
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.shuttingDown) return;

    // Check for recent exhaustion marker from a previous crash-loop
    if (config.dataRoot) {
      const markerPath = join(config.dataRoot, 'exhausted.marker');
      const marker = readFreshMarkerSync<{ timestamp: string; cycles: number; instanceName: string }>(
        markerPath,
        5 * 60 * 1000,
      );
      if (marker) {
        const ageMs = Date.now() - new Date(marker.timestamp).getTime();
        this.log.warn(
          { marker, ageMs },
          '*** RECENT EXHAUSTION MARKER DETECTED — previous process exited after %d exhaustion cycles %dms ago ***',
          marker.cycles,
          ageMs,
        );
      }
    }

    this.setConnectionState('connecting');
    this.connectStartedAt = Date.now();
    this.recordCredentialLifecycle('connect_start');
    this.persistConnectionRuntimeState('connect_start');
    this.log.info('Connecting to WhatsApp');

    try {
      const restore = this.authBond.restoreLatestIfNeeded();
      if (restore.restored) {
        this.recordCredentialLifecycle('auth_restore_succeeded', {
          authBond: restore.snapshot,
          note: restore.source ?? 'unknown',
        });
        this.log.warn({ source: restore.source }, 'auth bond restored from protected local snapshot');
      } else if (restore.attempted && restore.error) {
        this.recordCredentialLifecycle('auth_restore_failed', {
          authBond: restore.snapshot,
          note: restore.error,
        });
        this.log.error({ error: restore.error, source: restore.source }, 'auth bond restore failed');
      }

      const preflight = this.authBond.inspect();
      if (preflight.status !== 'present') {
        this.recordCredentialLifecycle('auth_preflight_invalid', { authBond: preflight });
      }
      if (preflight.status === 'invalid') {
        this.emitLocalAuthBondFailureAlert('connect-preflight', preflight);
      }

      installThirdPartyConsoleRedaction();

      const { state } = await useMultiFileAuthState(config.authDir);
      const saveCredsAtomically = createAtomicCredsSaver(config.authDir, () => state.creds);
      const resolvedVersion = await resolveBaileysVersion();
      this.latestBaileysVersion = baileysVersionLabel(resolvedVersion.version);
      this.recordCredentialLifecycle('baileys_version', {
        baileysVersion: this.latestBaileysVersion,
        note: `source=${resolvedVersion.source}`,
      });

      // Suppress Baileys internals (handshake material, signal keys, etc.)
      const baileysLogger = this.log.child({ component: 'baileys' });
      (baileysLogger as any).level = 'error';

      const sock = makeWASocket({
        version: resolvedVersion.version,
        logger: baileysLogger as any,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
        },
        generateHighQualityLinkPreview: config.generateHighQualityLinkPreview,
      });

      this.sock = sock;
      this.recordCredentialLifecycle('socket_created', { baileysVersion: this.latestBaileysVersion });
      this.registerEventHandlers(sock, async () => {
        await saveCredsAtomically();
        this.captureAuthBondSnapshot('creds-update');
      });
    } catch (err) {
      this.log.error({ err }, 'Failed to create WhatsApp connection');
      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    }
  }

  async disconnect(): Promise<void> {
    return this.shutdown();
  }

  async sendMessage(chatJid: string, text: string, opts?: SendOptions): Promise<SubmissionReceipt> {
    if (!this.sock) {
      throw new WhatSoupError('WhatsApp is not connected', 'CONNECTION_UNAVAILABLE');
    }
    // QR-086: honour an OPTIONAL infra caller token so the guard's SYSTEM_CALLERS
    // exemption (spec §4.2 step B — infra never floored) is reachable. Only
    // trusted infra (health admin /send via sendTracked) sets opts.caller;
    // every other path leaves it undefined → 'agent' → full cold-floor.
    applyOutboundIdentityGuard(chatJid, { caller: opts?.caller ?? 'agent', mode: this.identityMode }, this.identityStore);
    // Strip self-mentions — prevent the bot from @mentioning itself in outbound text.
    // This is Layer 2 of the bot self-awareness defense (see whatsapp-bot self-awareness spec).
    let cleaned = text;
    if (this.selfMentionRegexJid) {
      const ownBare = bareNumber(this.botJid!);
      cleaned = cleaned.replace(this.selfMentionRegexJid, ownBare);
      this.selfMentionRegexJid.lastIndex = 0; // reset global regex state
    }
    if (this.selfMentionRegexLid) {
      const lidBare = bareNumber(this.botLid!);
      cleaned = cleaned.replace(this.selfMentionRegexLid, lidBare);
      this.selfMentionRegexLid.lastIndex = 0;
    }
    if (cleaned !== text) {
      this.log.warn('stripped self-mention from outbound message');
    }

    // Resolve @name and @number patterns → rewritten text + Baileys mentions array
    // Pass LID mappings so mentions work in LID-addressed groups
    const { text: formatted, jids: mentions, hasMentions } = formatMentions(
      cleaned,
      this.contactsDir.contacts,
      this.contactsDir.getLidMappings(),
    );

    const autoTyping = config.autoTyping;
    if (autoTyping !== 'off') {
      await this.setTyping(chatJid, autoTyping);
    }

    let result;
    // QR-028: when the caller supplies a stable messageId (reused across retries
    // of one logical send), pass it through as the Baileys key.id so a
    // slow-but-delivered message is server-deduped on retry instead of doubled.
    // Only pass the options arg when an id is present, so the common no-id path
    // calls sock.sendMessage with the same arity as before.
    const content = hasMentions ? { text: formatted, mentions } : { text: formatted };
    if (hasMentions) this.log.info({ mentions }, 'Outbound message includes mentions');
    try {
      result = await withSendTimeout(
        opts?.messageId
          ? this.sock.sendMessage(chatJid, content, { messageId: opts.messageId })
          : this.sock.sendMessage(chatJid, content),
        'sendMessage',
      );
    } finally {
      if (autoTyping !== 'off') {
        await this.setTyping(chatJid, 'paused');
      }
    }
    this.log.info({ chatJid, messageId: result?.key?.id }, 'Sending message');
    this.queueLocalAuthBondClearCandidate('sendMessage', result?.key?.id ?? null);
    this.scheduleSettledAuthBondSnapshot('outbound-send-settled');
    return { waMessageId: result?.key?.id ?? null };
  }

  /**
   * Send a raw Baileys message payload. Used by MCP tools that need to send
   * message types not covered by the typed sendMessage/sendMedia helpers.
   */
  async sendRaw(chatJid: string, content: Record<string, unknown>): Promise<SubmissionReceipt> {
    if (!this.sock) throw new WhatSoupError('WhatsApp is not connected', 'CONNECTION_UNAVAILABLE');
    applyOutboundIdentityGuard(chatJid, { caller: 'mcp', mode: this.identityMode }, this.identityStore);
    const autoTyping = typeof content['text'] === 'string' && config.autoTyping !== 'off'
      ? config.autoTyping
      : 'off';

    if (autoTyping !== 'off') {
      await this.setTyping(chatJid, autoTyping);
    }

    let result;
    try {
      result = await withSendTimeout(
        this.sock.sendMessage(chatJid, content as any),
        'sendRaw',
      );
    } finally {
      if (autoTyping !== 'off') {
        await this.setTyping(chatJid, 'paused');
      }
    }
    this.queueLocalAuthBondClearCandidate('sendRaw', result?.key?.id ?? null);
    this.scheduleSettledAuthBondSnapshot('outbound-send-settled');
    return { waMessageId: result?.key?.id ?? null };
  }

  /**
   * Send a WhatsApp poll and store the message secret for later vote decryption.
   * Returns `hasSecret: false` if the poll was sent but messageSecret is unavailable
   * (vote decryption will not work — caller should fall back to text question).
   */
  async sendPollMessage(
    chatJid: string,
    name: string,
    values: string[],
    selectableCount: number,
  ): Promise<{ waMessageId: string | null; hasSecret: boolean }> {
    if (!this.sock) throw new WhatSoupError('WhatsApp is not connected', 'CONNECTION_UNAVAILABLE');
    applyOutboundIdentityGuard(chatJid, { caller: 'mcp', mode: this.identityMode }, this.identityStore);

    const result = await withSendTimeout(
      this.sock.sendMessage(chatJid, {
        poll: { name, values, selectableCount },
      } as any),
      'sendPollMessage',
    );

    const waMessageId = result?.key?.id ?? null;
    // messageSecret is set by Baileys' generateWAMessageContent at
    // m.messageContextInfo.messageSecret (inside the Message proto).
    // The return value of sendMessage is a WebMessageInfo where the
    // Message lives at result.message.
    const r = result as any;
    const messageSecret = (
      r?.message?.messageContextInfo?.messageSecret ??
      r?.messageContextInfo?.messageSecret ??
      r?.messageSecret
    ) as Uint8Array | undefined;

    if (waMessageId && messageSecret) {
      this.pollVoteDecryptor.track(waMessageId, { messageSecret, optionNames: values, chatJid });

      this.log.info({ chatJid, waMessageId, optionCount: values.length, secretLen: messageSecret.length }, 'poll sent and tracked for vote decryption');
      this.queueLocalAuthBondClearCandidate('sendPollMessage', waMessageId);
      this.scheduleSettledAuthBondSnapshot('outbound-send-settled');
      return { waMessageId, hasSecret: true };
    }

    this.log.warn({ chatJid, waMessageId }, 'poll sent but messageSecret unavailable — vote decryption disabled');
    this.queueLocalAuthBondClearCandidate('sendPollMessage', waMessageId);
    this.scheduleSettledAuthBondSnapshot('outbound-send-settled');
    return { waMessageId, hasSecret: false };
  }

  async setTyping(chatJid: string, typing: TypingState): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(resolveTypingState(typing), chatJid);
    } catch (err) {
      // best-effort — presence failures must never surface to callers
      this.log.debug({ op: 'sendPresenceUpdate', error: (err as Error).message }, 'transport_op_swallowed');
    }
  }

  async sendMedia(chatJid: string, media: OutboundMedia): Promise<SubmissionReceipt> {
    if (!this.sock) {
      throw new WhatSoupError('WhatsApp is not connected', 'CONNECTION_UNAVAILABLE');
    }
    applyOutboundIdentityGuard(chatJid, { caller: 'mcp', mode: this.identityMode }, this.identityStore);
    for (let attempt = 0; ; attempt += 1) {
      this.log.info({ chatJid, mediaType: media.type, attempt }, 'Sending media');
      const upload = mediaUpload(media);

      let result;
      try {
        switch (media.type) {
          case 'image':
            result = await withSendTimeout(this.sock.sendMessage(chatJid, {
              image: upload,
              caption: media.caption,
              mimetype: media.mimetype,
              viewOnce: media.viewOnce,
            }), 'sendMedia:image');
            break;
          case 'document':
            result = await withSendTimeout(this.sock.sendMessage(chatJid, {
              document: upload,
              fileName: media.filename,
              mimetype: media.mimetype,
              caption: media.caption,
            }), 'sendMedia:document');
            break;
          case 'audio':
            result = await withSendTimeout(this.sock.sendMessage(chatJid, {
              audio: upload,
              mimetype: media.mimetype,
              ptt: media.ptt,
              seconds: media.seconds,
            }), 'sendMedia:audio');
            break;
          case 'video':
            result = await withSendTimeout(this.sock.sendMessage(chatJid, {
              video: upload,
              caption: media.caption,
              mimetype: media.mimetype,
              ptv: media.ptv,
              gifPlayback: media.gifPlayback,
              viewOnce: media.viewOnce,
            }), 'sendMedia:video');
            break;
          case 'sticker':
            result = await withSendTimeout(this.sock.sendMessage(chatJid, {
              sticker: upload,
              mimetype: media.mimetype ?? 'image/webp',
              isAnimated: media.isAnimated,
            }), 'sendMedia:sticker');
            break;
        }
        this.queueLocalAuthBondClearCandidate('sendMedia', result?.key?.id ?? null);
        this.scheduleSettledAuthBondSnapshot('outbound-send-settled');
        return { waMessageId: result?.key?.id ?? null };
      } catch (err) {
        if (attempt > 0 || !canReplayMediaSend(media) || !isBaileysEncryptedTmpEnoent(err)) {
          throw err;
        }
        this.log.warn(
          { chatJid, mediaType: media.type, path: err.path },
          'baileys encrypted tmp file vanished during media send; retrying once',
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.setConnectionState('shutting_down');
    this.persistConnectionRuntimeState('shutdown');
    this.clearReconnectTimers();
    this.clearAuthSnapshotSettledTimer();
    this.stopKeepalive();
    // Clear poll vote grace timers to prevent post-shutdown emissions
    this.pollVoteDecryptor.dispose();
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // best-effort
      }
      this.sock = null;
    }
    this.clearIdentity();
  }

  private recordCredentialLifecycle(
    event: CredentialLifecycleEventName,
    options: {
      statusCode?: number;
      reason?: string;
      conflictType?: string | null;
      reconnectDecision?: string;
      lastDisconnectDiagnostic?: unknown;
      note?: string;
      baileysVersion?: string;
      authBond?: AuthBondSnapshot;
    } = {},
  ): void {
    const authBond = options.authBond;
    const entry: CredentialLifecycleEvent = {
      at: new Date().toISOString(),
      event,
      state: this.connectionState,
      reconnectAttempts: this.reconnectAttempts,
      reconnectPhase: this.reconnectPhase,
    };

    if (options.statusCode !== undefined) entry.statusCode = options.statusCode;
    if (options.reason !== undefined) entry.reason = options.reason;
    if ('conflictType' in options) entry.conflictType = options.conflictType ?? null;
    if (options.reconnectDecision !== undefined) entry.reconnectDecision = options.reconnectDecision;
    if (options.lastDisconnectDiagnostic !== undefined) {
      entry.lastDisconnectDiagnostic = options.lastDisconnectDiagnostic;
    }
    if (options.note !== undefined) entry.note = options.note;
    if (options.baileysVersion !== undefined) entry.baileysVersion = options.baileysVersion;
    if (authBond) {
      entry.authBondStatus = authBond.status;
      entry.authBondIssues = [...authBond.issues];
      entry.authDirMode = authBond.authDir.mode;
      entry.authDirMtime = authBond.authDir.mtime;
      entry.credsMode = authBond.creds.mode;
      entry.credsMtime = authBond.creds.mtime;
      entry.credsSize = authBond.creds.size;
      entry.credsHash = authBond.creds.sha256?.slice(0, 20) ?? null;
      entry.identityHash = authBond.meHash;
      entry.treeHash = authBond.treeHash?.slice(0, 20) ?? null;
      entry.latestBackup = authBond.backup.latest;
      entry.latestBackupAt = authBond.backup.latestAt;
      entry.latestBackupReason = authBond.backup.latestReason;
      entry.lastCaptureError = authBond.backup.lastCaptureError;
      entry.lastCaptureDeferredAt = authBond.backup.lastCaptureDeferredAt;
      entry.lastCaptureDeferredReason = authBond.backup.lastCaptureDeferredReason;
      entry.lastCaptureDeferredAgeMs = authBond.backup.lastCaptureDeferredAgeMs;
      entry.lastRestoreError = authBond.backup.lastRestoreError;
    }

    this.credentialLifecycleEvents.push(entry);
    if (this.credentialLifecycleEvents.length > ConnectionManager.CREDENTIAL_LIFECYCLE_EVENT_LIMIT) {
      this.credentialLifecycleEvents.splice(
        0,
        this.credentialLifecycleEvents.length - ConnectionManager.CREDENTIAL_LIFECYCLE_EVENT_LIMIT,
      );
    }
    this.persistBondEvent(entry);
  }

  private sanitizeLifecycleEventForBondEvent(event: CredentialLifecycleEvent): Record<string, unknown> {
    return {
      at: event.at,
      event: event.event,
      state: event.state,
      reconnectAttempts: event.reconnectAttempts,
      reconnectPhase: event.reconnectPhase,
      statusCode: event.statusCode ?? null,
      reason: event.reason ?? null,
      conflictType: event.conflictType ?? null,
      reconnectDecision: event.reconnectDecision ?? null,
      baileysVersion: event.baileysVersion ?? null,
      authBondStatus: event.authBondStatus ?? null,
      authBondIssues: (event.authBondIssues ?? []).map(redactAuthBondIssue),
      authDirMode: event.authDirMode ?? null,
      authDirMtime: event.authDirMtime ?? null,
      credentialMode: event.credsMode ?? null,
      credentialMtime: event.credsMtime ?? null,
      credentialSize: event.credsSize ?? null,
      credentialHash: event.credsHash ?? null,
      identityHash: event.identityHash ?? null,
      treeHash: event.treeHash ?? null,
      latestBackupHash: event.latestBackup ? shortHash(event.latestBackup, 20) : null,
      latestBackupAt: event.latestBackupAt ?? null,
      latestBackupReason: event.latestBackupReason ?? null,
      lastCaptureError: event.lastCaptureError ? redactDiagnosticString(event.lastCaptureError) : null,
      lastCaptureDeferredAt: event.lastCaptureDeferredAt ?? null,
      lastCaptureDeferredReason: event.lastCaptureDeferredReason ?? null,
      lastCaptureDeferredAgeMs: event.lastCaptureDeferredAgeMs ?? null,
      lastRestoreError: event.lastRestoreError ? redactDiagnosticString(event.lastRestoreError) : null,
      notePresent: event.note !== undefined,
      noteHash: event.note ? shortHash(event.note, 20) : null,
    };
  }

  private authBondEventDigest(snapshot: AuthBondSnapshot): Record<string, unknown> {
    return {
      status: snapshot.status,
      issues: snapshot.issues.map(redactAuthBondIssue),
      authRoot: {
        pathHash: shortHash(snapshot.authDir.path, 20),
        exists: snapshot.authDir.exists,
        mode: snapshot.authDir.mode,
        size: snapshot.authDir.size,
        mtime: snapshot.authDir.mtime,
      },
      credentialFile: {
        pathHash: shortHash(snapshot.creds.path, 20),
        exists: snapshot.creds.exists,
        mode: snapshot.creds.mode,
        size: snapshot.creds.size,
        mtime: snapshot.creds.mtime,
        hash: shortHashOrNull(snapshot.creds.sha256),
        identityHash: snapshot.meHash,
      },
      treeHash: shortHashOrNull(snapshot.treeHash),
      backup: {
        rootHash: snapshot.backup.root ? shortHash(snapshot.backup.root, 20) : null,
        latestHash: snapshot.backup.latest ? shortHash(snapshot.backup.latest, 20) : null,
        latestAt: snapshot.backup.latestAt,
        latestReason: snapshot.backup.latestReason,
        latestTreeHash: shortHashOrNull(snapshot.backup.latestTreeHash),
        lastCaptureAt: snapshot.backup.lastCaptureAt,
        lastCaptureReason: snapshot.backup.lastCaptureReason,
        lastCaptureError: snapshot.backup.lastCaptureError
          ? redactDiagnosticString(snapshot.backup.lastCaptureError)
          : null,
        lastCaptureDeferredAt: snapshot.backup.lastCaptureDeferredAt,
        lastCaptureDeferredReason: snapshot.backup.lastCaptureDeferredReason,
        lastCaptureDeferredAgeMs: snapshot.backup.lastCaptureDeferredAgeMs,
        lastRestoreAt: snapshot.backup.lastRestoreAt,
        lastRestoreSourceHash: snapshot.backup.lastRestoreSource
          ? shortHash(snapshot.backup.lastRestoreSource, 20)
          : null,
        lastRestoreError: snapshot.backup.lastRestoreError
          ? redactDiagnosticString(snapshot.backup.lastRestoreError)
          : null,
      },
    };
  }

  private persistBondEvent(entry: CredentialLifecycleEvent): void {
    if (!config.dataRoot) return;

    try {
      const authBond = this.authBond.inspect();
      const eventPath = join(config.dataRoot, 'bond-events.ndjson');
      const payload = {
        version: 1,
        eventId: shortHash(`${entry.at}:${config.botName}:${process.pid}:${entry.event}:${this.credentialLifecycleEvents.length}`, 24),
        timestamp: entry.at,
        event: entry.event,
        redaction: {
          version: 1,
          policy: 'no raw JIDs, phone numbers, message content, QR/pairing codes, auth content, tokens, or credential paths',
        },
        runtime: {
          host: hostname(),
          bot: config.botName,
          pid: process.pid,
          processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          processUptimeSeconds: Math.floor(process.uptime()),
          codeSha: process.env.WHATSOUP_GIT_SHA ?? process.env.GIT_SHA ?? null,
          nodeVersion: process.version,
          platform: platform(),
          arch: arch(),
          release: release(),
        },
        service: {
          healthPort: config.healthPort,
          provider: config.agentProvider,
        },
        auth: {
          accountHash: authBond.meHash,
          authRootHash: shortHash(config.authDir, 20),
          stateRootHash: config.stateRoot ? shortHash(config.stateRoot, 20) : null,
          dataRootHash: config.dataRoot ? shortHash(config.dataRoot, 20) : null,
          metadataClass: authBond.status,
          bond: this.authBondEventDigest(authBond),
        },
        connection: {
          state: entry.state,
          currentState: this.connectionState,
          reconnectAttempts: entry.reconnectAttempts,
          reconnectPhase: entry.reconnectPhase,
          lastStatusCode: this.lastStatusCode,
          lastDisconnectReason: this.lastDisconnectReason,
          credsUpdateSeenSinceStart: this.credsUpdateCount > 0,
          credsUpdateCount: this.credsUpdateCount,
          lastCredsUpdateAt: toIso(this.lastCredsUpdateAt),
          lastCredsUpdateFailedAt: toIso(this.lastCredsUpdateFailedAt),
          authSnapshotCaptureCount: this.authSnapshotCaptureCount,
          authSnapshotFailureCount: this.authSnapshotFailureCount,
        },
        statusCode: entry.statusCode ?? null,
        reason: entry.reason ?? null,
        conflictType: entry.conflictType ?? null,
        reconnectDecision: entry.reconnectDecision ?? null,
        rawDisconnect: {
          statusCode: entry.statusCode ?? null,
          reason: entry.reason ?? null,
          streamError: entry.lastDisconnectDiagnostic ?? null,
        },
        lifecycle: {
          recentEvents: this.credentialLifecycleEvents
            .slice(-50)
            .map(event => this.sanitizeLifecycleEventForBondEvent(event)),
        },
        ownerEvidence: {
          status: 'not_recorded',
        },
      };
      appendPrivateJsonLineSync(eventPath, payload);
    } catch (err) {
      this.log.warn({ err }, 'failed to persist WhatsApp bond event');
    }
  }

  private getCredentialLifecycleEnvironment(): CredentialLifecycleEnvironment {
    return {
      instance: config.botName,
      host: hostname(),
      pid: process.pid,
      nodeVersion: process.version,
      platform: platform(),
      arch: arch(),
      release: release(),
      processUptimeSeconds: Math.floor(process.uptime()),
      osUptimeSeconds: Math.floor(osUptime()),
      loadavg: loadavg(),
      memory: {
        freeBytes: freemem(),
        totalBytes: totalmem(),
      },
      authDir: config.authDir,
      stateRoot: config.stateRoot ?? null,
      dataRoot: config.dataRoot ?? null,
      lockPath: config.lockPath ?? 'unknown',
      healthPort: config.healthPort,
      provider: config.agentProvider,
    };
  }

  private authBondDigest(snapshot: AuthBondSnapshot): CredentialLifecycleAuthBondDigest {
    return {
      status: snapshot.status,
      issues: [...snapshot.issues],
      authDir: {
        path: snapshot.authDir.path,
        exists: snapshot.authDir.exists,
        mode: snapshot.authDir.mode,
        size: snapshot.authDir.size,
        mtime: snapshot.authDir.mtime,
      },
      creds: {
        path: snapshot.creds.path,
        exists: snapshot.creds.exists,
        mode: snapshot.creds.mode,
        size: snapshot.creds.size,
        mtime: snapshot.creds.mtime,
        hash: shortHashOrNull(snapshot.creds.sha256),
        identityHash: snapshot.meHash,
      },
      treeHash: shortHashOrNull(snapshot.treeHash),
      backup: {
        root: snapshot.backup.root,
        latest: snapshot.backup.latest,
        latestAt: snapshot.backup.latestAt,
        latestReason: snapshot.backup.latestReason,
        latestTreeHash: shortHashOrNull(snapshot.backup.latestTreeHash),
        lastCaptureAt: snapshot.backup.lastCaptureAt,
        lastCaptureReason: snapshot.backup.lastCaptureReason,
        lastCaptureError: snapshot.backup.lastCaptureError,
        lastCaptureDeferredAt: snapshot.backup.lastCaptureDeferredAt,
        lastCaptureDeferredReason: snapshot.backup.lastCaptureDeferredReason,
        lastCaptureDeferredAgeMs: snapshot.backup.lastCaptureDeferredAgeMs,
        lastRestoreAt: snapshot.backup.lastRestoreAt,
        lastRestoreSource: snapshot.backup.lastRestoreSource,
        lastRestoreError: snapshot.backup.lastRestoreError,
      },
    };
  }

  private getCredentialLifecycleSnapshot(authBond = this.authBond.inspect()): CredentialLifecycleSnapshot {
    return {
      version: 1,
      redaction: {
        version: 1,
        policy: 'credential material, tokens, pairing codes, full JIDs, and full phone numbers are blocked; identity fields use short hashes only',
      },
      environment: this.getCredentialLifecycleEnvironment(),
      currentAuthBond: this.authBondDigest(authBond),
      latestBaileysVersion: this.latestBaileysVersion,
      connectStartedAt: toIso(this.connectStartedAt),
      lastOpenAt: toIso(this.lastOpenAt),
      lastCloseAt: toIso(this.lastCloseAt),
      lastQrAt: toIso(this.lastQrAt),
      lastCredsUpdateAt: toIso(this.lastCredsUpdateAt),
      lastCredsUpdateFailedAt: toIso(this.lastCredsUpdateFailedAt),
      lastAuthSnapshotAt: toIso(this.lastAuthSnapshotAt),
      lastAuthSnapshotFailedAt: toIso(this.lastAuthSnapshotFailedAt),
      credsUpdateCount: this.credsUpdateCount,
      authSnapshotCaptureCount: this.authSnapshotCaptureCount,
      authSnapshotFailureCount: this.authSnapshotFailureCount,
      lastDisconnectDiagnostic: this.lastDisconnectDiagnostic,
      recentEvents: this.credentialLifecycleEvents.map(event => ({ ...event })),
    };
  }

  getConnectionState(): ConnectionStateSnapshot {
    const authBond = this.authBond.inspect();
    return {
      state: this.connectionState,
      connected: this.connectionState === 'connected' && this.botJid !== null,
      reconnectAttempts: this.reconnectAttempts,
      reconnectPhase: this.connectionState === 'connected' ? null : this.reconnectPhase,
      stateChangedAt: new Date(this.stateChangedAt).toISOString(),
      firstFailureAt: toIso(this.firstFailureAt),
      lastPingAt: toIso(this.lastPingAt),
      lastPongAt: toIso(this.lastPongAt),
      lastDisconnectReason: this.lastDisconnectReason,
      lastStatusCode: this.lastStatusCode,
      recentDisconnects: this.getRecentDisconnectStats(),
      authBond,
      credentialLifecycle: this.getCredentialLifecycleSnapshot(authBond),
    };
  }


  private recordDisconnect(statusCode: number | null, reason: string): void {
    const now = Date.now();
    this.recentDisconnects.push({ at: now, reason, statusCode });
    this.pruneRecentDisconnects(now);
  }

  private pruneRecentDisconnects(now = Date.now()): void {
    const cutoff = now - ConnectionManager.RECENT_DISCONNECT_WINDOW_MS;
    this.recentDisconnects = this.recentDisconnects.filter((event) => event.at >= cutoff);
  }

  private getRecentDisconnectStats(): ConnectionRecentDisconnects {
    this.pruneRecentDisconnects();
    const last = this.recentDisconnects.at(-1) ?? null;
    const byReason: Record<string, number> = {};
    for (const event of this.recentDisconnects) {
      byReason[event.reason] = (byReason[event.reason] ?? 0) + 1;
    }
    return {
      windowMs: ConnectionManager.RECENT_DISCONNECT_WINDOW_MS,
      count: this.recentDisconnects.length,
      lastAt: last ? toIso(last.at) : null,
      lastReason: last?.reason ?? null,
      lastStatusCode: last?.statusCode ?? null,
      byReason,
    };
  }

  private persistConnectionRuntimeState(
    event: string,
    planning: {
      backoffMs?: number;
      nextReconnectAt?: number;
      cooldownMs?: number;
      cooldownUntil?: number;
    } = {},
  ): void {
    if (!config.dataRoot) return;

    const authBond = this.authBond.inspect();
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      event,
      redaction: {
        version: 1,
        policy: 'no raw JIDs, phone numbers, credential paths, backup paths, tokens, or auth key material',
      },
      environment: {
        instance: config.botName,
        host: hostname(),
        pid: process.pid,
        nodeVersion: process.version,
        platform: platform(),
        arch: arch(),
        release: release(),
        healthPort: config.healthPort,
        provider: config.agentProvider,
      },
      connection: {
        state: this.connectionState,
        connected: this.connectionState === 'connected' && this.botJid !== null,
        stateChangedAt: new Date(this.stateChangedAt).toISOString(),
        reconnectAttempts: this.reconnectAttempts,
        reconnectPhase: this.connectionState === 'connected' ? null : this.reconnectPhase,
        firstFailureAt: toIso(this.firstFailureAt),
        lastPingAt: toIso(this.lastPingAt),
        lastPongAt: toIso(this.lastPongAt),
        lastDisconnectReason: this.lastDisconnectReason,
        lastStatusCode: this.lastStatusCode,
        recentDisconnects: this.getRecentDisconnectStats(),
        connectStartedAt: toIso(this.connectStartedAt),
        lastOpenAt: toIso(this.lastOpenAt),
        lastCloseAt: toIso(this.lastCloseAt),
        lastQrAt: toIso(this.lastQrAt),
        lastCredsUpdateAt: toIso(this.lastCredsUpdateAt),
        lastCredsUpdateFailedAt: toIso(this.lastCredsUpdateFailedAt),
        credsUpdateCount: this.credsUpdateCount,
        authSnapshotCaptureCount: this.authSnapshotCaptureCount,
        authSnapshotFailureCount: this.authSnapshotFailureCount,
        backoffMs: planning.backoffMs ?? null,
        nextReconnectAt: toIso(planning.nextReconnectAt ?? null),
        cooldownMs: planning.cooldownMs ?? null,
        cooldownUntil: toIso(planning.cooldownUntil ?? null),
      },
      authBond: {
        status: authBond.status,
        issues: [...authBond.issues],
        credsExists: authBond.creds.exists,
        credsMode: authBond.creds.mode,
        credsSize: authBond.creds.size,
        credsHash: shortHashOrNull(authBond.creds.sha256),
        identityHash: authBond.meHash,
        treeHash: shortHashOrNull(authBond.treeHash),
        latestBackupAt: authBond.backup.latestAt,
        latestBackupReason: authBond.backup.latestReason,
        lastCaptureAt: authBond.backup.lastCaptureAt,
        lastCaptureReason: authBond.backup.lastCaptureReason,
        lastCaptureError: authBond.backup.lastCaptureError,
        lastCaptureDeferredAt: authBond.backup.lastCaptureDeferredAt,
        lastCaptureDeferredReason: authBond.backup.lastCaptureDeferredReason,
        lastCaptureDeferredAgeMs: authBond.backup.lastCaptureDeferredAgeMs,
        lastRestoreAt: authBond.backup.lastRestoreAt,
        lastRestoreError: authBond.backup.lastRestoreError,
      },
      diagnostics: {
        stateFile: 'connection-state.json',
        stateFileFingerprint: shortHash(join(config.dataRoot, 'connection-state.json'), 20),
      },
    };

    try {
      writePrivateJsonMarkerSync(join(config.dataRoot, 'connection-state.json'), payload);
    } catch (err) {
      this.log.warn({ err }, 'failed to persist connection runtime state');
    }
  }

  // -------------------------------------------------------------------------
  // Event registration
  // -------------------------------------------------------------------------

  private registerEventHandlers(sock: WhatsAppSocket, saveCreds: () => Promise<void>): void {
    sock.ev.process(async (events) => {
      // Stale-socket guard: drop events from a socket that is no longer current
      if (this.sock !== sock) return;

      if (events['connection.update']) {
        this.handleConnectionUpdate(sock, events['connection.update']);
      }

      if (events['creds.update']) {
        try {
          await saveCreds();
          this.clearAuthSnapshotSettledTimer();
          this.lastCredsUpdateAt = Date.now();
          this.credsUpdateCount += 1;
          this.recordCredentialLifecycle('creds_update_saved', { authBond: this.authBond.inspect() });
          this.persistConnectionRuntimeState('creds_update_saved');
          this.log.info('Credentials saved');
        } catch (err) {
          this.lastCredsUpdateFailedAt = Date.now();
          this.recordCredentialLifecycle('creds_update_failed', {
            authBond: this.authBond.inspect(),
            note: errorMessage(err),
          });
          this.persistConnectionRuntimeState('creds_update_failed');
          this.log.error({ err }, 'Failed to save credentials');
        }
      }

      if (this.hasAuthKeyMaterialChurnSignal(events)) {
        this.scheduleSettledAuthBondSnapshot('baileys-key-material-settled');
      }

      if (events['messages.upsert']) {
        this.handleMessagesUpsert(events['messages.upsert']);
      }

      if (events['messages.update']) {
        this.handleMessagesUpdate(events['messages.update'] as any[]);
      }

      if (events['messages.delete']) {
        this.handleMessagesDelete(events['messages.delete'] as any);
      }

      if (events['contacts.upsert']) {
        const contacts = events['contacts.upsert'] as Array<{
          id: string;
          name?: string;
          notify?: string;
        }>;
        this.emit('contactsUpsert', contacts);
      }

      if (events['contacts.update']) {
        const updates = events['contacts.update'] as Array<{
          id: string;
          notify?: string;
          name?: string;
        }>;
        this.emit('contactsUpdate', updates);
      }

      if (events['presence.update']) {
        this.handlePresenceUpdate(events['presence.update'] as any);
      }

      if (events['call']) {
        this.handleCall(sock, events['call'] as any[]);
      }

      if (events['group-participants.update']) {
        const update = events['group-participants.update'] as any;
        const { id, author, participants, action } = update;
        this.log.info({ groupJid: id, author, participants, action }, 'group participants update');
        this.emit('groupParticipantsUpdate', {
          groupJid: id,
          author: author ?? '',
          participants: participants ?? [],
          action,
        });

        // Existing bot-removal detection
        if (action === 'remove') {
          const botRemoved = (participants || []).some(
            (p: string) => p === this.botJid || p === this.botLid
          );
          if (botRemoved) {
            this.log.warn({ groupJid: id }, 'bot was removed from group');
          }
        }
      }

      if (events['lid-mapping.update']) {
        const mapping = events['lid-mapping.update'] as { lid?: string; pn?: string };
        if (mapping.lid && mapping.pn) {
          const conversationKey = toConversationKey(mapping.lid);
          this.log.info({ lid: mapping.lid, pn: mapping.pn, conversationKey }, 'LID mapping updated');
          this.emit('jidAliasChanged', conversationKey, mapping.pn);
        }
      }

      try {
        if (events['messages.reaction']) {
          const raw = events['messages.reaction'];
          const reactions = Array.isArray(raw) ? raw as Array<{
            key: { remoteJid?: string; id?: string; fromMe?: boolean };
            reaction: { text: string; key: { remoteJid?: string; participant?: string } };
          }> : [];
          for (const r of reactions) {
            const messageId = r.key.id;
            const remoteJid = r.key.remoteJid;
            if (!messageId || !remoteJid) continue;
            const conversationKey = toConversationKey(remoteJid);
            const senderJid = r.reaction.key.participant ?? r.reaction.key.remoteJid ?? '';
            this.emit('reactionReceived', {
              messageId,
              conversationKey,
              senderJid,
              reaction: r.reaction.text ?? '',
            });
          }
        }
      } catch (err) {
        this.log.error({ err, event: 'messages.reaction' }, 'event handler failed');
      }

      try {
        if (events['message-receipt.update']) {
          const raw = events['message-receipt.update'];
          const receipts = Array.isArray(raw) ? raw as Array<{
            key: { id?: string };
            receipt: { userJid?: string; receiptTimestamp?: number; readTimestamp?: number; playedTimestamp?: number };
          }> : [];
          for (const r of receipts) {
            const messageId = r.key.id;
            const recipientJid = r.receipt?.userJid;
            if (!messageId || !recipientJid) continue;
            this.confirmLocalAuthBondSendProof(messageId, 'receipt_update', recipientJid);
            // Determine receipt type from which timestamp fields are present
            let type = 'server'; // default: server acknowledgement (single tick)
            if (r.receipt.playedTimestamp) type = 'played';
            else if (r.receipt.readTimestamp) type = 'read';
            else if (r.receipt.receiptTimestamp) type = 'delivery';
            this.emit('receiptUpdate', { messageId, recipientJid, type });
          }
        }
      } catch (err) {
        this.log.error({ err, event: 'message-receipt.update' }, 'event handler failed');
      }

      try {
        if (events['messages.media-update']) {
          const raw = events['messages.media-update'];
          const updates = Array.isArray(raw) ? raw as Array<{
            key: { id: string };
            update: Record<string, unknown>;
          }> : [];
          this.log.info({ count: updates.length }, 'media update received');
          this.emit('mediaUpdate', updates);
        }
      } catch (err) {
        this.log.error({ err, event: 'messages.media-update' }, 'event handler failed');
      }

      try {
        if (events['chats.upsert']) {
          const raw = events['chats.upsert'];
          const chats = Array.isArray(raw) ? raw as Array<{ id: string; [key: string]: unknown }> : [];
          this.emit('chatsUpsert', chats);
        }
      } catch (err) {
        this.log.error({ err, event: 'chats.upsert' }, 'event handler failed');
      }

      try {
        if (events['chats.update']) {
          const raw = events['chats.update'];
          const updates = Array.isArray(raw) ? raw as Array<{ id: string; [key: string]: unknown }> : [];
          this.emit('chatsUpdate', updates);
        }
      } catch (err) {
        this.log.error({ err, event: 'chats.update' }, 'event handler failed');
      }

      try {
        if (events['chats.delete']) {
          const raw = events['chats.delete'];
          const jids = Array.isArray(raw) ? raw as string[] : [];
          this.emit('chatsDelete', jids);
        }
      } catch (err) {
        this.log.error({ err, event: 'chats.delete' }, 'event handler failed');
      }

      try {
        if (events['messaging-history.set']) {
          const data = events['messaging-history.set'] as unknown as {
            messages?: unknown[];
            chats?: Array<{ id: string; [key: string]: unknown }>;
            isLatest?: boolean;
          };
          this.log.info(
            { messageCount: data.messages?.length ?? 0, isLatest: data.isLatest },
            'history sync received',
          );
          if (data.messages && data.messages.length > 0) {
            this.emit('historyMessages', data.messages);
          }
          if (data.chats && data.chats.length > 0) {
            this.emit('chatsUpsert', data.chats);
          }
          this.emit('historySyncComplete');
        }
      } catch (err) {
        this.log.error({ err, event: 'messaging-history.set' }, 'event handler failed');
      }

      try {
        if (events['groups.upsert']) {
          const raw = events['groups.upsert'];
          const groups = Array.isArray(raw) ? raw as Array<{ id: string; subject?: string }> : [];
          this.log.info({ count: groups.length }, 'groups upserted');
          this.emit('groupsUpsert', groups);
        }
      } catch (err) {
        this.log.error({ err, event: 'groups.upsert' }, 'event handler failed');
      }

      try {
        if (events['groups.update']) {
          const raw = events['groups.update'];
          const updates = Array.isArray(raw) ? raw as Array<{ id: string }> : [];
          this.log.info({ count: updates.length }, 'groups updated');
          this.emit('groupsUpdate', updates);
        }
      } catch (err) {
        this.log.error({ err, event: 'groups.update' }, 'event handler failed');
      }

      try {
        if (events['group.join-request']) {
          // NOTE: event name has a dot, not a hyphen
          const request = events['group.join-request'] as { id?: string; author?: string; participant?: string };
          const groupJid = request?.id ?? '';
          const requesterJid = request?.participant ?? '';
          if (groupJid && requesterJid) {
            this.log.info({ groupJid, requesterJid }, 'group join request received');
            this.emit('groupJoinRequest', { groupJid, requesterJid, requestId: '' });
          }
        }
      } catch (err) {
        this.log.error({ err, event: 'group.join-request' }, 'event handler failed');
      }

      try {
        if (events['blocklist.set']) {
          const raw = events['blocklist.set'] as any;
          const jids: string[] = Array.isArray(raw?.blocklist) ? raw.blocklist
                                : Array.isArray(raw) ? raw : [];
          this.log.info({ count: jids.length }, 'blocklist set (full sync)');
          this.emit('blocklistSet', jids);
        }
      } catch (err) {
        this.log.error({ err, event: 'blocklist.set' }, 'event handler failed');
      }

      try {
        if (events['blocklist.update']) {
          const raw = events['blocklist.update'];
          const update = raw as { blocklist?: string[]; type?: string };
          const jids: string[] = Array.isArray(update?.blocklist) ? update.blocklist! : [];
          const type: 'add' | 'remove' = update?.type === 'remove' ? 'remove' : 'add';
          this.log.info({ count: jids.length, type }, 'blocklist update');
          this.emit('blocklistUpdate', { blocklist: jids, type });
        }
      } catch (err) {
        this.log.error({ err, event: 'blocklist.update' }, 'event handler failed');
      }

      try {
        if (events['newsletter.reaction']) {
          const data = events['newsletter.reaction'];
          this.log.info({ data }, 'newsletter reaction received');
          this.emit('newsletterReaction', data);
        }
      } catch (err) {
        this.log.error({ err, event: 'newsletter.reaction' }, 'event handler failed');
      }

      try {
        if (events['newsletter.view']) {
          const data = events['newsletter.view'];
          this.log.info({ data }, 'newsletter view received');
          this.emit('newsletterView', data);
        }
      } catch (err) {
        this.log.error({ err, event: 'newsletter.view' }, 'event handler failed');
      }

      try {
        if (events['newsletter-participants.update']) {
          const data = events['newsletter-participants.update'];
          this.log.info({ data }, 'newsletter participants update received');
          this.emit('newsletterParticipantsUpdate', data);
        }
      } catch (err) {
        this.log.error({ err, event: 'newsletter-participants.update' }, 'event handler failed');
      }

      try {
        if (events['newsletter-settings.update']) {
          const data = events['newsletter-settings.update'];
          this.log.info({ data }, 'newsletter settings update received');
          this.emit('newsletterSettingsUpdate', data);
        }
      } catch (err) {
        this.log.error({ err, event: 'newsletter-settings.update' }, 'event handler failed');
      }

      try {
        if (events['labels.edit']) {
          const raw = events['labels.edit'];
          const labels = Array.isArray(raw) ? raw as Array<{
            id: string;
            name: string;
            color?: number;
            predefinedId?: string;
          }> : [];
          this.log.info({ count: labels.length }, 'labels edit received');
          this.emit('labelsEdit', labels);
        }
      } catch (err) {
        this.log.error({ err, event: 'labels.edit' }, 'event handler failed');
      }

      try {
        if (events['labels.association']) {
          const raw = events['labels.association'] as {
            association?: { labelId?: string; type?: string; chatId?: string; messageId?: string };
            type?: 'add' | 'remove';
          };
          const labelId = raw?.association?.labelId ?? '';
          const assocType = raw?.association?.type ?? 'chat';
          const chatJid = raw?.association?.chatId;
          const messageId = raw?.association?.messageId;
          const operation: 'add' | 'remove' = raw?.type === 'remove' ? 'remove' : 'add';
          if (labelId) {
            this.log.info({ labelId, assocType, chatJid, messageId, operation }, 'labels association received');
            this.emit('labelsAssociation', { labelId, type: assocType, chatJid, messageId, operation });
          }
        }
      } catch (err) {
        this.log.error({ err, event: 'labels.association' }, 'event handler failed');
      }
    });
  }

  // -------------------------------------------------------------------------
  // connection.update
  // -------------------------------------------------------------------------

  private handleConnectionUpdate(sock: WhatsAppSocket, update: any): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // QR code means auth state is missing — the auth CLI must be run separately
      this.lastQrAt = Date.now();
      const snapshot = this.authBond.inspect();
      this.recordCredentialLifecycle('qr_required', { authBond: snapshot });
      this.emitLocalAuthBondFailureAlert('qr-required', snapshot);
      this.persistConnectionRuntimeState('qr_required');
      this.log.warn('QR code received — run the auth CLI to pair this device');
      return;
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0;
      this.reconnectPhase = 'backoff';
      this.firstFailureAt = null;
      this.lastStatusCode = null;
      this.lastDisconnectReason = null;
      this.loggedOutAlertEmitted = false;
      this.unclassified401ReconnectSpent = false;
      this.localAuthAlertEmitted = false;
      this.gracefulReconnectInFlight = false;
      if (this.cooldownTimer !== null) {
        clearTimeout(this.cooldownTimer);
        this.cooldownTimer = null;
      }
      // Extract the bot's own JID and LID from the socket/creds
      const user = (sock as any).user;
      const rawId: string | undefined = user?.id ?? (sock as any).authState?.creds?.me?.id;
      const rawLid: string | undefined = user?.lid ?? (sock as any).authState?.creds?.me?.lid;
      this.botJid = rawId ? jidNormalizedUser(rawId) : null;
      this.botLid = rawLid ? jidNormalizedUser(rawLid) : null;
      const bare = this.botJid ? bareNumber(this.botJid) : undefined;
      this.selfMentionRegexJid = bare ? new RegExp(`@${bare}\\b`, 'g') : null;
      const lidBare = this.botLid ? bareNumber(this.botLid) : undefined;
      this.selfMentionRegexLid = (lidBare && lidBare !== bare) ? new RegExp(`@${lidBare}\\b`, 'g') : null;
      this.setConnectionState('connected');
      this.lastOpenAt = Date.now();
      this.startKeepalive(sock);
      this.captureAuthBondSnapshot('connection-open');
      this.recordCredentialLifecycle('connection_open', { authBond: this.authBond.inspect() });
      this.persistConnectionRuntimeState('connection_open');
      this.log.info({ botJid: this.botJid, botLid: this.botLid }, 'WhatsApp connected');
      return;
    }

    if (connection === 'close') {
      const statusCode: number | undefined = (lastDisconnect?.error as any)?.output?.statusCode;
      const reason = statusCode !== undefined ? (DisconnectReason[statusCode] ?? 'Unknown') : 'Unknown';
      const conflictType = extractStreamErrorConflictType(lastDisconnect);

      this.lastStatusCode = statusCode ?? null;
      this.lastDisconnectReason = reason;
      this.recordDisconnect(statusCode ?? null, reason);
      this.lastCloseAt = Date.now();
      this.lastDisconnectDiagnostic = redactDiagnosticValue(lastDisconnect);

      // Invalidate the stale socket before deciding whether to reconnect
      this.stopKeepalive();
      this.clearAuthSnapshotSettledTimer();
      try { sock.end(undefined); } catch { /* best-effort */ }
      this.sock = null;
      this.clearIdentity();

      let restartRequiredCount = 0;
      if (statusCode === DisconnectReason.restartRequired) {
        const now = Date.now();
        this.restartRequiredTimestamps.push(now);
        this.restartRequiredTimestamps = this.restartRequiredTimestamps.filter(t => now - t < 60_000);
        restartRequiredCount = this.restartRequiredTimestamps.length;
      }

      const actionContext: {
        restartRequiredCount: number;
        conflictType?: string | null;
        unclassified401Attempted?: boolean;
      } = { restartRequiredCount };
      if (conflictType !== undefined) actionContext.conflictType = conflictType;
      if (statusCode === DisconnectReason.loggedOut) {
        actionContext.unclassified401Attempted = this.unclassified401ReconnectSpent;
      }
      const action = decideDisconnectAction(statusCode, actionContext);
      const reconnectDecision = formatReconnectDecision(action);
      this.recordCredentialLifecycle('connection_close', {
        statusCode,
        reason,
        conflictType,
        reconnectDecision,
        lastDisconnectDiagnostic: this.lastDisconnectDiagnostic,
        authBond: this.authBond.inspect(),
      });
      this.persistConnectionRuntimeState('connection_close');

      this.log.warn({ statusCode, reason, conflictType, reconnectDecision }, 'WhatsApp connection closed');

      if (action.type === 'exit') {
        this.setConnectionState('disconnected');
        this.emitDeviceBondLostAlert(statusCode, reason, lastDisconnect, conflictType);
        this.persistConnectionRuntimeState('disconnect_exit_logged_out');
        this.log.error('Logged out — re-authenticate with the auth CLI');
        return;
      }

      if (action.reason === 'auth-401-unclassified') {
        this.unclassified401ReconnectSpent = true;
      }

      if (action.reason === 'restart-required-flapping') {
        this.log.warn(
          { count: action.count },
          'restartRequired flapping detected (%d in <60s) — using backoff reconnect',
          action.count,
        );
        this.restartRequiredTimestamps = [];
        if (!this.shuttingDown) {
          this.scheduleReconnect();
        }
        return;
      }

      if (action.reason === 'restart-required') {
        if (!this.shuttingDown) {
          this.scheduleReconnect();
        }
        return;
      }

      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    }
  }

  private emitDeviceBondLostAlert(
    statusCode: number | undefined,
    reason: string,
    lastDisconnect: unknown,
    conflictType?: string | null,
  ): void {
    if (this.loggedOutAlertEmitted) return;

    const authBond = this.authBond.inspect();
    this.recordCredentialLifecycle('device_bond_lost', {
      statusCode,
      reason,
      conflictType,
      reconnectDecision: 'exit:logged-out',
      lastDisconnectDiagnostic: this.lastDisconnectDiagnostic ?? redactDiagnosticValue(lastDisconnect),
      authBond,
    });
    const lifecycle = this.getCredentialLifecycleSnapshot(authBond);
    const credsPath = join(config.authDir, 'creds.json');
    const lockPath = config.lockPath ?? 'unknown';
    const evidence = [
      'classification: physical_intervention_required',
      'failure: WhatsApp linked-device bond lost or removed by server',
      `instance: ${config.botName}`,
      `host: ${lifecycle.environment.host}`,
      `pid: ${lifecycle.environment.pid}`,
      `healthPort: ${config.healthPort}`,
      `statusCode: ${statusCode ?? 'unknown'}`,
      `reason: ${reason}`,
      `connectionState: ${this.connectionState}`,
      `latestBaileysVersion: ${lifecycle.latestBaileysVersion ?? 'unknown'}`,
      `connectStartedAt: ${lifecycle.connectStartedAt ?? 'unknown'}`,
      `lastOpenAt: ${lifecycle.lastOpenAt ?? 'unknown'}`,
      `lastCloseAt: ${lifecycle.lastCloseAt ?? 'unknown'}`,
      `lastQrAt: ${lifecycle.lastQrAt ?? 'none'}`,
      `lastCredsUpdateAt: ${lifecycle.lastCredsUpdateAt ?? 'unknown'}`,
      `lastCredsUpdateFailedAt: ${lifecycle.lastCredsUpdateFailedAt ?? 'none'}`,
      `lastAuthSnapshotAt: ${lifecycle.lastAuthSnapshotAt ?? 'unknown'}`,
      `lastAuthSnapshotFailedAt: ${lifecycle.lastAuthSnapshotFailedAt ?? 'none'}`,
      `credsUpdateCount: ${lifecycle.credsUpdateCount}`,
      `authSnapshotCaptureCount: ${lifecycle.authSnapshotCaptureCount}`,
      `authSnapshotFailureCount: ${lifecycle.authSnapshotFailureCount}`,
      `authBondStatus: ${lifecycle.currentAuthBond.status}`,
      `authBondIssues: ${lifecycle.currentAuthBond.issues.length > 0 ? lifecycle.currentAuthBond.issues.join(',') : 'none'}`,
      `credsMode: ${lifecycle.currentAuthBond.creds.mode ?? 'unknown'}`,
      `credsSize: ${lifecycle.currentAuthBond.creds.size ?? 'unknown'}`,
      `credsMtime: ${lifecycle.currentAuthBond.creds.mtime ?? 'unknown'}`,
      `credsHash: ${lifecycle.currentAuthBond.creds.hash ?? 'unknown'}`,
      `identityHash: ${lifecycle.currentAuthBond.creds.identityHash ?? 'unknown'}`,
      `treeHash: ${lifecycle.currentAuthBond.treeHash ?? 'unknown'}`,
      `latestBackup: ${lifecycle.currentAuthBond.backup.latest ?? 'none'}`,
      `latestBackupAt: ${lifecycle.currentAuthBond.backup.latestAt ?? 'none'}`,
      `latestBackupReason: ${lifecycle.currentAuthBond.backup.latestReason ?? 'none'}`,
      `authDir: ${config.authDir} ${summarizePath(config.authDir)}`,
      `creds: ${credsPath} ${summarizePath(credsPath)}`,
      `lockPath: ${lockPath} ${lockPath === 'unknown' ? 'unknown' : summarizePath(lockPath)}`,
      `dataRoot: ${config.dataRoot ?? 'unknown'}`,
      `stateRoot: ${config.stateRoot ?? 'unknown'}`,
      `lastDisconnectSanitized: ${compactJson(this.lastDisconnectDiagnostic ?? redactDiagnosticValue(lastDisconnect))}`,
      `recentCredentialLifecycle: ${compactJson(lifecycle.recentEvents)}`,
      `redaction: ${lifecycle.redaction.policy}`,
      'operator_note: local auth restore can repair disk/config loss only; a server-side 401 device_removed requires verified WhatsApp re-link approval.',
      'q_action: investigate duplicate auth material, recent restarts, auth directory mutation, launchd/service overlap, and preserve auth backups before any destructive auth cleanup.',
    ].join('\n');

    try {
      this.loggedOutAlertEmitted = emitAlertChecked(
        config.botName,
        'whatsapp_device_bond_lost',
        `PHYSICAL INTERVENTION REQUIRED: whatsoup@${config.botName} lost WhatsApp linked-device bond`,
        evidence,
        'critical',
        this.deviceBondLostCriticalAsset(statusCode, reason),
      );
    } catch (err) {
      this.log.error({ err }, 'failed to enqueue WhatsApp device bond lost alert');
    }
  }

  private deviceBondLostCriticalAsset(
    statusCode: number | undefined,
    reason: string,
  ): BotErrorsCriticalAssetDiagnostic {
    const lifecycle = this.getCredentialLifecycleSnapshot();
    return {
      asset: {
        kind: 'whatsapp_linked_device',
        instance: config.botName,
        owner: 'whatsoup',
        path: config.authDir,
      },
      failure: {
        code: 'WA_AUTH_BOND_SERVER_REVOKED',
        domain: 'account_linkage',
        recoverability: 'manual_relink_required',
        confidence: statusCode === DisconnectReason.loggedOut || reason === 'loggedOut' ? 'confirmed' : 'probable',
        operatorAction: 'Preserve auth material and backups, investigate duplicate sessions/service overlap, and use phone-side WhatsApp relink only after non-physical recovery evidence is exhausted.',
        clearRequirement: 'clear only after WhatsApp is connected with a non-empty auth bond and a successful outbound send after the relinked creds mtime and after the incident',
      },
      evidenceRefs: [
        `status_code=${statusCode ?? 'unknown'}`,
        `disconnect_reason=${reason}`,
        `auth_dir=${config.authDir}`,
        `host=${lifecycle.environment.host}`,
        `latest_baileys_version=${lifecycle.latestBaileysVersion ?? 'unknown'}`,
        `last_open_at=${lifecycle.lastOpenAt ?? 'unknown'}`,
        `last_close_at=${lifecycle.lastCloseAt ?? 'unknown'}`,
        `last_creds_update_at=${lifecycle.lastCredsUpdateAt ?? 'unknown'}`,
        `creds_update_count=${lifecycle.credsUpdateCount}`,
        `auth_snapshot_count=${lifecycle.authSnapshotCaptureCount}`,
        `auth_bond_status=${lifecycle.currentAuthBond.status}`,
        `auth_bond_issues=${lifecycle.currentAuthBond.issues.join(',') || 'none'}`,
        `creds_hash=${lifecycle.currentAuthBond.creds.hash ?? 'unknown'}`,
        `tree_hash=${lifecycle.currentAuthBond.treeHash ?? 'unknown'}`,
      ],
    };
  }

  private captureAuthBondSnapshot(reason: string): void {
    const result = this.authBond.capture(reason);
    if (result.ok) {
      this.lastAuthSnapshotAt = Date.now();
      this.authSnapshotCaptureCount += 1;
      this.recordCredentialLifecycle('auth_snapshot_captured', {
        authBond: result.snapshot,
        note: result.captured ? result.path ?? 'captured' : result.path ? `reused:${result.path}` : 'unchanged',
      });
      if (result.captured) {
        this.log.info({ backupPath: result.path, reason }, 'auth bond snapshot captured');
      }
      return;
    }
    if (result.deferred) {
      this.recordCredentialLifecycle('auth_snapshot_skipped', {
        authBond: result.snapshot,
        note: result.error ?? 'credential-write-in-flight',
      });
      this.log.warn({ error: result.error, reason }, 'auth bond snapshot deferred while credential write settles');
      return;
    }
    this.lastAuthSnapshotFailedAt = Date.now();
    this.authSnapshotFailureCount += 1;
    this.recordCredentialLifecycle('auth_snapshot_failed', {
      authBond: result.snapshot,
      note: result.error ?? 'unknown',
    });
    this.log.error({ error: result.error, reason }, 'auth bond snapshot failed');
    this.emitLocalAuthBondFailureAlert(reason, result.snapshot);
  }

  private hasAuthKeyMaterialChurnSignal(events: Record<string, unknown>): boolean {
    return [
      'messages.upsert',
      'messages.update',
      'message-receipt.update',
      'messages.reaction',
      'messages.media-update',
      'group-participants.update',
      'groups.upsert',
      'groups.update',
      'messaging-history.set',
      'lid-mapping.update',
    ].some(eventName => events[eventName] !== undefined);
  }

  private scheduleSettledAuthBondSnapshot(reason: string): void {
    if (this.authSnapshotSettledTimer !== null) return;
    if (this.shuttingDown || this.loggedOutAlertEmitted) return;
    if (this.connectionState !== 'connected' || !this.sock) return;

    this.recordCredentialLifecycle('auth_snapshot_scheduled', {
      authBond: this.authBond.inspect(),
      note: reason,
    });

    this.authSnapshotSettledTimer = setTimeout(() => {
      this.authSnapshotSettledTimer = null;
      if (this.shuttingDown || this.loggedOutAlertEmitted) return;
      if (this.connectionState !== 'connected' || !this.sock) return;

      const now = Date.now();
      if (
        this.lastSettledAuthSnapshotAttemptAt !== null
        && now - this.lastSettledAuthSnapshotAttemptAt < ConnectionManager.AUTH_BOND_SETTLED_SNAPSHOT_MIN_INTERVAL_MS
      ) {
        this.recordCredentialLifecycle('auth_snapshot_skipped', {
          authBond: this.authBond.inspect(),
          note: 'settled-snapshot-min-interval',
        });
        return;
      }

      this.lastSettledAuthSnapshotAttemptAt = now;
      this.captureAuthBondSnapshot(reason);
      this.persistConnectionRuntimeState('auth_snapshot_settled');
    }, ConnectionManager.AUTH_BOND_SETTLED_SNAPSHOT_DELAY_MS);
    this.authSnapshotSettledTimer.unref?.();
  }

  private clearAuthSnapshotSettledTimer(): void {
    if (this.authSnapshotSettledTimer === null) return;
    clearTimeout(this.authSnapshotSettledTimer);
    this.authSnapshotSettledTimer = null;
  }

  private pruneAuthBondSendProofs(now = Date.now()): void {
    const cutoff = now - ConnectionManager.AUTH_BOND_CLEAR_PROOF_TTL_MS;
    for (const [messageId, candidate] of this.pendingAuthBondClearSends.entries()) {
      if (candidate.submittedAt < cutoff) this.pendingAuthBondClearSends.delete(messageId);
    }
    for (const [messageId, proof] of this.confirmedAuthBondSendProofs.entries()) {
      if (proof.confirmedAt < cutoff) this.confirmedAuthBondSendProofs.delete(messageId);
    }
  }

  private queueLocalAuthBondClearCandidate(operation: string, messageId: string | null): void {
    if (!this.localAuthAlertEmitted || !messageId) return;
    const now = Date.now();
    this.pruneAuthBondSendProofs(now);
    const candidate: AuthBondClearCandidate = { operation, messageId, submittedAt: now };
    this.pendingAuthBondClearSends.set(messageId, candidate);
    const proof = this.confirmedAuthBondSendProofs.get(messageId);
    if (proof) this.clearLocalAuthBondFailureAfterVerifiedSend(candidate, proof);
  }

  private confirmLocalAuthBondSendProof(
    messageId: string,
    source: AuthBondSendProof['source'],
    recipientJid?: string,
  ): void {
    const now = Date.now();
    this.pruneAuthBondSendProofs(now);
    const proof: AuthBondSendProof = { source, messageId, recipientJid, confirmedAt: now };
    this.confirmedAuthBondSendProofs.set(messageId, proof);
    const candidate = this.pendingAuthBondClearSends.get(messageId);
    if (candidate) this.clearLocalAuthBondFailureAfterVerifiedSend(candidate, proof);
  }

  private clearLocalAuthBondFailureAfterVerifiedSend(
    candidate: AuthBondClearCandidate,
    proof: AuthBondSendProof,
  ): void {
    if (!this.localAuthAlertEmitted) return;
    if (this.connectionState !== 'connected' || this.botJid === null) return;

    const snapshot = this.authBond.inspect();
    if (!this.isVerifiedLocalAuthSnapshot(snapshot)) return;

    const evidence = [
      `repair_lane:${config.botName}`,
      `confirmed_send_operation=${candidate.operation}`,
      `confirmed_send_message_id=${candidate.messageId}`,
      `confirmed_send_proof=${proof.source}`,
      `confirmed_send_recipient=${proof.recipientJid ?? 'unknown'}`,
      `confirmed_send_submitted_at=${new Date(candidate.submittedAt).toISOString()}`,
      `confirmed_send_at=${new Date(proof.confirmedAt).toISOString()}`,
      `status=${snapshot.status}`,
      `issues=${snapshot.issues.length > 0 ? snapshot.issues.join(',') : 'none'}`,
      `creds_size=${snapshot.creds.size ?? 'unknown'}`,
      `creds_hash=${snapshot.creds.sha256?.slice(0, 20) ?? 'unknown'}`,
      `tree_hash=${snapshot.treeHash?.slice(0, 20) ?? 'unknown'}`,
      `latest_backup=${snapshot.backup.latest ?? 'none'}`,
      `latest_backup_at=${snapshot.backup.latestAt ?? 'none'}`,
    ].join('\n');
    if (clearAlertSourceChecked(
      config.botName,
      'whatsapp_auth_bond_local_failure',
      evidence,
      this.localAuthBondClearCriticalAsset(snapshot),
    )) {
      this.localAuthAlertEmitted = false;
    }
    this.pendingAuthBondClearSends.delete(candidate.messageId);
    this.confirmedAuthBondSendProofs.delete(candidate.messageId);
  }

  private isVerifiedLocalAuthSnapshot(snapshot: AuthBondSnapshot): boolean {
    if (snapshot.status !== 'present') return false;
    if (snapshot.creds.exists !== true) return false;
    if ((snapshot.creds.size ?? 0) <= 0) return false;
    if (!snapshot.creds.sha256 || snapshot.creds.sha256 === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') return false;
    if (!snapshot.treeHash) return false;
    if (!snapshot.backup.latest) return false;
    return true;
  }

  private emitLocalAuthBondFailureAlert(reason: string, snapshot: AuthBondSnapshot): void {
    if (this.localAuthAlertEmitted) return;

    const evidence = [
      'classification: physical_intervention_risk',
      'failure: local WhatsApp auth bond is missing, invalid, or cannot be snapshotted',
      `instance: ${config.botName}`,
      `healthPort: ${config.healthPort}`,
      `reason: ${reason}`,
      `status: ${snapshot.status}`,
      `issues: ${snapshot.issues.length > 0 ? snapshot.issues.join(',') : 'none'}`,
      `authDir: ${snapshot.authDir.path} exists=${snapshot.authDir.exists} mode=${snapshot.authDir.mode ?? 'unknown'} mtime=${snapshot.authDir.mtime ?? 'unknown'}`,
      `creds: ${snapshot.creds.path} exists=${snapshot.creds.exists} mode=${snapshot.creds.mode ?? 'unknown'} size=${snapshot.creds.size ?? 'unknown'} mtime=${snapshot.creds.mtime ?? 'unknown'}`,
      `credsHash: ${snapshot.creds.sha256?.slice(0, 20) ?? 'unknown'}`,
      `meHash: ${snapshot.meHash ?? 'unknown'}`,
      `treeHash: ${snapshot.treeHash?.slice(0, 20) ?? 'unknown'}`,
      `backupRoot: ${snapshot.backup.root}`,
      `latestBackup: ${snapshot.backup.latest ?? 'none'}`,
      `latestBackupAt: ${snapshot.backup.latestAt ?? 'none'}`,
      `lastCaptureError: ${snapshot.backup.lastCaptureError ?? 'none'}`,
      `lastCaptureDeferredAt: ${snapshot.backup.lastCaptureDeferredAt ?? 'none'}`,
      `lastCaptureDeferredReason: ${snapshot.backup.lastCaptureDeferredReason ?? 'none'}`,
      `lastCaptureDeferredAgeMs: ${snapshot.backup.lastCaptureDeferredAgeMs ?? 'none'}`,
      `lastRestoreError: ${snapshot.backup.lastRestoreError ?? 'none'}`,
      'operator_note: local auto-restore can repair missing/corrupt auth files from protected snapshots; it cannot reverse a WhatsApp server-side device_removed/logout.',
      'q_action: inspect auth directory permissions, recent credential writes, backup availability, duplicate auth hashes, and service overlap before re-pairing or deleting auth material.',
    ].join('\n');

    try {
      this.localAuthAlertEmitted = emitAlertChecked(
        config.botName,
        'whatsapp_auth_bond_local_failure',
        `LOCAL AUTH BOND FAILURE: whatsoup@${config.botName} WhatsApp credentials are at risk`,
        evidence,
        'critical',
        this.localAuthBondFailureCriticalAsset(reason, snapshot),
      );
    } catch (err) {
      this.log.error({ err }, 'failed to enqueue local auth bond failure alert');
    }
  }

  private localAuthBondFailureCriticalAsset(
    reason: string,
    snapshot: AuthBondSnapshot,
  ): BotErrorsCriticalAssetDiagnostic {
    const hasBackup = typeof snapshot.backup.latest === 'string' && snapshot.backup.latest.length > 0;
    const issueText = snapshot.issues.join(',');
    let code = 'WA_AUTH_BOND_LOCAL_INVALID';
    let recoverability: BotErrorsCriticalAssetDiagnostic['failure']['recoverability'] = hasBackup
      ? 'auto_recoverable'
      : 'manual_repair_required';
    if (snapshot.status === 'missing') {
      code = hasBackup ? 'WA_AUTH_BOND_LOCAL_MISSING_RESTORABLE' : 'WA_AUTH_BOND_LOCAL_MISSING_UNRESTORABLE';
    } else if (reason.includes('creds-update') || snapshot.backup.lastCaptureError) {
      code = 'WA_AUTH_BOND_SNAPSHOT_CAPTURE_FAILED';
      recoverability = 'manual_repair_required';
    } else if (issueText.includes('mode') || issueText.includes('permission')) {
      code = 'WA_AUTH_BOND_PERMISSION_DRIFT';
    } else if (hasBackup) {
      code = 'WA_AUTH_BOND_LOCAL_CORRUPT_RESTORABLE';
    } else {
      code = 'WA_AUTH_BOND_LOCAL_CORRUPT_UNRESTORABLE';
    }

    return {
      asset: {
        kind: 'whatsapp_auth_bond',
        instance: config.botName,
        owner: 'whatsoup',
        path: config.authDir,
        fingerprint: snapshot.meHash ?? snapshot.creds.sha256?.slice(0, 20) ?? undefined,
      },
      failure: {
        code,
        domain: 'credential_integrity',
        recoverability,
        confidence: snapshot.status === 'present' && snapshot.issues.length === 0 ? 'suspected' : 'confirmed',
        operatorAction: 'Preserve current auth tree and protected snapshots, inspect permissions/corruption/service overlap, and prefer verified local restore before any phone-side relink.',
        clearRequirement: 'clear only after auth bond is present, non-empty, backed up, and a post-repair WhatsApp send is confirmed by receipt or echo proof',
      },
      evidenceRefs: [
        `reason=${reason}`,
        `status=${snapshot.status}`,
        `issues=${snapshot.issues.join(',') || 'none'}`,
        `latest_backup=${snapshot.backup.latest ?? 'none'}`,
      ],
    };
  }

  private localAuthBondClearCriticalAsset(snapshot: AuthBondSnapshot): BotErrorsCriticalAssetDiagnostic {
    return {
      asset: {
        kind: 'whatsapp_auth_bond',
        instance: config.botName,
        owner: 'whatsoup',
        path: config.authDir,
        fingerprint: snapshot.meHash ?? snapshot.creds.sha256?.slice(0, 20) ?? undefined,
      },
      failure: {
        code: 'WA_AUTH_BOND_LOCAL_REPAIR_VERIFIED',
        domain: 'credential_integrity',
        recoverability: 'operator_recoverable',
        confidence: 'confirmed',
        operatorAction: 'No further action for this local auth-bond incident unless the same source reopens.',
        clearRequirement: 'auth bond present, non-empty, backed by latest snapshot, connected socket, and confirmed outbound send proof',
      },
      evidenceRefs: [
        `status=${snapshot.status}`,
        `issues=${snapshot.issues.join(',') || 'none'}`,
        `latest_backup=${snapshot.backup.latest ?? 'none'}`,
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Reconnection with three-phase backoff
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    // Single-flight guard
    if (this.reconnectTimer !== null || this.cooldownTimer !== null) return;

    // Record the first failure time for max-duration tracking
    if (this.firstFailureAt === null) {
      this.firstFailureAt = Date.now();
    }

    // Check total elapsed since first failure
    const elapsedMs = Date.now() - this.firstFailureAt;
    if (elapsedMs > ConnectionManager.MAX_FAILURE_DURATION_MS) {
      this.log.fatal({ elapsedMs }, 'Connection failed for over 30 minutes — emitting exhausted');
      this.persistConnectionRuntimeState('connection_exhausted');
      emitAlertChecked(
        config.botName,
        'connection_exhausted',
        `whatsoup@${config.botName} connection exhausted after ${Math.round(elapsedMs / 60_000)}min`,
        `Reconnect phases exhausted. Elapsed: ${Math.round(elapsedMs / 1000)}s. Last disconnect: ${this.lastDisconnectReason ?? 'unknown'} (code ${this.lastStatusCode ?? 'none'})`,
      );
      this.emit('exhausted');
      return;
    }

    if (this.reconnectPhase === 'backoff' || this.reconnectPhase === 'retry') {
      if (this.reconnectAttempts >= ConnectionManager.MAX_RECONNECT_ATTEMPTS) {
        // Enter cooldown phase
        this.log.info(
          { attempts: this.reconnectAttempts, phase: this.reconnectPhase },
          `Max attempts reached — entering ${ConnectionManager.COOLDOWN_MS / 1000}s cooldown`,
        );
        this.reconnectPhase = 'cooldown';
        this.setConnectionState('cooldown');
        const cooldownUntil = Date.now() + ConnectionManager.COOLDOWN_MS;
        this.persistConnectionRuntimeState('reconnect_cooldown_entered', {
          cooldownMs: ConnectionManager.COOLDOWN_MS,
          cooldownUntil,
        });
        this.cooldownTimer = setTimeout(() => {
          this.cooldownTimer = null;
          this.reconnectAttempts = 0;
          this.reconnectPhase = 'retry';
          this.setConnectionState('reconnecting');
          this.persistConnectionRuntimeState('reconnect_cooldown_elapsed');
          void this.connect();
        }, ConnectionManager.COOLDOWN_MS);
        this.cooldownTimer.unref?.();
        return;
      }

      this.reconnectAttempts += 1;
      const backoffMs = jitteredDelay(
        ConnectionManager.BASE_BACKOFF_MS,
        this.reconnectAttempts - 1,
        ConnectionManager.MAX_BACKOFF_MS,
      );

      this.log.info(
        { attempt: this.reconnectAttempts, backoffMs, phase: this.reconnectPhase },
        'Scheduling reconnect',
      );
      this.setConnectionState('reconnecting');
      const nextReconnectAt = Date.now() + backoffMs;
      this.persistConnectionRuntimeState('reconnect_scheduled', { backoffMs, nextReconnectAt });

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.setConnectionState('connecting');
        this.persistConnectionRuntimeState('reconnect_timer_elapsed');
        void this.connect();
      }, backoffMs);
      this.reconnectTimer.unref?.();
      return;
    }

    // reconnectPhase === 'cooldown' — already waiting, nothing to do
  }

  // -------------------------------------------------------------------------
  // messages.upsert
  // -------------------------------------------------------------------------

  private handleMessagesUpsert(data: any): void {
    const { messages, type } = data;
    // Only process real-time and appended messages, not full history syncs
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages as WAMessage[]) {
      if (msg.key.id && msg.key.fromMe === true) {
        this.confirmLocalAuthBondSendProof(msg.key.id, 'own_message_echo', msg.key.remoteJid ?? undefined);
      }

      // Detect CIPHERTEXT stubs — decryption failed
      if ((msg as any).messageStubType === 2 && !msg.message) {
        const senderJid = msg.key.participant ?? msg.key.remoteJid ?? '';
        this.emit('decryptionFailure', {
          messageId: msg.key.id!,
          chatJid: msg.key.remoteJid!,
          senderJid,
          errorMessage: (msg as any).messageStubParameters?.[0] ?? 'unknown decryption error',
          rawKey: {
            remoteJid: msg.key.remoteJid!,
            id: msg.key.id!,
            fromMe: msg.key.fromMe ?? false,
          },
          timestamp: normalizeUnixTimestampSeconds(msg.messageTimestamp),
        });
        continue;
      }

      // L3: Mine LID↔phone pairs from message key's participant + participantAlt.
      // Baileys provides participantAlt as the alternate addressing form (PN when
      // participant is LID, or vice versa). This is a major untapped mapping source.
      const participant = msg.key.participant as string | undefined;
      const participantAlt = (msg.key as any).participantAlt as string | undefined;
      if (participant && participantAlt) {
        this.emit('lidPairDiscovered', participant, participantAlt);
      }

      // Poll vote detection — decrypt and emit before general parsing.
      // pollUpdateMessage arrives in messages.upsert (Baileys' process-message
      // poll branch is commented out in this version, so messages.update does NOT
      // carry decoded pollUpdates). We decrypt manually using stored messageSecret.
      const innerMsg = (msg.message as any);
      const pollUpdate = innerMsg?.pollUpdateMessage
        ?? innerMsg?.ephemeralMessage?.message?.pollUpdateMessage;
      if (pollUpdate) {
        this.pollVoteDecryptor.handlePollVote(msg, pollUpdate);
        // Fall through to parseIncomingMessage — it sets isResponseWorthy=false,
        // so the vote gets stored in DB but doesn't trigger an agent session.
      }

      const parsed = parseIncomingMessage(msg);
      if (parsed) {
        // Build contacts directory from every incoming sender for @mention resolution
        this.contactsDir.observe(parsed.senderJid, parsed.senderName);

        if (this.onMessage) {
          try {
            this.onMessage(parsed);
          } catch (err) {
            this.log.warn({ err, messageId: parsed.messageId }, 'onMessage callback threw');
          }
        }
      }
    }
  }

  /** Atomically clears all grace timers and pendingPolls state for a given poll. */
  public clearPollTracking(pollMessageId: string): void {
    this.pollVoteDecryptor.clearTracking(pollMessageId);
  }

  // -------------------------------------------------------------------------
  // messages.update — edits and deletions via protocol messages
  // -------------------------------------------------------------------------

  private handleMessagesUpdate(updates: any[]): void {
    for (const update of updates) {
      // Edited message: update.update.message contains editedMessage
      const editedMsg = update.update?.message?.editedMessage?.message;
      if (editedMsg) {
        const newContent =
          editedMsg.conversation ??
          editedMsg.extendedTextMessage?.text ??
          null;
        if (update.key?.id && newContent !== null) {
          this.emit('messageEdited', update.key.id as string, newContent as string);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // messages.delete
  // -------------------------------------------------------------------------

  private handleMessagesDelete(data: any): void {
    // data can be { keys: WAMessageKey[] } or { jid: string; all: true }
    if (data?.keys) {
      const ids: string[] = (data.keys as any[])
        .map((k: any) => k?.id)
        .filter(Boolean);
      if (ids.length > 0) {
        this.emit('messageDeleted', ids);
      }
    }
    if (data?.all && data?.jid) {
      // Clear-chat: mark all messages in this conversation as deleted
      this.emit('chatCleared', data.jid);
    }
  }

  // -------------------------------------------------------------------------
  // presence.update
  // -------------------------------------------------------------------------

  private handlePresenceUpdate(data: any): void {
    // data: { id: string; presences: Record<string, { lastKnownPresence: string; lastSeen?: number }> }
    const { id: chatJid, presences } = data;
    if (!presences) return;

    for (const [participantJid, presence] of Object.entries(presences as Record<string, any>)) {
      const status: string = presence.lastKnownPresence ?? 'unknown';
      const lastSeen: number | undefined = presence.lastSeen;

      this.presenceCache.update(participantJid, { status, lastSeen });
      this.emit('presenceUpdate', participantJid, status, lastSeen);

      void chatJid; // available for future use
    }
  }

  // -------------------------------------------------------------------------
  // call
  // -------------------------------------------------------------------------

  private handleCall(sock: WhatsAppSocket, calls: any[]): void {
    for (const call of calls) {
      const callId: string = call.id ?? '';
      const callFrom: string = call.from ?? '';

      if (this.autoRejectCalls && callId) {
        try {
          void (sock as any).rejectCall(callId, callFrom);
        } catch (err) {
          // best-effort
          this.log.debug({ op: 'rejectCall', error: (err as Error).message }, 'transport_op_swallowed');
        }
      }

      if (callId) {
        this.emit('callReceived', callId, callFrom);
      }
    }
  }

  private clearIdentity(): void {
    this.botJid = null;
    this.botLid = null;
    this.selfMentionRegexJid = null;
    this.selfMentionRegexLid = null;
  }

  private clearReconnectTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private setConnectionState(state: ConnectionLifecycleState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.stateChangedAt = Date.now();
  }

  private startKeepalive(sock: WhatsAppSocket): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      void this.runKeepalive(sock);
    }, ConnectionManager.KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.keepaliveInFlight = false;
  }

  private async runKeepalive(sock: WhatsAppSocket): Promise<void> {
    if (this.shuttingDown || this.sock !== sock || this.keepaliveInFlight) return;
    if (!(sock as any).ws?.isOpen) return;

    this.keepaliveInFlight = true;
    this.lastPingAt = Date.now();

    try {
      const result = await sock.query({
        tag: 'iq',
        attrs: {
          to: 's.whatsapp.net',
          type: 'get',
          xmlns: 'w:p',
        },
        content: [{ tag: 'ping', attrs: {} }],
      }, ConnectionManager.KEEPALIVE_TIMEOUT_MS);

      if (!result) {
        throw new Error('keepalive timed out');
      }

      if (this.shuttingDown || this.sock !== sock) return;
      this.lastPongAt = Date.now();
      // A successful pong proves the link is healthy — clear the keepalive-failure clock.
      this.keepaliveFailureFirstAt = null;
    } catch (err) {
      if (this.shuttingDown || this.sock !== sock) return;
      if (this.keepaliveFailureFirstAt === null) {
        this.keepaliveFailureFirstAt = Date.now();
      }
      const keepaliveFailingMs = Date.now() - this.keepaliveFailureFirstAt;
      if (keepaliveFailingMs > ConnectionManager.MAX_FAILURE_DURATION_MS) {
        // Sustained keepalive failure (no successful pong for >30min). gracefulReconnect
        // alone never reaches the exhaustion path, so route through it now to get the
        // alert + bounded process.exit/systemd restart instead of looping forever.
        this.log.fatal(
          { keepaliveFailingMs, err },
          'keepalive failing for over 30 minutes — emitting exhausted',
        );
        this.keepaliveFailureFirstAt = null;
        this.emit('exhausted');
      } else {
        this.log.warn({ err }, 'keepalive failed — forcing reconnect');
        await this.gracefulReconnect(sock, 'keepalive_failed');
      }
    } finally {
      this.keepaliveInFlight = false;
    }
  }

  private async handleExhausted(): Promise<void> {
    if (this.shuttingDown || this.gracefulReconnectInFlight) return;

    this.exhaustionCycles++;
    this.log.warn({ exhaustionCycles: this.exhaustionCycles, max: config.maxExhaustionCycles },
      'reconnect window exhausted — cycle %d of %d', this.exhaustionCycles, config.maxExhaustionCycles);

    if (this.exhaustionCycles >= (config.maxExhaustionCycles ?? 2)) {
      const marker = {
        timestamp: new Date().toISOString(),
        cycles: this.exhaustionCycles,
        instanceName: config.botName,
      };
      if (config.dataRoot) {
        const markerPath = join(config.dataRoot, 'exhausted.marker');
        try {
          writePrivateJsonMarkerSync(markerPath, marker);
        } catch (err) {
          this.log.error({ err }, 'failed to write exhaustion marker');
        }
      }
      this.log.fatal(marker, 'connection exhaustion limit reached — exiting for systemd restart');
      process.exit(1);
    }

    this.gracefulReconnectInFlight = true;
    this.log.warn('forcing fresh connect after exhaustion cycle');
    this.stopKeepalive();
    this.clearReconnectTimers();
    this.sock = null;
    this.clearIdentity();
    this.reconnectAttempts = 0;
    this.reconnectPhase = 'backoff';
    this.firstFailureAt = null;
    this.setConnectionState('reconnecting');
    this.persistConnectionRuntimeState('exhaustion_cycle_retry');

    try {
      await this.connect();
    } finally {
      if (this.connectionState !== 'connected') {
        this.gracefulReconnectInFlight = false;
      }
    }
  }

  private async gracefulReconnect(sock: WhatsAppSocket, reason: 'keepalive_failed' | 'connection_exhausted'): Promise<void> {
    if (this.gracefulReconnectInFlight || this.shuttingDown) return;
    if (this.sock !== sock) return;

    this.gracefulReconnectInFlight = true;
    this.log.warn({ reason }, 'graceful reconnect requested');
    this.stopKeepalive();
    this.clearReconnectTimers();
    this.sock = null;
    this.clearIdentity();
    this.reconnectAttempts = 0;
    this.reconnectPhase = 'backoff';
    this.firstFailureAt = null;
    this.setConnectionState('reconnecting');
    this.persistConnectionRuntimeState(`graceful_reconnect_${reason}`);

    try {
      sock.end(undefined);
    } catch {
      // best-effort
    }

    try {
      await this.connect();
    } finally {
      if (this.connectionState !== 'connected') {
        this.gracefulReconnectInFlight = false;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Message parsing (moved to src/core/message-parser.ts — re-exported here for
// back-compat; remove these re-exports once all external callers migrate).
// ---------------------------------------------------------------------------
import { unwrapMessage, MEDIA_CONTENT_TYPES, parseIncomingMessage } from '../core/message-parser.ts';
import { errorMessage } from '../lib/error-message.ts';
export { unwrapMessage, MEDIA_CONTENT_TYPES, parseIncomingMessage };
