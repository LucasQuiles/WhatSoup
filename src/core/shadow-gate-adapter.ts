// src/core/shadow-gate-adapter.ts
// Ingest-side adapter for the logged-only shadow gate: builds the gate input
// from an admitted message, evaluates it, and records the verdict through a
// lazily created recorder. Every export is total (never throws) and nothing
// here can change dispatch. Warnings carry closed codes only — never message
// text, JIDs, phone numbers or error messages.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import type { IncomingMessage } from './types.ts';
import { canonicalConversationKey, resolvePhoneFromJid, resolvePhoneFromJidForGrant } from './access-list.ts';
import { bareNumber } from './jid-constants.ts';
import { normalizeUnixTimestampSeconds } from './substrate/time.ts';
import { isAdminPhone } from '../lib/phone.ts';
import { isNonEmptyString } from '../lib/type-guards.ts';
import { FEATURE_VERSION, normalizeShadowText } from './shadow-gate-features.ts';
import type { ShadowGateInput, Tri } from './shadow-gate-features.ts';
import { shadowGate } from './shadow-gate.ts';
import type { ShadowRuleId, ShadowVerdict } from './shadow-gate.ts';
import { computeConfigGeneration, computeDatabaseLineage, createShadowGateRecorder } from './shadow-gate-events.ts';
import type { ShadowGateRecorder } from './shadow-gate-events.ts';

const log = createChildLogger('shadow-gate');

/** Evaluation budget; exceeding it is reported as OVERRUN, never interrupted. */
const SHADOW_GATE_BUDGET_MS = 5;
const MAX_INSTANCE_CHARS = 128;

/**
 * The config fields the adapter reads. Callers pass the live `config` object
 * (read per call, never copied); injecting it keeps this domain module from
 * importing the composition-ring config module.
 */
export interface ShadowGateConfig {
  readonly shadowGate?: { readonly mode: 'off' | 'shadow'; readonly eventsDir: string | null };
  readonly botName: string;
  readonly adminPhones: Set<string>;
  readonly siblingPhones: Set<string>;
  readonly botErrorsJid: string | null;
}

function warnCode(code: string): void {
  try {
    log.warn({ code }, 'shadow gate warning');
  } catch {
    // intentional: logging must never reach ingest.
  }
}

// ---------------------------------------------------------------------------
// Input construction
// ---------------------------------------------------------------------------

// Same transport-gated admin match as access-policy's self_only path (QR-143).
function ownerFeature(msg: IncomingMessage, db: Database, config: ShadowGateConfig): Tri {
  try {
    const phone = resolvePhoneFromJidForGrant(msg.senderJid, db);
    return phone !== null && isAdminPhone(phone, config.adminPhones);
  } catch {
    return 'unknown';
  }
}

// Mirrors access-policy's isSiblingBot.
function botSenderFeature(msg: IncomingMessage, db: Database, config: ShadowGateConfig): Tri {
  try {
    return msg.isGroup
      && config.siblingPhones?.size > 0
      && config.siblingPhones.has(resolvePhoneFromJid(msg.senderJid, db));
  } catch {
    return 'unknown';
  }
}

// Mirrors access-policy's group @mention check.
function mentionFeature(msg: IncomingMessage, getBotJid: () => string, getBotLid: () => string | null): Tri {
  try {
    const botJid = getBotJid();
    if (!botJid) return 'unknown';
    const botIds = new Set<string>([botJid, bareNumber(botJid)]);
    const botLid = getBotLid();
    if (botLid) {
      botIds.add(botLid);
      botIds.add(bareNumber(botLid));
    }
    return msg.mentionedJids.some((jid) => botIds.has(jid) || botIds.has(bareNumber(jid)));
  } catch {
    return 'unknown';
  }
}

function controlChatFeature(msg: IncomingMessage, config: ShadowGateConfig): Tri {
  try {
    return config.botErrorsJid === null ? false : msg.chatJid === config.botErrorsJid;
  } catch {
    return 'unknown';
  }
}

// Keyed on the raw handle so a reopened database prepares a fresh statement.
const previousMessageStatements = new WeakMap<DatabaseSync, StatementSync>();

