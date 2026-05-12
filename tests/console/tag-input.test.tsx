/**
 * TagInput — keyboard-driven tag list with validate/normalize/dedupe semantics.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
  const pillByLabel = (label: string) => {
    // Pills are <span> elements that directly contain the label text node.
    const spans = Array.from(utils.container.querySelectorAll('span'))
    const match = spans.find(s => Array.from(s.childNodes).some(n => n.nodeType === 3 && n.textContent?.trim() === label))
    if (!match) throw new Error(`pill not found for label: ${label}`)
    return match
  }
  return { onChange, input, rerender, container: utils.container, pillByLabel }
}

describe('TagInput', () => {
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

  it('removes a tag when its X button is clicked', () => {
    const { onChange, pillByLabel } = setup(['alpha', 'beta', 'gamma'])
    const betaPill = pillByLabel('beta')
    const removeBtn = within(betaPill).getByRole('button')
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
    fireEvent.click(within(pillByLabel('Key One')).getByRole('button'))
    expect(onChange).toHaveBeenLastCalledWith(['k2'])
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
})
