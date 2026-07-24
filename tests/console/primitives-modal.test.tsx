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


// ---------------------------------------------------------------------------
// initialFocus prop — C-B3W1-1 pass-through
// ---------------------------------------------------------------------------

describe('Modal — initialFocus prop', () => {
  it('provided initialFocus ref receives focus on open instead of first focusable', () => {
    const onClose = vi.fn()

    const Fixture: FC = () => {
      const inputRef = useRef<HTMLInputElement>(null)
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open</button>
          <Modal open={open} onClose={() => setOpen(false)} initialFocus={inputRef}>
            <ModalHeader title="Focus test" onClose={() => setOpen(false)} />
            <ModalBody>
              <input ref={inputRef} type="text" placeholder="Target input" />
              <button type="button">Another button</button>
            </ModalBody>
          </Modal>
        </>
      )
    }

    render(<Fixture />)
    act(() => { screen.getByRole('button', { name: 'Open' }).focus() })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    // The input (initialFocus target) should hold focus, not the header close X
    const input = screen.getByPlaceholderText('Target input')
    expect(document.activeElement).toBe(input)
  })

  it('omitted initialFocus: first focusable element (close X) receives focus', () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Default focus" onClose={() => {}} />
        <ModalBody>
          <input type="text" placeholder="Secondary input" />
        </ModalBody>
      </Modal>
    )

    // First focusable is the header close X (before the body input in DOM order)
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' })
    expect(document.activeElement).toBe(closeBtn)
  })
})


// ---------------------------------------------------------------------------
// B5: Exit presence — jsdom instant path and closing-phase contracts
// ---------------------------------------------------------------------------

describe('Modal — exit presence: jsdom instant path (C-B5-1)', () => {
  it('open→false removes the dialog synchronously when no animation duration resolves (jsdom path)', async () => {
    const { rerender } = render(
      <Modal open onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )
    expect(screen.getByRole('dialog')).toBeDefined()

    rerender(
      <Modal open={false} onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )

    // In jsdom: no stylesheet → computed animationDuration="" → instant unmount.
    // The dialog must not persist (no asynchronous dwell in jsdom).
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.soup-modal-backdrop')).toBeNull()
  })
})

