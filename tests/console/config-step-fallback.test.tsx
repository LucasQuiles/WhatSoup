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
import { type ReactElement, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfigStep from '../../console/src/components/wizard/ConfigStep'
import { PROVIDERS } from '../../console/src/lib/providers'

afterEach(() => cleanup())

interface RenderOpts {
  initialData?: Record<string, unknown>
}

function renderConfigStep(opts: RenderOpts = {}) {
  const onChange = vi.fn()
  const initialData: Record<string, unknown> = {
    type: 'agent',
    name: 'test-agent',
    ...opts.initialData,
  }
  let latestData = initialData

  function Harness(): ReactElement {
    const [data, setData] = useState(initialData)
    latestData = data

    const handleChange = (patch: Record<string, unknown>) => {
      onChange(patch)
      setData((current) => ({ ...current, ...patch }))
    }

    return <ConfigStep data={data} onChange={handleChange} errors={{}} />
  }

  const utils = render(<Harness />)
  return { onChange, getData: () => latestData, ...utils }
}

function getAgentOptions(data: Record<string, unknown>): Record<string, unknown> {
  return data.agentOptions as Record<string, unknown>
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

  it('enabling the checkbox keeps an empty provider placeholder instead of defaulting to the primary provider', () => {
    const { getData } = renderConfigStep({
      initialData: { agentOptions: { provider: 'codex-cli' } },
    })
    openPermissionsTab()

    fireEvent.click(screen.getByText('Configure a fallback provider'))

    expect(getAgentOptions(getData())).not.toHaveProperty('fallbackProvider')
    const fallbackSelect = screen.getByLabelText('Fallback Provider') as HTMLSelectElement
    expect(fallbackSelect.value).toBe('')
    expect(fallbackSelect.options[0]?.value).toBe('')
    expect(fallbackSelect.options[0]?.textContent).toMatch(/select fallback provider/i)
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
    expect(optionValues).toEqual(['', ...PROVIDERS.map((p) => p.id)])

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

  it('keeps the fallback model disabled until a fallback provider is selected', () => {
    renderConfigStep({
      initialData: { agentOptions: { provider: 'claude-cli' } },
    })
    openPermissionsTab()

    fireEvent.click(screen.getByText('Configure a fallback provider'))

    const modelInput = screen.getByPlaceholderText('Select a fallback provider first') as HTMLInputElement
    expect(modelInput.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Fallback Provider'), { target: { value: 'openai-api' } })

    const enabledModelInput = screen.getByPlaceholderText('claude-sonnet-4-6') as HTMLInputElement
    expect(enabledModelInput.disabled).toBe(false)
  })

  it('disabling the checkbox clears both fallbackProvider and fallbackModel', () => {
    const { getData } = renderConfigStep({
      initialData: {
        agentOptions: { provider: 'claude-cli', fallbackProvider: 'openai-api', fallbackModel: 'gpt-4o' },
      },
    })
    openPermissionsTab()

    fireEvent.click(screen.getByText('Configure a fallback provider'))

    const finalAgentOptions = getAgentOptions(getData())
    expect(finalAgentOptions).not.toHaveProperty('fallbackProvider')
    expect(finalAgentOptions).not.toHaveProperty('fallbackModel')
  })
})
