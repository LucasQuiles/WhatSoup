/**
 * ContactSearchPicker — full behavioral coverage (DD-16, B2).
 *
 * Prior component had NO test file (verified: only structural string-read tests
 * touched it). This file covers:
 *   - 300ms debounce + min-2-chars guard
 *   - Rapid retype collapses to one API call
 *   - API reject → empty results without throw
 *   - In-flight close discards stale response (generation token)
 *   - Add / remove chips with labeled remove buttons
 *   - Selected-JID exclusion from results
 *   - Name fallback chain (name / notify / number / jid) — migrated from the
 *     deleted contact-search.test.tsx so no coverage is lost
 *   - Keyboard contract (Down/Up/Enter)
 *   - Empty results → no listbox rendered
 *   - Combobox aria attributes
 *
 * Fake timers: uses vi.advanceTimersByTimeAsync (flushes Promises + timers) and
 * vi.waitFor (works with fake timers), matching the repo pattern in use-fleet.test.tsx.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import type { ContactResult } from '../../console/src/types.js'

// ---------------------------------------------------------------------------
// Mock the API module before importing the component.
// ---------------------------------------------------------------------------

const searchContactsMock = vi.fn()

vi.mock('../../console/src/lib/api.js', () => ({
  api: {
    searchContacts: (...args: [string, string]) => searchContactsMock(...args),
  },
}))

// Import after vi.mock so the component picks up the mocked module.
const { ContactSearchPicker } = await import(
  '../../console/src/components/shared/ContactSearchPicker'
)

// ---------------------------------------------------------------------------
// Sample fixtures (matching name/notify/number/jid fallback chain)
// ---------------------------------------------------------------------------

const alice: ContactResult = {
  jid: '111@s.whatsapp.net',
  name: 'Alice',
  number: '+1 555 0001',
}
const bob: ContactResult = {
  jid: '222@s.whatsapp.net',
  notify: 'BobNotify',
  number: '+1 555 0002',
}
const unknown: ContactResult = {
  jid: '333@s.whatsapp.net',
}

const sampleContacts: ContactResult[] = [alice, bob, unknown]

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  searchContactsMock.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInput() {
  return screen.getByRole('combobox') as HTMLInputElement
}

function defaultProps(overrides: Partial<Parameters<typeof ContactSearchPicker>[0]> = {}) {
  return {
    lineName: 'line-a',
    selected: [] as ContactResult[],
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  }
}

/** Advance fake timers AND flush queued Promises (repo pattern). */
async function advanceTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

// ---------------------------------------------------------------------------
// Debounce + min-chars guard
// ---------------------------------------------------------------------------

describe('ContactSearchPicker debounce', () => {
  it('does not call API for queries shorter than 2 chars', async () => {
    render(<ContactSearchPicker {...defaultProps()} />)
    const input = getInput()

    fireEvent.change(input, { target: { value: 'a' } })
    await advanceTimers(400)

    expect(searchContactsMock).not.toHaveBeenCalled()
  })

  it('calls API after 300ms debounce for queries ≥ 2 chars', async () => {
    searchContactsMock.mockResolvedValue({ contacts: sampleContacts })
    render(<ContactSearchPicker {...defaultProps()} />)
    const input = getInput()

    fireEvent.change(input, { target: { value: 'al' } })
    // Before debounce fires — no call yet
    expect(searchContactsMock).not.toHaveBeenCalled()

    await advanceTimers(300)
    await vi.waitFor(() => expect(searchContactsMock).toHaveBeenCalledTimes(1))
    expect(searchContactsMock).toHaveBeenCalledWith('line-a', 'al')
  })

  it('rapid retype collapses to one API call (debounce reset)', async () => {
    searchContactsMock.mockResolvedValue({ contacts: [] })
    render(<ContactSearchPicker {...defaultProps()} />)
    const input = getInput()

    fireEvent.change(input, { target: { value: 'al' } })
    await advanceTimers(100)
    fireEvent.change(input, { target: { value: 'ali' } })
    await advanceTimers(100)
    fireEvent.change(input, { target: { value: 'alic' } })
    await advanceTimers(300)

    await vi.waitFor(() => expect(searchContactsMock).toHaveBeenCalledTimes(1))
    expect(searchContactsMock).toHaveBeenCalledWith('line-a', 'alic')
  })
})

