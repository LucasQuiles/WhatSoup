/**
 * ProviderModelInput — live catalogue suggestions with an always-available
 * provider-native manual entry path.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const getProviderModels = vi.fn()

vi.mock('../../console/src/lib/api', () => ({
  api: { getProviderModels: (...args: unknown[]) => getProviderModels(...args) },
}))

import ProviderModelInput from '../../console/src/components/ProviderModelInput'
import { fetchProviderModels } from '../../console/src/hooks/use-fleet'

function renderInput(onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <label htmlFor="model-id">Model</label>
      <ProviderModelInput
        id="model-id"
        provider="opencode-cli"
        value=""
        onChange={onChange}
      />
    </QueryClientProvider>,
  )
  return { ...view, onChange }
}

beforeEach(() => getProviderModels.mockReset())
afterEach(cleanup)

describe('ProviderModelInput', () => {
  it('renders exactly the provider-native live ids as suggestions with provenance', async () => {
    getProviderModels.mockResolvedValue({
      status: 'ok',
      ids: ['future/new-model', 'new-provider/frontier-1'],
      sourceLabel: 'opencode CLI',
      asOfLabel: 'just now',
    })

    renderInput()

    await waitFor(() => expect(getProviderModels).toHaveBeenCalledWith('opencode-cli'))
    const input = screen.getByLabelText('Model') as HTMLInputElement
    await waitFor(() => expect(input.getAttribute('list')).toBe('model-id-catalogue'))
    const options = Array.from(document.querySelectorAll('#model-id-catalogue option'))
      .map((option) => option.getAttribute('value'))
    expect(options).toEqual(['future/new-model', 'new-provider/frontier-1'])
    expect(input.value).toBe('')
    expect(screen.getByTestId('provider-model-status').textContent).toContain('opencode CLI')
    expect(screen.getByTestId('provider-model-status').textContent).toContain('just now')
  })

  it('accepts a manual provider-native id that is absent from the suggestions', async () => {
    getProviderModels.mockResolvedValue({
      status: 'ok',
      ids: ['catalogued/model'],
      sourceLabel: 'test',
      asOfLabel: 'just now',
    })
    const { onChange } = renderInput()

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'private/future-model' } })

    expect(onChange).toHaveBeenCalledWith('private/future-model')
  })

  it('keeps manual entry enabled and discloses an unavailable catalogue', async () => {
    getProviderModels.mockResolvedValue({
      status: 'unavailable',
      reason: { kind: 'no-adapter', harness: 'opencode-cli' },
      asOfLabel: 'just now',
    })

    renderInput()

    const input = screen.getByLabelText('Model') as HTMLInputElement
    await waitFor(() => expect(screen.getByTestId('provider-model-status').textContent).toContain('no-adapter'))
    expect(input.disabled).toBe(false)
    expect(input.getAttribute('list')).toBeNull()
    expect(screen.getByTestId('provider-model-status').textContent).toContain('manually')
  })

  it('keeps manual entry enabled when the catalogue request itself fails', async () => {
    getProviderModels.mockResolvedValue({ status: 'request-failed' })

    renderInput()

    const input = screen.getByLabelText('Model') as HTMLInputElement
    await waitFor(() => expect(screen.getByTestId('provider-model-status').textContent).toContain('request failed'))
    expect(input.disabled).toBe(false)
    expect(input.getAttribute('list')).toBeNull()
  })

  it('normalizes a rejected transport request without masking it as provider data', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'))

    await expect(fetchProviderModels('opencode-cli', fetcher)).resolves.toEqual({ status: 'request-failed' })
    expect(fetcher).toHaveBeenCalledWith('opencode-cli')
  })
})
