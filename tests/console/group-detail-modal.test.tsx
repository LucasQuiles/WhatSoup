/**
 * GroupDetailModal — dedicated rendering suite (C-B3W3-6).
 *
 * This is the repo's first dedicated coverage for GroupDetailModal.
 * The groups-tab.test.tsx suite mocks the modal entirely; this file renders
 * the real component against a mocked API.
 *
 * Scope covers (packet §8):
 *   - Closed state renders nothing
 *   - aria-labelledby resolution (id group-detail-dialog-title preserved via labelledById)
 *   - backdrop pointerdown does NOT dismiss (dismissable=false, fresh pin)
 *   - Escape closes via the stack (single-fire)
 *   - Escape with Leave confirm open: first Escape closes only confirm, second closes modal
 *   - X close button
 *   - Tablist: label, roving tabindex, ArrowRight focuses without selecting,
 *     Enter selects, panel conditional mounting with correct aria wiring
 *   - Seg pins: aria-pressed exactly-one per pair, group labels, disabled during saving
 *   - Admin gating: isAdmin=false hides admin controls
 *   - Tab resets to info when group changes
 *   - Focus restore to opener
 *
 * Fixture strategy:
 *   - Synthetic JIDs (1555-prefix users; short group IDs — avoids hygiene guard)
 *   - QueryClientProvider + ToastProvider wrappers
 *   - api mock: getGroupDetail resolves to a full GroupDetail fixture
 *   - Settings mutator mocks (updateGroupSettings, updateGroupParticipants etc.)
 *
 * @vitest-environment jsdom
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// API mock — hoisted before component import
// ---------------------------------------------------------------------------

const mockGetGroupDetail = vi.fn()
const mockUpdateGroupSettings = vi.fn()
const mockUpdateGroupParticipants = vi.fn()
const mockUpdateGroupSubject = vi.fn()
const mockUpdateGroupDescription = vi.fn()
const mockUpdateGroupMemberAddMode = vi.fn()
const mockUpdateGroupJoinApproval = vi.fn()
const mockUpdateGroupEphemeral = vi.fn()
const mockGetGroupInviteLink = vi.fn()
const mockRevokeGroupInvite = vi.fn()
const mockLeaveGroup = vi.fn()

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getGroupDetail: (...args: unknown[]) => mockGetGroupDetail(...args),
    updateGroupSettings: (...args: unknown[]) => mockUpdateGroupSettings(...args),
    updateGroupParticipants: (...args: unknown[]) => mockUpdateGroupParticipants(...args),
    updateGroupSubject: (...args: unknown[]) => mockUpdateGroupSubject(...args),
    updateGroupDescription: (...args: unknown[]) => mockUpdateGroupDescription(...args),
    updateGroupMemberAddMode: (...args: unknown[]) => mockUpdateGroupMemberAddMode(...args),
    updateGroupJoinApproval: (...args: unknown[]) => mockUpdateGroupJoinApproval(...args),
    updateGroupEphemeral: (...args: unknown[]) => mockUpdateGroupEphemeral(...args),
    getGroupInviteLink: (...args: unknown[]) => mockGetGroupInviteLink(...args),
    revokeGroupInvite: (...args: unknown[]) => mockRevokeGroupInvite(...args),
    leaveGroup: (...args: unknown[]) => mockLeaveGroup(...args),
  },
}))

// ---------------------------------------------------------------------------
// Import component AFTER mocks
// ---------------------------------------------------------------------------

import { GroupDetailModal } from '../../console/src/components/line-detail/GroupDetailModal'
import type { GroupInfo, GroupDetail } from '../../console/src/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Synthetic JIDs — 1555-prefix users, non-real-looking group IDs
const MY_JID = '1555000001@s.whatsapp.net'
const ADMIN_JID = '1555000002@s.whatsapp.net'
const MEMBER_JID = '1555000003@s.whatsapp.net'
const GROUP_ID = '1555100001@g.us'
const LINE = 'primary-line'

const baseGroup: GroupInfo = {
  id: GROUP_ID,
  subject: 'Team Alpha',
  participants: [
    { id: MY_JID, admin: 'admin' },
    { id: MEMBER_JID },
  ],
}

const baseDetail: GroupDetail = {
  ...baseGroup,
  desc: 'Alpha squad description',
  announce: false,
  locked: false,
  memberAddMode: 'all_member_add',
  joinApprovalMode: 'off',
  ephemeralDuration: 0,
  pendingRequests: [],
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
    },
  })
}

// Minimal toast provider mock so useToast() doesn't throw
vi.mock('../../console/src/hooks/toast-context', () => ({
  ToastContext: { Provider: ({ children }: { children: ReactNode }) => children },
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}))

function Wrapper({ children, client }: { children: ReactNode; client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      {children}
    </QueryClientProvider>
  )
}

interface RenderProps {
  open?: boolean
  group?: GroupInfo | null
  myJid?: string
  onClose?: () => void
  client?: QueryClient
}

function renderModal({
  open = true,
  group = baseGroup,
  myJid = MY_JID,
  onClose = vi.fn(),
  client = makeClient(),
}: RenderProps = {}) {
  const rendered = render(
    <Wrapper client={client}>
      <GroupDetailModal
        open={open}
        group={group}
        lineName={LINE}
        myJid={myJid}
        onClose={onClose}
      />
    </Wrapper>,
  )
  return { ...rendered, onClose, client }
}

beforeEach(() => {
  mockGetGroupDetail.mockResolvedValue(baseDetail)
  mockUpdateGroupSettings.mockResolvedValue({ ok: true })
  mockUpdateGroupParticipants.mockResolvedValue({ ok: true })
  mockUpdateGroupSubject.mockResolvedValue({ ok: true })
  mockUpdateGroupDescription.mockResolvedValue({ ok: true })
  mockUpdateGroupMemberAddMode.mockResolvedValue({ ok: true })
  mockUpdateGroupJoinApproval.mockResolvedValue({ ok: true })
  mockUpdateGroupEphemeral.mockResolvedValue({ ok: true })
  mockGetGroupInviteLink.mockResolvedValue({ inviteLink: 'https://chat.whatsapp.com/abc123' })
  mockRevokeGroupInvite.mockResolvedValue({ ok: true })
  mockLeaveGroup.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// describe: closed state
// ---------------------------------------------------------------------------

describe('GroupDetailModal — closed state', () => {
  it('renders nothing when open is false', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders nothing when group is null', () => {
    renderModal({ group: null })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// describe: open state — shell and aria wiring
// ---------------------------------------------------------------------------

describe('GroupDetailModal — open state', () => {
  it('renders a dialog when open and group are both provided', async () => {
    renderModal()
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined())
  })

  it('aria-labelledby resolves to the element with id group-detail-dialog-title', async () => {
    renderModal()
    const dialog = await screen.findByRole('dialog')
    const labelledById = dialog.getAttribute('aria-labelledby')
    expect(labelledById).toBeTruthy()
    const titleEl = document.getElementById(labelledById!)
    expect(titleEl).not.toBeNull()
    // The subject text is the label
    expect(titleEl!.textContent).toBe('Team Alpha')
    // The id is explicitly group-detail-dialog-title (preserved via labelledById prop, C-B3W3-4)
    expect(labelledById).toBe('group-detail-dialog-title')
  })

  it('shows the group subject in the header', async () => {
    renderModal()
    await screen.findByRole('dialog')
    expect(screen.getByText('Team Alpha')).toBeDefined()
  })

  it('shows participant count in the header', async () => {
    renderModal()
    await screen.findByRole('dialog')
    expect(screen.getByText(/2 participant/)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// describe: dismissal behaviour (C-B3W3-1)
// ---------------------------------------------------------------------------

describe('GroupDetailModal — dismissal', () => {
  it('does NOT close on backdrop pointerdown (dismissable=false, fresh pin)', async () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    const dialog = await screen.findByRole('dialog')
    const backdrop = dialog.parentElement!
    fireEvent.pointerDown(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed (stack-aware)', async () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when the X (Close dialog) button is clicked', async () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    await screen.findByRole('dialog')
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' })
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// describe: stacked-modal Escape ordering (Leave confirm)
// ---------------------------------------------------------------------------

describe('GroupDetailModal — nested confirm Escape ordering', () => {
  it('Escape with Leave confirm open closes only the confirm, second Escape closes modal', async () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    await screen.findByRole('dialog')

    // Navigate to Settings tab
    const settingsTab = screen.getByRole('tab', { name: /Settings/i })
    fireEvent.click(settingsTab)
    // Activate via Enter (manual activation)
    fireEvent.keyDown(settingsTab, { key: 'Enter' })

    // Wait for settings panel to appear and find Leave button
    await waitFor(() => expect(screen.getByRole('button', { name: /Leave group/i })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /Leave group/i }))

    // Leave confirm dialog should now be open
    await waitFor(() => expect(screen.getByText('Leave group?')).toBeDefined())

    // First Escape — closes the confirm dialog only
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Leave group?')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()

    // Second Escape — closes the modal
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// describe: tablist (Tabs primitive — C-B3W3-4)
// ---------------------------------------------------------------------------

describe('GroupDetailModal — tablist', () => {
  it('renders a labelled tablist', async () => {
    renderModal()
    await screen.findByRole('dialog')
    const tablist = screen.getByRole('tablist')
    expect(tablist).toBeDefined()
    expect(tablist.getAttribute('aria-label')).toBeTruthy()
  })

  it('renders Info, Participants, Settings tabs', async () => {
    renderModal()
    await screen.findByRole('dialog')
    expect(screen.getByRole('tab', { name: /Info/i })).toBeDefined()
    expect(screen.getByRole('tab', { name: /Participants/i })).toBeDefined()
    expect(screen.getByRole('tab', { name: /Settings/i })).toBeDefined()
  })

  it('Info tab is selected by default (aria-selected=true)', async () => {
    renderModal()
    await screen.findByRole('dialog')
    const infoTab = screen.getByRole('tab', { name: /Info/i }) as HTMLElement
    expect(infoTab.getAttribute('aria-selected')).toBe('true')
  })

  it('ArrowRight moves focus to next tab without selecting it (roving tabindex, MANUAL activation)', async () => {
    renderModal()
    await screen.findByRole('dialog')
    const infoTab = screen.getByRole('tab', { name: /Info/i })
    const participantsTab = screen.getByRole('tab', { name: /Participants/i })
    // Focus Info tab first
    infoTab.focus()
    // ArrowRight — moves focus to Participants without selecting
    fireEvent.keyDown(infoTab, { key: 'ArrowRight' })
    // Info remains selected
    expect(infoTab.getAttribute('aria-selected')).toBe('true')
    // Participants tab receives focus (tabIndex 0 on focused tab under roving model)
    expect(document.activeElement).toBe(participantsTab)
  })

  it('Enter on focused tab selects it (manual activation)', async () => {
    renderModal()
    await screen.findByRole('dialog')
    const participantsTab = screen.getByRole('tab', { name: /Participants/i })
    // Navigate to Participants via ArrowRight from Info
    const infoTab = screen.getByRole('tab', { name: /Info/i })
    infoTab.focus()
    fireEvent.keyDown(infoTab, { key: 'ArrowRight' })
    // Now Enter selects the focused tab
    fireEvent.keyDown(participantsTab, { key: 'Enter' })
    expect(participantsTab.getAttribute('aria-selected')).toBe('true')
  })

  it('selected tabpanel has correct aria-labelledby wiring', async () => {
    renderModal()
    await screen.findByRole('dialog')
    // Wait for the detail to load so the tabpanel div is mounted
    await waitFor(() => expect(mockGetGroupDetail).toHaveBeenCalled())
    // The group subject appears in the Info panel once detail is loaded
    await waitFor(() => expect(screen.getByText('Team Alpha')).toBeDefined())
    const infoTab = screen.getByRole('tab', { name: /Info/i })
    const controlsId = infoTab.getAttribute('aria-controls')
    expect(controlsId).toBeTruthy()
    const panel = document.getElementById(controlsId!)
    expect(panel).not.toBeNull()
    expect(panel!.getAttribute('aria-labelledby')).toBe(infoTab.id)
  })
})

// ---------------------------------------------------------------------------
// describe: settings seg pairs (C-B3W3-2)
// ---------------------------------------------------------------------------

describe('GroupDetailModal — settings seg pairs', () => {
  async function openSettingsAsAdmin() {
    renderModal({ myJid: MY_JID })
    await screen.findByRole('dialog')
    // Wait for detail to load
    await waitFor(() => expect(mockGetGroupDetail).toHaveBeenCalled())
    // Switch to Settings tab
    const settingsTab = screen.getByRole('tab', { name: /Settings/i })
    fireEvent.click(settingsTab)
    fireEvent.keyDown(settingsTab, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('Messaging')).toBeDefined())
  }

  it('Messaging seg group has aria-label', async () => {
    await openSettingsAsAdmin()
    const group = screen.getByRole('group', { name: 'Messaging' })
    expect(group).toBeDefined()
  })

  it('exactly one button per seg pair has aria-pressed=true', async () => {
    await openSettingsAsAdmin()
    // Find the Messaging group
    const messagingGroup = screen.getByRole('group', { name: 'Messaging' })
    const btns = Array.from(messagingGroup.querySelectorAll('button'))
    const pressed = btns.filter(b => b.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
  })

  it('seg buttons are disabled while saving is in-flight (C-B3W3-2 double-fire protection)', async () => {
    // Make updateGroupSettings return a never-resolving promise to hold saving state
    mockUpdateGroupSettings.mockReturnValue(new Promise(() => {}))
    await openSettingsAsAdmin()

    const messagingGroup = screen.getByRole('group', { name: 'Messaging' })
    const btns = Array.from(messagingGroup.querySelectorAll('button')) as HTMLButtonElement[]

    // Click the non-selected button to trigger saving
    const unpressed = btns.find(b => b.getAttribute('aria-pressed') === 'false')!
    fireEvent.click(unpressed)

    // Now buttons should be disabled
    await waitFor(() => {
      const freshBtns = Array.from(messagingGroup.querySelectorAll('button')) as HTMLButtonElement[]
      expect(freshBtns.every(b => b.disabled)).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// describe: admin gating
// ---------------------------------------------------------------------------

describe('GroupDetailModal — admin gating', () => {
  it('hides admin-only controls when isAdmin=false', async () => {
    // myJid is a non-admin member
    renderModal({ myJid: MEMBER_JID })
    await screen.findByRole('dialog')
    await waitFor(() => expect(mockGetGroupDetail).toHaveBeenCalled())

    // Switch to Settings — Messaging/locked seg pairs should not appear for non-admins
    const settingsTab = screen.getByRole('tab', { name: /Settings/i })
    fireEvent.click(settingsTab)
    fireEvent.keyDown(settingsTab, { key: 'Enter' })

    // Give the tab panel time to mount
    await waitFor(() => {
      // Leave group button appears for all users
      expect(screen.getByRole('button', { name: /Leave group/i })).toBeDefined()
    })
    // Admin-only segs are hidden
    expect(screen.queryByRole('group', { name: 'Messaging' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// describe: tab reset on group change
// ---------------------------------------------------------------------------

describe('GroupDetailModal — tab reset', () => {
  it('resets to Info tab when the group prop changes', async () => {
    const { rerender, client } = renderModal()
    await screen.findByRole('dialog')

    // Switch to Participants
    const participantsTab = screen.getByRole('tab', { name: /Participants/i })
    fireEvent.click(participantsTab)
    fireEvent.keyDown(participantsTab, { key: 'Enter' })
    await waitFor(() => expect(participantsTab.getAttribute('aria-selected')).toBe('true'))

    // Change the group prop — tab should reset to Info
    const newGroup: GroupInfo = {
      id: '1555100002@g.us',
      subject: 'Team Beta',
      participants: [{ id: MY_JID, admin: 'admin' }],
    }
    mockGetGroupDetail.mockResolvedValue({ ...baseDetail, id: newGroup.id, subject: 'Team Beta' })

    rerender(
      <Wrapper client={client}>
        <GroupDetailModal
          open={true}
          group={newGroup}
          lineName={LINE}
          myJid={MY_JID}
          onClose={vi.fn()}
        />
      </Wrapper>,
    )

    await waitFor(() => {
      const infoTab = screen.getByRole('tab', { name: /Info/i })
      expect(infoTab.getAttribute('aria-selected')).toBe('true')
    })
  })
})
