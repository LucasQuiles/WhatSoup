/**
 * IdentityStep — behavior coverage
 *
 * Covers: initial render, field display, type selection via CardSelector,
 * slug derivation (live keystroke normalization), name availability checking
 * debounce flow, description field check-mark, adminPhones wiring via TagInput,
 * nameLocked prop, error display, and onChange callback forwarding.
 *
 * Behavior notes pinned below.
 *
 * 1. The name <input> forwards `slugAgentWorkspaceName(e.target.value)` on
 *    every change event. The component stores the already-normalized value,
 *    not the raw display string. Emoji and punctuation are stripped immediately.
 * 2. There is NO "Next" button inside IdentityStep itself — Next-button gating
 *    lives in the parent Wizard. The component only forwards onChange/errors.
 * 3. adminPhones strips non-digits via `values.map(v => v.replace(/\D/g, ''))`.
 *    The TagInput's own `validate` is `validatePhone` (≥10, ≤15 digits after
 *    normalization). "555-123-4567" → TagInput receives "555-123-4567", calls
 *    validatePhone which normalizes to "15551234567" (11 digits) — valid.
 *    IdentityStep then strips non-digits from "555-123-4567" → "5551234567"
 *    (10 digits), so onChange receives "5551234567".
 * 4. The `showConfirmed` state delays check-mark indicators by 300 ms on mount.
 *    In tests we use `act` + fake timers to advance past that gate.
 * 5. The uniqueness-check debounce fires after 500 ms for non-empty slugs and
 *    0 ms for empty slugs. Tests use `vi.advanceTimersByTime(500)` inside `act`
 *    to drive the debounce without `waitFor`, which polls real setInterval and
 *    deadlocks under fake timers.
 * 6. The Check icon appears for `nameStatus === 'available' || nameLocked`
 *    regardless of showConfirmed. The description/adminPhones Check icons DO
 *    depend on showConfirmed.
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
  type MockedFunction,
} from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

// Mock the api module before importing the component so the debounced
// useEffect resolves against our stub instead of the real HTTP client.
vi.mock('../../console/src/lib/api', () => ({
  api: {
    checkExists: vi.fn(),
  },
}))

import { api } from '../../console/src/lib/api'
import IdentityStep from '../../console/src/components/wizard/IdentityStep'

const mockCheckExists = api.checkExists as MockedFunction<typeof api.checkExists>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RenderOpts {
  data?: Record<string, unknown>
  errors?: Record<string, string>
  nameLocked?: boolean
}

function renderStep(opts: RenderOpts = {}) {
  const onChange = vi.fn()
  const data: Record<string, unknown> = opts.data ?? {}
  const utils = render(
    <IdentityStep
      data={data}
      onChange={onChange}
      errors={opts.errors ?? {}}
      nameLocked={opts.nameLocked}
    />,
  )
  return { onChange, ...utils }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
  mockCheckExists.mockReset()
  // Default: name is available
  mockCheckExists.mockResolvedValue({ exists: false })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

describe('initial render', () => {
  it('renders the Type, Name, Description, and Admin Phones sections', () => {
    renderStep()
    expect(screen.getByText('Type')).toBeDefined()
    expect(screen.getByPlaceholderText('my-line')).toBeDefined()
    expect(screen.getByText(/description/i)).toBeDefined()
    expect(screen.getByText('Admin Phones')).toBeDefined()
  })

  it('renders the Description field via the canonical Field (optional marker, not a raw inline span)', () => {
    // W2-S5 DD-43: Description migrated onto <Field optional> — the "(optional)" hint is now the
    // canonical c-optional-marker (aria-hidden), not a hand-rolled text-text-3 span in the label.
    renderStep()
    const marker = document.querySelector('.c-optional-marker') as HTMLElement
    expect(marker).not.toBeNull()
    expect(marker.textContent).toMatch(/optional/i)
    expect(marker.getAttribute('aria-hidden')).toBe('true')
    // the old ad-hoc pattern is gone: no text-text-3 span carrying "(optional)"
    const adhocOptional = [...document.querySelectorAll('span.text-text-3')]
      .some((s) => /optional/i.test(s.textContent ?? ''))
    expect(adhocOptional).toBe(false)
  })

  it('shows the three type options: Passive, Chat, Agent', () => {
    renderStep()
    expect(screen.getByText('Passive')).toBeDefined()
    expect(screen.getByText('Chat')).toBeDefined()
    expect(screen.getByText('Agent')).toBeDefined()
  })

  it('does not call onChange on mount (no auto-selection side effect)', () => {
    const { onChange } = renderStep({ data: {} })
    act(() => { vi.runAllTimers() })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reads name, description, type, adminPhones from data prop', () => {
    renderStep({
      data: {
        name: 'my-line',
        description: 'A test line',
        type: 'passive',
        adminPhones: ['15551234567'],
      },
    })
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement
    expect(nameInput.value).toBe('my-line')

    const descInput = screen.getByLabelText(/Description/) as HTMLInputElement
    expect(descInput.value).toBe('A test line')

    expect(screen.getByText('15551234567')).toBeDefined()
  })

  it('defaults name and description to empty strings when data is empty', () => {
    renderStep({ data: {} })
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement
    expect(nameInput.value).toBe('')
    const descInput = screen.getByLabelText(/Description/) as HTMLInputElement
    expect(descInput.value).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Slug derivation — the core naming behavior
// ---------------------------------------------------------------------------

describe('slug derivation on name input', () => {
  it('lowercases input when user types uppercase', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: 'ABC' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'abc' })
  })

  it('replaces spaces with dashes', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: 'my line' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'my-line' })
  })

  it('strips non-alphanumeric non-dash characters (e.g. underscores, dots)', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: 'my_line.v2' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'mylinev2' })
  })

  it('produces an empty string for pure emoji input', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: '🚀' } })
    expect(onChange).toHaveBeenCalledWith({ name: '' })
  })

  it('preserves digits in the name', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: 'line-42' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'line-42' })
  })

  it('produces an empty string for all-special-char input', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: '!@#$%' } })
    expect(onChange).toHaveBeenCalledWith({ name: '' })
  })

  it('preserves existing dashes', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: 'a-b-c' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'a-b-c' })
  })

  it('collapses whitespace runs to one dash', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: 'my  line' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'my-line' })
  })

  it('collapses repeated dashes produced by whitespace and typed dashes', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: 'my - line' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'my-line' })
  })

  it('trims leading spaces so no leading dash appears', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: ' leading' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'leading' })
  })

  it('trims trailing spaces so no trailing dash appears', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: 'trailing ' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'trailing' })
  })

  it('trims leading and trailing dash separators after slugging', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('my-line')
    fireEvent.change(input, { target: { value: ' -Leading Line- ' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'leading-line' })
  })
})

// ---------------------------------------------------------------------------
// Name uniqueness check (debounced API call)
// ---------------------------------------------------------------------------

describe('name uniqueness check', () => {
  it('calls api.checkExists with the slugified name after 500ms debounce', async () => {
    // Render with a pre-set name — the component's useEffect fires on mount
    // and debounces the API call. Since `name` comes from props (controlled),
    // we render with the final name directly.
    renderStep({ data: { name: 'my-line' } })
    // Not called immediately (debounce pending)
    expect(mockCheckExists).not.toHaveBeenCalled()
    // Advance past debounce and flush promises
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(mockCheckExists).toHaveBeenCalledWith('my-line')
  })

  it('shows "Name already exists" error when name is taken', async () => {
    mockCheckExists.mockResolvedValue({ exists: true })
    renderStep({ data: { name: 'taken-name' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(screen.getByText('Name already exists')).toBeDefined()
  })

  it('does not show "Name already exists" when name is available', async () => {
    mockCheckExists.mockResolvedValue({ exists: false })
    renderStep({ data: { name: 'my-line' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(screen.queryByText('Name already exists')).toBeNull()
  })

  it('aborts in-flight check when name changes before debounce fires', async () => {
    // The component is controlled: name comes from data prop.
    // Simulate rapid prop changes (as the wizard parent would do).
    const onChange = vi.fn()
    const { rerender } = render(
      <IdentityStep data={{ name: 'first' }} onChange={onChange} errors={{}} />,
    )
    // Not called immediately
    expect(mockCheckExists).not.toHaveBeenCalled()
    // Change the prop before 500ms elapses to simulate debounce reset
    await act(async () => { vi.advanceTimersByTime(200) })
    rerender(
      <IdentityStep data={{ name: 'second' }} onChange={onChange} errors={{}} />,
    )
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    // Only the final value triggers a check
    expect(mockCheckExists).toHaveBeenCalledWith('second')
    expect(mockCheckExists).toHaveBeenCalledTimes(1)
  })

  it('resets to idle and does not call api.checkExists when name is cleared', async () => {
    // Component is controlled: name comes from data prop, not DOM state.
    // Simulate the parent clearing the name by rerendering with empty data.
    const onChange = vi.fn()
    const { rerender } = render(
      <IdentityStep data={{ name: 'some-name' }} onChange={onChange} errors={{}} />,
    )
    // Let initial debounce fire so we have a clean baseline
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(mockCheckExists).toHaveBeenCalledWith('some-name')
    mockCheckExists.mockClear()

    // Parent clears the name — rerender with empty string
    rerender(
      <IdentityStep data={{ name: '' }} onChange={onChange} errors={{}} />,
    )
    // Empty slug triggers 0ms debounce that sets status→idle without calling checkExists
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })
    expect(mockCheckExists).not.toHaveBeenCalled()
    // "Name already exists" must not be showing (idle state)
    expect(screen.queryByText('Name already exists')).toBeNull()
  })

  it('does not show "Name already exists" for an idle state (empty name)', () => {
    renderStep({ data: {} })
    expect(screen.queryByText('Name already exists')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Type selection (CardSelector)
// ---------------------------------------------------------------------------

describe('type selection', () => {
  it('calls onChange with the selected type when a card is clicked', () => {
    const { onChange } = renderStep({ data: { type: 'chat' } })
    fireEvent.click(screen.getByText('Passive'))
    expect(onChange).toHaveBeenCalledWith({ type: 'passive' })
  })

  it('calls onChange with "agent" when Agent card is clicked', () => {
    const { onChange } = renderStep({ data: { type: 'chat' } })
    fireEvent.click(screen.getByText('Agent'))
    expect(onChange).toHaveBeenCalledWith({ type: 'agent' })
  })

  it('calls onChange with "chat" when Chat card is clicked', () => {
    const { onChange } = renderStep({ data: { type: 'passive' } })
    fireEvent.click(screen.getByText('Chat'))
    expect(onChange).toHaveBeenCalledWith({ type: 'chat' })
  })

  it('shows a type error when errors.type is set', () => {
    renderStep({ errors: { type: 'Type is required' } })
    expect(screen.getByText('Type is required')).toBeDefined()
  })

  it('marks the type radiogroup invalid and describes it with the type error', () => {
    renderStep({ errors: { type: 'Type is required' } })

    const group = screen.getByRole('radiogroup', { name: 'Line Type' })
    const error = screen.getByText('Type is required')

    expect(error.id).toBeTruthy()
    expect(group.getAttribute('aria-invalid')).toBe('true')
    expect(group.getAttribute('aria-describedby')).toBe(error.id)
  })

  it('renders all three type option descriptions', () => {
    renderStep()
    expect(screen.getByText('Listen & store messages. No AI responses.')).toBeDefined()
    expect(screen.getByText('Conversational AI bot with API key.')).toBeDefined()
    expect(screen.getByText(/agent with tool access/)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Description field
// ---------------------------------------------------------------------------

describe('description field', () => {
  it('calls onChange with updated description on input', () => {
    const { onChange } = renderStep({ data: { description: '' } })
    const input = screen.getByPlaceholderText('What this line is for')
    fireEvent.change(input, { target: { value: 'A test description' } })
    expect(onChange).toHaveBeenCalledWith({ description: 'A test description' })
  })

  it('passes description through raw without slugification', () => {
    const { onChange } = renderStep()
    const input = screen.getByPlaceholderText('What this line is for')
    fireEvent.change(input, { target: { value: 'My Line: for testing!' } })
    expect(onChange).toHaveBeenCalledWith({ description: 'My Line: for testing!' })
  })

  it('forwards an empty description without error', () => {
    const { onChange } = renderStep({ data: { description: 'old' } })
    const input = screen.getByPlaceholderText('What this line is for')
    fireEvent.change(input, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ description: '' })
  })
})

// ---------------------------------------------------------------------------
// Admin Phones (TagInput wiring)
// ---------------------------------------------------------------------------

describe('admin phones field', () => {
  it('shows instructional helper text when no phones configured', () => {
    renderStep({ data: { adminPhones: [] } })
    expect(screen.getByText(/Phone numbers with full admin access/)).toBeDefined()
  })

  it('shows single-phone helper when exactly one phone configured', () => {
    renderStep({ data: { adminPhones: ['15551234567'] } })
    expect(screen.getByText(/Add another number for shared admin access/)).toBeDefined()
  })

  it('shows count helper text when two or more phones configured', () => {
    renderStep({ data: { adminPhones: ['15551234567', '15559876543'] } })
    expect(screen.getByText('2 admin numbers configured.')).toBeDefined()
  })

  it('calls onChange with digits-only array when a valid phone is added via Enter', () => {
    const { onChange } = renderStep({ data: { adminPhones: [] } })
    const tagInput = screen.getByPlaceholderText('Enter phone number (press Enter to add)')
    fireEvent.change(tagInput, { target: { value: '15551234567' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ adminPhones: ['15551234567'] })
  })

  it('strips non-digit characters from phone values passed to onChange', () => {
    // Source surprise §4: IdentityStep strips via .replace(/\D/g, '') after TagInput adds.
    // "555-123-4567" passes TagInput's validatePhone (normalizePhoneInput yields "15551234567")
    // then IdentityStep strips dashes → "5551234567"
    const { onChange } = renderStep({ data: { adminPhones: [] } })
    const tagInput = screen.getByPlaceholderText('Enter phone number (press Enter to add)')
    fireEvent.change(tagInput, { target: { value: '555-123-4567' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ adminPhones: ['5551234567'] })
  })

  it('does not add invalid phones (fewer than 10 digits after normalization)', () => {
    const { onChange } = renderStep({ data: { adminPhones: [] } })
    const tagInput = screen.getByPlaceholderText('Enter phone number (press Enter to add)')
    fireEvent.change(tagInput, { target: { value: '123' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    // TagInput validate blocks short numbers — onChange is not called at all
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows adminPhones error when errors.adminPhones is set', () => {
    renderStep({ errors: { adminPhones: 'At least one admin required' } })
    expect(screen.getByText('At least one admin required')).toBeDefined()
  })

  it('describes the admin phone input with the error and suppresses the helper when invalid', () => {
    // W2-S5: migrated onto Field, which renders hint OR error (input.md
    // [label][control][hint|error]) — an error hides the helper and is the described element.
    renderStep({ errors: { adminPhones: 'At least one admin required' } })

    const input = screen.getByLabelText('Admin Phones') as HTMLInputElement
    const error = screen.getByText('At least one admin required')

    expect(screen.queryByText(/Phone numbers with full admin access/)).toBeNull()
    expect(error.id).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
  })

  it('describes the admin phone input with the helper when there is no error', () => {
    renderStep()
    const input = screen.getByLabelText('Admin Phones') as HTMLInputElement
    const helper = screen.getByText(/Phone numbers with full admin access/)
    expect(helper.id).toBeTruthy()
    expect(input.getAttribute('aria-describedby')).toBe(helper.id)
    expect(input.getAttribute('aria-invalid')).toBeNull()
  })

  it('renders existing phone tags in the display', () => {
    renderStep({ data: { adminPhones: ['15551234567'] } })
    expect(screen.getByText('15551234567')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// nameLocked prop
// ---------------------------------------------------------------------------

describe('nameLocked prop', () => {
  it('disables the name input when nameLocked is true', () => {
    renderStep({ data: { name: 'locked-line' }, nameLocked: true })
    const input = screen.getByLabelText('Name') as HTMLInputElement
    expect(input.disabled).toBe(true)
  })

  it('shows the locked helper text when nameLocked is true', () => {
    renderStep({ data: { name: 'locked-line' }, nameLocked: true })
    expect(screen.getByText('Name is locked — instance already provisioned')).toBeDefined()
  })

  it('does not show the locked helper text when nameLocked is false', () => {
    renderStep({ data: { name: 'my-line' }, nameLocked: false })
    expect(screen.queryByText('Name is locked — instance already provisioned')).toBeNull()
  })

  it('does not show the locked helper text when nameLocked is omitted', () => {
    renderStep({ data: { name: 'my-line' } })
    expect(screen.queryByText('Name is locked — instance already provisioned')).toBeNull()
  })

  it('does not show "Name already exists" when nameLocked is true', async () => {
    // When locked, the "Name already exists" display is gated by `!nameLocked`
    mockCheckExists.mockResolvedValue({ exists: true })
    renderStep({ data: { name: 'locked-line' }, nameLocked: true })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(screen.queryByText('Name already exists')).toBeNull()
  })

  it('name input is enabled when nameLocked is false', () => {
    renderStep({ data: { name: 'my-line' }, nameLocked: false })
    const input = screen.getByLabelText('Name') as HTMLInputElement
    expect(input.disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Error display from parent (passed via errors prop)
// ---------------------------------------------------------------------------

describe('error display', () => {
  it('shows name error from errors.name prop', () => {
    renderStep({ errors: { name: 'Name is required' } })
    expect(screen.getByText('Name is required')).toBeDefined()
  })

  it('marks the name input invalid and describes it with the name error', () => {
    renderStep({ errors: { name: 'Name is required' } })

    const input = screen.getByLabelText('Name') as HTMLInputElement
    const error = screen.getByText('Name is required')

    expect(error.id).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
  })

  it('shows type error from errors.type prop', () => {
    renderStep({ errors: { type: 'Type must be selected' } })
    expect(screen.getByText('Type must be selected')).toBeDefined()
  })

  it('shows adminPhones error from errors.adminPhones prop', () => {
    renderStep({ errors: { adminPhones: 'Admin phone required' } })
    expect(screen.getByText('Admin phone required')).toBeDefined()
  })

  it('shows no errors when errors prop is empty', () => {
    renderStep({ errors: {} })
    expect(screen.queryByText('Name is required')).toBeNull()
    expect(screen.queryByText('Type must be selected')).toBeNull()
    expect(screen.queryByText('Admin phone required')).toBeNull()
  })

  it('resolves to the uniqueness error when both format and taken-name errors apply (priority rule)', async () => {
    // W2-S5 (owner round-5): Field shows ONE error; priority is nameLocked-helper >
    // nameTaken-error > errors.name. With both a format error and a taken name, taken wins.
    mockCheckExists.mockResolvedValue({ exists: true })
    renderStep({ data: { name: 'taken' }, errors: { name: 'Invalid name format' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(screen.getByText('Name already exists')).toBeDefined()
    expect(screen.queryByText('Invalid name format')).toBeNull()
  })

  it('describes the name input with the single resolved error id (priority rule)', async () => {
    mockCheckExists.mockResolvedValue({ exists: true })
    renderStep({ data: { name: 'taken' }, errors: { name: 'Invalid name format' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    const input = screen.getByLabelText('Name') as HTMLInputElement
    const uniquenessError = screen.getByText('Name already exists')

    expect(uniquenessError.id).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    // Field wires aria-describedby to the one rendered error (the format error is suppressed).
    expect(input.getAttribute('aria-describedby')).toBe(uniquenessError.id)
  })
})

// ---------------------------------------------------------------------------
// onChange forwarding — patch shape
// ---------------------------------------------------------------------------

describe('onChange forwarding', () => {
  it('forwards onChange patch for name field with slugified value', () => {
    const { onChange } = renderStep()
    fireEvent.change(screen.getByPlaceholderText('my-line'), { target: { value: 'Test Line' } })
    expect(onChange).toHaveBeenCalledWith({ name: 'test-line' })
  })

  it('forwards onChange patch for description field with raw value', () => {
    const { onChange } = renderStep()
    fireEvent.change(screen.getByPlaceholderText('What this line is for'), { target: { value: 'hello world' } })
    expect(onChange).toHaveBeenCalledWith({ description: 'hello world' })
  })

  it('forwards onChange patch for type selection', () => {
    const { onChange } = renderStep({ data: { type: 'chat' } })
    fireEvent.click(screen.getByText('Agent'))
    expect(onChange).toHaveBeenCalledWith({ type: 'agent' })
  })

  it('onChange patches are single-key objects (not merged diffs)', () => {
    // Each field emits its own single-key patch; merging is the parent's job
    const { onChange } = renderStep()
    fireEvent.change(screen.getByPlaceholderText('my-line'), { target: { value: 'my-line' } })
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    expect(Object.keys(lastCall)).toEqual(['name'])
  })
})
