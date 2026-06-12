/**
 * @vitest-environment jsdom
 *
 * Primitive tests: Button and ActionButton (button.md).
 *
 * Covers:
 *   - Closed variant set (primary/neutral/ghost/danger/success/warning)
 *   - 3 sizes (md/sm/xs) — height contract via CSS class
 *   - aria-label requirement for icon-only (asserted by missing-label case)
 *   - aria-busy loading state
 *   - disabled state
 *   - Deterministic target-size floor: xs >= 24px, ActionButton hit area >= 28px
 *     (asserted on rendered style/class contract per DD-10)
 *   - ActionButton reveal-label mechanic (label is accessible name)
 *   - ActionButton danger flavor
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Plus } from 'lucide-react';
import { Button, ActionButton } from '../../console/src/components/primitives/index.ts';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Button — variant × size class contract
// ---------------------------------------------------------------------------

describe('Button variants', () => {
  const variants = ['primary', 'neutral', 'ghost', 'danger', 'success', 'warning'] as const;

  for (const variant of variants) {
    it(`variant="${variant}" renders soup-btn--${variant} class`, () => {
      render(<Button variant={variant}>{variant} action</Button>);
      const btn = screen.getByRole('button');
      expect(btn.classList.contains('soup-btn')).toBe(true);
      expect(btn.classList.contains(`soup-btn--${variant}`)).toBe(true);
    });
  }

  it('defaults to neutral variant when no variant specified', () => {
    render(<Button>Default</Button>);
    expect(screen.getByRole('button').classList.contains('soup-btn--neutral')).toBe(true);
  });
});

describe('Button sizes', () => {
  it('md size renders without size modifier class (default)', () => {
    render(<Button size="md">Medium</Button>);
    const btn = screen.getByRole('button');
    expect(btn.classList.contains('soup-btn')).toBe(true);
    // md is the base class, no extra size modifier
    expect(btn.classList.contains('soup-btn--sm')).toBe(false);
    expect(btn.classList.contains('soup-btn--xs')).toBe(false);
  });

  it('sm size renders soup-btn--sm class', () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole('button').classList.contains('soup-btn--sm')).toBe(true);
  });

  it('xs size renders soup-btn--xs class', () => {
    render(<Button size="xs">XS</Button>);
    const btn = screen.getByRole('button');
    expect(btn.classList.contains('soup-btn--xs')).toBe(true);
  });

  // DD-10: deterministic target-size floor via CSS class contract.
  // xs must carry soup-btn--xs (which maps to --btn-h-xs = 24px via primitives.css).
  // We assert the class contract since jsdom does not compute CSS custom property heights.
  // Computed-box/trusted-event proof lives in the browser lane:
  // tests/browser/target-size.test.tsx Button size cases.
  it('xs button carries the xs class that maps to 24px floor (DD-10 class contract)', () => {
    render(<Button size="xs">Floor</Button>);
    const btn = screen.getByRole('button');
    // The spec-mandated class — primitives.css binds it to --btn-h-xs (24px)
    expect(btn.classList.contains('soup-btn--xs')).toBe(true);
  });
});

describe('Button loading state', () => {
  it('sets aria-busy="true" when loading', () => {
    render(<Button loading>Saving</Button>);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-busy')).toBe('true');
  });

  it('is disabled when loading', () => {
    render(<Button loading>Saving</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows spinner element when loading', () => {
    render(<Button loading>Saving</Button>);
    // Loader2 renders an SVG; confirm it's present
    const svg = screen.getByRole('button').querySelector('svg');
    expect(svg).not.toBeNull();
  });

  it('keeps label text visible when loading (no width jump)', () => {
    render(<Button loading>Saving</Button>);
    expect(screen.getByText('Saving')).toBeTruthy();
  });
});

describe('Button disabled state', () => {
  it('is disabled when disabled prop set', () => {
    render(<Button disabled>Cannot</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sets aria-disabled="true" when disabled', () => {
    render(<Button disabled>Cannot</Button>);
    expect(screen.getByRole('button').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Button accessibility', () => {
  it('renders native <button> element', () => {
    render(<Button>Act</Button>);
    expect(screen.getByRole('button').tagName).toBe('BUTTON');
  });

  it('defaults type="button" to prevent accidental form submission', () => {
    render(<Button>Act</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('passes through aria-label for icon-only usage', () => {
    render(
      <Button aria-label="Add item" icon={<Plus size={14} />} />
    );
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Add item');
  });
});

// ---------------------------------------------------------------------------
// ActionButton — reveal-label mechanic
// ---------------------------------------------------------------------------

describe('ActionButton', () => {
  it('renders label as aria-label (accessible name)', () => {
    render(<ActionButton label="Restart line" />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toBe('Restart line');
  });

  it('renders label text in reveal span (visible on hover/focus)', () => {
    render(<ActionButton label="Delete line" />);
    const labelEl = document.querySelector('.soup-actbtn__label');
    expect(labelEl).not.toBeNull();
    expect(labelEl!.textContent).toBe('Delete line');
  });

  it('carries soup-actbtn class', () => {
    render(<ActionButton label="Send" />);
    expect(screen.getByRole('button').classList.contains('soup-actbtn')).toBe(true);
  });

  it('danger flavor adds soup-actbtn--danger class', () => {
    render(<ActionButton label="Delete" danger />);
    expect(screen.getByRole('button').classList.contains('soup-actbtn--danger')).toBe(true);
  });

  // DD-10: ActionButton minimum hit area = 28×28px via soup-actbtn class (primitives.css).
  it('carries soup-actbtn class that provides 28px minimum hit area (DD-10 class contract)', () => {
    render(<ActionButton label="Hit area test" />);
    const btn = screen.getByRole('button');
    // soup-actbtn class binds min-height: 28px + min-width: 28px in primitives.css
    expect(btn.classList.contains('soup-actbtn')).toBe(true);
  });

  it('renders with type="button" by default', () => {
    render(<ActionButton label="Go" />);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('renders icon when provided', () => {
    render(<ActionButton label="Refresh" icon={<Plus size={18} />} />);
    const svg = screen.getByRole('button').querySelector('svg');
    expect(svg).not.toBeNull();
  });
});

describe('Button icon-only accessibility contract (type-level)', () => {
  it('icon-only without aria-label is rejected by the type system', () => {
    // The discriminated-union props make this a COMPILE-TIME error; if the type
    // guard ever weakens, tsc (run in build and typecheck) fails on this fixture.
    // @ts-expect-error -- type-contract fixture: icon-only Button without aria-label must not typecheck; permanent negative fixture, renew on contract change; expires 2027-12-31
    render(<Button icon={<svg data-testid="i" />} />)
    // Runtime still renders a button (the contract is a typing contract, not a crash).
    expect(screen.getByRole('button')).toBeTruthy()
  })

  it('icon-only with aria-label exposes the accessible name', () => {
    render(<Button icon={<svg data-testid="i" />} aria-label="Refresh" />)
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  })
})
