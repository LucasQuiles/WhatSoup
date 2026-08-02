/**
 * GroupDetailModal - query states, info edits, participant actions, settings, and close affordances.
 *
 * Superset suite: combines main's functional coverage with the soup-v3 design
 * branch's accessibility/token-class assertions (C-B3W3 / DD-44):
 *   - aria-labelledby resolves to explicit id group-detail-dialog-title
 *   - backdrop pointerdown does NOT dismiss (dismissable=false, fresh pin)
 *   - nested Leave-confirm Escape ordering (confirm first, then modal)
 *   - tablist roving tabindex (ArrowRight focuses without selecting, Enter selects)
 *   - tabpanel aria-labelledby wiring
 *   - settings seg pairs: aria-label, exactly-one aria-pressed, disabled-while-saving
 *   - subject/description/select token classes (c-input, c-select, font-mono)
 *   - tab reset to Info on group change
 *
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context.js'
import type { ContactResult, GroupDetail, GroupInfo } from '../../console/src/types.js'

// ---- Mocks ----

const getGroupDetailMock = vi.fn()
const getGroupInviteLinkMock = vi.fn()
const leaveGroupMock = vi.fn()
const revokeGroupInviteMock = vi.fn()
const updateGroupDescriptionMock = vi.fn()
const updateGroupEphemeralMock = vi.fn()
const updateGroupJoinApprovalMock = vi.fn()
const updateGroupMemberAddModeMock = vi.fn()
const updateGroupParticipantsMock = vi.fn()
const updateGroupSettingsMock = vi.fn()
const updateGroupSubjectMock = vi.fn()

vi.mock('../../console/src/lib/api.js', () => ({
  api: {
    getGroupDetail: (...args: unknown[]) => getGroupDetailMock(...args),
    getGroupInviteLink: (...args: unknown[]) => getGroupInviteLinkMock(...args),
    leaveGroup: (...args: unknown[]) => leaveGroupMock(...args),
    revokeGroupInvite: (...args: unknown[]) => revokeGroupInviteMock(...args),
    updateGroupDescription: (...args: unknown[]) => updateGroupDescriptionMock(...args),
    updateGroupEphemeral: (...args: unknown[]) => updateGroupEphemeralMock(...args),
    updateGroupJoinApproval: (...args: unknown[]) => updateGroupJoinApprovalMock(...args),
    updateGroupMemberAddMode: (...args: unknown[]) => updateGroupMemberAddModeMock(...args),
    updateGroupParticipants: (...args: unknown[]) => updateGroupParticipantsMock(...args),
    updateGroupSettings: (...args: unknown[]) => updateGroupSettingsMock(...args),
    updateGroupSubject: (...args: unknown[]) => updateGroupSubjectMock(...args),
  },
}))

const addedContact: ContactResult = {
  jid: '1555000444@s.whatsapp.net',
  name: 'New Member',
  notify: 'New Member',
  number: '1555000444',
}

vi.mock('../../console/src/components/shared/ContactSearchPicker.js', () => ({
  ContactSearchPicker: ({
    selected,
    onAdd,
    onRemove,
    placeholder,
  }: {
    selected: ContactResult[]
    onAdd: (contact: ContactResult) => void
    onRemove: (jid: string) => void
    placeholder?: string
  }) => (
    <div data-testid="contact-picker">
      <span>{placeholder}</span>
      {selected.map(contact => (
        <button key={contact.jid} type="button" onClick={() => onRemove(contact.jid)}>
          remove {contact.name ?? contact.jid}
        </button>
      ))}
      <button type="button" onClick={() => onAdd(addedContact)}>
        add mocked contact
      </button>
    </div>
  ),
}))

// Import after mocks so the component picks up the mocked API and child component.
import { GroupDetailModal } from '../../console/src/components/line-detail/GroupDetailModal.js'

// ---- Helpers ----

interface ToastSpies extends ToastContextValue {
  success: Mock<ToastContextValue['success']>
  error: Mock<ToastContextValue['error']>
  info: Mock<ToastContextValue['info']>
  toast: Mock<ToastContextValue['toast']>
  dismiss: Mock<ToastContextValue['dismiss']>
  clear: Mock<ToastContextValue['clear']>
}

const groupId = '1555000001@g.us'
const lineName = 'line-a'
const currentUserJid = '1555000111@s.whatsapp.net'
const ownerJid = '1555000000@s.whatsapp.net'
const memberJid = '1555000222@s.whatsapp.net'
const pendingJid = '1555000333@s.whatsapp.net'

function makeGroup(overrides: Partial<GroupInfo> = {}): GroupInfo {
  return {
    id: groupId,
    subject: 'Team Atlas',
    desc: 'Launch coordination',
    creation: 1704067200,
    participants: [
      { id: currentUserJid, admin: 'admin' },
      { id: ownerJid, admin: 'superadmin' },
      { id: memberJid },
    ],
    ...overrides,
  }
}

function makeDetail(overrides: Partial<GroupDetail> = {}): GroupDetail {
  return {
    ...makeGroup(),
    inviteLink: 'https://chat.whatsapp.com/example-invite',
    announce: false,
    locked: false,
    ephemeralDuration: 0,
    memberAddMode: 'all_member_add',
    joinApprovalMode: 'off',
    pendingRequests: [{ jid: pendingJid }],
    ...overrides,
  }
}

function makeToast(): ToastSpies {
  return {
    success: vi.fn<ToastContextValue['success']>(),
    error: vi.fn<ToastContextValue['error']>(),
    info: vi.fn<ToastContextValue['info']>(),
    toast: vi.fn<ToastContextValue['toast']>(),
    dismiss: vi.fn<ToastContextValue['dismiss']>(),
    clear: vi.fn<ToastContextValue['clear']>(),
  }
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function Wrap({
  client,
  toast,
  children,
}: {
  client: QueryClient
  toast: ToastSpies
  children: ReactNode
}) {
  return (
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toast}>{children}</ToastContext.Provider>
    </QueryClientProvider>
  )
}

function renderModal({
  client = makeClient(),
  detail = makeDetail(),
  group = makeGroup(),
  myJid = currentUserJid,
  onClose = vi.fn(),
  toast = makeToast(),
}: {
  client?: QueryClient
  detail?: GroupDetail
  group?: GroupInfo | null
  myJid?: string
  onClose?: Mock
  toast?: ToastSpies
} = {}) {
  getGroupDetailMock.mockResolvedValue(detail)
  const rendered = render(
    <Wrap client={client} toast={toast}>
      <GroupDetailModal open group={group} lineName={lineName} myJid={myJid} onClose={onClose} />
    </Wrap>,
  )
  return { ...rendered, client, onClose, toast }
}

function confirmDialog(title: string): HTMLElement {
  return screen.getByText(title).closest('[role="dialog"]') as HTMLElement
}

async function waitForDetail() {
  await waitFor(() => {
    expect(getGroupDetailMock).toHaveBeenCalledWith(lineName, groupId)
  })
  expect(await screen.findByDisplayValue('Team Atlas')).toBeDefined()
}

beforeEach(() => {
  getGroupDetailMock.mockResolvedValue(makeDetail())
  getGroupInviteLinkMock.mockResolvedValue({
    jid: groupId,
    inviteCode: 'new-code',
    inviteLink: 'https://chat.whatsapp.com/new-link',
  })
  leaveGroupMock.mockResolvedValue({ success: true })
  revokeGroupInviteMock.mockResolvedValue({ inviteCode: 'rotated' })
  updateGroupDescriptionMock.mockResolvedValue({ success: true })
  updateGroupEphemeralMock.mockResolvedValue({ success: true })
  updateGroupJoinApprovalMock.mockResolvedValue({ success: true })
  updateGroupMemberAddModeMock.mockResolvedValue({ success: true })
  updateGroupParticipantsMock.mockResolvedValue({ success: true })
  updateGroupSettingsMock.mockResolvedValue({ success: true })
  updateGroupSubjectMock.mockResolvedValue({ success: true })

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  cleanup()
  getGroupDetailMock.mockReset()
  getGroupInviteLinkMock.mockReset()
  leaveGroupMock.mockReset()
  revokeGroupInviteMock.mockReset()
  updateGroupDescriptionMock.mockReset()
  updateGroupEphemeralMock.mockReset()
  updateGroupJoinApprovalMock.mockReset()
  updateGroupMemberAddModeMock.mockReset()
  updateGroupParticipantsMock.mockReset()
  updateGroupSettingsMock.mockReset()
  updateGroupSubjectMock.mockReset()
})

describe('GroupDetailModal query and shell states', () => {
  it('renders nothing and does not query when the modal is closed or group is missing', () => {
    const toast = makeToast()
    const onClose = vi.fn()

    const { rerender, container } = render(
      <Wrap client={makeClient()} toast={toast}>
        <GroupDetailModal open={false} group={makeGroup()} lineName={lineName} myJid={currentUserJid} onClose={onClose} />
      </Wrap>,
    )

    expect(container.firstChild).toBeNull()
    expect(getGroupDetailMock).not.toHaveBeenCalled()

    rerender(
      <Wrap client={makeClient()} toast={toast}>
        <GroupDetailModal open group={null} lineName={lineName} myJid={currentUserJid} onClose={onClose} />
      </Wrap>,
    )

    expect(container.firstChild).toBeNull()
    expect(getGroupDetailMock).not.toHaveBeenCalled()
  })

  it('shows a failed query state with retry support', async () => {
    getGroupDetailMock
      .mockRejectedValueOnce(new Error('socket down'))
      .mockResolvedValueOnce(makeDetail())

    renderModal()

    expect(await screen.findByText('Failed to load group')).toBeDefined()
    expect(screen.getByText('socket down')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByDisplayValue('Team Atlas')).toBeDefined()
    expect(getGroupDetailMock).toHaveBeenCalledTimes(2)
  })

  it('loads details, marks the current user, and closes on Escape', async () => {
    const { onClose } = renderModal()

    await waitForDetail()
    expect(screen.getByRole('dialog', { name: 'Team Atlas' })).toBeDefined()
    expect(screen.getByText('3 participants')).toBeDefined()
    expect(screen.getByText('Launch coordination')).toBeDefined()
    expect(screen.getByText(groupId)).toBeDefined()

    fireEvent.click(screen.getByRole('tab', { name: 'Participants' }))

    expect(screen.getByText('(you)')).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('aria-labelledby resolves to the element with id group-detail-dialog-title', async () => {
    renderModal()
    const dialog = await screen.findByRole('dialog')
    const labelledById = dialog.getAttribute('aria-labelledby')
    expect(labelledById).toBeTruthy()
    const titleEl = document.getElementById(labelledById!)
    expect(titleEl).not.toBeNull()
    // The subject text is the label
    expect(titleEl!.textContent).toBe('Team Atlas')
    // The id is explicitly group-detail-dialog-title (preserved via labelledById prop, C-B3W3-4)
    expect(labelledById).toBe('group-detail-dialog-title')
  })

  it('does NOT close on backdrop pointerdown (dismissable=false, fresh pin)', async () => {
    const { onClose } = renderModal()
    const dialog = await screen.findByRole('dialog')
    const backdrop = dialog.parentElement!
    fireEvent.pointerDown(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when the X (Close dialog) button is clicked', async () => {
    const { onClose } = renderModal()
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('GroupDetailModal info actions', () => {
  it('skips unchanged saves and restores fields after save failures', async () => {
    const { toast } = renderModal()
    await waitForDetail()

    fireEvent.blur(screen.getByDisplayValue('Team Atlas'))
    fireEvent.blur(screen.getByDisplayValue('Launch coordination'))

    expect(updateGroupSubjectMock).not.toHaveBeenCalled()
    expect(updateGroupDescriptionMock).not.toHaveBeenCalled()

    updateGroupSubjectMock.mockRejectedValueOnce(new Error('subject denied'))
    fireEvent.change(screen.getByDisplayValue('Team Atlas'), { target: { value: 'Denied Subject' } })
    fireEvent.blur(screen.getByDisplayValue('Denied Subject'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed: subject denied')
    })
    expect(screen.getByDisplayValue('Team Atlas')).toBeDefined()

    updateGroupDescriptionMock.mockRejectedValueOnce(new Error('description denied'))
    fireEvent.change(screen.getByDisplayValue('Launch coordination'), { target: { value: 'Denied description' } })
    fireEvent.blur(screen.getByDisplayValue('Denied description'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed: description denied')
    })
    expect(screen.getByDisplayValue('Launch coordination')).toBeDefined()
  })

  it('saves subject and empty description edits through the group API', async () => {
    const { toast } = renderModal()
    await waitForDetail()

    fireEvent.change(screen.getByDisplayValue('Team Atlas'), { target: { value: 'Team Atlas Prime' } })
    fireEvent.blur(screen.getByDisplayValue('Team Atlas Prime'))

    await waitFor(() => {
      expect(updateGroupSubjectMock).toHaveBeenCalledWith(lineName, groupId, 'Team Atlas Prime')
    })
    expect(toast.success).toHaveBeenCalledWith('Group subject updated')

    fireEvent.change(screen.getByDisplayValue('Launch coordination'), { target: { value: '' } })
    fireEvent.blur(screen.getByPlaceholderText('Group description...'))

    await waitFor(() => {
      expect(updateGroupDescriptionMock).toHaveBeenCalledWith(lineName, groupId, undefined)
    })
    expect(toast.success).toHaveBeenCalledWith('Description updated')
  })

  it('labels the editable subject and description fields with form-control token classes', async () => {
    renderModal()
    await waitForDetail()

    const subject = screen.getByLabelText('Subject') as HTMLInputElement
    expect(subject.className).toContain('c-input')
    expect(subject.className).toContain('font-mono')

    const description = screen.getByLabelText('Description') as HTMLTextAreaElement
    expect(description.className).toContain('c-input')
    expect(description.className).toContain('font-mono')
  })

  it('copies and revokes an existing invite link', async () => {
    const { toast } = renderModal()
    await waitForDetail()

    fireEvent.click(screen.getByRole('button', { name: /Copy/ }))

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://chat.whatsapp.com/example-invite')
    })
    expect(toast.success).toHaveBeenCalledWith('Invite link copied')

    fireEvent.click(screen.getByRole('button', { name: /Revoke/ }))
    fireEvent.click(within(confirmDialog('Revoke invite link?')).getByRole('button', { name: 'Revoke' }))

    await waitFor(() => {
      expect(revokeGroupInviteMock).toHaveBeenCalledWith(lineName, groupId)
    })
    expect(toast.success).toHaveBeenCalledWith('Invite link revoked')
  })

  it('guards the copy button against an insecure context (no clipboard API)', async () => {
    const { toast } = renderModal()
    await waitForDetail()

    const writeText = navigator.clipboard.writeText as Mock
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })

    fireEvent.click(screen.getByRole('button', { name: /Copy/ }))

    expect(toast.error).toHaveBeenCalledWith('Clipboard unavailable (insecure context)')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('reports invite revocation failures', async () => {
    const { toast } = renderModal()
    await waitForDetail()

    revokeGroupInviteMock.mockRejectedValueOnce(new Error('revoke denied'))
    fireEvent.click(screen.getByRole('button', { name: /Revoke/ }))
    fireEvent.click(within(confirmDialog('Revoke invite link?')).getByRole('button', { name: 'Revoke' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Revoke failed: revoke denied')
    })
  })

  it('fetches a missing invite link', async () => {
    const { toast } = renderModal({ detail: makeDetail({ inviteLink: undefined }) })
    await waitForDetail()

    fireEvent.click(screen.getByRole('button', { name: /Fetch invite link/ }))

    await waitFor(() => {
      expect(getGroupInviteLinkMock).toHaveBeenCalledWith(lineName, groupId)
    })
    expect(await screen.findByText('https://chat.whatsapp.com/new-link')).toBeDefined()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports invite-link fetch failures', async () => {
    const { toast } = renderModal({ detail: makeDetail({ inviteLink: undefined }) })
    await waitForDetail()

    getGroupInviteLinkMock.mockRejectedValueOnce(new Error('invite unavailable'))
    fireEvent.click(screen.getByRole('button', { name: /Fetch invite link/ }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed: invite unavailable')
    })
  })
})

describe('GroupDetailModal participant actions', () => {
  it('adds selected contacts, approves requests, promotes members, and removes participants', async () => {
    const { toast } = renderModal()
    await waitForDetail()

    fireEvent.click(screen.getByRole('tab', { name: 'Participants' }))
    fireEvent.click(screen.getByRole('button', { name: 'add mocked contact' }))
    fireEvent.click(screen.getByRole('button', { name: /Add 1/ }))

    await waitFor(() => {
      expect(updateGroupParticipantsMock).toHaveBeenCalledWith(lineName, groupId, [addedContact.jid], 'add')
    })
    expect(toast.success).toHaveBeenCalledWith('Added 1 participant')

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => {
      expect(updateGroupParticipantsMock).toHaveBeenCalledWith(lineName, groupId, [pendingJid], 'add')
    })

    fireEvent.click(screen.getByTitle('Promote to admin'))
    await waitFor(() => {
      expect(updateGroupParticipantsMock).toHaveBeenCalledWith(lineName, groupId, [memberJid], 'promote')
    })

    const memberRow = screen.getByText(memberJid).closest('div') as HTMLElement
    fireEvent.click(within(memberRow).getByTitle('Remove participant'))
    fireEvent.click(within(confirmDialog(`Remove ${memberJid}?`)).getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(updateGroupParticipantsMock).toHaveBeenCalledWith(lineName, groupId, [memberJid], 'remove')
    })
  })

  it('rejects requests and demotes admins through participant mutations', async () => {
    const { toast } = renderModal()
    await waitForDetail()

    fireEvent.click(screen.getByRole('tab', { name: 'Participants' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))

    await waitFor(() => {
      expect(updateGroupParticipantsMock).toHaveBeenCalledWith(lineName, groupId, [pendingJid], 'remove')
    })
    expect(toast.success).toHaveBeenCalledWith(`Rejected ${pendingJid}`)

    fireEvent.click(screen.getAllByTitle('Demote')[0])
    await waitFor(() => {
      expect(updateGroupParticipantsMock).toHaveBeenCalledWith(lineName, groupId, [ownerJid], 'demote')
    })
  })

  it('filters participant rows and surfaces participant action errors', async () => {
    const { toast } = renderModal()
    await waitForDetail()

    fireEvent.click(screen.getByRole('tab', { name: 'Participants' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search 3 participants' }), {
      target: { value: ownerJid },
    })

    expect(screen.getByText(ownerJid)).toBeDefined()
    expect(screen.queryByText(memberJid)).toBeNull()

    updateGroupParticipantsMock.mockRejectedValueOnce(new Error('promotion denied'))
    fireEvent.click(screen.getByTitle('Demote'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed: promotion denied')
    })
  })
})

describe('GroupDetailModal settings actions', () => {
  it('updates group settings and leaves the group with query invalidation', async () => {
    const client = makeClient()
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
    const { onClose, toast } = renderModal({ client })
    await waitForDetail()

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Admins only' })[0])

    await waitFor(() => {
      expect(updateGroupSettingsMock).toHaveBeenCalledWith(lineName, groupId, 'announcement')
    })
    expect(toast.success).toHaveBeenCalledWith('Setting updated')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '86400' } })
    await waitFor(() => {
      expect(updateGroupEphemeralMock).toHaveBeenCalledWith(lineName, groupId, 86400)
    })

    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    await waitFor(() => {
      expect(updateGroupJoinApprovalMock).toHaveBeenCalledWith(lineName, groupId, 'on')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Leave group' }))
    fireEvent.click(within(confirmDialog('Leave group?')).getByRole('button', { name: 'Leave' }))

    await waitFor(() => {
      expect(leaveGroupMock).toHaveBeenCalledWith(lineName, groupId)
    })
    expect(toast.success).toHaveBeenCalledWith('Left group')
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['groups', lineName] })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('updates secondary settings and supports cancelling the leave confirmation', async () => {
    renderModal()
    await waitForDetail()

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Admins only' })[1])

    await waitFor(() => {
      expect(updateGroupSettingsMock).toHaveBeenCalledWith(lineName, groupId, 'locked')
    })

    fireEvent.click(screen.getAllByRole('button', { name: 'Admins only' })[2])
    await waitFor(() => {
      expect(updateGroupMemberAddModeMock).toHaveBeenCalledWith(lineName, groupId, 'admin_add')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => {
      expect(updateGroupJoinApprovalMock).toHaveBeenCalledWith(lineName, groupId, 'off')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Leave group' }))
    fireEvent.click(within(confirmDialog('Leave group?')).getByRole('button', { name: 'Cancel' }))

    expect(leaveGroupMock).not.toHaveBeenCalled()
  })

  it('reports settings mutation failures', async () => {
    const { toast } = renderModal()
    await waitForDetail()

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    updateGroupSettingsMock.mockRejectedValueOnce(new Error('settings denied'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Admins only' })[0])

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed: settings denied')
    })
  })

  it('renders non-admin details without privileged controls', async () => {
    renderModal({
      myJid: memberJid,
      detail: makeDetail({
        desc: undefined,
        participants: [
          { id: currentUserJid, admin: 'admin' },
          { id: memberJid },
        ],
      }),
      group: makeGroup({
        desc: undefined,
        participants: [
          { id: currentUserJid, admin: 'admin' },
          { id: memberJid },
        ],
      }),
    })
    await waitFor(() => {
      expect(getGroupDetailMock).toHaveBeenCalledWith(lineName, groupId)
    })
    expect(await screen.findByText('Team Atlas')).toBeDefined()
    expect(screen.getByText('No description')).toBeDefined()

    expect(screen.queryByPlaceholderText('Group description...')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Participants' }))
    expect(screen.queryByText('Add participants')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(screen.queryByRole('button', { name: 'Admins only' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Leave group' })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Accessibility / token-class assertions folded in from the soup-v3 design
// branch (C-B3W3 / DD-44). These cover behaviours main's functional suite
// does not assert: stack-aware Escape ordering, tablist roving-tabindex,
// tabpanel aria wiring, seg-pair aria-pressed/disabled, and form-control
// token classes.
// ---------------------------------------------------------------------------

describe('GroupDetailModal nested confirm Escape ordering', () => {
  it('Escape with Leave confirm open closes only the confirm, second Escape closes modal', async () => {
    const { onClose } = renderModal()
    await waitForDetail()

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Leave group' }))

    // Leave confirm dialog should now be open
    await waitFor(() => expect(screen.getByText('Leave group?')).toBeDefined())

    // First Escape — closes the confirm dialog only
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Leave group?')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()

    // Second Escape — closes the modal
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('GroupDetailModal tablist (roving tabindex)', () => {
  it('renders a labelled tablist with Info, Participants, and Settings tabs', async () => {
    renderModal()
    await waitForDetail()
    const tablist = screen.getByRole('tablist')
    expect(tablist.getAttribute('aria-label')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Info/i })).toBeDefined()
    expect(screen.getByRole('tab', { name: /Participants/i })).toBeDefined()
    expect(screen.getByRole('tab', { name: /Settings/i })).toBeDefined()
  })

  it('Info tab is selected by default (aria-selected=true)', async () => {
    renderModal()
    await waitForDetail()
    const infoTab = screen.getByRole('tab', { name: /Info/i })
    expect(infoTab.getAttribute('aria-selected')).toBe('true')
  })

  it('ArrowRight moves focus to the next tab without selecting it (manual activation)', async () => {
    renderModal()
    await waitForDetail()
    const infoTab = screen.getByRole('tab', { name: /Info/i })
    const participantsTab = screen.getByRole('tab', { name: /Participants/i })
    infoTab.focus()
    fireEvent.keyDown(infoTab, { key: 'ArrowRight' })
    // Info remains selected; focus moves to Participants under the roving model
    expect(infoTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(participantsTab)
  })

  it('Enter on the focused tab selects it (manual activation)', async () => {
    renderModal()
    await waitForDetail()
    const infoTab = screen.getByRole('tab', { name: /Info/i })
    const participantsTab = screen.getByRole('tab', { name: /Participants/i })
    infoTab.focus()
    fireEvent.keyDown(infoTab, { key: 'ArrowRight' })
    fireEvent.keyDown(participantsTab, { key: 'Enter' })
    expect(participantsTab.getAttribute('aria-selected')).toBe('true')
  })

  it('selected tabpanel has correct aria-labelledby wiring', async () => {
    renderModal()
    await waitForDetail()
    const infoTab = screen.getByRole('tab', { name: /Info/i })
    const controlsId = infoTab.getAttribute('aria-controls')
    expect(controlsId).toBeTruthy()
    const panel = document.getElementById(controlsId!)
    expect(panel).not.toBeNull()
    expect(panel!.getAttribute('aria-labelledby')).toBe(infoTab.id)
  })

  it('resets to the Info tab when the group prop changes', async () => {
    const { rerender, client, toast } = renderModal()
    await waitForDetail()

    const participantsTab = screen.getByRole('tab', { name: /Participants/i })
    fireEvent.click(participantsTab)
    fireEvent.keyDown(participantsTab, { key: 'Enter' })
    await waitFor(() => expect(participantsTab.getAttribute('aria-selected')).toBe('true'))

    const newGroup = makeGroup({ id: '1555000002@g.us', subject: 'Team Beta' })
    getGroupDetailMock.mockResolvedValue(makeDetail({ id: newGroup.id, subject: 'Team Beta' }))

    rerender(
      <Wrap client={client} toast={toast}>
        <GroupDetailModal open group={newGroup} lineName={lineName} myJid={currentUserJid} onClose={vi.fn()} />
      </Wrap>,
    )

    await waitFor(() => {
      const infoTab = screen.getByRole('tab', { name: /Info/i })
      expect(infoTab.getAttribute('aria-selected')).toBe('true')
    })
  })
})

describe('GroupDetailModal settings seg pairs', () => {
  async function openSettingsAsAdmin() {
    const ctx = renderModal({ myJid: currentUserJid })
    await waitForDetail()
    fireEvent.click(screen.getByRole('tab', { name: /Settings/i }))
    await waitFor(() => expect(screen.getByRole('group', { name: 'Messaging' })).toBeDefined())
    return ctx
  }

  it('the Messaging seg group exposes an aria-label', async () => {
    await openSettingsAsAdmin()
    const group = screen.getByRole('group', { name: 'Messaging' })
    expect(group.getAttribute('aria-label')).toBe('Messaging')
  })

  it('exactly one button per seg pair has aria-pressed=true', async () => {
    await openSettingsAsAdmin()
    const messagingGroup = screen.getByRole('group', { name: 'Messaging' })
    const btns = Array.from(messagingGroup.querySelectorAll('button'))
    const pressed = btns.filter(b => b.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
  })

  it('seg buttons are disabled while a save is in-flight (double-fire protection)', async () => {
    updateGroupSettingsMock.mockReturnValue(new Promise(() => {}))
    await openSettingsAsAdmin()

    const messagingGroup = screen.getByRole('group', { name: 'Messaging' })
    const btns = Array.from(messagingGroup.querySelectorAll('button')) as HTMLButtonElement[]
    const unpressed = btns.find(b => b.getAttribute('aria-pressed') === 'false')!
    fireEvent.click(unpressed)

    await waitFor(() => {
      const freshBtns = Array.from(messagingGroup.querySelectorAll('button')) as HTMLButtonElement[]
      expect(freshBtns.every(b => b.disabled)).toBe(true)
    })
  })

  it('the disappearing-messages select uses form-control token classes', async () => {
    await openSettingsAsAdmin()

    const select = screen.getByRole('combobox', { name: 'Disappearing messages' }) as HTMLSelectElement
    expect(select.className).toContain('c-input')
    expect(select.className).toContain('c-select')
    expect(select.className).not.toContain('c-btn')

    fireEvent.change(select, { target: { value: '86400' } })
    await waitFor(() => {
      expect(updateGroupEphemeralMock).toHaveBeenCalledWith(lineName, groupId, 86400)
    })
  })
})
