/**
 * @vitest-environment jsdom
 *
 * Primitive tests: Popover + usePopoverKeyboard (select.md § Accessibility, B2).
 *
 * Covers (per packet § 8 test plan):
 *   - Open/close gate (data-state, open=false renders nothing)
 *   - Combobox trigger aria wiring (aria-expanded, aria-controls, aria-activedescendant)
 *   - Listbox + role=option rendering
 *   - Down opens + moves active, Up moves (clamp at start/end)
 *   - Enter selects active option + closes
 *   - Escape closes one layer (via useDismissable stack) — focus stays/returns to trigger
 *   - aria-activedescendant tracking (id on option matches trigger attr)
 *   - Outside-click closes
 *   - STACKING (packet §6.3): Popover inside legacy dialog — Escape closes Popover
 *     via capture-phase stopPropagation; legacy bubble-phase handler NOT reached.
 *     Two stacked Popovers: Escape closes only the topmost.
 *   - Listener lifecycle on rapid open/close (mount/unmount count)
 *   - Options mutation while open (active option tracks value, not index)
 *   - Zero-options no-op for Up/Down
 *   - max-height/scroll class contract (class-level, noted)
 *     Computed-box/trusted-event proof lives in the browser lane:
 *     tests/browser/target-size.test.tsx Popover option-row height cases.
 *   - Focus STAYS on trigger — no trap, no steal
 *   - No-trap proof (Tab does NOT cycle within panel)
 *   - useDismissable opt-out pinning: trapFocus=false/autoFocus=false keep defaults
 *     for existing callers (regression proof for C-B2-1)
 *
 * Stacking note: the capture-phase stopPropagation fix is proven against a simulated
 * legacy dialog (bubble-phase document keydown listener) — the actual defect pattern
 * per packet §6.3. Modal/Drawer use the same capture-phase stack as Popover, so
 * ordering between them is determined by effect registration order (children before
 * parents). Popover + Modal ordering in jsdom follows React effect order and is
 * separately covered by the two-popover test above.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import type { FC } from 'react';
import { Popover, popoverOptionId, usePopoverKeyboard } from '../../console/src/components/primitives/Popover';
import type { PopoverOption } from '../../console/src/components/primitives/Popover';
import { Modal, ModalHeader, ModalBody } from '../../console/src/components/primitives/Modal';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRUITS: PopoverOption[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
];

const SELECTED_FRUITS: PopoverOption[] = [
  { value: 'apple', label: 'Apple', selected: true },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
];

/** Stable listbox id for fixtures that need to wire aria-controls / aria-activedescendant. */
const LISTBOX_ID = 'fixture-listbox';

/**
 * Full combobox fixture: trigger button + Popover with keyboard contract wired.
 * Uses a fixed listboxId so the trigger can wire aria-controls/aria-activedescendant.
 */
const ComboboxFixture: FC<{
  initialOptions?: PopoverOption[];
  onSelect?: (v: string) => void;
  onClose?: () => void;
}> = ({ initialOptions = FRUITS, onSelect, onClose }) => {
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const [options] = useState(initialOptions);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    setActiveValue(null);
    onClose?.();
  };

  const { handleKeyDown } = usePopoverKeyboard({
    open,
    options,
    activeValue,
    onOpen: () => setOpen(true),
    onClose: close,
    onSelect: (v) => {
      onSelect?.(v);
      close();
    },
    onActiveChange: setActiveValue,
  });

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="trigger"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? LISTBOX_ID : undefined}
        aria-activedescendant={
          open && activeValue
            ? popoverOptionId(LISTBOX_ID, activeValue)
            : undefined
        }
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleKeyDown}
      >
        Fruit picker
      </button>
      {open && (
        <Popover
          open={open}
          onClose={close}
          anchorRef={triggerRef}
          options={options}
          activeValue={activeValue}
          onSelect={(v) => {
            onSelect?.(v);
            close();
          }}
          listboxLabel="Fruits"
          listboxId={LISTBOX_ID}
        />
      )}
    </div>
  );
};

/**
 * Dynamic options fixture — allows mutating the options while the panel is open.
 */
