/**
 * LineDetail — structural tests for tab components, metrics, and history.
 * Tests the decomposed tab components and metrics chart helpers.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// LineDetail tab barrel exports
// ---------------------------------------------------------------------------

describe('line-detail tab components', () => {
  it('barrel exports all expected tab components', async () => {
    const mod = await import('../../console/src/components/line-detail/index.ts');
    expect(mod.SummaryTab).toBeDefined();
    expect(mod.ModeTab).toBeDefined();
    expect(mod.PipelineTab).toBeDefined();
    expect(mod.AccessTab).toBeDefined();
    expect(mod.HistoryTab).toBeDefined();
    expect(mod.LogsTab).toBeDefined();
    expect(mod.MetricsTab).toBeDefined();
  });

  it('barrel exports dialog components', async () => {
    const mod = await import('../../console/src/components/line-detail/index.ts');
    expect(mod.ConfigEditDialog).toBeDefined();
    expect(mod.ModeSwitchDialog).toBeDefined();
  });

  it('exports exactly 9 named items', async () => {
    const mod = await import('../../console/src/components/line-detail/index.ts');
    const exportNames = Object.keys(mod);
    expect(exportNames.length).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// MetricsChart component
// ---------------------------------------------------------------------------

describe('MetricsChart', () => {
  it('is exported from components/MetricsChart', async () => {
    const mod = await import('../../console/src/components/MetricsChart.tsx');
    expect(mod.MetricsChart).toBeDefined();
    expect(typeof mod.MetricsChart).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// ActiveHoursHeatmap component
// ---------------------------------------------------------------------------

describe('ActiveHoursHeatmap', () => {
  it('is exported from components/ActiveHoursHeatmap', async () => {
    const mod = await import('../../console/src/components/ActiveHoursHeatmap.tsx');
    expect(mod.ActiveHoursHeatmap).toBeDefined();
    expect(typeof mod.ActiveHoursHeatmap).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Metrics hook
// ---------------------------------------------------------------------------

describe('metrics hooks', () => {
  it('exports useMetrics and useFleetMetrics', async () => {
    const mod = await import('../../console/src/hooks/use-metrics.ts');
    expect(mod.useMetrics).toBeDefined();
    expect(mod.useFleetMetrics).toBeDefined();
    expect(mod.getMetricsQueryOptions).toBeDefined();
    expect(mod.getFleetMetricsQueryOptions).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LineDetail page
// ---------------------------------------------------------------------------

describe('LineDetail page structure', () => {
  it('is a default export', async () => {
    const mod = await import('../../console/src/pages/LineDetail.tsx');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// History tab uses virtual scrolling hook
// ---------------------------------------------------------------------------

describe('virtual scrolling integration', () => {
  it('useVirtualMessages hook is exported', async () => {
    const mod = await import('../../console/src/hooks/use-virtual-messages.ts');
    expect(mod.useVirtualMessages).toBeDefined();
    expect(typeof mod.useVirtualMessages).toBe('function');
  });
});
