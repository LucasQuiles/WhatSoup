/**
 * Shadow-gate measurement: joins recorded shadow verdicts (NDJSON sidecar
 * segments) to a read-only snapshot of `inbound_events` and computes coverage
 * first, then rates. Missing evidence is never allowed to improve a rate: a
 * row without exactly one valid joined verdict is "missing", and the
 * conservative disagreement rate counts every missing or ERROR echoed row
 * against the gate.
 *
 * Privacy: only closed codes, counts, hashes and boot ids leave this module.
 * The snapshot holds message text, JIDs and phone numbers, so the query reads
 * only `seq, message_id, routed_to, terminal_reason`, and message ids are
 * never printed.
 */

import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  SHADOW_GATE_EVENTS_FILE_PREFIX,
  validateShadowGateEvent,
} from '../../src/core/shadow-gate-events.ts';
import type {
  ShadowGateCoverageEvent,
  ShadowGateErrorReason,
  ShadowGateEvent,
  ShadowGateVerdictEvent,
} from '../../src/core/shadow-gate-events.ts';
import { clopperPearsonUpper } from '../../src/lib/clopper-pearson.ts';
import { isNonEmptyString } from '../../src/lib/type-guards.ts';

/** Evidence the report cannot measure honestly; the CLI maps it to exit 65. */
export class ShadowGateEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShadowGateEvidenceError';
  }
}

export interface SegmentLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxLineBytes: number;
}

export const DEFAULT_SEGMENT_LIMITS: SegmentLimits = {
  maxFiles: 64,
  maxTotalBytes: 200 * 1024 * 1024,
  maxLineBytes: 4096,
};

const SEGMENT_NAME = new RegExp(`^${SHADOW_GATE_EVENTS_FILE_PREFIX}\\.\\d{6}\\.ndjson$`);
const EXCLUDED_ROUTES: ReadonlySet<string> = new Set(['none', 'admin', 'control', 'passive']);
// Dispatch routes are the lower-cased runtime class names ingest journals
// (`runtime.constructor.name`).
const KNOWN_DISPATCH_ROUTES: ReadonlySet<string> = new Set(['agentruntime', 'chatruntime', 'passiveruntime']);
const SYNTHETIC_ID_PREFIXES = ['agentjob-', 'obl:'] as const;
// Scheduled jobs and obligations journal under this route and never pass ingest.
const SYNTHETIC_ROUTE = 'agent';
const NULL_ROUTE = '(null)';
// routed_to is the only free-form DB string that reaches output; anything
// outside a runtime-name shape is bucketed rather than printed.
const PRINTABLE_ROUTE = /^[a-z_]{1,64}$/;
const UNPRINTABLE_ROUTE = '(unprintable)';
const ECHOED = 'response_echoed';
const NO_REPLY = 'no_reply_policy';
const MISSING_WARNING = 'WARNING: rates below are computed on joined rows; missing evidence may hide disagreements';
const COUNTERS_SCOPE_LABEL = '(cumulative per boot at last marker, not windowed)';
const PROXY_CAVEAT ='response_echoed is historical behaviour, not proof a reply was required; this is not a gold false-suppress rate';

// ---------------------------------------------------------------------------
// Segment reading
// ---------------------------------------------------------------------------

export interface SegmentReadResult {
  events: ShadowGateEvent[];
  /** Extra copies of byte-identical lines, keyed by the kept line's index in `events`. */
  duplicateCopies: number[];
  tornTail: number;
  files: number;
}

function evidenceError(message: string): never {
  throw new ShadowGateEvidenceError(message);
}

