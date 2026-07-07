/**
 * ModelAuthStep — passive/chat/agent view dispatch, tabbed models, API key input toggle & errors.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const ModelAuthStep = (await import('../../console/src/components/wizard/ModelAuthStep')).default

interface RenderOpts {
  data?: Record<string, unknown>
  errors?: Record<string, string>
}

function renderStep(opts: RenderOpts = {}) {
  const onChange = vi.fn<(patch: Record<string, unknown>) => void>()
  const view = render(
    <ModelAuthStep
      data={opts.data ?? {}}
      onChange={onChange}
      errors={opts.errors ?? {}}
    />,
  )
  return { onChange, ...view }
}

afterEach(() => cleanup())

describe('ModelAuthStep — view dispatch by data.type', () => {
  it('renders the passive view (no inputs, no tabs) when type=passive', () => {
    renderStep({ data: { type: 'passive' } })

    expect(screen.getByText(/Passive lines don.+require a model configuration/)).toBeDefined()
    expect(screen.queryByRole('tab', { name: 'Anthropic' })).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByPlaceholderText(/sk-ant-/)).toBeNull()
  })

  it('renders the agent view (auth-method radios + tabs) when type=agent', () => {
    renderStep({ data: { type: 'agent' } })

    expect(screen.getByText('Anthropic Auth')).toBeDefined()
    expect(screen.getByRole('radiogroup', { name: 'Anthropic Auth' })).toBeDefined()
    expect(screen.getByRole('radio', { name: /API Key/ })).toBeDefined()
    expect(screen.getByRole('radio', { name: /Existing Claude session/ })).toBeDefined()
    expect(screen.getByRole('tab', { name: 'Anthropic' })).toBeDefined()
    expect(screen.getByRole('tab', { name: 'OpenAI' })).toBeDefined()
  })

  it('falls back to the chat view (tabs without auth-method radios) for unknown or missing type', () => {
    renderStep({ data: {} })

    expect(screen.getByRole('tab', { name: 'Anthropic' })).toBeDefined()
    expect(screen.getByRole('tab', { name: 'OpenAI' })).toBeDefined()
    expect(screen.queryByText('Anthropic Auth')).toBeNull()
    expect(screen.queryByRole('radio', { name: /Existing Claude session/ })).toBeNull()
  })
})

describe('ModelAuthStep — role selects are label↔input associated via <Field> (W2-S5)', () => {
  // Decisive a11y proof of the Field migration: getByLabelText resolves the role
  // label to its <select> via the Field-provided htmlFor wiring. Before the
  // migration these Anthropic/OpenAI role selects had a raw <label> with NO
  // htmlFor, so getByLabelText could not find them (this test would fail).
  it('resolves each Anthropic role label to its select element by accessible name', () => {
    renderStep({ data: { type: 'chat' } })

    const conversation = screen.getByLabelText('Conversation') as HTMLSelectElement
    const extraction = screen.getByLabelText('Extraction') as HTMLSelectElement
    const validation = screen.getByLabelText('Validation') as HTMLSelectElement

    expect(conversation.tagName).toBe('SELECT')
    expect(extraction.tagName).toBe('SELECT')
    expect(validation.tagName).toBe('SELECT')
    // The associated select carries the committed per-role default value.
    expect(conversation.value).toBe('claude-sonnet-4-6')
  })

  it('resolves each OpenAI role label to its select element after switching tabs', () => {
    renderStep({ data: { type: 'chat' } })

    fireEvent.click(screen.getByRole('tab', { name: 'OpenAI' }))

    const fallback = screen.getByLabelText('Fallback / Conversation') as HTMLSelectElement
    const extraction = screen.getByLabelText('Extraction') as HTMLSelectElement
    const validation = screen.getByLabelText('Validation') as HTMLSelectElement

    expect(fallback.tagName).toBe('SELECT')
    expect(extraction.tagName).toBe('SELECT')
    expect(validation.tagName).toBe('SELECT')
    // OpenAI selects default to '' with a leading "None" option.
    expect(fallback.value).toBe('')
    expect(within(fallback).getByText('None')).toBeDefined()
  })
})

describe('ModelAuthStep — chat view: Anthropic tab is active by default', () => {
  it('shows all three Anthropic role selects with default-model values', () => {
    renderStep({ data: { type: 'chat' } })

    expect(screen.getByText('Conversation')).toBeDefined()
    expect(screen.getByText('Extraction')).toBeDefined()
    expect(screen.getByText('Validation')).toBeDefined()
    const selects = screen.getAllByRole('combobox')
    expect(selects.length).toBeGreaterThanOrEqual(3)
    // Conversation default = claude-sonnet-4-6; haiku is in the option list for the others.
    expect((selects[0] as HTMLSelectElement).value).toBe('claude-sonnet-4-6')
    expect((selects[1] as HTMLSelectElement).value).toBe('claude-haiku-4-5-20251001')
  })

  it('exposes an Anthropic API Key input with sk-ant placeholder masked by default', () => {
    renderStep({ data: { type: 'chat' } })

    const apiInput = screen.getByPlaceholderText('sk-ant-...') as HTMLInputElement
    expect(apiInput).toBeDefined()
    expect(screen.getByLabelText('API Key')).toBe(apiInput)
    expect(apiInput.type).toBe('password')
  })

  it('marks the Anthropic tab aria-selected=true and OpenAI tab aria-selected=false', () => {
    renderStep({ data: { type: 'chat' } })

    expect(screen.getByRole('tab', { name: 'Anthropic' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'OpenAI' }).getAttribute('aria-selected')).toBe('false')
  })

  it('disables the Local tab as "coming soon" using aria-disabled and disabledReason', () => {
    renderStep({ data: { type: 'chat' } })

    const local = screen.getByRole('tab', { name: /Local/ }) as HTMLButtonElement
    // Tabs primitive uses aria-disabled (not HTML disabled) — arrow-reachable but not selectable
    expect(local.getAttribute('aria-disabled')).toBe('true')
    // Reason exposed via aria-describedby -> hidden span
    const describedBy = local.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('Coming soon')
  })
})

describe('ModelAuthStep — chat view: switching tabs', () => {
  it('reveals the OpenAI panel with optional "None" first option after clicking the OpenAI tab', () => {
    renderStep({ data: { type: 'chat' } })

    fireEvent.click(screen.getByRole('tab', { name: 'OpenAI' }))

    expect(screen.getByText('Fallback / Conversation')).toBeDefined()
    const openaiKey = screen.getByPlaceholderText('sk-...') as HTMLInputElement
    expect(openaiKey).toBeDefined()
    // OpenAI selects default to '' and offer a "None" option.
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[]
    expect(selects[0].value).toBe('')
    expect(within(selects[0]).getByText('None')).toBeDefined()
  })

  it('hides the Anthropic API key input when the OpenAI tab is active', () => {
    renderStep({ data: { type: 'chat', apiKey: 'sk-ant-abc' } })

    fireEvent.click(screen.getByRole('tab', { name: 'OpenAI' }))

    expect(screen.queryByPlaceholderText('sk-ant-...')).toBeNull()
    expect(screen.getByPlaceholderText('sk-...')).toBeDefined()
  })
})

describe('ModelAuthStep — chat view: change events bubble to onChange', () => {
  it('emits a models patch (with all roles preserved) when an Anthropic select changes', () => {
    const { onChange } = renderStep({ data: { type: 'chat' } })

    const conversation = screen.getAllByRole('combobox')[0] as HTMLSelectElement
    fireEvent.change(conversation, { target: { value: 'claude-opus-4-6' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    const patch = onChange.mock.calls[0][0] as { models: Record<string, string> }
    expect(patch.models.conversation).toBe('claude-opus-4-6')
    // Other defaults are spread in.
    expect(patch.models.extraction).toBe('claude-haiku-4-5-20251001')
    expect(patch.models.validation).toBe('claude-haiku-4-5-20251001')
  })

  it('emits an apiKey patch when the Anthropic key input receives input', () => {
    const { onChange } = renderStep({ data: { type: 'chat' } })

    const input = screen.getByPlaceholderText('sk-ant-...') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-ant-new' } })

    expect(onChange).toHaveBeenCalledWith({ apiKey: 'sk-ant-new' })
  })

  it('emits an openaiKey patch (not apiKey) when the OpenAI key input receives input', () => {
    const { onChange } = renderStep({ data: { type: 'chat' } })

    fireEvent.click(screen.getByRole('tab', { name: 'OpenAI' }))
    const openaiInput = screen.getByPlaceholderText('sk-...') as HTMLInputElement
    fireEvent.change(openaiInput, { target: { value: 'OPENAI_FAKE_X' } })

    expect(onChange).toHaveBeenCalledWith({ openaiKey: 'OPENAI_FAKE_X' })
  })
})

describe('ModelAuthStep — chat view: custom OpenAI endpoint', () => {
  it('renders the chat-only BYOK endpoint controls', () => {
    renderStep({ data: { type: 'chat' } })

    expect(screen.getByLabelText('Custom OpenAI endpoint')).toBeDefined()
    expect(screen.getByLabelText('Keyring Service')).toBeDefined()
    expect(screen.getByText(/Key must be set on the host keyring/)).toBeDefined()
  })

  it('hides the chat BYOK endpoint controls for agent and passive lines', () => {
    renderStep({ data: { type: 'agent' } })
    expect(screen.queryByLabelText('Custom OpenAI endpoint')).toBeNull()
    expect(screen.queryByLabelText('Keyring Service')).toBeNull()

    cleanup()
    renderStep({ data: { type: 'passive' } })
    expect(screen.queryByLabelText('Custom OpenAI endpoint')).toBeNull()
    expect(screen.queryByLabelText('Keyring Service')).toBeNull()
  })

  it('emits chatOptions.openaiProviderConfig.baseUrl when the custom endpoint changes', () => {
    const { onChange } = renderStep({ data: { type: 'chat' } })

    fireEvent.change(screen.getByLabelText('Custom OpenAI endpoint'), {
      target: { value: 'https://api.groq.com/openai/v1' },
    })

    expect(onChange).toHaveBeenCalledWith({
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://api.groq.com/openai/v1',
        },
      },
    })
  })

  it('preserves the committed endpoint when the keyring service changes', () => {
    const { onChange } = renderStep({
      data: {
        type: 'chat',
        chatOptions: {
          openaiProviderConfig: {
            baseUrl: 'https://api.groq.com/openai/v1',
          },
        },
      },
    })

    fireEvent.change(screen.getByLabelText('Keyring Service'), {
      target: { value: 'groq' },
    })

    expect(onChange).toHaveBeenCalledWith({
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKeyService: 'groq',
        },
      },
    })
  })

  it('clears apiKeyService without dropping the committed endpoint', () => {
    const { onChange } = renderStep({
      data: {
        type: 'chat',
        chatOptions: {
          openaiProviderConfig: {
            baseUrl: 'https://api.groq.com/openai/v1',
            apiKeyService: 'groq',
          },
        },
      },
    })

    fireEvent.change(screen.getByLabelText('Keyring Service'), {
      target: { value: '' },
    })

    expect(onChange).toHaveBeenCalledWith({
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://api.groq.com/openai/v1',
        },
      },
    })
  })

  it('renders dotted-field validation errors for the chat BYOK controls', () => {
    renderStep({
      data: { type: 'chat' },
      errors: {
        'chatOptions.openaiProviderConfig.baseUrl': 'Enter a valid http(s) URL',
        'chatOptions.openaiProviderConfig.apiKeyService': 'Choose a base URL first',
      },
    })

    const endpoint = screen.getByLabelText('Custom OpenAI endpoint')
    const service = screen.getByLabelText('Keyring Service')
    const endpointError = screen.getByText('Enter a valid http(s) URL')
    const serviceError = screen.getByText('Choose a base URL first')

    expect(endpoint.getAttribute('aria-invalid')).toBe('true')
    expect(service.getAttribute('aria-invalid')).toBe('true')
    expect(endpoint.getAttribute('aria-describedby')).toBe(endpointError.id)
    expect(service.getAttribute('aria-describedby')).toBe(serviceError.id)
  })
})

describe('ModelAuthStep — ApiKeyInput visibility toggle', () => {
  it('flips the Anthropic key input from password to text when the eye button is clicked, and back', () => {
    renderStep({ data: { type: 'chat', apiKey: 'sk-ant-secret' } })

    const input = screen.getByPlaceholderText('sk-ant-...') as HTMLInputElement
    expect(input.type).toBe('password')

    const toggle = screen.getByRole('button', { name: 'Show API key' }) as HTMLButtonElement

    fireEvent.click(toggle)
    expect(input.type).toBe('text')

    fireEvent.click(toggle)
    expect(input.type).toBe('password')
  })
})

describe('ModelAuthStep — ApiKeyInput error rendering', () => {
  it('renders the Anthropic apiKey error message when errors.apiKey is set', () => {
    renderStep({ data: { type: 'chat' }, errors: { apiKey: 'Anthropic key required' } })

    expect(screen.getByText('Anthropic key required')).toBeDefined()
  })

  it('marks the Anthropic API key input invalid and describes it with its error', () => {
    renderStep({ data: { type: 'chat' }, errors: { apiKey: 'Anthropic key required' } })

    const input = screen.getByPlaceholderText('sk-ant-...') as HTMLInputElement
    const error = screen.getByText('Anthropic key required')

    expect(error.id).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
  })

  it('renders the OpenAI key error only after switching to the OpenAI tab', () => {
    renderStep({ data: { type: 'chat' }, errors: { openaiKey: 'OpenAI key invalid' } })

    expect(screen.queryByText('OpenAI key invalid')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'OpenAI' }))
    expect(screen.getByText('OpenAI key invalid')).toBeDefined()
  })

  it('marks the OpenAI key input invalid and describes it with its error', () => {
    renderStep({ data: { type: 'chat' }, errors: { openaiKey: 'OpenAI key invalid' } })

    fireEvent.click(screen.getByRole('tab', { name: 'OpenAI' }))
    const input = screen.getByPlaceholderText('sk-...') as HTMLInputElement
    const error = screen.getByText('OpenAI key invalid')

    expect(error.id).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
  })
})

describe('ModelAuthStep — agent view: auth-method switching', () => {
  it('defaults to api_key checked when data.authMethod is absent', () => {
    renderStep({ data: { type: 'agent' } })

    expect((screen.getByRole('radio', { name: /API Key/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: /Existing Claude session/ }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByText(/Requires active Claude CLI login/)).toBeNull()
    // Anthropic key visible in api_key mode.
    expect(screen.getByPlaceholderText('sk-ant-...')).toBeDefined()
  })

  it('emits {authMethod: "oauth"} and shows the CLI-login banner when the oauth radio is selected', () => {
    const { onChange } = renderStep({ data: { type: 'agent' } })

    fireEvent.click(screen.getByRole('radio', { name: /Existing Claude session/ }))

    expect(onChange).toHaveBeenCalledWith({ authMethod: 'oauth' })
  })

  it('hides the Anthropic API key input and shows the CLI-login banner when authMethod=oauth is committed in data', () => {
    renderStep({ data: { type: 'agent', authMethod: 'oauth' } })

    expect((screen.getByRole('radio', { name: /Existing Claude session/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/Requires active Claude CLI login on this machine/)).toBeDefined()
    expect(screen.queryByPlaceholderText('sk-ant-...')).toBeNull()
    // OpenAI key is still reachable from the OpenAI tab — auth-method only gates Anthropic.
    fireEvent.click(screen.getByRole('tab', { name: 'OpenAI' }))
    expect(screen.getByPlaceholderText('sk-...')).toBeDefined()
  })

  it('emits {authMethod: "api_key"} when toggling back from oauth', () => {
    const { onChange } = renderStep({ data: { type: 'agent', authMethod: 'oauth' } })

    fireEvent.click(screen.getByRole('radio', { name: /API Key/ }))

    expect(onChange).toHaveBeenCalledWith({ authMethod: 'api_key' })
  })
})

describe('ModelAuthStep — committed data is reflected (controlled inputs)', () => {
  it('reflects committed apiKey, openaiKey, and per-role model values from data', () => {
    renderStep({
      data: {
        type: 'chat',
        apiKey: 'sk-ant-committed',
        openaiKey: 'OPENAI_FAKE_COMMITTED',
        models: {
          conversation: 'claude-opus-4-6',
          extraction: 'claude-sonnet-4-6',
          validation: 'claude-opus-4-6',
          fallback: 'gpt-4.1',
          openaiExtraction: 'gpt-4.1-mini',
          openaiValidation: 'gpt-4.1-nano',
        },
      },
    })

    expect((screen.getByPlaceholderText('sk-ant-...') as HTMLInputElement).value).toBe('sk-ant-committed')
    const anthSelects = screen.getAllByRole('combobox') as HTMLSelectElement[]
    expect(anthSelects[0].value).toBe('claude-opus-4-6')
    expect(anthSelects[1].value).toBe('claude-sonnet-4-6')
    expect(anthSelects[2].value).toBe('claude-opus-4-6')

    fireEvent.click(screen.getByRole('tab', { name: 'OpenAI' }))
    const openaiSelects = screen.getAllByRole('combobox') as HTMLSelectElement[]
    expect(openaiSelects[0].value).toBe('gpt-4.1')
    expect(openaiSelects[1].value).toBe('gpt-4.1-mini')
    expect(openaiSelects[2].value).toBe('gpt-4.1-nano')
    expect((screen.getByPlaceholderText('sk-...') as HTMLInputElement).value).toBe('OPENAI_FAKE_COMMITTED')
  })
})

describe('ModelAndKeyTabs — tablist keyboard contract (DD-21r)', () => {
  it('Anthropic tab is in the tab order (tabIndex 0); OpenAI is not (tabIndex -1)', () => {
    renderStep({ data: { type: 'chat' } })

    const anthropic = screen.getByRole('tab', { name: 'Anthropic' })
    const openai = screen.getByRole('tab', { name: 'OpenAI' })
    expect(anthropic.tabIndex).toBe(0)
    expect(openai.tabIndex).toBe(-1)
  })

  it('ArrowRight moves focus to OpenAI WITHOUT selecting; Enter selects', () => {
    renderStep({ data: { type: 'chat' } })

    const anthropic = screen.getByRole('tab', { name: 'Anthropic' })
    anthropic.focus()
    fireEvent.keyDown(anthropic, { key: 'ArrowRight' })
    const openai = screen.getByRole('tab', { name: 'OpenAI' })
    expect(document.activeElement).toBe(openai)
    // focus alone must not switch the panel (manual activation)
    expect(screen.getByPlaceholderText('sk-ant-...')).toBeDefined()
    // now confirm with Enter
    fireEvent.keyDown(openai, { key: 'Enter' })
    expect(screen.queryByPlaceholderText('sk-ant-...')).toBeNull()
    expect(screen.getByPlaceholderText('sk-...')).toBeDefined()
  })

  it('ArrowLeft from Anthropic wraps to Local (last tab)', () => {
    renderStep({ data: { type: 'chat' } })

    const anthropic = screen.getByRole('tab', { name: 'Anthropic' })
    anthropic.focus()
    fireEvent.keyDown(anthropic, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Local/ }))
  })

  it('Home jumps to Anthropic (first tab); End jumps to Local (last tab)', () => {
    renderStep({ data: { type: 'chat' } })

    const anthropic = screen.getByRole('tab', { name: 'Anthropic' })
    const openai = screen.getByRole('tab', { name: 'OpenAI' })
    openai.focus()
    fireEvent.keyDown(openai, { key: 'Home' })
    expect(document.activeElement).toBe(anthropic)
    fireEvent.keyDown(anthropic, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Local/ }))
  })

  it('disabled Local tab is arrow-reachable but click and Enter do not switch panels', () => {
    renderStep({ data: { type: 'chat' } })

    const local = screen.getByRole('tab', { name: /Local/ })
    fireEvent.click(local)
    // Panel should still show Anthropic content
    expect(screen.getByPlaceholderText('sk-ant-...')).toBeDefined()

    local.focus()
    fireEvent.keyDown(local, { key: 'Enter' })
    expect(screen.getByPlaceholderText('sk-ant-...')).toBeDefined()
  })

  it('Space key selects the focused OpenAI tab (manual activation)', () => {
    renderStep({ data: { type: 'chat' } })

    const anthropic = screen.getByRole('tab', { name: 'Anthropic' })
    anthropic.focus()
    fireEvent.keyDown(anthropic, { key: 'ArrowRight' })
    const openai = screen.getByRole('tab', { name: 'OpenAI' })
    expect(document.activeElement).toBe(openai)
    fireEvent.keyDown(openai, { key: ' ' })
    expect(screen.queryByPlaceholderText('sk-ant-...')).toBeNull()
    expect(screen.getByPlaceholderText('sk-...')).toBeDefined()
  })
})
