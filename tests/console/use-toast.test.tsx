/**
 * Behavioral coverage for toast-context.ts + use-toast.tsx.
 *
 * These two files form one unit: the context shape (ToastContext,
 * ToastContextValue, ToastItem, ToastVariant, useToast) and the
 * stateful provider (ToastProvider) that implements it.
 *
 * Source surprises captured during authoring:
 *   - ID counter is a MODULE-LEVEL integer (let nextId = 0), not uuid /
 *     Date.now. IDs are unique within a process lifetime but not stable
 *     across module resets. Tests assert uniqueness, not specific values.
 *   - The provider has NO auto-dismiss timer — that lives entirely inside
 *     the <Toast> component (covered by PR #522). Fake timers not needed.
 *   - The public API is { toast, success, error, info }. There is NO
 *     `dismiss(id)` or `clear()` on the context — removal is internal,
 *     triggered via the `onClose` prop on each rendered <Toast>.
 *   - Queue is FIFO append: setToasts(prev => [...prev, newItem]).
 *     No dedup by ID or message, no max-toasts cap.
 *   - useToast() throws 'useToast must be used within a ToastProvider'
 *     when called outside the provider.
 *   - ToastProvider renders framer-motion AnimatePresence + motion.div
 *     wrappers; both are mocked here so state tests run without animation.
 *
 * Strategy: render a thin "consumer" component inside ToastProvider and
 * call imperative commands via a captured ref. The provider's own JSX
 * renders stub <Toast> nodes with data-testid="toast-stub" so we can
 * count and inspect them in the DOM.
 *
 * @vitest-environment jsdom
 */
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement, type FC, type ReactNode } from 'react';

// ─── Mocks (declared before module imports) ──────────────────────────────────

// Capture onClose callbacks so we can trigger dismissal from tests.
const toastMockOnCloses: Array<() => void> = [];

vi.mock('../../console/src/components/Toast.tsx', () => ({
  default: ({
    variant,
    message,
    onClose,
  }: {
    variant: string;
    message: string;
    onClose: () => void;
  }) => {
    // Register onClose so tests can trigger dismissal imperatively.
    toastMockOnCloses.push(onClose);
    return createElement('div', {
      'data-testid': 'toast-stub',
      'data-variant': variant,
      'data-message': message,
    });
  },
}));

