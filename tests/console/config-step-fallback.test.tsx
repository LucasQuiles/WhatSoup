/**
 * ConfigStep — optional fallback-provider section (Permissions tab).
 *
 * The section lets an operator configure agentOptions.fallbackProvider /
 * fallbackModel at create time, mirroring the primary-provider + providerConfig
 * UI. It is gated behind a "Configure a fallback provider" checkbox.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfigStep from '../../console/src/components/wizard/ConfigStep'
import { PROVIDERS } from '../../console/src/lib/providers'

afterEach(() => cleanup())

interface RenderOpts {
  initialData?: Record<string, unknown>
}

function renderConfigStep(opts: RenderOpts = {}) {
  const onChange = vi.fn()
  let data: Record<string, unknown> = {
    type: 'agent',
    name: 'test-agent',
    ...opts.initialData,
  }
  const utils = render(<ConfigStep data={data} onChange={onChange} errors={{}} />)
  const rerenderWith = (next: Record<string, unknown>) => {
    data = next
    utils.rerender(<ConfigStep data={data} onChange={onChange} errors={{}} />)
  }
  return { onChange, rerenderWith, ...utils }
}

function openPermissionsTab() {
  fireEvent.click(screen.getByRole('tab', { name: /permissions/i }))
}

describe('ConfigStep — fallback provider section', () => {
  it('hides the fallback provider/model fields until the checkbox is enabled', () => {
    renderConfigStep({ initialData: { agentOptions: { provider: 'claude-cli' } } })
    openPermissionsTab()

    // Section collapsed by default — no fallback fields rendered.
    expect(screen.queryByText('Fallback Provider')).toBeNull()
    expect(screen.queryByText('Fallback Model')).toBeNull()
  })

  it('enabling the checkbox defaults fallbackProvider to the primary provider id', () => {
    const { onChange } = renderConfigStep({
      initialData: { agentOptions: { provider: 'codex-cli' } },
    })
    openPermissionsTab()
    onChange.mockClear()

    fireEvent.click(screen.getByText('Configure a fallback provider'))

    const patch = onChange.mock.calls[0][0] as { agentOptions: { fallbackProvider?: string } }
    expect(patch.agentOptions.fallbackProvider).toBe('codex-cli')
  })

  it('renders provider <select> + model field when a fallbackProvider is set, and the select lists every catalog provider', () => {
    renderConfigStep({
      initialData: {
        agentOptions: { provider: 'claude-cli', fallbackProvider: 'openai-api', fallbackModel: 'gpt-4o' },
      },
    })
    openPermissionsTab()

    expect(screen.getByText('Fallback Provider')).toBeDefined()
    expect(screen.getByText('Fallback Model')).toBeDefined()

    // The fallback select shows the configured provider's display name (OpenAI)
    // and offers every provider id from the single console catalog.
    const fallbackSelect = screen.getByDisplayValue('OpenAI') as HTMLSelectElement
    const optionValues = Array.from(fallbackSelect.options).map((o) => o.value)
    expect(optionValues).toEqual(PROVIDERS.map((p) => p.id))

    // Model text field reflects the configured fallback model.
    expect((screen.getByDisplayValue('gpt-4o') as HTMLInputElement).tagName).toBe('INPUT')
  })

  it('changing the fallback model writes agentOptions.fallbackModel', () => {
    const { onChange } = renderConfigStep({
      initialData: {
        agentOptions: { provider: 'claude-cli', fallbackProvider: 'openai-api', fallbackModel: '' },
      },
    })
    openPermissionsTab()
    onChange.mockClear()

    const modelInput = screen.getByPlaceholderText('claude-sonnet-4-6')
    fireEvent.change(modelInput, { target: { value: 'gpt-4o-mini' } })

    const patch = onChange.mock.calls[0][0] as { agentOptions: { fallbackModel?: string } }
    expect(patch.agentOptions.fallbackModel).toBe('gpt-4o-mini')
  })

  it('disabling the checkbox clears both fallbackProvider and fallbackModel', () => {
    const { onChange } = renderConfigStep({
      initialData: {
        agentOptions: { provider: 'claude-cli', fallbackProvider: 'openai-api', fallbackModel: 'gpt-4o' },
      },
    })
    openPermissionsTab()
    onChange.mockClear()

    fireEvent.click(screen.getByText('Configure a fallback provider'))

    // The uncheck path removes fallbackProvider (and clears the model).
    const providerCleared = onChange.mock.calls.some(([p]) => {
      const opts = (p as { agentOptions?: { fallbackProvider?: unknown } }).agentOptions
      return opts !== undefined && !('fallbackProvider' in opts)
    })
    expect(providerCleared).toBe(true)
  })
})
