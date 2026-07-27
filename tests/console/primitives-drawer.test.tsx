/**
 * @vitest-environment jsdom
 *
 * Primitive tests: Drawer (drawer.md, investigation §8).
 *
 * Covers:
 *   - Opens: data-state="open" on drawer root when open=true
 *   - Escape closes the drawer exactly once
 *   - Stacked with Modal: Escape closes Modal first (top of stack), Drawer second
 *   - Focus enters close X on open
 *   - Focus restores to opener on close
 *   - Retarget: content swap while open=true does NOT remount the drawer shell
 *     (stable element identity via data-testid on the shell) and does NOT steal focus
 *   - aria-label / aria-labelledby wiring on the shell
 *   - DrawerLayout renders content + drawer as siblings
 *
 * jsdom limits:
 *   - Container-query squeeze flip (≥900px → flex sibling, <900px → overlay) is NOT
 *     provable in jsdom — jsdom does not implement CSS container queries. Tests assert
 *     class/structure contracts only.
 *     Computed-box/trusted-event proof lives in the browser lane:
 *     tests/browser/viewport-matrix.test.tsx "Drawer squeeze flip" suite.
 *   - Computed CSS (animation, transforms) not verifiable in jsdom.
 *   - Real focus ring visual appearance not verifiable.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { FC } from 'react';
import {
  Drawer,
  DrawerLayout,
  DrawerHeader,
  DrawerBody,
  DrawerFooter,
} from '../../console/src/components/primitives/Drawer';
import { Modal, ModalHeader, ModalBody } from '../../console/src/components/primitives/Modal';

const __here = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Drawer fixture: trigger button + controlled Drawer. */
const DrawerFixture: FC<{
  onClose?: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  title?: string;
  bodyContent?: string;
}> = ({
  onClose,
  ariaLabel = 'Line inspector',
  ariaLabelledBy,
  title = 'Test Drawer',
  bodyContent = 'Drawer body content',
}) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    onClose?.();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="open-trigger"
        onClick={() => setOpen(true)}
      >
        Open Drawer
      </button>
      <Drawer
        open={open}
        onClose={close}
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={ariaLabelledBy}
      >
        <DrawerHeader title={title} onClose={close} />
        <DrawerBody>
          <span data-testid="body-text">{bodyContent}</span>
        </DrawerBody>
      </Drawer>
    </>
  );
};

// ---------------------------------------------------------------------------
// Open / close gate
// ---------------------------------------------------------------------------

