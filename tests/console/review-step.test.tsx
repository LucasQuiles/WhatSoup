/**
 * ReviewStep — pure-render behavior coverage for the wizard summary card stack.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import ReviewStep from '../../console/src/components/wizard/ReviewStep'

afterEach(() => cleanup())

interface RenderOpts {
  data?: Record<string, unknown>
  creating?: boolean
  error?: string | null
  onEditPhase?: (phase: number) => void
  onCreateLine?: () => Promise<void>
}

function renderReview(opts: RenderOpts = {}) {
  const onEditPhase = vi.fn(opts.onEditPhase)
  const onCreateLine = vi.fn(async () => {
    if (opts.onCreateLine) await opts.onCreateLine()
  })
  const utils = render(
    createElement(ReviewStep, {
      data: opts.data ?? {},
      onEditPhase,
      onCreateLine,
      creating: opts.creating ?? false,
      error: opts.error ?? null,
    }),
  )
  return { ...utils, onEditPhase, onCreateLine }
}

/** Find the value span of a KV row by its label. */
function kvValue(label: string): string {
  const labelEl = screen.getByText(label)
  const row = labelEl.parentElement
  if (!row) throw new Error(`KV row not found for label "${label}"`)
  const valueSpan = row.querySelector('span.font-mono')
  if (!valueSpan) throw new Error(`KV value span not found for label "${label}"`)
  return valueSpan.textContent ?? ''
}

function kvExists(label: string): boolean {
  return screen.queryByText(label) !== null
}

describe('ReviewStep — Identity card', () => {
  it('renders name, type badge, and admin phone count for chat type', () => {
    renderReview({
      data: {
        name: 'review-fixture-1',
        type: 'chat',
        adminPhones: ['+10000000001', '+10000000002', '+10000000003'],
      },
    })
    expect(screen.getByText('Identity')).toBeDefined()
    expect(kvValue('Name')).toBe('review-fixture-1')
    expect(kvValue('Admin Phones')).toBe('3 configured')
    // ModeBadge renders the mode label inside the KV row.
    expect(screen.getByText('chat')).toBeDefined()
  })

  it('falls back to "-" when name is missing and omits the Description row when empty', () => {
    renderReview({ data: { type: 'agent', adminPhones: [] } })
    expect(kvValue('Name')).toBe('-')
    expect(kvValue('Admin Phones')).toBe('0 configured')
    expect(kvExists('Description')).toBe(false)
  })

  it('renders the Description row when a description is provided', () => {
    renderReview({
      data: {
        name: 'review-fixture-2',
        type: 'passive',
        description: 'synthetic description for tree inspection',
        adminPhones: ['+10000000010'],
      },
    })
    expect(kvValue('Description')).toBe('synthetic description for tree inspection')
  })
})

describe('ReviewStep — canonical transport config', () => {
  it('renders the nested Twilio config and keyring service without a raw token', () => {
    const { container } = renderReview({
      data: {
        name: 'twilio-review',
        type: 'passive',
        transport: 'twilio',
        adminPhones: ['15551234567'],
        twilioConfig: {
          accountSid: `AC${'a'.repeat(32)}`,
          authTokenService: 'whatsoup-twilio-twilio-review',
          authToken: 'must-not-render',
          messagingServiceSid: `MG${'b'.repeat(32)}`,
        },
      },
    })

    expect(screen.getByText('Transport')).toBeDefined()
    expect(kvValue('SMS Access Phones')).toBe('1 configured')
    expect(screen.queryByText('Admin IDs')).toBeNull()
    expect(kvValue('Account SID')).toBe(`AC${'a'.repeat(32)}`)
    expect(kvValue('Auth token service')).toBe('whatsoup-twilio-twilio-review')
    expect(kvValue('Sender')).toBe(`MG${'b'.repeat(32)}`)
    expect(container.textContent).not.toContain('must-not-render')
  })

  it('directs Twilio adminPhones errors to the truthful SMS-access field', () => {
    renderReview({
      data: { name: 'twilio-review', type: 'chat', transport: 'twilio', adminPhones: [] },
      error: 'adminPhones must be a non-empty array',
    })

    expect(screen.getByText(/At least one notification phone is required/)).toBeDefined()
    expect(screen.queryByText(/admin phone number is required/i)).toBeNull()
  })

  it('makes unsafe iMessage sender code points visible in Review', () => {
    renderReview({
      data: {
        name: 'imessage-review',
        type: 'passive',
        transport: 'imessage',
        adminPhones: ['owner@example.com'],
        imessageConfig: {
          backend: 'imsg',
          sender: 'owner\u202E@example.com',
          imsgSocketPath: '/tmp/imsg.sock',
        },
      },
    })

    expect(kvValue('Sender')).toBe('owner\\u202E@example.com')
  })
})

