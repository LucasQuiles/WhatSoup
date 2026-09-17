/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigEditDialog } from '../../console/src/components/line-detail/ConfigEditDialog'
import { ToastContext } from '../../console/src/hooks/toast-context'
import { api } from '../../console/src/lib/api'

vi.mock('../../console/src/lib/api', () => ({
  api: {
    updateConfig: vi.fn(),
    getProviders: vi.fn(),
    getProviderModels: vi.fn(),
  },
}))

const updateConfigMock = api.updateConfig as unknown as ReturnType<typeof vi.fn>
const getProvidersMock = api.getProviders as unknown as ReturnType<typeof vi.fn>
const getProviderModelsMock = api.getProviderModels as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetAllMocks()
  updateConfigMock.mockResolvedValue(undefined)
  getProvidersMock.mockResolvedValue([
    { id: 'claude-cli', displayName: 'Claude CLI', type: 'cli', needsApiKey: false, credentialService: null, providerConfig: [] },
    { id: 'opencode-cli', displayName: 'OpenCode', type: 'cli', needsApiKey: true, credentialService: null, providerConfig: ['model'] },
  ])
  getProviderModelsMock.mockImplementation(async (provider: string) => ({
    status: 'ok',
    ids: [`${provider}/suggested-model`],
    sourceLabel: provider,
    asOfLabel: 'just now',
  }))
})

afterEach(() => cleanup())

async function renderFallback(provider: string, model: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={{
        toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(),
        dismiss: vi.fn(), clear: vi.fn(),
      }}>
        <ConfigEditDialog
          open
          lineName="fallback-line"
          config={{
            type: 'agent',
            model: 'primary/model',
            agentOptions: {
              provider: 'claude-cli',
              fallbackProvider: provider,
              fallbackModel: model,
            },
          }}
          onClose={vi.fn()}
        />
      </ToastContext.Provider>
    </QueryClientProvider>,
  )
  const providerInput = screen.getByLabelText('agentOptions.fallbackProvider') as HTMLSelectElement
  await waitFor(() => expect(Array.from(providerInput.options).map(option => option.value))
    .toEqual(['claude-cli', 'opencode-cli']))
  return {
    providerInput,
    modelInput: screen.getByLabelText('agentOptions.fallbackModel') as HTMLInputElement,
  }
}

async function saveAndExpect(patch: Record<string, unknown>) {
  fireEvent.click(screen.getByRole('button', { name: /Save/ }))
  await waitFor(() => expect(updateConfigMock).toHaveBeenCalledTimes(1))
  expect(updateConfigMock).toHaveBeenCalledWith('fallback-line', patch)
}

describe('ConfigEditDialog fallback provider changes', () => {
  it.each([
    ['claude-cli', 'opencode-cli'],
    ['opencode-cli', 'claude-cli'],
  ])('clears the model when changing %s to %s', async (from, to) => {
    const { providerInput, modelInput } = await renderFallback(from, `${from}/configured-model`)

    fireEvent.change(providerInput, { target: { value: to } })

    expect(modelInput.value).toBe('')
    expect((screen.getByLabelText('model') as HTMLInputElement).value).toBe('primary/model')
    await saveAndExpect({ agentOptions: { fallbackProvider: to, fallbackModel: '' } })
  })

  it('preserves the configured model when the provider does not change', async () => {
    const { providerInput, modelInput } = await renderFallback('opencode-cli', 'private/configured-model')

    fireEvent.change(providerInput, { target: { value: 'opencode-cli' } })

    expect(modelInput.value).toBe('private/configured-model')
    expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(updateConfigMock).not.toHaveBeenCalled()
  })

  it('preserves an edited model when the provider does not change', async () => {
    const { providerInput, modelInput } = await renderFallback('opencode-cli', 'private/configured-model')
    fireEvent.change(modelInput, { target: { value: 'private/edited-model' } })

    fireEvent.change(providerInput, { target: { value: 'opencode-cli' } })

    expect(modelInput.value).toBe('private/edited-model')
    await saveAndExpect({ agentOptions: { fallbackModel: 'private/edited-model' } })
  })

  it('keeps the model cleared when switching back to the original provider', async () => {
    const { providerInput, modelInput } = await renderFallback('opencode-cli', 'private/configured-model')

    fireEvent.change(providerInput, { target: { value: 'claude-cli' } })
    fireEvent.change(providerInput, { target: { value: 'opencode-cli' } })

    expect(modelInput.value).toBe('')
    await saveAndExpect({ agentOptions: { fallbackModel: '' } })
  })

  it('saves a newly selected model for the changed provider', async () => {
    const { providerInput, modelInput } = await renderFallback('opencode-cli', 'private/configured-model')

    fireEvent.change(providerInput, { target: { value: 'claude-cli' } })
    await waitFor(() => expect(getProviderModelsMock).toHaveBeenCalledWith('claude-cli'))
    fireEvent.change(modelInput, { target: { value: 'claude-cli/suggested-model' } })

    await saveAndExpect({
      agentOptions: { fallbackProvider: 'claude-cli', fallbackModel: 'claude-cli/suggested-model' },
    })
  })
})
