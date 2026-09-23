// src/core/shadow-gate-events.ts
// Shadow-gate event envelope, strict validator, and recorder. Events are
// advisory_only metadata records: no message text, no stack traces or error
// messages — closed codes only. Ids are restricted to a closed charset that
// rules out JIDs, and messageId/instance reject a standalone phone-length
// digit run; a phone number glued to letters inside an id is not detected.

import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { createBoundedNdjsonSink } from '../lib/bounded-ndjson-sink.ts';
import type { BoundedNdjsonSink, SinkState } from '../lib/bounded-ndjson-sink.ts';
import { getRulesSha256, SHADOW_GATE_VERSION } from './shadow-gate.ts';
import { systemClock } from '../lib/clock.ts';
import type { ShadowRuleId, ShadowVerdict } from './shadow-gate.ts';
import { FEATURE_VERSION } from './shadow-gate-features.ts';
import { isNonEmptyString, isRecord } from '../lib/type-guards.ts';
import { shortHash } from '../lib/short-hash.ts';

export const SHADOW_GATE_EVENT_SCHEMA_VERSION = 1;
const SHADOW_GATE_EVENT_TYPES = ['shadow_gate_verdict', 'shadow_gate_coverage'] as const;
type ShadowGateStatus = 'OK' | 'ERROR';
export type ShadowGateErrorReason = 'OVERRUN' | 'E_THROW';
export const SHADOW_GATE_EVENTS_FILE_PREFIX = 'shadow-gate-events';

/** Recorded id alphabet (a regex character-class body) and length bound. */
export const SHADOW_GATE_ID_CHARS = 'A-Za-z0-9._:-';
export const SHADOW_GATE_ID_MAX_CHARS = 128;

/** Coverage-marker count keys; the counts type, validator and report derive from this list. */
export const SHADOW_GATE_COUNT_KEYS = [
  'evaluated', 'recorded', 'written', 'droppedQueueFull', 'droppedOversize', 'droppedClosed', 'droppedDegraded',
  'droppedWriteFailed', 'droppedUnserializable', 'invalid', 'writeErrors', 'journalFailures',
] as const;
export type ShadowGateCounts = Record<typeof SHADOW_GATE_COUNT_KEYS[number], number>;

/** Per-process identity, minted once (mirrors lifecycle-emission's per-process boot id). */
export const SHADOW_GATE_PROCESS_BOOT_ID: string = randomUUID();

export interface ShadowGateVerdictEvent {
  schemaVersion: 1; ts: number; event: 'shadow_gate_verdict';
  instance: string; databaseLineage: string; bootId: string; configGeneration: string; attemptId: string;
  messageId: string; inboundSeq: number | null; chatScope: 'dm' | 'group';
  status: ShadowGateStatus; reason: ShadowGateErrorReason | null;
  verdict: ShadowVerdict | null; ruleId: ShadowRuleId | null;
  tookMs: number; gateVersion: number; rulesSha256: string; featureVersion: number;
  authority: 'advisory_only';
}

export interface ShadowGateCoverageEvent {
  schemaVersion: 1; ts: number; event: 'shadow_gate_coverage';
  instance: string; databaseLineage: string; bootId: string; configGeneration: string;
  marker: 'armed' | 'counts' | 'disarmed';
  counts: ShadowGateCounts;
  sinkState: SinkState; sinkDegradedReason: string | null;
  gateVersion: number; rulesSha256: string; featureVersion: number;
  authority: 'advisory_only';
}

export type ShadowGateEvent = ShadowGateVerdictEvent | ShadowGateCoverageEvent;

// Runtime mirror of the ShadowRuleId type; the two assertions below fail
// typecheck if either side gains a member the other lacks.
const SHADOW_RULE_IDS = [
  'S01_OWNER', 'S02_DM', 'S03_CONTROL', 'S04_MENTION', 'S05_QUOTED', 'S06_NONTEXT',
  'S07_UNKNOWN', 'S08_OBLIGATION', 'X02_STATUS_ONLY', 'X03_NO_REPLY_PATTERN', 'D00_DEFAULT',
] as const satisfies readonly ShadowRuleId[];
type MissingRuleIds = Exclude<ShadowRuleId, typeof SHADOW_RULE_IDS[number]>;
const ruleIdsExhaustive: [MissingRuleIds] extends [never] ? true : never = true;
void ruleIdsExhaustive;

