/**
 * @vitest-environment jsdom
 */
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { createElement, type FC, type ReactNode } from 'react';

vi.mock('../../console/src/components/Toast.tsx', () => ({
  default: ({
    variant,
    message,
    onClose,
  }: {
    variant: string;
    message: string;
    onClose: () => void;
  }) => createElement(
    'div',
    {
      role: 'alert',
      'aria-live': 'polite',
      'data-variant': variant,
    },
    createElement('span', null, message),
    createElement('button', { type: 'button', onClick: onClose }, 'Dismiss notification'),
  ),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  motion: {
    div: ({ children }: { children?: ReactNode }) =>
      createElement('div', null, children),
  },
}));

import { useToast } from '../../console/src/hooks/toast-context.ts';
import { ToastProvider, MAX_TOASTS } from '../../console/src/hooks/use-toast.tsx';

// ---- Helpers ----

function renderProvider() {
  let toastApi: ReturnType<typeof useToast> | null = null;

  const Consumer: FC = () => {
    toastApi = useToast();
    return createElement('span', { 'data-testid': 'consumer' }, 'consumer');
  };

  const result = render(
    createElement(ToastProvider, null, createElement(Consumer)),
  );

  return {
    ...result,
    getApi: () => {
      if (!toastApi) throw new Error('toast api was not captured');
      return toastApi;
    },
  };
}

function pushToast(api: ReturnType<typeof useToast>, variant: 'success' | 'error' | 'info', message: string) {
  act(() => {
    api.toast(variant, message);
  });
}

function alertTexts() {
  return screen.getAllByRole('alert').map(alert => alert.textContent);
}

