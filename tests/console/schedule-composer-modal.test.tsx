/**
 * ScheduleComposerModal — open/close, create/edit/template modes, field editing,
 * validation gating, save success+error paths, cancel/Escape, cron recurrence.
 *
 * SOURCE SURPRISES (pinned):
 *  1. isEditing = !!editMessage && editMessage.id > 0 — id:-1 template mode
 *     renders as "Schedule Message" (create), not "Edit Scheduled Message".
 *  2. No react-query inside this component — no invalidateQueries; caller owns that.
 *     onCreated() + onClose() are the only side-effect callbacks on success.
 *  3. Future-time validation: scheduledAt must be > Date.now()/1000.
 *     Tests that need the save path to succeed must supply a far-future datetime.
 *  4. ChatPicker is stubbed to expose a `Select Chat` button and a `Clear Chat` button.
 *  5. contentType toggle is two explicit buttons ("Text"/"Media"), not a checkbox.
 *  6. recurrence is a 4-segment row ("Once"/"Daily"/"Weekly"/"Cron"); Cron reveals a
 *     free-text input + cronToHuman preview (Phase A DateTimePicker primitive).
 *  7. cronToHuman preview appears only when Cron is the active segment and the cron
 *     expr is non-empty.
 *  8. Backdrop pointerdown does NOT dismiss — dismissable=false (C-B3W2-2 inversion).
 *     Previously backdrop click called onClose; now protected by the Modal primitive.
 *  9. Escape key calls onClose when modal is open (stack-aware capture-phase handler
 *     from useDismissable, replacing the legacy hand-rolled bubble-phase effect).
 * 10. mediaPath required for media content type; empty mediaPath blocks submit.
 * 11. caption is optional in media mode.
 * 12. body.scheduled_at uses snake_case (matching MCP backend convention).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'

// ---------------------------------------------------------------------------
// Mocks — must precede dynamic imports
// ---------------------------------------------------------------------------

vi.mock('../../console/src/lib/api', () => ({
  api: {
    createScheduled: vi.fn(),
    updateScheduled: vi.fn(),
  },
}))

// Stub ChatPicker: exposes a "Select Chat" button and a "Clear Chat" button so
// tests can drive selection without simulating mouse-event dropdown interactions.
vi.mock('../../console/src/components/shared/ChatPicker', () => ({
  ChatPicker: ({
    chats,
    onSelect,
    onClear,
    selected,
    placeholder,
  }: {
    chats: { conversationKey: string; name: string }[]
    onSelect: (c: { conversationKey: string; name: string }) => void
    onClear: () => void
    selected: { conversationKey: string; name: string } | null
    placeholder?: string
  }) => (
    <div data-testid="chat-picker" data-placeholder={placeholder}>
      {selected
        ? (
          <>
            <span data-testid="selected-chat">{selected.name}</span>
            <button type="button" data-testid="clear-chat" onClick={onClear}>Clear Chat</button>
          </>
          )
        : chats.map(c => (
          <button
            key={c.conversationKey}
            type="button"
            data-testid={`select-chat-${c.conversationKey}`}
            onClick={() => onSelect(c)}
          >
            Select {c.name}
          </button>
        ))}
    </div>
  ),
}))

import { ScheduleComposerModal } from '../../console/src/components/line-detail/ScheduleComposerModal'
import { api } from '../../console/src/lib/api'
import type { ChatItem, ScheduledMessage } from '../../console/src/types'

// ---------------------------------------------------------------------------
// Typed mock handles
// ---------------------------------------------------------------------------

const createScheduledMock = api.createScheduled as unknown as ReturnType<typeof vi.fn>
const updateScheduledMock = api.updateScheduled as unknown as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LINE = 'test-line'

// 1555-prefix phone JID and short 9-digit group JID (hygiene-guard approved forms)
const CHAT_PERSONAL: ChatItem = {
  conversationKey: '15555550001@s.whatsapp.net',
  name: 'Alice',
  lastMessagePreview: '',
  lastMessageAt: '',
  unreadCount: 0,
  isGroup: false,
}

const CHAT_GROUP: ChatItem = {
  conversationKey: '120363001@g.us',
  name: 'Team Alpha',
  lastMessagePreview: '',
  lastMessageAt: '',
  unreadCount: 0,
  isGroup: true,
}

const CHATS: ChatItem[] = [CHAT_PERSONAL, CHAT_GROUP]

// Far-future unix timestamp: 2099-01-01T09:00 — safe for future-time validation
const FUTURE_TS = Math.floor(new Date('2099-01-01T09:00:00').getTime() / 1000)

// Corresponding datetime-local string for the input (same wall-clock instant)
function futureLocalString(): string {
  const d = new Date(FUTURE_TS * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

function makeScheduledMessage(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: 42,
    chatJid: '15555550001@s.whatsapp.net',
    chatName: 'Alice',
    contentType: 'text',
    payload: { text: 'hello world' },
    scheduledAt: FUTURE_TS,
    runCount: 0,
    status: 'pending',
    createdAt: 1_700_000_000,
    retryCount: 0,
    ...overrides,
  }
}

function makeToast(): ToastContextValue {
  return {
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
  }
}

let toastValue: ToastContextValue

function withToast(node: ReactElement) {
  return <ToastContext.Provider value={toastValue}>{node}</ToastContext.Provider>
}

function defaultProps(overrides: Partial<Parameters<typeof ScheduleComposerModal>[0]> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    onCreated: vi.fn(),
    lineName: LINE,
    chats: CHATS,
    ...overrides,
  }
}

beforeEach(() => {
  createScheduledMock.mockReset()
  updateScheduledMock.mockReset()
  toastValue = makeToast()
})

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
// 1. Closed state
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — closed state', () => {
  it('renders null when open=false', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps({ open: false })} />))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Schedule Message')).toBeNull()
    expect(screen.queryByText('Edit Scheduled Message')).toBeNull()
  })

  it('does not call api.createScheduled or api.updateScheduled when closed', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps({ open: false })} />))

    expect(createScheduledMock).not.toHaveBeenCalled()
    expect(updateScheduledMock).not.toHaveBeenCalled()
  })

  it('initial focus lands inside the dialog when opened (ChatPicker panel NOT auto-opened, §4.2)', () => {
    // useDismissable default focus: header close X (no initialFocus passed).
    // ChatPicker SearchInput onFocus auto-opens the panel — we must NOT land
    // focus there on open. Verify focus is inside the dialog but NOT on a chat item.
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    // Chat picker panel must NOT be open (no listbox rendered)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Create mode (no editMessage)
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — create mode', () => {
  it('renders the dialog with "Schedule Message" title when open with no editMessage', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByText('Schedule Message')).toBeDefined()
    expect(screen.queryByText('Edit Scheduled Message')).toBeNull()
  })

  it('shows "Schedule" (not "Update") on the submit button in create mode', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    // Button text is "Schedule" in create mode
    expect(screen.getByText('Schedule')).toBeDefined()
    expect(screen.queryByText('Update')).toBeNull()
  })

  it('chat picker starts empty and textarea starts blank', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    expect(screen.queryByTestId('selected-chat')).toBeNull()
    expect(screen.getByRole('textbox', { name: /Message text/i })).toBeDefined()
  })

  it('content type defaults to text and shows the message textarea', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    expect(screen.getByRole('textbox', { name: /Message text/i })).toBeDefined()
    expect(screen.queryByLabelText(/File path/i)).toBeNull()
  })

  it('recurrence defaults to Once (no cron input visible)', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    // Cron input is only visible when Cron segment is selected; Once is the default
    expect(screen.queryByPlaceholderText(/Cron expression/i)).toBeNull()
    // Verify Once button is present and pressed
    expect(screen.getByRole('button', { name: 'Once' })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 3. Edit mode (editMessage.id > 0)
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — edit mode (id > 0)', () => {
  const editMsg = makeScheduledMessage({
    id: 42,
    chatJid: '15555550001@s.whatsapp.net',
    chatName: 'Alice',
    contentType: 'text',
    payload: { text: 'original text' },
    scheduledAt: FUTURE_TS,
  })

  it('renders "Edit Scheduled Message" title when editMessage.id > 0', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: editMsg })} />))

    expect(screen.getByText('Edit Scheduled Message')).toBeDefined()
    expect(screen.queryByText('Schedule Message')).toBeNull()
  })

  it('shows "Update" on the submit button in edit mode', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: editMsg })} />))

    expect(screen.getByText('Update')).toBeDefined()
    expect(screen.queryByText('Schedule')).toBeNull()
  })

  it('pre-populates the message text from editMessage.payload.text', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: editMsg })} />))

    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe('original text')
  })

  it('pre-selects the chat that matches editMessage.chatJid via conversationKey', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: editMsg })} />))

    // ChatPicker stub renders selected-chat when a match is found
    const selected = screen.getByTestId('selected-chat')
    expect(selected.textContent).toBe('Alice')
  })

  it('pre-populates recurrence when editMessage.recurrence is the Weekly preset', () => {
    const recurringMsg = makeScheduledMessage({ recurrence: '0 9 * * 1' })
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: recurringMsg })} />))

    // Weekly segment should be active
    const weeklyBtn = screen.getByRole('button', { name: 'Weekly' })
    expect(weeklyBtn.getAttribute('aria-pressed')).toBe('true')
    // Cron input is hidden because Cron segment is not active
    expect(screen.queryByPlaceholderText(/Cron expression/i)).toBeNull()
  })

  it('pre-populates recurrence when editMessage.recurrence is the Daily preset', () => {
    const recurringMsg = makeScheduledMessage({ recurrence: '0 9 * * *' })
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: recurringMsg })} />))

    const dailyBtn = screen.getByRole('button', { name: 'Daily' })
    expect(dailyBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('pre-populates the Cron segment when editMessage.recurrence is a non-preset cron', () => {
    const recurringMsg = makeScheduledMessage({ recurrence: '*/30 * * * *' })
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: recurringMsg })} />))

    const cronBtn = screen.getByRole('button', { name: 'Cron' })
    expect(cronBtn.getAttribute('aria-pressed')).toBe('true')
    const cronInput = screen.getByPlaceholderText(/Cron expression/i) as HTMLInputElement
    expect(cronInput.value).toBe('*/30 * * * *')
  })

  it('leaves recurrence in Once when editMessage.recurrence is undefined', () => {
    const oneShot = makeScheduledMessage({ recurrence: undefined })
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: oneShot })} />))

    const onceBtn = screen.getByRole('button', { name: 'Once' })
    expect(onceBtn.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByPlaceholderText(/Cron expression/i)).toBeNull()
  })

  it('pre-selects media content type when editMessage.contentType is not "text"', () => {
    const mediaMsg = makeScheduledMessage({
      contentType: 'image',
      payload: { path: '/tmp/photo.jpg', caption: 'My photo' },
    })
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: mediaMsg })} />))

    // Media mode: file path input visible, message textarea hidden
    const pathInput = screen.getByLabelText(/File path/i) as HTMLInputElement
    expect(pathInput.value).toBe('/tmp/photo.jpg')
    const captionEl = screen.getByLabelText(/Caption/i) as HTMLTextAreaElement
    expect(captionEl.value).toBe('My photo')
    expect(screen.queryByRole('textbox', { name: /Message text/i })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. id:-1 template mode (duplicate — create new from template)
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — id:-1 template mode', () => {
  // ScheduledTab passes { ...original, id: -1 } to signal "create new, not edit".
  // isEditing = !!editMessage && editMessage.id > 0 → false when id=-1.
  const templateMsg = makeScheduledMessage({
    id: -1,
    chatJid: '15555550001@s.whatsapp.net',
    chatName: 'Alice',
    contentType: 'text',
    payload: { text: 'template text' },
    scheduledAt: FUTURE_TS,
  })

  it('renders "Schedule Message" title when editMessage.id === -1 (template create)', () => {
    // SOURCE SURPRISE: id=-1 evaluates id > 0 as false, so isEditing=false.
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: templateMsg })} />))

    expect(screen.getByText('Schedule Message')).toBeDefined()
    expect(screen.queryByText('Edit Scheduled Message')).toBeNull()
  })

  it('shows "Schedule" button (not "Update") for id:-1 template mode', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: templateMsg })} />))

    expect(screen.getByText('Schedule')).toBeDefined()
    expect(screen.queryByText('Update')).toBeNull()
  })

  it('pre-populates fields from the template message in id:-1 mode', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: templateMsg })} />))

    // Chat should be pre-selected (fields preserved from original)
    expect(screen.getByTestId('selected-chat').textContent).toBe('Alice')
    // Text should be pre-populated
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe('template text')
  })

  it('calls api.createScheduled (not updateScheduled) when saving in id:-1 mode', async () => {
    createScheduledMock.mockResolvedValue({})
    const onCreated = vi.fn()
    const onClose = vi.fn()

    render(withToast(
      <ScheduleComposerModal
        {...defaultProps({ editMessage: templateMsg, onCreated, onClose })}
      />,
    ))

    // Schedule time input must be far-future; set it explicitly to bypass past-time validation
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Schedule$/i }))
    })

    await waitFor(() => {
      expect(createScheduledMock).toHaveBeenCalledTimes(1)
    })
    expect(updateScheduledMock).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Field editing
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — field editing', () => {
  it('updates textarea value on change', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'new message text' } })
    expect(textarea.value).toBe('new message text')
  })

  it('routes composer fields through form-control primitives', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    const text = screen.getByRole('textbox', { name: /Message text/i })
    const scheduledTime = screen.getByLabelText(/Scheduled time/i)

    expect(text.className).toContain('c-input')
    expect(text.className).toContain('font-mono')
    expect(scheduledTime.className).toContain('c-input')
    expect(scheduledTime.className).toContain('font-mono')

    fireEvent.click(screen.getByRole('button', { name: /Media/i }))
    const path = screen.getByLabelText(/File path/i)
    const caption = screen.getByLabelText(/Caption/i)

    expect(path.className).toContain('c-input')
    expect(path.className).toContain('font-mono')
    expect(caption.className).toContain('c-input')
    expect(caption.className).toContain('font-mono')

    // Open Cron segment — the free-text cron input routes through TextInput
    fireEvent.click(screen.getByRole('button', { name: 'Cron' }))
    const cron = screen.getByPlaceholderText(/Cron expression/i)

    expect(cron.className).toContain('c-input')
    expect(cron.className).toContain('font-mono')
  })

  it('switches to media content type when "Media" button is clicked', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByRole('button', { name: /Media/i }))

    expect(screen.getByLabelText(/File path/i)).toBeDefined()
    expect(screen.queryByRole('textbox', { name: /Message text/i })).toBeNull()
  })

  it('switches back to text content type when "Text" button is clicked', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByRole('button', { name: /Media/i }))
    fireEvent.click(screen.getByRole('button', { name: /Text/i }))

    expect(screen.getByRole('textbox', { name: /Message text/i })).toBeDefined()
    expect(screen.queryByLabelText(/File path/i)).toBeNull()
  })

  it('shows cron input when the "Cron" segment is clicked', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByRole('button', { name: 'Cron' }))

    expect(screen.getByPlaceholderText(/Cron expression/i)).toBeDefined()
  })

  it('hides cron input when the "Once" segment is clicked after opening Cron', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByRole('button', { name: 'Cron' }))
    fireEvent.click(screen.getByRole('button', { name: 'Once' }))

    expect(screen.queryByPlaceholderText(/Cron expression/i)).toBeNull()
  })

  it('updates cron expression input value', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByRole('button', { name: 'Cron' }))
    const cronInput = screen.getByPlaceholderText(/Cron expression/i) as HTMLInputElement
    fireEvent.change(cronInput, { target: { value: '*/30 * * * *' } })
    expect(cronInput.value).toBe('*/30 * * * *')
  })

  it('selects Daily preset via the Daily segment (no separate preset button)', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByRole('button', { name: 'Daily' }))

    // Daily segment is pressed; cron input stays hidden (Daily carries its preset implicitly)
    expect(screen.getByRole('button', { name: 'Daily' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByPlaceholderText(/Cron expression/i)).toBeNull()
  })

  it('selects Weekly preset via the Weekly segment', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }))

    expect(screen.getByRole('button', { name: 'Weekly' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByPlaceholderText(/Cron expression/i)).toBeNull()
  })

  it('shows a cron preview when Cron segment is active and expr is non-empty', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByRole('button', { name: 'Cron' }))
    // Default seed cron is '0 9 * * *' (Daily at 09:00)
    expect(screen.getByText(/Daily at/i)).toBeDefined()
  })

  it('selects a chat via the picker stub', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    expect(screen.getByTestId('selected-chat').textContent).toBe('Alice')
  })

  it('clears the selected chat when Clear Chat is clicked', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    expect(screen.getByTestId('selected-chat')).toBeDefined()

    fireEvent.click(screen.getByTestId('clear-chat'))
    expect(screen.queryByTestId('selected-chat')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5a. ToolbarTimeRange segmented control pins (DD-15, C-B3W2-4)
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — segmented control aria contract', () => {
  it('content-type seg: role="group" with accessible label "Content type"', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    const contentTypeGroup = screen.getByRole('group', { name: 'Content type' })
    const buttons = within(contentTypeGroup).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Text', 'Media'])
  })

  it('content-type seg: Text button is aria-pressed=true by default', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    const textBtn = screen.getByRole('button', { name: 'Text' })
    expect(textBtn.getAttribute('aria-pressed')).toBe('true')
    const mediaBtn = screen.getByRole('button', { name: 'Media' })
    expect(mediaBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('content-type seg: exactly one button pressed after switching to Media', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByRole('button', { name: 'Media' }))

    expect(screen.getByRole('button', { name: 'Media' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Text' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('recurrence seg: role="group" with accessible label "Recurrence"', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    const recurGroup = screen.getByRole('group', { name: 'Recurrence' })
    const buttons = within(recurGroup).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Once', 'Daily', 'Weekly', 'Cron'])
  })

  it('recurrence seg: Once is aria-pressed=true by default', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    const onceBtn = screen.getByRole('button', { name: 'Once' })
    expect(onceBtn.getAttribute('aria-pressed')).toBe('true')
    const dailyBtn = screen.getByRole('button', { name: 'Daily' })
    expect(dailyBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('recurrence seg: exactly one button pressed after switching to Cron', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByRole('button', { name: 'Cron' }))

    expect(screen.getByRole('button', { name: 'Cron' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Once' }).getAttribute('aria-pressed')).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// 6. Validation gating
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — validation gating', () => {
  it('blocks submit and does not call api when no chat is selected (button disabled)', async () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    // The submit button carries disabled={!selectedChat} — jsdom respects this and the
    // click handler never fires.  The "no chat selected" guard inside handleSubmit is
    // defensive code that cannot be reached via the UI when the button is disabled.
    // Verify the button is disabled and the API is never called.
    const submitBtn = screen.getByText('Schedule').closest('button') as HTMLButtonElement
    expect(submitBtn.disabled).toBe(true)

    await act(async () => {
      fireEvent.click(submitBtn)
    })

    expect(createScheduledMock).not.toHaveBeenCalled()
    expect(toastValue.error).not.toHaveBeenCalled()
  })

  it('blocks submit and toasts "Message text is required" when text is blank', async () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    // Set far-future datetime
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })
    // Leave text blank (default empty)

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    expect(createScheduledMock).not.toHaveBeenCalled()
    expect(toastValue.error).toHaveBeenCalledWith('Message text is required')
  })

  it('blocks submit and toasts "File path is required" when media mode has blank path', async () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    fireEvent.click(screen.getByRole('button', { name: /Media/i }))
    // Leave media path blank
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    expect(createScheduledMock).not.toHaveBeenCalled()
    expect(toastValue.error).toHaveBeenCalledWith('File path is required')
  })

  it('blocks submit and toasts future-time error when scheduled time is in the past', async () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello' } })

    // Set an obviously past datetime
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: '2020-01-01T00:00' } })

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    expect(createScheduledMock).not.toHaveBeenCalled()
    expect(toastValue.error).toHaveBeenCalledWith('Scheduled time must be in the future')
  })

  it('submit button is disabled when no chat is selected (disabled attribute)', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    // The submit button has disabled={submitting || !selectedChat}
    const submitBtn = screen.getByText('Schedule').closest('button') as HTMLButtonElement
    expect(submitBtn.disabled).toBe(true)
  })

  it('submit button becomes enabled once a chat is selected', () => {
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))

    const submitBtn = screen.getByText('Schedule').closest('button') as HTMLButtonElement
    expect(submitBtn.disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. Save success — create path
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — save success (create)', () => {
  async function renderAndSaveText() {
    createScheduledMock.mockResolvedValue({})
    const onCreated = vi.fn()
    const onClose = vi.fn()

    render(withToast(
      <ScheduleComposerModal
        {...defaultProps({ onCreated, onClose })}
      />,
    ))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'test message' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      expect(createScheduledMock).toHaveBeenCalledTimes(1)
    })

    return { onCreated, onClose }
  }

  it('calls api.createScheduled with chatJid, chatName, scheduled_at (snake_case), and text', async () => {
    const { onCreated } = await renderAndSaveText()

    const [callLine, callBody] = createScheduledMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(callLine).toBe(LINE)
    expect(callBody.chatJid).toBe(CHAT_PERSONAL.conversationKey)
    expect(callBody.chatName).toBe(CHAT_PERSONAL.name)
    expect(callBody.text).toBe('test message')
    // SOURCE SURPRISE: body key is scheduled_at (snake_case), not scheduledAt
    expect(typeof callBody.scheduled_at).toBe('number')
    expect((callBody.scheduled_at as number)).toBeGreaterThan(Math.floor(Date.now() / 1000))
    // onCreated must be called on success
    expect(onCreated).toHaveBeenCalledTimes(1)
  })

  it('calls onClose after successful create', async () => {
    const { onClose } = await renderAndSaveText()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('toasts "Message scheduled" on successful create', async () => {
    await renderAndSaveText()
    expect(toastValue.success).toHaveBeenCalledWith('Message scheduled')
  })

  it('includes recurrence field in body when Daily segment is selected', async () => {
    createScheduledMock.mockResolvedValue({})
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'recurring test' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }))

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      expect(createScheduledMock).toHaveBeenCalledTimes(1)
    })

    const [, callBody] = createScheduledMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(callBody.recurrence).toBe('0 9 * * *')
    // #1067: a recurring schedule pins the browser's IANA timezone.
    expect(callBody.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it('includes recurrence field in body when Weekly segment is selected', async () => {
    createScheduledMock.mockResolvedValue({})
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'weekly test' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }))

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      expect(createScheduledMock).toHaveBeenCalledTimes(1)
    })

    const [, callBody] = createScheduledMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(callBody.recurrence).toBe('0 9 * * 1')
  })

  it('includes recurrence field in body when Cron segment is selected with custom expr', async () => {
    createScheduledMock.mockResolvedValue({})
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'cron test' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })
    fireEvent.click(screen.getByRole('button', { name: 'Cron' }))
    const cronInput = screen.getByPlaceholderText(/Cron expression/i) as HTMLInputElement
    fireEvent.change(cronInput, { target: { value: '*/30 * * * *' } })

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      expect(createScheduledMock).toHaveBeenCalledTimes(1)
    })

    const [, callBody] = createScheduledMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(callBody.recurrence).toBe('*/30 * * * *')
  })

  it('does not include recurrence in body when one-shot mode', async () => {
    createScheduledMock.mockResolvedValue({})
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'one-shot msg' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      expect(createScheduledMock).toHaveBeenCalledTimes(1)
    })

    const [, callBody] = createScheduledMock.mock.calls[0] as [string, Record<string, unknown>]
    // recurrence must be absent; text must be present to confirm the right branch executed
    expect(Object.keys(callBody)).not.toContain('recurrence')
    // #1067: timezone is only pinned for recurring schedules — absent for one-shots.
    expect(Object.keys(callBody)).not.toContain('timezone')
    expect(typeof callBody.text).toBe('string')
  })

  it('sends filePath and optional caption in body when media content type', async () => {
    createScheduledMock.mockResolvedValue({})
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    fireEvent.click(screen.getByRole('button', { name: /Media/i }))
    const pathInput = screen.getByLabelText(/File path/i) as HTMLInputElement
    fireEvent.change(pathInput, { target: { value: '/tmp/image.jpg' } })
    const captionEl = screen.getByLabelText(/Caption/i) as HTMLTextAreaElement
    fireEvent.change(captionEl, { target: { value: 'my caption' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      expect(createScheduledMock).toHaveBeenCalledTimes(1)
    })

    const [, callBody] = createScheduledMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(callBody.filePath).toBe('/tmp/image.jpg')
    expect(callBody.caption).toBe('my caption')
    // text must be absent in media mode — filePath is the content field instead
    expect(Object.keys(callBody)).not.toContain('text')
  })

  it('omits caption from body when caption is blank in media mode', async () => {
    createScheduledMock.mockResolvedValue({})
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    fireEvent.click(screen.getByRole('button', { name: /Media/i }))
    const pathInput = screen.getByLabelText(/File path/i) as HTMLInputElement
    fireEvent.change(pathInput, { target: { value: '/tmp/video.mp4' } })
    // Leave caption blank
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      expect(createScheduledMock).toHaveBeenCalledTimes(1)
    })

    const [, callBody] = createScheduledMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(callBody.filePath).toBe('/tmp/video.mp4')
    // caption must be absent when blank; filePath confirms the media branch ran
    expect(Object.keys(callBody)).not.toContain('caption')
  })

  it('uses the group JID as chatJid when a group chat is selected', async () => {
    createScheduledMock.mockResolvedValue({})
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_GROUP.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'group message' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      expect(createScheduledMock).toHaveBeenCalledTimes(1)
    })

    const [, callBody] = createScheduledMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(callBody.chatJid).toBe('120363001@g.us')
    expect(callBody.chatName).toBe('Team Alpha')
  })
})

