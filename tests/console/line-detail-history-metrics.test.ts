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
    expect({
      SummaryTab: typeof mod.SummaryTab,
      ModeTab: typeof mod.ModeTab,
      PipelineTab: typeof mod.PipelineTab,
      AccessTab: typeof mod.AccessTab,
      HistoryTab: typeof mod.HistoryTab,
      LogsTab: typeof mod.LogsTab,
      MetricsTab: typeof mod.MetricsTab,
    }).toEqual({
      SummaryTab: 'function',
      ModeTab: 'function',
      PipelineTab: 'function',
      AccessTab: 'function',
      HistoryTab: 'function',
      LogsTab: 'function',
      MetricsTab: 'function',
    });
  });

  it('barrel exports dialog components', async () => {
    const mod = await import('../../console/src/components/line-detail/index.ts');
    expect({
      ConfigEditDialog: typeof mod.ConfigEditDialog,
      ModeSwitchDialog: typeof mod.ModeSwitchDialog,
    }).toEqual({
      ConfigEditDialog: 'function',
      ModeSwitchDialog: 'function',
    });
  });

  it('exports exactly 13 named items', async () => {
    const mod = await import('../../console/src/components/line-detail/index.ts');
    expect(Object.keys(mod).sort()).toEqual([
      'AccessTab',
      'ApprovalsTab',
      'ConfigEditDialog',
      'GroupsTab',
      'HistoryTab',
      'LogsTab',
      'MetricsTab',
      'ModeSwitchDialog',
      'ModeTab',
      'PipelineTab',
      'ProvidersKeysCard',
      'ScheduledTab',
      'SummaryTab',
    ]);
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
    expect({
      useMetrics: typeof mod.useMetrics,
      useFleetMetrics: typeof mod.useFleetMetrics,
      getMetricsQueryOptions: typeof mod.getMetricsQueryOptions,
      getFleetMetricsQueryOptions: typeof mod.getFleetMetricsQueryOptions,
    }).toEqual({
      useMetrics: 'function',
      useFleetMetrics: 'function',
      getMetricsQueryOptions: 'function',
      getFleetMetricsQueryOptions: 'function',
    });
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