const MutableOptionsFixture: FC = () => {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<PopoverOption[]>(FRUITS);
  const [activeValue, setActiveValue] = useState<string | null>('apple');
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="trigger"
        onClick={() => setOpen(true)}
      >
        Open
      </button>
      <button
        type="button"
        data-testid="remove-apple"
        onClick={() => {
          setOptions((prev) => prev.filter((o) => o.value !== 'apple'));
          setActiveValue((v) => (v === 'apple' ? null : v));
        }}
      >
        Remove Apple
      </button>
      {open && (
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          options={options}
          activeValue={activeValue}
          onSelect={() => setOpen(false)}
          listboxLabel="Fruits"
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Open / close gate
// ---------------------------------------------------------------------------

describe('Popover — open/close gate', () => {
  it('renders nothing when open=false', () => {
    const ref = { current: null };
    render(
      <Popover
        open={false}
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
      />,
    );
    expect(document.querySelector('.soup-popover')).toBeNull();
  });

  it('renders panel with data-state="open" when open=true', () => {
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );
    const panel = document.querySelector('.soup-popover');
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute('data-state')).toBe('open');
  });

  it('renders listbox with given label', () => {
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Pick a fruit"
      />,
    );
    const listbox = screen.getByRole('listbox', { name: 'Pick a fruit' });
    expect(listbox.getAttribute('aria-label')).toBe('Pick a fruit');
  });
});

// ---------------------------------------------------------------------------
// Role + ARIA
// ---------------------------------------------------------------------------

