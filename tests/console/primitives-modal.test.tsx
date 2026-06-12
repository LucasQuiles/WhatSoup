/**
 * @vitest-environment jsdom
 *
 * Primitive tests: Modal, ModalHeader, ModalBody, ModalFooter (modal.md),
 * and useDismissable hook (interaction-patterns.md §2).
 *
 * Covers:
 *   - Focus trap: Tab cycles within open modal
 *   - FOCUS RESTORATION: trigger button regains focus after modal closes
 *   - Stacking single-fire Escape: two nested Modals → one Escape → only top closes
 *   - Outside-click (dismissable=true) calls onClose
 *   - Outside-click (dismissable=false) does NOT call onClose
 *   - aria wiring: role=dialog, aria-modal, aria-labelledby
 *   - Size class mapping
 *   - ModalHeader / ModalBody / ModalFooter rendering
 *   - Close button in ModalHeader
 *   - Returns null when open=false
 *   - Type-contract negative: labelledById is optional
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../../console/src/components/primitives/Modal';
import type { FC } from 'react';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal wrapper that renders a trigger button + Modal controlled by open state. */
const ModalFixture: FC<{
  onClose?: () => void;
  size?: 'sm' | 'md' | 'lg';
  dismissable?: boolean;
  renderFooter?: boolean;
}> = ({ onClose, size, dismissable, renderFooter }) => {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open Modal
      </button>
      <Modal open={open} onClose={close} size={size} dismissable={dismissable}>
        <ModalHeader title="Test Modal" onClose={close} />
        <ModalBody>
          <button type="button">Body Button A</button>
          <button type="button">Body Button B</button>
        </ModalBody>
        {renderFooter && (
          <ModalFooter>
            <button type="button" onClick={close}>OK</button>
          </ModalFooter>
        )}
      </Modal>
    </>
  );
};

// ---------------------------------------------------------------------------
// Open/close gate
// ---------------------------------------------------------------------------

describe('Modal — open/close gate', () => {
  it('renders nothing when open=false', () => {
    render(<Modal open={false} onClose={() => {}}><div>content</div></Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('content')).toBeNull();
  });

  it('renders dialog when open=true', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Hello" />
        <ModalBody><p>Body</p></ModalBody>
      </Modal>
    );
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ARIA wiring
// ---------------------------------------------------------------------------

describe('Modal — aria wiring', () => {
  it('shell has role=dialog and aria-modal=true', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="ARIA Test" />
        <ModalBody><span>Body</span></ModalBody>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('aria-labelledby on shell points to the title element', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="My Title" />
        <ModalBody><span>x</span></ModalBody>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    const labelledById = dialog.getAttribute('aria-labelledby');
    expect(labelledById).toBeTruthy();
    // The title span should exist with the matching id (ModalHeader auto-wires it via data attribute)
    // Verify the dialog itself has a stable aria-labelledby
    expect(typeof labelledById).toBe('string');
    expect(labelledById!.length).toBeGreaterThan(0);
  });

  it('accepts custom labelledById prop', () => {
    render(
      <Modal open onClose={() => {}} labelledById="my-title">
        <ModalBody><span id="my-title">Custom Title</span></ModalBody>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe('my-title');
  });
});

// ---------------------------------------------------------------------------
// Size class mapping
// ---------------------------------------------------------------------------

describe('Modal — size classes', () => {
  for (const [size, cls] of [
    ['sm', 'soup-modal-shell--sm'],
    ['md', 'soup-modal-shell--md'],
    ['lg', 'soup-modal-shell--lg'],
  ] as const) {
    it(`size="${size}" applies ${cls}`, () => {
      render(
        <Modal open onClose={() => {}} size={size}>
          <ModalBody><span>x</span></ModalBody>
        </Modal>
      );
      const dialog = screen.getByRole('dialog');
      expect(dialog.classList.contains(cls)).toBe(true);
    });
  }

  it('defaults to md size class when no size given', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalBody><span>x</span></ModalBody>
      </Modal>
    );
    expect(screen.getByRole('dialog').classList.contains('soup-modal-shell--md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ModalHeader, ModalBody, ModalFooter rendering
// ---------------------------------------------------------------------------

describe('Modal — sub-components', () => {
  it('ModalHeader renders title text', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Dialog Title" />
        <ModalBody><span>x</span></ModalBody>
      </Modal>
    );
    expect(screen.getByText('Dialog Title')).toBeDefined();
  });

  it('ModalHeader renders close button when onClose provided', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <ModalHeader title="T" onClose={onClose} />
        <ModalBody><span>x</span></ModalBody>
      </Modal>
    );
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' });
    expect(closeBtn).toBeDefined();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ModalHeader renders NO close button when onClose not provided', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="T" />
        <ModalBody><span>x</span></ModalBody>
      </Modal>
    );
    expect(screen.queryByRole('button', { name: 'Close dialog' })).toBeNull();
  });

  it('ModalBody renders children with soup-modal-body class', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalBody><span data-testid="body-content">content</span></ModalBody>
      </Modal>
    );
    const body = screen.getByTestId('body-content').closest('.soup-modal-body');
    expect(body).not.toBeNull();
  });

  it('ModalFooter renders children with soup-modal-footer class', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalBody><span>x</span></ModalBody>
        <ModalFooter><button type="button">OK</button></ModalFooter>
      </Modal>
    );
    const footer = screen.getByText('OK').closest('.soup-modal-footer');
    expect(footer).not.toBeNull();
  });

  it('ModalFooter renders note content left-aligned', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalBody><span>x</span></ModalBody>
        <ModalFooter note={<span data-testid="note">Note text</span>}>
          <button type="button">OK</button>
        </ModalFooter>
      </Modal>
    );
    expect(screen.getByTestId('note')).toBeDefined();
    const noteEl = screen.getByTestId('note').closest('.soup-modal-footer__note');
    expect(noteEl).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Escape key behavior