function alertWithText(text: string) {
  const alert = screen.getAllByRole('alert').find(item => item.textContent?.includes(text));
  if (!alert) throw new Error(`Unable to find alert with text: ${text}`);
  return alert;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---- useToast ----

describe('useToast', () => {
  it('throws when rendered outside a ToastProvider', () => {
    expect(() => {
      renderHook(() => useToast());
    }).toThrow('useToast must be used within a ToastProvider');
  });

  it('exposes toast helpers including dismiss and clear from inside a ToastProvider', () => {
    const { getApi } = renderProvider();
    const api = getApi();

    expect(Object.keys(api).sort()).toEqual(['clear', 'dismiss', 'error', 'info', 'success', 'toast']);
    expect(api).toEqual({
      toast: expect.any(Function),
      success: expect.any(Function),
      error: expect.any(Function),
      info: expect.any(Function),
      dismiss: expect.any(Function),
      clear: expect.any(Function),
    });
  });
});

// ---- ToastProvider ----

describe('ToastProvider', () => {
  it('renders children before any toast is shown', () => {
    render(
      createElement(
        ToastProvider,
        null,
        createElement('span', { 'data-testid': 'child-node' }, 'content'),
      ),
    );

    expect(screen.getByTestId('child-node').textContent).toBe('content');
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('renders pushed toasts as alerts in FIFO order', () => {
    const { getApi } = renderProvider();
    const api = getApi();

    act(() => {
      api.toast('info', 'first message');
      api.toast('success', 'second message');
      api.toast('error', 'third message');
    });

    expect(screen.getAllByRole('alert')).toHaveLength(3);
    expect(alertTexts()).toEqual([
      'first messageDismiss notification',
      'second messageDismiss notification',
      'third messageDismiss notification',
    ]);
    expect(screen.getAllByRole('alert').map(alert => alert.getAttribute('data-variant'))).toEqual([
      'info',
      'success',
      'error',
    ]);
  });

  it('renders duplicate messages as separate notifications', () => {
    const { getApi } = renderProvider();

    act(() => {
      getApi().toast('info', 'duplicate');
      getApi().toast('info', 'duplicate');
    });

    expect(alertTexts()).toEqual([
      'duplicateDismiss notification',
      'duplicateDismiss notification',
    ]);
  });

  it('success, error, and info helpers render their matching variants', () => {
    const { getApi } = renderProvider();
    const api = getApi();

    act(() => {
      api.success('saved');
      api.error('failed');
      api.info('queued');
    });

    const alerts = screen.getAllByRole('alert');
    expect(alerts.map(alert => alert.getAttribute('data-variant'))).toEqual([
      'success',
      'error',
      'info',
    ]);
    expect(alertTexts()).toEqual([
      'savedDismiss notification',
      'failedDismiss notification',
      'queuedDismiss notification',
    ]);
  });

  it('removes only the dismissed notification when its close button is clicked', () => {
    const { getApi } = renderProvider();

    act(() => {
      getApi().toast('info', 'first');
      getApi().toast('info', 'second');
      getApi().toast('info', 'third');
    });

    const secondAlert = alertWithText('second');
    fireEvent.click(within(secondAlert).getByRole('button', { name: 'Dismiss notification' }));

    expect(alertTexts()).toEqual([
      'firstDismiss notification',
      'thirdDismiss notification',
    ]);
  });

  it('removes one of two duplicate notifications when only one close button is clicked', () => {
    const { getApi } = renderProvider();

    act(() => {
      getApi().toast('info', 'duplicate');
      getApi().toast('info', 'duplicate');
    });

    const alerts = screen.getAllByRole('alert');
    fireEvent.click(within(alerts[0]).getByRole('button', { name: 'Dismiss notification' }));

    expect(alertTexts()).toEqual(['duplicateDismiss notification']);
  });

  it('keeps children mounted after toast state changes', () => {
    const { getApi } = renderProvider();

    pushToast(getApi(), 'success', 'side-by-side');

    expect(screen.getByTestId('consumer').textContent).toBe('consumer');
    expect(alertWithText('side-by-side')).toBeTruthy();
  });

  // ---- dismiss / clear / cap ----

  it('dismiss removes a toast by id returned from toast()', () => {
    const { getApi } = renderProvider();
    const api = getApi();

    let betaId: number | undefined;

    act(() => {
      api.toast('info', 'alpha');
      betaId = api.toast('success', 'beta');
      api.toast('error', 'gamma');
    });

    expect(screen.getAllByRole('alert')).toHaveLength(3);
    expect(betaId).toEqual(expect.any(Number));

    act(() => {
      api.dismiss(betaId!);
    });

    expect(alertTexts()).toEqual([
      'alphaDismiss notification',
      'gammaDismiss notification',
    ]);
  });

  it('success, error, and info return ids that can be dismissed', () => {
    const { getApi } = renderProvider();
    const api = getApi();

    let savedId: number | undefined;
    let failedId: number | undefined;
    let queuedId: number | undefined;

    act(() => {
      savedId = api.success('saved');
      failedId = api.error('failed');
      queuedId = api.info('queued');
    });

    expect([savedId, failedId, queuedId]).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);

    act(() => {
      api.dismiss(failedId!);
    });

    expect(alertTexts()).toEqual([
      'savedDismiss notification',
      'queuedDismiss notification',
    ]);
  });

  it('dismiss is a no-op when id is not found', () => {
    const { getApi } = renderProvider();
    const api = getApi();

    act(() => {
      api.toast('info', 'present');
    });

    expect(screen.getAllByRole('alert')).toHaveLength(1);

    // Dismiss with ids that were never assigned — queue must be unchanged
    act(() => {
      api.dismiss(-1);
      api.dismiss(99999);
    });

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('alert')[0].textContent).toContain('present');
  });

  it('clear removes all toasts at once', () => {
    const { getApi } = renderProvider();
    const api = getApi();

    act(() => {
      api.toast('info', 'one');
      api.toast('success', 'two');
      api.toast('error', 'three');
    });

    expect(screen.getAllByRole('alert')).toHaveLength(3);

    act(() => {
      api.clear();
    });

    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('push evicts oldest when MAX_TOASTS exceeded', () => {
    const { getApi } = renderProvider();
    const api = getApi();

    // Push MAX_TOASTS + 2 toasts; only the last MAX_TOASTS should survive
    act(() => {
      for (let i = 0; i < MAX_TOASTS + 2; i++) {
        api.toast('info', `msg-${i}`);
      }
    });

    const texts = alertTexts();
    expect(texts).toHaveLength(MAX_TOASTS);

    // The first two toasts (msg-0 and msg-1) must have been evicted
    expect(texts.some(t => t?.includes('msg-0'))).toBe(false);
    expect(texts.some(t => t?.includes('msg-1'))).toBe(false);

    // The last MAX_TOASTS toasts (msg-2 through msg-(MAX_TOASTS+1)) must be present
    for (let i = 2; i < MAX_TOASTS + 2; i++) {
      expect(texts.some(t => t?.includes(`msg-${i}`))).toBe(true);
    }
  });

  it('MAX_TOASTS cap is respected across mixed push paths (success/error/info)', () => {
    const { getApi } = renderProvider();
    const api = getApi();

    // Push via all four push paths; total = MAX_TOASTS + 1 to exceed cap by 1
    act(() => {
      for (let i = 0; i < MAX_TOASTS + 1; i++) {
        if (i % 4 === 0) api.success(`s-${i}`);
        else if (i % 4 === 1) api.error(`e-${i}`);
        else if (i % 4 === 2) api.info(`n-${i}`);
        else api.toast('info', `t-${i}`);
      }
    });

    expect(screen.getAllByRole('alert')).toHaveLength(MAX_TOASTS);
  });
});