// ---------------------------------------------------------------------------
// 8. Save success — edit path
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — save success (edit)', () => {
  const editMsg = makeScheduledMessage({ id: 42 })

  it('calls api.updateScheduled with lineName, editMessage.id, and body on save', async () => {
    updateScheduledMock.mockResolvedValue({})
    const onCreated = vi.fn()
    const onClose = vi.fn()

    render(withToast(
      <ScheduleComposerModal
        {...defaultProps({ editMessage: editMsg, onCreated, onClose })}
      />,
    ))

    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByText('Update'))
    })

    await waitFor(() => {
      expect(updateScheduledMock).toHaveBeenCalledTimes(1)
    })
    const [callLine, callId, callBody] = updateScheduledMock.mock.calls[0] as [string, number, Record<string, unknown>]
    expect(callLine).toBe(LINE)
    expect(callId).toBe(42)
    expect(callBody.chatJid).toBe(CHAT_PERSONAL.conversationKey)
    expect(createScheduledMock).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('toasts "Scheduled message updated" on successful update', async () => {
    updateScheduledMock.mockResolvedValue({})
    render(withToast(<ScheduleComposerModal {...defaultProps({ editMessage: editMsg })} />))

    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByText('Update'))
    })

    await waitFor(() => {
      expect(toastValue.success).toHaveBeenCalledWith('Scheduled message updated')
    })
  })
})

