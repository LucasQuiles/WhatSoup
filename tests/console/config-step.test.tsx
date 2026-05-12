/**
 * ConfigStep — real React handler contract tests.
 *
 * Replaces the simulator-only coverage in `provider-wiring.test.ts` for the
 * 7 contracts in the audit report (#261). Renders the actual component with
 * @testing-library/react so the bound onChange handlers, useEffect prefill,
 * and field-set rerender behavior are exercised end-to-end.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfigStep from '../../console/src/components/wizard/ConfigStep'

afterEach(() => cleanup())

interface RenderOpts {
  initialData?: Record<string, unknown>
  errors?: Record<string, string>
}

/**
 * Controlled render harness. `onChange` patches the data object the next
 * render reads from, mirroring how the wizard parent threads state.
 */
function renderConfigStep(opts: RenderOpts = {}) {
  const onChange = vi.fn()
  let data: Record<string, unknown> = {
    type: 'agent',
    name: 'test-agent',
    ...opts.initialData,
  }

  const utils = render(
    <ConfigStep data={data} onChange={onChange} errors={opts.errors ?? {}} />,
  )

  // Re-render helper that re-feeds the latest data through props
  const rerenderWith = (next: Record<string, unknown>) => {
    data = next
    utils.rerender(
      <ConfigStep data={data} onChange={onChange} errors={opts.errors ?? {}} />,
    )
  }

  return { onChange, rerenderWith, ...utils, getData: () => data }
}

/** Click the Permissions tab so provider/provider-config fields render. */
function openPermissionsTab() {
  fireEvent.click(screen.getByRole('tab', { name: /permissions/i }))
}