describe('ReviewStep — Model & Auth card', () => {
  it('shows "None (passive)" model row and hides Auth/Conversation/Extraction for passive type', () => {
    renderReview({ data: { name: 'pas-line', type: 'passive' } })
    expect(screen.getByText('Model & Auth')).toBeDefined()
    expect(kvValue('Models')).toBe('None (passive)')
    expect(kvExists('Conversation')).toBe(false)
    expect(kvExists('Extraction')).toBe(false)
    expect(kvExists('Auth')).toBe(false)
  })

  it('shows model defaults and "API key" auth label when models/auth are missing for chat type', () => {
    renderReview({ data: { name: 'cht-line', type: 'chat' } })
    expect(kvValue('Conversation')).toBe('claude-sonnet-4-6')
    expect(kvValue('Extraction')).toBe('claude-haiku-4-5-20251001')
    expect(kvValue('Auth')).toBe('API key')
  })

  it('renders explicit model values and "OAuth session" label when authMethod is oauth', () => {
    renderReview({
      data: {
        name: 'cht-oauth',
        type: 'chat',
        models: { conversation: 'fixture-conversation-model', extraction: 'fixture-extraction-model' },
        authMethod: 'oauth',
      },
    })
    expect(kvValue('Conversation')).toBe('fixture-conversation-model')
    expect(kvValue('Extraction')).toBe('fixture-extraction-model')
    expect(kvValue('Auth')).toBe('OAuth session')
  })
})

describe('ReviewStep — Config card access mode + system prompt', () => {
  it('maps known access modes to friendly labels', () => {
    renderReview({ data: { name: 'cfg-1', type: 'chat', accessMode: 'allowlist' } })
    expect(kvValue('Access mode')).toBe('Allowlist')
  })

  it('falls back to the raw access mode string when it is not in the label map', () => {
    renderReview({ data: { name: 'cfg-2', type: 'chat', accessMode: 'experimental-mode' } })
    expect(kvValue('Access mode')).toBe('experimental-mode')
  })

  it('defaults to "Admin Only" when accessMode is not supplied', () => {
    renderReview({ data: { name: 'cfg-3', type: 'chat' } })
    expect(kvValue('Access mode')).toBe('Admin Only')
  })

  it('truncates a long system prompt at 60 chars with an ellipsis on the first line only', () => {
    const longPrompt = 'A'.repeat(80) + '\nshould not appear'
    renderReview({ data: { name: 'cfg-4', type: 'chat', systemPrompt: longPrompt } })
    const value = kvValue('System prompt')
    expect(value.length).toBe(63)
    expect(value.endsWith('...')).toBe(true)
    expect(value.includes('should not appear')).toBe(false)
  })

  it('omits the System prompt row entirely for passive type', () => {
    renderReview({
      data: { name: 'cfg-5', type: 'passive', systemPrompt: 'irrelevant for passive type' },
    })
    expect(kvExists('System prompt')).toBe(false)
  })

  it('omits the System prompt row when the prompt is empty', () => {
    renderReview({ data: { name: 'cfg-6', type: 'chat', systemPrompt: '' } })
    expect(kvExists('System prompt')).toBe(false)
  })
})

describe('ReviewStep — Config card rate limit / token budget / RAG', () => {
  it('renders rate limit and token-budget defaults when fields are missing', () => {
    renderReview({ data: { name: 'cfg-defaults', type: 'chat' } })
    expect(kvValue('Rate limit')).toBe('60/hr')
    expect(kvValue('Token budget')).toBe('50,000')
    expect(kvValue('RAG')).toBe('Not configured')
  })

  it('renders custom rate limit, token budget (with thousands separators), and pineconeIndex', () => {
    renderReview({
      data: {
        name: 'cfg-custom',
        type: 'chat',
        rateLimitPerHour: 1234,
        tokenBudget: 7654321,
        pineconeIndex: 'fixture-pinecone-index',
      },
    })
    expect(kvValue('Rate limit')).toBe('1234/hr')
    expect(kvValue('Token budget')).toBe('7,654,321')
    expect(kvValue('RAG')).toBe('fixture-pinecone-index')
  })
})

