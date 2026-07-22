/**
 * ConfigStep — broad tab wiring coverage for non-provider controls.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ReactElement, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfigStep from '../../console/src/components/wizard/ConfigStep'

afterEach(() => cleanup())

interface RenderOpts {
  initialData?: Record<string, unknown>
  errors?: Record<string, string>
  includeSkip?: boolean
}

function renderConfigStep(opts: RenderOpts = {}) {
  const onChange = vi.fn()
  const onSkip = vi.fn()
  const initialData: Record<string, unknown> = {
    type: 'agent',
    name: 'test-agent',
    systemPrompt: 'Existing prompt',
    claudeMd: 'Existing CLAUDE.md',
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

    return (
      <ConfigStep
        data={data}
        onChange={handleChange}
        errors={opts.errors ?? {}}
        onSkip={opts.includeSkip ? onSkip : undefined}
      />
    )
  }

  const utils = render(<Harness />)
  return { onChange, onSkip, getData: () => latestData, ...utils }
}

function openTab(name: RegExp | string) {
  fireEvent.click(screen.getByRole('tab', { name }))
}

function installFileReader(result: string) {
  const OriginalFileReader = globalThis.FileReader
  class MockFileReader {
    result: string | ArrayBuffer | null = null
    onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null
    readAsText(_file: Blob) {
      this.result = result
      this.onload?.call(this as unknown as FileReader, new ProgressEvent('load') as ProgressEvent<FileReader>)
    }
  }
  globalThis.FileReader = MockFileReader as unknown as typeof FileReader
  return () => {
    globalThis.FileReader = OriginalFileReader
  }
}

function latestAgentOptions(onChange: ReturnType<typeof vi.fn>) {
  const patch = onChange.mock.calls.at(-1)?.[0] as { agentOptions?: Record<string, unknown> } | undefined
  return patch?.agentOptions ?? {}
}

describe('ConfigStep — access and behavior tabs', () => {
  it('prefills chat prompts without agent CLAUDE.md and returns to the access tab', () => {
    const { onChange } = renderConfigStep({
      initialData: { type: 'chat', name: 'helper', systemPrompt: '', claudeMd: '' },
    })
    expect(onChange).toHaveBeenCalledWith({
      systemPrompt: expect.stringContaining('AI assistant'),
    })
    expect(onChange.mock.calls.some(([patch]) => Object.prototype.hasOwnProperty.call(patch, 'claudeMd'))).toBe(false)

    openTab(/behavior/i)
    openTab(/access/i)
    expect(screen.getByText('Access Mode')).toBeDefined()
  })

  it('writes access mode changes without presenting an unwritten pre-approval control', () => {
    const { onChange } = renderConfigStep({ initialData: { accessMode: 'self_only' } })

    // Access-mode options are a WAI radiogroup (CardSelector, DD-14) — each option
    // is role="radio" with its accessible name composed from label + description.
    fireEvent.click(screen.getByRole('radio', { name: /Allowlist Approved contacts only/i }))
    expect(onChange).toHaveBeenLastCalledWith({ accessMode: 'allowlist' })
    expect(screen.queryByLabelText('Pre-approved contacts')).toBeNull()
    expect(screen.queryByText(/automatically approved when they first message/i)).toBeNull()

    onChange.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: /Open DMs Anyone can send direct messages/i }))
    expect(onChange).toHaveBeenLastCalledWith({ accessMode: 'open_dm' })
    expect(screen.getByText(/Anyone can send a direct message/)).toBeDefined()

    onChange.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: /Groups Only Only responds in group chats/i }))
    expect(onChange).toHaveBeenLastCalledWith({ accessMode: 'groups_only' })
    expect(screen.getByText(/Direct messages are ignored/)).toBeDefined()
  })

  it('offers only functional access modes for an interactive Twilio SMS line', () => {
    renderConfigStep({
      initialData: {
        transport: 'twilio',
        type: 'chat',
        accessMode: 'self_only',
      },
    })

    expect(screen.getByText(/Twilio SMS cannot authenticate sender identity/)).toBeDefined()
    expect(screen.getByText(/Admin Only and Groups Only are unavailable/)).toBeDefined()
    expect(screen.getByRole('radio', { name: /Allowlist Approved contacts only/i })).toBeDefined()
    expect(screen.getByRole('radio', { name: /Open DMs Anyone can send direct messages/i })).toBeDefined()
    expect(screen.queryByRole('radio', { name: /Admin Only/i })).toBeNull()
    expect(screen.queryByRole('radio', { name: /Groups Only/i })).toBeNull()
    expect(screen.queryByLabelText('Pre-approved contacts')).toBeNull()
    expect(screen.getByText(/New SMS contacts remain pending until an operator approves or blocks them in the console/)).toBeDefined()
  })

  it.each([
    ['baileys', 'WhatsApp'],
    ['twilio', 'SMS'],
    ['signal', 'Signal'],
    ['imessage', 'iMessage'],
  ] as const)('prefills %s agent instructions for the actual %s transport', (transport, channel) => {
    const { onChange } = renderConfigStep({
      initialData: {
        transport,
        type: 'agent',
        name: `${transport}-agent`,
        systemPrompt: '',
        claudeMd: '',
      },
    })

    const prefill = onChange.mock.calls.find(([patch]) => (
      Object.prototype.hasOwnProperty.call(patch, 'systemPrompt')
      && Object.prototype.hasOwnProperty.call(patch, 'claudeMd')
    ))?.[0] as Record<string, unknown> | undefined
    expect(prefill?.systemPrompt).toContain(`on ${channel}`)
    expect(prefill?.systemPrompt).toContain(`${channel} messages`)
    expect(prefill?.claudeMd).toContain(`${channel} Agent`)
    expect(prefill?.claudeMd).toContain(`running on ${channel} via WhatSoup`)
    if (transport !== 'baileys') {
      expect(prefill?.systemPrompt).not.toContain('WhatsApp')
      expect(prefill?.claudeMd).not.toContain('WhatsApp')
    }
  })

  it('updates behavior text fields and hides system prompts for passive lines', () => {
    const { onChange } = renderConfigStep()
    openTab(/behavior/i)
    onChange.mockClear()

    fireEvent.change(screen.getByLabelText('System Prompt'), { target: { value: 'New prompt' } })
    expect(onChange).toHaveBeenLastCalledWith({ systemPrompt: 'New prompt' })

    fireEvent.change(screen.getByDisplayValue('Existing CLAUDE.md'), { target: { value: '# Runtime Rules' } })
    expect(onChange).toHaveBeenLastCalledWith({ claudeMd: '# Runtime Rules' })

    cleanup()
    renderConfigStep({ initialData: { type: 'passive', systemPrompt: '', claudeMd: '' } })
    openTab(/behavior/i)
    expect(screen.queryByLabelText('System Prompt')).toBeNull()
    expect(screen.getByText('CLAUDE.md Instructions')).toBeDefined()
  })

  it('loads CLAUDE.md file contents through FileReader', () => {
    const restoreFileReader = installFileReader('# Uploaded Instructions')
    const { container, onChange } = renderConfigStep()
    openTab(/behavior/i)
    onChange.mockClear()

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['ignored'], 'CLAUDE.md', { type: 'text/markdown' })] },
    })

    expect(onChange).toHaveBeenCalledWith({ claudeMd: '# Uploaded Instructions' })
    onChange.mockClear()
    fireEvent.change(fileInput, { target: { files: [] } })
    expect(onChange).not.toHaveBeenCalled()
    restoreFileReader()
  })
})

describe('ConfigStep — permissions tab non-provider controls', () => {
  it('clears fallback model and provider through their visible fields', () => {
    const { onChange } = renderConfigStep({
      initialData: {
        agentOptions: {
          provider: 'claude-cli',
          fallbackProvider: 'openai-api',
          fallbackModel: 'gpt-4o',
        },
      },
    })
    openTab(/permissions/i)
    onChange.mockClear()

    fireEvent.change(screen.getByDisplayValue('gpt-4o'), { target: { value: '' } })
    expect(Object.prototype.hasOwnProperty.call(latestAgentOptions(onChange), 'fallbackModel')).toBe(false)
    expect(latestAgentOptions(onChange).fallbackProvider).toBe('openai-api')

    onChange.mockClear()
    fireEvent.change(screen.getByDisplayValue('OpenAI'), { target: { value: 'openai-api' } })
    expect(onChange).not.toHaveBeenCalled()

    onChange.mockClear()
    fireEvent.change(screen.getByLabelText('Fallback Provider'), { target: { value: '' } })
    expect(Object.prototype.hasOwnProperty.call(latestAgentOptions(onChange), 'fallbackProvider')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(latestAgentOptions(onChange), 'fallbackModel')).toBe(false)
  })

  it('treats unchanged provider config edits as no-ops', () => {
    const { onChange } = renderConfigStep({
      initialData: {
        agentOptions: {
          provider: 'anthropic-api',
          providerConfig: { model: 'claude-sonnet-4-6' },
        },
      },
    })
    openTab(/permissions/i)
    onChange.mockClear()

    fireEvent.change(screen.getByDisplayValue('claude-sonnet-4-6'), { target: { value: 'claude-sonnet-4-6' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('writes nested agent permission toggles, per-user dirs, and plugin presets', () => {
    const { onChange } = renderConfigStep({ initialData: { agentOptions: {} } })
    openTab(/permissions/i)
    onChange.mockClear()

    fireEvent.change(screen.getByLabelText('Working Directory'), { target: { value: '/srv/test-agent' } })
    expect(latestAgentOptions(onChange).cwd).toBe('/srv/test-agent')

    fireEvent.change(screen.getByLabelText('Session Scope'), { target: { value: 'shared' } })
    expect(latestAgentOptions(onChange).sessionScope).toBe('shared')

    fireEvent.click(screen.getByLabelText('Isolate per-chat workspaces'))
    expect(latestAgentOptions(onChange).sandboxPerChat).toBe(false)

    fireEvent.click(screen.getByLabelText('Enable per-user directories'))
    expect(latestAgentOptions(onChange).perUserDirs).toEqual({ enabled: true, basePath: 'users' })

    fireEvent.change(screen.getByLabelText('Base path'), { target: { value: 'members' } })
    expect(latestAgentOptions(onChange).perUserDirs).toEqual({ enabled: true, basePath: 'members' })

    fireEvent.click(screen.getByLabelText('Allow bash commands'))
    expect(latestAgentOptions(onChange).sandbox).toEqual({ bash: { enabled: false } })

    fireEvent.click(screen.getByLabelText('Restrict bash to allowed paths'))
    expect(latestAgentOptions(onChange).sandbox).toEqual({ bash: { enabled: false, pathRestricted: false } })

    fireEvent.click(screen.getByLabelText('Allow sending media (images, files)'))
    expect(latestAgentOptions(onChange).mcp).toEqual({ send_media: false })

    fireEvent.click(screen.getByLabelText(/SDLC-OS/))
    expect((latestAgentOptions(onChange).enabledPlugins as Record<string, boolean>)['sdlc-os@sdlc-os-dev']).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Enable all' }))
    const allEnabled = latestAgentOptions(onChange).enabledPlugins as Record<string, boolean>
    expect(Object.values(allEnabled).every(Boolean)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Core only' }))
    const coreOnly = latestAgentOptions(onChange).enabledPlugins as Record<string, boolean>
    expect(coreOnly['superpowers@superpowers-marketplace']).toBe(true)
    expect(coreOnly['sdlc-os@sdlc-os-dev']).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Reset to global defaults' }))
    expect(latestAgentOptions(onChange).enabledPlugins).toEqual({})
  })

  it('saves valid custom settings JSON and ignores invalid edits', () => {
    const { onChange } = renderConfigStep()
    openTab(/permissions/i)
    onChange.mockClear()

    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'custom' } })
    expect(onChange).toHaveBeenLastCalledWith({ settingsJsonMode: 'custom' })

    onChange.mockClear()
    const settingsJson = screen.getByPlaceholderText(/"permissions"/)
    fireEvent.change(settingsJson, { target: { value: '{"permissions":{"allow":["Read"],"deny":[]}}' } })
    expect(onChange).toHaveBeenLastCalledWith({ settingsJson: { permissions: { allow: ['Read'], deny: [] } } })

    onChange.mockClear()
    fireEvent.change(settingsJson, { target: { value: '{"permissions":' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('resets custom settings JSON to defaults and imports JSON files', () => {
    const restoreFileReader = installFileReader('{"permissions":{"allow":["Bash"]}}')
    const { container, onChange } = renderConfigStep({
      initialData: {
        settingsJsonMode: 'custom',
        settingsJson: { permissions: { allow: ['Read'], deny: [] } },
      },
    })
    openTab(/permissions/i)
    onChange.mockClear()

    const fileInput = container.querySelector('input[accept=".json"]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['ignored'], 'settings.json', { type: 'application/json' })] },
    })
    expect(onChange).toHaveBeenLastCalledWith({ settingsJson: { permissions: { allow: ['Bash'] } } })

    onChange.mockClear()
    fireEvent.change(fileInput, { target: { files: [] } })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'default' } })
    expect(onChange).toHaveBeenCalledWith({ settingsJsonMode: 'default' })
    expect(onChange).toHaveBeenLastCalledWith({ settingsJson: undefined, settingsJsonMode: 'default' })
    restoreFileReader()
  })
})

describe('ConfigStep — limits, RAG, and skip actions', () => {
  it('writes numeric limit fields, tool-update mode, and skip action', () => {
    const { onChange, onSkip } = renderConfigStep({ includeSkip: true })
    openTab(/limits/i)
    onChange.mockClear()

    fireEvent.change(screen.getByLabelText('Messages per hour'), { target: { value: '24' } })
    expect(onChange).toHaveBeenLastCalledWith({ rateLimitPerHour: 24 })

    fireEvent.change(screen.getByLabelText('Max tokens per response'), { target: { value: '2048' } })
    expect(onChange).toHaveBeenLastCalledWith({ maxTokens: 2048 })

    fireEvent.change(screen.getByLabelText('Token budget per session'), { target: { value: '12000' } })
    expect(onChange).toHaveBeenLastCalledWith({ tokenBudget: 12000 })

    fireEvent.change(screen.getByLabelText('Tool update verbosity'), { target: { value: 'minimal' } })
    expect(onChange).toHaveBeenLastCalledWith({ toolUpdateMode: 'minimal' })

    fireEvent.click(screen.getByRole('button', { name: 'Skip — Use Defaults' }))
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('writes RAG index, search mode, rerank, TopK, and allowed index tags', () => {
    const { onChange } = renderConfigStep({ initialData: { pineconeAllowedIndexes: ['dev-docs'] } })
    openTab(/rag/i)
    onChange.mockClear()

    fireEvent.change(screen.getByLabelText('Pinecone Index Name'), { target: { value: 'thinkers-lab' } })
    expect(onChange).toHaveBeenLastCalledWith({ pineconeIndex: 'thinkers-lab' })

    fireEvent.click(screen.getByRole('button', { name: 'Entity' }))
    expect(onChange).toHaveBeenLastCalledWith({ pineconeSearchMode: 'Entity' })

    fireEvent.click(screen.getByLabelText('Rerank results'))
    expect(onChange).toHaveBeenLastCalledWith({ pineconeRerank: true })

    fireEvent.change(screen.getByLabelText('TopK'), { target: { value: '8' } })
    expect(onChange).toHaveBeenLastCalledWith({ pineconeTopK: 8 })

    const indexInput = screen.getByPlaceholderText('Index name (press Enter to add)')
    fireEvent.change(indexInput, { target: { value: 'oneplatform-codebase-v2' } })
    fireEvent.keyDown(indexInput, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith({
      pineconeAllowedIndexes: ['dev-docs', 'oneplatform-codebase-v2'],
    })
  })
})