function previousMessageStatement(db: Database): StatementSync {
  const raw = db.raw;
  let stmt = previousMessageStatements.get(raw);
  if (!stmt) {
    // Served by idx_messages_conversation_ts (conversation_key, timestamp).
    stmt = raw.prepare(
      `SELECT is_from_me, content FROM messages
       WHERE conversation_key = ? AND timestamp < ?
       ORDER BY timestamp DESC LIMIT 1`,
    );
    previousMessageStatements.set(raw, stmt);
  }
  return stmt;
}

function obligationFeature(
  msg: IncomingMessage,
  conversationKey: string | undefined,
  db: Database,
): { pendingObligation: Tri; contextStatus: 'known' | 'unknown' } {
  try {
    const key = conversationKey ?? canonicalConversationKey(msg.chatJid, db);
    const row = previousMessageStatement(db).get(key, normalizeUnixTimestampSeconds(msg.timestamp)) as
      | { is_from_me: number; content: string | null }
      | undefined;
    const pending = row !== undefined
      && row.is_from_me === 1
      && isNonEmptyString(row.content)
      && (row.content.includes('?') || row.content.includes('？'));
    return { pendingObligation: pending, contextStatus: 'known' };
  } catch {
    return { pendingObligation: 'unknown', contextStatus: 'unknown' };
  }
}

/**
 * Build the gate input from an admitted inbound message. Call before ingest's
 * self-mention strip mutates `msg.content`. `conversationKey` defaults to the
 * key ingest stores under; ingest passes the key it already resolved.
 */
