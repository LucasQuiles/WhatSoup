/**
 * WizardStep — unit tests for the narrow presentational shell.
 *
 * Asserts that the shell renders children, title, subtitle, footerExtra, and
 * the correct omission behavior when optional props are absent.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import WizardStep from '../../console/src/components/wizard/WizardStep'

afterEach(() => cleanup())

describe('WizardStep shell', () => {
  it('renders children inside the container', () => {
    render(<WizardStep><span>body content</span></WizardStep>)
    expect(screen.getByText('body content')).toBeDefined()
  })

  it('renders title when provided', () => {
    render(<WizardStep title="Identity"><span /></WizardStep>)
    expect(screen.getByText('Identity')).toBeDefined()
  })

  it('renders subtitle when provided', () => {
    render(<WizardStep subtitle="Configure your line."><span /></WizardStep>)
    expect(screen.getByText('Configure your line.')).toBeDefined()
  })

  it('omits the header section when neither title nor subtitle is provided', () => {
    const { container } = render(<WizardStep><span /></WizardStep>)
    expect(container.querySelector('h3')).toBeNull()
    expect(container.querySelector('p')).toBeNull()
  })

  it('renders title and subtitle together when both are provided', () => {
    render(
      <WizardStep title="Model & Auth" subtitle="Select a model and enter your API key.">
        <span />
      </WizardStep>,
    )
    expect(screen.getByText('Model & Auth')).toBeDefined()
    expect(screen.getByText('Select a model and enter your API key.')).toBeDefined()
  })

  it('renders footerExtra when provided', () => {
    render(
      <WizardStep footerExtra={<button>Skip</button>}>
        <span />
      </WizardStep>,
    )
    expect(screen.getByText('Skip')).toBeDefined()
  })

  it('omits the footer section when footerExtra is absent', () => {
    const { container } = render(<WizardStep><span /></WizardStep>)
    expect(container.querySelector('.c-border-t')).toBeNull()
  })

  it('renders both body and footerExtra in expected order', () => {
    const { container } = render(
      <WizardStep footerExtra={<button>Extra</button>}>
        <input data-testid="body-field" />
      </WizardStep>,
    )
    const root = container.firstElementChild
    // root should have: children div (or element), then footer div
    const children = Array.from(root?.children ?? [])
    const footerDiv = children.find((el) => el.classList.contains('c-border-t'))
    const bodyField = container.querySelector('[data-testid="body-field"]')
    expect(bodyField).toBeDefined()
    expect(footerDiv).toBeDefined()
    // footer comes after the body field in DOM order
    const bodyPos = Array.from(root?.querySelectorAll('*') ?? []).indexOf(bodyField as Element)
    const footerPos = Array.from(root?.querySelectorAll('*') ?? []).indexOf(footerDiv as Element)
    expect(bodyPos).toBeLessThan(footerPos)
  })
})
