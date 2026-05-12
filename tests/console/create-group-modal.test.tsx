/**
 * CreateGroupModal — open/close, subject input, participants via ContactSearchPicker, submit pipeline, Escape, validation.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ContactResult } from '../../console/src/types.js'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context.js'

// ---- Mocks ----

const createGroupMock = vi.fn()

vi.mock('../../console/src/lib/api.js', () => ({
  api: {
    createGroup: (...args: unknown[]) => createGroupMock(...args),
  },
}))

// Stub ContactSearchPicker so we don't drag api.searchContacts + debounce into
// the modal's behavior surface. Expose three buttons:
//   add-alice / add-bob — push synthetic contacts into the parent list
//   remove-first        — remove whichever JID is at index 0 of `selected`
// Rendering also reflects the current `selected` array so tests can assert it.
vi.mock('../../console/src/components/shared/ContactSearchPicker.js', () => ({
  ContactSearchPicker: ({
    lineName,
    selected,
    onAdd,
    onRemove,
    placeholder,
  }: {
    lineName: string
    selected: ContactResult[]
    onAdd: (c: ContactResult) => void
    onRemove: (jid: string) => void
    placeholder?: string
  }) => (
    <div data-testid="picker-stub" data-line={lineName} data-placeholder={placeholder}>
      <button
        type="button"
        data-testid="picker-add-alice"
        onClick={() => onAdd({ jid: '15551110001@s.whatsapp.net', name: 'Alice' })}
      >
        add-alice
      </button>
      <button
        type="button"
        data-testid="picker-add-bob"
        onClick={() => onAdd({ jid: '15551110002@s.whatsapp.net', name: 'Bob' })}
      >
        add-bob
      </button>
      <button
        type="button"
        data-testid="picker-remove-first"
        onClick={() => {
          if (selected[0]) onRemove(selected[0].jid)
        }}
      >
        remove-first
      </button>
      <ul data-testid="picker-selected">
        {selected.map((c, i) => (
          // Use index in the key to tolerate duplicate-jid test cases — the
          // real ContactSearchPicker dedups by selectedJids, but the modal
          // itself does not, and we want to render whatever it stores.
          <li key={`${i}-${c.jid}`} data-jid={c.jid}>
            {c.name ?? c.jid}
          </li>
        ))}
      </ul>
    </div>
  ),
}))

// Import after mocks so the component picks up the stubbed module graph.
import { CreateGroupModal } from '../../console/src/components/line-detail/CreateGroupModal.js'

// ---- Helpers ----

interface ToastSpies extends ToastContextValue {
  success: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  toast: ReturnType<typeof vi.fn>
}

function makeToast(): ToastSpies {
  return {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    toast: vi.fn(),
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

afterEach(() => {
  cleanup()
  createGroupMock.mockReset()
})

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
    expect(dialog.getAttribute('aria-labelledby')).toBe('create-group-dialog-title')
    const title = document.getElementById('create-group-dialog-title')
    expect(title?.textContent).toBe('Create Group')

    const subject = screen.getByLabelText(/Group subject/i) as HTMLInputElement
    expect(subject.value).toBe('')
    expect(subject.tagName).toBe('INPUT')

    const submit = screen.getByRole('button', { name: /Create Group/ })
    expect(submit).toHaveProperty('disabled', true)
  })

  it('forwards lineName and placeholder to the ContactSearchPicker and starts with zero participants', () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="alpha-line" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    const picker = screen.getByTestId('picker-stub')
    expect(picker.getAttribute('data-line')).toBe('alpha-line')
    expect(picker.getAttribute('data-placeholder')).toBe('Search contacts...')
    expect(screen.getByTestId('picker-selected').children.length).toBe(0)
    expect(screen.queryByText(/selected\)/)).toBeNull()
  })
})

describe('CreateGroupModal participant list', () => {
  it('appends a contact via onAdd and shows the "(N selected)" badge', () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.click(screen.getByTestId('picker-add-alice'))

    const list = screen.getByTestId('picker-selected')
    expect(list.children.length).toBe(1)
    expect(list.querySelector('[data-jid="15551110001@s.whatsapp.net"]')).not.toBeNull()
    expect(screen.getByText('(1 selected)')).toBeDefined()
  })

  it('appends a second distinct contact and updates the counter', () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.click(screen.getByTestId('picker-add-alice'))
    fireEvent.click(screen.getByTestId('picker-add-bob'))

    expect(screen.getByTestId('picker-selected').children.length).toBe(2)
    expect(screen.getByText('(2 selected)')).toBeDefined()
  })

  it('appends duplicates verbatim — the modal performs no dedup itself', () => {
    // The modal's onAdd is `setParticipants(prev => [...prev, c])` with no
    // identity check. Dedup is the picker's job (it filters by `selectedJids`).
    // This test pins the modal's contract: whatever the picker emits goes in.
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.click(screen.getByTestId('picker-add-alice'))
    fireEvent.click(screen.getByTestId('picker-add-alice'))

    expect(screen.getByTestId('picker-selected').children.length).toBe(2)
    expect(screen.getByText('(2 selected)')).toBeDefined()
  })

  it('removes a participant via onRemove(jid)', () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.click(screen.getByTestId('picker-add-alice'))
    fireEvent.click(screen.getByTestId('picker-add-bob'))
    expect(screen.getByTestId('picker-selected').children.length).toBe(2)

    fireEvent.click(screen.getByTestId('picker-remove-first'))
    const remaining = screen.getByTestId('picker-selected')
    expect(remaining.children.length).toBe(1)
    expect(remaining.querySelector('[data-jid="15551110001@s.whatsapp.net"]')).toBeNull()
    expect(remaining.querySelector('[data-jid="15551110002@s.whatsapp.net"]')).not.toBeNull()
  })

  it('resets subject and participants when re-opened after being closed', () => {
    const client = makeClient()
    const { rerender } = render(
      <Wrap client={client} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.change(screen.getByLabelText(/Group subject/i), { target: { value: 'temp' } })
    fireEvent.click(screen.getByTestId('picker-add-alice'))
    expect(screen.getByTestId('picker-selected').children.length).toBe(1)

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
    expect(screen.getByTestId('picker-selected').children.length).toBe(0)
  })
})

describe('CreateGroupModal submit button gating', () => {
  it('stays disabled until both subject and at least one participant are present', () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    const submit = screen.getByRole('button', { name: /Create Group/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(/Group subject/i), { target: { value: 'Team' } })
    expect(submit.disabled).toBe(true)

    fireEvent.click(screen.getByTestId('picker-add-alice'))
    expect(submit.disabled).toBe(false)
  })

  it('treats whitespace-only subject as empty for the disabled gate', () => {
    render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={() => {}} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.change(screen.getByLabelText(/Group subject/i), { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('picker-add-alice'))

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
    fireEvent.click(screen.getByTestId('picker-add-alice'))
    fireEvent.click(screen.getByTestId('picker-add-bob'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Group/ }))
    })

    expect(createGroupMock).toHaveBeenCalledTimes(1)
    expect(createGroupMock).toHaveBeenCalledWith('primary', 'Team Hydra', [
      '15551110001@s.whatsapp.net',
      '15551110002@s.whatsapp.net',
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
    fireEvent.click(screen.getByTestId('picker-add-alice'))

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
    fireEvent.click(screen.getByTestId('picker-add-alice'))

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

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
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

  it('invokes onClose when the backdrop is clicked but not when clicking inside the dialog', () => {
    const onClose = vi.fn()

    const { container } = render(
      <Wrap client={makeClient()} toast={makeToast()}>
        <CreateGroupModal open lineName="primary" onClose={onClose} onCreated={() => {}} />
      </Wrap>,
    )

    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    const backdrop = container.querySelector('.c-dialog-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
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
