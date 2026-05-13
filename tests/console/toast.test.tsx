/**
 * Behavioral coverage for console/src/components/Toast.tsx.
 *
 * Toast renders a dismissable notification with a mount-time useEffect
 * that auto-fires onClose after `duration` ms. Uses jsdom + RTL to drive
 * the effect; fake timers control the auto-dismiss clock.
 *
 * Critical invariants:
 *   - role="alert" + aria-live="polite" (screen-reader contract)
 *   - Dismiss button has aria-label="Dismiss notification"
 *   - Message text renders inline
 *   - variant → icon component + color class (success / error / info)
 *   - Auto-dismiss fires onClose after duration ms (default 4000)
 *   - Cleanup cancels the timer when component unmounts before fire
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import Toast from '../../console/src/components/Toast.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Toast — accessibility', () => {
  it('outer container has role="alert" and aria-live="polite"', () => {
    const { container } = render(
      createElement(Toast, { variant: 'info', message: 'hi', onClose: () => {} }),
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('role')).toBe('alert');
    expect(root.getAttribute('aria-live')).toBe('polite');
  });

  it('dismiss button has aria-label="Dismiss notification"', () => {
    const { getByLabelText } = render(
      createElement(Toast, { variant: 'info', message: 'hi', onClose: () => {} }),
    );
    const button = getByLabelText('Dismiss notification');
    expect(button.tagName).toBe('BUTTON');
  });
});

describe('Toast — message rendering', () => {
  it('renders the message text inline', () => {
    const { getByText } = render(
      createElement(Toast, { variant: 'info', message: 'hello world', onClose: () => {} }),
    );
    expect(getByText('hello world')).toBeTruthy();
  });
});

describe('Toast — variant → icon presence', () => {
  // The icon is rendered as <svg>. We can verify its presence + count.
  function countIcons(container: HTMLElement): number {
    // 2 SVGs expected: 1 variant icon + 1 close X.
    return container.querySelectorAll('svg').length;
  }

  it('success variant renders the variant icon + close icon (2 SVGs)', () => {
    const { container } = render(
      createElement(Toast, { variant: 'success', message: 'x', onClose: () => {} }),
    );
    expect(countIcons(container)).toBe(2);
  });

  it('error variant renders the variant icon + close icon (2 SVGs)', () => {
    const { container } = render(
      createElement(Toast, { variant: 'error', message: 'x', onClose: () => {} }),
    );
    expect(countIcons(container)).toBe(2);
  });

  it('info variant renders the variant icon + close icon (2 SVGs)', () => {
    const { container } = render(
      createElement(Toast, { variant: 'info', message: 'x', onClose: () => {} }),
    );
    expect(countIcons(container)).toBe(2);
  });
});

describe('Toast — variant → color class on icon', () => {
  it('success variant icon carries text-s-ok', () => {
    const { container } = render(
      createElement(Toast, { variant: 'success', message: 'x', onClose: () => {} }),
    );
    // First svg is the variant icon (close X is second)
    const variantIcon = container.querySelector('svg');
    expect(variantIcon?.getAttribute('class')).toContain('text-s-ok');
  });

  it('error variant icon carries text-s-crit', () => {
    const { container } = render(
      createElement(Toast, { variant: 'error', message: 'x', onClose: () => {} }),
    );
    const variantIcon = container.querySelector('svg');
    expect(variantIcon?.getAttribute('class')).toContain('text-s-crit');
  });

  it('info variant icon carries text-m-cht', () => {
    const { container } = render(
      createElement(Toast, { variant: 'info', message: 'x', onClose: () => {} }),
    );
    const variantIcon = container.querySelector('svg');
    expect(variantIcon?.getAttribute('class')).toContain('text-m-cht');
  });
});

describe('Toast — auto-dismiss timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('fires onClose after the default duration of 4000ms', () => {
    const onClose = vi.fn();
    render(createElement(Toast, { variant: 'info', message: 'x', onClose }));
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3999);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('honours a custom duration prop', () => {
    const onClose = vi.fn();
    render(
      createElement(Toast, { variant: 'info', message: 'x', onClose, duration: 1500 }),
    );
    vi.advanceTimersByTime(1499);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('unmount cancels the auto-dismiss timer (no onClose call after unmount)', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      createElement(Toast, { variant: 'info', message: 'x', onClose, duration: 1000 }),
    );
    unmount();
    vi.advanceTimersByTime(5000);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Toast — manual dismiss', () => {
  it('clicking the dismiss button invokes onClose immediately', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      createElement(Toast, { variant: 'info', message: 'x', onClose }),
    );
    fireEvent.click(getByLabelText('Dismiss notification'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
