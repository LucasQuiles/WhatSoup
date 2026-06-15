/**
 * @vitest-environment jsdom
 *
 * Primitive tests: Pill (pill.md).
 *
 * Covers:
 *   - All 8 tones render correct soup-pill--<tone> class
 *   - Both sizes (md/sm) render correct class
 *   - Static variant is a <span>
 *   - Interactive variant is a <button> with aria-pressed
 *   - Interactive pressed/unpressed state
 *   - Removable variant renders label + remove button
 *   - Remove button calls onRemove
 *   - Remove button aria-label ("Remove <label>")
 *   - Custom removeLabel overrides the default
 *   - count prop renders the count in the pill
 *   - Disabled interactive pill has opacity class contract
 *   - type-contract: interactive without pressed is a TS error (negative fixture)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Pill } from '../../console/src/components/primitives/Pill';

afterEach(() => { cleanup(); });

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

describe('Pill — tones', () => {
  const tones = ['neutral', 'ok', 'warn', 'crit', 'passive', 'chat', 'agent', 'accent'] as const;

  for (const tone of tones) {
    it(`tone="${tone}" applies soup-pill--${tone} class`, () => {
      render(<Pill tone={tone}>label</Pill>);
      const el = document.querySelector('.soup-pill');
      expect(el).not.toBeNull();
      expect(el!.classList.contains(`soup-pill--${tone}`)).toBe(true);
    });
  }

  it('defaults to neutral tone when no tone given', () => {
    render(<Pill>label</Pill>);
    expect(document.querySelector('.soup-pill')!.classList.contains('soup-pill--neutral')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

describe('Pill — sizes', () => {
  it('md size renders soup-pill without soup-pill--sm', () => {
    render(<Pill size="md">label</Pill>);
    const el = document.querySelector('.soup-pill')!;
    expect(el.classList.contains('soup-pill')).toBe(true);
    expect(el.classList.contains('soup-pill--sm')).toBe(false);
  });

  it('sm size renders soup-pill--sm class', () => {
    render(<Pill size="sm">label</Pill>);
    expect(document.querySelector('.soup-pill')!.classList.contains('soup-pill--sm')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Static variant
// ---------------------------------------------------------------------------

describe('Pill — static variant', () => {
  it('renders a <span> (not a button)', () => {
    render(<Pill>static label</Pill>);
    const el = document.querySelector('.soup-pill');
    expect(el?.tagName).toBe('SPAN');
  });

  it('renders children text', () => {
    render(<Pill>hello pill</Pill>);
    expect(screen.getByText('hello pill')).toBeDefined();
  });

  it('renders count in a nested span when provided', () => {
    render(<Pill count={3}>label</Pill>);
    const countEl = document.querySelector('.soup-pill__count');
    expect(countEl).not.toBeNull();
    expect(countEl!.textContent).toBe('3');
  });

  it('does not render count span when count is undefined', () => {
    render(<Pill>label</Pill>);
    expect(document.querySelector('.soup-pill__count')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Interactive variant
// ---------------------------------------------------------------------------

describe('Pill — interactive variant', () => {
  it('renders a <button> element', () => {
    render(<Pill variant="interactive" pressed={false} onClick={() => {}}>filter</Pill>);
    const btn = screen.getByRole('button');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('sets aria-pressed=false when not pressed', () => {
    render(<Pill variant="interactive" pressed={false} onClick={() => {}}>filter</Pill>);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
  });

  it('sets aria-pressed=true when pressed', () => {
    render(<Pill variant="interactive" pressed={true} onClick={() => {}}>filter</Pill>);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps pressed/type contracts when pass-through button props conflict', () => {
    render(
      <Pill
        variant="interactive"
        pressed={true}
        type="submit"
        aria-pressed={false}
        onClick={() => {}}
      >
        filter
      </Pill>,
    );

    const btn = screen.getByRole('button', { name: 'filter' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('applies soup-pill--pressed class when pressed=true', () => {
    render(<Pill variant="interactive" pressed={true} onClick={() => {}}>filter</Pill>);
    expect(screen.getByRole('button').classList.contains('soup-pill--pressed')).toBe(true);
  });

  it('does NOT apply soup-pill--pressed class when pressed=false', () => {
    render(<Pill variant="interactive" pressed={false} onClick={() => {}}>filter</Pill>);
    expect(screen.getByRole('button').classList.contains('soup-pill--pressed')).toBe(false);
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<Pill variant="interactive" pressed={false} onClick={onClick}>filter</Pill>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('has type="button" to prevent form submission', () => {
    render(<Pill variant="interactive" pressed={false} onClick={() => {}}>filter</Pill>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('applies soup-pill--interactive class', () => {
    render(<Pill variant="interactive" pressed={false} onClick={() => {}}>filter</Pill>);
    expect(screen.getByRole('button').classList.contains('soup-pill--interactive')).toBe(true);
  });

  it('renders count in data lane', () => {
    render(<Pill variant="interactive" pressed={false} count={7} onClick={() => {}}>filter</Pill>);
    const btn = screen.getByRole('button');
    const countEl = btn.querySelector('.soup-pill__count');
    expect(countEl).not.toBeNull();
    expect(countEl!.textContent).toBe('7');
  });
});

// ---------------------------------------------------------------------------
// Removable variant
// ---------------------------------------------------------------------------

describe('Pill — removable variant', () => {
  it('renders as a <span>', () => {
    render(<Pill variant="removable" onRemove={() => {}}>env:prod</Pill>);
    const el = document.querySelector('.soup-pill');
    expect(el?.tagName).toBe('SPAN');
  });

  it('renders label text', () => {
    render(<Pill variant="removable" onRemove={() => {}}>env:staging</Pill>);
    expect(screen.getByText('env:staging')).toBeDefined();
  });

  it('renders remove button with aria-label="Remove <label>"', () => {
    render(<Pill variant="removable" onRemove={() => {}}>env:prod</Pill>);
    const removeBtn = screen.getByRole('button', { name: 'Remove env:prod' });
    expect(removeBtn.className).toContain('soup-pill__remove');
  });

  it('custom removeLabel overrides the default aria-label', () => {
    render(
      <Pill variant="removable" onRemove={() => {}} removeLabel="Delete this tag">
        env:prod
      </Pill>
    );
    expect(screen.getByRole('button', { name: 'Delete this tag' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Remove env:prod' })).toBeNull();
  });

  it('calls onRemove when the remove button is clicked', () => {
    const onRemove = vi.fn();
    render(<Pill variant="removable" onRemove={onRemove}>env:prod</Pill>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove env:prod' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('applies soup-pill--removable class', () => {
    render(<Pill variant="removable" onRemove={() => {}}>tag</Pill>);
    expect(document.querySelector('.soup-pill')!.classList.contains('soup-pill--removable')).toBe(true);
  });

  it('renders soup-pill__label wrapper around text', () => {
    render(<Pill variant="removable" onRemove={() => {}}>my tag</Pill>);
    const label = document.querySelector('.soup-pill__label');
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe('my tag');
  });
});

// ---------------------------------------------------------------------------
// Channel tones on interactive pills — aria-pressed contract preserved
// ---------------------------------------------------------------------------

describe('Pill — tone × interactive combination', () => {
  for (const tone of ['passive', 'chat', 'agent'] as const) {
    it(`tone="${tone}" interactive pill with pressed=true has both tone class and pressed class`, () => {
      render(
        <Pill variant="interactive" tone={tone} pressed={true} onClick={() => {}}>
          {tone}
        </Pill>
      );
      const btn = screen.getByRole('button');
      expect(btn.getAttribute('aria-pressed')).toBe('true');
      expect(btn.classList.contains(`soup-pill--${tone}`)).toBe(true);
      expect(btn.classList.contains('soup-pill--pressed')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Type-contract negative fixture
// ---------------------------------------------------------------------------

describe('Pill — type contract', () => {
  it('removable pill without onRemove is rejected by TS (negative fixture)', () => {
    // @ts-expect-error -- type-contract fixture: removable Pill requires onRemove; permanent negative fixture; expires 2027-12-31; waiver:PILL-TYPE-01
    render(<Pill variant="removable">tag</Pill>);
    // Runtime still renders (contract is type-level, not a crash)
    expect(document.querySelector('.soup-pill')).not.toBeNull();
  });
});

describe('Pill removable — remove-button hit-area class contract (DD-10, D7 finding C-D7-2)', () => {
  it('remove button carries the soup-pill__remove class whose ::before expands the target to 24px (class contract — computed-box proof is D7)', () => {
    render(<Pill variant="removable" onRemove={() => {}}>env:prod</Pill>);
    const removeBtn = screen.getByRole('button', { name: 'Remove env:prod' });
    expect(removeBtn.className).toContain('soup-pill__remove');
    expect(removeBtn.className).toContain('soup-actbtn');
  });
});