describe('ConfigStep — real React handler wiring', () => {
  // ──────────────────────────────────────────────────────────────────────
  // Contract 7: mount-only useEffect prefill (ConfigStep.tsx:178-189)
  // Runs on initial render — capture and reset before later assertions
  // ──────────────────────────────────────────────────────────────────────
  describe('mount prefill effect', () => {
    it('prefills systemPrompt and claudeMd exactly once on mount for agent type', () => {
      const { onChange } = renderConfigStep({
        initialData: { type: 'agent', name: 'sage', systemPrompt: '', claudeMd: '' },
      })
      // The mount effect should fire exactly once and patch both fields
      const prefillCalls = onChange.mock.calls.filter(([patch]) => {
        return patch && (
          Object.prototype.hasOwnProperty.call(patch, 'systemPrompt') ||
          Object.prototype.hasOwnProperty.call(patch, 'claudeMd')
        )
      })
      expect(prefillCalls.length).toBe(1)
      const patch = prefillCalls[0][0] as Record<string, unknown>
      expect(typeof patch.systemPrompt).toBe('string')
      expect((patch.systemPrompt as string).length).toBeGreaterThan(20)
      expect(typeof patch.claudeMd).toBe('string')
      expect((patch.claudeMd as string).length).toBeGreaterThan(20)
    })

    it('does not overwrite an existing systemPrompt on mount', () => {
      const existing = 'You are a custom prompt that must not be overwritten.'
      const { onChange } = renderConfigStep({
        initialData: { type: 'agent', name: 'sage', systemPrompt: existing, claudeMd: '' },
      })
      // No onChange call may contain a systemPrompt key
      const systemPromptPatches = onChange.mock.calls.filter(
        ([p]) => p && Object.prototype.hasOwnProperty.call(p, 'systemPrompt'),
      )
      expect(systemPromptPatches).toEqual([])
      // claudeMd should still be prefilled because it was blank
      const claudeMdPatches = onChange.mock.calls.filter(
        ([p]) => p && Object.prototype.hasOwnProperty.call(p, 'claudeMd'),
      )
      expect(claudeMdPatches.length).toBe(1)
    })

    it('does not prefill systemPrompt for passive type', () => {
      const { onChange } = renderConfigStep({
        initialData: { type: 'passive', name: 'watcher', systemPrompt: '', claudeMd: '' },
      })
      // Passive type skips systemPrompt entirely AND claudeMd (which requires type === 'agent')
      const sysPatches = onChange.mock.calls.filter(
        ([p]) => p && Object.prototype.hasOwnProperty.call(p, 'systemPrompt'),
      )
      const claudePatches = onChange.mock.calls.filter(
        ([p]) => p && Object.prototype.hasOwnProperty.call(p, 'claudeMd'),
      )
      expect(sysPatches).toEqual([])
      expect(claudePatches).toEqual([])
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Contract 1: provider <select> → handleProviderChange wiring
  // Contract 6: side effects on provider switch (providerConfig reset)
  // ──────────────────────────────────────────────────────────────────────
  describe('handleProviderChange wiring', () => {
    it('select onChange fires handleProviderChange and resets providerConfig', () => {
      const { onChange } = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'sage',
          agentOptions: {
            provider: 'anthropic-api',
            providerConfig: { model: 'claude-sonnet-4-6', maxTokens: 16384 },
          },
        },
      })
      openPermissionsTab()
      onChange.mockClear()

      const select = screen.getByDisplayValue('Anthropic') as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'codex-cli' } })

      expect(onChange).toHaveBeenCalledTimes(1)
      const patch = onChange.mock.calls[0][0] as { agentOptions: { provider: string; providerConfig: Record<string, unknown> } }
      expect(patch.agentOptions.provider).toBe('codex-cli')
      expect(patch.agentOptions.providerConfig).toEqual({})
    })

    it('re-selecting the current provider is a no-op (same-value early return)', () => {
      const { onChange } = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'sage',
          agentOptions: { provider: 'anthropic-api', providerConfig: { model: 'x' } },
        },
      })
      openPermissionsTab()
      onChange.mockClear()

      const select = screen.getByDisplayValue('Anthropic') as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'anthropic-api' } })

      // handleProviderChange must early-return: zero onChange calls
      const providerPatches = onChange.mock.calls.filter(
        ([p]) => p && (p as { agentOptions?: { provider?: string } }).agentOptions?.provider !== undefined,
      )
      expect(providerPatches.length).toBe(0)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Contract 6 (continued): rerender drops stale provider config fields
  // ──────────────────────────────────────────────────────────────────────
  describe('provider field set rerender on switch', () => {
    it('switching from anthropic-api to codex-cli removes Max Tokens / Base URL inputs', () => {
      const { rerenderWith } = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'sage',
          agentOptions: {
            provider: 'anthropic-api',
            providerConfig: { model: 'claude-sonnet-4-6', maxTokens: 16384, baseUrl: 'x', apiKeyService: 'y' },
          },
        },
      })
      openPermissionsTab()
      // anthropic-api shows Model + Base URL + Keyring Service + Max Tokens
      expect(screen.getByText('Max Tokens')).toBeDefined()
      expect(screen.getByText('Base URL')).toBeDefined()
      expect(screen.getByText('Keyring Service')).toBeDefined()

      // Simulate parent threading the reset
      act(() => {
        rerenderWith({
          type: 'agent',
          name: 'sage',
          agentOptions: { provider: 'codex-cli', providerConfig: {} },
        })
      })
      openPermissionsTab()

      expect(screen.queryByText('Max Tokens')).toBeNull()
      expect(screen.queryByText('Base URL')).toBeNull()
      expect(screen.queryByText('Keyring Service')).toBeNull()
      // codex-cli is a CLI provider — only Model remains
      expect(screen.getByText('Model')).toBeDefined()
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Contract 3: empty-string / undefined deletion via real TextInput
  // ──────────────────────────────────────────────────────────────────────
  describe('handleProviderConfigOption — TextInput sanitization', () => {
    it('typing a value sets the key in providerConfig', () => {
      const { onChange } = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'sage',
          agentOptions: { provider: 'anthropic-api', providerConfig: {} },
        },
      })
      openPermissionsTab()
      onChange.mockClear()

      // The Model field renders as TextInput; find by placeholder
      const modelInput = screen.getByPlaceholderText('claude-sonnet-4-6') as HTMLInputElement
      fireEvent.change(modelInput, { target: { value: 'claude-opus-4' } })

      expect(onChange).toHaveBeenCalledTimes(1)
      const patch = onChange.mock.calls[0][0] as { agentOptions: { providerConfig: Record<string, unknown> } }
      expect(patch.agentOptions.providerConfig.model).toBe('claude-opus-4')
    })

    it('clearing a text input deletes the key (empty string -> undefined)', () => {
      const { onChange } = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'sage',
          agentOptions: {
            provider: 'anthropic-api',
            providerConfig: { model: 'claude-opus-4' },
          },
        },
      })
      openPermissionsTab()
      onChange.mockClear()

      const modelInput = screen.getByDisplayValue('claude-opus-4') as HTMLInputElement
      fireEvent.change(modelInput, { target: { value: '' } })

      expect(onChange).toHaveBeenCalledTimes(1)
      const patch = onChange.mock.calls[0][0] as { agentOptions: { providerConfig: Record<string, unknown> } }
      expect('model' in patch.agentOptions.providerConfig).toBe(false)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Contract 4: Number() / NaN rejection via real NumberInput
  // ──────────────────────────────────────────────────────────────────────
  describe('handleProviderConfigOption — NumberInput sanitization', () => {
    it('typing a valid number stores it numerically', () => {
      const { onChange } = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'sage',
          agentOptions: { provider: 'anthropic-api', providerConfig: {} },
        },
      })
      openPermissionsTab()
      onChange.mockClear()

      const maxTokensInput = screen.getByPlaceholderText('16384') as HTMLInputElement
      fireEvent.change(maxTokensInput, { target: { value: '8192' } })

      expect(onChange).toHaveBeenCalledTimes(1)
      const patch = onChange.mock.calls[0][0] as { agentOptions: { providerConfig: { maxTokens?: unknown } } }
      expect(patch.agentOptions.providerConfig.maxTokens).toBe(8192)
    })

    it('clearing the number input deletes the key (no NaN, no empty string)', () => {
      const { onChange } = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'sage',
          agentOptions: {
            provider: 'anthropic-api',
            providerConfig: { maxTokens: 16384 },
          },
        },
      })
      openPermissionsTab()
      onChange.mockClear()

      const maxTokensInput = screen.getByDisplayValue('16384') as HTMLInputElement
      fireEvent.change(maxTokensInput, { target: { value: '' } })

      expect(onChange).toHaveBeenCalledTimes(1)
      const patch = onChange.mock.calls[0][0] as { agentOptions: { providerConfig: Record<string, unknown> } }
      expect('maxTokens' in patch.agentOptions.providerConfig).toBe(false)
    })

    it('rejects invalid number input instead of storing NaN', () => {
      const { onChange } = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'sage',
          agentOptions: {
            provider: 'anthropic-api',
            providerConfig: { maxTokens: 16384 },
          },
        },
      })
      openPermissionsTab()
      onChange.mockClear()

      const maxTokensInput = screen.getByDisplayValue('16384') as HTMLInputElement
      Object.defineProperty(maxTokensInput, 'value', {
        configurable: true,
        get: () => '1e',
      })
      fireEvent.change(maxTokensInput)

      expect(onChange).toHaveBeenCalledTimes(1)
      const patch = onChange.mock.calls[0][0] as { agentOptions: { providerConfig: Record<string, unknown> } }
      expect(Number.isNaN(patch.agentOptions.providerConfig.maxTokens)).toBe(false)
      expect('maxTokens' in patch.agentOptions.providerConfig).toBe(false)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Contract 2: form validation error rendering
  // ──────────────────────────────────────────────────────────────────────
  describe('form validation error display', () => {
    it('renders cwd error text when errors.cwd is set', () => {
      renderConfigStep({
        initialData: { type: 'agent', name: 'sage' },
        errors: { cwd: 'Working directory is required' },
      })
      openPermissionsTab()

      expect(screen.getByText('Working directory is required')).toBeDefined()
    })

    it('renders systemPrompt error text when errors.systemPrompt is set', () => {
      renderConfigStep({
        initialData: { type: 'agent', name: 'sage', systemPrompt: '' },
        errors: { systemPrompt: 'System prompt must be at least 10 chars' },
      })
      fireEvent.click(screen.getByRole('tab', { name: /behavior/i }))

      expect(screen.getByText('System prompt must be at least 10 chars')).toBeDefined()
    })
  })
})
