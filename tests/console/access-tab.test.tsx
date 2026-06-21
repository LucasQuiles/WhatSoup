/**
 * AccessTab — pending/allowed/blocked grouping, confirm flow, api.accessDecision contract.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../../console/src/lib/api', () => ({
  api: { accessDecision: vi.fn() },
}))

import { AccessTab } from '../../console/src/components/line-detail/AccessTab'
import { api } from '../../console/src/lib/api'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AccessEntry } from '../../console/src/types'

const accessDecisionMock = api.accessDecision as unknown as ReturnType<typeof vi.fn>

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}

function withProviders(node: ReactElement, queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toastValue}>{node}</ToastContext.Provider>
    </QueryClientProvider>
  )
}

const LINE = 'test-line'

// Repo convention: 555-prefixed phone JIDs / short 120363NNN@g.us synthetic group JIDs.
const pendingPhone: AccessEntry = {
  subjectType: 'phone',
  subjectId: '15555550001@s.whatsapp.net',
  subjectName: 'Pending Pat',
  status: 'pending',
  updatedAt: '2026-05-12T12:00:00Z',
}
const seenGroup: AccessEntry = {
  subjectType: 'group',
  subjectId: '120363001@g.us',
  subjectName: 'Seen Squad',
  status: 'seen',
  updatedAt: '2026-05-12T12:01:00Z',
}
const allowedPhone: AccessEntry = {
  subjectType: 'phone',
  subjectId: '15555550002@s.whatsapp.net',
  subjectName: 'Allowed Alice',
  status: 'allowed',
  updatedAt: '2026-05-12T11:00:00Z',
}
const allowedGroup: AccessEntry = {
  subjectType: 'group',
  subjectId: '120363002@g.us',
  subjectName: 'Allowed Group',
  status: 'allowed',
  updatedAt: '2026-05-12T11:01:00Z',
}
const blockedPhone: AccessEntry = {
  subjectType: 'phone',
  subjectId: '15555550003@s.whatsapp.net',
  subjectName: 'Blocked Bob',
  status: 'blocked',
  updatedAt: '2026-05-12T10:00:00Z',
}

beforeEach(() => {
  accessDecisionMock.mockReset()
  toastValue.success = vi.fn()
  toastValue.error = vi.fn()
})
afterEach(() => cleanup())

describe('AccessTab — partitioning into pending / allowed / blocked', () => {
  it('groups entries by status with correct counts in section headers', () => {
    render(withProviders(
      <AccessTab
        lineName={LINE}
        access={[pendingPhone, seenGroup, allowedPhone, allowedGroup, blockedPhone]}
      />,
    ))

    // Both 'pending' and 'seen' roll into the Pending queue.
    expect(screen.getByText('Pending (2)')).toBeDefined()
    expect(screen.getByText('Allowed (2)')).toBeDefined()
    expect(screen.getByText('Blocked (1)')).toBeDefined()

    expect(screen.getByText('Pending Pat')).toBeDefined()
    expect(screen.getByText('Seen Squad')).toBeDefined()
    expect(screen.getByText('Allowed Alice')).toBeDefined()
    expect(screen.getByText('Blocked Bob')).toBeDefined()
  })

  it('hides the Pending section entirely when no pending/seen entries exist', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[allowedPhone, blockedPhone]} />,
    ))

    expect(screen.queryByText(/^Pending \(/)).toBeNull()
    expect(screen.getByText('Allowed (1)')).toBeDefined()
    expect(screen.getByText('Blocked (1)')).toBeDefined()
  })

  it('renders an empty Blocked placeholder and a zero count when no blocked entries exist', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[allowedPhone]} />,
    ))

    expect(screen.getByText('Blocked (0)')).toBeDefined()
    expect(screen.getByText('No blocked contacts')).toBeDefined()
  })

  it('renders subjectId beneath subjectName inside each row', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[allowedPhone]} />,
    ))

    expect(screen.getByText('Allowed Alice')).toBeDefined()
    expect(screen.getByText('15555550002@s.whatsapp.net')).toBeDefined()
  })

  it('renders an empty shell with zero counts when given no entries', () => {
    render(withProviders(<AccessTab lineName={LINE} access={[]} />))

    expect(screen.queryByText(/^Pending \(/)).toBeNull()
    expect(screen.getByText('Allowed (0)')).toBeDefined()
    expect(screen.getByText('Blocked (0)')).toBeDefined()
    expect(screen.getByText('No blocked contacts')).toBeDefined()
  })
})

describe('AccessTab — pending row actions (Allow / Block buttons)', () => {
  it('exposes both Allow and Block buttons on pending rows', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[pendingPhone]} />,
    ))

    expect(screen.getByRole('button', { name: /^Allow$/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /^Block$/ })).toBeDefined()
  })

  it('opens the confirm dialog with allow-variant copy when Allow is clicked', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[pendingPhone]} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Allow Pending Pat?')).toBeDefined()
    expect(within(dialog).getByText(/will grant/i)).toBeDefined()
    // ConfirmDialog renders confirmLabel into the confirm button.
    expect(within(dialog).getByRole('button', { name: /^Allow$/ })).toBeDefined()
  })

  it('opens the confirm dialog with block-variant copy when Block is clicked', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[pendingPhone]} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: /^Block$/ }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Block Pending Pat?')).toBeDefined()
    expect(within(dialog).getByText(/will block/i)).toBeDefined()
    expect(within(dialog).getByRole('button', { name: /^Block$/ })).toBeDefined()
  })

  it('closes the confirm dialog without calling api when Cancel is clicked', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[pendingPhone]} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }))
    expect(screen.getByRole('dialog')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(accessDecisionMock).not.toHaveBeenCalled()
  })
})

describe('AccessTab — allowed/blocked row inline action buttons', () => {
  it('exposes a Block-only button on allowed rows', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[allowedPhone]} />,
    ))

    expect(screen.getByRole('button', { name: 'Block contact' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Allow contact' })).toBeNull()
  })

  it('exposes an Allow-only button on blocked rows', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[blockedPhone]} />,
    ))

    expect(screen.getByRole('button', { name: 'Allow contact' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Block contact' })).toBeNull()
  })

  it('opens a Block confirm dialog when the allowed-row Block icon is clicked', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[allowedPhone]} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Block contact' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Block Allowed Alice?')).toBeDefined()
    expect(within(dialog).getByText(/will block/i)).toBeDefined()
  })

  it('opens an Allow confirm dialog when the blocked-row Allow icon is clicked', () => {
    render(withProviders(
      <AccessTab lineName={LINE} access={[blockedPhone]} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Allow contact' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Allow Blocked Bob?')).toBeDefined()
    expect(within(dialog).getByText(/will grant/i)).toBeDefined()
  })
})

describe('AccessTab — confirm executes api.accessDecision with the pinned shape', () => {
  it('calls api.accessDecision(lineName, "phone", subjectId, "allow") on pending phone allow', async () => {
    accessDecisionMock.mockResolvedValue({ ok: true, result: 'allowed' })

    render(withProviders(
      <AccessTab lineName={LINE} access={[pendingPhone]} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }))
    const dialog = screen.getByRole('dialog')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^Allow$/ }))
    })

    expect(accessDecisionMock).toHaveBeenCalledTimes(1)
    expect(accessDecisionMock).toHaveBeenCalledWith(
      LINE,
      'phone',
      '15555550001@s.whatsapp.net',
      'allow',
    )
    expect(toastValue.success).toHaveBeenCalledWith('Allowed Pending Pat')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('passes subjectType="group" through to api.accessDecision for group entries', async () => {
    accessDecisionMock.mockResolvedValue({ ok: true, result: 'allowed' })

    render(withProviders(
      <AccessTab lineName={LINE} access={[seenGroup]} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Allow$/ }))
    })

    expect(accessDecisionMock).toHaveBeenCalledWith(
      LINE,
      'group',
      '120363001@g.us',
      'allow',
    )
    expect(toastValue.success).toHaveBeenCalledWith('Allowed Seen Squad')
  })

  it('calls api.accessDecision with action="block" and toasts "Blocked …" on block confirm', async () => {
    accessDecisionMock.mockResolvedValue({ ok: true, result: 'blocked' })

    render(withProviders(
      <AccessTab lineName={LINE} access={[allowedPhone]} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Block contact' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Block$/ }))
    })

    expect(accessDecisionMock).toHaveBeenCalledWith(
      LINE,
      'phone',
      '15555550002@s.whatsapp.net',
      'block',
    )
    expect(toastValue.success).toHaveBeenCalledWith('Blocked Allowed Alice')
  })

  it('invalidates the ["access", lineName] query after a successful decision', async () => {
    accessDecisionMock.mockResolvedValue({ ok: true, result: 'allowed' })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    render(withProviders(
      <AccessTab lineName={LINE} access={[pendingPhone]} />,
      client,
    ))

    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Allow$/ }))
    })

    expect(invalidateSpy).toHaveBeenCalledTimes(1)
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['access', LINE] })
  })

  it('keeps the confirm action single-flight while an access decision is pending', async () => {
    let resolveDecision!: () => void
    accessDecisionMock.mockReturnValue(new Promise(resolve => {
      resolveDecision = () => resolve({ ok: true, result: 'allowed' })
    }))

    render(withProviders(
      <AccessTab lineName={LINE} access={[pendingPhone]} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }))
    const dialog = screen.getByRole('dialog')
    const confirmButton = within(dialog).getByRole('button', { name: /^Allow$/ }) as HTMLButtonElement

    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)

    expect(accessDecisionMock).toHaveBeenCalledTimes(1)
    expect(confirmButton.disabled).toBe(true)

    await act(async () => {
      resolveDecision()
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('surfaces api errors via toast.error and still closes the dialog', async () => {
    accessDecisionMock.mockRejectedValue(new Error('boom'))

    render(withProviders(
      <AccessTab lineName={LINE} access={[pendingPhone]} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: /^Block$/ }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Block$/ }))
    })

    expect(toastValue.error).toHaveBeenCalledWith('Block failed: boom')
    expect(toastValue.success).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not invalidate the access query when the api call rejects', async () => {
    accessDecisionMock.mockRejectedValue(new Error('nope'))

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    render(withProviders(
      <AccessTab lineName={LINE} access={[pendingPhone]} />,
      client,
    ))

    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Allow$/ }))
    })

    expect(invalidateSpy).not.toHaveBeenCalled()
    expect(toastValue.error).toHaveBeenCalledWith('Allow failed: nope')
  })
})