function listSegments(dir: string, limits: SegmentLimits): Array<{ name: string; path: string }> {
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) evidenceError('--events is not a directory');
    names = readdirSync(dir);
  } catch (err) {
    if (err instanceof ShadowGateEvidenceError) throw err;
    evidenceError('--events directory is unreadable');
  }
  const segments = names.filter((name) => SEGMENT_NAME.test(name)).sort();
  if (segments.length > limits.maxFiles) {
    evidenceError(`too many segment files: ${segments.length} > ${limits.maxFiles}`);
  }
  let total = 0;
  const out: Array<{ name: string; path: string }> = [];
  for (const name of segments) {
    const path = join(dir, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      evidenceError(`${name} is unreadable`);
    }
    if (!st.isFile()) evidenceError(`${name} is not a regular file`);
    total += st.size;
    if (total > limits.maxTotalBytes) evidenceError(`segment files exceed ${limits.maxTotalBytes} bytes in total`);
    out.push({ name, path });
  }
  return out;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Read, validate and de-duplicate every segment. An invalid interior line is
 * fatal and named by file and line number only; a final line without a
 * trailing newline is a torn tail and is excluded even when it parses.
 */
export function readSegments(dir: string, limits: SegmentLimits = DEFAULT_SEGMENT_LIMITS): SegmentReadResult {
  const events: ShadowGateEvent[] = [];
  const duplicateCopies: number[] = [];
  const seen = new Map<string, number>();
  let tornTail = 0;
  const segments = listSegments(dir, limits);
  for (const { name, path } of segments) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      evidenceError(`${name} is unreadable`);
    }
    let start = 0;
    let lineNo = 0;
    while (start < bytes.length) {
      lineNo += 1;
      const newline = bytes.indexOf(0x0a, start);
      const end = newline === -1 ? bytes.length : newline;
      if (end - start > limits.maxLineBytes) evidenceError(`${name}:${lineNo} exceeds ${limits.maxLineBytes} bytes`);
      if (newline === -1) {
        tornTail += 1;
        break;
      }
      const line = bytes.subarray(start, end);
      start = newline + 1;
      let text: string;
      let parsed: unknown;
      try {
        text = UTF8.decode(line);
        parsed = JSON.parse(text);
      } catch {
        evidenceError(`${name}:${lineNo} is not valid JSON`);
      }
      const problem = validateShadowGateEvent(parsed);
      if (problem) evidenceError(`${name}:${lineNo} is not a valid shadow-gate event (${problem})`);
      const kept = seen.get(text);
      if (kept !== undefined) {
        duplicateCopies[kept] = (duplicateCopies[kept] ?? 0) + 1;
        continue;
      }
      seen.set(text, events.length);
      events.push(parsed as ShadowGateEvent);
    }
  }
  return { events, duplicateCopies, tornTail, files: segments.length };
}

// ---------------------------------------------------------------------------
// Snapshot reading
// ---------------------------------------------------------------------------

export interface InboundRow {
  seq: number;
  messageId: string;
  routedTo: string;
  terminalReason: string | null;
}

function nonEmptySidecar(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/**
 * Read inbound rows received in [since, until) from a self-contained snapshot.
 * Opened `immutable=1` so no -wal/-shm sidecar is created; a non-empty -wal
 * next to the snapshot would be silently ignored by that mode (hiding rows),
 * so it is refused instead.
 */
export function readInboundWindow(dbPath: string, since: number, until: number): InboundRow[] {
  const absolute = resolve(dbPath);
  try {
    if (!statSync(absolute).isFile()) evidenceError('--db is not a regular file');
  } catch (err) {
    if (err instanceof ShadowGateEvidenceError) throw err;
    evidenceError('--db is unreadable');
  }
  if (nonEmptySidecar(`${absolute}-wal`)) {
    evidenceError('--db has a non-empty -wal sidecar; take the snapshot with the SQLite backup API (sqlite3 .backup)');
  }
  const url = pathToFileURL(absolute);
  url.searchParams.set('immutable', '1');
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(url, { readOnly: true });
    const rows = db.prepare(
      `SELECT seq, message_id, routed_to, terminal_reason FROM inbound_events
        WHERE received_at >= datetime(?, 'unixepoch') AND received_at < datetime(?, 'unixepoch')`,
    ).all(since, until) as Array<{ seq: number; message_id: string; routed_to: string | null; terminal_reason: string | null }>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      messageId: String(r.message_id),
      routedTo: r.routed_to === null ? NULL_ROUTE : PRINTABLE_ROUTE.test(r.routed_to) ? r.routed_to : UNPRINTABLE_ROUTE,
      terminalReason: isNonEmptyString(r.terminal_reason) ? r.terminal_reason : null,
    }));
  } catch {
    throw new ShadowGateEvidenceError('--db could not be read as a WhatSoup database (inbound_events)');
  } finally {
    try {
      db?.close();
    } catch {
      // intentional: nothing to recover when closing a read-only handle.
    }
  }
}

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

