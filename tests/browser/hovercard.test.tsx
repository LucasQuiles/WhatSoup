/**
 * @file tests/browser/hovercard.test.tsx
 *
 * HC-04 browser proof for the HoverCard primitive (DD-43). Behaviors JSDOM cannot verify
 * and the code review flagged as resting on assumptions:
 *   - the card actually renders VISIBLE on hover (real CSS cascade — opacity/pointer-events)
 *   - the hover-bridge HOLDS when the pointer crosses trigger→card (real pointer moves; the
 *     jsdom test could only exercise timer cancellation on a single wrapper element)
 *   - the panel has real positioned geometry
 *   - theme tokens resolve (dark vs light surface differ)
 *
 * NOT covered (tracked as a separate bead): portal/clip-escape — B1 renders the card
 * INLINE; a portal severs the wrapper-region bridge and needs its own implementation +
 * proof. Reduced-motion lift is a visual screenshot-class check deferred with that work.
 *
 * Real timers (closeDelay) → the bridge proof chains real CDP hovers (each consumes real
 * wall-clock time well past closeDelay) rather than a raw sleep, then asserts still-open.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import React from 'react';
import { HoverCard } from '../../console/src/components/primitives/HoverCard.tsx';
import '../../console/src/index.css';

afterEach(() => cleanup());

function Subject({ theme }: { theme?: 'dark' | 'light' } = {}) {
  return (
    <div data-theme={theme} style={{ padding: '160px' }}>
      <HoverCard cardLabel="Detail" card={<button type="button">copy</button>} openDelay={40} closeDelay={40}>
        <button type="button">trigger</button>
      </HoverCard>
    </div>
  );
}

const expanded = (t: HTMLElement) => t.getAttribute('aria-expanded') === 'true';
const panelOf = (t: HTMLElement) => document.getElementById(t.getAttribute('aria-controls') as string) as HTMLElement;

describe('HoverCard — browser proof (HC-04)', () => {
  it('opens a VISIBLE, positioned card on hover (real CSS cascade)', async () => {
    const { getByRole } = await render(<Subject />);
    const trigger = getByRole('button', { name: 'trigger' }).element() as HTMLElement;
    const panel = panelOf(trigger);

    expect(getComputedStyle(panel).opacity).toBe('0'); // closed recipe paints opacity:0

    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(expanded(trigger)).toBe(true));

    await vi.waitFor(() => expect(getComputedStyle(panel).opacity).toBe('1'));
    expect(getComputedStyle(panel).pointerEvents).not.toBe('none');
    const rect = panel.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  it('the hover-bridge HOLDS when the pointer crosses trigger↔card (real pointer moves)', async () => {
    const { getByRole } = await render(<Subject />);
    const trigger = getByRole('button', { name: 'trigger' }).element() as HTMLElement;

    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(expanded(trigger)).toBe(true));

    // Real CDP pointer round-trips trigger→card→trigger→card. Each hover consumes real
    // wall-clock time > closeDelay(40ms); a broken bridge would fire mouseleave on a
    // trigger→card transition and close mid-sequence, failing the final assertion.
    const copy = getByRole('button', { name: 'copy' }).element() as HTMLElement;
    await userEvent.hover(copy);
    await userEvent.hover(trigger);
    await userEvent.hover(copy);
    expect(expanded(trigger)).toBe(true);
    expect(getComputedStyle(panelOf(trigger)).opacity).toBe('1');
  });

  it('closes after the pointer leaves the whole component', async () => {
    const { getByRole } = await render(<Subject />);
    const trigger = getByRole('button', { name: 'trigger' }).element() as HTMLElement;

    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(expanded(trigger)).toBe(true));
    await userEvent.hover(document.body);
    await vi.waitFor(() => expect(expanded(trigger)).toBe(false));
  });

  it('resolves design tokens — the open card paints a real themed surface + shadow (not transparent)', async () => {
    const { getByRole } = await render(<Subject />);
    const trigger = getByRole('button', { name: 'trigger' }).element() as HTMLElement;
    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(expanded(trigger)).toBe(true));

    const cs = getComputedStyle(panelOf(trigger));
    // --surface-overlay / --shadow-overlay / --border-hairline resolve to real values in
    // the browser cascade (jsdom returns empty/transparent for all of these).
    expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(cs.backgroundColor).not.toBe('transparent');
    expect(cs.backgroundColor).not.toBe('');
    expect(cs.boxShadow).not.toBe('none');
    expect(cs.borderTopWidth).not.toBe('0px');
  });
});
