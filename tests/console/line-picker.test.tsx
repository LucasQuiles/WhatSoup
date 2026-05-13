/**
 * LinePicker — open/close, selection, click-outside, Escape, listener cleanup.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
      connection: { state: 'open' },
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

describe('LinePicker (toolbar variant)', () => {
  it('renders trigger with current selection and keeps dropdown closed initially', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: /alpha/ })
    expect(trigger).toBeDefined()
    // No option buttons rendered when closed — only the 1 trigger.
    expect(screen.getAllByRole('button')).toHaveLength(1)
    // Trigger reflects selection status via StatusDot aria-label.
    expect(within(trigger).getByLabelText('online')).toBeDefined()
  })

  it('falls back to placeholder copy when no line is active', () => {
    render(<LinePicker lines={sampleLines} activeLine="" onSelect={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Select a line/ })).toBeDefined()
    // No StatusDot on trigger when there is no current line.
    expect(screen.queryByLabelText('online')).toBeNull()
  })

  it('opens the dropdown on trigger click and lists every line with a status dot', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /alpha/ }))

    const options = screen.getAllByRole('button').slice(1) // first is the trigger
    expect(options).toHaveLength(sampleLines.length)
    expect(within(options[0]!).getByLabelText('online')).toBeDefined()
    expect(within(options[1]!).getByLabelText('degraded')).toBeDefined()
    expect(within(options[2]!).getByLabelText('unreachable')).toBeDefined()
    // Phone rendered on each row (toolbar variant).
    expect(screen.getByText('+15550002222')).toBeDefined()
  })

  it('calls onSelect with the line name and closes the dropdown', () => {
    const onSelect = vi.fn()
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /alpha/ }))
    // Find row by its phone text, then click the enclosing button.
    const gammaRow = screen.getByText('+15550003333').closest('button')!
    fireEvent.click(gammaRow)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('gamma')
    // Dropdown closed → phone text gone.
    expect(screen.queryByText('+15550003333')).toBeNull()
  })

  it('closes the dropdown when a mousedown lands outside the picker', () => {
    render(
      <div>
        <LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />
        <button type="button" data-testid="outside">outside</button>
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: /alpha/ }))
    expect(screen.getByText('+15550002222')).toBeDefined()

    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByText('+15550002222')).toBeNull()
  })

  it('keeps the dropdown open when mousedown lands inside the picker', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /alpha/ }))
    // mousedown on the dropdown container itself (not a row) should NOT close.
    const phoneNode = screen.getByText('+15550002222')
    fireEvent.mouseDown(phoneNode)
    expect(screen.getByText('+15550002222')).toBeDefined()
  })

  it('closes the dropdown when Escape is pressed', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /alpha/ }))
    expect(screen.getByText('+15550002222')).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('+15550002222')).toBeNull()
  })

  it('ignores non-Escape keys while open', () => {
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /alpha/ }))

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByText('+15550002222')).toBeDefined()
  })

  it('renders no option rows when lines is empty (dropdown body still opens)', () => {
    render(<LinePicker lines={[]} activeLine="" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Select a line/ }))
    // Only the trigger button — no row buttons.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

describe('LinePicker (compact variant)', () => {
  it('uses the compact placeholder copy when nothing is selected', () => {
    render(<LinePicker lines={sampleLines} activeLine="" onSelect={vi.fn()} variant="compact" />)
    expect(screen.getByRole('button', { name: /Select line/ })).toBeDefined()
    // No phone rendered in compact rows (different template).
    expect(screen.queryByText('+15550002222')).toBeNull()
  })

  it('capitalizes single-letter line names in the compact trigger and rows', () => {
    render(<LinePicker lines={sampleLines} activeLine="b" onSelect={vi.fn()} variant="compact" />)
    // Trigger should show 'B' (uppercase via displayInstanceName).
    const trigger = screen.getByRole('button', { name: /B/ })
    expect(trigger).toBeDefined()

    fireEvent.click(trigger)
    // 'alpha' stays lowercase (>1 char); 'b' becomes 'B' in the row.
    const rows = screen.getAllByRole('button').slice(1)
    expect(rows).toHaveLength(sampleLines.length)
    expect(within(rows[1]!).getByText('B')).toBeDefined()
    expect(within(rows[0]!).getByText('alpha')).toBeDefined()
  })

  it('invokes onSelect with the raw line name (not the display name) in compact mode', () => {
    const onSelect = vi.fn()
    render(<LinePicker lines={sampleLines} activeLine="alpha" onSelect={onSelect} variant="compact" />)
    fireEvent.click(screen.getByRole('button', { name: /alpha/ }))

    fireEvent.click(screen.getByText('B').closest('button')!)
    expect(onSelect).toHaveBeenCalledWith('b')
  })
})

describe('LinePicker listener lifecycle', () => {
  it('only attaches mousedown/keydown listeners while open and removes them on close', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { unmount } = render(
      <LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />,
    )
    // Closed at mount → no listeners attached for our events yet.
    expect(addSpy.mock.calls.some(([evt]) => evt === 'mousedown')).toBe(false)
    expect(addSpy.mock.calls.some(([evt]) => evt === 'keydown')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /alpha/ }))
    expect(addSpy.mock.calls.some(([evt]) => evt === 'mousedown')).toBe(true)
    expect(addSpy.mock.calls.some(([evt]) => evt === 'keydown')).toBe(true)

    // Close via Escape and confirm both listeners are torn down.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(removeSpy.mock.calls.some(([evt]) => evt === 'mousedown')).toBe(true)
    expect(removeSpy.mock.calls.some(([evt]) => evt === 'keydown')).toBe(true)

    unmount()
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('removes any open-state listeners on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(
      <LinePicker lines={sampleLines} activeLine="alpha" onSelect={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /alpha/ }))
    removeSpy.mockClear()
    unmount()

    expect(removeSpy.mock.calls.some(([evt]) => evt === 'mousedown')).toBe(true)
    expect(removeSpy.mock.calls.some(([evt]) => evt === 'keydown')).toBe(true)
    removeSpy.mockRestore()
  })
})
