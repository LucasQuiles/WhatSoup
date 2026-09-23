import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeConfigGeneration,
  computeDatabaseLineage,
  createShadowGateRecorder,
  SHADOW_GATE_EVENT_SCHEMA_VERSION,
  SHADOW_GATE_PROCESS_BOOT_ID,
  validateShadowGateEvent,
} from '../../src/core/shadow-gate-events.ts';
import type {
  ShadowGateCoverageEvent,
  ShadowGateVerdictEvent,
  ShadowGateVerdictInput,
} from '../../src/core/shadow-gate-events.ts';
import { getRulesSha256, SHADOW_GATE_VERSION } from '../../src/core/shadow-gate.ts';
import { FEATURE_VERSION } from '../../src/core/shadow-gate-features.ts';
import type { BoundedNdjsonSink, BoundedNdjsonSinkStats, SinkState } from '../../src/lib/bounded-ndjson-sink.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('shadow-gate-events-');

afterEach(() => {
  vi.useRealTimers();
});

function verdictEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ev: ShadowGateVerdictEvent = {
    schemaVersion: 1,
    ts: 1_700_000_000_000,
    event: 'shadow_gate_verdict',
    instance: 'q',
    databaseLineage: '0123456789abcdef',
    bootId: SHADOW_GATE_PROCESS_BOOT_ID,
    configGeneration: 'fedcba9876543210',
    attemptId: 'attempt-1',
    messageId: 'MSG1',
    inboundSeq: 42,
    chatScope: 'dm',
    status: 'OK',
    reason: null,
    verdict: 'SPAWN',
    ruleId: 'S02_DM',
    tookMs: 0.4,
    gateVersion: SHADOW_GATE_VERSION,
    rulesSha256: getRulesSha256(),
    featureVersion: FEATURE_VERSION,
    authority: 'advisory_only',
  };
  return { ...ev, ...overrides };
}

function coverageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ev: ShadowGateCoverageEvent = {
    schemaVersion: 1,
    ts: 1_700_000_000_000,
    event: 'shadow_gate_coverage',
    instance: 'q',
    databaseLineage: 'memory',
    bootId: SHADOW_GATE_PROCESS_BOOT_ID,
    configGeneration: 'fedcba9876543210',
    marker: 'armed',
    counts: {
      evaluated: 0, recorded: 0, droppedQueueFull: 0, droppedOversize: 0,
      droppedClosed: 0, droppedDegraded: 0, droppedWriteFailed: 0, droppedUnserializable: 0,
      invalid: 0, writeErrors: 0, journalFailures: 0,
    },
    sinkState: 'starting',
    sinkDegradedReason: null,
    gateVersion: SHADOW_GATE_VERSION,
    rulesSha256: getRulesSha256(),
    featureVersion: FEATURE_VERSION,
    authority: 'advisory_only',
  };
  return { ...ev, ...overrides };
}

const verdictInput: ShadowGateVerdictInput = {
  attemptId: 'attempt-1',
  messageId: 'MSG1',
  inboundSeq: 7,
  chatScope: 'group',
  status: 'OK',
  reason: null,
  verdict: 'SUPPRESS',
  ruleId: 'X02_STATUS_ONLY',
  tookMs: 1.25,
};

