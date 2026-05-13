/**
 * Behavioral coverage for console/src/components/HeartbeatStrip.tsx.
 *
 * User-visible contract:
 *   - exposes a labeled role="img" visualization
 *   - aria-label reports healthy count over the original beats array
 *
 * Design-token contract:
 *   - always renders 20 visual bars
 *   - short input is left-padded with "up"; long input keeps the latest 20
 *   - beat states map to the expected color token classes
 */
/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import HeartbeatStrip from '../../console/src/components/HeartbeatStrip.tsx';

type Beat = 'up' | 'down' | 'slow';

afterEach(() => cleanup());

function renderStrip(beats: Beat[]): HTMLDivElement {
  render(<HeartbeatStrip beats={beats} />);
  return screen.getByRole('img') as HTMLDivElement;
}

function bars(strip: HTMLDivElement): HTMLDivElement[] {
  return Array.from(strip.querySelectorAll(':scope > div'));
}

describe('HeartbeatStrip — bar count design-token contract', () => {
  it('pads with "up" bars on the left when fewer than 20 beats are supplied', () => {
    const all = bars(renderStrip(['down']));

    expect(all).toHaveLength(20);
    expect(all[0].className).toContain('bg-s-ok');
    expect(all[19].className).toContain('bg-s-crit');
  });

  it('renders exactly 20 bars for an empty beats array', () => {
    expect(bars(renderStrip([]))).toHaveLength(20);
  });

  it('renders exactly 20 bars for a 20-beat array without padding or truncation', () => {
    const beats: Beat[] = new Array(20).fill('slow');
    const all = bars(renderStrip(beats));

    expect(all).toHaveLength(20);
    for (const bar of all) {
      expect(bar.className).toContain('bg-s-warn');
    }
  });

  it('keeps the last 20 beats when more than 20 are supplied', () => {
    const beats: Beat[] = [
      ...new Array<Beat>(5).fill('up'),
      ...new Array<Beat>(20).fill('down'),
    ];
    const all = bars(renderStrip(beats));

    expect(all).toHaveLength(20);
    for (const bar of all) {
      expect(bar.className).toContain('bg-s-crit');
    }
  });
});

describe('HeartbeatStrip — beat color design-token contract', () => {
  it('maps up beats to bg-s-ok', () => {
    const lastBar = bars(renderStrip(['up']))[19];
    expect(lastBar.className).toContain('bg-s-ok');
  });

  it('maps down beats to bg-s-crit', () => {
    const lastBar = bars(renderStrip(['down']))[19];
    expect(lastBar.className).toContain('bg-s-crit');
  });

  it('maps slow beats to bg-s-warn', () => {
    const lastBar = bars(renderStrip(['slow']))[19];
    expect(lastBar.className).toContain('bg-s-warn');
  });
});

describe('HeartbeatStrip — accessibility behavior', () => {
  it('uses role="img" so screen readers treat the strip as a visualization', () => {
    expect(renderStrip(['up', 'down']).getAttribute('role')).toBe('img');
  });

  it('reports healthy count over the original beats length rather than the 20 rendered bars', () => {
    render(<HeartbeatStrip beats={['up', 'up', 'up', 'down', 'slow']} />);

    expect(screen.getByRole('img', { name: 'Health: 3 of 5 heartbeats healthy' })).toBeDefined();
  });

  it('reports 0 of 0 for empty beats with no padding leakage', () => {
    render(<HeartbeatStrip beats={[]} />);

    expect(screen.getByRole('img', { name: 'Health: 0 of 0 heartbeats healthy' })).toBeDefined();
  });
});
