/**
 * Behavioral contract-lock for the Switch primitive (showcase §15).
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

import { Switch } from '../../console/src/components/primitives/Switch'

afterEach(() => cleanup())

describe('Switch', () => {
  it('renders role=switch with aria-checked reflecting state and the on class', () => {
    const { rerender } = render(
      <Switch label="Auto-respond" checked={false} onChange={() => {}} />,
    )

    const toggle = screen.getByRole('switch', { name: 'Auto-respond' })
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.getAttribute('type')).toBe('button')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.classList.contains('soup-switch')).toBe(true)
    expect(toggle.classList.contains('soup-switch--on')).toBe(false)

    rerender(<Switch label="Auto-respond" checked onChange={() => {}} />)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.classList.contains('soup-switch--on')).toBe(true)
  })

  it('associates a visible label via aria-labelledby (not aria-label)', () => {
    render(<Switch label="Business hours only" checked={false} onChange={() => {}} />)

    const toggle = screen.getByRole('switch', { name: 'Business hours only' })
    const labelId = toggle.getAttribute('aria-labelledby')
    expect(labelId).toBeTruthy()
    expect(toggle.getAttribute('aria-label')).toBeNull()

    const label = document.getElementById(labelId as string)
    expect(label?.textContent).toBe('Business hours only')
    expect(label?.classList.contains('soup-switch__label')).toBe(true)
  })

  it('falls back to aria-label for icon-only rows with no visible label', () => {
    render(<Switch aria-label="Mute line" checked={false} onChange={() => {}} />)

    const toggle = screen.getByRole('switch', { name: 'Mute line' })
    expect(toggle.getAttribute('aria-label')).toBe('Mute line')
    expect(toggle.getAttribute('aria-labelledby')).toBeNull()
    expect(screen.queryByText('Mute line')).toBeNull()
  })

  it('honors an explicit id and derives the label id from it', () => {
    render(<Switch id="auto" label="Auto" checked={false} onChange={() => {}} />)

    const toggle = screen.getByRole('switch', { name: 'Auto' })
    expect(toggle.id).toBe('auto')
    expect(toggle.getAttribute('aria-labelledby')).toBe('auto-label')
  })

  it('toggles on pointer click and emits the next boolean', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    function Harness() {
      const [on, setOn] = useState(false)
      return (
        <Switch
          label="Auto-respond"
          checked={on}
          onChange={next => {
            onChange(next)
            setOn(next)
          }}
        />
      )
    }

    render(<Harness />)
    const toggle = screen.getByRole('switch', { name: 'Auto-respond' })

    await user.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await user.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('toggles via the keyboard with Space and Enter', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    function Harness() {
      const [on, setOn] = useState(false)
      return (
        <Switch
          label="Auto-respond"
          checked={on}
          onChange={next => {
            onChange(next)
            setOn(next)
          }}
        />
      )
    }

    render(<Harness />)
    const toggle = screen.getByRole('switch', { name: 'Auto-respond' })

    toggle.focus()
    expect(document.activeElement).toBe(toggle)

    await user.keyboard(' ')
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('does not toggle when disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(<Switch label="Auto-respond" checked={false} disabled onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Auto-respond' }) as HTMLButtonElement

    expect(toggle.disabled).toBe(true)
    await user.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('applies an extra class to the row wrapper', () => {
    const { container } = render(
      <Switch label="Auto" checked={false} onChange={() => {}} className="settings-row" />,
    )
    const row = container.querySelector('.soup-switch-row')
    expect(row?.classList.contains('settings-row')).toBe(true)
  })
})
