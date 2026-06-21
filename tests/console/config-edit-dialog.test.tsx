/**
 * ConfigEditDialog — open/close, field editing, save handler (success + error),
 * dirty tracking, validation gating, enum/custom-enum, TagInput wiring, backdrop dismiss.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'

// SOURCE SURPRISE: TagInput is default-exported and owns local input state.
// Stub it so all array-of-strings fields (adminPhones, etc.) are testable without
// keyboard-simulation complexity; the TagInput unit is covered by its own tests.
vi.mock('../../console/src/components/TagInput', () => ({
  default: ({
    values,
    onChange,
    id,
    placeholder,
    displayLabels,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
  }: {
    values: string[]
    onChange: (v: string[]) => void
    id?: string
    placeholder?: string
    displayLabels?: Record<string, string>
    'aria-describedby'?: string
    'aria-invalid'?: true
  }) => (
    <div data-testid="tag-input" data-placeholder={placeholder}>
      <input
        id={id}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        data-testid="tag-input-control"
        readOnly
      />
      {values.map((v, i) => (
        <span key={i} data-testid={`tag-${i}`}>{displayLabels?.[v] ?? v}</span>
      ))}
      <button
        type="button"
        data-testid="tag-add"
        onClick={() => onChange([...values, placeholder === 'Add phone number' ? '15557654321' : 'new-item'])}
      >
        add
      </button>
      <button
        type="button"
        data-testid="tag-remove-0"
        onClick={() => onChange(values.slice(1))}
      >
        remove-0
      </button>
    </div>
  ),
}))

vi.mock('../../console/src/lib/api', () => ({
  api: {
    updateConfig: vi.fn(),
  },
}))

import { ConfigEditDialog } from '../../console/src/components/line-detail/ConfigEditDialog'
import { api } from '../../console/src/lib/api'

const updateConfigMock = api.updateConfig as unknown as ReturnType<typeof vi.fn>

let toastValue: ToastContextValue

function getReactClickHandler(element: HTMLElement): () => unknown {
  const propsKey = Object.keys(element).find(key => key.startsWith('__reactProps$'))
  if (!propsKey) throw new Error('React props key not found')
  const props = (element as unknown as Record<string, { onClick?: () => unknown }>)[propsKey]
  if (!props.onClick) throw new Error('React onClick handler not found')
  return props.onClick
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

function withProviders(node: ReactElement, queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toastValue}>{node}</ToastContext.Provider>
    </QueryClientProvider>
  )
}

const LINE = 'test-line'

// SOURCE SURPRISE: CONFIG_EXCLUDE_KEYS excludes name/type/paths/healthPort.
// These must not appear in editableEntries; confirmed by rendering with these keys present.
const BASE_CONFIG: Record<string, unknown> = {
  // excluded keys (should not be rendered)
  name: 'test-line',
  type: 'agent',
  paths: { data: '/var/data' },
  healthPort: 9000,
  // included keys for field type coverage
  accessMode: 'self_only',           // string with ENUM_OPTIONS
  maxTokens: 8000,                   // number
  enabled: true,                     // boolean
  adminPhones: ['15551234567'],       // string array → TagInput (SOURCE SURPRISE: uses 1555 prefix format)
  systemPrompt: 'You are a helpful agent with some extra verbose instructions here that go beyond 80 chars.',
  // agentOptions → nested expansion (SOURCE SURPRISE)
  agentOptions: {
    sessionScope: 'single',
    cwd: '/home/user',
  },
}

beforeEach(() => {
  updateConfigMock.mockReset()
  toastValue = makeToast()
})

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
// Structural render
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — structural render', () => {
  it('renders the dialog with correct role and aria attributes', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // Modal generates the id; assert it resolves to the title element
    const labelId = dialog.getAttribute('aria-labelledby')
    expect(labelId).not.toBeNull()
    const titleEl = document.getElementById(labelId as string)
    expect(titleEl).not.toBeNull()
    expect(titleEl!.textContent).toBe('Edit Configuration')
  })

  it('renders the restart warning banner', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    expect(screen.getByText(/Some changes may require a restart/i)).toBeDefined()
  })

  it('renders close button with accessible label', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const closeBtn = screen.getByRole('button', { name: 'Close dialog' })
    expect(closeBtn.tagName).toBe('BUTTON')
    expect((closeBtn as HTMLButtonElement).type).toBe('button')
  })

  it('does NOT render excluded config keys (name, type, paths, healthPort)', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    // Excluded keys must not appear as field labels
    expect(screen.queryByText('name')).toBeNull()
    expect(screen.queryByText('type')).toBeNull()
    expect(screen.queryByText('paths')).toBeNull()
    expect(screen.queryByText('healthPort')).toBeNull()
  })

  it('renders included config keys as field labels', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    expect(screen.getByText('accessMode')).toBeDefined()
    expect(screen.getByText('maxTokens')).toBeDefined()
    expect(screen.getByText('enabled')).toBeDefined()
    expect(screen.getByText('adminPhones')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// agentOptions expansion
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — agentOptions nested expansion', () => {
  it('expands agentOptions.sessionScope as a separate field instead of raw agentOptions', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    // SOURCE SURPRISE: agentOptions is decomposed into agentOptions.sessionScope / agentOptions.cwd
    // rather than rendered as a single JSON blob. The raw "agentOptions" label must not appear.
    expect(screen.getByText('agentOptions.sessionScope')).toBeDefined()
    expect(screen.getByText('agentOptions.cwd')).toBeDefined()
    expect(screen.queryByText('agentOptions')).toBeNull()
  })

  it('renders agentOptions (other) blob for unrecognised nested keys', () => {
    const configWithExtra: Record<string, unknown> = {
      ...BASE_CONFIG,
      agentOptions: {
        sessionScope: 'single',
        unknownFutureKey: 'mystery-value',
      },
    }

    render(withProviders(
      <ConfigEditDialog open={true} config={configWithExtra} lineName={LINE} onClose={() => {}} />,
    ))

    expect(screen.getByText('agentOptions (other)')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Field type rendering
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — field type rendering', () => {
  it('associates dynamic scalar field labels with their controls', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    expect((screen.getByLabelText('enabled') as HTMLInputElement).type).toBe('checkbox')
    expect((screen.getByLabelText('maxTokens') as HTMLInputElement).type).toBe('number')
    expect((screen.getByLabelText('accessMode') as HTMLSelectElement).tagName).toBe('SELECT')
    expect((screen.getByLabelText('systemPrompt') as HTMLTextAreaElement).tagName).toBe('TEXTAREA')
  })

  it('renders a checkbox for boolean fields', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBeGreaterThanOrEqual(1)
    const enabledCheckbox = checkboxes.find(cb => (cb as HTMLInputElement).checked === true)
    expect(enabledCheckbox).not.toBeNull()
    expect((enabledCheckbox as HTMLInputElement).type).toBe('checkbox')
  })

  it('renders a number input for numeric fields', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const numberInputs = screen.getAllByRole('spinbutton')
    expect(numberInputs.length).toBeGreaterThanOrEqual(1)
    expect((numberInputs[0] as HTMLInputElement).value).toBe('8000')
  })

  it('renders a select for string fields with known enum options', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    // accessMode is in ENUM_OPTIONS → should render <select>
    const selects = screen.getAllByRole('combobox')
    expect(selects.length).toBeGreaterThanOrEqual(1)
    const accessModeSelect = selects.find(
      s => (s as HTMLSelectElement).value === 'self_only',
    )
    expect(accessModeSelect).not.toBeNull()
    expect((accessModeSelect as HTMLSelectElement).tagName).toBe('SELECT')
  })

  it('renders a TagInput stub for string-array fields', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    expect(screen.getByTestId('tag-input')).toBeDefined()
    // initial phone value should be rendered as a tag
    expect(screen.getByTestId('tag-0')).toBeDefined()
    expect(screen.getByTestId('tag-0').textContent).toBe('15551234567')
  })

  it('renders a textarea for long string fields (>80 chars)', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const textareas = screen.getAllByRole('textbox')
    // systemPrompt (>80 chars) should be a textarea, not an input
    const systemPromptArea = textareas.find(
      el => el.tagName === 'TEXTAREA' && (el as HTMLTextAreaElement).value.includes('You are a helpful'),
    )
    expect(systemPromptArea).not.toBeNull()
    expect((systemPromptArea as HTMLTextAreaElement).readOnly).toBe(false)
  })

  it('renders a read-only textarea for object fields', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    // agentOptions (other) is only rendered when there are unrecognised nested keys.
    // Here BASE_CONFIG.agentOptions has only recognised keys, so let's test with a direct object field.
    const configWithObj: Record<string, unknown> = {
      someObject: { nested: 'value' },
    }
    cleanup()
    render(withProviders(
      <ConfigEditDialog open={true} config={configWithObj} lineName={LINE} onClose={() => {}} />,
    ))

    const textareas = screen.getAllByRole('textbox')
    const readOnly = textareas.find(el => (el as HTMLTextAreaElement).readOnly)
    expect(readOnly).not.toBeNull()
    expect((readOnly as HTMLTextAreaElement).value).toContain('"nested"')
  })

  it('renders null config values as read-only JSON literals', () => {
    render(withProviders(
      <ConfigEditDialog
        open={true}
        config={{ nullableSetting: null }}
        lineName={LINE}
        onClose={() => {}}
      />,
    ))

    const nullableField = screen.getByLabelText('nullableSetting') as HTMLTextAreaElement

    expect(nullableField.tagName).toBe('TEXTAREA')
    expect(nullableField.readOnly).toBe(true)
    expect(nullableField.value).toBe('null')
    expect(screen.queryByText('modified')).toBeNull()
    expect((screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('routes scalar controls through shared form primitives', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const enabledCheckbox = screen.getAllByRole('checkbox').find(
      checkbox => (checkbox as HTMLInputElement).checked === true,
    )
    expect(enabledCheckbox).not.toBeNull()
    expect(enabledCheckbox!.closest('.c-checkbox-row')).not.toBeNull()

    const numberInput = screen.getAllByRole('spinbutton')[0]
    expect(numberInput.classList.contains('c-input-number')).toBe(true)

    const accessModeSelect = screen.getAllByRole('combobox').find(
      select => (select as HTMLSelectElement).value === 'self_only',
    )
    expect(accessModeSelect).not.toBeNull()
    expect(accessModeSelect!.classList.contains('c-select')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dirty tracking and "modified" marker
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — dirty tracking', () => {
  it('shows no "modified" markers initially', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    expect(screen.queryByText('modified')).toBeNull()
  })

  it('shows a "modified" marker after changing a boolean field', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    expect(screen.getByText('modified')).toBeDefined()
  })

  it('shows a "modified" marker after changing a number field', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const numberInput = screen.getAllByRole('spinbutton')[0]
    fireEvent.change(numberInput, { target: { value: '9000' } })

    expect(screen.getByText('modified')).toBeDefined()
  })

  it('removes the "modified" marker when value is reverted to original', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const numberInput = screen.getAllByRole('spinbutton')[0]
    // Change to new value
    fireEvent.change(numberInput, { target: { value: '9000' } })
    expect(screen.getByText('modified')).toBeDefined()

    // Revert to original
    fireEvent.change(numberInput, { target: { value: '8000' } })
    expect(screen.queryByText('modified')).toBeNull()
  })

  it('shows "modified" marker after TagInput adds an item', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    fireEvent.click(screen.getByTestId('tag-add'))

    expect(screen.getByText('modified')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Save button state
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — save button state', () => {
  it('renders the Save button disabled when there are no changes', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const saveBtn = screen.getByRole('button', { name: /^Save$/ })
    expect(saveBtn).toBeDefined()
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables Save button when at least one field has changed', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    // Button label includes count when changes present
    const saveBtn = screen.getByRole('button', { name: /Save \(1\)/ })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows change count in Save button label', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    // Change two fields
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    const numberInput = screen.getAllByRole('spinbutton')[0]
    fireEvent.change(numberInput, { target: { value: '9000' } })

    expect(screen.getByRole('button', { name: /Save \(2\)/ })).toBeDefined()
  })

  it('disables Save button when there are field validation errors', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    // Set maxTokens below the 256 minimum (FIELD_VALIDATORS.maxTokens enforces this)
    const numberInput = screen.getAllByRole('spinbutton')[0]
    fireEvent.change(numberInput, { target: { value: '10' } })

    const saveBtn = screen.getByRole('button', { name: /Save/ })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows validation error text for fields below minimum', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const numberInput = screen.getAllByRole('spinbutton')[0]
    fireEvent.change(numberInput, { target: { value: '10' } })

    const error = screen.getByText('Min 256')
    expect(error).toBeDefined()
    expect(error.id).toBeTruthy()
    expect(numberInput.getAttribute('aria-invalid')).toBe('true')
    expect(numberInput.getAttribute('aria-describedby')).toBe(error.id)
  })
})

// ---------------------------------------------------------------------------
// Save handler — success path
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — save success', () => {
  it('calls api.updateConfig with lineName and the accumulated patch', async () => {
    updateConfigMock.mockResolvedValue(undefined)

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    expect(updateConfigMock).toHaveBeenCalledTimes(1)
    expect(updateConfigMock).toHaveBeenCalledWith(LINE, expect.objectContaining({
      enabled: false,
    }))
  })

  it('calls toast.success after a successful save', async () => {
    updateConfigMock.mockResolvedValue(undefined)

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    expect(toastValue.success).toHaveBeenCalledWith('Configuration updated')
    expect(toastValue.error).not.toHaveBeenCalled()
  })

  it('invalidates the lines query after a successful save', async () => {
    updateConfigMock.mockResolvedValue(undefined)

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
      client,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['lines', LINE] })
  })

  it('calls onClose after a successful save', async () => {
    updateConfigMock.mockResolvedValue(undefined)
    const onClose = vi.fn()

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={onClose} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows "Saving..." label while the save is in flight', async () => {
    let resolveUpdate!: () => void
    updateConfigMock.mockReturnValue(new Promise<void>(res => { resolveUpdate = res }))

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    // Start the save but do NOT await it yet
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    expect(screen.getByText('Saving...')).toBeDefined()

    // Resolve so the promise doesn't leak
    await act(async () => { resolveUpdate() })
  })

  it('disables the Save button while saving is in flight', async () => {
    let resolveUpdate!: () => void
    updateConfigMock.mockReturnValue(new Promise<void>(res => { resolveUpdate = res }))

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    const savingBtn = screen.getByText('Saving...')
    expect((savingBtn.closest('button') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { resolveUpdate() })
  })

  it('calls onClose through the empty-patch save path without invoking api', async () => {
    const onClose = vi.fn()

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={onClose} />,
    ))

    const saveBtn = screen.getByRole('button', { name: /^Save$/ })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      await getReactClickHandler(saveBtn)()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(updateConfigMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Save handler — error path
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — save error', () => {
  it('calls toast.error with the error message when api.updateConfig rejects', async () => {
    updateConfigMock.mockRejectedValue(new Error('network timeout'))

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    expect(toastValue.error).toHaveBeenCalledWith('Update failed: network timeout')
    expect(toastValue.success).not.toHaveBeenCalled()
  })

  it('does not call onClose when the save fails', async () => {
    updateConfigMock.mockRejectedValue(new Error('server error'))
    const onClose = vi.fn()

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={onClose} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not invalidate the query when the save fails', async () => {
    updateConfigMock.mockRejectedValue(new Error('fail'))

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
      client,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('re-enables the Save button after a failed save so the user can retry', async () => {
    updateConfigMock.mockRejectedValue(new Error('retry-me'))

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    const saveBtn = screen.getByRole('button', { name: /Save \(1\)/ })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cancel + backdrop dismiss
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — cancel and backdrop', () => {
  it('calls onClose when the Cancel button is clicked', () => {
    const onClose = vi.fn()

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={onClose} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the header close icon is clicked', () => {
    const onClose = vi.fn()

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={onClose} />,
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('backdrop pointerdown does NOT dismiss (dismissable=false)', () => {
    // C-B3W2-2: inverted assertion — form dialogs use protective default.
    const onClose = vi.fn()

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={onClose} />,
    ))

    // The Modal primitive portals to body; the backdrop is document.querySelector
    const backdrop = document.querySelector('.soup-modal-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.pointerDown(backdrop as Element)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not call onClose when pointerdown is inside the dialog panel', () => {
    // stopPropagation mechanism replaced by useDismissable pointerdown semantics
    const onClose = vi.fn()

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={onClose} />,
    ))

    fireEvent.pointerDown(screen.getByRole('dialog'))

    expect(onClose).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Modal-primitive behaviour (gained by migration — C-B3W2-1)
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — closed state, Escape, reset-on-open, focus', () => {
  it('renders nothing when open=false', () => {
    render(withProviders(
      <ConfigEditDialog open={false} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Edit Configuration')).toBeNull()
  })

  it('renders the dialog when open=true', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByText('Edit Configuration')).toBeDefined()
  })

  it('Escape key calls onClose when the dialog is open (gained: was missing pre-migration)', () => {
    const onClose = vi.fn()
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={onClose} />,
    ))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape does NOT call onClose when dialog is closed (listener unbound)', () => {
    const onClose = vi.fn()
    render(withProviders(
      <ConfigEditDialog open={false} config={BASE_CONFIG} lineName={LINE} onClose={onClose} />,
    ))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('resets patch and custom-enum state when reopened (C-B3W2-1 reset-on-open effect)', () => {
    const { rerender } = render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    // Change a field to make patch dirty
    const numberInput = screen.getAllByRole('spinbutton')[0]
    fireEvent.change(numberInput, { target: { value: '9000' } })
    expect(screen.getByText('modified')).toBeDefined()

    // Close and reopen
    rerender(withProviders(
      <ConfigEditDialog open={false} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))
    rerender(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    // modified marker must be gone — patch was reset
    expect(screen.queryByText('modified')).toBeNull()
  })

  it('initial focus lands inside the dialog (accessible: focus trap engaged)', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const dialog = screen.getByRole('dialog')
    // document.activeElement must be the dialog shell or a descendant
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Enum field — select + custom-enum flow
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — enum and custom-enum field', () => {
  it('renders select options for enum keys', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const selects = screen.getAllByRole('combobox')
    const accessModeSelect = selects.find(s => (s as HTMLSelectElement).value === 'self_only')
    expect(accessModeSelect).toBeDefined()

    const options = Array.from((accessModeSelect as HTMLSelectElement).options).map(o => o.value)
    expect(options).toContain('allowlist')
    expect(options).toContain('open_dm')
    expect(options).toContain('groups_only')
  })

  it('marks the field modified when the select value changes', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const selects = screen.getAllByRole('combobox')
    const accessModeSelect = selects.find(s => (s as HTMLSelectElement).value === 'self_only')
    expect(accessModeSelect).toBeDefined()

    fireEvent.change(accessModeSelect as Element, { target: { value: 'allowlist' } })

    expect(screen.getByText('modified')).toBeDefined()
  })

  it('renders the Custom… option for CUSTOMIZABLE_ENUM_KEYS (model)', () => {
    // SOURCE SURPRISE: only 'model' is in CUSTOMIZABLE_ENUM_KEYS, not 'accessMode'.
    const configWithModel: Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
    }

    render(withProviders(
      <ConfigEditDialog open={true} config={configWithModel} lineName={LINE} onClose={() => {}} />,
    ))

    const selects = screen.getAllByRole('combobox')
    const modelSelect = selects.find(s => (s as HTMLSelectElement).value === 'claude-sonnet-4-6')
    expect(modelSelect).toBeDefined()

    const options = Array.from((modelSelect as HTMLSelectElement).options).map(o => o.value)
    expect(options).toContain('__custom__')
  })

  it('shows a custom text input when Custom… is selected for model', () => {
    const configWithModel: Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
    }

    render(withProviders(
      <ConfigEditDialog open={true} config={configWithModel} lineName={LINE} onClose={() => {}} />,
    ))

    const selects = screen.getAllByRole('combobox')
    const modelSelect = selects.find(s => (s as HTMLSelectElement).value === 'claude-sonnet-4-6')
    fireEvent.change(modelSelect as Element, { target: { value: '__custom__' } })

    expect(screen.getByPlaceholderText('Enter custom model ID')).toBeDefined()
  })

  it('gives the custom model text input an explicit accessible name', () => {
    const configWithModel: Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
    }

    render(withProviders(
      <ConfigEditDialog open={true} config={configWithModel} lineName={LINE} onClose={() => {}} />,
    ))

    const selects = screen.getAllByRole('combobox')
    const modelSelect = selects.find(s => (s as HTMLSelectElement).value === 'claude-sonnet-4-6')
    fireEvent.change(modelSelect as Element, { target: { value: '__custom__' } })

    const customInput = screen.getByRole('textbox', { name: 'Custom model ID' })
    expect(customInput).toBe(screen.getByPlaceholderText('Enter custom model ID'))
  })
})

// ---------------------------------------------------------------------------
// agentOptions.sessionScope — enum select within nested agentOptions
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — agentOptions.sessionScope enum', () => {
  it('renders a select for agentOptions.sessionScope with the correct current value', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    // agentOptions.sessionScope has enum ['single', 'shared', 'per_chat']
    const selects = screen.getAllByRole('combobox')
    const scopeSelect = selects.find(s => (s as HTMLSelectElement).value === 'single')
    expect(scopeSelect).not.toBeNull()
    const opts = Array.from((scopeSelect as HTMLSelectElement).options).map(o => o.value)
    expect(opts).toContain('shared')
    expect(opts).toContain('per_chat')
  })

  it('marks agentOptions.sessionScope modified when changed', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const selects = screen.getAllByRole('combobox')
    const scopeSelect = selects.find(s => (s as HTMLSelectElement).value === 'single')
    fireEvent.change(scopeSelect as Element, { target: { value: 'shared' } })

    expect(screen.getByText('modified')).toBeDefined()
  })

  it('serializes agentOptions.sessionScope as a nested object in the api.updateConfig call', async () => {
    // SOURCE SURPRISE: patch keys use dot-notation ("agentOptions.sessionScope") but
    // handleSave calls setValueAtPath() to rebuild the nested object before calling
    // api.updateConfig. Verify the API receives { agentOptions: { sessionScope: 'shared' } }
    // not { 'agentOptions.sessionScope': 'shared' }.
    updateConfigMock.mockResolvedValue(undefined)

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const selects = screen.getAllByRole('combobox')
    const scopeSelect = selects.find(s => (s as HTMLSelectElement).value === 'single')
    fireEvent.change(scopeSelect as Element, { target: { value: 'shared' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    expect(updateConfigMock).toHaveBeenCalledWith(LINE, expect.objectContaining({
      agentOptions: expect.objectContaining({ sessionScope: 'shared' }),
    }))
  })
})

// ---------------------------------------------------------------------------
// TagInput wiring — adminPhones
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — adminPhones TagInput wiring', () => {
  it('associates the adminPhones label with the TagInput control', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    expect(screen.getByLabelText('adminPhones')).toBeDefined()
  })

  it('passes adminPhones values into TagInput stub', () => {
    render(withProviders(
      <ConfigEditDialog
        open={true}
        config={BASE_CONFIG}
        lineName={LINE}
        adminPhonesDisplay={{ '15551234567': 'Alice' }}
        onClose={() => {}}
      />,
    ))

    expect(screen.getByTestId('tag-0').textContent).toBe('Alice')
  })

  it('shows "Add phone number" placeholder for adminPhones TagInput', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    const tagInput = screen.getByTestId('tag-input')
    expect(tagInput.getAttribute('data-placeholder')).toBe('Add phone number')
  })

  it('marks adminPhones modified after adding a tag', () => {
    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    fireEvent.click(screen.getByTestId('tag-add'))

    expect(screen.getByText('modified')).toBeDefined()
  })

  it('saves the changed adminPhones array through api.updateConfig', async () => {
    updateConfigMock.mockResolvedValue(undefined)

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    fireEvent.click(screen.getByTestId('tag-add'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }))
    })

    expect(updateConfigMock).toHaveBeenCalledTimes(1)
    expect(updateConfigMock).toHaveBeenCalledWith(LINE, {
      adminPhones: ['15551234567', '15557654321'],
    })
  })

  it('blocks save and shows error when adminPhones is emptied (validator fires)', async () => {
    updateConfigMock.mockResolvedValue(undefined)

    render(withProviders(
      <ConfigEditDialog open={true} config={BASE_CONFIG} lineName={LINE} onClose={() => {}} />,
    ))

    // Remove the only existing phone — FIELD_VALIDATORS.adminPhones rejects empty array.
    fireEvent.click(screen.getByTestId('tag-remove-0'))

    expect(screen.getByText('At least one admin phone is required')).toBeDefined()
    const saveBtn = screen.getByRole('button', { name: /Save/ })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Empty config
// ---------------------------------------------------------------------------

describe('ConfigEditDialog — empty config', () => {
  it('renders with no visible fields when all keys are excluded', () => {
    const excludedOnly: Record<string, unknown> = {
      name: 'test',
      type: 'agent',
      paths: {},
      healthPort: 9090,
    }

    render(withProviders(
      <ConfigEditDialog open={true} config={excludedOnly} lineName={LINE} onClose={() => {}} />,
    ))

    // Dialog still renders
    expect(screen.getByRole('dialog')).toBeDefined()
    // No modified markers
    expect(screen.queryByText('modified')).toBeNull()
    // Save disabled (no changes)
    const saveBtn = screen.getByRole('button', { name: /^Save$/ })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true)
  })
})
