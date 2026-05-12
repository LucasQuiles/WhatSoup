/**
 * RelinkModal — open/close, ARIA, Escape, backdrop, listener cleanup.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

vi.mock('../../console/src/components/wizard/LinkStep', () => ({
  __esModule: true,
  default: ({ lineName, onComplete }: { lineName: string; onComplete: () => void }) => (
    <div data-testid="link-step-stub" data-line={lineName}>
      <button type="button" onClick={onComplete}>complete-link</button>
    </div>
  ),
}))

import RelinkModal from '../../console/src/components/RelinkModal'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RelinkModal open/close state', () => {
  it('renders nothing when open=false', () => {
    const { container, queryByRole } = render(
      <RelinkModal lineName="alpha" open={false} onClose={vi.fn()} onLinked={vi.fn()} />,
    )

    expect(queryByRole('dialog')).toBeNull()
    expect(container.querySelector('.c-dialog-backdrop')).toBeNull()
    expect(container.childElementCount).toBe(0)
  })

  it('renders the dialog chrome with ARIA wiring when open=true', () => {
    const { getByRole, getByText, getByLabelText } = render(
      <RelinkModal lineName="alpha" open={true} onClose={vi.fn()} onLinked={vi.fn()} />,
    )

    const dialog = getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('relink-dialog-title')

    const title = getByText('Re-link alpha')
    expect(title.id).toBe('relink-dialog-title')
    expect(dialog.contains(title)).toBe(true)

    const close = getByLabelText('Close')
    expect(close.tagName).toBe('BUTTON')
    expect(dialog.contains(close)).toBe(true)
  })

  it('interpolates the supplied lineName into the title and child LinkStep', () => {
    const { getByText, getByTestId } = render(
      <RelinkModal lineName="line-zulu" open={true} onClose={vi.fn()} onLinked={vi.fn()} />,
    )

    expect(getByText('Re-link line-zulu')).toBeDefined()
    expect(getByTestId('link-step-stub').getAttribute('data-line')).toBe('line-zulu')
  })
})

describe('RelinkModal close affordances', () => {
  it('invokes onClose when the header close button is clicked', () => {
    const onClose = vi.fn()
    const { getByLabelText } = render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    fireEvent.click(getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('invokes onClose when the backdrop is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    const backdrop = container.querySelector('.c-dialog-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not invoke onClose when the dialog body is clicked (stopPropagation)', () => {
    const onClose = vi.fn()
    const { getByRole } = render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    fireEvent.click(getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(0)
  })

  it('forwards LinkStep onComplete through onLinked', () => {
    const onLinked = vi.fn()
    const { getByText } = render(
      <RelinkModal lineName="alpha" open={true} onClose={vi.fn()} onLinked={onLinked} />,
    )

    fireEvent.click(getByText('complete-link'))
    expect(onLinked).toHaveBeenCalledTimes(1)
  })
})

describe('RelinkModal keyboard handling', () => {
  let addSpy: ReturnType<typeof vi.spyOn>
  let removeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    addSpy = vi.spyOn(document, 'addEventListener')
    removeSpy = vi.spyOn(document, 'removeEventListener')
  })

  it('calls onClose when Escape is pressed while open', () => {
    const onClose = vi.fn()
    render(<RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores non-Escape keys', () => {
    const onClose = vi.fn()
    render(<RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />)

    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.keyDown(document, { key: ' ' })
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(onClose).toHaveBeenCalledTimes(0)
  })

  it('does not register a keydown listener while open=false', () => {
    render(<RelinkModal lineName="alpha" open={false} onClose={vi.fn()} onLinked={vi.fn()} />)

    const keydownAdds = addSpy.mock.calls.filter(([type]) => type === 'keydown')
    expect(keydownAdds).toHaveLength(0)
  })

  it('registers exactly one keydown listener when opened', () => {
    render(<RelinkModal lineName="alpha" open={true} onClose={vi.fn()} onLinked={vi.fn()} />)

    const keydownAdds = addSpy.mock.calls.filter(([type]) => type === 'keydown')
    expect(keydownAdds).toHaveLength(1)
  })

  it('removes the keydown listener on unmount and stops invoking onClose on Escape', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    unmount()

    const keydownRemoves = removeSpy.mock.calls.filter(([type]) => type === 'keydown')
    expect(keydownRemoves).toHaveLength(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(0)
  })

  it('removes the keydown listener when open transitions from true to false', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    rerender(<RelinkModal lineName="alpha" open={false} onClose={onClose} onLinked={vi.fn()} />)

    const keydownRemoves = removeSpy.mock.calls.filter(([type]) => type === 'keydown')
    expect(keydownRemoves).toHaveLength(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(0)
  })
})
