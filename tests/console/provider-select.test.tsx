/**
 * ProviderSelect — server-reported execution-provider choices with explicit
 * degradation when the catalogue cannot be read.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const getProviders = vi.fn()

vi.mock('../../console/src/lib/api', () => ({
  api: { getProviders: (...args: unknown[]) => getProviders(...args) },
}))

import ProviderSelect from '../../console/src/components/ProviderSelect'
import { fetchProviders } from '../../console/src/hooks/use-fleet'

function renderSelect(
  props: Partial<React.ComponentProps<typeof ProviderSelect>> = {},
) {
  const onChange = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <label htmlFor="provider-id">Provider</label>
      <ProviderSelect
        id="provider-id"
        value="runtime-default"
        onChange={onChange}
        {...props}
      />
    </QueryClientProvider>,
  )
  return { ...view, onChange }
}

beforeEach(() => getProviders.mockReset())
afterEach(cleanup)

describe('ProviderSelect', () => {
  it('renders exactly the execution providers reported by the live server catalogue', async () => {
    getProviders.mockResolvedValue([
      { id: 'runtime-default', displayName: 'Runtime Default', type: 'cli', needsApiKey: false, credentialService: null, providerConfig: [] },
      { id: 'new-adapter', displayName: 'New Adapter', type: 'cli', needsApiKey: false, credentialService: null, providerConfig: ['model'] },
    ])

    const { onChange } = renderSelect()

    await waitFor(() => expect(getProviders).toHaveBeenCalledTimes(1))
    const select = screen.getByLabelText('Provider') as HTMLSelectElement
    await waitFor(() => expect(Array.from(select.options).map((option) => option.value))
      .toEqual(['runtime-default', 'new-adapter']))
    expect(Array.from(select.options).map((option) => option.textContent))
      .toEqual(['Runtime Default', 'New Adapter'])

    fireEvent.change(select, { target: { value: 'new-adapter' } })
    expect(onChange).toHaveBeenCalledWith('new-adapter')
  })

  it('preserves but identifies a configured value absent from the reported catalogue', async () => {
    getProviders.mockResolvedValue([
      { id: 'new-adapter', displayName: 'New Adapter', type: 'cli', needsApiKey: false, credentialService: null, providerConfig: [] },
    ])

    renderSelect({ value: 'retired-adapter' })

    const select = screen.getByLabelText('Provider') as HTMLSelectElement
    await waitFor(() => expect(Array.from(select.options).map((option) => option.value))
      .toEqual(['retired-adapter', 'new-adapter']))
    expect(select.options[0]?.textContent).toContain('configured; not reported')
  })

  it('does not substitute a compiled fallback list when the server reports no providers', async () => {
    getProviders.mockResolvedValue([])

    renderSelect({ value: 'configured-adapter' })

    const select = screen.getByLabelText('Provider') as HTMLSelectElement
    await waitFor(() => expect(screen.getByTestId('provider-catalogue-status').textContent)
      .toContain('0 execution providers'))
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['configured-adapter'])
    expect(select.value).toBe('configured-adapter')
  })

  it('normalizes a rejected catalogue request without masking it as provider data', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'))

    await expect(fetchProviders(fetcher)).resolves.toEqual({ status: 'request-failed' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('supports an explicit empty choice without manufacturing a default', async () => {
    getProviders.mockResolvedValue([
      { id: 'new-adapter', displayName: 'New Adapter', type: 'cli', needsApiKey: false, credentialService: null, providerConfig: [] },
    ])

    renderSelect({ value: '', allowEmpty: true, emptyLabel: 'Select fallback provider' })

    const select = screen.getByLabelText('Provider') as HTMLSelectElement
    await waitFor(() => expect(Array.from(select.options).map((option) => option.value))
      .toEqual(['', 'new-adapter']))
    expect(select.options[0]?.textContent).toBe('Select fallback provider')
  })
})