describe('validateShadowGateEvent', () => {
  it('accepts canonical verdict and coverage events', () => {
    expect(validateShadowGateEvent(verdictEvent())).toBeNull();
    expect(validateShadowGateEvent(coverageEvent())).toBeNull();
    expect(validateShadowGateEvent(verdictEvent({
      status: 'ERROR', reason: 'OVERRUN', verdict: 'SUPPRESS', ruleId: 'X03_NO_REPLY_PATTERN',
    }))).toBeNull();
    expect(validateShadowGateEvent(verdictEvent({ status: 'ERROR', reason: 'E_THROW', verdict: null, ruleId: null }))).toBeNull();
    expect(validateShadowGateEvent(verdictEvent({ status: 'ERROR', reason: 'E_INPUT', verdict: null, ruleId: null }))).toBeNull();
    expect(validateShadowGateEvent(verdictEvent({ inboundSeq: null }))).toBeNull();
  });

  it.each([
    ['non-object', null, 'not_object'],
    ['unknown event type', verdictEvent({ event: 'shadow_gate_other' }), 'unknown_event'],
    ['unknown key', verdictEvent({ text: 'hello' }), 'unknown_key'],
    ['missing key', (() => { const e = verdictEvent(); delete e.tookMs; return e; })(), 'missing_key'],
    ['wrong schema version', verdictEvent({ schemaVersion: 2 }), 'bad_schema_version'],
    ['negative tookMs', verdictEvent({ tookMs: -1 }), 'bad_took_ms'],
    ['non-finite tookMs', verdictEvent({ tookMs: Number.POSITIVE_INFINITY }), 'bad_took_ms'],
    ['NaN tookMs', verdictEvent({ tookMs: Number.NaN }), 'bad_took_ms'],
    ['messageId over 128 chars', verdictEvent({ messageId: 'm'.repeat(129) }), 'bad_message_id'],
    ['attemptId over 128 chars', verdictEvent({ attemptId: 'a'.repeat(129) }), 'bad_attempt_id'],
    ['instance over 128 chars', verdictEvent({ instance: 'i'.repeat(129) }), 'bad_instance'],
    ['bootId over 128 chars', verdictEvent({ bootId: 'b'.repeat(129) }), 'bad_boot_id'],
    ['non-hex rulesSha256', verdictEvent({ rulesSha256: 'g'.repeat(64) }), 'bad_rules_sha256'],
    ['short rulesSha256', verdictEvent({ rulesSha256: 'a'.repeat(63) }), 'bad_rules_sha256'],
    ['uppercase rulesSha256', verdictEvent({ rulesSha256: 'A'.repeat(64) }), 'bad_rules_sha256'],
    ['wrong authority', verdictEvent({ authority: 'enforcing' }), 'bad_authority'],
    ['OK without verdict', verdictEvent({ verdict: null, ruleId: null }), 'ok_without_verdict'],
    ['OK with reason', verdictEvent({ reason: 'OVERRUN' }), 'ok_with_reason'],
    ['verdict without ruleId', verdictEvent({ ruleId: null }), 'verdict_rule_mismatch'],
    ['unknown verdict', verdictEvent({ verdict: 'MAYBE' }), 'bad_verdict'],
    ['unknown ruleId', verdictEvent({ ruleId: 'Z99' }), 'bad_rule_id'],
    ['ERROR without reason', verdictEvent({ status: 'ERROR', reason: null }), 'bad_reason'],
    ['E_THROW with verdict', verdictEvent({ status: 'ERROR', reason: 'E_THROW' }), 'error_with_verdict'],
    ['OVERRUN without verdict', verdictEvent({ status: 'ERROR', reason: 'OVERRUN', verdict: null, ruleId: null }), 'overrun_without_verdict'],
    ['unknown status', verdictEvent({ status: 'MAYBE' }), 'bad_status'],
    ['bad chatScope', verdictEvent({ chatScope: 'channel' }), 'bad_chat_scope'],
    ['negative inboundSeq', verdictEvent({ inboundSeq: -1 }), 'bad_inbound_seq'],
    ['bad marker', coverageEvent({ marker: 'paused' }), 'bad_marker'],
    ['unknown counts key', coverageEvent({ counts: { ...(coverageEvent().counts as object), extra: 1 } }), 'counts_unknown_key'],
    ['negative count', coverageEvent({ counts: { ...(coverageEvent().counts as object), recorded: -1 } }), 'bad_count_value'],
    ['bad sinkState', coverageEvent({ sinkState: 'open' }), 'bad_sink_state'],
    ['coverage wrong authority', coverageEvent({ authority: 'advisory' }), 'bad_authority'],
  ])('rejects %s', (_name, ev, code) => {
    expect(validateShadowGateEvent(ev)).toBe(code);
  });

  const baseCounts = coverageEvent().counts as Record<string, number>;
  it.each(['droppedWriteFailed', 'droppedUnserializable', 'invalid'])('requires the %s count', (key) => {
    const counts = { ...baseCounts };
    delete counts[key];
    expect(validateShadowGateEvent(coverageEvent({ counts }))).toBe('counts_missing_key');
    expect(validateShadowGateEvent(coverageEvent({ counts: { ...baseCounts, [key]: -1 } }))).toBe('bad_count_value');
    expect(validateShadowGateEvent(coverageEvent({ counts: { ...baseCounts, [key]: 1.5 } }))).toBe('bad_count_value');
    expect(validateShadowGateEvent(coverageEvent({ counts: { ...baseCounts, [key]: 3 } }))).toBeNull();
  });

  it.each([
    ['messageId', 'bad_message_id', verdictEvent],
    ['attemptId', 'bad_attempt_id', verdictEvent],
    ['bootId', 'bad_boot_id', verdictEvent],
    ['instance', 'bad_instance', verdictEvent],
    ['databaseLineage', 'bad_database_lineage', coverageEvent],
    ['configGeneration', 'bad_config_generation', coverageEvent],
  ] as const)('rejects a %s outside the closed id charset', (field, code, make) => {
    for (const bad of ['user@s.whatsapp.net', '+0000000', 'group@g.us', 'has space', 'tab\there', 'é', '']) {
      expect(validateShadowGateEvent(make({ [field]: bad }))).toBe(code);
    }
    for (const good of ['3EB0A1B2C3D4', 'agent-job_1.2:3', 'a'.repeat(128)]) {
      expect(validateShadowGateEvent(make({ [field]: good }))).toBeNull();
    }
  });
});