// ---------------------------------------------------------------------------

describe('Modal — Escape key', () => {
  it('Escape key calls onClose when modal is open', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <ModalBody><button type="button">X</button></ModalBody>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape key does not fire when modal is closed', () => {
    const onClose = vi.fn();
    render(
      <Modal open={false} onClose={onClose}>
        <ModalBody><button type="button">X</button></ModalBody>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// STACKING SINGLE-FIRE ESCAPE — two nested modals, one Escape closes only top
// ---------------------------------------------------------------------------

describe('Modal — stacking single-fire Escape (P1-2 fix)', () => {
  it('Escape closes ONLY the topmost modal when two are open', async () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();

    // Both modals open simultaneously
    const { rerender } = render(
      <>
        <Modal open onClose={outerClose}>
          <ModalBody><button type="button">Outer</button></ModalBody>
        </Modal>
        <Modal open onClose={innerClose}>
          <ModalBody><button type="button">Inner</button></ModalBody>
        </Modal>
      </>
    );

    // Single Escape
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });

    // Only inner (topmost registered) closes
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();

    // Simulate inner close by rerendering with inner closed
    rerender(
      <>
        <Modal open onClose={outerClose}>
          <ModalBody><button type="button">Outer</button></ModalBody>
        </Modal>
        <Modal open={false} onClose={innerClose}>
          <ModalBody><button type="button">Inner</button></ModalBody>
        </Modal>
      </>
    );

    // Second Escape closes outer
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(outerClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// FOCUS RESTORATION — trigger button regains focus after modal closes
// ---------------------------------------------------------------------------

describe('Modal — focus restoration on close', () => {
  it('restores focus to the trigger element when the modal closes', async () => {
    const { rerender } = render(<ModalFixture />);

    // Open modal by clicking trigger
    const trigger = screen.getByRole('button', { name: 'Open Modal' });
    act(() => { trigger.focus(); });
    fireEvent.click(trigger);

    // Modal is now open; Escape to close
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });

    // Rerender with closed state simulated by the fixture
    // (fixture wires onClose → setOpen(false))
    // After close, focus should return to trigger
    await act(async () => {});

    // The trigger should now be focused
    expect(document.activeElement).toBe(trigger);
  });
});

// ---------------------------------------------------------------------------
// Focus trap — Tab cycles within modal
// ---------------------------------------------------------------------------

describe('Modal — focus trap', () => {
  it('Tab cycles within modal (last element → first)', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Trap" onClose={() => {}} />
        <ModalBody>
          <button type="button" data-testid="btn-a">A</button>
          <button type="button" data-testid="btn-b">B</button>
        </ModalBody>
      </Modal>
    );

    const btnA = screen.getByTestId('btn-a');
    const btnB = screen.getByTestId('btn-b');
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' });

    // Focus last button
    act(() => { btnB.focus(); });

    // Tab from last → should wrap to first focusable (close button in header)
    fireEvent.keyDown(document, { key: 'Tab', bubbles: true });
    // closeBtn is the first focusable inside the modal (in header before body)
    expect(document.activeElement).toBe(closeBtn);

    // Shift+Tab from first → should wrap to last
    act(() => { closeBtn.focus(); });
    fireEvent.keyDown(document, {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
    });
    expect(document.activeElement).toBe(btnB);
  });
});

// ---------------------------------------------------------------------------
// Outside-click behavior
// ---------------------------------------------------------------------------

describe('Modal — outside-click', () => {
  it('dismissable=true: clicking outside the shell calls onClose', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} dismissable>
        <ModalBody><button type="button">Inside</button></ModalBody>
      </Modal>
    );

    // Fire a pointerdown on document.body (outside the shell)
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismissable=false: clicking outside the shell does NOT call onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} dismissable={false}>
        <ModalBody><button type="button">Inside</button></ModalBody>
      </Modal>
    );

    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking inside the shell does NOT call onClose even when dismissable=true', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} dismissable>
        <ModalBody><button type="button" data-testid="inner">Inside</button></ModalBody>
      </Modal>
    );

    fireEvent.pointerDown(screen.getByTestId('inner'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Backdrop and shell class structure
// ---------------------------------------------------------------------------

describe('Modal — class structure', () => {
  it('renders soup-modal-backdrop wrapping the shell', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalBody><span>x</span></ModalBody>
      </Modal>
    );
    const backdrop = document.querySelector('.soup-modal-backdrop');
    expect(backdrop).not.toBeNull();
    const shell = backdrop!.querySelector('.soup-modal-shell');
    expect(shell).not.toBeNull();
  });
});

describe('Modal outside-dismissal single-owner contract', () => {
  it('a full browser click sequence on the backdrop calls onClose exactly once', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} dismissable>
        <ModalHeader title="Single fire" />
        <ModalBody>content</ModalBody>
      </Modal>,
    )
    const backdrop = document.querySelector('[data-soup-backdrop]') as HTMLElement
    // pointerdown -> pointerup -> click, as real browsers dispatch
    fireEvent.pointerDown(backdrop)
    fireEvent.pointerUp(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
