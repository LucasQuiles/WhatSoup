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

    it('regenerates recognized defaults when the selected transport changes', () => {
      const signalRender = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'sage',
          transport: 'signal',
          systemPrompt: '',
          claudeMd: '',
        },
      })
      const signalDefaults = signalRender.onChange.mock.calls[0][0] as Record<string, unknown>
      expect(signalDefaults.systemPrompt).toContain('Signal')
      expect(signalDefaults.claudeMd).toContain('Signal')
      signalRender.unmount()

      const twilioRender = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'renamed-sage',
          transport: 'twilio',
          ...signalDefaults,
        },
      })

      expect(twilioRender.onChange).toHaveBeenCalledWith({
        systemPrompt: expect.stringContaining('SMS'),
        claudeMd: expect.stringContaining('SMS'),
      })
      const twilioDefaults = twilioRender.onChange.mock.calls[0][0] as Record<string, unknown>
      expect(twilioDefaults.systemPrompt).toContain('Renamed-sage')
      expect(twilioDefaults.systemPrompt).not.toContain('Signal')
      expect(twilioDefaults.claudeMd).not.toContain('Signal')
    })

    it('preserves user-authored instructions when the selected transport changes', () => {
      const systemPrompt = 'Follow the operator handbook exactly.'
      const claudeMd = '# Custom runtime policy\n\nNever replace this text.'
      const { onChange, rerenderWith } = renderConfigStep({
        initialData: {
          type: 'agent',
          name: 'sage',
          transport: 'signal',
          systemPrompt,
          claudeMd,
        },
      })

      onChange.mockClear()
      rerenderWith({
        type: 'agent',
        name: 'sage',
        transport: 'twilio',
        systemPrompt,
        claudeMd,
      })

      expect(onChange).not.toHaveBeenCalled()
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

  describe('enabled plugin checkboxes', () => {
    it('renders plugin toggles through CheckboxField and patches enabledPlugins', () => {
      const { onChange } = renderConfigStep({
        initialData: { type: 'agent', name: 'sage' },
      })
      openPermissionsTab()
      onChange.mockClear()

      const checkbox = screen.getByRole('checkbox', {
        name: /Superpowers Brainstorming, TDD, debugging, plans, verification/,
      }) as HTMLInputElement
      const row = checkbox.closest('label')

      expect(checkbox.checked).toBe(true)
      expect(row?.classList.contains('c-checkbox-row')).toBe(true)

      fireEvent.click(checkbox)

      expect(onChange).toHaveBeenCalledTimes(1)
      const patch = onChange.mock.calls[0][0] as {
        agentOptions: { enabledPlugins: Record<string, boolean> }
      }
      expect(patch.agentOptions.enabledPlugins['superpowers@superpowers-marketplace']).toBe(false)
    })
  })

  describe('allowlist truthfulness', () => {
    it('does not render an unwritten pre-approved contacts control', () => {
      renderConfigStep({
        initialData: { type: 'agent', name: 'sage', accessMode: 'allowlist' },
      })

      expect(screen.queryByLabelText('Pre-approved contacts')).toBeNull()
      expect(screen.queryByText(/automatically approved when they first message/i)).toBeNull()
    })

    it('labels the RAG allowed indexes input and describes it with its Field helper', () => {
      renderConfigStep({
        initialData: { type: 'agent', name: 'sage' },
      })
      fireEvent.click(screen.getByRole('tab', { name: /RAG/i }))

      const input = screen.getByLabelText('Allowed indexes') as HTMLInputElement
      const helper = screen.getByText('Restrict which Pinecone indexes this instance can query')

      expect(helper.id).toBeTruthy()
      expect(input.getAttribute('aria-describedby')).toBe(helper.id)
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

describe('ConfigStep — tablist keyboard contract (DD-21r)', () => {
  it('Access tab is in the tab order (tabIndex 0) by default; other tabs are not', () => {
    const { } = renderConfigStep()

    expect(screen.getByRole('tab', { name: 'Access' }).tabIndex).toBe(0)
    expect(screen.getByRole('tab', { name: 'Behavior' }).tabIndex).toBe(-1)
    expect(screen.getByRole('tab', { name: 'Limits' }).tabIndex).toBe(-1)
  })

  it('ArrowRight moves focus without selecting (manual activation); Enter selects', () => {
    renderConfigStep()

    const access = screen.getByRole('tab', { name: 'Access' })
    access.focus()
    fireEvent.keyDown(access, { key: 'ArrowRight' })
    const behavior = screen.getByRole('tab', { name: 'Behavior' })
    expect(document.activeElement).toBe(behavior)
    // no panel switch yet
    expect(screen.queryByPlaceholderText('You are a helpful assistant...')).toBeNull()
    // Enter selects
    fireEvent.keyDown(behavior, { key: 'Enter' })
    expect(screen.getByRole('tabpanel')).toBeDefined()
    expect(screen.getByRole('tab', { name: 'Behavior' }).getAttribute('aria-selected')).toBe('true')
  })

  it('Space key selects the focused tab (manual activation)', () => {
    renderConfigStep()

    const access = screen.getByRole('tab', { name: 'Access' })
    access.focus()
    fireEvent.keyDown(access, { key: 'ArrowRight' })
    const behavior = screen.getByRole('tab', { name: 'Behavior' })
    fireEvent.keyDown(behavior, { key: ' ' })
    expect(screen.getByRole('tab', { name: 'Behavior' }).getAttribute('aria-selected')).toBe('true')
  })

  it('Home moves focus to Access (first tab); End moves to the last tab', () => {
    renderConfigStep()

    const access = screen.getByRole('tab', { name: 'Access' })
    const behavior = screen.getByRole('tab', { name: 'Behavior' })
    behavior.focus()
    fireEvent.keyDown(behavior, { key: 'Home' })
    expect(document.activeElement).toBe(access)
    fireEvent.keyDown(access, { key: 'End' })
    // last tab in agent mode is RAG
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /RAG/ }))
  })

  it('ArrowLeft from Access wraps to the last tab', () => {
    renderConfigStep()

    const access = screen.getByRole('tab', { name: 'Access' })
    access.focus()
    fireEvent.keyDown(access, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /RAG/ }))
  })

  it('tablist has accessible label', () => {
    renderConfigStep()
    expect(screen.getByRole('tablist', { name: 'Config sections' })).toBeDefined()
  })

  it('Permissions tab present for agent type; absent for chat type', () => {
    const { } = renderConfigStep({ initialData: { type: 'agent', name: 'a' } })
    expect(screen.getByRole('tab', { name: /Permissions/i })).toBeDefined()

    cleanup()
    renderConfigStep({ initialData: { type: 'chat', name: 'b' } })
    expect(screen.queryByRole('tab', { name: /Permissions/i })).toBeNull()
  })
})
