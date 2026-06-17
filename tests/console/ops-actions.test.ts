/**
 * Ops page — structural tests for format helpers.
 * Tests the pure functions used by the Ops page without mounting React.
 */
import { describe, it, expect } from 'vitest';
import {
  formatChatTime,
  formatFullTime,
  formatRelative,
  formatTime,
  formatTimeWithSeconds,
} from '../../console/src/lib/format-time';
import { displayInstanceName } from '../../console/src/lib/text-utils';

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

describe('formatTimeWithSeconds', () => {
  it('formats an ISO string to include seconds', () => {
    const result = formatTimeWithSeconds('2026-04-05T19:30:45.000');
    expect(typeof result).toBe('string');
    expect(result).toBe('19:30:45');
  });

  it('returns an em dash for nullish or empty timestamps', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatTime(null)).toBe('—');
    expect(formatTimeWithSeconds(null)).toBe('—');
    expect(formatChatTime(null)).toBe('—');
    expect(formatFullTime(null)).toBe('—');
    expect(formatRelative(undefined)).toBe('—');
    expect(formatTime(undefined)).toBe('—');
    expect(formatTimeWithSeconds(undefined)).toBe('—');
    expect(formatChatTime(undefined)).toBe('—');
    expect(formatFullTime(undefined)).toBe('—');
    expect(formatRelative('')).toBe('—');
    expect(formatTime('')).toBe('—');
    expect(formatTimeWithSeconds('')).toBe('—');
    expect(formatChatTime('')).toBe('—');
    expect(formatFullTime('')).toBe('—');
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
    const mod = await import('../../console/src/pages/Operator');
    expect(typeof mod.default).toBe('function');
  });

  it('imports required hooks and components', async () => {
    // Verify the Ops module can be loaded without errors
    const mod = await import('../../console/src/pages/Operator');
    expect(Object.keys(mod)).toEqual(['default']);
    expect(mod.default).toEqual(expect.any(Function));
  });
});