// ---------------------------------------------------------------------------
// Results display + name fallback chain
// ---------------------------------------------------------------------------

describe('ContactSearchPicker results', () => {
  it('renders options and falls back through name/notify/number/jid', async () => {
    searchContactsMock.mockResolvedValue({ contacts: sampleContacts })
    render(<ContactSearchPicker {...defaultProps()} />)

    fireEvent.change(getInput(), { target: { value: 'al' } })
    await advanceTimers(300)

    await vi.waitFor(() => expect(screen.queryByRole('listbox')).not.toBeNull())

    // name fallback
    expect(screen.getByText('Alice')).toBeDefined()
    // notify fallback
    expect(screen.getByText('BobNotify')).toBeDefined()
    // jid fallback (unknown contact has no name/notify/number)
    expect(screen.getByText('333@s.whatsapp.net')).toBeDefined()
    // numbers appear alongside
    expect(screen.getByText('+1 555 0001')).toBeDefined()
    expect(screen.getByText('+1 555 0002')).toBeDefined()
  })

  it('shows no listbox when results are empty', async () => {
    searchContactsMock.mockResolvedValue({ contacts: [] })
    render(<ContactSearchPicker {...defaultProps()} />)

    fireEvent.change(getInput(), { target: { value: 'zzz' } })
    await advanceTimers(300)

    await vi.waitFor(() => expect(searchContactsMock).toHaveBeenCalled())
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('API reject → empty results without throwing', async () => {
    searchContactsMock.mockRejectedValue(new Error('network'))
    render(<ContactSearchPicker {...defaultProps()} />)

    fireEvent.change(getInput(), { target: { value: 'al' } })
    await advanceTimers(300)

    await vi.waitFor(() => expect(searchContactsMock).toHaveBeenCalled())
    // No listbox, no throw
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Selection + chip removal
// ---------------------------------------------------------------------------

describe('ContactSearchPicker add/remove', () => {
  it('calls onAdd when an option is selected via click', async () => {
    const onAdd = vi.fn()
    searchContactsMock.mockResolvedValue({ contacts: [alice] })
    render(<ContactSearchPicker {...defaultProps({ onAdd })} />)

    fireEvent.change(getInput(), { target: { value: 'al' } })
    await advanceTimers(300)
    await vi.waitFor(() => expect(screen.queryByRole('listbox')).not.toBeNull())

    // Option accessible name includes the phone number label text — use regex match.
    fireEvent.mouseDown(screen.getByRole('option', { name: /Alice/ }))

    expect(onAdd).toHaveBeenCalledWith(alice)
    await vi.waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  })

  it('renders selected contacts as Pill chips with labeled remove buttons', () => {
    const onRemove = vi.fn()
    render(
      <ContactSearchPicker
        {...defaultProps({
          selected: [alice, bob],
          onRemove,
        })}
      />,
    )

    // Chip labels
    expect(screen.getByText('Alice')).toBeDefined()
    expect(screen.getByText('BobNotify')).toBeDefined()

    // Labeled remove buttons — Pill removable uses "Remove <label>" pattern
    const removeAlice = screen.getByRole('button', { name: 'Remove Alice' })
    expect(removeAlice).toBeDefined()
    const removeBob = screen.getByRole('button', { name: 'Remove BobNotify' })
    expect(removeBob).toBeDefined()

    fireEvent.click(removeAlice)
    expect(onRemove).toHaveBeenCalledWith(alice.jid)
  })

  it('chip remove buttons carry accessible names for jid-only contacts', () => {
    render(
      <ContactSearchPicker
        {...defaultProps({ selected: [unknown] })}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Remove 333@s.whatsapp.net' }),
    ).toBeDefined()
  })

  it('excludes already-selected contacts from results', async () => {
    searchContactsMock.mockResolvedValue({ contacts: sampleContacts })
    render(
      <ContactSearchPicker
        {...defaultProps({ selected: [alice] })}
      />,
    )

    fireEvent.change(getInput(), { target: { value: 'al' } })
    await advanceTimers(300)
    await vi.waitFor(() => expect(screen.queryByRole('listbox')).not.toBeNull())

    // Alice is already selected — must not appear in the listbox
    const options = screen.getAllByRole('option')
    const labels = options.map((o) => o.textContent)
    expect(labels.some((l) => l?.includes('Alice'))).toBe(false)
    // Others still appear
    expect(screen.getByText('BobNotify')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// In-flight close discards stale response (generation token)
// ---------------------------------------------------------------------------

describe('ContactSearchPicker in-flight guard', () => {
  it('response after unmount does not throw or crash', async () => {
    // The generation token ensures that a response resolving after the component
    // has changed state (close() increments the token) is silently discarded.
    // This test verifies there is no "setState on unmounted component" crash.
    let resolveSearch!: (v: { contacts: ContactResult[] }) => void
    searchContactsMock.mockReturnValue(
      new Promise<{ contacts: ContactResult[] }>((res) => {
        resolveSearch = res
      }),
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<ContactSearchPicker {...defaultProps()} />)

    // Trigger a search
    fireEvent.change(getInput(), { target: { value: 'al' } })
    await advanceTimers(300)
    expect(searchContactsMock).toHaveBeenCalledTimes(1)

    // Unmount before response arrives
    unmount()

    // Resolve the in-flight search — must not throw
    await act(async () => {
      resolveSearch({ contacts: sampleContacts })
      await Promise.resolve()
    })

    // The contract: the stale response is silently discarded — React surfaces
    // no error (state updates on unmounted trees log via console.error).
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Keyboard contract
// ---------------------------------------------------------------------------

describe('ContactSearchPicker keyboard navigation', () => {
  it('Down + Enter selects the first result', async () => {
    const onAdd = vi.fn()
    searchContactsMock.mockResolvedValue({ contacts: [alice, bob] })
    render(<ContactSearchPicker {...defaultProps({ onAdd })} />)

    const input = getInput()
    fireEvent.change(input, { target: { value: 'al' } })
    await advanceTimers(300)
    await vi.waitFor(() => expect(screen.queryByRole('listbox')).not.toBeNull())

    // Down sets first option active
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).not.toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledWith(alice)
    await vi.waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  })

  it('arrow keys with zero visible options are no-ops', async () => {
    searchContactsMock.mockResolvedValue({ contacts: [] })
    render(<ContactSearchPicker {...defaultProps()} />)

    fireEvent.change(getInput(), { target: { value: 'zzz' } })
    await advanceTimers(300)

    await vi.waitFor(() => expect(searchContactsMock).toHaveBeenCalled())

    // No crash, no listbox
    expect(() => fireEvent.keyDown(getInput(), { key: 'ArrowDown' })).not.toThrow()
    expect(() => fireEvent.keyDown(getInput(), { key: 'ArrowUp' })).not.toThrow()
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Combobox aria attributes
// ---------------------------------------------------------------------------

describe('ContactSearchPicker combobox aria', () => {
  it('input has role=combobox, aria-haspopup=listbox, aria-autocomplete=list', () => {
    render(<ContactSearchPicker {...defaultProps()} />)
    const input = getInput()
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-haspopup')).toBe('listbox')
    expect(input.getAttribute('aria-autocomplete')).toBe('list')
  })

  it('aria-expanded is false when no results', async () => {
    searchContactsMock.mockResolvedValue({ contacts: [] })
    render(<ContactSearchPicker {...defaultProps()} />)
    fireEvent.change(getInput(), { target: { value: 'al' } })
    await advanceTimers(300)
    await vi.waitFor(() => expect(searchContactsMock).toHaveBeenCalled())
    expect(getInput().getAttribute('aria-expanded')).toBe('false')
  })

  it('aria-controls points to the listbox id when open', async () => {
    searchContactsMock.mockResolvedValue({ contacts: [alice] })
    render(<ContactSearchPicker {...defaultProps()} />)
    fireEvent.change(getInput(), { target: { value: 'al' } })
    await advanceTimers(300)
    await vi.waitFor(() => expect(screen.queryByRole('listbox')).not.toBeNull())

    const controls = getInput().getAttribute('aria-controls')
    expect(controls).not.toBeNull()
    expect(document.getElementById(controls!)).not.toBeNull()
  })

  it('chip pills carry soup-pill class', () => {
    render(<ContactSearchPicker {...defaultProps({ selected: [alice] })} />)
    const pill = document.querySelector('.soup-pill')
    expect(pill).not.toBeNull()
    expect(pill?.textContent).toContain('Alice')
  })
})