// ---------------------------------------------------------------------------
// 9. Save error path
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — save error path', () => {
  it('toasts the error message and does not call onCreated or onClose on create failure', async () => {
    createScheduledMock.mockRejectedValue(new Error('network down'))
    const onCreated = vi.fn()
    const onClose = vi.fn()

    render(withToast(
      <ScheduleComposerModal {...defaultProps({ onCreated, onClose })} />,
    ))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'will fail' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      expect(toastValue.error).toHaveBeenCalledWith('Failed: network down')
    })
    expect(onCreated).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stringifies non-Error rejections in the error toast', async () => {
    createScheduledMock.mockRejectedValue('plain string error')
    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'will fail' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    await act(async () => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      expect(toastValue.error).toHaveBeenCalledWith('Failed: plain string error')
    })
  })

  it('shows "Saving..." during submission and restores button text after error', async () => {
    let resolveReject: (reason: Error) => void = () => {}
    createScheduledMock.mockReturnValue(
      new Promise<never>((_, reject) => { resolveReject = reject }),
    )

    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'in flight' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    act(() => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    // While the promise is pending the button shows "Saving..."
    await waitFor(() => {
      expect(screen.getByText('Saving...')).toBeDefined()
    })

    // Resolve the rejection so the test can clean up
    await act(async () => {
      resolveReject(new Error('timed out'))
    })

    await waitFor(() => {
      expect(screen.getByText('Schedule')).toBeDefined()
    })
  })
})