export interface ReportOptions {
  instance: string;
  since: number;
  until: number;
  lineage: string | null;
}

export interface Ratio {
  x: number;
  n: number;
  rate: number | null;
}

export interface BoundedRatio extends Ratio {
  /** One-sided 95% Clopper–Pearson upper bound; null when n = 0. */
  cpUpper95: number | null;
}

export interface Rates {
  eligible: number;
  ok: number;
  suppress: number;
  suppressOverOk: Ratio;
  suppressOverEligible: Ratio;
  echoedJoined: number;
  echoedAll: number;
  proxyDisagreement: number;
  /** OK-only: SUPPRESS on echoed rows over echoed rows whose verdict is OK. */
  disagreementOverEchoedOk: BoundedRatio;
  disagreementOverEchoedJoined: BoundedRatio;
  disagreementOverEchoedAll: BoundedRatio;
  disagreementConservative: BoundedRatio;
  proxyConfirmedOverLabeled: Ratio;
}

export interface BootMarkers {
  bootId: string;
  armed: number;
  counts: number;
  disarmed: number;
  lastCounts: ShadowGateCoverageEvent['counts'] | null;
  /** Sink state in the last WRITTEN marker; a degraded sink writes no further markers. */
  lastSinkState: ShadowGateCoverageEvent['sinkState'] | null;
  lastSinkDegradedReason: string | null;
}

