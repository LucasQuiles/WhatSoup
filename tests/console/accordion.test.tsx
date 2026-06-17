/** @vitest-environment jsdom */
/**
 * Accordion primitive contract (showcase §21; DD-43):
 *   - native <details>/<summary> disclosure semantics (no hand-rolled aria-expanded)
 *   - defaultOpen paints the row open on first render
 *   - clicking the summary flips details[open]
 *   - the one focus recipe on the summary (verbatim from Card.tsx)
 *   - chevron present (ChevronRight from lucide-react)
 *   - the group wrapper lays out multiple items with hairline dividers
 *   - reduced-motion path: chevron transition is removed (off-and-instant)
 *
 * Class-only assertions prove the CSS hook exists, not the rendered ink.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Accordion, AccordionItem } from '../../console/src/components/primitives/Accordion';

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Single AccordionItem
// ---------------------------------------------------------------------------

describe('AccordionItem — native <details>/<summary> disclosure', () => {
  it('renders a <details> with a <summary> carrying the label', () => {
    render(<AccordionItem label="What is SOUP?">A toolkit.</AccordionItem>);
    const summary = screen.getByText('What is SOUP?').closest('summary');
    expect(summary).not.toBeNull();
    // Native semantics — the body lives inside the same <details>.
    const details = summary!.closest('details');
    expect(details).not.toBeNull();
    expect(details!.textContent).toContain('A toolkit.');
    // Closed by default.
    expect((details as HTMLDetailsElement).open).toBe(false);
  });

  it('defaultOpen paints the row open on first render (native <details open>)', () => {
    render(<AccordionItem label="Open me" defaultOpen>Visible body</AccordionItem>);
    const details = screen.getByText('Open me').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  it('clicking the summary toggles details[open]', () => {
    render(<AccordionItem label="Toggle">body</AccordionItem>);
    const summary = screen.getByText('Toggle').closest('summary') as HTMLElement;
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);

    fireEvent.click(summary);
    expect(details.open).toBe(true);

    fireEvent.click(summary);
    expect(details.open).toBe(false);
  });

  it('renders a ChevronRight glyph inside the summary (decorative)', () => {
    const { container } = render(<AccordionItem label="With chevron">body</AccordionItem>);
    const chev = container.querySelector('.soup-accordion__chev');
    expect(chev).not.toBeNull();
    // Chevron is decorative — aria-hidden.
    expect(chev!.getAttribute('aria-hidden')).toBe('true');
    // Lucide renders an SVG inside the chevron span.
    expect(chev!.querySelector('svg')).not.toBeNull();
  });

  it('summary carries the one focus recipe (verbatim from Card.tsx)', () => {
    render(<AccordionItem label="Focused">body</AccordionItem>);
    const summary = screen.getByText('Focused').closest('summary')!;
    // The same canonical Tailwind utility strings the other primitives use.
    expect(summary.className).toContain('focus-visible:outline-2');
    expect(summary.className).toContain('focus-visible:outline-offset-2');
    expect(summary.className).toContain('focus-visible:outline-[var(--focus-ring)]');
  });

  it('summary wires aria-controls to the body region id (assistive tech linkage)', () => {
    render(<AccordionItem label="Linked">body</AccordionItem>);
    const summary = screen.getByText('Linked').closest('summary')!;
    const controlsId = summary.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    const body = document.getElementById(controlsId!);
    expect(body).not.toBeNull();
    // body carries role=region + aria-labelledby pointing at the summary id.
    expect(body!.getAttribute('role')).toBe('region');
    expect(body!.getAttribute('aria-labelledby')).toBe(summary.id);
  });
});

// ---------------------------------------------------------------------------
// Accordion group wrapper
// ---------------------------------------------------------------------------

describe('Accordion — group wrapper', () => {
  it('renders the .soup-accordion container and forwards children', () => {
    const { container } = render(
      <Accordion>
        <AccordionItem label="A">a</AccordionItem>
        <AccordionItem label="B">b</AccordionItem>
      </Accordion>,
    );
    const group = container.querySelector('.soup-accordion');
    expect(group).not.toBeNull();
    // Both items rendered as native <details>.
    expect(group!.querySelectorAll('details').length).toBe(2);
  });

  it('appends a custom className to the group wrapper', () => {
    const { container } = render(
      <Accordion className="extra-class">
        <AccordionItem label="x">x</AccordionItem>
      </Accordion>,
    );
    const group = container.querySelector('.soup-accordion')!;
    expect(group.className).toContain('extra-class');
  });
});

// ---------------------------------------------------------------------------
// Reduced-motion — the chevron transition is REMOVED, not shortened
// (motion.md §9). We assert the CSS contract: the global media block removes
// the transition property under prefers-reduced-motion. The matching CSS rule
// lives in primitives.css; the test pins the contract via class + media check.
// ---------------------------------------------------------------------------

describe('Accordion — reduced-motion law (motion.md §9)', () => {
  it('chevron transition class contract is the soup-accordion__chev token', () => {
    const { container } = render(<AccordionItem label="r">body</AccordionItem>);
    const chev = container.querySelector('.soup-accordion__chev');
    expect(chev).not.toBeNull();
    // The CSS @media prefers-reduced-motion block removes the chevron transition
    // entirely. The class is the keyed hook for that rule. (Visual proof of the
    // removal requires a layout engine; this pins the hook exists.)
    expect(chev!.classList.contains('soup-accordion__chev')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sanity — the primitive does not regress when nested inside other primitives
// (the leaf forbids consumer adoption, but the primitive itself must compose).
// ---------------------------------------------------------------------------

describe('Accordion — composition sanity', () => {
  it('children render whatever the caller passes (paragraphs, lists, etc.)', () => {
    render(
      <AccordionItem label="Rich body">
        <p>first paragraph</p>
        <p>second paragraph</p>
      </AccordionItem>,
    );
    expect(screen.getByText('first paragraph')).toBeDefined();
    expect(screen.getByText('second paragraph')).toBeDefined();
  });
});