// ---------------------------------------------------------------------------
// 10. Cancel / close paths
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — cancel and close', () => {
  it('calls onClose when the Cancel button is clicked', () => {
    const onClose = vi.fn()
    render(withToast(<ScheduleComposerModal {...defaultProps({ onClose })} />))

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the X (close icon) button is clicked', () => {
    const onClose = vi.fn()
    render(withToast(<ScheduleComposerModal {...defaultProps({ onClose })} />))

    // ModalHeader renders the close button with label 'Close dialog'
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the Escape key is pressed while the modal is open', () => {
    const onClose = vi.fn()
    render(withToast(<ScheduleComposerModal {...defaultProps({ onClose })} />))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onClose on Escape when the modal is closed (listener not attached)', () => {
    const onClose = vi.fn()
    render(withToast(<ScheduleComposerModal {...defaultProps({ open: false, onClose })} />))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('backdrop pointerdown does NOT dismiss (dismissable=false, C-B3W2-2)', () => {
    // C-B3W2-2: inverted assertion — form dialogs use the protective default.
    // Previously backdrop click destroyed eight fields of state (no recovery).
    const onClose = vi.fn()
    render(withToast(<ScheduleComposerModal {...defaultProps({ onClose })} />))

    // Modal portals to body; backdrop is document.querySelector
    const backdrop = document.querySelector('.soup-modal-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.pointerDown(backdrop as Element)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does NOT call onClose when pointerdown is inside the dialog panel', () => {
    // stopPropagation mechanism replaced by useDismissable pointerdown semantics
    const onClose = vi.fn()
    render(withToast(<ScheduleComposerModal {...defaultProps({ onClose })} />))

    const dialog = screen.getByRole('dialog')
    fireEvent.pointerDown(dialog)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Cancel button is disabled while submitting', async () => {
    let resolve: (v: unknown) => void = () => {}
    createScheduledMock.mockReturnValue(new Promise(r => { resolve = r }))

    render(withToast(<ScheduleComposerModal {...defaultProps()} />))

    fireEvent.click(screen.getByTestId(`select-chat-${CHAT_PERSONAL.conversationKey}`))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'test' } })
    const dtInput = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement
    fireEvent.change(dtInput, { target: { value: futureLocalString() } })

    act(() => {
      fireEvent.click(screen.getByText('Schedule'))
    })

    await waitFor(() => {
      const cancelBtn = screen.getByRole('button', { name: /Cancel/i }) as HTMLButtonElement
      expect(cancelBtn.disabled).toBe(true)
    })

    // Clean up
    await act(async () => { resolve({}) })
  })
})

