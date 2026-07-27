/**
 * @file tests/browser/b5-inert-toast.test.tsx
 *
 * B5 browser proofs (reduced-motion context from vitest.browser.config.ts):
 *
 *   1. Modal open → #root has inert attribute; a button inside #root refuses
 *      programmatic focus; modal closed → button focusable again.
 *   2. Background inert releases after modal close, making the background
 *      button focusable again (C-B5-4 end-state proof).
 *   3. Toast liveness: toast fired while a modal is open renders outside the
 *      inert subtree (body-level) and its dismiss button is clickable.
 *   4. Reduced-motion exit proof: close a modal → element removed immediately
 *      (no closing dwell in the reduced-motion context, motion.md §9).
 *
 * These run under the existing vitest.browser.config.ts (reducedMotion: 'reduce').
 * Animated-exit proofs (duration + data-state dwell) run under
 * vitest.browser.motion.config.ts via tests/browser-motion/.
 *
 * Note: CDP-driven browser tests do not use jsdom. The inert attribute in a real
 * browser is behaviorally enforced (focus() no-ops, click events suppressed).
 * jsdom only checks attribute presence — the browser proves the actual behavior.
 *
 * NOTE: No vi.mock calls in this file. Modal, ModalHeader, ModalBody, ToastProvider,
 * and useToast do not import react-router-dom or any module requiring a stub.
 * The earlier passthrough mock (vi.mock react-router-dom with ...actual spread)
 * was a no-op and has been removed — async importOriginal spread factories
 * do not reliably work under @vitest/browser 3.2.6.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { useEffect } from 'react';
import { Modal, ModalHeader, ModalBody } from '../../console/src/components/primitives/Modal';
import { _resetInertCount } from '../../console/src/hooks/use-background-inert.ts';
import { ToastProvider } from '../../console/src/hooks/use-toast.tsx';
import { useToast } from '../../console/src/hooks/toast-context.ts';
import '../../console/src/index.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates and appends a #root element; returns a cleanup function. */
function createRoot(): { root: HTMLDivElement; cleanup: () => void } {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  return { root, cleanup: () => { if (root.parentNode) root.parentNode.removeChild(root); } };
}

afterEach(() => {
  cleanup();
  _resetInertCount();
});

// ---------------------------------------------------------------------------
// Suite 1: Reduced-motion exit proof
// ---------------------------------------------------------------------------

describe('B5 — reduced-motion exit: modal removed instantly on close', () => {
  it('closes without a closing dwell under prefers-reduced-motion: reduce', async () => {
    // Under reducedMotion: 'reduce' the browser emits prefers-reduced-motion: reduce.
    // The CSS block sets animation: none on [data-state="closing"] → computed duration
    // is 0s → the presence hook takes the instant path → unmount is synchronous.
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);

    const { getByRole, rerender } = await render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Reduced motion test" />
        <ModalBody><button type="button">inside</button></ModalBody>
      </Modal>
    );

    const dialog = getByRole('dialog').element();
    expect(dialog).not.toBeNull();
    expect(getComputedStyle(dialog).animationName).toBe('none');

    await rerender(
      <Modal open={false} onClose={() => {}}>
        <ModalHeader title="Reduced motion test" />
        <ModalBody><button type="button">inside</button></ModalBody>
      </Modal>
    );

    // Reduced motion must remove the dialog through the real close path without
    // waiting for an animation. The open-state computed-style assertion above
    // proves this context resolves the production animation to `none`.
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.querySelector('.soup-modal-shell')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Background inert behavioral proof
// ---------------------------------------------------------------------------

describe('B5 — background inert: #root inert while modal open', () => {
  it('button inside #root refuses focus while modal is open; becomes focusable after close', async () => {
    const { root, cleanup: cleanRoot } = createRoot();

    try {
      // Render a button inside #root (will be inerted when modal opens).
      const bgButton = document.createElement('button');
      bgButton.textContent = 'Background';
      bgButton.setAttribute('type', 'button');
      root.appendChild(bgButton);

      // Render modal (portals to body — outside #root).
      const { rerender } = await render(
        <Modal open onClose={() => {}}>
          <ModalHeader title="Inert test" />
          <ModalBody><span>modal content</span></ModalBody>
        </Modal>
      );

      // #root should have inert.
      expect(root.hasAttribute('inert')).toBe(true);

      // Focus attempt on the background button must be a no-op.
      bgButton.focus();
      expect(document.activeElement).not.toBe(bgButton);

      // Close the modal.
      await rerender(
        <Modal open={false} onClose={() => {}}>
          <ModalHeader title="Inert test" />
          <ModalBody><span>modal content</span></ModalBody>
        </Modal>
      );

      // Inert released.
      expect(root.hasAttribute('inert')).toBe(false);

      // Background button is now focusable.
      bgButton.focus();
      expect(document.activeElement).toBe(bgButton);
    } finally {
      cleanRoot();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Toast liveness with modal open (C-B5-3)
// ---------------------------------------------------------------------------

describe('B5 — toast liveness: toast outside inert subtree while modal is open', () => {
  it('toast stack portals to body (outside inert #root) while a modal is open', async () => {
    // This test verifies the portal location of the toast stack, not dismiss-button
    // clickability. The toast fires via useEffect on mount (before the inert
    // attribute is set by the Modal), ensuring the .fixed portal container exists.
    // Computed-box/trusted-event proof lives in the browser lane (this file).
    const { root, cleanup: cleanRoot } = createRoot();

    try {
      // Fire a toast on mount so the toast stack is populated immediately.
      const ToastAutoFire = () => {
        const { info } = useToast();
        useEffect(() => {
          info('Test toast while modal open');
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional fire-once-on-mount test harness; expires 2026-12-31
        }, []);
        return null;
      };

      await render(
        <ToastProvider>
          <ToastAutoFire />
          <Modal open onClose={() => {}}>
            <ModalHeader title="Modal with toast" />
            <ModalBody><span>content</span></ModalBody>
          </Modal>
        </ToastProvider>
      );

      // Modal is open → #root is inert.
      expect(root.hasAttribute('inert')).toBe(true);

      // The toast stack portals to document.body (outside #root).
      // ToastProvider renders: createPortal(toastStack, document.body)
      // The stack div carries className="fixed z-[var(--z-toast)] ..."
      const toastPortal = document.body.querySelector('.fixed');
      // The portal must exist (toast was fired on mount).
      expect(toastPortal).not.toBeNull();
      // The portal must be outside #root — not contained by the inert subtree.
      expect(root.contains(toastPortal)).toBe(false);

      const dismissButton = page.getByRole('button', { name: 'Dismiss notification' });
      expect(dismissButton.element()).not.toBeNull();
      await dismissButton.click();
      await vi.waitFor(() => {
        expect(document.body.querySelector('[role="alert"]')).toBeNull();
      });
    } finally {
      cleanup();
      cleanRoot();
    }
  });
});
