/** @vitest-environment jsdom */
/**
 * Regression (#1058): editing a scheduled message must not lose in-progress edits when the
 * `chats` array reference churns (refetchOnWindowFocus / unreadCount updates). The populate
 * effect is keyed on the open/editMessage identity via a ref, so a new chats reference does
 * not re-run the reset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context';
import { ScheduleComposerModal } from '../../console/src/components/line-detail/ScheduleComposerModal';
import type { ChatItem, ScheduledMessage } from '../../console/src/types';

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
};

function chat(conversationKey: string, name: string, unreadCount = 0): ChatItem {
  return {
    conversationKey,
    name,
    lastMessagePreview: 'hi',
    lastMessageAt: '2026-06-18T00:00:00Z',
    unreadCount,
    isGroup: false,
  };
}

function editMsg(text: string): ScheduledMessage {
  return {
    id: 42,
    chatJid: 'key-a',
    contentType: 'text',
    payload: { text },
    scheduledAt: 1_900_000_000,
    runCount: 0,
    status: 'pending',
    createdAt: 1_800_000_000,
    retryCount: 0,
  };
}

function renderModal(chats: ChatItem[], editMessage?: ScheduledMessage) {
  return render(
    <ToastContext.Provider value={toastValue}>
      <ScheduleComposerModal
        open
        onClose={vi.fn()}
        onCreated={vi.fn()}
        lineName="test-line"
        chats={chats}
        editMessage={editMessage}
      />
    </ToastContext.Provider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ScheduleComposerModal — edit preservation (#1058)', () => {
  it('keeps in-progress edits when the chats array reference changes', () => {
    const initialChats = [chat('key-a', 'Alice'), chat('key-b', 'Bob')];
    const { rerender } = renderModal(initialChats, editMsg('original draft'));

    const textarea = screen.getByPlaceholderText('Type your message...') as HTMLTextAreaElement;
    expect(textarea.value).toBe('original draft');

    // Operator edits the message.
    fireEvent.change(textarea, { target: { value: 'my in-progress edit' } });
    expect(textarea.value).toBe('my in-progress edit');

    // chats refetch churns the array reference (e.g. unreadCount bump) — new array, same modal/edit.
    const refreshedChats = [chat('key-a', 'Alice', 3), chat('key-b', 'Bob', 1)];
    rerender(
      <ToastContext.Provider value={toastValue}>
        <ScheduleComposerModal
          open
          onClose={vi.fn()}
          onCreated={vi.fn()}
          lineName="test-line"
          chats={refreshedChats}
          editMessage={editMsg('original draft')}
        />
      </ToastContext.Provider>,
    );

    // The edit must survive — not be reset back to 'original draft'.
    expect((screen.getByPlaceholderText('Type your message...') as HTMLTextAreaElement).value).toBe(
      'my in-progress edit',
    );
  });

  it('re-populates when a different edit target is opened', () => {
    const chats = [chat('key-a', 'Alice')];
    const { rerender } = renderModal(chats, editMsg('first message'));
    expect((screen.getByPlaceholderText('Type your message...') as HTMLTextAreaElement).value).toBe('first message');

    const other: ScheduledMessage = { ...editMsg('second message'), id: 99 };
    rerender(
      <ToastContext.Provider value={toastValue}>
        <ScheduleComposerModal
          open
          onClose={vi.fn()}
          onCreated={vi.fn()}
          lineName="test-line"
          chats={chats}
          editMessage={other}
        />
      </ToastContext.Provider>,
    );
    expect((screen.getByPlaceholderText('Type your message...') as HTMLTextAreaElement).value).toBe('second message');
  });
});