// ---------------------------------------------------------------------------
// 11. Reset behavior when modal reopens
// ---------------------------------------------------------------------------

describe('ScheduleComposerModal — state reset on reopen', () => {
  it('resets fields to blank when reopened after close without editMessage', () => {
    const { rerender } = render(
      withToast(<ScheduleComposerModal {...defaultProps({ open: false })} />),
    )

    // Open with text entered
    rerender(withToast(<ScheduleComposerModal {...defaultProps({ open: true })} />))
    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'dirty value' } })

    // Close and reopen
    rerender(withToast(<ScheduleComposerModal {...defaultProps({ open: false })} />))
    rerender(withToast(<ScheduleComposerModal {...defaultProps({ open: true })} />))

    const freshTextarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    expect(freshTextarea.value).toBe('')
    expect(screen.queryByTestId('selected-chat')).toBeNull()
  })

  it('populates fields from a new editMessage when reopened in edit mode', () => {
    const { rerender } = render(
      withToast(<ScheduleComposerModal {...defaultProps({ open: false })} />),
    )

    const editMsg = makeScheduledMessage({ payload: { text: 'from edit' } })
    rerender(withToast(
      <ScheduleComposerModal {...defaultProps({ open: true, editMessage: editMsg })} />,
    ))

    const textarea = screen.getByRole('textbox', { name: /Message text/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe('from edit')
  })
})