describe('identity helpers', () => {
  it('computeDatabaseLineage returns memory for :memory:', () => {
    expect(computeDatabaseLineage(':memory:')).toBe('memory');
  });

  it('computeDatabaseLineage is 16 hex for a real file and unknown for a missing one', () => {
    const dir = tmp.make('lineage');
    const db = join(dir, 'bot.db');
    writeFileSync(db, '');
    const lineage = computeDatabaseLineage(db);
    expect(lineage).toMatch(/^[0-9a-f]{16}$/);
    expect(computeDatabaseLineage(db)).toBe(lineage);
    expect(computeDatabaseLineage(join(dir, 'missing.db'))).toBe('unknown');
  });

  it('computeConfigGeneration is key-order independent and value sensitive', () => {
    const a = computeConfigGeneration({ enabled: true, nested: { x: 1, y: [1, { b: 2, a: 1 }] } });
    const b = computeConfigGeneration({ nested: { y: [1, { a: 1, b: 2 }], x: 1 }, enabled: true });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(computeConfigGeneration({ enabled: false, nested: { x: 1, y: [1, { a: 1, b: 2 }] } })).not.toBe(a);
  });

  it('SHADOW_GATE_PROCESS_BOOT_ID is a UUID', () => {
    expect(SHADOW_GATE_PROCESS_BOOT_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

function readEvents(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, 'shadow-gate-events.000001.ndjson'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('createShadowGateRecorder', () => {
  it('writes armed, verdict and disarmed lines in order through the real sink', async () => {
    const dir = join(tmp.make('recorder'), 'events');
    let t = 1000;
    const recorder = createShadowGateRecorder({
      dir, instance: 'q', databaseLineage: 'memory', configGeneration: 'fedcba9876543210', now: () => (t += 1),
    });
    recorder.noteEvaluated();
    recorder.recordVerdict(verdictInput);
    await recorder.close(1000);
    const events = readEvents(dir);
    expect(events.map((e) => e.event === 'shadow_gate_coverage' ? e.marker : e.event))
      .toEqual(['armed', 'shadow_gate_verdict', 'disarmed']);
    for (const e of events) expect(validateShadowGateEvent(e)).toBeNull();
    expect(events[1]).toMatchObject({
      ...verdictInput,
      schemaVersion: SHADOW_GATE_EVENT_SCHEMA_VERSION,
      instance: 'q',
      bootId: SHADOW_GATE_PROCESS_BOOT_ID,
      rulesSha256: getRulesSha256(),
      authority: 'advisory_only',
      ts: 1002,
    });
    expect((events[2]!.counts as Record<string, number>)).toMatchObject({ evaluated: 1, recorded: 1 });
    expect(recorder.stats()).toMatchObject({ evaluated: 1, recorded: 1, invalid: 0 });
  });

  it('does not write an invalid verdict, counts it, and emits a closed warn code', async () => {
    const dir = join(tmp.make('invalid'), 'events');
    const warnings: string[] = [];
    const recorder = createShadowGateRecorder({
      dir, instance: 'q', databaseLineage: 'memory', configGeneration: 'fedcba9876543210', warn: (c) => warnings.push(c),
    });
    expect(() => recorder.recordVerdict({ ...verdictInput, tookMs: -5 })).not.toThrow();
    expect(() => recorder.recordVerdict({ ...verdictInput, text: 'secret' } as ShadowGateVerdictInput)).not.toThrow();
    expect(() => recorder.recordVerdict(null as unknown as ShadowGateVerdictInput)).not.toThrow();
    await recorder.close(1000);
    expect(readEvents(dir).map((e) => e.marker ?? e.event)).toEqual(['armed', 'disarmed']);
    expect(readEvents(dir)[1]!.counts).toMatchObject({ invalid: 3, recorded: 0 });
    expect(recorder.stats()).toMatchObject({ recorded: 0, invalid: 3 });
    expect(warnings).toEqual(['shadow_gate_invalid_verdict', 'shadow_gate_invalid_verdict', 'shadow_gate_invalid_verdict']);
    expect(JSON.stringify(readEvents(dir))).not.toContain('secret');
  });

  it('emits a counts marker every countsIntervalMs and stops after close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const records: Array<Record<string, unknown>> = [];
    const stats: BoundedNdjsonSinkStats = {
      queued: 0, written: 0, droppedQueueFull: 2, droppedOversize: 0, droppedClosed: 0, droppedDegraded: 0,
      droppedWriteFailed: 4, droppedUnserializable: 5, writeErrors: 1, segmentIndex: 1, segmentBytes: 0,
    };
    let sinkState: SinkState = 'ready';
    const sink: BoundedNdjsonSink = {
      enqueue: (r) => { records.push(r as Record<string, unknown>); return 'queued'; },
      state: () => sinkState,
      degradedReason: () => null,
      stats: () => stats,
      close: async () => { sinkState = 'closed'; },
    };
    const recorder = createShadowGateRecorder({
      dir: 'unused', instance: 'q', databaseLineage: 'memory', configGeneration: 'fedcba9876543210',
      countsIntervalMs: 1000, sink,
    });
    expect(records.map((r) => r.marker)).toEqual(['armed']);
    recorder.noteEvaluated();
    recorder.noteJournalFailure();
    // A JID-shaped id is rejected by the validator and surfaces as counts.invalid.
    recorder.recordVerdict({ ...verdictInput, messageId: 'user@s.whatsapp.net' });
    expect(records).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(records).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(records.map((r) => r.marker)).toEqual(['armed', 'counts']);
    expect(records[1]!.counts).toEqual({
      evaluated: 1, recorded: 0, droppedQueueFull: 2, droppedOversize: 0,
      droppedClosed: 0, droppedDegraded: 0, droppedWriteFailed: 4, droppedUnserializable: 5,
      invalid: 1, writeErrors: 1, journalFailures: 1,
    });
    for (const r of records) expect(validateShadowGateEvent(r)).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(records.map((r) => r.marker)).toEqual(['armed', 'counts', 'counts']);
    await recorder.close();
    expect(records.map((r) => r.marker)).toEqual(['armed', 'counts', 'counts', 'disarmed']);
    vi.advanceTimersByTime(5000);
    expect(records).toHaveLength(4);
  });
});
