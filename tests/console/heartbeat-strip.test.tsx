/**
 * Behavioral contract-lock for console/src/components/HeartbeatStrip.tsx.
 *
 * Critical invariants:
 *   - Always renders exactly STRIP_LENGTH = 20 bars (pad-with-'up' when
 *     shorter; right-truncate-keep-last-20 when longer).
 *   - aria-label exposes `<healthy-count> of <total-beats> heartbeats healthy`
 *     using the *original* beats array (not the normalized 20-bar array).
 *   - role="img" so screen readers treat the strip as a visualization.
 *   - Per-beat color class maps to up/down/slow.
 *
 * No prior test mirror. ReactElement tree inspection only (no DOM/jsdom).
 */
import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import HeartbeatStrip from '../../console/src/components/HeartbeatStrip.tsx';

type Beat = 'up' | 'down' | 'slow';

function render(beats: Beat[]): ReactElement {
  return (HeartbeatStrip as (props: { beats: Beat[] }) => ReactElement)({ beats });
}

function bars(tree: ReactElement): ReactElement[] {
  // tree.props.children = beats.map((b, i) => <div className=... />)
  const children = tree.props.children;
  return Array.isArray(children) ? (children as ReactElement[]) : [children as ReactElement];
}

describe('HeartbeatStrip — bar count (always 20)', () => {
  it('pads with "up" bars on the LEFT when fewer than 20 beats supplied', () => {
    const tree = render(['down']);
    const all = bars(tree);
    expect(all).toHaveLength(20);
    // First 19 should be "up" (padding), last 1 the supplied "down"
    const lastBar = all[19];
    expect(String(lastBar.props.className)).toContain('bg-s-crit');
    const firstBar = all[0];
    expect(String(firstBar.props.className)).toContain('bg-s-ok');
  });

  it('returns exactly 20 bars for an empty beats array', () => {
    const tree = render([]);
    expect(bars(tree)).toHaveLength(20);
  });

  it('returns exactly 20 bars for a 20-beat array (no pad, no truncate)', () => {
    const beats: Beat[] = new Array(20).fill('slow');
    const tree = render(beats);
    const all = bars(tree);
    expect(all).toHaveLength(20);
    for (const bar of all) {
      expect(String(bar.props.className)).toContain('bg-s-warn');
    }
  });

  it('keeps the LAST 20 beats when more than 20 supplied (right-truncates)', () => {
    const beats: Beat[] = [
      ...new Array(5).fill('up' as Beat),
      ...new Array(20).fill('down' as Beat),
    ];
    const tree = render(beats);
    const all = bars(tree);
    expect(all).toHaveLength(20);
    // All 20 visible bars must be 'down' (the most recent 20)
    for (const bar of all) {
      expect(String(bar.props.className)).toContain('bg-s-crit');
    }
  });
});

describe('HeartbeatStrip — beat → color class', () => {
  it('up → bg-s-ok', () => {
    const tree = render(['up']);
    const lastBar = bars(tree)[19];
    expect(String(lastBar.props.className)).toContain('bg-s-ok');
  });

  it('down → bg-s-crit', () => {
    const tree = render(['down']);
    const lastBar = bars(tree)[19];
    expect(String(lastBar.props.className)).toContain('bg-s-crit');
  });

  it('slow → bg-s-warn', () => {
    const tree = render(['slow']);
    const lastBar = bars(tree)[19];
    expect(String(lastBar.props.className)).toContain('bg-s-warn');
  });
});

describe('HeartbeatStrip — accessibility', () => {
  it('uses role="img" so screen readers treat the strip as a visualization', () => {
    const tree = render(['up', 'down']);
    expect(tree.props.role).toBe('img');
  });

  it('aria-label reports healthy count over the ORIGINAL beats length (not 20)', () => {
    // 3 ups + 1 down + 1 slow = 4 healthy of 5 supplied (padding excluded)
    const tree = render(['up', 'up', 'up', 'down', 'slow']);
    expect(tree.props['aria-label']).toBe('Health: 3 of 5 heartbeats healthy');
  });

  it('aria-label reports 0 of 0 for empty beats (no padding leakage)', () => {
    const tree = render([]);
    expect(tree.props['aria-label']).toBe('Health: 0 of 0 heartbeats healthy');
  });
});
