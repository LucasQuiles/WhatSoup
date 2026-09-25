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
import type { SinkState } from '../lib/bounded-ndjson-sink.ts';
import type { Database } from './database.ts';
import type { IncomingMessage } from './types.ts';
import { canonicalConversationKey, resolvePhoneFromJid } from './access-list.ts';
import { isAuthenticatedSenderJid } from './jid-constants.ts';
import { isAuthenticatedAdmin, isBotMentioned } from './access-predicates.ts';
import { normalizeUnixTimestampSeconds } from './substrate/time.ts';
import { isNonEmptyString } from '../lib/type-guards.ts';
import { containsQuestionMark, FEATURE_VERSION, normalizeShadowText } from './shadow-gate-features.ts';
import type { ShadowGateInput, Tri } from './shadow-gate-features.ts';
import { shadowGate, warmShadowRules } from './shadow-gate.ts';
import type { ShadowRuleId, ShadowVerdict } from './shadow-gate.ts';
import {
  computeConfigGeneration,
  computeDatabaseLineage,
  createShadowGateRecorder,
  isShadowGateId,
  SHADOW_GATE_COUNT_KEYS,
  SHADOW_GATE_ID_CHARS,
  SHADOW_GATE_ID_MAX_CHARS,
} from './shadow-gate-events.ts';
import type { ShadowGateCounts, ShadowGateErrorReason, ShadowGateRecorder } from './shadow-gate-events.ts';

const log = createChildLogger('shadow-gate');

/** Evaluation budget; exceeding it is reported as OVERRUN, never interrupted. */
const SHADOW_GATE_BUDGET_MS = 5;

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

/** The sender's phone, resolved once per message; null when resolution throws. */
function resolveSenderPhone(msg: IncomingMessage, db: Database): string | null {
  try {
    return resolvePhoneFromJid(msg.senderJid, db);
  } catch {
    return null;
  }
}

// The access policy's admin predicate. An unauthenticated sender is decided
// (false) even when phone resolution failed.
function ownerFeature(msg: IncomingMessage, phone: string | null, config: ShadowGateConfig): Tri {
  try {
    if (!isAuthenticatedSenderJid(msg.senderJid)) return false;
    return phone === null ? 'unknown' : isAuthenticatedAdmin(msg.senderJid, phone, config.adminPhones);
  } catch {
    return 'unknown';
  }
}

// Mirrors access-policy's isSiblingBot.
function botSenderFeature(msg: IncomingMessage, phone: string | null, config: ShadowGateConfig): Tri {
  try {
    if (!msg.isGroup || !(config.siblingPhones?.size > 0)) return false;
    return phone === null ? 'unknown' : config.siblingPhones.has(phone);
  } catch {
    return 'unknown';
  }
}

