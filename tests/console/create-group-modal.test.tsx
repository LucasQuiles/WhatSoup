/**
 * CreateGroupModal — open/close, subject input, participants via ContactSearchPicker, submit pipeline, Escape, validation.
 * Updated for B3 wave-1 Modal migration (was: ad-hoc backdrop; now: Modal dismissable=false).
 *
 * Test changes from pre-migration version:
 *   - aria-labelledby: literal id check → resolution check (Modal auto-generates id)
 *   - Close button label: Close → Close dialog (ModalHeader ActionButton)
 *   - Backdrop: INVERTS from "closes on click" → "does NOT dismiss (dismissable=false)" (C-B3W1-3)
 *   - container.querySelector .c-dialog-backdrop → document.querySelector .soup-modal-backdrop
 *   - NEW: subject input holds initial focus after open (C-B3W1-1)
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ContactResult } from '../../console/src/types.js'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context.js'

// ---- Mocks ----

const createGroupMock = vi.fn()
const searchContactsMock = vi.fn()

vi.mock('../../console/src/lib/api.js', () => ({
  api: {
    createGroup: (...args: unknown[]) => createGroupMock(...args),
    searchContacts: (...args: unknown[]) => searchContactsMock(...args),
  },
}))

// Import after mocks so the component picks up the mocked API boundary.
import { CreateGroupModal } from '../../console/src/components/line-detail/CreateGroupModal.js'

// ---- Helpers ----

interface ToastSpies extends ToastContextValue {
  success: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  toast: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
}

const alice: ContactResult = {
  jid: '15551230001@s.whatsapp.net',
  name: 'Alice Johnson',
  notify: 'Alice',
  number: '15551230001',
}

const bob: ContactResult = {
  jid: '15551230002@s.whatsapp.net',
  name: 'Bob Smith',
  notify: 'Bob',
  number: '15551230002',
}

function makeToast(): ToastSpies {
  return {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    toast: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
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

beforeEach(() => {
  searchContactsMock.mockResolvedValue({ contacts: [alice, bob] })
})

afterEach(() => {
  cleanup()
  createGroupMock.mockReset()
  searchContactsMock.mockReset()
})

function searchInput(): HTMLInputElement {
  return screen.getByRole('textbox', { name: 'Search contacts...' }) as HTMLInputElement
}

async function searchFor(query: string, contacts: ContactResult[] = [alice, bob]) {
  const callCount = searchContactsMock.mock.calls.length
  searchContactsMock.mockResolvedValueOnce({ contacts })
  fireEvent.change(searchInput(), { target: { value: query } })
  await waitFor(() => {
    expect(searchContactsMock.mock.calls.length).toBeGreaterThan(callCount)
  })
}

async function chooseContact(contact: ContactResult, query = contact.name?.slice(0, 2) ?? contact.jid.slice(0, 2)) {
  await searchFor(query, [contact])
  fireEvent.click(screen.getByText(contact.name ?? contact.notify ?? contact.jid).closest('button')!)
  await waitFor(() => {
    expect(screen.getByRole('button', { name: `Remove ${contact.name ?? contact.jid}` })).toBeDefined()
  })
}

// ---- Tests ----

describe('CreateGroupModal closed state', () => {
  it('renders nothing and binds no Escape listener when open is false', () => {
    const onClose = vi.fn()
    const onCreated = vi.fn()
    const toast = makeToast()

    const { container } = render(
      <Wrap client={makeClient()} toast={toast}>
        <CreateGroupModal open={false} lineName="primary" onClose={onClose} onCreated={onCreated} />
      </Wrap>,
    )

    expect(container.firstChild).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })
})

describe('CreateGroupModal initial render', () => {
  it('renders dialog shell, subject input empty, and a disabled Create Group button', () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // Modal auto-generates the id; resolve it rather than pin the literal value
    const labelledById = dialog.getAttribute('aria-labelledby')
    expect(labelledById).toBeTruthy()
    const title = document.getElementById(labelledById!)
    expect(title).not.toBeNull()
    expect(title!.textContent).toBe('Create Group')

    const subject = screen.getByLabelText(/Group subject/i) as HTMLInputElement
    expect(subject.value).toBe('')
    expect(subject.tagName).toBe('INPUT')

    const submit = screen.getByRole('button', { name: /Create Group/ })
    expect(submit).toHaveProperty('disabled', true)

    expect(searchInput().value).toBe('')
    expect(screen.queryByText(/selected\)/)).toBeNull()
    expect(searchContactsMock).not.toHaveBeenCalled()
  })
})

describe('CreateGroupModal initial focus (C-B3W1-1)', () => {
  it('subject input holds initial focus after open', () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    const subject = screen.getByLabelText(/Group subject/i)
    expect(document.activeElement).toBe(subject)
  })
})

describe('CreateGroupModal participant list', () => {
  it('searches contacts for the current line, adds a result, and shows the selected count', async () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="alpha-line" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    await searchFor('Ali', [alice])
    expect(searchContactsMock).toHaveBeenLastCalledWith('alpha-line', 'Ali')
    fireEvent.click(screen.getByText('Alice Johnson').closest('button')!)

    expect(screen.getByRole('button', { name: 'Remove Alice Johnson' })).toBeDefined()
    expect(screen.getByText('(1 selected)')).toBeDefined()
    expect(searchInput().value).toBe('')
    expect(screen.queryByText('15551230001')).toBeNull()
  })

  it('adds a second distinct contact and updates the counter', async () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    await chooseContact(alice)
    await chooseContact(bob)

    expect(screen.getByRole('button', { name: 'Remove Alice Johnson' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Remove Bob Smith' })).toBeDefined()
    expect(screen.getByText('(2 selected)')).toBeDefined()
  })

  it('does not offer already selected contacts in later search results', async () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    await chooseContact(alice)
    await searchFor('team', [alice, bob])

    expect(screen.getByRole('button', { name: 'Remove Alice Johnson' })).toBeDefined()
    expect(screen.queryByText('15551230001')).toBeNull()
    expect(screen.getByText('Bob Smith')).toBeDefined()
    expect(screen.getByText('15551230002')).toBeDefined()
    expect(screen.getByText('(1 selected)')).toBeDefined()
  })

  it('removes a selected participant from the picker', async () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    await chooseContact(alice)
    await chooseContact(bob)
    expect(screen.getByText('(2 selected)')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Alice Johnson' }))

    expect(screen.queryByRole('button', { name: 'Remove Alice Johnson' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Bob Smith' })).toBeDefined()
    expect(screen.getByText('(1 selected)')).toBeDefined()
  })

  it('resets subject and participants when re-opened after being closed', async () => {
    const client = makeClient()
    const { rerender } = render(
      <Wrap client={client} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.change(screen.getByLabelText(/Group subject/i), { target: { value: 'temp' } })
    await chooseContact(alice)
    expect(screen.getByRole('button', { name: 'Remove Alice Johnson' })).toBeDefined()

    rerender(
      <Wrap client={client} toast={makeToast()}>
        <CreateGroupModal open={false} lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )
    rerender(
      <Wrap client={client} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    const subjectAfter = screen.getByLabelText(/Group subject/i) as HTMLInputElement
    expect(subjectAfter.value).toBe('')
    expect(screen.queryByRole('button', { name: 'Remove Alice Johnson' })).toBeNull()
    expect(screen.queryByText(/selected\)/)).toBeNull()
  })
})

describe('CreateGroupModal submit button gating', () => {
  it('stays disabled until both subject and at least one participant are present', async () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    const submit = screen.getByRole('button', { name: /Create Group/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(/Group subject/i), { target: { value: 'Team' } })
    expect(submit.disabled).toBe(true)

    await chooseContact(alice)
    expect(submit.disabled).toBe(false)
  })

  it('treats whitespace-only subject as empty for the disabled gate', async () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.change(screen.getByLabelText(/Group subject/i), { target: { value: '   ' } })
    await chooseContact(alice)

    const submit = screen.getByRole('button', { name: /Create Group/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })
})

describe('CreateGroupModal submit pipeline', () => {
  it('calls api.createGroup with (lineName, trimmed subject, [jids]) on success and closes', async () => {
    createGroupMock.mockResolvedValue({ id: 'group-1' })
    const onClose = vi.fn()
    const onCreated = vi.fn()
    const toast = makeToast()
    const client = makeClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    render(
      <Wrap client={client} toast={toast}>
        <CreateGroupModal open lineName="primary" onClose={onClose} onCreated={onCreated} />
      </Wrap>,
    )

    fireEvent.change(screen.getByLabelText(/Group subject/i), { target: { value: '  Team Hydra  ' } })
    await chooseContact(alice)
    await chooseContact(bob)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Group/ }))
    })

    expect(createGroupMock).toHaveBeenCalledTimes(1)
    expect(createGroupMock).toHaveBeenCalledWith('primary', 'Team Hydra', [
      '15551230001@s.whatsapp.net',
      '15551230002@s.whatsapp.net',
    ])

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    expect(toast.success).toHaveBeenCalledWith('Group "Team Hydra" created')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groups', 'primary'] })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows a Creating... label and keeps the button disabled while the mutation is in flight', async () => {
    let resolveCreate: (v: { id: string }) => void = () => {}
    createGroupMock.mockImplementation(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveCreate = resolve
        }),
    )
    const onClose = vi.fn()
    const onCreated = vi.fn()
    const toast = makeToast()

    render(
      <Wrap client={makeClient()} toast={toast}>
        <CreateGroupModal open lineName="primary" onClose={onClose} onCreated={onCreated} />
      </Wrap>,
    )

    fireEvent.change(screen.getByLabelText(/Group subject/i), { target: { value: 'Hydra' } })
    await chooseContact(alice)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Create Group/ }))
    })

    const inFlight = await screen.findByRole('button', { name: /Creating\.\.\./ }) as HTMLButtonElement
    expect(inFlight.disabled).toBe(true)
    expect(onCreated).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    const cancelDuring = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    expect(cancelDuring.disabled).toBe(true)

    await act(async () => {
      resolveCreate({ id: 'g' })
    })

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(onCreated).toHaveBeenCalledTimes(1)
    })
  })

  it('surfaces a toast.error and does not close when api.createGroup rejects', async () => {
    createGroupMock.mockRejectedValue(new Error('network down'))
    const onClose = vi.fn()
    const onCreated = vi.fn()
    const toast = makeToast()

    render(
      <Wrap client={makeClient()} toast={toast}>
        <CreateGroupModal open lineName="primary" onClose={onClose} onCreated={onCreated} />
      </Wrap>,
    )

    fireEvent.change(screen.getByLabelText(/Group subject/i), { target: { value: 'Hydra' } })
    await chooseContact(alice)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Group/ }))
    })

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed: network down')
    })
    expect(onCreated).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // Submit button returns from "Creating..." back to "Create Group" enabled.
    const submitAfter = screen.getByRole('button', { name: /Create Group/ }) as HTMLButtonElement
    expect(submitAfter.disabled).toBe(false)
  })
})

describe('CreateGroupModal close affordances', () => {
  it('invokes onClose when the header Close button is clicked and never calls the api', () => {
    const onClose = vi.fn()
    const onCreated = vi.fn()

    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={onClose} onCreated={onCreated} />
      </Wrap>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCreated).not.toHaveBeenCalled()
    expect(createGroupMock).not.toHaveBeenCalled()
  })

  it('invokes onClose when the footer Cancel button is clicked', () => {
    const onClose = vi.fn()

    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={onClose} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(createGroupMock).not.toHaveBeenCalled()
  })

  it('backdrop pointerdown does NOT dismiss (dismissable=false, C-B3W1-3 inversion)', () => {
    // Migration note (B3 wave-1): CreateGroupModal uses Modal with dismissable=false.
    // Previously backdrop click destroyed subject + participants silently — corrected.
    // Mirrors confirm-dialog.test.tsx C2-migration test verbatim.
    const onClose = vi.fn()

    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={onClose} onCreated={() => {}} />
      </Wrap>,
    )

    // Modal portals to document.body — use document.querySelector
    const backdrop = document.querySelector('.soup-modal-backdrop')
    expect(backdrop).not.toBeNull()
    // dismissable=false: pointerdown on body outside shell must NOT call onClose
    fireEvent.pointerDown(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('invokes onClose when Escape is pressed while open, and unbinds on unmount', () => {
    const onClose = vi.fn()

    const { unmount } = render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={onClose} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores non-Escape keys', () => {
    const onClose = vi.fn()

    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={onClose} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.keyDown(document, { key: ' ' })

    expect(onClose).not.toHaveBeenCalled()
  })
})

// NOTE: handleCreate also contains two internal guards (toast.error for
// empty subject / empty participants), but both are unreachable from the UI —
// the submit button's `disabled` prop already prevents the click. They're
// defensive dead code for now and aren't asserted to avoid pinning behavior
// behind synthetic event dispatch that bypasses React's disabled-button gate.