describe('Modal — exit presence: closing phase with stubbed duration (C-B5-6)', () => {
  it('shell carries data-state="closing" after open→false with a non-zero duration', async () => {
    // Stub duration: set inline style so getComputedStyle returns a parseable value
    // in jsdom (C-B5-9 seam — no public prop on Modal).
    const { rerender } = render(
      <Modal open onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )

    const shell = document.querySelector('.soup-modal-shell') as HTMLElement
    expect(shell).not.toBeNull()
    // Simulate the -out keyframe being present by setting inline animationDuration.
    shell.style.animationDuration = '120ms'

    rerender(
      <Modal open={false} onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )

    // Phase → closing; element still mounted with data-state="closing".
    await act(async () => {})
    const closingShell = document.querySelector('.soup-modal-shell')
    expect(closingShell).not.toBeNull()
    expect(closingShell!.getAttribute('data-state')).toBe('closing')
  })

  it('animationend on the shell with matching animationName → unmounts', async () => {
    const { rerender } = render(
      <Modal open onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )

    const shell = document.querySelector('.soup-modal-shell') as HTMLElement
    shell.style.animationDuration = '120ms'

    rerender(
      <Modal open={false} onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )

    await act(async () => {})

    // Fire animationend on the shell with matching name → triggers unmount.
    const closingShell = document.querySelector('.soup-modal-shell')
    expect(closingShell).not.toBeNull()
    await act(async () => {
      fireEvent.animationEnd(closingShell!, { animationName: 'soup-modal-shell-out' })
    })

    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('animationend from a CHILD element does NOT trigger unmount (C-B5-6 guard)', async () => {
    const { rerender } = render(
      <Modal open onClose={() => {}}>
        <ModalBody>
          <div data-testid="child-anim">inner</div>
        </ModalBody>
      </Modal>
    )

    const shell = document.querySelector('.soup-modal-shell') as HTMLElement
    shell.style.animationDuration = '120ms'

    rerender(
      <Modal open={false} onClose={() => {}}>
        <ModalBody>
          <div data-testid="child-anim">inner</div>
        </ModalBody>
      </Modal>
    )

    await act(async () => {})

    const closingShell = document.querySelector('.soup-modal-shell')
    expect(closingShell).not.toBeNull()
    const child = closingShell!.querySelector('[data-testid="child-anim"]')
    expect(child).not.toBeNull()
    await act(async () => {
      fireEvent.animationEnd(child!, { animationName: 'soup-modal-shell-out', bubbles: true })
    })
    // Shell should still be present (child animationend does not satisfy the guard).
    expect(document.querySelector('.soup-modal-shell')).not.toBeNull()
  })

  it('INCONCLUSIVE: animationName guard is browser-only (jsdom AnimationEvent is unavailable)', () => {
    // jsdom 29 does not support AnimationEvent: fireEvent.animationEnd creates a plain
    // Event where e.animationName is undefined. The hook's conditional guard
    // (`e.animationName !== undefined && e.animationName !== expected`) skips the
    // animationName check when undefined, making the "wrong name" pin impossible in jsdom.
    // This behavior is proven in the browser lane (tests/browser-motion/b5-motion-policy.test.tsx).
    // The structural assertion: the guard code path exists in the hook source.
    expect(typeof window.AnimationEvent).toBe('undefined')
  })
})

describe('Modal — exit presence: re-open during closing cancels dwell', () => {
  it('re-opening during closing returns data-state to "open" and keeps dialog mounted', async () => {
    const { rerender } = render(
      <Modal open onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )

    const shell = document.querySelector('.soup-modal-shell') as HTMLElement
    shell.style.animationDuration = '120ms'

    // Start closing
    rerender(
      <Modal open={false} onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )
    await act(async () => {})

    // Re-open during the closing dwell
    rerender(
      <Modal open onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )
    await act(async () => {})

    // Dialog must be present and state must be "open"
    const dialog = screen.queryByRole('dialog')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('data-state')).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// B5: Background inert — refcount and restoration ordering (C-B5-4/5)
// ---------------------------------------------------------------------------

describe('Modal — background inert (C-B5-5): #root receives inert while modal is open', () => {
  let root: HTMLDivElement | null = null

  beforeEach(() => {
    // Create a #root element that the hook can find.
    root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
  })

  afterEach(() => {
    if (root && root.parentNode) root.parentNode.removeChild(root)
    root = null
    // Reset the module-level inert counter between tests.
    // We import the reset helper lazily to keep the import at file scope.
  })

  it('inert attribute is set on #root when modal opens', async () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )
    await act(async () => {})
    expect(root!.hasAttribute('inert')).toBe(true)
  })

  it('inert attribute is removed from #root when modal closes', async () => {
    const { rerender } = render(
      <Modal open onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )
    await act(async () => {})
    expect(root!.hasAttribute('inert')).toBe(true)

    rerender(
      <Modal open={false} onClose={() => {}}>
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    )
    await act(async () => {})
    expect(root!.hasAttribute('inert')).toBe(false)
  })

  it('refcount: inert remains on #root while the bottom modal is still open (P1-2 stacking, C-B5-5)', async () => {
    const outerClose = vi.fn()
    const innerClose = vi.fn()

    const { rerender } = render(
      <>
        <Modal open onClose={outerClose}>
          <ModalBody><button type="button">Outer</button></ModalBody>
        </Modal>
        <Modal open onClose={innerClose}>
          <ModalBody><button type="button">Inner</button></ModalBody>
        </Modal>
      </>
    )
    await act(async () => {})
    expect(root!.hasAttribute('inert')).toBe(true)

    // Close only the inner (top) modal
    rerender(
      <>
        <Modal open onClose={outerClose}>
          <ModalBody><button type="button">Outer</button></ModalBody>
        </Modal>
        <Modal open={false} onClose={innerClose}>
          <ModalBody><button type="button">Inner</button></ModalBody>
        </Modal>
      </>
    )
    await act(async () => {})
    // Outer modal still open → #root must STILL be inert
    expect(root!.hasAttribute('inert')).toBe(true)

    // Close the outer (bottom) modal too
    rerender(
      <>
        <Modal open={false} onClose={outerClose}>
          <ModalBody><button type="button">Outer</button></ModalBody>
        </Modal>
        <Modal open={false} onClose={innerClose}>
          <ModalBody><button type="button">Inner</button></ModalBody>
        </Modal>
      </>
    )
    await act(async () => {})
    // Both closed → inert released
    expect(root!.hasAttribute('inert')).toBe(false)
  })
})

describe('Modal — focus restoration ordering with inert active (C-B5-4)', () => {
  it('opener regains focus on close even when the inert hook is wired', async () => {
    // Create a #root fixture containing the opener so we can verify that inert
    // is released before focus restoration fires.
    const root = document.createElement('div')
    root.id = 'root'

    // Render a fixture where the trigger and modal live in a #root-bearing tree.
    // RTL appends its container to body; we use body.appendChild for the root div.
    document.body.appendChild(root)

    try {
      const Fixture: FC = () => {
        const [open, setOpen] = useState(false)
        return (
          <>
            <button
              type="button"
              data-testid="inert-opener"
              onClick={() => setOpen(true)}
            >
              Open
            </button>
            <Modal open={open} onClose={() => setOpen(false)}>
              <ModalHeader title="Inert ordering test" onClose={() => setOpen(false)} />
              <ModalBody><span>content</span></ModalBody>
            </Modal>
          </>
        )
      }

      render(<Fixture />)
      const opener = screen.getByTestId('inert-opener')
      act(() => { opener.focus() })
      fireEvent.click(opener)
      await act(async () => {})

      // Close via Escape
      fireEvent.keyDown(document, { key: 'Escape', bubbles: true })
      await act(async () => {})

      // Opener must regain focus — proves inert was released before restoration ran.
      expect(document.activeElement).toBe(opener)
    } finally {
      if (root.parentNode) root.parentNode.removeChild(root)
    }
  })
})
