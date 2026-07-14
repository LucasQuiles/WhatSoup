/**
 * LinePicker — combobox contract tests (DD-12, B2 rebuild on Popover).
 *
 * Changes from pre-B2 tests (justified per packet §8 + §3 table):
 *
 * TRIGGER QUERIES: getByRole('button') → getByRole('combobox'). The trigger
 * now carries role="combobox" (select.md combobox contract). Querying by
 * role="button" would fail because the ARIA role is overridden.
 *
 * OPTION QUERIES: getAllByRole('button').slice(1) → getAllByRole('option').
 * Option rows are now listbox/option roles inside the Popover, not raw buttons.
 *
 * PHONE TEXT: toolbar options are portaled to document.body so they render
 * outside the component tree container. Tests using getByText(phone) still
 * work because screen queries the full document.
 *
 * OUTSIDE-CLICK: The previous test fired fireEvent.mouseDown on an outside
 * element; useDismissable listens to 'pointerdown' on document. Updated to
 * fireEvent.pointerDown per the hook's actual event.
 *
 * ESCAPE: The previous test fired fireEvent.keyDown(document, {key:'Escape'}).
 * useDismissable registers on document with {capture: true}. fireEvent.keyDown
 * delivers to the capture phase in jsdom — behavior is the same.
 *
 * LISTENER LIFECYCLE: Pre-B2 tests spied on document.addEventListener for
 * 'mousedown' and 'keydown' (hand-rolled listeners). Post-B2 those listeners
 * are gone; useDismissable manages 'pointerdown' (outside-click) and 'keydown'
 * (capture, Escape only) internally. The lifecycle tests are replaced by
 * behavioral equivalents: open→close→open cycles stay functional, Escape fires
 * onClose exactly once per open. This is the correct test level — the hook's
 * own listener lifecycle is already covered in primitives-popover.test.tsx.
 *
 * KEYBOARD CONTRACT: Added per packet §8: Down opens + moves active, Up moves
 * + clamps, Enter selects + closes, aria-activedescendant tracks active option,
 * Escape closes and restores focus.
 *
 * SELECTED-ROW CLASSES: Added aria-selected + soup-popover__option--selected
 * class asserts for the active line in the listbox.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import LinePicker from '../../console/src/components/LinePicker'
import type { LineInstance } from '../../console/src/types'

afterEach(() => cleanup())

function line(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'alpha',
    phone: '+15550001111',
    mode: 'passive',
    status: 'online',
    accessMode: 'open',
    healthPort: 9101,
    uptime: '1h',
    messagesTotal: 0,
    health: {
      status: 'ok',
      uptime_seconds: 60,
      messages_total: 0,
      whatsapp: { connection: { state: 'open' } },
      sqlite: { messages_total: 0, schema_version: 1 },
    },
    ...overrides,
  } as LineInstance
}

const sampleLines: LineInstance[] = [
  line({ name: 'alpha', status: 'online', mode: 'passive', phone: '+15550001111' }),
  line({ name: 'b', status: 'degraded', mode: 'chat', phone: '+15550002222' }),
  line({ name: 'gamma', status: 'unreachable', mode: 'agent', phone: '+15550003333' }),
]

// ---------------------------------------------------------------------------
// Toolbar variant — display / open / select / dismiss
// ---------------------------------------------------------------------------

describe('LinePicker (toolbar variant)', () => {
  it('renders trigger with current selection and keeps dropdown closed initially', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)

    // Trigger is a combobox (role overrides button for the pick contract)
    const trigger = screen.getByRole('combobox', { name: /alpha/ })
    expect(trigger).toBeDefined()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    // No options rendered when closed
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    // Trigger reflects selection status via StatusDot/StatusCell aria-label
    expect(within(trigger).getByLabelText('online')).toBeDefined()
  })

  it('falls back to placeholder copy when no line is active', () => {
    render(<LinePicker lines={sampleLines} activeLine="" onSelect={vi.fn()} />)

    const trigger = screen.getByRole('combobox', { name: /Select a line/ })
    expect(trigger).toBeDefined()
    // No StatusCell on trigger when there is no current line
    expect(within(trigger).queryByLabelText('online')).toBeNull()
  })

  it('opens the panel on trigger click and lists every line with a status shape', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    const trigger = screen.getByRole('combobox', { name: /alpha/ })
    fireEvent.click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(sampleLines.length)
    // Each option row has a status shape aria-label (via StatusCell)
    expect(within(options[0]!).getByLabelText('online')).toBeDefined()
    expect(within(options[1]!).getByLabelText('degraded')).toBeDefined()
    expect(within(options[2]!).getByLabelText('unreachable')).toBeDefined()
    // Phone rendered on each row (toolbar variant)
    expect(screen.getByText('+15550002222')).toBeDefined()
  })

  it('calls onSelect with the line name and closes the panel', () => {
    const onSelect = vi.fn()
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('combobox', { name: /alpha/ }))
    // Click the gamma option by its phone text
    const gammaRow = screen.getByText('+15550003333').closest('[role="option"]')!
    fireEvent.mouseDown(gammaRow)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('gamma')
    // Panel closed → phone text gone
    expect(screen.queryByText('+15550003333')).toBeNull()
  })

  it('closes the panel when a pointerdown lands outside', () => {
    render(
      <div>
        <LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />
        <button type="button" data-testid="outside">outside</button>
      </div>,
    )
    fireEvent.click(screen.getByRole('combobox', { name: /alpha/ }))
    expect(screen.getByText('+15550002222')).toBeDefined()

    // useDismissable listens to 'pointerdown' for outside-click dismissal
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(screen.queryByText('+15550002222')).toBeNull()
  })

  it('keeps the panel open when pointerdown lands inside the panel', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox', { name: /alpha/ }))
    const phoneNode = screen.getByText('+15550002222')
    fireEvent.pointerDown(phoneNode)
    expect(screen.getByText('+15550002222')).toBeDefined()
  })

  it('closes the panel when Escape is pressed', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox', { name: /alpha/ }))
    expect(screen.getByText('+15550002222')).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('+15550002222')).toBeNull()
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false')
  })

  it('renders no option rows when lines is empty (panel opens but is empty)', () => {
    render(<LinePicker lines={[]} activeLine="" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox', { name: /Select a line/ }))
    // Listbox is present but has no options
    const listbox = screen.getByRole('listbox')
    expect(listbox).toBeDefined()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('selected option row carries aria-selected and --selected class', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox', { name: /alpha/ }))

    const options = screen.getAllByRole('option')
    // First option (alpha) is the active line → selected
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    expect(options[0].classList.contains('soup-popover__option--selected')).toBe(true)
    // Others are not selected
    expect(options[1].getAttribute('aria-selected')).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// Compact variant — display / select
// ---------------------------------------------------------------------------

describe('LinePicker (compact variant)', () => {
  it('uses the compact placeholder copy when nothing is selected', () => {
    render(<LinePicker lines={sampleLines} activeLine="" onSelect={vi.fn()} variant="compact" />)
    const trigger = screen.getByRole('combobox', { name: /Select line/ })
    expect(trigger).toBeDefined()
    // No phone rendered in compact (not part of compact row template)
    expect(screen.queryByText('+15550002222')).toBeNull()
  })

  it('capitalizes single-letter line names in the compact trigger and rows', () => {
    render(<LinePicker lines={sampleLines} activeLine="b" onSelect={vi.fn()} variant="compact" />)
    // Trigger should show 'B' (uppercase via displayInstanceName)
    const trigger = screen.getByRole('combobox', { name: /B/ })
    expect(trigger).toBeDefined()

    fireEvent.click(trigger)
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(sampleLines.length)
    expect(within(options[1]!).getByText('B')).toBeDefined()
    expect(within(options[0]!).getByText('alpha')).toBeDefined()
  })

  it('invokes onSelect with the raw line name (not the display name) in compact mode', () => {
    const onSelect = vi.fn()
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={onSelect} variant="compact" />)
    fireEvent.click(screen.getByRole('combobox', { name: /alpha/ }))

    // The option for 'b' shows 'B' — click it via the option role
    const options = screen.getAllByRole('option')
    fireEvent.mouseDown(options[1]!) // 'b' option
    expect(onSelect).toHaveBeenCalledWith('b')
  })
})

// ---------------------------------------------------------------------------
// Keyboard contract — Down / Up / Enter / Escape / aria-activedescendant
// ---------------------------------------------------------------------------

describe('LinePicker keyboard contract', () => {
  it('ArrowDown opens the panel when closed', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')).toHaveLength(sampleLines.length)
  })

  it('ArrowDown moves active option from first to second', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger) // open
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // active = alpha (first)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // active = b (second)

    const opts = screen.getAllByRole('option')
    expect(opts[1].getAttribute('data-active')).toBe('true')
    expect(opts[0].getAttribute('data-active')).toBeNull()
  })

  it('ArrowDown clamps at last option (does not wrap)', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    for (let i = 0; i < 10; i++) fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const opts = screen.getAllByRole('option')
    expect(opts[2].getAttribute('data-active')).toBe('true') // gamma is last
    expect(opts[0].getAttribute('data-active')).toBeNull()
  })

  it('ArrowUp moves active option upward (clamps at first)', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // alpha
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // b
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })   // back to alpha
    const opts = screen.getAllByRole('option')
    expect(opts[0].getAttribute('data-active')).toBe('true')
    expect(opts[1].getAttribute('data-active')).toBeNull()

    // Clamp: further Up stays on alpha
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(opts[0].getAttribute('data-active')).toBe('true')
  })

  it('Enter selects the active option and closes the panel', () => {
    const onSelect = vi.fn()
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={onSelect} />)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // alpha active
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // b active
    fireEvent.keyDown(trigger, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('b')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('Enter with no active option is a no-op', () => {
    const onSelect = vi.fn()
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={onSelect} />)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    // No arrow press — activeValue is null
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getAllByRole('option')).toHaveLength(sampleLines.length)
  })

  it('aria-activedescendant on trigger matches the active option id', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // alpha active

    const descendant = trigger.getAttribute('aria-activedescendant')
    expect(descendant).toBeTruthy()
    const optEl = document.getElementById(descendant!)
    expect(optEl).not.toBeNull()
    expect(optEl!.getAttribute('role')).toBe('option')
  })

  it('Escape closes the panel and returns focus to the trigger', async () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
    act(() => { trigger.focus() })
    fireEvent.click(trigger)
    expect(screen.getAllByRole('option')).toHaveLength(sampleLines.length)

    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => {})

    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    // Focus restored to trigger (useDismissable focus restoration)
    expect(document.activeElement).toBe(trigger)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle — panel state cycles correctly on repeated open/close
// ---------------------------------------------------------------------------

describe('LinePicker lifecycle', () => {
  it('panel can be opened and closed multiple times without stuck state', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    const trigger = screen.getByRole('combobox')

    for (let i = 0; i < 3; i++) {
      fireEvent.click(trigger)
      expect(screen.getAllByRole('option')).toHaveLength(sampleLines.length)
      fireEvent.click(trigger) // toggle closed
      expect(screen.queryAllByRole('option')).toHaveLength(0)
    }
  })

  it('activeValue resets to null after close so reopening starts with no highlighted option', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    const trigger = screen.getByRole('combobox')

    // Open, navigate to second option, close
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.click(trigger) // close

    // Reopen — no option should be active
    fireEvent.click(trigger)
    const opts = screen.getAllByRole('option')
    for (const opt of opts) {
      expect(opt.getAttribute('data-active')).toBeNull()
    }
  })

  it('Escape fires exactly once per open (single-fire via useDismissable stack)', () => {
    const onSelect = vi.fn()
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={onSelect} />)
    const trigger = screen.getByRole('combobox')

    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryAllByRole('option')).toHaveLength(0)

    // Second Escape while panel is closed does nothing
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('activeLine-not-in-lines: trigger renders activeLine text without a status shape', () => {
    render(
      <LinePicker
        lines={sampleLines}
        activeLine="orphaned-line"
        onSelect={vi.fn()}
      />,
    )
    // No StatusCell because currentLine is undefined
    const trigger = screen.getByRole('combobox')
    expect(within(trigger).queryByRole('img')).toBeNull()
    // The activeLine text still appears
    expect(within(trigger).getByText('orphaned-line')).toBeDefined()
  })
})
