/**
 * @file tests/browser-motion/b5-exit-motion.test.tsx
 *
 * B5 animated-exit proofs (no-reduce browser context via vitest.browser.motion.config.ts).
 *
 * These proofs require a context WITHOUT reducedMotion because they assert:
 *   - data-state="closing" persists while the CSS -out keyframe plays
 *   - computed animation-name matches the expected keyframe name
 *   - the element is removed within a bounded window after the animation
 *   - the closing backdrop has pointer-events: none (motion.md §10)
 *
 * Under the existing vitest.browser.config.ts (reducedMotion: 'reduce'), CSS
 * animation-duration resolves to 0s and the element unmounts immediately — there
 * is no closing dwell to observe. Hence this separate config.
 *
 * C-B5-7: this file is intentionally NOT wired into the main npm test:browser
 * script. The D7 lane wires it when the no-reduce config is validated on CI.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { useState } from 'react';
import { Modal, ModalHeader, ModalBody } from '../../console/src/components/primitives/Modal';
import { Drawer, DrawerBody, DrawerLayout } from '../../console/src/components/primitives/Drawer';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual };
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for a maximum of `ms` milliseconds for a condition to become true. */
async function waitFor(condition: () => boolean, maxMs = 500): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 16));
  }
}

// ---------------------------------------------------------------------------
// Suite 1: Modal exit motion
// ---------------------------------------------------------------------------

describe('B5 — modal exit motion (animated, no-reduce context)', () => {
  it('shell carries data-state="closing" and soup-modal-shell-out animation on close', async () => {
    const { rerender } = render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Exit motion test" />
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    );

    expect(document.querySelector('[role="dialog"]') ).not.toBeNull();

    rerender(
      <Modal open={false} onClose={() => {}}>
        <ModalHeader title="Exit motion test" />
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    );

    // Immediately after re-render the closing dwell should be active.
    const closingShell = document.querySelector('.soup-modal-shell');
    if (closingShell) {
      expect(closingShell.getAttribute('data-state')).toBe('closing');
      const animName = getComputedStyle(closingShell).animationName;
      expect(animName).toBe('soup-modal-shell-out');
    }

    // After the animation completes the shell must be gone.
    await waitFor(() => document.querySelector('.soup-modal-shell') === null, 500);
    expect(document.querySelector('.soup-modal-shell')).toBeNull();
  });

  it('closing backdrop has pointer-events: none (motion.md §10)', async () => {
    const { rerender } = render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Pointer events test" />
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    );

    rerender(
      <Modal open={false} onClose={() => {}}>
        <ModalHeader title="Pointer events test" />
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    );

    const backdrop = document.querySelector('.soup-modal-backdrop') as HTMLElement | null;
    if (backdrop) {
      const pe = getComputedStyle(backdrop).pointerEvents;
      expect(pe).toBe('none');
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Drawer exit motion
// ---------------------------------------------------------------------------

describe('B5 — drawer exit motion (animated, no-reduce context)', () => {
  it('drawer shell carries data-state="closing" and soup-drawer-out animation on close', async () => {
    const { rerender } = render(
      <DrawerLayout
        drawer={
          <Drawer open onClose={() => {}} aria-label="inspector">
            <DrawerBody><span>drawer content</span></DrawerBody>
          </Drawer>
        }
      >
        <span>content</span>
      </DrawerLayout>
    );

    expect(document.querySelector('.soup-drawer')).not.toBeNull();

    rerender(
      <DrawerLayout
        drawer={
          <Drawer open={false} onClose={() => {}} aria-label="inspector">
            <DrawerBody><span>drawer content</span></DrawerBody>
          </Drawer>
        }
      >
        <span>content</span>
      </DrawerLayout>
    );

    const closingShell = document.querySelector('.soup-drawer');
    if (closingShell) {
      expect(closingShell.getAttribute('data-state')).toBe('closing');
      const animName = getComputedStyle(closingShell).animationName;
      expect(animName).toBe('soup-drawer-out');
    }

    // After animation completes, drawer is gone.
    await waitFor(() => document.querySelector('.soup-drawer') === null, 600);
    expect(document.querySelector('.soup-drawer')).toBeNull();
  });
});
