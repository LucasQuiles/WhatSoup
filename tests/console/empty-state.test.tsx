/**
 * EmptyState — variant + retry button behavior coverage.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import EmptyState from '../../console/src/components/EmptyState'

afterEach(() => cleanup())

describe('EmptyState default variant', () => {
  it('renders title text and applies the default title color class', () => {
    render(<EmptyState title="No conversations yet" />)

    const title = screen.getByText('No conversations yet')
    expect(title.className).toContain('text-t3')
    expect(title.className).not.toContain('text-s-crit')
  })

  it('omits the description node when no description prop is supplied', () => {
    render(<EmptyState title="Nothing here" />)

    expect(screen.queryByText(/./, { selector: '.text-body' })).toBeNull()
  })

  it('renders description text inside the body-text container when provided', () => {
    render(<EmptyState title="Nothing here" description="Try syncing again soon." />)

    const description = screen.getByText('Try syncing again soon.')
    expect(description.className).toContain('text-body')
    expect(description.className).toContain('text-t4')
  })

  it('renders no icon node when neither icon prop nor error variant is supplied', () => {
    const { container } = render(<EmptyState title="Empty" />)

    // Outer flex wrapper is the only direct child; title + (no icon, no description, no button)
    const root = container.firstElementChild as HTMLElement
    expect(root.children.length).toBe(1)
  })

  it('renders a caller-supplied icon node verbatim when icon prop is given', () => {
    render(
      <EmptyState
        title="With icon"
        icon={<svg data-testid="custom-icon" aria-label="custom" />}
      />,
    )

    expect(screen.getByTestId('custom-icon')).toBeDefined()
  })
})

describe('EmptyState error variant', () => {
  it('applies the critical color class to the title in error variant', () => {
    render(<EmptyState title="Something went wrong" variant="error" />)

    const title = screen.getByText('Something went wrong')
    expect(title.className).toContain('text-s-crit')
    expect(title.className).not.toContain('text-t3')
  })

  it('falls back to the AlertTriangle lucide icon when no icon prop is supplied in error variant', () => {
    const { container } = render(<EmptyState title="Error" variant="error" />)

    // lucide-react renders <svg class="lucide lucide-alert-triangle ...">
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('class') ?? '').toMatch(/lucide-alert-triangle|lucide-triangle-alert/)
  })

  it('prefers the caller-supplied icon over the AlertTriangle fallback in error variant', () => {
    render(
      <EmptyState
        title="Error"
        variant="error"
        icon={<svg data-testid="override-icon" />}
      />,
    )

    expect(screen.getByTestId('override-icon')).toBeDefined()
  })
})

describe('EmptyState retry button', () => {
  it('does not render a retry button when onRetry is not supplied', () => {
    render(<EmptyState title="Empty" />)

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders a single retry button with the default label when onRetry is supplied', () => {
    render(<EmptyState title="Empty" onRetry={() => {}} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBe(1)
    expect(buttons[0]!.textContent).toBe('Try again')
  })

  it('renders the custom retry label when retryLabel is supplied', () => {
    render(<EmptyState title="Empty" onRetry={() => {}} retryLabel="Reload now" />)

    const button = screen.getByRole('button')
    expect(button.textContent).toBe('Reload now')
  })

  it('invokes the onRetry callback exactly once per click', () => {
    const onRetry = vi.fn()
    render(<EmptyState title="Empty" onRetry={onRetry} />)

    fireEvent.click(screen.getByRole('button'))

    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('applies the primary button design-system classes', () => {
    render(<EmptyState title="Empty" onRetry={() => {}} />)

    const button = screen.getByRole('button')
    expect(button.className).toContain('c-btn')
    expect(button.className).toContain('c-btn-primary')
  })
})
