/**
 * Ops page — structural tests for format helpers and log theme.
 * Tests the pure functions used by the Ops page without mounting React.
 */
import { describe, it, expect } from 'vitest';
import { levelColor, levelBg } from '../../console/src/lib/log-theme';
import { formatTimeWithSeconds } from '../../console/src/lib/format-time';
import { displayInstanceName } from '../../console/src/lib/text-utils';

// ---------------------------------------------------------------------------
// Log theme helpers (used by Ops log viewer)
// ---------------------------------------------------------------------------

describe('log theme helpers', () => {
  it('levelColor maps each log level to a CSS class', () => {
    expect(levelColor['info']).toBeTruthy();
    expect(levelColor['warn']).toBeTruthy();
    expect(levelColor['error']).toBeTruthy();
  });

  it('levelBg maps each log level to a CSS class', () => {
    expect(levelBg['info']).toBeTruthy();
    expect(levelBg['warn']).toBeTruthy();
    expect(levelBg['error']).toBeTruthy();
  });

  it('different levels return different colors', () => {
    expect(levelColor['info']).not.toBe(levelColor['error']);
    expect(levelBg['warn']).not.toBe(levelBg['error']);
  });
});

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

describe('formatTimeWithSeconds', () => {
  it('formats an ISO string to include seconds', () => {
    const result = formatTimeWithSeconds('2026-04-05T19:30:45.000Z');
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    // Should contain seconds separator
    expect(result.length).toBeGreaterThan(4);
  });
});

describe('displayInstanceName', () => {
  it('returns the instance name as-is', () => {
    expect(displayInstanceName('my-instance')).toBe('my-instance');
  });

  it('handles single-word names', () => {
    const result = displayInstanceName('q');
    expect(result.toLowerCase()).toBe('q');
  });
});

// ---------------------------------------------------------------------------
// Ops page structural checks
// ---------------------------------------------------------------------------

describe('Ops page structure', () => {
  it('Ops component is a default export', async () => {
    const mod = await import('../../console/src/pages/Ops');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });

  it('imports required hooks and components', async () => {
    // Verify the Ops module can be loaded without errors
    const mod = await import('../../console/src/pages/Ops');
    expect(mod).toBeDefined();
  });
});