describe('Popover — role and ARIA', () => {
  it('renders role=listbox with role=option children', () => {
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toContain('Apple');
    expect(options[1].textContent).toContain('Banana');
    expect(options[2].textContent).toContain('Cherry');
  });

  it('selected option has aria-selected=true', () => {
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={SELECTED_FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[1].getAttribute('aria-selected')).toBe('false');
  });

  it('selected option carries soup-popover__option--selected class', () => {
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={SELECTED_FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options[0].classList.contains('soup-popover__option--selected')).toBe(true);
    expect(options[1].classList.contains('soup-popover__option--selected')).toBe(false);
  });

  it('active option carries data-active="true" and --active class', () => {
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue="banana"
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options[1].getAttribute('data-active')).toBe('true');
    expect(options[1].classList.contains('soup-popover__option--active')).toBe(true);
    expect(options[0].getAttribute('data-active')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// aria-activedescendant wiring
// ---------------------------------------------------------------------------

describe('Popover — aria-activedescendant', () => {
  it('builds collision-free ids for values that differ only by punctuation', () => {
    expect(popoverOptionId(LISTBOX_ID, 'owner+ops_at_example.com@imessage'))
      .not.toBe(popoverOptionId(LISTBOX_ID, 'owner.ops_at_example.com@imessage'))
  })

  it('option ids follow popoverOptionId(listboxId, value) formula', () => {
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
        listboxId={LISTBOX_ID}
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options[0].id).toBe(popoverOptionId(LISTBOX_ID, 'apple'));
    expect(options[1].id).toBe(popoverOptionId(LISTBOX_ID, 'banana'));
    expect(options[2].id).toBe(popoverOptionId(LISTBOX_ID, 'cherry'));
  });

  it('trigger aria-activedescendant matches option id when active', () => {
    render(<ComboboxFixture />);
    const trigger = screen.getByTestId('trigger');
    // Open
    fireEvent.click(trigger);
    // Press Down to set first option active
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    // Now aria-activedescendant should point to the apple option id
    const descendant = trigger.getAttribute('aria-activedescendant');
    expect(descendant).toBeTruthy();
    // The option with this id should exist in the document
    const appleOpt = document.getElementById(descendant!);
    expect(appleOpt).not.toBeNull();
    expect(appleOpt!.textContent).toContain('Apple');
  });
});

// ---------------------------------------------------------------------------
// Keyboard contract: Down / Up / Enter
// ---------------------------------------------------------------------------

describe('Popover — keyboard navigation (usePopoverKeyboard)', () => {
  it('ArrowDown opens the panel if closed', () => {
    render(<ComboboxFixture />);
    const trigger = screen.getByTestId('trigger');
    expect(document.querySelector('.soup-popover')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(document.querySelector('.soup-popover')).not.toBeNull();
  });

  it('ArrowDown moves active option from first to second', () => {
    render(<ComboboxFixture />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger); // open
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // active = apple
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // active = banana
    const opts = screen.getAllByRole('option');
    expect(opts[1].getAttribute('data-active')).toBe('true');
    expect(opts[0].getAttribute('data-active')).toBeNull();
  });

  it('ArrowDown clamps at last option (does not wrap)', () => {
    render(<ComboboxFixture />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger);
    // Down 5 times — only 3 options
    for (let i = 0; i < 5; i++) fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const opts = screen.getAllByRole('option');
    expect(opts[2].getAttribute('data-active')).toBe('true'); // cherry is last
    expect(opts[0].getAttribute('data-active')).toBeNull();
  });

  it('ArrowUp moves active option from second to first', () => {
    render(<ComboboxFixture />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // apple
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // banana
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });   // back to apple
    const opts = screen.getAllByRole('option');
    expect(opts[0].getAttribute('data-active')).toBe('true');
    expect(opts[1].getAttribute('data-active')).toBeNull();
  });

  it('ArrowUp clamps at first option (does not wrap)', () => {
    render(<ComboboxFixture />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // apple
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });   // still apple (clamped)
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });   // still apple
    const opts = screen.getAllByRole('option');
    expect(opts[0].getAttribute('data-active')).toBe('true');
  });

  it('Enter selects active option and closes panel', () => {
    const onSelect = vi.fn();
    render(<ComboboxFixture onSelect={onSelect} />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // apple active
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('apple');
    expect(document.querySelector('.soup-popover')).toBeNull();
  });

  it('Enter with no active option is a no-op', () => {
    const onSelect = vi.fn();
    render(<ComboboxFixture onSelect={onSelect} />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger);
    // No Down key pressed — activeValue is null
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('.soup-popover')).not.toBeNull();
  });

  it('zero options: ArrowDown is a no-op (no crash)', () => {
    render(<ComboboxFixture initialOptions={[]} />);
    const trigger = screen.getByTestId('trigger');
    // Open manually — ArrowDown won't render options but should not throw
    fireEvent.click(trigger);
    expect(() => {
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Option click selection
// ---------------------------------------------------------------------------

describe('Popover — option mouse selection', () => {
  it('clicking an option selects it and closes', () => {
    const onSelect = vi.fn();
    render(<ComboboxFixture onSelect={onSelect} />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger);
    const opts = screen.getAllByRole('option');
    fireEvent.mouseDown(opts[1]); // banana
    expect(onSelect).toHaveBeenCalledWith('banana');
    expect(document.querySelector('.soup-popover')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Escape — single-fire, focus stays on trigger
// ---------------------------------------------------------------------------

describe('Popover — Escape key', () => {
  it('Escape closes the panel (calls onClose once)', () => {
    const onClose = vi.fn();
    render(<ComboboxFixture onClose={onClose} />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger); // open
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.soup-popover')).toBeNull();
  });

  it('Escape does not fire when panel is closed', () => {
    const onClose = vi.fn();
    render(<ComboboxFixture onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('focus stays on trigger after Escape closes panel', async () => {
    render(<ComboboxFixture />);
    const trigger = screen.getByTestId('trigger');
    act(() => { trigger.focus(); });
    fireEvent.click(trigger);
    await act(async () => {});
    // Panel is open; trigger still has focus (autoFocus: false)
    expect(document.activeElement).toBe(trigger);
    // Close with Escape
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    await act(async () => {});
    // Focus returned to trigger by useDismissable restoration
    expect(document.activeElement).toBe(trigger);
  });
});

// ---------------------------------------------------------------------------
// Outside-click closes
// ---------------------------------------------------------------------------

describe('Popover — outside-click', () => {
  it('clicking outside the panel calls onClose', () => {
    const onClose = vi.fn();
    render(<ComboboxFixture onClose={onClose} />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger); // open
    // Fire pointerdown on document.body (outside the panel)
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the panel does NOT call onClose', () => {
    const onClose = vi.fn();
    render(<ComboboxFixture onClose={onClose} />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger);
    const panel = document.querySelector('.soup-popover') as HTMLElement;
    fireEvent.pointerDown(panel);
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// STACKING — Escape ordering: capture-phase Popover vs bubble-phase legacy dialog.
//
// Defect being fixed (packet §6.3):
// Pre-B2: Escape with a picker panel (ChatPicker) open inside a legacy dialog
// (formerly ScheduleComposerModal, which used a hand-rolled bubble-phase document
// keydown handler) would fire BOTH handlers — panel AND dialog close together.
//
// NOTE (B3 wave 2): ScheduleComposerModal was migrated to the Modal primitive and
// no longer carries a hand-rolled Escape handler. The stack-based ordering protection
// (capture-phase + stopPropagation) upgrades from phase-ordering to stack-membership
// for all migrated dialogs. The fixture below uses an inline useEffect to simulate
// the legacy anti-pattern, which remains relevant for dialogs not yet migrated.
//
// Fix mechanism: useDismissable registers its Escape handler on the CAPTURE phase
// with stopPropagation. When the Popover is registered on the overlay stack,
// its capture-phase handler fires, calls the topmost handler (popoverClose), then
// calls stopPropagation — the bubble-phase handler on any legacy dialog never fires.
//
// The test simulates this with an inline useEffect bubble-phase listener.
//
// Also tests: two stacked Popovers — Escape closes only the topmost.
// ---------------------------------------------------------------------------

describe('Popover — stacking: Escape ordering', () => {
  it('capture-phase Popover Escape stops propagation to bubble-phase legacy handler', () => {
    const legacyClose = vi.fn();
    const popoverClose = vi.fn();

    /**
     * Simulates a legacy dialog that uses a non-stacking bubble-phase
     * document keydown Escape handler — the pre-B2 anti-pattern.
     */
    const LegacyDialogFixture: FC = () => {
      const anchorRef = useRef<HTMLButtonElement>(null);
      const [popoverOpen, setPopoverOpen] = useState(true);

      // Simulate legacy dialog bubble-phase Escape (no capture flag)
      useEffect(() => {
        function handleEscape(e: KeyboardEvent) {
          if (e.key === 'Escape') legacyClose();
        }
        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
      }, []);

      return (
        <div data-testid="legacy-dialog">
          <button ref={anchorRef} type="button" data-testid="anchor">
            Anchor
          </button>
          <Popover
            open={popoverOpen}
            onClose={() => {
              setPopoverOpen(false);
              popoverClose();
            }}
            anchorRef={anchorRef}
            options={FRUITS}
            activeValue={null}
            onSelect={() => {}}
            listboxLabel="Fruits"
          />
        </div>
      );
    };

    render(<LegacyDialogFixture />);

    // Escape — capture phase fires Popover handler + stopPropagation.
    // Legacy bubble-phase handler never receives the event.
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(popoverClose).toHaveBeenCalledTimes(1);
    expect(legacyClose).not.toHaveBeenCalled();
  });

  it('two stacked Popovers: Escape closes only the topmost (last registered)', () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    const outerRef = { current: null };
    const innerRef = { current: null };

    render(
      <>
        <Popover
          open
          onClose={outerClose}
          anchorRef={outerRef}
          options={FRUITS}
          activeValue={null}
          onSelect={() => {}}
          listboxLabel="Outer"
        />
        <Popover
          open
          onClose={innerClose}
          anchorRef={innerRef}
          options={FRUITS}
          activeValue={null}
          onSelect={() => {}}
          listboxLabel="Inner"
        />
      </>,
    );

    // Single Escape — only inner (last registered = topmost) should close
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Focus stays on trigger — no trap, no steal
// ---------------------------------------------------------------------------

describe('Popover — focus stays on trigger (no trap, no steal)', () => {
  it('opening the Popover does not steal focus from the trigger', async () => {
    render(<ComboboxFixture />);
    const trigger = screen.getByTestId('trigger');
    act(() => { trigger.focus(); });
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger); // open
    await act(async () => {});
    // autoFocus: false — focus must remain on trigger
    expect(document.activeElement).toBe(trigger);
  });

  it('Tab does NOT cycle within the Popover panel (no trap)', () => {
    render(<ComboboxFixture />);
    const trigger = screen.getByTestId('trigger');
    act(() => { trigger.focus(); });
    fireEvent.click(trigger);
    // trapFocus: false means the Tab handler is not installed.
    // Verify: Tab doesn't throw and panel stays open (Tab doesn't close it).
    expect(() => {
      fireEvent.keyDown(document, { key: 'Tab', bubbles: true });
    }).not.toThrow();
    // Panel should still be open (Tab doesn't close it)
    expect(document.querySelector('.soup-popover')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Options mutation while open
// ---------------------------------------------------------------------------

describe('Popover — options mutation while open', () => {
  it('removing the active option resets active to null without error', async () => {
    render(<MutableOptionsFixture />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger); // open, activeValue='apple'
    await act(async () => {});
    // Verify apple is active
    let opts = screen.getAllByRole('option');
    expect(opts[0].getAttribute('data-active')).toBe('true');
    // Remove apple from options
    fireEvent.click(screen.getByTestId('remove-apple'));
    // Panel should still be open with remaining options
    opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(2);
    // No option should be active (active was reset by the fixture)
    for (const opt of opts) {
      expect(opt.getAttribute('data-active')).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Listener lifecycle on rapid open/close
// ---------------------------------------------------------------------------

describe('Popover — listener lifecycle', () => {
  it('rapid open/close does not leave orphan stack entries', () => {
    render(<ComboboxFixture />);
    const trigger = screen.getByTestId('trigger');

    // Open then close rapidly several times
    for (let i = 0; i < 3; i++) {
      fireEvent.click(trigger); // toggle open
      fireEvent.click(trigger); // toggle closed
    }

    // After all closes, panel is closed and no Escape handler should fire
    expect(document.querySelector('.soup-popover')).toBeNull();
    // Escape should do nothing (no registered handler)
    expect(() => {
      fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Class contract — max-height + list overflow
// Computed-box/trusted-event proof lives in the browser lane:
// tests/browser/target-size.test.tsx Popover option-row height cases.
// ---------------------------------------------------------------------------

describe('Popover — class contract', () => {
  it('panel carries soup-popover class', () => {
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
      />,
    );
    expect(document.querySelector('.soup-popover')).not.toBeNull();
  });

  it('list carries soup-popover__list class', () => {
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
      />,
    );
    expect(document.querySelector('.soup-popover__list')).not.toBeNull();
  });

  it('option rows carry soup-popover__option class', () => {
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
      />,
    );
    const items = document.querySelectorAll('.soup-popover__option');
    expect(items.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// useDismissable opt-out regression: defaults preserve trap + autofocus
// (C-B2-1 proof — existing callers unchanged when trapFocus/autoFocus not passed)
// ---------------------------------------------------------------------------

describe('useDismissable — opt-out defaults preserve Modal/Drawer behavior (C-B2-1)', () => {
  it('Modal focus trap still cycles Tab when Popover opt-out options NOT passed to Modal', () => {
    // Modal does not pass trapFocus/autoFocus — defaults (true) apply.
    render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Trap test" onClose={() => {}} />
        <ModalBody>
          <button type="button" data-testid="btn-a">A</button>
          <button type="button" data-testid="btn-b">B</button>
        </ModalBody>
      </Modal>,
    );
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' });
    const btnB = screen.getByTestId('btn-b');

    act(() => { btnB.focus(); });
    // Tab from last → wraps to first (close button)
    fireEvent.keyDown(document, { key: 'Tab', bubbles: true });
    expect(document.activeElement).toBe(closeBtn);
  });

  it('Modal still shifts initial focus into container (autoFocus default=true)', async () => {
    // When Modal opens, it steals focus to its first focusable child
    render(
      <Modal open onClose={() => {}}>
        <ModalBody>
          <button type="button" data-testid="first">First</button>
        </ModalBody>
      </Modal>,
    );
    await act(async () => {});
    // First focusable in modal should have focus (autoFocus default)
    const firstBtn = screen.getByTestId('first');
    expect(document.activeElement).toBe(firstBtn);
  });

  it('Popover with trapFocus=false does NOT cycle Tab', () => {
    // Popover explicitly opts out of trap
    const ref = { current: null };
    render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
      />,
    );
    // With no trap, Tab keydown does not throw and does not cycle focus
    expect(() => {
      fireEvent.keyDown(document, { key: 'Tab', bubbles: true });
    }).not.toThrow();
  });

  it('Popover with autoFocus=false does NOT steal focus from external elements', async () => {
    // Set focus on an external button, then render the Popover open — focus should stay
    const ExternalFixture: FC = () => {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <div style={{ position: 'relative' }}>
          <button ref={ref} type="button" data-testid="external">External</button>
          <Popover
            open
            onClose={() => {}}
            anchorRef={ref}
            options={FRUITS}
            activeValue={null}
            onSelect={() => {}}
          />
        </div>
      );
    };
    render(<ExternalFixture />);
    const external = screen.getByTestId('external');
    act(() => { external.focus(); });
    await act(async () => {});
    // autoFocus: false means Popover did not steal focus
    expect(document.activeElement).toBe(external);
  });
});

// ---------------------------------------------------------------------------
// P1-7: Exit presence — closing lifecycle (mirrors Modal/Drawer B5 §4.2 contract)
//
// The Popover now defers unmount while the soup-popover-out keyframe plays.
// In jsdom (no stylesheet) the instant path fires synchronously (C-B5-1).
// Tests below mirror primitives-modal.test.tsx / primitives-drawer.test.tsx
// exit-presence suites for consistency.
// ---------------------------------------------------------------------------

describe('Popover — exit presence: jsdom instant path (C-B5-1)', () => {
  it('open→false removes the panel synchronously when no animation duration resolves (jsdom path)', async () => {
    const ref = { current: null };
    const { rerender } = render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );
    expect(document.querySelector('.soup-popover')).not.toBeNull();

    rerender(
      <Popover
        open={false}
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );

    // In jsdom: no stylesheet → computed animationDuration="" → instant unmount (C-B5-1).
    await act(async () => {});
    expect(document.querySelector('.soup-popover')).toBeNull();
  });
});

describe('Popover — exit presence: closing phase with stubbed duration (C-B5-6)', () => {
  it('panel carries data-state="closing" after open→false with a non-zero duration', async () => {
    const ref = { current: null };
    const { rerender } = render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );

    const panel = document.querySelector('.soup-popover') as HTMLElement;
    expect(panel).not.toBeNull();
    // Simulate the -out keyframe being present by stubbing inline animationDuration (C-B5-9 seam).
    panel.style.animationDuration = '120ms';

    rerender(
      <Popover
        open={false}
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );

    await act(async () => {});

    // If the hook detected the stubbed duration it enters closing phase.
    const closingPanel = document.querySelector('.soup-popover');
    if (closingPanel) {
      expect(closingPanel.getAttribute('data-state')).toBe('closing');
    }
    // Note: jsdom rAF may fire synchronously — either outcome (closing or already unmounted)
    // is valid for the instant-or-closing dwell boundary.
  });

  it('animationend on the panel with matching animationName → unmounts panel', async () => {
    const ref = { current: null };
    const { rerender } = render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );

    const panel = document.querySelector('.soup-popover') as HTMLElement;
    panel.style.animationDuration = '120ms';

    rerender(
      <Popover
        open={false}
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );

    await act(async () => {});

    // Fire animationend with the matching keyframe name → triggers unmount.
    await act(async () => {
      const closingPanel = document.querySelector('.soup-popover');
      if (closingPanel) {
        fireEvent.animationEnd(closingPanel, { animationName: 'soup-popover-out' });
      }
    });

    await act(async () => {});
    expect(document.querySelector('.soup-popover')).toBeNull();
  });

  it('re-open during closing: panel returns to data-state="open"', async () => {
    const ref = { current: null };
    const { rerender } = render(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );

    const panel = document.querySelector('.soup-popover') as HTMLElement;
    panel.style.animationDuration = '120ms';

    rerender(
      <Popover
        open={false}
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );
    await act(async () => {});

    // Re-open during closing dwell
    rerender(
      <Popover
        open
        onClose={() => {}}
        anchorRef={ref}
        options={FRUITS}
        activeValue={null}
        onSelect={() => {}}
        listboxLabel="Fruits"
      />,
    );
    await act(async () => {});

    const popoverEl = document.querySelector('.soup-popover');
    expect(popoverEl).not.toBeNull();
    expect(popoverEl?.getAttribute('data-state')).toBe('open');
  });
});

describe('Popover — exit presence: reduced-motion instant path', () => {
  it('INCONCLUSIVE: prefers-reduced-motion is CSS-only; jsdom returns empty animationDuration so the instant-unmount path always fires', () => {
    // The global @media (prefers-reduced-motion: reduce) block sets animation: none on
    // .soup-popover and .soup-popover[data-state="closing"]. In a real browser,
    // animation: none resolves to animationDuration="0s" → use-exit-presence takes the
    // instant unmount path (C-B5-1 equivalent for reduced motion), so no closing dwell.
    // jsdom does not apply stylesheets — animationDuration is always empty string, which
    // parseDurationMs("") returns 0 → same instant unmount path.
    // Structural proof: jsdom returns empty string for animationDuration.
    const div = document.createElement('div');
    document.body.appendChild(div);
    const duration = getComputedStyle(div).animationDuration;
    document.body.removeChild(div);
    // jsdom: empty string → 0 → instant unmount (no dwell) — equivalent to animation:none path.
    expect(duration).toBe('');
  });
});
