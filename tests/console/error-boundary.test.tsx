/**
 * ErrorBoundary — behavior coverage via real React render in jsdom.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import ErrorBoundary from '../../console/src/components/ErrorBoundary';

afterEach(() => cleanup());

function Throw({ message }: { message: string }): never {
  throw new Error(message);
}

function Safe({ label }: { label: string }) {
  return <div data-testid="safe-child">{label}</div>;
}

describe('ErrorBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs caught render errors to console.error in dev; silence noise.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('renders children unchanged when no error is thrown', () => {
    const { getByTestId, queryByRole } = render(
      <ErrorBoundary>
        <Safe label="ok" />
      </ErrorBoundary>,
    );

    const child = getByTestId('safe-child');
    expect(child).not.toBeNull();
    expect(child.textContent).toBe('ok');
    expect(queryByRole('alert')).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('catches render-time errors and renders the EmptyState fallback with the error message', () => {
    const { getByRole, getByText } = render(
      <ErrorBoundary>
        <Throw message="kaboom" />
      </ErrorBoundary>,
    );

    const alert = getByRole('alert');
    expect(alert).not.toBeNull();
    expect(alert.className).toContain('flex-1');
    expect(getByText('This page crashed')).not.toBeNull();
    expect(getByText('kaboom')).not.toBeNull();

    // componentDidCatch logs through console.error with the expected prefix.
    const calls = errorSpy.mock.calls.map((args) => String(args[0] ?? ''));
    expect(calls.some((msg) => msg.includes('route render failed'))).toBe(true);
  });

  it('falls back to a generic description when the thrown error message is empty', () => {
    const { getByRole, getByText } = render(
      <ErrorBoundary>
        <Throw message="" />
      </ErrorBoundary>,
    );

    expect(getByRole('alert')).not.toBeNull();
    expect(getByText('An unexpected render error occurred.')).not.toBeNull();
  });

  it('stays in the error state across re-renders until handleRetry is invoked', () => {
    const { getByRole, queryByTestId, rerender } = render(
      <ErrorBoundary>
        <Throw message="boom" />
      </ErrorBoundary>,
    );

    expect(getByRole('alert')).not.toBeNull();
    expect(queryByTestId('safe-child')).toBeNull();

    // Re-render with healthy children — boundary remains in error state because
    // the state flag is sticky until the Retry button resets it.
    rerender(
      <ErrorBoundary>
        <Safe label="now-ok" />
      </ErrorBoundary>,
    );

    expect(getByRole('alert')).not.toBeNull();
    expect(queryByTestId('safe-child')).toBeNull();
  });

  it('recovers and renders children after the Retry button resets the boundary', () => {
    let shouldThrow = true;
    function Toggling() {
      if (shouldThrow) throw new Error('first-pass');
      return <div data-testid="safe-child">recovered</div>;
    }

    const { getByRole, getByText, queryByRole, getByTestId } = render(
      <ErrorBoundary>
        <Toggling />
      </ErrorBoundary>,
    );

    expect(getByRole('alert')).not.toBeNull();

    // Flip the underlying child to a healthy state, then click Retry.
    shouldThrow = false;
    fireEvent.click(getByText('Retry'));

    expect(queryByRole('alert')).toBeNull();
    const recovered = getByTestId('safe-child');
    expect(recovered).not.toBeNull();
    expect(recovered.textContent).toBe('recovered');
  });
});
