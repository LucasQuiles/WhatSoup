/**
 * @file tests/browser-motion/b5-motion-policy.test.tsx
 *
 * B5 production motion-policy proofs (no-reduce browser context).
 *
 * These proofs require a context WITHOUT reducedMotion because they assert
 * matchMedia is false and real production Modal/Drawer shells retain their
 * authored enter animations with non-zero computed durations.
 *
 * Exit-presence proofs additionally require closing shells to survive the
 * falling edge with their authored exit animations and disappear only after
 * animation completion.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
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

  it('retains closing shell and backdrop through their authored exit animations', async () => {
    const { rerender } = await render(
      <Modal open onClose={() => {}}>
        <ModalHeader title="Modal exit test" />
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    );

    await rerender(
      <Modal open={false} onClose={() => {}}>
        <ModalHeader title="Modal exit test" />
        <ModalBody><span>content</span></ModalBody>
      </Modal>
    );

    const closingShell = document.querySelector<HTMLElement>('.soup-modal-shell');
    const closingBackdrop = document.querySelector<HTMLElement>('.soup-modal-backdrop');
    expect(closingShell).not.toBeNull();
    expect(closingBackdrop).not.toBeNull();
    expect(closingShell!.getAttribute('data-state')).toBe('closing');
    expect(closingBackdrop!.getAttribute('data-state')).toBe('closing');
    expect(getComputedStyle(closingShell!).animationName).toBe('soup-modal-shell-out');
    expect(getComputedStyle(closingBackdrop!).animationName).toBe('soup-modal-backdrop-out');
    expect(parseFloat(getComputedStyle(closingShell!).animationDuration)).toBeGreaterThan(0);
    expect(parseFloat(getComputedStyle(closingBackdrop!).animationDuration)).toBeGreaterThan(0);
    expect(getComputedStyle(closingBackdrop!).pointerEvents).toBe('none');

    await vi.waitFor(() => {
      expect(document.querySelector('.soup-modal-shell')).toBeNull();
      expect(document.querySelector('.soup-modal-backdrop')).toBeNull();
    });
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

  it('retains the closing shell through its authored exit animation', async () => {
    const { rerender } = await render(
      <DrawerLayout
        drawer={
          <Drawer open onClose={() => {}} aria-label="exit inspector">
            <DrawerBody><span>drawer content</span></DrawerBody>
          </Drawer>
        }
      >
        <span>content</span>
      </DrawerLayout>
    );

    await rerender(
      <DrawerLayout
        drawer={
          <Drawer open={false} onClose={() => {}} aria-label="exit inspector">
            <DrawerBody><span>drawer content</span></DrawerBody>
          </Drawer>
        }
      >
        <span>content</span>
      </DrawerLayout>
    );

    const closingShell = document.querySelector<HTMLElement>('.soup-drawer');
    const closingScrim = document.querySelector<HTMLElement>('.soup-drawer-scrim');
    expect(closingShell).not.toBeNull();
    expect(closingScrim).not.toBeNull();
    expect(closingShell!.getAttribute('data-state')).toBe('closing');
    expect(closingScrim!.getAttribute('data-state')).toBe('closing');
    expect(getComputedStyle(closingShell!).animationName).toBe('soup-drawer-out');
    expect(getComputedStyle(closingScrim!).animationName).toBe('soup-drawer-scrim-out');
    expect(parseFloat(getComputedStyle(closingShell!).animationDuration)).toBeGreaterThan(0);
    expect(parseFloat(getComputedStyle(closingScrim!).animationDuration)).toBeGreaterThan(0);
    expect(getComputedStyle(closingScrim!).pointerEvents).toBe('none');

    await vi.waitFor(() => {
      expect(document.querySelector('.soup-drawer')).toBeNull();
      expect(document.querySelector('.soup-drawer-scrim')).toBeNull();
    });
  });
});
