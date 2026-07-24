/**
 * @file tests/browser-motion/b5-motion-policy.test.tsx
 *
 * B5 production motion-policy proofs (no-reduce browser context).
 *
 * These proofs require a context WITHOUT reducedMotion because they assert
 * matchMedia is false and real production Modal/Drawer shells retain their
 * authored enter animations with non-zero computed durations.
 *
 * Exit-presence behavior is intentionally not claimed here. A separate defect
 * causes the shell to unmount before the close effect can establish its dwell;
 * this lane keeps the harness-policy repair bounded to configuration and proof.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { Modal, ModalHeader, ModalBody } from '../../console/src/components/primitives/Modal';
import { Drawer, DrawerBody, DrawerLayout } from '../../console/src/components/primitives/Drawer';
import '../../console/src/index.css';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Production modal motion
// ---------------------------------------------------------------------------

describe('B5 — production modal motion (no-reduce context)', () => {
  it('renders the production shell with its authored non-zero animation', async () => {
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);

    await render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Motion policy test" />
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    );

    const openShell = document.querySelector<HTMLElement>('.soup-modal-shell');
    expect(openShell).not.toBeNull();
    expect(openShell!.getAttribute('data-state')).toBe('open');
    expect(getComputedStyle(openShell!).animationName).toBe('soup-modal-shell-in');
    expect(parseFloat(getComputedStyle(openShell!).animationDuration)).toBeGreaterThan(0);
  });

  it('renders the production backdrop with its authored non-zero animation', async () => {
    await render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Backdrop motion test" />
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    );

    const backdrop = document.querySelector<HTMLElement>('.soup-modal-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop!.getAttribute('data-state')).toBe('open');
    expect(getComputedStyle(backdrop!).animationName).toBe('soup-modal-backdrop-in');
    expect(parseFloat(getComputedStyle(backdrop!).animationDuration)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Production drawer motion
// ---------------------------------------------------------------------------

describe('B5 — production drawer motion (no-reduce context)', () => {
  it('renders the production shell with its authored non-zero animation', async () => {
    await render(
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

    const openShell = document.querySelector<HTMLElement>('.soup-drawer');
    expect(openShell).not.toBeNull();
    expect(openShell!.getAttribute('data-state')).toBe('open');
    expect(getComputedStyle(openShell!).animationName).toBe('soup-drawer-in');
    expect(parseFloat(getComputedStyle(openShell!).animationDuration)).toBeGreaterThan(0);
  });
});
