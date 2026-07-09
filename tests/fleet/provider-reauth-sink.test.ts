import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Deliberately NOT mocking '../../src/lib/emit-alert.ts' — this file proves the
// REAL alert module writes real records to WHATSOUP_ALERT_SINK end-to-end.
// throttle/silence/logger mocks are kept from the Task 11 prologue: the
// alert-throttle-store mock matters because real (file-backed) throttle state
// would leak between test runs — the mocked store keeps it in-memory only.
const alertThrottleStore = vi.hoisted(() => ({
  loadAlertThrottle: vi.fn(() => new Map<string, string>()),
  loadAlertThrottleDetailed: vi.fn((): {
    entries: Map<string, string>;
    loadError: { file: string; code?: string; error: string } | null;
  } => ({ entries: new Map<string, string>(), loadError: null })),
  recordAlertThrottle: vi.fn(),
}));
const silenceManager = vi.hoisted(() => ({
  isInstanceSilenced: vi.fn(() => false),
}));
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/fleet/alert-throttle-store.ts', () => ({
  ALERT_THROTTLE_INTERVAL_MS: 15 * 60 * 1000,
  ...alertThrottleStore,
}));

vi.mock('../../src/fleet/silence-manager.ts', () => silenceManager);

// Suppress pino output during tests (this also silences src/lib/emit-alert.ts's
// own logger, since it resolves to the same src/logger.ts module).
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    ...logger,
    child: vi.fn().mockReturnThis(),
  }),
}));

function makeInstance(overrides: Partial<InstanceHealth> = {}): InstanceHealth {
  return {
    name: 'remote-1',
    type: 'chat',
    accessMode: 'open',
    healthPort: 9100,
    healthToken: null,
    ...overrides,
  };
}

function makeInstances(...items: [string, InstanceHealth][]): Map<string, InstanceHealth> {
  return new Map(items);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(HERE, '..', 'fixtures', 'health', name), 'utf8'));

function fetchReturning(body: Record<string, unknown>, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  });
}

let sinkFile: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sinkFile = path.join(mkdtempSync(path.join(tmpdir(), 'reauth-sink-')), 'sink.jsonl');
  process.env.WHATSOUP_ALERT_SINK = sinkFile;
});
afterEach(() => {
  delete process.env.WHATSOUP_ALERT_SINK;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function sinkRecords(): Array<Record<string, any>> {
  if (!existsSync(sinkFile)) return [];
  return readFileSync(sinkFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

it('ALERT-13: replaying the incident fixture lands exactly one critical record in the sink', async () => {
  vi.stubGlobal('fetch', fetchReturning(fixture('provider-reauth-required.json')));
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }));
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  poller.stop();
  const alerts = sinkRecords().filter((r) => r.eventType === 'alert' && r.source === 'provider_reauth_required');
  expect(alerts).toHaveLength(1);
  expect(alerts[0].severity).toBe('critical');
  expect(alerts[0].instance).toBe('ad-bot');
});

it('ALERT-13A: the recovery-window fixture lands exactly one clear with the recovery code', async () => {
  const mockFetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => fixture('provider-reauth-required.json') })
    .mockResolvedValue({ ok: true, status: 200, json: async () => fixture('provider-reauth-recovered.json') });
  vi.stubGlobal('fetch', mockFetch);
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }), 5_000);
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5_000);
  poller.stop();
  const clears = sinkRecords().filter((r) => r.eventType === 'clear' && r.source === 'provider_reauth_required');
  expect(clears).toHaveLength(1);
  expect(String(clears[0].evidence)).toContain('AGENT_PROVIDER_AUTH_RECOVERED');
});

it('ALERT-16: every sink record survives the canonical secret-shape taxonomy', async () => {
  vi.stubGlobal('fetch', fetchReturning(fixture('provider-reauth-required.json')));
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }));
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  poller.stop();
  const { secretPatterns } = await import('../../scripts/repo-hygiene-guard.ts');
  expect(secretPatterns.length).toBeGreaterThan(0); // non-vacuous: the import carries real patterns
  const records = sinkRecords();
  expect(records.length).toBeGreaterThan(0); // non-vacuous: the sweep must actually inspect something
  for (const record of records) {
    const raw = JSON.stringify(record);
    for (const p of secretPatterns) {
      expect(p.regex.test(raw), `sink record must not contain ${p.code}`).toBe(false);
    }
  }
});