// The access policy's group @mention predicate; unknown before the bot JID is known.
function mentionFeature(msg: IncomingMessage, getBotJid: () => string, getBotLid: () => string | null): Tri {
  try {
    const botJid = getBotJid();
    if (!botJid) return 'unknown';
    return isBotMentioned(msg.mentionedJids, botJid, getBotLid());
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
    // Known blind spot: timestamps are whole seconds and the comparison is
    // strict, so a bot message stored in the same second as this inbound one is
    // not "previous" and cannot set pendingObligation. Among several earlier rows
    // sharing the latest second, which one is returned is unspecified.
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
  // S02_DM decides every DM before the gate reads these, so skip the lookup.
  if (!msg.isGroup) return { pendingObligation: 'unknown', contextStatus: 'unknown' };
  try {
    const key = conversationKey ?? canonicalConversationKey(msg.chatJid, db);
    const row = previousMessageStatement(db).get(key, normalizeUnixTimestampSeconds(msg.timestamp)) as
      | { is_from_me: number; content: string | null }
      | undefined;
    const pending = row !== undefined
      && row.is_from_me === 1
      && isNonEmptyString(row.content)
      && containsQuestionMark(row.content);
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
  const phone = resolveSenderPhone(msg, db);
  return {
    chatKind: msg.isGroup ? 'group' : 'dm',
    isOwner: ownerFeature(msg, phone, config),
    isBotSender: botSenderFeature(msg, phone, config),
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
  reason: ShadowGateErrorReason | null;
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

const OUTSIDE_ID_CHARS = new RegExp(`[^${SHADOW_GATE_ID_CHARS}]`, 'g');

/** Recorded instance id: the validator's closed id charset, bounded length. */
function recordedInstanceId(botName: string): string {
  const id = botName.replace(OUTSIDE_ID_CHARS, '_').slice(0, SHADOW_GATE_ID_MAX_CHARS);
  return id.length > 0 ? id : 'unnamed';
}

/**
 * Compile the rules and prepare the previous-message statement now, so the
 * first evaluation's tookMs covers neither. Ingest calls this at handler
 * creation in `shadow` mode. A rules load failure is not a recorder failure:
 * each evaluation then records E_THROW. Never throws.
 */
export function warmShadowGate(db: Database): void {
  try {
    if (!warmShadowRules()) warnCode('shadow_gate_rules_unavailable');
  } catch {
    // intentional: warming is best-effort; evaluation reports its own failure.
  }
  try {
    previousMessageStatement(db);
  } catch {
    // intentional: a database that is not open yet is prepared on first use.
  }
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
    // Warm before creating the recorder: it reads the rules hash once, and the
    // hash must describe the bytes that were compiled.
    warmShadowGate(db);
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
export function getShadowGateStats(): ShadowGateCounts {
  if (recorder) {
    try {
      return recorder.stats();
    } catch {
      // intentional: fall through to the zero snapshot.
    }
  }
  return Object.fromEntries(SHADOW_GATE_COUNT_KEYS.map((key) => [key, 0])) as ShadowGateCounts;
}

export type ShadowGateRecorderHealth =
  | 'not_started' | 'disabled' | 'starting' | 'ready' | 'degraded' | 'unavailable';

export type ShadowGateHealth =
  | { mode: 'off' }
  | {
      mode: 'shadow';
      recorder: ShadowGateRecorderHealth;
      sinkState: SinkState | null;
      sinkDegradedReason: string | null;
      counts: ShadowGateCounts;
    };

/**
 * Advisory health projection: closed codes and counters only. Mode off does no
 * work. In shadow mode, `not_started` is the normal state before the first
 * dispatched message (creation is lazy); `disabled` means creation failed and
 * is latched until restart; `degraded` wins whenever the sink has a degraded
 * reason, even once closed; `unavailable` means the sink is closed or its
 * status is unreadable. A reason outside the recorded id charset is reported as
 * `unknown` so no free text reaches the body. Never throws.
 */
export function getShadowGateHealth(config: Pick<ShadowGateConfig, 'shadowGate'>): ShadowGateHealth {
  if (config.shadowGate?.mode !== 'shadow') return { mode: 'off' };
  const counts = getShadowGateStats();
  const unread = { mode: 'shadow', sinkState: null, sinkDegradedReason: null, counts } as const;
  if (!recorder) return { ...unread, recorder: recorderDisabled ? 'disabled' : 'not_started' };
  try {
    const { state, degradedReason } = recorder.sinkStatus();
    const reason = degradedReason === null ? null : isShadowGateId(degradedReason) ? degradedReason : 'unknown';
    const health: ShadowGateRecorderHealth =
      reason !== null || state === 'degraded' ? 'degraded'
        : state === 'closed' ? 'unavailable'
          : state === 'starting' ? 'starting'
            : 'ready';
    return { mode: 'shadow', recorder: health, sinkState: state, sinkDegradedReason: reason, counts };
  } catch {
    return { ...unread, recorder: 'unavailable' };
  }
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