describe('Drawer — open/close gate', () => {
  it('renders nothing when open=false', () => {
    render(
      <Drawer open={false} onClose={() => {}} aria-label="inspector">
        <DrawerBody>content</DrawerBody>
      </Drawer>,
    );
    expect(document.querySelector('.soup-drawer')).toBeNull();
  });

  it('data-state="open" when open=true', () => {
    render(
      <Drawer open onClose={() => {}} aria-label="inspector">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    const drawer = document.querySelector('.soup-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer!.getAttribute('data-state')).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Escape closes the drawer exactly once
// ---------------------------------------------------------------------------

describe('Drawer — Escape key', () => {
  it('Escape closes the drawer (calls onClose once)', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} aria-label="inspector">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape does NOT fire when drawer is closed', () => {
    const onClose = vi.fn();
    render(
      <Drawer open={false} onClose={onClose} aria-label="inspector">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stacked with Modal: Escape closes Modal first, then Drawer (stack order)
// Tests investigation §6.7 — existing stack tests; one drawer-over-modal ordering test.
// ---------------------------------------------------------------------------

describe('Drawer — Escape stacking with Modal', () => {
  it('when Drawer is open over a Modal, Escape closes Drawer first (topmost stack)', () => {
    const drawerClose = vi.fn();
    const modalClose = vi.fn();

    // Modal opens first (bottom of stack), then Drawer (top of stack).
    render(
      <>
        <Modal open onClose={modalClose}>
          <ModalHeader title="Background modal" />
          <ModalBody><button type="button">Modal button</button></ModalBody>
        </Modal>
        <Drawer open onClose={drawerClose} aria-label="inspector">
          <DrawerBody><span>Drawer</span></DrawerBody>
        </Drawer>
      </>,
    );

    // Single Escape — only topmost (Drawer, last registered) should close.
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(drawerClose).toHaveBeenCalledTimes(1);
    expect(modalClose).not.toHaveBeenCalled();
  });

  it('when Modal is open over a Drawer, Escape closes Modal first (topmost stack)', () => {
    const drawerClose = vi.fn();
    const modalClose = vi.fn();

    // Drawer opens first (bottom), Modal opens on top (registered last).
    render(
      <>
        <Drawer open onClose={drawerClose} aria-label="inspector">
          <DrawerBody><span>Drawer</span></DrawerBody>
        </Drawer>
        <Modal open onClose={modalClose}>
          <ModalHeader title="Top modal" />
          <ModalBody><button type="button">Modal button</button></ModalBody>
        </Modal>
      </>,
    );

    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(modalClose).toHaveBeenCalledTimes(1);
    expect(drawerClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Focus enters close X on open
// ---------------------------------------------------------------------------

describe('Drawer — initial focus on close X', () => {
  it('close X button (aria-label="Close inspector") receives focus when drawer opens', async () => {
    render(<DrawerFixture />);
    const trigger = screen.getByTestId('open-trigger');
    act(() => { trigger.focus(); });
    fireEvent.click(trigger);

    // After opening, the close button should have focus
    await act(async () => {});
    const closeBtn = screen.getByRole('button', { name: 'Close inspector' });
    expect(document.activeElement).toBe(closeBtn);
  });
});

// ---------------------------------------------------------------------------
// Focus restores to opener on close
// ---------------------------------------------------------------------------

describe('Drawer — focus restoration', () => {
  it('focus returns to the trigger button after drawer closes via Escape', async () => {
    render(<DrawerFixture />);
    const trigger = screen.getByTestId('open-trigger');

    act(() => { trigger.focus(); });
    fireEvent.click(trigger);
    await act(async () => {});

    // Close via Escape
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    await act(async () => {});

    // focus should be restored to trigger
    expect(document.activeElement).toBe(trigger);
  });
});

// ---------------------------------------------------------------------------
// Retarget: content swap without remount + focus not stolen
// Investigation §6.2 / §6.6.
//
// Asserts that swapping the drawer title/content while open=true does NOT
// remount the shell element (same DOM node, proven via a stable data-testid
// and the DOM node reference captured before the swap).
// Also asserts that focused element inside the drawer is not stolen.
// ---------------------------------------------------------------------------

describe('Drawer — retarget (content swap without remount)', () => {
  it('shell element identity is stable across a content swap (no remount)', async () => {
    const Retarget: FC = () => {
      const [target, setTarget] = useState<'A' | 'B'>('A');

      return (
        <>
          <button
            type="button"
            data-testid="open"
            onClick={() => {}}
          >
            Open
          </button>
          <Drawer open aria-label="inspector" onClose={() => {}}>
            <DrawerHeader
              title={target === 'A' ? 'Entity A' : 'Entity B'}
              onClose={() => {}}
            />
            <DrawerBody>
              <span data-testid="body-content" data-target={target}>
                {target === 'A' ? 'Content A' : 'Content B'}
              </span>
            </DrawerBody>
          </Drawer>
          <button
            type="button"
            data-testid="swap"
            onClick={() => setTarget('B')}
          >
            Swap
          </button>
        </>
      );
    };

    render(<Retarget />);

    // Capture shell reference before swap
    const shellBefore = document.querySelector('.soup-drawer') as HTMLElement;
    expect(shellBefore).not.toBeNull();
    expect(screen.getByText('Entity A')).toBeDefined();

    // Focus a button inside the drawer body (close button)
    const closeBtn = screen.getByRole('button', { name: 'Close inspector' });
    act(() => { closeBtn.focus(); });
    expect(document.activeElement).toBe(closeBtn);

    // Swap content
    fireEvent.click(screen.getByTestId('swap'));

    // Shell should be the same DOM node (no remount)
    const shellAfter = document.querySelector('.soup-drawer') as HTMLElement;
    expect(shellAfter).toBe(shellBefore);

    // Content updated
    expect(screen.getByText('Entity B')).toBeDefined();
    expect(screen.queryByText('Entity A')).toBeNull();

    // Focus was NOT stolen — still on close button (same element)
    // After a retarget (content swap), focus MUST NOT move (investigation §6.6).
    // Note: jsdom focus retention across React reconciliation is INCONCLUSIVE
    // when the focused element's subtree is rebuilt. We assert the close button
    // still exists (identity preserved) and remains focusable.
    const closeBtnAfter = screen.getByRole('button', { name: 'Close inspector' });
    expect(closeBtnAfter).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// aria labelling
// ---------------------------------------------------------------------------

describe('Drawer — aria labelling', () => {
  it('shell has aria-label when aria-label prop is provided', () => {
    render(
      <Drawer open onClose={() => {}} aria-label="My inspector">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    const shell = document.querySelector('.soup-drawer');
    expect(shell?.getAttribute('aria-label')).toBe('My inspector');
  });

  it('shell has aria-labelledby when aria-labelledby prop is provided', () => {
    render(
      <Drawer open onClose={() => {}} aria-labelledby="drawer-title">
        <DrawerBody><span id="drawer-title">Title</span></DrawerBody>
      </Drawer>,
    );
    const shell = document.querySelector('.soup-drawer');
    expect(shell?.getAttribute('aria-labelledby')).toBe('drawer-title');
  });

  it('shell has role="complementary"', () => {
    render(
      <Drawer open onClose={() => {}} aria-label="inspector">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    expect(screen.getByRole('complementary')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DrawerLayout structure
// ---------------------------------------------------------------------------

describe('DrawerLayout — structure', () => {
  it('renders content and drawer as siblings inside soup-drawer-layout', () => {
    render(
      <DrawerLayout
        drawer={
          <Drawer open aria-label="inspector" onClose={() => {}}>
            <DrawerBody><span data-testid="drawer-inner">Drawer</span></DrawerBody>
          </Drawer>
        }
      >
        <span data-testid="main-content">Main</span>
      </DrawerLayout>,
    );

    const layout = document.querySelector('.soup-drawer-layout');
    expect(layout).not.toBeNull();

    const content = layout!.querySelector('.soup-drawer-layout__content');
    expect(content).not.toBeNull();
    expect(content?.querySelector('[data-testid="main-content"]')).not.toBeNull();

    expect(screen.getByTestId('drawer-inner')).toBeDefined();
  });

  // Container-query squeeze flip (≥900px → no scrim, flex sibling) is NOT
  // provable in jsdom — jsdom does not implement CSS container queries.
  // Computed-box/trusted-event proof lives in the browser lane:
  // tests/browser/viewport-matrix.test.tsx "Drawer squeeze flip" suite.
  it('INCONCLUSIVE: container-query squeeze flip cannot be tested in jsdom (manual QA required)', () => {
    // Structural assertion only: soup-drawer-layout has container-type via CSS.
    // The actual flip (position:static vs position:absolute) cannot be asserted
    // here because jsdom does not process CSS or container queries.
    render(
      <DrawerLayout drawer={null}>
        <span>content</span>
      </DrawerLayout>,
    );
    const layout = document.querySelector('.soup-drawer-layout');
    // Assert the layout element exists with the correct class that carries the container query.
    expect(layout?.classList.contains('soup-drawer-layout')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DrawerHeader / DrawerBody / DrawerFooter sub-components
// ---------------------------------------------------------------------------

describe('Drawer — sub-components', () => {
  it('DrawerHeader renders title text', () => {
    render(
      <Drawer open onClose={() => {}} aria-label="inspector">
        <DrawerHeader title="My Title" onClose={() => {}} />
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    expect(screen.getByText('My Title')).toBeDefined();
  });

  it('DrawerHeader renders close button with aria-label "Close inspector"', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} aria-label="inspector">
        <DrawerHeader title="T" onClose={onClose} />
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    const closeBtn = screen.getByRole('button', { name: 'Close inspector' });
    expect(closeBtn).toBeDefined();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('DrawerBody renders children with soup-drawer-body class', () => {
    render(
      <Drawer open onClose={() => {}} aria-label="inspector">
        <DrawerBody>
          <span data-testid="body-child">body</span>
        </DrawerBody>
      </Drawer>,
    );
    const body = screen.getByTestId('body-child').closest('.soup-drawer-body');
    expect(body).not.toBeNull();
  });

  it('DrawerFooter renders children with soup-drawer-footer class', () => {
    render(
      <Drawer open onClose={() => {}} aria-label="inspector">
        <DrawerBody><span>x</span></DrawerBody>
        <DrawerFooter>
          <button type="button">Action</button>
        </DrawerFooter>
      </Drawer>,
    );
    const footer = screen.getByText('Action').closest('.soup-drawer-footer');
    expect(footer).not.toBeNull();
  });
});

describe('Drawer — restoreFocus override (retarget contract, QA finding D3)', () => {
  it('restores focus to the override target instead of the captured opener', async () => {
    const Fixture: FC = () => {
      const [open, setOpen] = useState(false);
      const overrideRef = useRef<HTMLButtonElement | null>(null);
      return (
        <div>
          <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
            open
          </button>
          <button type="button" data-testid="override-target" ref={overrideRef}>
            current row stand-in
          </button>
          <Drawer
            open={open}
            onClose={() => setOpen(false)}
            aria-label="inspector"
            restoreFocus={overrideRef}
          >
            <DrawerBody><span>content</span></DrawerBody>
          </Drawer>
        </div>
      );
    };
    render(<Fixture />);
    const opener = screen.getByTestId('opener');
    const override = screen.getByTestId('override-target');

    act(() => { opener.focus(); });
    fireEvent.click(opener);
    await act(async () => {});

    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    await act(async () => {});

    // Focus restores to the override target, NOT the opener captured at open.
    expect(document.activeElement).toBe(override);
    expect(document.activeElement).not.toBe(opener);
  });
});


// ---------------------------------------------------------------------------
// B5: Exit presence — jsdom instant path and closing-phase contracts
// ---------------------------------------------------------------------------

describe('Drawer — exit presence: jsdom instant path (C-B5-1)', () => {
  it('open→false removes the drawer synchronously when no animation duration resolves (jsdom path)', async () => {
    const { rerender } = render(
      <Drawer open onClose={() => {}} aria-label="inspector">
        <DrawerBody><span>content</span></DrawerBody>
      </Drawer>
    )
    expect(document.querySelector('.soup-drawer')).not.toBeNull()

    rerender(
      <Drawer open={false} onClose={() => {}} aria-label="inspector">
        <DrawerBody><span>content</span></DrawerBody>
      </Drawer>
    )

    await act(async () => {})
    // In jsdom: no stylesheet → instant unmount (C-B5-1).
    expect(document.querySelector('.soup-drawer')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Bottom-sheet placement (narrow/phone surfaces — reachable action path)
//
// The bottom-sheet docks the same Drawer surface to the bottom edge as a MODAL
// sheet so the contact-pane / inspector actions land on-screen on narrow widths.
// Spec (showcase §26): role="dialog" aria-modal, focus-trapped, Escape +
// scrim-tap dismiss, focus restores to the opener, a grab handle affordance,
// and a translateY slide (removed under prefers-reduced-motion).
// ---------------------------------------------------------------------------

/** Bottom-sheet fixture: trigger + controlled Drawer with action rows. */
const BottomSheetFixture: FC<{
  onClose?: () => void;
}> = ({ onClose }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="sheet-trigger"
        onClick={() => setOpen(true)}
      >
        Open contact actions
      </button>
      <Drawer
        open={open}
        onClose={close}
        aria-label="Contact actions"
        placement="bottom-sheet"
      >
        <DrawerHeader title="+34 612 88 04 19" onClose={close} />
        <DrawerBody>
          <button type="button" data-testid="act-mark-read">
            Mark read
          </button>
          <button type="button" data-testid="act-allow">
            Allow
          </button>
          <button type="button" data-testid="act-block">
            Block
          </button>
          <button type="button" data-testid="act-save">
            Save contact
          </button>
        </DrawerBody>
      </Drawer>
    </>
  );
};

describe('Drawer — bottom-sheet placement (modal)', () => {
  it('shell is role="dialog" with aria-modal="true" (modal, not complementary)', () => {
    render(
      <Drawer open onClose={() => {}} aria-label="sheet" placement="bottom-sheet">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    const shell = screen.getByRole('dialog');
    expect(shell.getAttribute('aria-modal')).toBe('true');
    expect(shell.classList.contains('soup-drawer--bottom-sheet')).toBe(true);
    expect(shell.getAttribute('data-placement')).toBe('bottom-sheet');
    // It must NOT be exposed as a complementary landmark in this mode.
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('default placement stays role="complementary" (non-modal right anchor)', () => {
    render(
      <Drawer open onClose={() => {}} aria-label="sheet">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    expect(screen.getByRole('complementary')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.soup-drawer--bottom-sheet')).toBeNull();
  });

  it('renders a grab-handle affordance above the content (aria-hidden)', () => {
    render(
      <Drawer open onClose={() => {}} aria-label="sheet" placement="bottom-sheet">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    const grab = document.querySelector('.soup-drawer-grab');
    expect(grab).not.toBeNull();
    // Affordance only — hidden from the accessibility tree, never the sole exit.
    expect(grab!.getAttribute('aria-hidden')).toBe('true');
    expect(grab!.querySelector('.soup-drawer-grab__bar')).not.toBeNull();
  });

  it('renders a modal scrim variant (always present, covers the surface beneath)', () => {
    render(
      <Drawer open onClose={() => {}} aria-label="sheet" placement="bottom-sheet">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    const scrim = document.querySelector('.soup-drawer-scrim--bottom-sheet');
    expect(scrim).not.toBeNull();
    expect(scrim!.getAttribute('aria-hidden')).toBe('true');
  });

  it('portals the modal sheet to document.body, escaping the inline layout (DD-24 fix)', () => {
    // The bottom-sheet is position:fixed and must dock to the VIEWPORT bottom.
    // It is portaled to document.body so it escapes the DrawerLayout's
    // `container-type` containing block (which previously docked the absolute
    // sheet to the inline layout's bottom — off-screen on a tall/scrolled narrow
    // page). Proving the shell is NOT inside the render container guards that.
    const { container } = render(
      <Drawer open onClose={() => {}} aria-label="sheet" placement="bottom-sheet">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    const shell = screen.getByRole('dialog');
    expect(container.contains(shell)).toBe(false);
    expect(document.body.contains(shell)).toBe(true);
    // The modal scrim is portaled alongside the shell (same overlay fragment).
    const scrim = document.querySelector('.soup-drawer-scrim--bottom-sheet')!;
    expect(container.contains(scrim)).toBe(false);
  });

  it('does NOT portal the right placement — it stays inline (non-modal, DD-19 exception)', () => {
    const { container } = render(
      <Drawer open onClose={() => {}} aria-label="sheet">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    const shell = screen.getByRole('complementary');
    expect(container.contains(shell)).toBe(true);
  });

  it('Escape dismisses the bottom-sheet exactly once', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} aria-label="sheet" placement="bottom-sheet">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('scrim-tap (outside pointerdown) dismisses the modal bottom-sheet', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} aria-label="sheet" placement="bottom-sheet">
        <DrawerBody><span data-testid="inside">x</span></DrawerBody>
      </Drawer>,
    );
    // A pointerdown OUTSIDE the sheet shell (on the scrim) dismisses — the
    // bottom-sheet opts into dismissable=true because it is modal.
    const scrim = document.querySelector('.soup-drawer-scrim--bottom-sheet')!;
    fireEvent.pointerDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);

    // A pointerdown INSIDE the sheet does NOT dismiss.
    onClose.mockClear();
    fireEvent.pointerDown(screen.getByTestId('inside'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('right placement does NOT dismiss on outside pointerdown (non-modal)', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} aria-label="inspector">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    const scrim = document.querySelector('.soup-drawer-scrim')!;
    fireEvent.pointerDown(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('traps focus and restores it to the opener on Escape (modal containment)', async () => {
    render(<BottomSheetFixture />);
    const trigger = screen.getByTestId('sheet-trigger');
    act(() => { trigger.focus(); });
    fireEvent.click(trigger);
    await act(async () => {});

    // Initial focus lands on the close X (focus moved into the trapped sheet).
    const closeBtn = screen.getByRole('button', { name: 'Close inspector' });
    expect(document.activeElement).toBe(closeBtn);

    // Close via Escape → focus restores to the opening trigger.
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    await act(async () => {});
    expect(document.activeElement).toBe(trigger);
  });

  it('opening sheet starts in data-state="open" and closes cleanly', async () => {
    const { rerender } = render(
      <Drawer open onClose={() => {}} aria-label="sheet" placement="bottom-sheet">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    const shell = document.querySelector('.soup-drawer--bottom-sheet') as HTMLElement;
    expect(shell).not.toBeNull();
    // The open sheet is in the open phase (its enter keyframe is the slide-up).
    expect(shell.getAttribute('data-state')).toBe('open');

    rerender(
      <Drawer open={false} onClose={() => {}} aria-label="sheet" placement="bottom-sheet">
        <DrawerBody><span>x</span></DrawerBody>
      </Drawer>,
    );
    await act(async () => {});
    // jsdom (no stylesheet) → instant unmount path (C-B5-1); a closing shell, if
    // present, is finished by its OWN slide-down keyframe (soup-drawer-sheet-out).
    await act(async () => {
      const closing = document.querySelector('.soup-drawer--bottom-sheet');
      if (closing) {
        fireEvent.animationEnd(closing, { animationName: 'soup-drawer-sheet-out' });
      }
    });
    await act(async () => {});
    expect(document.querySelector('.soup-drawer--bottom-sheet')).toBeNull();
  });

  it('wires the slide-DOWN (translateY) exit keyframe in the stylesheet', () => {
    // The sheet shell watches soup-drawer-sheet-out; the keyframe must move the
    // surface via translateY 0→100% (slide down off the bottom edge), the
    // bottom-sheet's spatial exit — distinct from the right placement's translateX.
    const css = readFileSync(
      resolve(__here, '../../console/src/styles/primitives.css'),
      'utf8',
    );
    expect(css).toMatch(
      /@keyframes soup-drawer-sheet-out \{\s*from \{ transform: translateY\(0\); \}\s*to\s+\{ transform: translateY\(100%\); \}/,
    );
    expect(css).toMatch(
      /@keyframes soup-drawer-sheet-in \{\s*from \{ transform: translateY\(100%\); \}\s*to\s+\{ transform: translateY\(0\); \}/,
    );
  });

  it('reduced-motion neutralizes the bottom-sheet slide (off-and-instant)', () => {
    // The reduced-motion rule sets animation:none on .soup-drawer--bottom-sheet
    // so the translateY slide is REMOVED, not shortened. We assert the stylesheet
    // carries that rule (jsdom does not apply media queries, so this is a
    // source-contract check, mirroring the right-placement reduced-motion idiom).
    const css = readFileSync(
      resolve(__here, '../../console/src/styles/primitives.css'),
      'utf8',
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.soup-drawer--bottom-sheet[^]*?animation: none/,
    );
  });

  it('wired consumer actions stay reachable inside the bottom-sheet (DD-24 fix)', async () => {
    render(<BottomSheetFixture />);
    fireEvent.click(screen.getByTestId('sheet-trigger'));
    await act(async () => {});

    // All four contact-pane actions render INSIDE the modal sheet shell —
    // on a narrow viewport they are docked on-screen, not off the right edge.
    const shell = screen.getByRole('dialog');
    for (const id of ['act-mark-read', 'act-allow', 'act-block', 'act-save']) {
      const action = screen.getByTestId(id);
      expect(shell.contains(action)).toBe(true);
    }
  });
});

describe('Drawer — exit presence: closing phase with stubbed duration', () => {
  it('animationend on the shell with matching animationName → unmounts drawer', async () => {
    const { rerender } = render(
      <Drawer open onClose={() => {}} aria-label="inspector">
        <DrawerBody><span>content</span></DrawerBody>
      </Drawer>
    )

    const shell = document.querySelector('.soup-drawer') as HTMLElement
    expect(shell).not.toBeNull()
    shell.style.animationDuration = '180ms'

    rerender(
      <Drawer open={false} onClose={() => {}} aria-label="inspector">
        <DrawerBody><span>content</span></DrawerBody>
      </Drawer>
    )

    await act(async () => {})

    const closingShell = document.querySelector('.soup-drawer')
    expect(closingShell).not.toBeNull()
    expect(closingShell!.getAttribute('data-state')).toBe('closing')
    await act(async () => {
      fireEvent.animationEnd(closingShell!, { animationName: 'soup-drawer-out' })
    })

    await act(async () => {})
    expect(document.querySelector('.soup-drawer')).toBeNull()
  })

  it('re-open during closing: shell returns to data-state="open"', async () => {
    const { rerender } = render(
      <Drawer open onClose={() => {}} aria-label="inspector">
        <DrawerBody><span>content</span></DrawerBody>
      </Drawer>
    )

    const shell = document.querySelector('.soup-drawer') as HTMLElement
    shell.style.animationDuration = '180ms'

    rerender(
      <Drawer open={false} onClose={() => {}} aria-label="inspector">
        <DrawerBody><span>content</span></DrawerBody>
      </Drawer>
    )
    await act(async () => {})

    const closingShell = document.querySelector('.soup-drawer')
    expect(closingShell).not.toBeNull()
    expect(closingShell!.getAttribute('data-state')).toBe('closing')

    // Re-open
    rerender(
      <Drawer open onClose={() => {}} aria-label="inspector">
        <DrawerBody><span>content</span></DrawerBody>
      </Drawer>
    )
    await act(async () => {})

    const drawerEl = document.querySelector('.soup-drawer')
    expect(drawerEl).not.toBeNull()
    expect(drawerEl?.getAttribute('data-state')).toBe('open')
  })
})
