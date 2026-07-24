/**
 * @file tests/browser-motion/ceremony-play.test.tsx
 *
 * v3.5 ceremony PLAY contract (T5 b-10 acceptance, 13-ceremony-motion §2),
 * computed in a browser context WITHOUT reducedMotion.
 *
 * Why it lives in the motion lane: b-10 wrote this leg into the D7 browser
 * suite while `instances[].context.reducedMotion` was inert — the option the
 * provider never read, so animations played there by accident. #2158 corrected
 * the option to factory-level `contextOptions`, which makes the D7 lane
 * genuinely reduced-motion, and a play contract cannot be asserted in a lane
 * that (correctly) removes animation. The two halves of the law are now each
 * proven where they are true:
 *
 *   - PLAY (this file, no-reduce context): glow is the radial one-shot,
 *     ≤800ms, single iteration; avatar pops once.
 *   - REMOVAL (tests/browser/viewport-matrix.test.tsx, reduce context):
 *     the same computed properties resolve to no animation.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { page } from '@vitest/browser/context';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Ceremony } from '../../console/src/components/journey/Ceremony';
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context';
// The computed-animation assertions need the real stylesheet in the document —
// without it every animation-name resolves to 'none' and the pins pass/fail for
// the wrong reason.
import '../../console/src/index.css';

afterEach(() => {
  cleanup();
});

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
};

function wrapCeremony() {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter>
          <Ceremony
            name="Quinn"
            soul="Keeps the room tidy."
            channelLabel="WhatsApp"
            adminPhone="+15550100001"
            lineName="quinn"
            agentInitial="Q"
            onAdjust={() => {}}
          />
        </MemoryRouter>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}

describe('v3.5 ceremony play contract (13-§2, no-reduce context)', () => {
  it('glow is the radial one-shot: ≤800ms, single iteration', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapCeremony());
    await vi.waitFor(() => {
      expect(container.querySelector('.journey-glow')).not.toBeNull();
    });
    const glow = container.querySelector('.journey-glow') as HTMLElement;
    const glowStyle = window.getComputedStyle(glow);
    expect(glowStyle.animationName).toBe('journey-glowplay');
    expect(parseFloat(glowStyle.animationDuration)).toBeLessThanOrEqual(0.8);
    expect(glowStyle.animationIterationCount).toBe('1');
  });

  it('the avatar pops exactly once', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapCeremony());
    await vi.waitFor(() => {
      expect(container.querySelector('.journey-av')).not.toBeNull();
    });
    const av = container.querySelector('.journey-av') as HTMLElement;
    const style = window.getComputedStyle(av);
    expect(style.animationName).toBe('journey-pop');
    expect(style.animationIterationCount).toBe('1');
  });
});
