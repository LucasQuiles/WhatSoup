/** @vitest-environment jsdom */
/**
 * InlineEdit primitive contract (showcase §17): a dashed-underline button
 * (display mode) that swaps to a TextInput on activation. Enter commits via
 * onCommit (awaiting promises, busy during), Esc and blur cancel (revert,
 * no onCommit), validate blocks invalid input and surfaces an error, an
 * unchanged value exits without committing, empty values show emptyText,
 * and disabled blocks entry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InlineEdit } from '../../console/src/components/primitives';

afterEach(() => cleanup());

function enterEdit(label: string) {
  fireEvent.click(screen.getByRole('button', { name: `Edit ${label}` }));
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe('InlineEdit — display/edit toggle', () => {
  it('renders a button showing the value with an Edit <label> aria-name', () => {
    render(<InlineEdit value="support-eu" onCommit={() => {}} label="Line name" />);
    const btn = screen.getByRole('button', { name: 'Edit Line name' });
    expect(btn).toBeDefined();
    expect(btn.textContent).toContain('support-eu');
  });

  it('switches to a labelled text input on click and back on cancel', () => {
    render(<InlineEdit value="support-eu" onCommit={() => {}} label="Line name" />);
    const input = enterEdit('Line name');
    expect(input).toBeDefined();
    expect(input.value).toBe('support-eu');
  });
});

describe('InlineEdit — commit / cancel semantics', () => {
  it('calls onCommit with the new value on Enter and returns to display', async () => {
    const onCommit = vi.fn();
    render(<InlineEdit value="old" onCommit={onCommit} label="x" />);
    const input = enterEdit('x');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('new');
    // onCommit is awaited even when sync, so the return to display is async.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit x' })).toBeDefined();
    });
  });

  it('Esc reverts the draft and does NOT call onCommit', () => {
    const onCommit = vi.fn();
    render(<InlineEdit value="old" onCommit={onCommit} label="x" />);
    const input = enterEdit('x');
    fireEvent.change(input, { target: { value: 'discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
    const btn = screen.getByRole('button', { name: 'Edit x' });
    expect(btn.textContent).toContain('old');
  });

  it('blur cancels (reverts) without calling onCommit', () => {
    const onCommit = vi.fn();
    render(<InlineEdit value="kept" onCommit={onCommit} label="x" />);
    const input = enterEdit('x');
    fireEvent.change(input, { target: { value: 'lost' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit x' }).textContent).toContain('kept');
  });

  it('an unchanged value on Enter exits without calling onCommit', () => {
    const onCommit = vi.fn();
    render(<InlineEdit value="same" onCommit={onCommit} label="x" />);
    const input = enterEdit('x');
    // no change to draft
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit x' })).toBeDefined();
  });
});

describe('InlineEdit — validation', () => {
  it('blocks commit when validate returns a message, shows the error, stays in edit mode', () => {
    const onCommit = vi.fn();
    const validate = (v: string) => (v.length < 3 ? 'Min 3 chars' : null);
    render(<InlineEdit value="abc" onCommit={onCommit} label="x" validate={validate} />);
    const input = enterEdit('x');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    // error surfaced + announced
    expect(screen.getByText('Min 3 chars')).toBeDefined();
    const errInput = screen.getByLabelText('x') as HTMLInputElement;
    expect(errInput.getAttribute('aria-invalid')).toBe('true');
    expect(errInput.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('accepts commit when validate returns null', () => {
    const onCommit = vi.fn();
    const validate = (v: string) => (v.length < 3 ? 'Min 3 chars' : null);
    render(<InlineEdit value="abc" onCommit={onCommit} label="x" validate={validate} />);
    const input = enterEdit('x');
    fireEvent.change(input, { target: { value: 'longenough' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('longenough');
  });
});

describe('InlineEdit — async onCommit', () => {
  it('disables the input while the promise is pending, then closes on resolve', async () => {
    let resolveCommit!: () => void;
    const onCommit = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveCommit = resolve;
      }),
    );
    render(<InlineEdit value="old" onCommit={onCommit} label="x" />);
    const input = enterEdit('x');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('new');
    // busy: input still mounted but disabled
    const busy = screen.getByLabelText('x') as HTMLInputElement;
    expect(busy.disabled).toBe(true);
    resolveCommit();
    await waitFor(() => {
      expect(screen.queryByLabelText('x')).toBeNull();
    });
    // Back to display mode. The displayed value is the controlled `value` prop,
    // which the parent updates after refetch; onCommit already carried 'new'.
    expect(screen.getByRole('button', { name: 'Edit x' })).toBeDefined();
  });

  it('stays in edit mode when onCommit rejects (caller toasts)', async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error('boom')));
    render(<InlineEdit value="old" onCommit={onCommit} label="x" />);
    const input = enterEdit('x');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    // input re-enabled, still in edit mode
    const stillEditing = screen.getByLabelText('x') as HTMLInputElement;
    expect(stillEditing.disabled).toBe(false);
  });
});

describe('InlineEdit — empty / disabled / a11y', () => {
  it('shows emptyText (default —) when the value is empty', () => {
    render(<InlineEdit value="" onCommit={() => {}} label="x" />);
    expect(screen.getByRole('button', { name: 'Edit x' }).textContent).toContain('—');
  });

  it('shows a custom emptyText when provided', () => {
    render(<InlineEdit value="" onCommit={() => {}} label="x" emptyText="(not set)" />);
    expect(screen.getByRole('button', { name: 'Edit x' }).textContent).toContain('(not set)');
  });

  it('blocks entry when disabled', () => {
    render(<InlineEdit value="v" onCommit={() => {}} label="x" disabled />);
    const btn = screen.getByRole('button', { name: 'Edit x' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    // still in display mode — no input
    expect(screen.queryByLabelText('x')).toBeNull();
  });

  it('button carries aria-label="Edit <label>" and the input carries aria-label=<label>', () => {
    render(<InlineEdit value="v" onCommit={() => {}} label="Fallback model" />);
    expect(screen.getByRole('button', { name: 'Edit Fallback model' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Fallback model' }));
    expect(screen.getByLabelText('Fallback model')).toBeDefined();
  });
});