describe('ReviewStep — Config card agent-only rows', () => {
  it('omits CWD/Session scope/Provider rows for non-agent types', () => {
    renderReview({ data: { name: 'cht-line', type: 'chat' } })
    expect(kvExists('CWD')).toBe(false)
    expect(kvExists('Session scope')).toBe(false)
    expect(kvExists('Provider')).toBe(false)
  })

  it('renders agent rows with defaults when agentOptions is empty', () => {
    renderReview({ data: { name: 'agt-defaults', type: 'agent', agentOptions: {} } })
    expect(kvValue('CWD')).toBe('~/.local/share/whatsoup/instances/agt-defaults/workspace')
    expect(kvValue('Session scope')).toBe('single')
    expect(kvValue('Provider')).toBe('claude-cli')
  })

  it('renders provider config fields only for non-default providers and skips empty values', () => {
    renderReview({
      data: {
        name: 'agt-anthropic',
        type: 'agent',
        agentOptions: {
          provider: 'anthropic-api',
          providerConfig: {
            model: 'fixture-model-name',
            baseUrl: '', // empty — must be skipped
            apiKeyService: 'fixture-keyring',
            maxTokens: 32768,
          },
        },
      },
    })
    expect(kvValue('Provider')).toBe('anthropic-api')
    expect(kvValue('Model')).toBe('fixture-model-name')
    expect(kvValue('Keyring Service')).toBe('fixture-keyring')
    expect(kvValue('Max Tokens')).toBe('32768')
    // Empty baseUrl must not render a row.
    expect(kvExists('Base URL')).toBe(false)
  })

  it('does not render provider-config field rows for the default provider', () => {
    renderReview({
      data: {
        name: 'agt-default-provider',
        type: 'agent',
        agentOptions: { provider: 'claude-cli', providerConfig: { model: 'ignored-for-default' } },
      },
    })
    expect(kvValue('Provider')).toBe('claude-cli')
    // The provider-config field rows (Model/Base URL/etc.) must not render for the default provider.
    expect(kvExists('Model')).toBe(false)
    expect(kvExists('Base URL')).toBe(false)
  })
})

describe('ReviewStep — Edit buttons', () => {
  it('clicking each card Edit button calls onEditPhase with the matching phase index', () => {
    const { onEditPhase } = renderReview({ data: { name: 'edit-fix', type: 'agent' } })
    const buttons = screen.getAllByRole('button', { name: /edit/i })
    expect(buttons).toHaveLength(4)
    fireEvent.click(buttons[0])
    fireEvent.click(buttons[1])
    fireEvent.click(buttons[2])
    fireEvent.click(buttons[3])
    expect(onEditPhase.mock.calls.map(([phase]) => phase)).toEqual([0, 0, 2, 3])
  })
})

describe('ReviewStep — Create button + creating state', () => {
  it('renders an enabled "Create Line" button by default and calls onCreateLine when clicked', () => {
    const { onCreateLine } = renderReview({ data: { name: 'create-fix', type: 'chat' } })
    const btn = screen.getByRole('button', { name: 'Create Line' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onCreateLine).toHaveBeenCalledTimes(1)
  })

  it('disables the button and switches the label to "Creating..." while creating is true', () => {
    renderReview({ data: { name: 'create-fix', type: 'chat' }, creating: true })
    const btn = screen.getByRole('button', { name: 'Creating...' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    // "Create Line" must not be present while the creating label is active.
    expect(screen.queryByRole('button', { name: 'Create Line' })).toBeNull()
  })
})

describe('ReviewStep — friendlyError mapping', () => {
  it('does not render the error banner when error is null', () => {
    renderReview({ data: { name: 'err-fix', type: 'chat' }, error: null })
    // The friendly-error generic prefix must not appear when there is no error.
    expect(screen.queryByText(/Something went wrong/)).toBeNull()
  })

  it('maps "already exists" to the friendly duplicate-name message', () => {
    renderReview({
      data: { name: 'err-fix', type: 'chat' },
      error: 'fleet: instance already exists',
    })
    expect(
      screen.getByText(/An instance with this name already exists/),
    ).toBeDefined()
  })

  it('maps "systemPrompt" validation errors to the Config-card guidance message', () => {
    renderReview({
      data: { name: 'err-fix', type: 'chat' },
      error: 'invalid: systemPrompt required',
    })
    expect(screen.getByText(/A system prompt is required/)).toBeDefined()
  })

  it('maps cwd-scope errors to the home-directory guidance message', () => {
    renderReview({
      data: { name: 'err-fix', type: 'agent' },
      error: 'ValidationError: cwd must be within home',
    })
    expect(screen.getByText(/working directory must be inside the home directory/)).toBeDefined()
  })

  it('maps fetch/network errors to the fleet-unreachable message', () => {
    renderReview({
      data: { name: 'err-fix', type: 'chat' },
      error: 'TypeError: Failed to fetch',
    })
    expect(screen.getByText(/Could not reach the fleet server/)).toBeDefined()
  })

  it('maps timeout/AbortError to the heavy-load message', () => {
    renderReview({
      data: { name: 'err-fix', type: 'chat' },
      error: 'AbortError: request timeout',
    })
    expect(screen.getByText(/The request timed out/)).toBeDefined()
  })

  it('falls back to the generic "Something went wrong" message for unmapped errors', () => {
    renderReview({
      data: { name: 'err-fix', type: 'chat' },
      error: 'unmapped-raw-error-token-xyz',
    })
    expect(
      screen.getByText(/Something went wrong: unmapped-raw-error-token-xyz/),
    ).toBeDefined()
  })
})
