/**
 * ScheduledMessageRow — behavior coverage for console/src/components/line-detail/ScheduledMessageRow.tsx.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ScheduledMessage } from '../../console/src/types';

const { ScheduledMessageRow } = await import(
  '../../console/src/components/line-detail/ScheduledMessageRow'
);

function buildMessage(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: 42,
    chatJid: 'chat-placeholder-jid',
    chatName: 'Alice',
    contentType: 'text',
    payload: { text: 'Hello there' },
    scheduledAt: 1_700_000_000,
    runCount: 0,
    status: 'pending',
    createdAt: 1_699_000_000,
    retryCount: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ScheduledMessageRow', () => {
  it('renders text preview, chat name, and pending status badge with edit + cancel buttons', () => {
    const onCancel = vi.fn();
    const onEdit = vi.fn();
    const onDuplicate = vi.fn();
    render(
      <ScheduledMessageRow
        message={buildMessage()}
        onCancel={onCancel}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        cancelling={null}
      />,
    );

    expect(screen.getByText('Hello there')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByLabelText('Edit scheduled message')).toBeTruthy();
    expect(
      screen.getByLabelText(/Cancel scheduled message to Alice/),
    ).toBeTruthy();
    expect(screen.getByLabelText('Duplicate as new scheduled message')).toBeTruthy();
    // Non-recurring + no retries — no expand toggle.
    expect(screen.queryByLabelText(/Expand details|Collapse details/)).toBeNull();
  });

  it('truncates long text preview to 100 chars with ellipsis', () => {
    const longText = 'a'.repeat(150);
    render(
      <ScheduledMessageRow
        message={buildMessage({ payload: { text: longText } })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );
    const preview = screen.getByText(/a{97}\.\.\./);
    expect(preview).toBeTruthy();
    expect(preview.textContent!.length).toBe(100);
  });

  it('falls back to caption for image content and chatJid when chatName is missing', () => {
    render(
      <ScheduledMessageRow
        message={buildMessage({
          contentType: 'image',
          payload: { caption: 'Sunset photo' },
          chatName: undefined,
        })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );
    expect(screen.getByText('Sunset photo')).toBeTruthy();
    expect(screen.getByText('chat-placeholder-jid')).toBeTruthy();
  });

  it.each([
    ['owner\u202E@example.com', 'owner\\u202E@example.com'],
    ['owner\\u202E@example.com', 'owner\\\\u202E@example.com'],
  ])('renders a persisted destination as distinct safe visible and accessible text %#', (chatName, expected) => {
    render(
      <ScheduledMessageRow
        message={buildMessage({ chatName })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );

    const label = screen.getByText(expected);
    expect(label.getAttribute('title')).toBe(expected);
    expect(screen.getByLabelText(`Cancel scheduled message to ${expected}`)).toBeTruthy();
  });

  it('falls back to content type label when image has no caption', () => {
    render(
      <ScheduledMessageRow
        message={buildMessage({ contentType: 'image', payload: {} })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );
    expect(screen.getByText('Image')).toBeTruthy();
  });

  it('renders (no preview) sentinel for empty text payload', () => {
    render(
      <ScheduledMessageRow
        message={buildMessage({ payload: { text: '' } })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );
    expect(screen.getByText('(no preview)')).toBeTruthy();
  });

  it('shows recurrence pill and run count when message is recurring with prior runs', () => {
    render(
      <ScheduledMessageRow
        message={buildMessage({
          recurrence: '0 9 * * 1',
          runCount: 3,
          status: 'sent',
        })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );
    expect(screen.getByText(/Weekly on Monday at 09:00/)).toBeTruthy();
    expect(screen.getByText(/Sent 3×/)).toBeTruthy();
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.getByLabelText('Expand details')).toBeTruthy();
  });

  it('hides edit + cancel buttons for non-pending statuses but keeps duplicate', () => {
    for (const status of ['sent', 'failed', 'cancelled', 'processing'] as const) {
      render(
        <ScheduledMessageRow
          message={buildMessage({ status })}
          onCancel={vi.fn()}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          cancelling={null}
        />,
      );
      expect(screen.queryByLabelText('Edit scheduled message')).toBeNull();
      expect(screen.queryByLabelText(/Cancel scheduled message/)).toBeNull();
      expect(screen.getByLabelText('Duplicate as new scheduled message')).toBeTruthy();
      cleanup();
    }
  });

  it('renders error text only when status=failed and error is set', () => {
    const { rerender } = render(
      <ScheduledMessageRow
        message={buildMessage({ status: 'failed', error: 'Network down' })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );
    expect(screen.getByText('Network down')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();

    rerender(
      <ScheduledMessageRow
        message={buildMessage({ status: 'pending', error: 'Network down' })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );
    expect(screen.queryByText('Network down')).toBeNull();
  });

  it('fires onEdit, onCancel, and onDuplicate with the right payload when buttons clicked', () => {
    const onCancel = vi.fn();
    const onEdit = vi.fn();
    const onDuplicate = vi.fn();
    const msg = buildMessage();
    render(
      <ScheduledMessageRow
        message={msg}
        onCancel={onCancel}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        cancelling={null}
      />,
    );

    fireEvent.click(screen.getByLabelText('Edit scheduled message'));
    fireEvent.click(screen.getByLabelText(/Cancel scheduled message to Alice/));
    fireEvent.click(screen.getByLabelText('Duplicate as new scheduled message'));

    expect(onEdit).toHaveBeenCalledWith(msg);
    expect(onCancel).toHaveBeenCalledWith(42);
    expect(onDuplicate).toHaveBeenCalledWith(msg);
  });

  it('disables the cancel button and shows a spinner while cancelling this row', () => {
    const onCancel = vi.fn();
    render(
      <ScheduledMessageRow
        message={buildMessage()}
        onCancel={onCancel}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={42}
      />,
    );
    const cancelBtn = screen.getByLabelText(/Cancel scheduled message to Alice/) as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(true);
    expect(cancelBtn.querySelector('.animate-spin')).not.toBeNull();
  });

  it('does not disable cancel when a different row is mid-cancel', () => {
    render(
      <ScheduledMessageRow
        message={buildMessage()}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={99}
      />,
    );
    const cancelBtn = screen.getByLabelText(/Cancel scheduled message to Alice/) as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(false);
    expect(cancelBtn.querySelector('.animate-spin')).toBeNull();
  });

  it('toggles expanded details panel when chevron is clicked for recurring messages', () => {
    render(
      <ScheduledMessageRow
        message={buildMessage({
          recurrence: '*/15 * * * *',
          nextRunAt: 1_700_001_000,
          sentAt: 1_699_999_000,
          retryCount: 0,
          runCount: 1,
          status: 'sent',
        })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );
    expect(screen.queryByText(/Next run:/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand details'));
    expect(screen.getByText(/Next run:/)).toBeTruthy();
    expect(screen.getByText(/Last sent:/)).toBeTruthy();
    expect(screen.getByText('ID: 42')).toBeTruthy();
    expect(screen.getByText(/Created:/)).toBeTruthy();
    expect(screen.queryByText(/Retries:/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Collapse details'));
    expect(screen.queryByText(/Next run:/)).toBeNull();
  });

  it('shows expand toggle for non-recurring messages once retryCount > 0 and surfaces retries', () => {
    render(
      <ScheduledMessageRow
        message={buildMessage({
          status: 'failed',
          error: 'send failed',
          retryCount: 2,
        })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );
    const expandBtn = screen.getByLabelText('Expand details');
    fireEvent.click(expandBtn);
    expect(screen.getByText('Retries: 2')).toBeTruthy();
    expect(screen.getByText('ID: 42')).toBeTruthy();
    // No nextRunAt / sentAt set on this fixture.
    expect(screen.queryByText(/Next run:/)).toBeNull();
    expect(screen.queryByText(/Last sent:/)).toBeNull();
  });

  it('hides "Sent N×" until at least one run is recorded even for recurring messages', () => {
    render(
      <ScheduledMessageRow
        message={buildMessage({ recurrence: '0 9 * * *', runCount: 0 })}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        cancelling={null}
      />,
    );
    expect(screen.queryByText(/Sent \d+×/)).toBeNull();
    expect(screen.getByText(/Daily at 09:00/)).toBeTruthy();
  });
});
