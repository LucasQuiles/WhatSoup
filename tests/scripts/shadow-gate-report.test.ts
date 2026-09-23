import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { clopperPearsonUpper } from '../../src/lib/clopper-pearson.ts';
import { validateShadowGateEvent } from '../../src/core/shadow-gate-events.ts';
import type { ShadowGateCoverageEvent, ShadowGateVerdictEvent } from '../../src/core/shadow-gate-events.ts';
import { parseArgs, runShadowGateReport } from '../../scripts/shadow-gate-report.ts';
import type { ShadowGateReport } from '../../scripts/lib/shadow-gate-report.ts';

const CLI_PATH = fileURLToPath(new URL('../../scripts/shadow-gate-report.ts', import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

const tmp = trackTmpDirs('whatsoup-shadow-report-');

const SINCE = 1_800_000_000;
const UNTIL = SINCE + 3600;
const INSTANCE = 'fixture-bot';
const LINEAGE = '0123456789abcdef';
const BOOT_A = 'boot-a-0000';
const BOOT_B = 'boot-b-1111';
const RULES_A = 'a'.repeat(64);
const RULES_B = 'b'.repeat(64);
const CONFIG_GEN = 'cfg0000000000001';
const SEQ_BASE = 900_001;
// Canaries: none of these may ever reach report output.
const FIXTURE_JID = '15550009999@s.whatsapp.net';
const FIXTURE_PHONE = '15550009999';
const FIXTURE_TEXT = 'fixture private text canary';

interface FixtureRow {
  messageId: string;
  routedTo: string | null;
  terminalReason: string | null;
  offset?: number;
}

// Row index i gets seq SEQ_BASE + i.
const ROWS: FixtureRow[] = [
  { messageId: 'm-echo-suppress', routedTo: 'agentruntime', terminalReason: 'response_echoed' },
  { messageId: 'm-echo-spawn', routedTo: 'agentruntime', terminalReason: 'response_echoed' },
  { messageId: 'm-echo-missing', routedTo: 'agentruntime', terminalReason: 'response_echoed' },
  { messageId: 'm-noreply-suppress', routedTo: 'agentruntime', terminalReason: 'no_reply_policy' },
  { messageId: 'm-pending', routedTo: 'agentruntime', terminalReason: null },
  { messageId: 'm-error', routedTo: 'agentruntime', terminalReason: 'response_echoed' },
  { messageId: 'm-overrun', routedTo: 'agentruntime', terminalReason: 'no_reply_policy' },
  { messageId: 'm-dup', routedTo: 'agentruntime', terminalReason: 'response_echoed' },
  { messageId: 'm-conflict', routedTo: 'agentruntime', terminalReason: 'response_echoed' },
  { messageId: 'm-seqmis', routedTo: 'agentruntime', terminalReason: 'no_reply_policy' },
  { messageId: 'm-bootb', routedTo: 'agentruntime', terminalReason: 'response_echoed' },
  { messageId: 'm-unknown-route', routedTo: 'mysteryruntime', terminalReason: 'no_reply_policy' },
  { messageId: 'm-denied', routedTo: 'none', terminalReason: 'access_denied' },
  { messageId: 'agentjob-7-1800000100-occ1', routedTo: 'agent', terminalReason: 'response_echoed' },
  { messageId: 'obl:5:1', routedTo: 'agent', terminalReason: null },
  { messageId: 'm-before-window', routedTo: 'agentruntime', terminalReason: 'response_echoed', offset: -10 },
];

function seqOf(messageId: string): number {
  return SEQ_BASE + ROWS.findIndex((r) => r.messageId === messageId);
}

function makeDb(dir: string): string {
  const dbPath = path.join(dir, 'snapshot.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE inbound_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      received_at TEXT NOT NULL,
      routed_to TEXT,
      processing_status TEXT NOT NULL DEFAULT 'pending',
      completed_at TEXT,
      terminal_reason TEXT,
      UNIQUE(message_id)
    );
    CREATE TABLE messages (conversation_key TEXT, content TEXT);
  `);
  const insert = db.prepare(`
    INSERT INTO inbound_events (seq, message_id, conversation_key, chat_jid, received_at, routed_to, terminal_reason)
    VALUES (?, ?, ?, ?, datetime(?, 'unixepoch'), ?, ?)
  `);
  ROWS.forEach((row, i) => {
    insert.run(SEQ_BASE + i, row.messageId, FIXTURE_PHONE, FIXTURE_JID, SINCE + (row.offset ?? 60 + i), row.routedTo, row.terminalReason);
  });
  db.prepare('INSERT INTO messages VALUES (?, ?)').run(FIXTURE_PHONE, FIXTURE_TEXT);
  db.close();
  return dbPath;
}

let attempt = 0;

function verdict(messageId: string, overrides: Partial<ShadowGateVerdictEvent> = {}): ShadowGateVerdictEvent {
  attempt += 1;
  const event: ShadowGateVerdictEvent = {
    schemaVersion: 1,
    ts: (SINCE + 120) * 1000 + attempt,
    event: 'shadow_gate_verdict',
    instance: INSTANCE,
    databaseLineage: LINEAGE,
    bootId: BOOT_A,
    configGeneration: CONFIG_GEN,
    attemptId: `attempt-${attempt}`,
    messageId,
    inboundSeq: seqOf(messageId),
    chatScope: 'dm',
    status: 'OK',
    reason: null,
    verdict: 'SPAWN',
    ruleId: 'S02_DM',
    tookMs: 1,
    gateVersion: 1,
    rulesSha256: RULES_A,
    featureVersion: 1,
    authority: 'advisory_only',
    ...overrides,
  };
  expect(validateShadowGateEvent(event)).toBeNull();
  return event;
}

function coverage(
  marker: ShadowGateCoverageEvent['marker'],
  ts: number,
  overrides: Partial<ShadowGateCoverageEvent> = {},
): ShadowGateCoverageEvent {
  const event: ShadowGateCoverageEvent = {
    schemaVersion: 1,
    ts,
    event: 'shadow_gate_coverage',
    instance: INSTANCE,
    databaseLineage: LINEAGE,
    bootId: BOOT_A,
    configGeneration: CONFIG_GEN,
    marker,
    counts: {
      evaluated: marker === 'armed' ? 0 : 12,
      recorded: marker === 'armed' ? 0 : 11,
      written: marker === 'armed' ? 0 : 20,
      droppedQueueFull: marker === 'armed' ? 0 : 1,
      droppedOversize: 0,
      droppedClosed: 0,
      droppedDegraded: 0,
      droppedWriteFailed: 0,
      droppedUnserializable: 0,
      invalid: marker === 'armed' ? 0 : 2,
      writeErrors: 0,
      journalFailures: marker === 'armed' ? 0 : 1,
    },
    sinkState: 'ready',
    sinkDegradedReason: null,
    gateVersion: 1,
    rulesSha256: RULES_A,
    featureVersion: 1,
    authority: 'advisory_only',
    ...overrides,
  };
  expect(validateShadowGateEvent(event)).toBeNull();
  return event;
}

const line = (event: object): string => `${JSON.stringify(event)}\n`;

interface FixtureOptions {
  bootBRules?: string;
  extraLineage?: boolean;
  extraCoverageLineage?: boolean;
}

function writeSegments(dir: string, opts: FixtureOptions = {}): void {
  const suppress = { verdict: 'SUPPRESS' as const, ruleId: 'X03_NO_REPLY_PATTERN' as const };
  const dupLine = line(verdict('m-dup', { tookMs: 2.5 }));
  const first = [
    line(coverage('armed', (SINCE + 1) * 1000)),
    line(verdict('m-echo-suppress', { ...suppress, tookMs: 0.5 })),
    line(verdict('m-echo-spawn', { tookMs: 1 })),
    line(verdict('m-noreply-suppress', { ...suppress, tookMs: 1.5 })),
    line(verdict('m-pending', { tookMs: 2 })),
    line(verdict('m-error', { status: 'ERROR', reason: 'E_THROW', verdict: null, ruleId: null, tookMs: 0 })),
    line(verdict('m-overrun', { status: 'ERROR', reason: 'OVERRUN', ...suppress, tookMs: 9 })),
    dupLine,
    dupLine,
    line(verdict('m-conflict', { tookMs: 1 })),
    line(verdict('m-conflict', { ...suppress, tookMs: 1 })),
    line(verdict('m-seqmis', { inboundSeq: 999 })),
    line(verdict('m-bootb', { bootId: BOOT_B, rulesSha256: opts.bootBRules ?? RULES_A, tookMs: 3 })),
    line(verdict('m-unknown-route', { inboundSeq: null, tookMs: 3.5 })),
    line(verdict('m-not-in-db')),
    line(verdict('m-echo-missing', { instance: 'other-bot' })),
    line(coverage('counts', (SINCE + 600) * 1000)),
  ];
  if (opts.extraLineage) first.push(line(verdict('m-echo-spawn', { databaseLineage: 'fedcba9876543210' })));
  if (opts.extraCoverageLineage) {
    first.push(line(coverage('armed', (SINCE + 700) * 1000, { bootId: 'boot-c-2222', databaseLineage: 'fedcba9876543210' })));
  }
  writeFileSync(path.join(dir, 'shadow-gate-events.000001.ndjson'), first.join(''));
  // Torn tail: a parseable verdict for a missing row, without its newline.
  const torn = JSON.stringify(verdict('m-echo-missing'));
  writeFileSync(path.join(dir, 'shadow-gate-events.000002.ndjson'), torn);
  writeFileSync(path.join(dir, 'shadow-gate-events.lock'), 'not a segment');
  writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
}

function makeFixture(opts: FixtureOptions = {}): { dbDir: string; dbPath: string; eventsDir: string } {
  const root = tmp.make('fixture');
  const dbDir = path.join(root, 'db');
  const eventsDir = path.join(root, 'events');
  mkdirSync(dbDir);
  mkdirSync(eventsDir);
  return { dbDir, dbPath: makeDb(dbDir), eventsDir: (writeSegments(eventsDir, opts), eventsDir) };
}

function baseArgs(f: { dbPath: string; eventsDir: string }): string[] {
  return ['--db', f.dbPath, '--events', f.eventsDir, '--instance', INSTANCE, '--since', String(SINCE), '--until', String(UNTIL)];
}

function runJson(argv: string[]): { code: number; report: ShadowGateReport } {
  let out = '';
  const code = runShadowGateReport([...argv, '--json'], (text) => { out += text; });
  return { code, report: JSON.parse(out) as ShadowGateReport };
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CLI_PATH, ...args],
    { encoding: 'utf8' },
  );
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('shadow-gate report', () => {
  it('is exposed through the pinned-node wrapper like its neighbours', () => {
    expect(packageJson.scripts['report:shadow-gate']).toBe('bash scripts/run-with-pinned-node.sh scripts/shadow-gate-report.ts');
  });

  it('counts every coverage and missingness category', () => {
    const f = makeFixture();
    const { code, report } = runJson(baseArgs(f));
    expect(code).toBe(0);
    expect(report.lineage).toBe(LINEAGE);
    expect(report.coverage).toMatchObject({
      eligible: 12,
      received: 9,
      missing: 3,
      excludedRouted: 1,
      excludedSynthetic: 2,
      routedTo: { agent: 2, agentruntime: 11, mysteryruntime: 1, none: 1 },
      unknownRoutedTo: ['mysteryruntime'],
      unknownRoutedEligible: 1,
      countersScope: 'cumulative-per-boot',
      invalid: 2,
      written: 20,
      recorderDropped: 1,
      journalFailures: 1,
      duplicate: 1,
      conflicting: 1,
      seqMismatch: 1,
      unjoined: 1,
      tornTail: 1,
      segmentFiles: 2,
      bootsWithoutArmed: [BOOT_B],
      warning: 'WARNING: rates below are computed on joined rows; missing evidence may hide disagreements',
    });
    expect(report.coverage.markers).toEqual([
      expect.objectContaining({
        bootId: BOOT_A, armed: 1, counts: 1, disarmed: 0, lastSinkState: 'ready', lastSinkDegradedReason: null,
      }),
      {
        bootId: BOOT_B, armed: 0, counts: 0, disarmed: 0, lastCounts: null, lastSinkState: null, lastSinkDegradedReason: null,
      },
    ]);
    expect(report.coverage.markers[0]!.lastCounts).toMatchObject({ evaluated: 12, recorded: 11, written: 20, invalid: 2 });
  });

  it('prints the last written sink state per boot and labels counters as cumulative per boot', () => {
    const f = makeFixture();
    const segment = path.join(f.eventsDir, 'shadow-gate-events.000001.ndjson');
    writeFileSync(segment, readFileSync(segment, 'utf8') + line(coverage('counts', (SINCE + 900) * 1000, {
      sinkState: 'degraded', sinkDegradedReason: 'segment_cap_reached',
    })));
    const { report } = runJson(baseArgs(f));
    expect(report.coverage.markers[0]).toMatchObject({ lastSinkState: 'degraded', lastSinkDegradedReason: 'segment_cap_reached' });
    let text = '';
    runShadowGateReport(baseArgs(f), (t) => { text += t; });
    expect(text).toContain(`boot ${BOOT_A}: armed 1, counts 2, disarmed 0; last written sink state: degraded (segment_cap_reached)`);
    expect(text).toContain('recorder counters (cumulative per boot at last marker, not windowed):');
    expect(text).toContain(`boot ${BOOT_B}: armed 0, counts 0, disarmed 0; last written sink state: none`);
  });

  it('excludes routed_to = agent as synthetic even without a synthetic id prefix', () => {
    const f = makeFixture();
    const db = new DatabaseSync(f.dbPath);
    db.prepare(`INSERT INTO inbound_events (message_id, conversation_key, chat_jid, received_at, routed_to, terminal_reason)
      VALUES (?, ?, ?, datetime(?, 'unixepoch'), ?, ?)`).run('m-agent-route', FIXTURE_PHONE, FIXTURE_JID, SINCE + 32, 'agent', 'response_echoed');
    db.close();
    const { report } = runJson(baseArgs(f));
    expect(report.coverage).toMatchObject({ eligible: 12, excludedSynthetic: 3, unknownRoutedTo: ['mysteryruntime'] });
    expect(report.coverage.routedTo.agent).toBe(3);
  });

  it('counts ERROR as SPAWN in proxy rates, against the gate conservatively, and prints OK-only rates', () => {
    const f = makeFixture();
    const { report } = runJson(baseArgs(f));
    expect(report.status).toEqual({ ok: 7, error: { OVERRUN: 1, E_THROW: 1 } });
    expect(report.labels).toEqual({ labeled: 11, pending: 1, echoedAll: 7, echoedJoined: 5, echoedMissing: 2 });
    const pooled = report.pooled!;
    expect(pooled.suppressOverOk).toEqual({ x: 2, n: 7, rate: 2 / 7 });
    expect(pooled.suppressOverEligible).toEqual({ x: 2, n: 12, rate: 2 / 12 });
    expect(pooled.proxyDisagreement).toBe(1);
    // Echoed joined rows: four OK plus the E_THROW row m-error.
    expect(pooled.disagreementOverEchoedOk).toEqual({ x: 1, n: 4, rate: 1 / 4, cpUpper95: clopperPearsonUpper(1, 4) });
    expect(pooled.disagreementOverEchoedJoined).toEqual({ x: 1, n: 5, rate: 1 / 5, cpUpper95: clopperPearsonUpper(1, 5) });
    expect(pooled.disagreementOverEchoedAll).toEqual({ x: 1, n: 7, rate: 1 / 7, cpUpper95: clopperPearsonUpper(1, 7) });
    // One SUPPRESS, one echoed ERROR and two missing echoed rows.
    expect(pooled.disagreementConservative).toEqual({ x: 4, n: 7, rate: 4 / 7, cpUpper95: clopperPearsonUpper(4, 7) });
    // The OVERRUN row carries SUPPRESS but counts as SPAWN, so only one row is proxy-confirmed.
    expect(pooled.proxyConfirmedOverLabeled).toEqual({ x: 1, n: 11, rate: 1 / 11 });
  });

  it('a boot whose every verdict is E_THROW has conservative disagreement equal to the echoed count', () => {
    const f = makeFixture();
    const eventsDir = tmp.make('all-throw');
    const eligible = ROWS.filter((r) => r.routedTo !== 'none' && r.routedTo !== 'agent' && r.offset === undefined);
    writeFileSync(path.join(eventsDir, 'shadow-gate-events.000001.ndjson'), [
      line(coverage('armed', (SINCE + 1) * 1000)),
      ...eligible.map((r) => line(verdict(r.messageId, { status: 'ERROR', reason: 'E_THROW', verdict: null, ruleId: null }))),
    ].join(''));
    const { code, report } = runJson(['--db', f.dbPath, '--events', eventsDir, '--instance', INSTANCE, '--since', String(SINCE), '--until', String(UNTIL)]);
    expect(code).toBe(0);
    expect(report.coverage).toMatchObject({ eligible: 12, received: 12, missing: 0 });
    expect(report.status.error.E_THROW).toBe(12);
    const pooled = report.pooled!;
    expect(pooled.disagreementConservative).toEqual({ x: 7, n: 7, rate: 1, cpUpper95: 1 });
    expect(pooled.disagreementOverEchoedJoined).toEqual({ x: 0, n: 7, rate: 0, cpUpper95: clopperPearsonUpper(0, 7) });
    expect(pooled.disagreementOverEchoedOk).toEqual({ x: 0, n: 0, rate: null, cpUpper95: null });
  });

  it('reports per-rule counts, version partitions and latency over all and OK-only rows', () => {
    const f = makeFixture();
    const { report } = runJson(baseArgs(f));
    // SPAWN/SUPPRESS hold OK results only: the OVERRUN SUPPRESS row is an ERROR.
    expect(report.perRule).toEqual({
      NONE: { SPAWN: 0, SUPPRESS: 0, ERROR: 1 },
      S02_DM: { SPAWN: 5, SUPPRESS: 0, ERROR: 0 },
      X03_NO_REPLY_PATTERN: { SPAWN: 0, SUPPRESS: 2, ERROR: 1 },
    });
    expect(report.partitions).toEqual([
      { gateVersion: 1, rulesSha256: RULES_A, featureVersion: 1, configGeneration: CONFIG_GEN, bootId: BOOT_A, count: 8 },
      { gateVersion: 1, rulesSha256: RULES_A, featureVersion: 1, configGeneration: CONFIG_GEN, bootId: BOOT_B, count: 1 },
    ]);
    expect(report.rulePartitions).toHaveLength(1);
    // All nine received rows, including E_THROW (0) and OVERRUN (9).
    expect(report.latency.all).toEqual({ count: 9, p50: 2, p95: 9, p99: 9, max: 9 });
    expect(report.latency.ok).toEqual({ count: 7, p50: 2, p95: 3.5, p99: 3.5, max: 3.5 });
  });

  it('withholds pooled rates and reports them per rules partition when rules differ', () => {
    const f = makeFixture({ bootBRules: RULES_B });
    const { report } = runJson(baseArgs(f));
    expect(report.pooled).toBeNull();
    const [a, b] = report.rulePartitions;
    expect(a).toMatchObject({ rulesSha256: RULES_A, received: 8 });
    expect(b).toMatchObject({ rulesSha256: RULES_B, received: 1 });
    // Missing rows (two of them echoed) are attributed to every partition.
    expect(a!.rates.disagreementConservative).toEqual({ x: 4, n: 6, rate: 4 / 6, cpUpper95: clopperPearsonUpper(4, 6) });
    expect(b!.rates.disagreementOverEchoedJoined).toEqual({ x: 0, n: 1, rate: 0, cpUpper95: clopperPearsonUpper(0, 1) });
    expect(b!.rates.disagreementConservative).toEqual({ x: 2, n: 3, rate: 2 / 3, cpUpper95: clopperPearsonUpper(2, 3) });

    let text = '';
    expect(runShadowGateReport(baseArgs(f), (t) => { text += t; })).toBe(0);
    expect(text).toContain('pooled rates withheld: 2 rules partitions');
    expect(text).toContain('per rules partition');
  });

  it('prints coverage first and never prints JIDs, phone numbers, text or message ids', () => {
    const f = makeFixture();
    const text = runCli(baseArgs(f));
    const json = runCli([...baseArgs(f), '--json']);
    expect(text.code).toBe(0);
    expect(json.code).toBe(0);
    const sections = ['1. Coverage', '2. Status', '3. Proposed suppression', '4. Proxy agreement', '5. Clopper', '6. Per-rule', '7. Version', '8. Latency'];
    const positions = sections.map((s) => text.stdout.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(text.stdout).toContain('WARNING: rates below are computed on joined rows');
    expect(text.stdout).toContain('response_echoed is historical behaviour, not proof a reply was required');
    for (const out of [text.stdout, text.stderr, json.stdout, json.stderr]) {
      for (const canary of [FIXTURE_JID, FIXTURE_PHONE, FIXTURE_TEXT, '@s.whatsapp.net', ...ROWS.map((r) => r.messageId)]) {
        expect(out).not.toContain(canary);
      }
    }
  });

  it('never creates sidecars next to a WAL-mode snapshot', () => {
    const f = makeFixture();
    expect(readdirSync(f.dbDir)).toEqual(['snapshot.db']);
    expect(runJson(baseArgs(f)).code).toBe(0);
    expect(readdirSync(f.dbDir)).toEqual(['snapshot.db']);
  });

  it('refuses a snapshot with a non-empty -wal sidecar (exit 65)', () => {
    const f = makeFixture();
    writeFileSync(`${f.dbPath}-wal`, 'uncheckpointed');
    const result = runCli(baseArgs(f));
    expect(result.code).toBe(65);
    expect(result.stderr).toContain('non-empty -wal sidecar');
  });

  it('exits 65 on an invalid interior line, naming file and line but not content', () => {
    const f = makeFixture();
    const segment = path.join(f.eventsDir, 'shadow-gate-events.000001.ndjson');
    const lines = readFileSync(segment, 'utf8').split('\n');
    lines.splice(2, 0, JSON.stringify({ event: 'shadow_gate_verdict', secret: FIXTURE_TEXT }));
    writeFileSync(segment, lines.join('\n'));
    const result = runCli(baseArgs(f));
    expect(result.code).toBe(65);
    expect(result.stderr).toContain('shadow-gate-events.000001.ndjson:3');
    expect(result.stderr).not.toContain(FIXTURE_TEXT);
  });

  it('exits 65 when a line exceeds the per-line bound', () => {
    const f = makeFixture();
    writeFileSync(path.join(f.eventsDir, 'shadow-gate-events.000003.ndjson'), `${'x'.repeat(5000)}\n`);
    const result = runCli(baseArgs(f));
    expect(result.code).toBe(65);
    expect(result.stderr).toContain('shadow-gate-events.000003.ndjson:1 exceeds 4096 bytes');
  });

  it('exits 65 on more than one lineage unless --lineage selects one', () => {
    const f = makeFixture({ extraLineage: true });
    const ambiguous = runCli(baseArgs(f));
    expect(ambiguous.code).toBe(65);
    expect(ambiguous.stderr).toContain('pass --lineage');
    const { code, report } = runJson([...baseArgs(f), '--lineage', LINEAGE]);
    expect(code).toBe(0);
    expect(report.coverage.received).toBe(9);
    expect(report.lineagesSeen).toEqual(['0123456789abcdef', 'fedcba9876543210']);
  });

  it('exits 65 when only coverage markers span a second lineage', () => {
    const f = makeFixture({ extraCoverageLineage: true });
    const ambiguous = runCli(baseArgs(f));
    expect(ambiguous.code).toBe(65);
    expect(ambiguous.stderr).toContain('2 databaseLineages in the window');
    const { code, report } = runJson([...baseArgs(f), '--lineage', LINEAGE]);
    expect(code).toBe(0);
    expect(report.coverage.markers.map((m) => m.bootId)).toEqual([BOOT_A, BOOT_B]);
  });

  it('reports everything missing, not an error, when no verdict evidence exists', () => {
    const f = makeFixture();
    const empty = tmp.make('empty-events');
    const { code, report } = runJson(['--db', f.dbPath, '--events', empty, '--instance', INSTANCE, '--since', String(SINCE), '--until', String(UNTIL)]);
    expect(code).toBe(0);
    expect(report.coverage).toMatchObject({ eligible: 12, received: 0, missing: 12 });
    expect(report.pooled!.disagreementOverEchoedJoined.cpUpper95).toBeNull();
    expect(report.pooled!.disagreementConservative).toEqual({ x: 7, n: 7, rate: 1, cpUpper95: 1 });
  });

  it('keeps NULL and unprintable routed_to values visible and eligible, never printing them raw', () => {
    const f = makeFixture();
    const db = new DatabaseSync(f.dbPath);
    const insert = db.prepare(`INSERT INTO inbound_events (message_id, conversation_key, chat_jid, received_at, routed_to)
      VALUES (?, ?, ?, datetime(?, 'unixepoch'), ?)`);
    insert.run('m-null-route', FIXTURE_PHONE, FIXTURE_JID, SINCE + 30, null);
    insert.run('m-odd-route', FIXTURE_PHONE, FIXTURE_JID, SINCE + 31, FIXTURE_JID);
    db.close();
    const { report } = runJson(baseArgs(f));
    expect(report.coverage.routedTo['(null)']).toBe(1);
    expect(report.coverage.routedTo['(unprintable)']).toBe(1);
    expect(report.coverage.unknownRoutedTo).toEqual(['(null)', '(unprintable)', 'mysteryruntime']);
    expect(report.coverage).toMatchObject({ eligible: 14, missing: 5, unknownRoutedEligible: 3 });
    expect(JSON.stringify(report)).not.toContain(FIXTURE_JID);
  });

  it('exits 65 when a segment cannot be read', () => {
    const f = makeFixture();
    mkdirSync(path.join(f.eventsDir, 'shadow-gate-events.000009.ndjson'));
    const result = runCli(baseArgs(f));
    expect(result.code).toBe(65);
    expect(result.stderr).toContain('shadow-gate-events.000009.ndjson is not a regular file');
  });

  it('exits 64 on a missing --since and on an inverted window', () => {
    const f = makeFixture();
    const noSince = runCli(['--db', f.dbPath, '--events', f.eventsDir, '--instance', INSTANCE, '--until', String(UNTIL)]);
    expect(noSince.code).toBe(64);
    expect(noSince.stderr).toContain('--since is required');
    expect(noSince.stderr).toContain('usage: shadow-gate-report');
    expect(() => parseArgs(['--db', 'a', '--events', 'b', '--instance', INSTANCE, '--since', '5', '--until', '5'])).toThrow(
      '--since must be earlier than --until',
    );
    expect(() => parseArgs(['--db', 'a', '--events', 'b', '--instance', 'x@y', '--since', '1', '--until', '5'])).toThrow(
      '--instance must be a recorded instance id',
    );
    // The validator's digit-run rule: such an instance can never have recorded events.
    expect(() => parseArgs(['--db', 'a', '--events', 'b', '--instance', 'bot-15551234567', '--since', '1', '--until', '5'])).toThrow(
      '--instance must be a recorded instance id',
    );
    // --lineage keeps the charset-only rule (lineages are hex hashes).
    expect(parseArgs(['--db', 'a', '--events', 'b', '--instance', INSTANCE, '--lineage', '1234567890123456', '--since', '1', '--until', '5']).lineage)
      .toBe('1234567890123456');
    expect(() => parseArgs(['--db', 'a', '--events', 'b', '--instance', INSTANCE, '--lineage', 'x'.repeat(129), '--since', '1', '--until', '5']))
      .toThrow('--lineage must be a recorded databaseLineage');
  });
});
