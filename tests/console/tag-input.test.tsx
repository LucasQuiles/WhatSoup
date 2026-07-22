/**
 * TagInput — keyboard-driven tag list with validate/normalize/dedupe semantics.
 * @vitest-environment jsdom
 *
 * DD-13 migration: chips render via Pill variant="removable". All behavioral
 * contracts (Enter/trim/dedupe/normalize/validate/Backspace/blur/displayLabels)
 * are preserved. New assertions added:
 *   - remove buttons carry accessible names "Remove <label>" (getByRole)
 *   - chip containers carry the soup-pill class contract
 *
 * pillByLabel updated: Pill wraps the label in <span class="soup-pill__label">
 * so we locate by that inner span and return the parent soup-pill span.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TagInput from '../../console/src/components/TagInput'

afterEach(() => cleanup())

function setup(initial: string[] = [], extraProps: Partial<React.ComponentProps<typeof TagInput>> = {}) {
  const onChange = vi.fn((next: string[]) => {
    // Re-render with the new values so we exercise the controlled flow.
    rerender(<TagInput values={next} onChange={onChange} {...extraProps} />)
  })
  const utils = render(<TagInput values={initial} onChange={onChange} {...extraProps} />)
  const { rerender } = utils
  const input = () => utils.container.querySelector('input') as HTMLInputElement
  // Pill variant="removable" wraps the label in <span class="soup-pill__label">.
  // We find that inner span by text content and return its parent pill span.
  const pillByLabel = (label: string) => {
    const labelSpans = Array.from(utils.container.querySelectorAll('.soup-pill__label'))
    const match = labelSpans.find(s => s.textContent?.trim() === label)
    if (!match) throw new Error(`pill not found for label: ${label}`)
    const pill = match.closest('.soup-pill')
    if (!pill) throw new Error(`soup-pill container not found for label: ${label}`)
    return pill as HTMLElement
  }
  return { onChange, input, rerender, container: utils.container, pillByLabel }
}

describe('TagInput', () => {
  it('renders the text input through the form primitive class contract', () => {
    const { input } = setup([])
    expect(input().classList.contains('c-input')).toBe(true)
    expect(input().classList.contains('font-mono')).toBe(true)
  })

  it('forwards id and validation aria attributes to the text input', () => {
    const { input } = setup([], {
      id: 'admin-phones-input',
      'aria-invalid': true,
      'aria-describedby': 'admin-phones-error',
    })

    expect(input().id).toBe('admin-phones-input')
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(input().getAttribute('aria-describedby')).toBe('admin-phones-error')
  })

  it('adds a tag on Enter, clears the input, and emits the new values', () => {
    const { onChange, input } = setup([])
    fireEvent.change(input(), { target: { value: 'alpha' } })
    expect(input().value).toBe('alpha')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(['alpha'])
    expect(input().value).toBe('')
    expect(screen.getByText('alpha')).toBeDefined()
  })

  it('trims whitespace before adding and rejects whitespace-only input', () => {
    const { onChange, input } = setup([])
    fireEvent.change(input(), { target: { value: '   ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(input(), { target: { value: '  beta  ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(['beta'])
  })

  it.each(['\t', '\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF'])(
    'does not erase an unsafe boundary before validation: %#',
    (boundary) => {
      const normalizeValue = (value: string) => value.toLowerCase()
      const validate = (value: string) => value === 'owner@example.com'
      const { onChange, input } = setup([], { normalizeValue, validate })

      fireEvent.change(input(), { target: { value: `${boundary}Owner@Example.com` } })
      fireEvent.keyDown(input(), { key: 'Enter' })

      expect(onChange).not.toHaveBeenCalled()
    },
  )

  it('rejects duplicate tags without invoking onChange or clearing the input', () => {
    const { onChange, input } = setup(['alpha'])
    fireEvent.change(input(), { target: { value: 'alpha' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    // Per source: when addTag short-circuits before setInput(''), the input retains the text.
    expect(input().value).toBe('alpha')
  })

  it('applies normalizeValue after trimming and skips empty post-normalize results', () => {
    const normalizeValue = vi.fn((v: string) => v.toLowerCase())
    const { onChange, input } = setup([], { normalizeValue })
    fireEvent.change(input(), { target: { value: '  GAMMA  ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(normalizeValue).toHaveBeenCalledWith('GAMMA')
    expect(onChange).toHaveBeenLastCalledWith(['gamma'])

  })

  it('skips when normalizeValue returns an empty string', () => {
    const dropAll = vi.fn(() => '')
    const { onChange, input } = setup([], { normalizeValue: dropAll })
    fireEvent.change(input(), { target: { value: 'delta' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(dropAll).toHaveBeenCalledWith('delta')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects values when validate() returns false and accepts when true', () => {
    const validate = vi.fn((v: string) => v.length >= 3)
    const { onChange, input } = setup([], { validate })
    fireEvent.change(input(), { target: { value: 'ab' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(validate).toHaveBeenCalledWith('ab')
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(input(), { target: { value: 'abcd' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(validate).toHaveBeenLastCalledWith('abcd')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(['abcd'])
  })

  it('applies normalize before validate (validate receives the normalized value)', () => {
    const normalizeValue = (v: string) => v.toLowerCase()
    const validate = vi.fn((v: string) => v === v.toLowerCase())
    const { onChange, input } = setup([], { normalizeValue, validate })
    fireEvent.change(input(), { target: { value: 'MIXED' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(validate).toHaveBeenCalledWith('mixed')
    expect(onChange).toHaveBeenLastCalledWith(['mixed'])
  })

  it('removes a tag when its labeled remove button is clicked', () => {
    // DD-13: remove button must carry accessible name "Remove <label>".
    const { onChange } = setup(['alpha', 'beta', 'gamma'])
    const removeBtn = screen.getByRole('button', { name: 'Remove beta' })
    fireEvent.click(removeBtn)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(['alpha', 'gamma'])
  })

  it('removes the last tag on Backspace when the input is empty', () => {
    const { onChange, input } = setup(['alpha', 'beta'])
    expect(input().value).toBe('')
    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(['alpha'])
  })

  it('does not remove tags on Backspace when the input has content', () => {
    const { onChange, input } = setup(['alpha', 'beta'])
    fireEvent.change(input(), { target: { value: 'x' } })
    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not remove on Backspace when there are no existing tags', () => {
    const { onChange, input } = setup([])
    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('')
  })

  it('adds the current input value on blur', () => {
    const { onChange, input } = setup([])
    fireEvent.change(input(), { target: { value: 'epsilon' } })
    fireEvent.blur(input())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(['epsilon'])
  })

  it('renders display labels from displayLabels but keeps underlying values', () => {
    const { onChange, container, pillByLabel } = setup(['k1', 'k2'], { displayLabels: { k1: 'Key One', k2: 'Key Two' } })
    expect(container.textContent).toContain('Key One')
    expect(container.textContent).toContain('Key Two')
    expect(container.textContent).not.toContain('k1')
    // Removing still emits the raw key, not the label.
    // With displayLabels, the remove button name matches the display label.
    const removeBtn = screen.getByRole('button', { name: 'Remove Key One' })
    fireEvent.click(removeBtn)
    expect(onChange).toHaveBeenLastCalledWith(['k2'])
    // pillByLabel still resolves the display label via soup-pill__label
    void pillByLabel('Key Two')
  })

  it('falls back to the raw tag when displayLabels has no entry for it', () => {
    const { container } = setup(['k1', 'k2'], { displayLabels: { k1: 'Key One' } })
    expect(container.textContent).toContain('Key One')
    expect(container.textContent).toContain('k2')
  })

  it('uses the placeholder-with-hint suffix when a placeholder is provided', () => {
    const { input } = setup([], { placeholder: 'add tag' })
    expect(input().placeholder).toBe('add tag (press Enter to add)')
  })

  it('uses the default hint placeholder when no placeholder is provided', () => {
    const { input } = setup([])
    expect(input().placeholder).toBe('Press Enter to add')
  })

  it('hides the tag list when there are no values', () => {
    const { container } = setup([])
    // No pills => no buttons in the document.
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('prevents default form submission on Enter', () => {
    const { input } = setup([])
    fireEvent.change(input(), { target: { value: 'zeta' } })
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    const prevented = !input().dispatchEvent(event)
    expect(prevented).toBe(true)
  })

  it('ignores unrelated keys (e.g. comma is typed as input, not a delimiter)', () => {
    const { onChange, input } = setup([])
    fireEvent.change(input(), { target: { value: 'a,b' } })
    fireEvent.keyDown(input(), { key: ',' })
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('a,b')
    // Only Enter (or blur) commits — confirm with Enter.
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(['a,b'])
  })

  // -------------------------------------------------------------------------
  // DD-13: Pill primitive contract assertions
  // -------------------------------------------------------------------------

  it('chips carry the soup-pill class (Pill primitive contract)', () => {
    // Verifies chips are rendered via Pill, not re-rolled spans.
    const { pillByLabel } = setup(['alpha', 'beta'])
    const pillA = pillByLabel('alpha')
    expect(pillA.classList.contains('soup-pill')).toBe(true)
    expect(pillA.classList.contains('soup-pill--removable')).toBe(true)
  })

  it('each remove button carries an accessible name "Remove <label>"', () => {
    // Core DD-13 requirement: unlabeled X buttons become labeled ActionButtons.
    setup(['one', 'two', 'three'])
    expect(screen.getByRole('button', { name: 'Remove one' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Remove two' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Remove three' })).toBeDefined()
  })

  it('remove button accessible name reflects the display label, not the raw value', () => {
    // When displayLabels is provided, the aria-label uses the display string.
    setup(['k1'], { displayLabels: { k1: 'Key One' } })
    expect(screen.getByRole('button', { name: 'Remove Key One' })).toBeDefined()
    // The raw value "k1" does not appear as a button name.
    expect(screen.queryByRole('button', { name: 'Remove k1' })).toBeNull()
  })
})