export interface LatencyStats {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface RulePartition {
  gateVersion: number;
  rulesSha256: string;
  featureVersion: number;
  received: number;
  rates: Rates;
}

export interface ShadowGateReport {
  schema: 'shadow-gate-report/v1';
  instance: string;
  window: { since: number; until: number };
  lineage: string | null;
  lineagesSeen: string[];
  coverage: {
    eligible: number;
    received: number;
    missing: number;
    excludedRouted: number;
    excludedSynthetic: number;
    routedTo: Record<string, number>;
    unknownRoutedTo: string[];
    unknownRoutedEligible: number;
    /** Recorder counters are cumulative per boot at its last marker, not windowed. */
    countersScope: 'cumulative-per-boot';
    invalid: number;
    written: number;
    recorderDropped: number;
    journalFailures: number;
    duplicate: number;
    conflicting: number;
    seqMismatch: number;
    unjoined: number;
    tornTail: number;
    segmentFiles: number;
    markers: BootMarkers[];
    bootsWithoutArmed: string[];
    warning: string | null;
  };
  status: { ok: number; error: Record<ShadowGateErrorReason, number> };
  labels: { labeled: number; pending: number; echoedAll: number; echoedJoined: number; echoedMissing: number };
  /** Null when more than one rules partition is present: rates are then per partition only. */
  pooled: Rates | null;
  /** SPAWN/SUPPRESS count OK results only; ERROR counts every other status. */
  perRule: Record<string, { SPAWN: number; SUPPRESS: number; ERROR: number }>;
  partitions: Array<{
    gateVersion: number; rulesSha256: string; featureVersion: number; configGeneration: string; bootId: string; count: number;
  }>;
  rulePartitions: RulePartition[];
  /** `all` covers every received row (OK and ERROR, including OVERRUN); `ok` only OK rows. */
  latency: { all: LatencyStats; ok: LatencyStats };
  caveat: string;
}

interface Joined {
  row: InboundRow;
  event: ShadowGateVerdictEvent;
}

function ratio(x: number, n: number): Ratio {
  return { x, n, rate: n === 0 ? null : x / n };
}

function bounded(x: number, n: number): BoundedRatio {
  return { ...ratio(x, n), cpUpper95: clopperPearsonUpper(x, n) };
}

/**
 * For the proxy rates, ERROR (any reason, including OVERRUN which carries a
 * verdict) counts as SPAWN. The conservative rate instead counts an echoed
 * ERROR row against the gate, like a missing one.
 */
function effectiveVerdict(ev: ShadowGateVerdictEvent): 'SPAWN' | 'SUPPRESS' {
  return ev.status === 'OK' && ev.verdict === 'SUPPRESS' ? 'SUPPRESS' : 'SPAWN';
}

/**
 * Rates over `received` plus every missing row. Per partition, all missing
 * rows are attributed to each partition: their verdict is unknown, so the
 * conservative denominators must include them.
 */
function computeRates(received: readonly Joined[], missing: readonly InboundRow[]): Rates {
  const ok = received.filter((j) => j.event.status === 'OK');
  const suppressed = received.filter((j) => effectiveVerdict(j.event) === 'SUPPRESS');
  const echoedJoined = received.filter((j) => j.row.terminalReason === ECHOED);
  const echoedOk = echoedJoined.filter((j) => j.event.status === 'OK').length;
  const echoedError = echoedJoined.length - echoedOk;
  const echoedMissing = missing.filter((r) => r.terminalReason === ECHOED).length;
  const echoedAll = echoedJoined.length + echoedMissing;
  const disagreement = suppressed.filter((j) => j.row.terminalReason === ECHOED).length;
  const confirmed = suppressed.filter((j) => j.row.terminalReason === NO_REPLY).length;
  const labeled = received.filter((j) => j.row.terminalReason !== null).length
    + missing.filter((r) => r.terminalReason !== null).length;
  const eligible = received.length + missing.length;
  return {
    eligible,
    ok: ok.length,
    suppress: suppressed.length,
    suppressOverOk: ratio(suppressed.length, ok.length),
    suppressOverEligible: ratio(suppressed.length, eligible),
    echoedJoined: echoedJoined.length,
    echoedAll,
    proxyDisagreement: disagreement,
    disagreementOverEchoedOk: bounded(disagreement, echoedOk),
    disagreementOverEchoedJoined: bounded(disagreement, echoedJoined.length),
    disagreementOverEchoedAll: bounded(disagreement, echoedAll),
    disagreementConservative: bounded(disagreement + echoedError + echoedMissing, echoedAll),
    proxyConfirmedOverLabeled: ratio(confirmed, labeled),
  };
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

function latencyOf(joined: readonly Joined[]): LatencyStats {
  const sorted = joined.map((j) => j.event.tookMs).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? null,
  };
}

function isSynthetic(row: InboundRow): boolean {
  return row.routedTo === SYNTHETIC_ROUTE || SYNTHETIC_ID_PREFIXES.some((prefix) => row.messageId.startsWith(prefix));
}

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

const COUNT_DROP_KEYS = [
  'droppedQueueFull', 'droppedOversize', 'droppedClosed', 'droppedDegraded', 'droppedWriteFailed', 'droppedUnserializable',
] as const;

export function buildShadowGateReport(
  rows: readonly InboundRow[],
  segments: SegmentReadResult,
  opts: ReportOptions,
): ShadowGateReport {
  const sinceMs = opts.since * 1000;
  const untilMs = opts.until * 1000;
  const inWindow = (ts: number): boolean => ts >= sinceMs && ts < untilMs;

  // DB side: eligible population.
  const routedTo = new Map<string, number>();
  const eligibleRows: InboundRow[] = [];
  let excludedRouted = 0;
  let excludedSynthetic = 0;
  let unknownRoutedEligible = 0;
  for (const row of rows) {
    increment(routedTo, row.routedTo);
    if (EXCLUDED_ROUTES.has(row.routedTo)) {
      excludedRouted += 1;
    } else if (isSynthetic(row)) {
      excludedSynthetic += 1;
    } else {
      eligibleRows.push(row);
      if (!KNOWN_DISPATCH_ROUTES.has(row.routedTo)) unknownRoutedEligible += 1;
    }
  }
  const eligibleById = new Map(eligibleRows.map((r) => [r.messageId, r]));
  const unknownRoutedTo = [...new Set(eligibleRows.map((r) => r.routedTo))]
    .filter((k) => !KNOWN_DISPATCH_ROUTES.has(k))
    .sort();

  // Event side: instance, window, lineage.
  const indexed = segments.events.map((event, index) => ({ event, copies: segments.duplicateCopies[index] ?? 0 }))
    .filter(({ event }) => event.instance === opts.instance);
  const verdictsInScope = indexed.filter(({ event }) => event.event === 'shadow_gate_verdict'
    && (eligibleById.has(event.messageId) || inWindow(event.ts)));
  const coverageInWindow = indexed.filter(({ event }) => event.event === 'shadow_gate_coverage' && inWindow(event.ts));
  const lineagesSeen = [...new Set([...verdictsInScope, ...coverageInWindow].map(({ event }) => event.databaseLineage))].sort();
  let lineage = opts.lineage;
  if (lineage === null) {
    if (lineagesSeen.length > 1) {
      evidenceError(
        `${lineagesSeen.length} databaseLineages in the window (${lineagesSeen.join(', ')}); pass --lineage`,
      );
    }
    lineage = lineagesSeen[0] ?? null;
  }
  const sameLineage = <T extends { event: ShadowGateEvent }>(items: T[]): T[] =>
    lineage === null ? items : items.filter(({ event }) => event.databaseLineage === lineage);
  const verdicts = sameLineage(verdictsInScope) as Array<{ event: ShadowGateVerdictEvent; copies: number }>;
  const coverageEvents = sameLineage(indexed.filter(({ event }) => event.event === 'shadow_gate_coverage')) as Array<
    { event: ShadowGateCoverageEvent; copies: number }
  >;

  let duplicate = 0;
  for (const { copies } of verdicts) duplicate += copies;
  for (const { event, copies } of coverageEvents) if (inWindow(event.ts)) duplicate += copies;

  // Conflicts: more than one distinct verdict for one message.
  const byMessage = new Map<string, ShadowGateVerdictEvent[]>();
  for (const { event } of verdicts) {
    const list = byMessage.get(event.messageId) ?? [];
    list.push(event);
    byMessage.set(event.messageId, list);
  }
  let conflicting = 0;
  let unjoined = 0;
  let seqMismatch = 0;
  const receivedById = new Map<string, Joined>();
  for (const [messageId, list] of byMessage) {
    if (list.length > 1) {
      conflicting += 1;
      continue;
    }
    const row = eligibleById.get(messageId);
    const event = list[0]!;
    if (!row) {
      unjoined += 1;
      continue;
    }
    if (event.inboundSeq !== null && event.inboundSeq !== row.seq) {
      seqMismatch += 1;
      continue;
    }
    receivedById.set(messageId, { row, event });
  }
  const received = [...receivedById.values()];
  const missingRows = eligibleRows.filter((r) => !receivedById.has(r.messageId));

  // Coverage markers.
  const bootIds = new Set<string>();
  for (const { event } of verdicts) bootIds.add(event.bootId);
  for (const { event } of coverageEvents) if (inWindow(event.ts)) bootIds.add(event.bootId);
  const markers: BootMarkers[] = [...bootIds].sort().map((bootId) => {
    const own = coverageEvents.map(({ event }) => event).filter((e) => e.bootId === bootId);
    const inside = own.filter((e) => inWindow(e.ts));
    const latest = own.filter((e) => e.ts < untilMs).sort((a, b) => a.ts - b.ts).at(-1);
    return {
      bootId,
      armed: inside.filter((e) => e.marker === 'armed').length,
      counts: inside.filter((e) => e.marker === 'counts').length,
      disarmed: inside.filter((e) => e.marker === 'disarmed').length,
      lastCounts: latest ? { ...latest.counts } : null,
      lastSinkState: latest?.sinkState ?? null,
      lastSinkDegradedReason: latest?.sinkDegradedReason ?? null,
    };
  });
  const armedBoots = new Set(coverageEvents.filter(({ event }) => event.marker === 'armed').map(({ event }) => event.bootId));
  const bootsWithoutArmed = [...bootIds].filter((id) => !armedBoots.has(id)).sort();
  let invalid = 0;
  let written = 0;
  let recorderDropped = 0;
  let journalFailures = 0;
  for (const m of markers) {
    if (!m.lastCounts) continue;
    invalid += m.lastCounts.invalid;
    written += m.lastCounts.written;
    journalFailures += m.lastCounts.journalFailures;
    for (const key of COUNT_DROP_KEYS) recorderDropped += m.lastCounts[key];
  }

  // Status.
  const error: Record<ShadowGateErrorReason, number> = { OVERRUN: 0, E_THROW: 0, E_INPUT: 0 };
  let ok = 0;
  for (const { event } of received) {
    if (event.status === 'OK') ok += 1;
    else if (event.reason) error[event.reason] += 1;
  }

  // Partitions.
  const partitionCounts = new Map<string, number>();
  const ruleGroups = new Map<string, Joined[]>();
  const perRule: ShadowGateReport['perRule'] = {};
  for (const j of received) {
    const e = j.event;
    increment(partitionCounts, JSON.stringify([e.gateVersion, e.rulesSha256, e.featureVersion, e.configGeneration, e.bootId]));
    const ruleKey = JSON.stringify([e.gateVersion, e.rulesSha256, e.featureVersion]);
    const group = ruleGroups.get(ruleKey) ?? [];
    group.push(j);
    ruleGroups.set(ruleKey, group);
    const rule = perRule[e.ruleId ?? 'NONE'] ??= { SPAWN: 0, SUPPRESS: 0, ERROR: 0 };
    rule[e.status === 'OK' && e.verdict !== null ? e.verdict : 'ERROR'] += 1;
  }
  const partitions = [...partitionCounts].map(([key, count]) => {
    const [gateVersion, rulesSha256, featureVersion, configGeneration, bootId] = JSON.parse(key) as [
      number, string, number, string, string,
    ];
    return { gateVersion, rulesSha256, featureVersion, configGeneration, bootId, count };
  }).sort((a, b) => b.count - a.count || a.bootId.localeCompare(b.bootId));
  const rulePartitions: RulePartition[] = [...ruleGroups].map(([key, group]) => {
    const [gateVersion, rulesSha256, featureVersion] = JSON.parse(key) as [number, string, number];
    return { gateVersion, rulesSha256, featureVersion, received: group.length, rates: computeRates(group, missingRows) };
  }).sort((a, b) => b.received - a.received || a.rulesSha256.localeCompare(b.rulesSha256));

  const labeled = eligibleRows.filter((r) => r.terminalReason !== null).length;
  const echoedAll = eligibleRows.filter((r) => r.terminalReason === ECHOED).length;
  const echoedJoined = received.filter((j) => j.row.terminalReason === ECHOED).length;

  return {
    schema: 'shadow-gate-report/v1',
    instance: opts.instance,
    window: { since: opts.since, until: opts.until },
    lineage,
    lineagesSeen,
    coverage: {
      eligible: eligibleRows.length,
      received: received.length,
      missing: missingRows.length,
      excludedRouted,
      excludedSynthetic,
      routedTo: Object.fromEntries([...routedTo].sort(([a], [b]) => a.localeCompare(b))),
      unknownRoutedTo,
      unknownRoutedEligible,
      countersScope: 'cumulative-per-boot',
      invalid,
      written,
      recorderDropped,
      journalFailures,
      duplicate,
      conflicting,
      seqMismatch,
      unjoined,
      tornTail: segments.tornTail,
      segmentFiles: segments.files,
      markers,
      bootsWithoutArmed,
      warning: missingRows.length > 0 ? MISSING_WARNING : null,
    },
    status: { ok, error },
    labels: {
      labeled,
      pending: eligibleRows.length - labeled,
      echoedAll,
      echoedJoined,
      echoedMissing: echoedAll - echoedJoined,
    },
    pooled: rulePartitions.length > 1 ? null : computeRates(received, missingRows),
    perRule: Object.fromEntries(Object.entries(perRule).sort(([a], [b]) => a.localeCompare(b))),
    partitions,
    rulePartitions,
    latency: {
      all: latencyOf(received),
      ok: latencyOf(received.filter((j) => j.event.status === 'OK')),
    },
    caveat: PROXY_CAVEAT,
  };
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

function fmtRate(r: Ratio): string {
  return r.rate === null ? `${r.x}/${r.n} = inconclusive` : `${r.x}/${r.n} = ${r.rate.toFixed(4)}`;
}

function fmtBound(r: BoundedRatio): string {
  return r.cpUpper95 === null ? 'inconclusive' : r.cpUpper95.toFixed(6);
}

function rateLines(rates: Rates, indent: string): { suppression: string[]; proxy: string[]; bounds: string[] } {
  return {
    suppression: [
      `${indent}SUPPRESS / valid OK results: ${fmtRate(rates.suppressOverOk)}`,
      `${indent}SUPPRESS / eligible (lower bound): ${fmtRate(rates.suppressOverEligible)}`,
    ],
    proxy: [
      `${indent}proxyDisagreement (SUPPRESS on response_echoed): ${rates.proxyDisagreement}`,
      `${indent}over echoed OK-only: ${fmtRate(rates.disagreementOverEchoedOk)}`,
      `${indent}over echoed_joined: ${fmtRate(rates.disagreementOverEchoedJoined)}`,
      `${indent}over echoed_all: ${fmtRate(rates.disagreementOverEchoedAll)}`,
      `${indent}conservative (missing or ERROR echoed = disagreement): ${fmtRate(rates.disagreementConservative)}`,
      `${indent}proxy-confirmed (SUPPRESS on no_reply_policy) / labeled: ${fmtRate(rates.proxyConfirmedOverLabeled)}`,
    ],
    bounds: [
      `${indent}over echoed OK-only: ${fmtBound(rates.disagreementOverEchoedOk)}`,
      `${indent}over echoed_joined: ${fmtBound(rates.disagreementOverEchoedJoined)}`,
      `${indent}over echoed_all: ${fmtBound(rates.disagreementOverEchoedAll)}`,
      `${indent}conservative: ${fmtBound(rates.disagreementConservative)}`,
    ],
  };
}

export function renderShadowGateReportText(report: ShadowGateReport): string {
  const c = report.coverage;
  const out: string[] = [];
  out.push(`shadow-gate report — instance ${report.instance}, window [${report.window.since}, ${report.window.until})`);
  out.push(`lineage: ${report.lineage ?? 'none (no verdict events)'}; lineages seen: ${report.lineagesSeen.join(', ') || 'none'}`);
  out.push('', '1. Coverage');
  out.push(`  eligible: ${c.eligible}  received: ${c.received}  missing: ${c.missing}`);
  out.push(`  excluded: routed ${c.excludedRouted}, synthetic (agentjob-/obl:) ${c.excludedSynthetic}`);
  out.push(`  routed_to: ${Object.entries(c.routedTo).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  if (c.unknownRoutedTo.length > 0) {
    out.push(`  unknown routed_to values (included as eligible, ${c.unknownRoutedEligible} rows): ${c.unknownRoutedTo.join(', ')}`);
  }
  out.push(`  recorder counters ${COUNTERS_SCOPE_LABEL}:`);
  out.push(`    invalid: ${c.invalid}  written: ${c.written}  recorderDropped: ${c.recorderDropped}  journalFailures: ${c.journalFailures}`);
  out.push(`  conflicting: ${c.conflicting}  duplicate: ${c.duplicate}  seqMismatch: ${c.seqMismatch}  unjoined: ${c.unjoined}  tornTail: ${c.tornTail}`);
  out.push(`  segment files: ${c.segmentFiles}`);
  for (const m of c.markers) {
    const counts = m.lastCounts
      ? Object.entries(m.lastCounts).map(([k, v]) => `${k}=${v}`).join(' ')
      : 'none';
    const sink = m.lastSinkState === null
      ? 'none'
      : `${m.lastSinkState}${m.lastSinkDegradedReason ? ` (${m.lastSinkDegradedReason})` : ''}`;
    out.push(`  boot ${m.bootId}: armed ${m.armed}, counts ${m.counts}, disarmed ${m.disarmed}; last written sink state: ${sink}`);
    out.push(`    last counts ${COUNTERS_SCOPE_LABEL}: ${counts}`);
  }
  out.push(`  boots without an armed marker: ${c.bootsWithoutArmed.length === 0 ? 'none' : c.bootsWithoutArmed.join(', ')}`);
  if (c.warning) out.push(c.warning);

  out.push('', '2. Status (ERROR counts as SPAWN in the proxy rates and as a disagreement in the conservative rate)');
  out.push(`  OK: ${report.status.ok}  ERROR: OVERRUN ${report.status.error.OVERRUN}, E_THROW ${report.status.error.E_THROW}, E_INPUT ${report.status.error.E_INPUT}`);

  const l = report.labels;
  const pooled = report.pooled ? rateLines(report.pooled, '  ') : null;
  const withheld = `  pooled rates withheld: ${report.rulePartitions.length} rules partitions; see per-partition rates in section 7`;
  out.push('', '3. Proposed suppression');
  out.push(...(pooled ? pooled.suppression : [withheld]));
  out.push('', '4. Proxy agreement with history (label = terminal_reason)');
  out.push(`  labeled: ${l.labeled}  pending (no terminal_reason): ${l.pending}  echoed_all: ${l.echoedAll}  echoed_joined: ${l.echoedJoined}  echoed_missing: ${l.echoedMissing}`);
  out.push(...(pooled ? pooled.proxy : [withheld]));
  out.push(`  ${report.caveat}`);
  out.push('', '5. Clopper–Pearson one-sided 95% upper bound on disagreement');
  out.push(...(pooled ? pooled.bounds : [withheld]));

  out.push('', '6. Per-rule breakdown (recorded verdict; SPAWN/SUPPRESS are OK results only)');
  const rules = Object.entries(report.perRule);
  if (rules.length === 0) out.push('  none');
  for (const [rule, v] of rules) out.push(`  ${rule}: SPAWN ${v.SPAWN}, SUPPRESS ${v.SUPPRESS}, ERROR ${v.ERROR}`);

  out.push('', '7. Version partitions');
  if (report.partitions.length === 0) out.push('  none');
  for (const p of report.partitions) {
    out.push(`  gate ${p.gateVersion} rules ${p.rulesSha256.slice(0, 12)} feature ${p.featureVersion} config ${p.configGeneration} boot ${p.bootId}: ${p.count}`);
  }
  if (report.rulePartitions.length > 1) {
    out.push('  per rules partition (missing rows attributed to every partition):');
    for (const rp of report.rulePartitions) {
      const lines = rateLines(rp.rates, '      ');
      out.push(`    gate ${rp.gateVersion} rules ${rp.rulesSha256.slice(0, 12)} feature ${rp.featureVersion}: received ${rp.received}`);
      out.push(...lines.suppression, ...lines.proxy);
      out.push('      Clopper–Pearson 95% upper:', ...lines.bounds);
    }
  }

  const ms = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(3));
  const latencyLine = (label: string, lat: LatencyStats): string =>
    `  ${label}: count ${lat.count}  p50 ${ms(lat.p50)}  p95 ${ms(lat.p95)}  p99 ${ms(lat.p99)}  max ${ms(lat.max)}`;
  out.push('', '8. Latency (tookMs)');
  out.push(latencyLine('all received (OK and ERROR, incl. OVERRUN)', report.latency.all));
  out.push(latencyLine('OK only', report.latency.ok));
  return `${out.join('\n')}\n`;
}