const RULE_ID_SET: ReadonlySet<unknown> = new Set(SHADOW_RULE_IDS);
const VERDICT_SET: ReadonlySet<unknown> = new Set<ShadowVerdict>(['SPAWN', 'SUPPRESS']);
const EVENT_TYPE_SET: ReadonlySet<unknown> = new Set(SHADOW_GATE_EVENT_TYPES);
const ERROR_REASON_SET: ReadonlySet<unknown> = new Set<ShadowGateErrorReason>(['OVERRUN', 'E_THROW']);
const MARKER_SET: ReadonlySet<unknown> = new Set(['armed', 'counts', 'disarmed']);
const SINK_STATE_SET: ReadonlySet<unknown> = new Set<SinkState>(['starting', 'ready', 'degraded', 'closed']);
// Closed id charset: excludes '@', '+' and whitespace, so a full JID or a
// '+'-prefixed number cannot be recorded. It does not exclude bare digits.
const ID_CHARSET = new RegExp(`^[${SHADOW_GATE_ID_CHARS}]+$`);
// messageId and instance also reject a standalone 7–15 digit run (the E.164
// length range). A run glued to letters is not caught: hex ids contain long
// digit runs by chance, so matching those would drop roughly a fifth of
// WhatsApp ids.
const STANDALONE_PHONE_DIGITS = /(?<![A-Za-z0-9])\d{7,15}(?![A-Za-z0-9])/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const COMMON_KEYS = [
  'schemaVersion', 'ts', 'event', 'instance', 'databaseLineage', 'bootId', 'configGeneration',
  'gateVersion', 'rulesSha256', 'featureVersion', 'authority',
] as const;
const VERDICT_INPUT_KEY_LIST = [
  'attemptId', 'messageId', 'inboundSeq', 'chatScope', 'status', 'reason', 'verdict', 'ruleId', 'tookMs',
] as const;
const VERDICT_INPUT_KEYS: ReadonlySet<string> = new Set(VERDICT_INPUT_KEY_LIST);
const VERDICT_KEYS: ReadonlySet<string> = new Set([...COMMON_KEYS, ...VERDICT_INPUT_KEY_LIST]);
const COVERAGE_KEYS: ReadonlySet<string> = new Set([...COMMON_KEYS, 'marker', 'counts', 'sinkState', 'sinkDegradedReason']);
const COUNT_KEYS: ReadonlySet<string> = new Set(SHADOW_GATE_COUNT_KEYS);

function exactKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  const keys = Object.keys(obj);
  for (const k of keys) if (!allowed.has(k)) return 'unknown_key';
  if (keys.length !== allowed.size) return 'missing_key';
  return null;
}

/** An id in the recorded charset and length bound. */
export function isShadowGateId(v: unknown): v is string {
  return isNonEmptyString(v) && ID_CHARSET.test(v) && v.length <= SHADOW_GATE_ID_MAX_CHARS;
}

/** A recordable messageId or instance: a valid id with no standalone phone-length digit run. */
export function isShadowGatePhoneFreeId(v: unknown): v is string {
  return isShadowGateId(v) && !STANDALONE_PHONE_DIGITS.test(v);
}