export function buildShadowGateInput(
  msg: IncomingMessage,
  db: Database,
  getBotJid: () => string,
  getBotLid: () => string | null,
  config: ShadowGateConfig,
  conversationKey?: string,
): ShadowGateInput {
  const { text, truncated } = normalizeShadowText(msg.content);
  const { pendingObligation, contextStatus } = obligationFeature(msg, conversationKey, db);
  return {
    chatKind: msg.isGroup ? 'group' : 'dm',
    isOwner: ownerFeature(msg, db, config),
    isBotSender: botSenderFeature(msg, db, config),
    mentionedSelf: mentionFeature(msg, getBotJid, getBotLid),
    isControlChat: controlChatFeature(msg, config),
    contentType: msg.contentType,
    quoted: msg.quotedMessageId !== null,
    text,
    truncated,
    contextStatus,
    pendingObligation,
    featureVersion: FEATURE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface ShadowGateEvaluation {
  status: 'OK' | 'ERROR';
  reason: 'OVERRUN' | 'E_THROW' | null;
  verdict: ShadowVerdict | null;
  ruleId: ShadowRuleId | null;
  tookMs: number;
  chatScope: 'dm' | 'group';
}

function elapsedSince(start: number): number {
  const took = performance.now() - start;
  return Number.isFinite(took) && took >= 0 ? took : 0;
}

export function evaluateShadowGateForMessage(
  msg: IncomingMessage,
  db: Database,
  getBotJid: () => string,
  getBotLid: () => string | null,
  config: ShadowGateConfig,
  conversationKey?: string,
): ShadowGateEvaluation {
  let chatScope: 'dm' | 'group' = 'dm';
  let start = 0;
  try {
    chatScope = msg.isGroup ? 'group' : 'dm';
    start = performance.now();
    const input = buildShadowGateInput(msg, db, getBotJid, getBotLid, config, conversationKey);
    const { verdict, ruleId } = shadowGate(input);
    const tookMs = elapsedSince(start);
    if (tookMs > SHADOW_GATE_BUDGET_MS) return { status: 'ERROR', reason: 'OVERRUN', verdict, ruleId, tookMs, chatScope };
    return { status: 'OK', reason: null, verdict, ruleId, tookMs, chatScope };
  } catch {
    let tookMs = 0;
    try {
      tookMs = elapsedSince(start);
    } catch {
      // intentional: a failing clock leaves tookMs at 0.
    }
    return { status: 'ERROR', reason: 'E_THROW', verdict: null, ruleId: null, tookMs, chatScope };
  }
}

// ---------------------------------------------------------------------------
// Recorder lifecycle
// ---------------------------------------------------------------------------

let recorder: ShadowGateRecorder | null = null;
let recorderDisabled = false;

/** Recorded instance id: the validator's closed id charset, bounded length. */
function recordedInstanceId(botName: string): string {
  const id = botName.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, MAX_INSTANCE_CHARS);
  return id.length > 0 ? id : 'unnamed';
}

/**
 * Lazily create the process recorder on first use in `shadow` mode. Returns
 * null in `off` mode or once creation has failed (latched until reset).
 */
export function getShadowGateRecorder(db: Database, config: ShadowGateConfig): ShadowGateRecorder | null {
  if (recorder) return recorder;
  if (recorderDisabled) return null;
  try {
    const section = config.shadowGate;
    if (section?.mode !== 'shadow') return null;
    // main.ts is sha-pinned (deploy/source-runtime-manifest.json), so there is
    // no shutdown close(): the 'disarmed' marker is absent on process exit and
    // the periodic 'counts' markers bound the unrecorded tail.
    recorder = createShadowGateRecorder({
      dir: section.eventsDir ?? join(homedir(), '.config', 'whatsoup', 'instances', config.botName),
      instance: recordedInstanceId(config.botName),
      databaseLineage: computeDatabaseLineage(db.path),
      configGeneration: computeConfigGeneration(section),
      warn: warnCode,
    });
    return recorder;
  } catch {
    recorderDisabled = true;
    warnCode('shadow_gate_recorder_create_failed');
    return null;
  }
}

/** Snapshot of recorder counters; all zero when no recorder exists. */
export function getShadowGateStats(): ReturnType<ShadowGateRecorder['stats']> {
  if (recorder) {
    try {
      return recorder.stats();
    } catch {
      // intentional: fall through to the zero snapshot.
    }
  }
  return {
    evaluated: 0, recorded: 0, droppedQueueFull: 0, droppedOversize: 0, droppedClosed: 0, droppedDegraded: 0,
    droppedWriteFailed: 0, droppedUnserializable: 0, invalid: 0, writeErrors: 0, journalFailures: 0,
  };
}

/** Test-only: close and forget the process recorder and clear the disabled latch. */
export async function __resetShadowGateForTests(): Promise<void> {
  const current = recorder;
  recorder = null;
  recorderDisabled = false;
  if (current) await current.close();
}

// ---------------------------------------------------------------------------
// Ingest call site
// ---------------------------------------------------------------------------

export interface ShadowGateAttempt {
  /** Record the verdict with the journalled inbound seq (null without durability). */
  settle(inboundSeq: number | null): void;
  /** Count a journalInbound failure; the verdict is not recorded. */
  journalFailed(): void;
}

/**
 * Evaluate an admitted message and return a handle that records the verdict
 * once the inbound seq is known. Null when no recorder is available. Callers
 * gate on `config.shadowGate.mode === 'shadow'` so mode `off` does no work.
 */
export function startShadowGateAttempt(
  msg: IncomingMessage,
  conversationKey: string,
  db: Database,
  getBotJid: () => string,
  getBotLid: () => string | null,
  config: ShadowGateConfig,
): ShadowGateAttempt | null {
  try {
    const rec = getShadowGateRecorder(db, config);
    if (!rec) return null;
    const evaluation = evaluateShadowGateForMessage(msg, db, getBotJid, getBotLid, config, conversationKey);
    const attemptId = randomUUID();
    const messageId = msg.messageId;
    rec.noteEvaluated();
    let settled = false;
    return {
      settle(inboundSeq) {
        if (settled) return;
        settled = true;
        try {
          rec.recordVerdict({ attemptId, messageId, inboundSeq, ...evaluation });
        } catch {
          warnCode('shadow_gate_record_failed');
        }
      },
      journalFailed() {
        if (settled) return;
        settled = true;
        try {
          rec.noteJournalFailure();
        } catch {
          warnCode('shadow_gate_record_failed');
        }
      },
    };
  } catch {
    warnCode('shadow_gate_attempt_failed');
    return null;
  }
}
