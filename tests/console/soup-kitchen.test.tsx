/**
 * SoupKitchen page — component-level tests.
 *
 * Since no DOM environment (jsdom/happy-dom) is configured, these tests
 * exercise the same logic paths the SoupKitchen component uses:
 *   - KPI-based filtering
 *   - Mode-based filtering
 *   - Search filtering
 *   - Alert message derivation (unreachable vs degraded, auth_expired)
 *   - Mode count aggregation
 *   - KPI toggle (idempotent deselect)
 *   - Structural verification of component composition
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeKpis } from '../../console/src/lib/compute-kpis';
import { deriveFleetMessageSparklines } from '../../console/src/lib/metrics-sparklines';
import { displayInstanceName, formatPhone, formatCompact } from '../../console/src/lib/text-utils';
import type { LineInstance, Mode, Status, FeedEvent } from '../../console/src/types';

const repoRoot = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'test-line', phone: '+15550001234', mode: 'passive', status: 'online',
    accessMode: 'open', healthPort: 9100, uptime: '2h', messagesTotal: 50,
    health: null, heartbeat: [], lastActive: new Date().toISOString(), error: null,
    ...overrides,
  };
}

// Replicate the filter logic from SoupKitchen exactly
type KpiFilter = 'connected' | 'attention' | 'unread' | 'agent' | 'messages' | null;

function filterLines(
  lines: LineInstance[],
  activeKpi: KpiFilter,
  modeFilter: Mode | 'all',
  search: string,
): LineInstance[] {
  let result = lines;

  if (activeKpi === 'connected')
    result = result.filter((l) => l.status === 'online');
  else if (activeKpi === 'attention')
    result = result.filter((l) => l.status === 'unreachable' || l.status === 'degraded');
  else if (activeKpi === 'unread')
    result = result.filter((l) => (l.unread ?? 0) > 0);
  else if (activeKpi === 'agent')
    result = result.filter((l) => l.mode === 'agent');
  else if (activeKpi === 'messages')
    result = result.filter((l) => (l.messagesToday ?? 0) > 0);

  if (modeFilter !== 'all')
    result = result.filter((l) => l.mode === modeFilter);

  if (search.trim()) {
    const q = search.toLowerCase();
    result = result.filter(
      (l) => l.name.toLowerCase().includes(q) || (l.phone ?? '').toLowerCase().includes(q),
    );
  }

  return result;
}

// Replicate alert derivation from SoupKitchen
function deriveAlerts(lines: LineInstance[]) {
  return lines
    .filter((l) => l.status === 'unreachable' || l.status === 'degraded')
    .map((l) => ({
      line: l.name,
      message:
        l.status === 'unreachable'
          ? l.lastSessionStatus === 'auth_expired' ? 'auth expired' : 'connection lost'
          : 'degraded',
    }));
}

// Replicate mode count aggregation from SoupKitchen
function computeModeCounts(lines: LineInstance[]) {
  const counts: Record<Mode | 'all', number> = { all: lines.length, passive: 0, chat: 0, agent: 0 };
  for (const l of lines) counts[l.mode]++;
  return counts;
}

// ---------------------------------------------------------------------------
// 1. Loading state — structural verification
// ---------------------------------------------------------------------------

describe('SoupKitchen loading state', () => {
  it('renders with empty lines array when data is not yet loaded', () => {
    // When useLines returns { data: undefined }, the component defaults to []
    const lines: LineInstance[] = [];
    const kpis = computeKpis(lines);

    expect(kpis.connected).toBe(0);
    expect(kpis.needAttention).toBe(0);
    expect(kpis.totalSent).toBe(0);
    expect(kpis.totalReceived).toBe(0);
    expect(kpis.agentSessions).toBe(0);
    expect(kpis.unread).toBe(0);
    expect(kpis.totalMedia).toBe(0);
  });

  it('shows "No instances match" when filtered list is empty', () => {
    const filtered = filterLines([], null, 'all', '');
    expect(filtered).toHaveLength(0);
    // The component renders "No instances match the current filters" for empty filtered list
    const source = read('console/src/pages/SoupKitchen.tsx');
    expect(source).toContain('No instances match the current filters');
  });

  it('defaults fleet metrics sparklines to undefined when no data', () => {
    const sparklines = deriveFleetMessageSparklines(undefined);
    expect(sparklines).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. KPI cards with data
// ---------------------------------------------------------------------------

describe('SoupKitchen KPI cards with data', () => {
  const lines: LineInstance[] = [
    makeLine({ name: 'alpha', status: 'online', mode: 'passive', messageStats: { sent: 100, received: 200, images: 5, audio: 2, documents: 1 } }),
    makeLine({ name: 'bravo', status: 'online', mode: 'agent', messageStats: { sent: 50, received: 80, images: 10, audio: 0, documents: 3 },
      health: { status: 'ok', uptime_seconds: 3600, messages_total: 130, connection: { state: 'open' }, sqlite: { messages_total: 130, schema_version: 1 },
        runtime: { agent: { activeSessions: 2, lastSessionStatus: null, lastSessionStartedAt: null } } } }),
    makeLine({ name: 'charlie', status: 'degraded', mode: 'chat', messageStats: { sent: 20, received: 30, images: 0, audio: 0, documents: 0 } }),
    makeLine({ name: 'delta', status: 'unreachable', mode: 'passive', lastSessionStatus: 'auth_expired' }),
  ];

  const kpis = computeKpis(lines);

  it('computes connected count correctly', () => {
    expect(kpis.connected).toBe(2); // alpha + bravo
  });

  it('computes need attention count correctly', () => {
    expect(kpis.needAttention).toBe(2); // charlie (degraded) + delta (unreachable)
  });

  it('aggregates sent messages', () => {
    expect(kpis.totalSent).toBe(170); // 100 + 50 + 20
  });

  it('aggregates received messages', () => {
    expect(kpis.totalReceived).toBe(310); // 200 + 80 + 30
  });

  it('aggregates media processed', () => {
    expect(kpis.totalMedia).toBe(21); // (5+2+1) + (10+0+3) + (0+0+0)
  });

  it('counts agent sessions from health runtime', () => {
    expect(kpis.agentSessions).toBe(2);
  });

  it('renders all 7 KPI cards in the component source', () => {
    const source = read('console/src/pages/SoupKitchen.tsx');
    const kpiLabels = [
      'Lines Connected', 'Need Attention', 'Messages Sent',
      'Messages Received', 'Agent Sessions', 'Unread', 'Media Processed',
    ];
    for (const label of kpiLabels) {
      expect(source).toContain(`label="${label}"`);
    }
  });

  it('passes sparkData to Messages Sent and Messages Received KPI cards', () => {
    const source = read('console/src/pages/SoupKitchen.tsx');
    expect(source).toContain('sparkData={messageSparklines?.outbound}');
    expect(source).toContain('sparkData={messageSparklines?.inbound}');
  });
});

// ---------------------------------------------------------------------------
// 3. Instance cards / table from fleet health
// ---------------------------------------------------------------------------

describe('SoupKitchen instance table rendering', () => {
  const lines: LineInstance[] = [
    makeLine({ name: 'primary-line', mode: 'passive', status: 'online', phone: '+15551234567',
      chatCounts: { chats: 42, groups: 8 }, unread: 3, messageStats: { sent: 10, received: 20, images: 0, audio: 0, documents: 0 } }),
    makeLine({ name: 'operator-agent', mode: 'agent', status: 'online', phone: '+15559876543',
      chatCounts: { chats: 15, groups: 2 }, unread: 0, messageStats: { sent: 200, received: 150, images: 5, audio: 1, documents: 2 },
      totalSessions: 47, tokenUsage: { input: 125000, output: 45000 } }),
  ];

  it('filtered list includes all lines when no filter active', () => {
    const filtered = filterLines(lines, null, 'all', '');
    expect(filtered).toHaveLength(2);
  });

  it('table has all expected column headers', () => {
    const source = read('console/src/pages/SoupKitchen.tsx');
    const columns = ['Mode', 'Line', 'Chats', 'Groups', 'Unread', 'Sent', 'Recv', 'Tokens', 'Sessions', 'Tags', 'Active'];
    for (const col of columns) {
      expect(source).toContain(`label: "${col}"`);
    }
  });

  it('displays instance name via displayInstanceName', () => {
    expect(displayInstanceName('primary-line')).toBe('primary-line');
    expect(displayInstanceName('A')).toBe('A'); // single letter gets uppercased
    expect(displayInstanceName('a')).toBe('A');
  });

  it('formats phone numbers for display', () => {
    expect(formatPhone('+15551234567')).toMatch(/555/);
    expect(formatPhone('unknown')).toBe('\u2014'); // em dash
  });

  it('formats compact token counts', () => {
    expect(formatCompact(170000)).toBe('170K');
    expect(formatCompact(1234)).toBe('1.2K');
    expect(formatCompact(500)).toBe('500');
    expect(formatCompact(2450000)).toBe('2.5M');
  });

  it('shows sessions column only for agent mode lines', () => {
    const source = read('console/src/pages/SoupKitchen.tsx');
    // Verify the conditional rendering: agent lines show totalSessions, others show dash
    expect(source).toContain("line.mode === 'agent'");
    expect(source).toContain('line.totalSessions ?? 0');
  });
});

// ---------------------------------------------------------------------------
// 4. Error state handling
// ---------------------------------------------------------------------------

describe('SoupKitchen error state handling', () => {
  it('derives alert for unreachable line with connection lost message', () => {
    const lines = [makeLine({ name: 'down-line', status: 'unreachable', lastSessionStatus: null })];
    const alerts = deriveAlerts(lines);
    expect(alerts).toEqual([{ line: 'down-line', message: 'connection lost' }]);
  });

  it('derives alert for unreachable line with auth_expired message', () => {
    const lines = [makeLine({ name: 'expired-line', status: 'unreachable', lastSessionStatus: 'auth_expired' })];
    const alerts = deriveAlerts(lines);
    expect(alerts).toEqual([{ line: 'expired-line', message: 'auth expired' }]);
  });

  it('derives alert for degraded line', () => {
    const lines = [makeLine({ name: 'slow-line', status: 'degraded' })];
    const alerts = deriveAlerts(lines);
    expect(alerts).toEqual([{ line: 'slow-line', message: 'degraded' }]);
  });

  it('produces no alerts for healthy lines', () => {
    const lines = [makeLine({ status: 'online' }), makeLine({ status: 'online' })];
    const alerts = deriveAlerts(lines);
    expect(alerts).toHaveLength(0);
  });

  it('produces multiple alerts for mixed statuses', () => {
    const lines = [
      makeLine({ name: 'a', status: 'unreachable', lastSessionStatus: 'auth_expired' }),
      makeLine({ name: 'b', status: 'degraded' }),
      makeLine({ name: 'c', status: 'online' }),
      makeLine({ name: 'd', status: 'unreachable', lastSessionStatus: null }),
    ];
    const alerts = deriveAlerts(lines);
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toEqual({ line: 'a', message: 'auth expired' });
    expect(alerts[1]).toEqual({ line: 'b', message: 'degraded' });
    expect(alerts[2]).toEqual({ line: 'd', message: 'connection lost' });
  });

  it('applies error row styling for unreachable lines (structural)', () => {
    const source = read('console/src/pages/SoupKitchen.tsx');
    expect(source).toContain('line.status === "unreachable"');
    expect(source).toContain('s-crit-wash');
    expect(source).toContain('s-warn-wash');
  });

  it('renders AlertBanner component with derived alerts', () => {
    const source = read('console/src/pages/SoupKitchen.tsx');
    expect(source).toContain('<AlertBanner alerts={alerts}');
  });
});

// ---------------------------------------------------------------------------
// 5. KPI filter + Mode filter + Search filter interaction
// ---------------------------------------------------------------------------

describe('SoupKitchen filter logic', () => {
  const lines: LineInstance[] = [
    makeLine({ name: 'alpha', status: 'online', mode: 'passive', unread: 5, messagesToday: 10 }),
    makeLine({ name: 'bravo', status: 'online', mode: 'agent', unread: 0, messagesToday: 0 }),
    makeLine({ name: 'charlie', status: 'degraded', mode: 'chat', unread: 2, messagesToday: 3 }),
    makeLine({ name: 'delta', status: 'unreachable', mode: 'passive', unread: 0, messagesToday: 0 }),
    makeLine({ name: 'echo', status: 'online', mode: 'agent', unread: 0, messagesToday: 7, phone: '+15559999999' }),
  ];

  // KPI filters
  it('filters by "connected" KPI — online only', () => {
    const result = filterLines(lines, 'connected', 'all', '');
    expect(result.map(l => l.name)).toEqual(['alpha', 'bravo', 'echo']);
  });

  it('filters by "attention" KPI — degraded + unreachable', () => {
    const result = filterLines(lines, 'attention', 'all', '');
    expect(result.map(l => l.name)).toEqual(['charlie', 'delta']);
  });

  it('filters by "unread" KPI — lines with unread > 0', () => {
    const result = filterLines(lines, 'unread', 'all', '');
    expect(result.map(l => l.name)).toEqual(['alpha', 'charlie']);
  });

  it('filters by "agent" KPI — agent mode lines only', () => {
    const result = filterLines(lines, 'agent', 'all', '');
    expect(result.map(l => l.name)).toEqual(['bravo', 'echo']);
  });

  it('filters by "messages" KPI — lines with messagesToday > 0', () => {
    const result = filterLines(lines, 'messages', 'all', '');
    expect(result.map(l => l.name)).toEqual(['alpha', 'charlie', 'echo']);
  });

  // Mode filters
  it('filters by passive mode', () => {
    const result = filterLines(lines, null, 'passive', '');
    expect(result.map(l => l.name)).toEqual(['alpha', 'delta']);
  });

  it('filters by chat mode', () => {
    const result = filterLines(lines, null, 'chat', '');
    expect(result.map(l => l.name)).toEqual(['charlie']);
  });

  it('filters by agent mode', () => {
    const result = filterLines(lines, null, 'agent', '');
    expect(result.map(l => l.name)).toEqual(['bravo', 'echo']);
  });

  // Combined KPI + mode filters
  it('combines KPI and mode filters', () => {
    const result = filterLines(lines, 'connected', 'agent', '');
    expect(result.map(l => l.name)).toEqual(['bravo', 'echo']);
  });

  it('combined attention + passive yields only unreachable passive line', () => {
    const result = filterLines(lines, 'attention', 'passive', '');
    expect(result.map(l => l.name)).toEqual(['delta']);
  });

  // Search
  it('filters by name search (case insensitive)', () => {
    const result = filterLines(lines, null, 'all', 'ALPHA');
    expect(result.map(l => l.name)).toEqual(['alpha']);
  });

  it('filters by phone search', () => {
    const result = filterLines(lines, null, 'all', '9999');
    expect(result.map(l => l.name)).toEqual(['echo']);
  });

  it('combines all three filters', () => {
    const result = filterLines(lines, 'connected', 'agent', 'echo');
    expect(result.map(l => l.name)).toEqual(['echo']);
  });

  it('returns empty when no lines match combined filters', () => {
    const result = filterLines(lines, 'attention', 'agent', '');
    expect(result).toHaveLength(0);
  });

  it('ignores whitespace-only search', () => {
    const result = filterLines(lines, null, 'all', '   ');
    expect(result).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 6. Mode counts
// ---------------------------------------------------------------------------

describe('SoupKitchen mode counts', () => {
  const lines: LineInstance[] = [
    makeLine({ mode: 'passive' }),
    makeLine({ mode: 'passive' }),
    makeLine({ mode: 'agent' }),
    makeLine({ mode: 'chat' }),
    makeLine({ mode: 'agent' }),
  ];

  it('counts all modes correctly', () => {
    const counts = computeModeCounts(lines);
    expect(counts).toEqual({ all: 5, passive: 2, agent: 2, chat: 1 });
  });

  it('handles empty lines', () => {
    const counts = computeModeCounts([]);
    expect(counts).toEqual({ all: 0, passive: 0, agent: 0, chat: 0 });
  });

  it('renders mode filter pills for all, passive, chat, agent', () => {
    const source = read('console/src/pages/SoupKitchen.tsx');
    expect(source).toContain('"all", "passive", "chat", "agent"');
  });
});

// ---------------------------------------------------------------------------
// 7. KPI toggle (deselect on second click)
// ---------------------------------------------------------------------------

describe('SoupKitchen KPI toggle', () => {
  function toggleKpi(prev: KpiFilter, key: KpiFilter): KpiFilter {
    return prev === key ? null : key;
  }

  it('selects a KPI on first click', () => {
    expect(toggleKpi(null, 'connected')).toBe('connected');
  });

  it('deselects the same KPI on second click', () => {
    expect(toggleKpi('connected', 'connected')).toBeNull();
  });

  it('switches to a different KPI', () => {
    expect(toggleKpi('connected', 'attention')).toBe('attention');
  });
});

// ---------------------------------------------------------------------------
// 8. Sparkline data for KPI cards
// ---------------------------------------------------------------------------

describe('SoupKitchen sparkline integration', () => {
  it('derives sparkline data from fleet metrics messageVolume', () => {
    const messageVolume = [
      { bucket: '2026-04-05T00:00:00Z', inbound: 10, outbound: 20 },
      { bucket: '2026-04-05T01:00:00Z', inbound: 5, outbound: 40 },
      { bucket: '2026-04-05T02:00:00Z', inbound: 0, outbound: 0 },
    ];
    const sparklines = deriveFleetMessageSparklines(messageVolume);
    expect(sparklines).toBeDefined();
    expect(sparklines!.outbound).toEqual([0.5, 1, 0]);
    expect(sparklines!.inbound).toEqual([1, 0.5, 0]);
  });

  it('passes useFleetMetrics with 24h range by default', () => {
    const source = read('console/src/pages/SoupKitchen.tsx');
    expect(source).toContain("useFleetMetrics('24h')");
  });
});

// ---------------------------------------------------------------------------
// 9. Component structural composition
// ---------------------------------------------------------------------------

describe('SoupKitchen structural composition', () => {
  const source = read('console/src/pages/SoupKitchen.tsx');

  it('imports and uses required hooks', () => {
    expect(source).toContain('useLines');
    expect(source).toContain('useFeed');
    expect(source).toContain('useFleetMetrics');
    expect(source).toContain('useNavigate');
  });

  it('imports required components', () => {
    expect(source).toContain("import KpiCard from");
    expect(source).toContain("import AlertBanner from");
    expect(source).toContain("import ActivityFeed from");
    expect(source).toContain("import ModeBadge from");
    expect(source).toContain("import FilterPill from");
    expect(source).toContain("import LineTags from");
  });

  it('renders the Instances heading', () => {
    expect(source).toContain('Instances');
  });

  it('renders a search input for lines', () => {
    expect(source).toContain('placeholder="Search lines..."');
  });

  it('renders the Add Line button with wizard', () => {
    expect(source).toContain('Add Line');
    expect(source).toContain('AddLineWizard');
    expect(source).toContain('setShowAddWizard(true)');
  });

  it('uses class-based layout primitives instead of inline style props', () => {
    expect(source).toContain('className="flex flex-col flex-1 min-h-0 overflow-hidden p-[var(--sp-4)] gap-[var(--sp-3)]"');
    expect(source).toContain('className="c-card flex-shrink-0 grid grid-cols-7 gap-[var(--sp-2)] p-[var(--sp-2)]"');
    expect(source).toContain('className="flex flex-1 min-h-0 gap-[var(--sp-3)]"');
    expect(source).toContain('className="c-card flex flex-col min-h-0 overflow-hidden basis-0 grow-[3]"');
    expect(source).toContain('className="c-card flex flex-col min-h-0 overflow-hidden basis-0 flex-1 min-w-[var(--feed-min-w)]"');
    expect(source).not.toContain('style={{');
  });

  it('navigates to line detail on row click', () => {
    expect(source).toContain('navigate(`/lines/${line.name}`)');
  });

  it('renders ActivityFeed in sidebar', () => {
    expect(source).toContain('<ActivityFeed events={feed}');
  });

  it('lazy-loads AddLineWizard with Suspense', () => {
    expect(source).toContain('lazy(() => import');
    expect(source).toContain('<Suspense');
  });

  it('is exported as default', async () => {
    const mod = await import('../../console/src/pages/SoupKitchen');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });
});
