import { describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const store: Record<string, string> = {};
const mockStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
};

describe('preferences', () => {
  beforeEach(() => { for (const k in store) delete store[k]; });

  it('getPreference returns default when key not set', async () => {
    const { getPreference } = await import('../../console/src/lib/preferences.ts');
    expect(getPreference('metricsRange', '24h', mockStorage as any)).toBe('24h');
  });

  it('setPreference persists and getPreference retrieves', async () => {
    const { getPreference, setPreference } = await import('../../console/src/lib/preferences.ts');
    setPreference('metricsRange', '7d', mockStorage as any);
    expect(getPreference('metricsRange', '24h', mockStorage as any)).toBe('7d');
  });
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

describe('metricsToCSV', () => {
  it('converts message volume to CSV string', async () => {
    const { metricsToCSV } = await import('../../console/src/lib/csv-export.ts');
    const csv = metricsToCSV([
      { bucket: '2026-01-01T00:00:00Z', inbound: 5, outbound: 3 },
      { bucket: '2026-01-01T01:00:00Z', inbound: 2, outbound: 1 },
    ]);
    expect(csv).toContain('bucket,inbound,outbound');
    expect(csv).toContain('2026-01-01T00:00:00Z,5,3');
    expect(csv).toContain('2026-01-01T01:00:00Z,2,1');
  });

  it('returns header-only for empty data', async () => {
    const { metricsToCSV } = await import('../../console/src/lib/csv-export.ts');
    expect(metricsToCSV([])).toBe('bucket,inbound,outbound');
  });
});

// ---------------------------------------------------------------------------
// Integration checks
// ---------------------------------------------------------------------------

describe('MetricsTab CSV export integration', () => {
  it('MetricsTab source imports csv-export', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('console/src/components/line-detail/MetricsTab.tsx', 'utf8');
    expect(source).toContain('csv-export');
    expect(source).toContain('Download');
  });
});

describe('LineDetail preferences integration', () => {
  it('LineDetail source imports preferences', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('console/src/pages/LineDetail.tsx', 'utf8');
    expect(source).toContain('getPreference');
    expect(source).toContain('setPreference');
  });
});