function isCount(v: unknown): boolean {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function validateVerdictFields(ev: Record<string, unknown>): string | null {
  if (!isShadowGateId(ev.attemptId)) return 'bad_attempt_id';
  if (!isShadowGatePhoneFreeId(ev.messageId)) return 'bad_message_id';
  if (ev.inboundSeq !== null && !isCount(ev.inboundSeq)) return 'bad_inbound_seq';
  if (ev.chatScope !== 'dm' && ev.chatScope !== 'group') return 'bad_chat_scope';
  if (typeof ev.tookMs !== 'number' || !Number.isFinite(ev.tookMs) || ev.tookMs < 0) return 'bad_took_ms';
  const hasVerdict = ev.verdict !== null || ev.ruleId !== null;
  if (ev.verdict !== null && !VERDICT_SET.has(ev.verdict)) return 'bad_verdict';
  if (ev.ruleId !== null && !RULE_ID_SET.has(ev.ruleId)) return 'bad_rule_id';
  if ((ev.verdict === null) !== (ev.ruleId === null)) return 'verdict_rule_mismatch';
  if (ev.status === 'OK') {
    if (ev.reason !== null) return 'ok_with_reason';
    if (!hasVerdict) return 'ok_without_verdict';
    return null;
  }
  if (ev.status !== 'ERROR') return 'bad_status';
  if (!ERROR_REASON_SET.has(ev.reason)) return 'bad_reason';
  if (ev.reason === 'OVERRUN') return hasVerdict ? null : 'overrun_without_verdict';
  return hasVerdict ? 'error_with_verdict' : null;
}

function validateCoverageFields(ev: Record<string, unknown>): string | null {
  if (!MARKER_SET.has(ev.marker)) return 'bad_marker';
  if (!isRecord(ev.counts)) return 'bad_counts';
  const countsKeys = exactKeys(ev.counts, COUNT_KEYS);
  if (countsKeys) return `counts_${countsKeys}`;
  for (const v of Object.values(ev.counts)) if (!isCount(v)) return 'bad_count_value';
  if (!SINK_STATE_SET.has(ev.sinkState)) return 'bad_sink_state';
  if (ev.sinkDegradedReason !== null && !isShadowGateId(ev.sinkDegradedReason)) return 'bad_sink_degraded_reason';
  return null;
}

/** Returns null when valid, otherwise a short closed problem code. */
export function validateShadowGateEvent(ev: unknown): string | null {
  if (!isRecord(ev)) return 'not_object';
  if (!EVENT_TYPE_SET.has(ev.event)) return 'unknown_event';
  const keys = exactKeys(ev, ev.event === 'shadow_gate_verdict' ? VERDICT_KEYS : COVERAGE_KEYS);
  if (keys) return keys;
  if (ev.schemaVersion !== SHADOW_GATE_EVENT_SCHEMA_VERSION) return 'bad_schema_version';
  if (typeof ev.ts !== 'number' || !Number.isFinite(ev.ts) || ev.ts < 0) return 'bad_ts';
  if (!isShadowGatePhoneFreeId(ev.instance)) return 'bad_instance';
  if (!isShadowGateId(ev.databaseLineage)) return 'bad_database_lineage';
  if (!isShadowGateId(ev.bootId)) return 'bad_boot_id';
  if (!isShadowGateId(ev.configGeneration)) return 'bad_config_generation';
  if (!isCount(ev.gateVersion)) return 'bad_gate_version';
  if (!isCount(ev.featureVersion)) return 'bad_feature_version';
  if (typeof ev.rulesSha256 !== 'string' || !SHA256_HEX.test(ev.rulesSha256)) return 'bad_rules_sha256';
  if (ev.authority !== 'advisory_only') return 'bad_authority';
  return ev.event === 'shadow_gate_verdict' ? validateVerdictFields(ev) : validateCoverageFields(ev);
}

/** Called once at startup; sync fs is deliberate. */
export function computeDatabaseLineage(dbPath: string): string {
  if (dbPath === ':memory:') return 'memory';
  try {
    const real = realpathSync(dbPath);
    const { ino } = statSync(real);
    return shortHash(`${real}:${ino}`, 16);
  } catch {
    return 'unknown';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function computeConfigGeneration(section: unknown): string {
  try {
    return shortHash(JSON.stringify(canonicalize(section)) ?? 'undefined', 16);
  } catch {
    return 'unknown';
  }
}

export type ShadowGateVerdictInput = Omit<
  ShadowGateVerdictEvent,
  'schemaVersion' | 'ts' | 'event' | 'instance' | 'databaseLineage' | 'bootId' | 'configGeneration'
  | 'gateVersion' | 'rulesSha256' | 'featureVersion' | 'authority'
>;

export interface ShadowGateRecorder {
  recordVerdict(e: ShadowGateVerdictInput): void;
  noteEvaluated(): void;
  noteJournalFailure(): void;
  stats(): ShadowGateCounts;
  close(timeoutMs?: number): Promise<void>;
}

export interface ShadowGateRecorderOptions {
  dir: string;
  instance: string;
  databaseLineage: string;
  configGeneration: string;
  warn?: (code: string) => void;
  countsIntervalMs?: number;
  now?: () => number;
  sink?: BoundedNdjsonSink;
}

const DEFAULT_COUNTS_INTERVAL_MS = 600_000;
const WARN_INTERVAL_MS = 60_000;

export function createShadowGateRecorder(opts: ShadowGateRecorderOptions): ShadowGateRecorder {
  const now = opts.now ?? (() => systemClock.now());
  // Per-message codes (e.g. every Signal id failing the charset) would
  // otherwise log once per message; the counters carry the totals.
  const lastWarnAt = new Map<string, number>();
  const warn = (code: string): void => {
    try {
      const at = now();
      const last = lastWarnAt.get(code);
      if (last !== undefined && at - last < WARN_INTERVAL_MS) return;
      lastWarnAt.set(code, at);
      opts.warn?.(code);
    } catch {
      // intentional: a throwing warn callback must not reach the caller.
    }
  };
  const sink = opts.sink ?? createBoundedNdjsonSink({
    dir: opts.dir,
    filePrefix: SHADOW_GATE_EVENTS_FILE_PREFIX,
    warn,
  });
  const identity = {
    instance: opts.instance,
    databaseLineage: opts.databaseLineage,
    bootId: SHADOW_GATE_PROCESS_BOOT_ID,
    configGeneration: opts.configGeneration,
  };
  const versions = {
    gateVersion: SHADOW_GATE_VERSION,
    // Total: an unreadable rules file yields a sentinel, never a throw that
    // would latch the recorder disabled.
    rulesSha256: getRulesSha256(),
    featureVersion: FEATURE_VERSION,
    authority: 'advisory_only' as const,
  };
  const own = { evaluated: 0, recorded: 0, journalFailures: 0, invalid: 0 };
  let closePromise: Promise<void> | null = null;

  const counts = (): ShadowGateCounts => {
    const s = sink.stats();
    return {
      evaluated: own.evaluated,
      recorded: own.recorded,
      written: s.written,
      droppedQueueFull: s.droppedQueueFull,
      droppedOversize: s.droppedOversize,
      droppedClosed: s.droppedClosed,
      droppedDegraded: s.droppedDegraded,
      droppedWriteFailed: s.droppedWriteFailed,
      droppedUnserializable: s.droppedUnserializable,
      invalid: own.invalid,
      writeErrors: s.writeErrors,
      journalFailures: own.journalFailures,
    };
  };

  const writeCoverage = (marker: ShadowGateCoverageEvent['marker']): void => {
    try {
      const event: ShadowGateCoverageEvent = {
        schemaVersion: SHADOW_GATE_EVENT_SCHEMA_VERSION,
        ts: now(),
        event: 'shadow_gate_coverage',
        ...identity,
        marker,
        counts: counts(),
        sinkState: sink.state(),
        sinkDegradedReason: sink.degradedReason(),
        ...versions,
      };
      const problem = validateShadowGateEvent(event);
      if (problem) {
        own.invalid += 1;
        warn('shadow_gate_invalid_coverage');
        return;
      }
      sink.enqueue(event);
    } catch {
      warn('shadow_gate_coverage_failed');
    }
  };

  writeCoverage('armed');
  const timer = setInterval(() => writeCoverage('counts'), opts.countsIntervalMs ?? DEFAULT_COUNTS_INTERVAL_MS);
  timer.unref?.();

  return {
    recordVerdict(e) {
      try {
        // Caller keys outside the input contract are rejected, not silently dropped.
        if (!isRecord(e) || Object.keys(e).some((k) => !VERDICT_INPUT_KEYS.has(k))) {
          own.invalid += 1;
          warn('shadow_gate_invalid_verdict');
          return;
        }
        const event: ShadowGateVerdictEvent = {
          schemaVersion: SHADOW_GATE_EVENT_SCHEMA_VERSION,
          ts: now(),
          event: 'shadow_gate_verdict',
          ...identity,
          attemptId: e.attemptId,
          messageId: e.messageId,
          inboundSeq: e.inboundSeq,
          chatScope: e.chatScope,
          status: e.status,
          reason: e.reason,
          verdict: e.verdict,
          ruleId: e.ruleId,
          tookMs: e.tookMs,
          ...versions,
        };
        if (validateShadowGateEvent(event)) {
          own.invalid += 1;
          warn('shadow_gate_invalid_verdict');
          return;
        }
        if (sink.enqueue(event) === 'queued') own.recorded += 1;
      } catch {
        own.invalid += 1;
        warn('shadow_gate_record_failed');
      }
    },
    noteEvaluated() {
      own.evaluated += 1;
    },
    noteJournalFailure() {
      own.journalFailures += 1;
    },
    stats: counts,
    close(timeoutMs) {
      if (closePromise) return closePromise;
      clearInterval(timer);
      writeCoverage('disarmed');
      closePromise = sink.close(timeoutMs).catch(() => undefined);
      return closePromise;
    },
  };
}
