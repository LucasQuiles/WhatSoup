/**
 * Behavioral contract-lock for the Tooltip primitive (showcase §24).
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Tooltip } from '../../console/src/components/primitives/Tooltip'

afterEach(() => cleanup())

function shownState(bubble: HTMLElement): boolean {
  return bubble.classList.contains('soup-tooltip__bubble--show')
}

describe('Tooltip', () => {
  it('wires the trigger to the bubble via aria-describedby and role=tooltip', () => {
    render(
      <Tooltip content="Billing requires a linked channel">
        <button type="button">Billing</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Billing' })
    const describedBy = trigger.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    const bubble = document.getElementById(describedBy as string)
    expect(bubble).not.toBeNull()
    expect(bubble?.getAttribute('role')).toBe('tooltip')
    expect(bubble?.textContent).toContain('Billing requires a linked channel')
  })

  it('merges an existing aria-describedby on the trigger', () => {
    render(
      <Tooltip content="extra" id="tip-x">
        <button type="button" aria-describedby="external-note">Trigger</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Trigger' })
    expect(trigger.getAttribute('aria-describedby')).toBe('external-note tip-x')
  })

  it('is hidden until interaction (aria-hidden, no show class)', () => {
    render(
      <Tooltip content="hidden detail" id="tip-h">
        <button type="button">Anchor</button>
      </Tooltip>,
    )

    const bubble = document.getElementById('tip-h') as HTMLElement
    expect(bubble.getAttribute('aria-hidden')).toBe('true')
    expect(shownState(bubble)).toBe(false)
  })

  it('reveals on pointer hover and dismisses on mouse leave', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip content="hover detail" id="tip-hover">
        <button type="button">Anchor</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Anchor' })
    const bubble = document.getElementById('tip-hover') as HTMLElement

    await user.hover(trigger)
    expect(shownState(bubble)).toBe(true)
    expect(bubble.getAttribute('aria-hidden')).toBeNull()

    await user.unhover(trigger)
    expect(shownState(bubble)).toBe(false)
    expect(bubble.getAttribute('aria-hidden')).toBe('true')
  })

  it('reveals on keyboard focus and dismisses on blur', () => {
    render(
      <Tooltip content="focus detail" id="tip-focus">
        <button type="button">Anchor</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Anchor' })
    const bubble = document.getElementById('tip-focus') as HTMLElement

    fireEvent.focus(trigger)
    expect(shownState(bubble)).toBe(true)

    fireEvent.blur(trigger)
    expect(shownState(bubble)).toBe(false)
  })

  it('dismisses on Escape without removing the bubble or moving focus off the trigger', () => {
    render(
      <Tooltip content="esc detail" id="tip-esc">
        <button type="button">Anchor</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Anchor' })
    const bubble = document.getElementById('tip-esc') as HTMLElement

    trigger.focus()
    fireEvent.focus(trigger)
    expect(shownState(bubble)).toBe(true)

    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(shownState(bubble)).toBe(false)
    // Trigger stays focusable + present; bubble is not unmounted (still in DOM).
    expect(document.getElementById('tip-esc')).not.toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('ignores Escape when the tooltip is not shown', () => {
    render(
      <Tooltip content="noop" id="tip-noop">
        <button type="button">Anchor</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Anchor' })
    const bubble = document.getElementById('tip-noop') as HTMLElement

    // Esc with nothing shown must be a no-op (does not throw, stays hidden).
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(shownState(bubble)).toBe(false)
  })

  it('defaults to the top placement and flips below when clipped at the top edge', () => {
    render(
      <Tooltip content="placement" id="tip-place">
        <button type="button">Anchor</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Anchor' })
    const bubble = document.getElementById('tip-place') as HTMLElement
    const anchor = bubble.parentElement as HTMLElement

    // Anchor near the top edge: anchorRect.top (10) - estimatedHeight (96) < 0 -> below.
    anchor.getBoundingClientRect = () =>
      ({ left: 100, top: 10, width: 80, height: 24, right: 180, bottom: 34, x: 100, y: 10, toJSON: () => ({}) }) as DOMRect

    fireEvent.focus(trigger)
    expect(bubble.getAttribute('data-placement')).toBe('below')
    expect(bubble.classList.contains('soup-tooltip__bubble--bottom')).toBe(true)
  })

  it('stays above when there is room to grow up', () => {
    render(
      <Tooltip content="placement" id="tip-above">
        <button type="button">Anchor</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Anchor' })
    const bubble = document.getElementById('tip-above') as HTMLElement
    const anchor = bubble.parentElement as HTMLElement

    // Anchor far down the page: top (500) - height (96) >= 0 -> above.
    anchor.getBoundingClientRect = () =>
      ({ left: 100, top: 500, width: 80, height: 24, right: 180, bottom: 524, x: 100, y: 500, toJSON: () => ({}) }) as DOMRect

    fireEvent.focus(trigger)
    expect(bubble.getAttribute('data-placement')).toBe('above')
    expect(bubble.classList.contains('soup-tooltip__bubble--top')).toBe(true)
  })

  it('keeps the default placement under an uninformative zero rect (jsdom)', () => {
    render(
      <Tooltip content="placement" id="tip-zero">
        <button type="button">Anchor</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Anchor' })
    const bubble = document.getElementById('tip-zero') as HTMLElement
    const anchor = bubble.parentElement as HTMLElement

    anchor.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    fireEvent.focus(trigger)
    expect(bubble.getAttribute('data-placement')).toBe('above')
  })

  it('applies an extra class to the anchor wrapper', () => {
    const { container } = render(
      <Tooltip content="x" className="inline-anchor">
        <button type="button">Anchor</button>
      </Tooltip>,
    )
    const anchor = container.querySelector('.soup-tooltip')
    expect(anchor?.classList.contains('inline-anchor')).toBe(true)
  })
})