// Framer-motion: transparent pass-through wrappers.
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-testid': 'ap' }, children),
  motion: {
    div: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-testid': 'motion-div' }, children),
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import { useToast } from '../../console/src/hooks/toast-context.ts';
import { ToastProvider } from '../../console/src/hooks/use-toast.tsx';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Render the ToastProvider and expose its useToast() API via a ref.
 * The provider's own JSX renders stub <Toast> nodes in the DOM so
 * we can query them with getByTestId / getAllByTestId.
 */
function renderProvider() {
  let toastApi: ReturnType<typeof useToast> | null = null;

  const Consumer: FC = () => {
    toastApi = useToast();
    return createElement('span', { 'data-testid': 'consumer' });
  };

  const result = render(
    createElement(ToastProvider, null, createElement(Consumer)),
  );

  return {
    ...result,
    getApi: () => toastApi!,
  };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  toastMockOnCloses.length = 0;
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. useToast outside provider → throws
// ToastContext is created with null as default; the guard in useToast() fires
// whenever context is null (i.e. no ToastProvider ancestor).
// ─────────────────────────────────────────────────────────────────────────────

describe('useToast — outside provider', () => {
  it('throws "useToast must be used within a ToastProvider"', () => {
    expect(() => {
      renderHook(() => useToast());
    }).toThrow('useToast must be used within a ToastProvider');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. API surface inside provider
// ─────────────────────────────────────────────────────────────────────────────

describe('useToast — API surface', () => {
  it('exposes exactly toast, success, error, info (all functions)', () => {
    const { getApi } = renderProvider();
    const api = getApi();
    expect(typeof api.toast).toBe('function');
    expect(typeof api.success).toBe('function');
    expect(typeof api.error).toBe('function');
    expect(typeof api.info).toBe('function');
  });

  it('does NOT expose dismiss or clear on the public context', () => {
    const { getApi } = renderProvider();
    const api = getApi();
    expect('dismiss' in api).toBe(false);
    expect('clear' in api).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Pushing toasts: DOM state reflects queue
// ─────────────────────────────────────────────────────────────────────────────

describe('ToastProvider — push adds toast to DOM', () => {
  it('initial render has no toast stubs in the DOM', () => {
    const { queryAllByTestId } = renderProvider();
    expect(queryAllByTestId('toast-stub')).toHaveLength(0);
  });

  it('toast() adds one stub node to the DOM', () => {
    const { getApi, getAllByTestId } = renderProvider();
    act(() => { getApi().toast('info', 'hello'); });
    expect(getAllByTestId('toast-stub')).toHaveLength(1);
  });

  it('three sequential pushes produce three stub nodes (FIFO, no dedup)', () => {
    const { getApi, getAllByTestId } = renderProvider();
    act(() => {
      getApi().toast('info', 'one');
      getApi().toast('success', 'two');
      getApi().toast('error', 'three');
    });
    expect(getAllByTestId('toast-stub')).toHaveLength(3);
  });

  it('pushing identical messages twice produces two separate stubs', () => {
    const { getApi, getAllByTestId } = renderProvider();
    act(() => {
      getApi().toast('info', 'dup');
      getApi().toast('info', 'dup');
    });
    expect(getAllByTestId('toast-stub')).toHaveLength(2);
  });

  it('no max-toasts cap: 10 pushes → 10 stub nodes', () => {
    const { getApi, getAllByTestId } = renderProvider();
    act(() => {
      for (let i = 0; i < 10; i++) {
        getApi().toast('info', `msg-${i}`);
      }
    });
    expect(getAllByTestId('toast-stub')).toHaveLength(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Variant and message propagation to Toast stub
// ─────────────────────────────────────────────────────────────────────────────

describe('ToastProvider — variant and message propagation', () => {
  it('toast("success", msg) → stub carries data-variant="success"', () => {
    const { getApi, getByTestId } = renderProvider();
    act(() => { getApi().toast('success', 'ok'); });
    expect(getByTestId('toast-stub').getAttribute('data-variant')).toBe('success');
  });

  it('toast("error", msg) → stub carries data-variant="error"', () => {
    const { getApi, getByTestId } = renderProvider();
    act(() => { getApi().toast('error', 'fail'); });
    expect(getByTestId('toast-stub').getAttribute('data-variant')).toBe('error');
  });

  it('toast("info", msg) → stub carries data-variant="info"', () => {
    const { getApi, getByTestId } = renderProvider();
    act(() => { getApi().toast('info', 'note'); });
    expect(getByTestId('toast-stub').getAttribute('data-variant')).toBe('info');
  });

  it('message text is forwarded to the stub via data-message', () => {
    const { getApi, getByTestId } = renderProvider();
    act(() => { getApi().toast('info', 'my-test-message'); });
    expect(getByTestId('toast-stub').getAttribute('data-message')).toBe('my-test-message');
  });

  it('FIFO order: first push renders first in DOM order', () => {
    const { getApi, getAllByTestId } = renderProvider();
    act(() => {
      getApi().toast('info', 'alpha');
      getApi().toast('info', 'beta');
    });
    const stubs = getAllByTestId('toast-stub');
    expect(stubs[0].getAttribute('data-message')).toBe('alpha');
    expect(stubs[1].getAttribute('data-message')).toBe('beta');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Shorthand helpers — variant delegation
// ─────────────────────────────────────────────────────────────────────────────

describe('useToast — shorthand helpers delegate variant', () => {
  it('success(msg) renders a stub with variant="success"', () => {
    const { getApi, getByTestId } = renderProvider();
    act(() => { getApi().success('great'); });
    expect(getByTestId('toast-stub').getAttribute('data-variant')).toBe('success');
    expect(getByTestId('toast-stub').getAttribute('data-message')).toBe('great');
  });

  it('error(msg) renders a stub with variant="error"', () => {
    const { getApi, getByTestId } = renderProvider();
    act(() => { getApi().error('bad'); });
    expect(getByTestId('toast-stub').getAttribute('data-variant')).toBe('error');
    expect(getByTestId('toast-stub').getAttribute('data-message')).toBe('bad');
  });

  it('info(msg) renders a stub with variant="info"', () => {
    const { getApi, getByTestId } = renderProvider();
    act(() => { getApi().info('neutral'); });
    expect(getByTestId('toast-stub').getAttribute('data-variant')).toBe('info');
    expect(getByTestId('toast-stub').getAttribute('data-message')).toBe('neutral');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Remove / dismiss — via onClose callback
// ─────────────────────────────────────────────────────────────────────────────

describe('ToastProvider — remove via onClose', () => {
  it('calling onClose of first toast removes it from the DOM', () => {
    const { getApi, queryAllByTestId } = renderProvider();
    act(() => { getApi().toast('info', 'removable'); });
    expect(queryAllByTestId('toast-stub')).toHaveLength(1);
    // The mock captured the onClose when it mounted:
    act(() => { toastMockOnCloses[toastMockOnCloses.length - 1](); });
    expect(queryAllByTestId('toast-stub')).toHaveLength(0);
  });

  it('dismissing middle toast of three leaves the other two', () => {
    const { getApi, queryAllByTestId, getAllByTestId } = renderProvider();
    act(() => {
      getApi().toast('info', 'first');
      getApi().toast('info', 'second');
      getApi().toast('info', 'third');
    });
    expect(queryAllByTestId('toast-stub')).toHaveLength(3);
    // onClose for the second toast was the 2nd captured:
    const secondOnClose = toastMockOnCloses[1];
    act(() => { secondOnClose(); });
    const remaining = getAllByTestId('toast-stub');
    expect(remaining).toHaveLength(2);
    expect(remaining[0].getAttribute('data-message')).toBe('first');
    expect(remaining[1].getAttribute('data-message')).toBe('third');
  });

  it('dismissing all toasts one-by-one clears the DOM', () => {
    const { getApi, queryAllByTestId } = renderProvider();
    act(() => {
      getApi().toast('info', 'a');
      getApi().toast('info', 'b');
      getApi().toast('info', 'c');
    });
    expect(queryAllByTestId('toast-stub')).toHaveLength(3);
    // Dismiss in reverse order (last → first):
    act(() => { toastMockOnCloses[2](); });
    expect(queryAllByTestId('toast-stub')).toHaveLength(2);
    act(() => { toastMockOnCloses[1](); });
    expect(queryAllByTestId('toast-stub')).toHaveLength(1);
    act(() => { toastMockOnCloses[0](); });
    expect(queryAllByTestId('toast-stub')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. ID uniqueness (integer counter, not uuid)
// ─────────────────────────────────────────────────────────────────────────────

describe('ToastProvider — ID uniqueness (module-level counter)', () => {
  it('dismissing by id removes only that toast (unique IDs guaranteed)', () => {
    // Push two toasts with the same message but distinct IDs.
    // If IDs were NOT unique, both would be removed by one onClose call.
    const { getApi, queryAllByTestId } = renderProvider();
    act(() => {
      getApi().toast('info', 'same-msg');
      getApi().toast('info', 'same-msg');
    });
    expect(queryAllByTestId('toast-stub')).toHaveLength(2);
    // Dismiss only the first one:
    act(() => { toastMockOnCloses[toastMockOnCloses.length - 2](); });
    // Only one remains — proves IDs are unique (filter(t => t.id !== id)
    // removed exactly one entry):
    expect(queryAllByTestId('toast-stub')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Referential stability (useCallback)
// ─────────────────────────────────────────────────────────────────────────────

describe('useToast — referential stability across re-renders', () => {
  it('toast, success, error, info refs are stable after state update', () => {
    const { getApi } = renderProvider();
    const api = getApi();
    const first = {
      toast: api.toast,
      success: api.success,
      error: api.error,
      info: api.info,
    };

    // Trigger a state update (adds a toast → re-renders provider):
    act(() => { api.toast('info', 'trigger-rerender'); });

    // After re-render, re-read the api (consumer re-rendered too):
    const second = getApi();
    expect(second.toast).toBe(first.toast);
    expect(second.success).toBe(first.success);
    expect(second.error).toBe(first.error);
    expect(second.info).toBe(first.info);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Provider renders children alongside the toast stack
// ─────────────────────────────────────────────────────────────────────────────

describe('ToastProvider — children are rendered', () => {
  it('children passed to ToastProvider appear in the DOM', () => {
    const { getByTestId } = render(
      createElement(
        ToastProvider,
        null,
        createElement('span', { 'data-testid': 'child-node' }, 'content'),
      ),
    );
    expect(getByTestId('child-node').textContent).toBe('content');
  });

  it('children and toast stack coexist (consumer and stub side-by-side)', () => {
    let api: ReturnType<typeof useToast> | null = null;
    const Consumer: FC = () => {
      api = useToast();
      return createElement('span', { 'data-testid': 'consumer-2' });
    };
    const { getByTestId, queryAllByTestId } = render(
      createElement(ToastProvider, null, createElement(Consumer)),
    );
    expect(getByTestId('consumer-2').dataset.testid).toBe('consumer-2');
    act(() => { api!.toast('success', 'side-by-side'); });
    // Consumer still in DOM after toast push + toast stub added by provider:
    expect(getByTestId('consumer-2').dataset.testid).toBe('consumer-2');
    expect(queryAllByTestId('toast-stub')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. All three variants accepted without error
// ─────────────────────────────────────────────────────────────────────────────

describe('ToastProvider — all variant values accepted', () => {
  it('all three variant literals produce stubs with correct data-variant', () => {
    const { getApi, getAllByTestId } = renderProvider();
    act(() => {
      getApi().toast('success', 's');
      getApi().toast('error', 'e');
      getApi().toast('info', 'i');
    });
    const stubs = getAllByTestId('toast-stub');
    expect(stubs).toHaveLength(3);
    const variants = stubs.map(s => s.getAttribute('data-variant'));
    expect(variants).toEqual(['success', 'error', 'info']);
  });
});
