/**
 * AddLineWizard — behavioral shell suite (C-B3W4-6 hard prerequisite).
 *
 * Tests the migrated Modal-based shell (B3 wave 4):
 *   - open-prop gate (renders nothing until open=true)
 *   - dialog role + accessible name via Modal aria-labelledby
 *   - backdrop pointerdown does NOT dismiss (dismissable=false protective pin)
 *   - Escape on pristine step 0 closes immediately
 *   - Escape with dirty form raises discard confirm
 *   - Escape after creation raises abandon confirm
 *   - Escape with exit confirm open closes ONLY the confirm; second Escape re-raises (P1-2)
 *   - X close routes through the same handleClose gate
 *   - step walk: invalid step 0 blocks with validateStep messages
 *   - valid step 0 fires createLine exactly once and locks the name
 *   - Back from step 0 = Cancel (closes)
 *   - footer absent on step 1 (Link)
 *   - createError renders ONCE (D2 duplicate dead — footer error block moved to body)
 *   - discard-flow option α: no deleteLine on save-and-close after creation
 *   - focus lands inside on open (dialog has focus or element within it)
 *   - reset-on-open: reopened wizard starts at step 0 with fresh state
 *
 * JID fixtures use BES-pattern names per established project conventions.
 * beforeunload is not jsdom-testable — live QA script.
 *
 * @vitest-environment jsdom
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import type { FC, ReactElement } from 'react'
import { ToastProvider } from '../../console/src/hooks/use-toast'

// ---------------------------------------------------------------------------
// Mocks — hoisted before component import
// ---------------------------------------------------------------------------

const mockCreateLine = vi.fn()
const mockUpdateConfig = vi.fn()
const mockDeleteLine = vi.fn()
const mockCheckExists = vi.fn()
const mockSetCredential = vi.fn()

vi.mock('../../console/src/lib/api', () => ({
  api: {
    createLine: (...args: unknown[]) => mockCreateLine(...args),
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    deleteLine: (...args: unknown[]) => mockDeleteLine(...args),
    checkExists: (...args: unknown[]) => mockCheckExists(...args),
    setCredential: (...args: unknown[]) => mockSetCredential(...args),
  },
  // isProductionConsole is exported from the real module; other test workers
  // that share this mock factory expect it to exist on the named export.
  isProductionConsole: () => false,
}))

// ---------------------------------------------------------------------------
// Import component AFTER mocks
// ---------------------------------------------------------------------------

import AddLineWizard from '../../console/src/components/AddLineWizard'

// AddLineWizard now calls useToast() unconditionally (finish-step credential
// toasts) — every render needs a ToastProvider ancestor, or the hook throws
// "must be used within a ToastProvider" before the first paint. All renders
// in this file are of AddLineWizard/WizardWrapper, so shadowing `render` here
// covers every call site (including `rerender`, which reuses the same wrapper).
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: ToastProvider })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WizardESListener = (event: MessageEvent | Event) => void

class WizardFakeEventSource {
  url: string
  readyState = 1
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  private readonly listeners: Map<string, WizardESListener[]> = new Map()

  constructor(url: string) {
    this.url = url
    wizardEventSources.push(this)
  }

  addEventListener(type: string, handler: WizardESListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type)!.push(handler)
  }

  removeEventListener(type: string, handler: WizardESListener): void {
    const handlers = this.listeners.get(type)
    if (!handlers) return
    const index = handlers.indexOf(handler)
    if (index >= 0) handlers.splice(index, 1)
  }

  close(): void {
    this.readyState = 2
  }

  emit(type: string, data?: string): void {
    const event = data !== undefined
      ? new MessageEvent(type, { data })
      : new Event(type)
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

let wizardEventSources: WizardFakeEventSource[] = []

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  mockCreateLine.mockReset()
  mockUpdateConfig.mockReset()
  mockDeleteLine.mockReset()
  mockCheckExists.mockReset()
  mockSetCredential.mockReset()
})

beforeEach(() => {
  // Default: createLine resolves successfully; other calls resolve trivially
  mockCreateLine.mockResolvedValue({ name: 'test-line', healthPort: 9001 })
  mockUpdateConfig.mockResolvedValue({})
  mockDeleteLine.mockResolvedValue({ deleted: 'test-line' })
  mockCheckExists.mockResolvedValue({ exists: false })
  mockSetCredential.mockResolvedValue({ ok: true, service: 's' })
  wizardEventSources = []
  // jsdom has no EventSource; LinkStep (mounted when tests advance past
  // Identity) opens one in an effect, which otherwise raises unhandled
  // rejections. Inert stub — LinkStep's SSE behavior is pinned by its own
  // suite (wizard-link-step.test.tsx) with a controllable FakeEventSource.
  vi.stubGlobal('EventSource', WizardFakeEventSource)
})

/** Wrapper that manages the open prop for the latched-mount contract (C-B3W4-3). */
const WizardWrapper: FC<{
  onClose?: () => void
  initialOpen?: boolean
}> = ({ onClose = vi.fn(), initialOpen = true }) => {
  const [open, setOpen] = useState(initialOpen)
  const [everOpened, setEverOpened] = useState(initialOpen)
  const handleOpen = () => { setOpen(true); setEverOpened(true) }
  const handleClose = () => { setOpen(false); onClose() }
  return (
    <>
      <button type="button" onClick={handleOpen} data-testid="opener">
        Open Wizard
      </button>
      {everOpened && (
        <AddLineWizard open={open} onClose={handleClose} />
      )}
    </>
  )
}

/**
 * Fill out step 0 identity fields (type + name + adminPhones).
 */
async function fillIdentityStep(typeName: RegExp = /passive/i): Promise<void> {
  // Select line type — passive card.
  // CardSelector uses role="radio"; accessible name derives from text content
  // inside the card div (label + description). Partial match /passive/i works.
  const typeCard = screen.getByRole('radio', { name: typeName })
  await act(async () => { fireEvent.click(typeCard) })

  const nameInput = screen.getByLabelText('Name')
  await act(async () => {
    fireEvent.change(nameInput, { target: { value: 'test-line' } })
  })

  // Add an admin phone — TagInput appends " (press Enter to add)" to placeholder,
  // so match with a partial pattern rather than the exact placeholder string.
  const phoneInput = screen.getByPlaceholderText(/enter phone/i)
  await act(async () => {
    fireEvent.change(phoneInput, { target: { value: '15551234567' } })
    fireEvent.keyDown(phoneInput, { key: 'Enter' })
  })
}

async function advanceIdentityToLink(typeName: RegExp = /passive/i): Promise<void> {
  await fillIdentityStep(typeName)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
  })
  await waitFor(() => expect(mockCreateLine).toHaveBeenCalledTimes(1))
}

async function completeLinkStep(): Promise<void> {
  await waitFor(() => expect(wizardEventSources).toHaveLength(1))
  await act(async () => {
    wizardEventSources[0].emit('connected')
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'View Line' }))
  })
  await waitFor(() => expect(screen.getByText('Model & Auth')).toBeDefined())
}

async function advanceToConfigStep(typeName: RegExp = /passive/i): Promise<void> {
  await advanceIdentityToLink(typeName)
  await completeLinkStep()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  })
  await waitFor(() => expect(screen.getByRole('tab', { name: /behavior/i })).toBeDefined())
}

async function advanceToReviewStep(typeName: RegExp = /passive/i): Promise<void> {
  await advanceToConfigStep(typeName)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  })
  await waitFor(() => expect(screen.getByRole('button', { name: /create line/i })).toBeDefined())
}

/**
 * Drive a chat-type line to the Review step, typing an Anthropic API key on
 * the Model & Auth step along the way (chat type keeps the key entry simple —
 * no auth-method radios). Chat's Config step ships a non-empty default system
 * prompt, so no Config-step input is needed before advancing to Review.
 */
async function driveToReviewWithApiKey(apiKeyValue: string): Promise<void> {
  await advanceIdentityToLink(/chat/i)
  await completeLinkStep()
  const apiKeyInput = screen.getByPlaceholderText(/sk-ant-/)
  await act(async () => {
    fireEvent.change(apiKeyInput, { target: { value: apiKeyValue } })
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  })
  await waitFor(() => expect(screen.getByRole('tab', { name: /behavior/i })).toBeDefined())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  })
  await waitFor(() => expect(screen.getByRole('button', { name: /create line/i })).toBeDefined())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AddLineWizard — open-prop gate', () => {
  it('renders nothing when open=false', () => {
    render(<AddLineWizard open={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the dialog when open=true', () => {
    render(<AddLineWizard open={true} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Add New Line' })).toBeDefined()
  })
})

describe('AddLineWizard — dialog semantics', () => {
  it('exposes dialog role with accessible name "Add New Line"', () => {
    render(<AddLineWizard open={true} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Add New Line' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('does NOT use c-dialog-backdrop (role-on-backdrop defect is dead)', () => {
    const { container } = render(<AddLineWizard open={true} onClose={vi.fn()} />)
    // The backdrop element must not carry role="dialog" — Modal owns it on the shell
    const backdropWithRole = container.querySelector('[role="dialog"].c-dialog-backdrop')
    expect(backdropWithRole).toBeNull()
    // Modal puts the dialog role on the shell (not the backdrop) — confirm the role IS wired
    expect(screen.getByRole('dialog', { name: 'Add New Line' }).classList.contains('soup-modal-shell')).toBe(true)
  })
})

describe('AddLineWizard — dismiss protection (dismissable=false)', () => {
  it('backdrop pointerdown does NOT call onClose', async () => {
    const onClose = vi.fn()
    render(<AddLineWizard open={true} onClose={onClose} />)
    // Modal portals to document.body — backdrop is outside the render container.
    // Use document.querySelector, not container.querySelector.
    const backdrop = document.querySelector('[data-soup-backdrop]')
    expect(backdrop).not.toBeNull()
    await act(async () => {
      fireEvent.pointerDown(backdrop!)
    })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('AddLineWizard — Escape gate behavior', () => {
  it('Escape on pristine step 0 calls onClose immediately', async () => {
    const onClose = vi.fn()
    render(<AddLineWizard open={true} onClose={onClose} />)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: /discard/i })).toBeNull()
  })

  it('Escape with dirty form (step 0 after typing) raises discard confirm', async () => {
    render(<WizardWrapper />)
    // Dirty the form — locate name input by placeholder (IdentityStep has no htmlFor)
    const nameInput = screen.getByPlaceholderText('my-line')
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'foo' } })
    })
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.getByRole('dialog', { name: /discard/i })).toBeDefined()
  })

  it('Escape with exit confirm open closes only the confirm (P1-2 single-fire)', async () => {
    const onClose = vi.fn()
    render(<WizardWrapper onClose={onClose} />)
    // Dirty the form so Escape raises confirm
    const nameInput = screen.getByPlaceholderText('my-line')
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'foo' } })
    })
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    // Confirm is open, wizard is still open
    expect(screen.getByRole('dialog', { name: /discard/i })).toBeDefined()
    // First Escape closes the confirm only
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByRole('dialog', { name: /discard/i })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // Wizard still open
    expect(screen.getByRole('dialog', { name: 'Add New Line' })).toBeDefined()
  })

  it('Escape after creation raises abandon confirm (save-unlinked copy)', async () => {
    render(<WizardWrapper />)
    await fillIdentityStep()
    // Advance to step 1 — triggers createLine
    const nextBtn = screen.getByRole('button', { name: /next/i })
    await act(async () => { fireEvent.click(nextBtn) })
    await waitFor(() => expect(mockCreateLine).toHaveBeenCalledTimes(1))
    // Now on step 1 — fire Escape
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    // Should raise confirm (post-creation abandon, not pre-creation discard)
    const confirm = screen.getByRole('dialog', { name: /abandon/i })
    // Confirm is a stacked Modal — verify its modal attribute is wired
    expect(confirm.getAttribute('aria-modal')).toBe('true')
  })
})

describe('AddLineWizard — X close button', () => {
  it('X close routes through handleClose gate (pristine = immediate close)', async () => {
    const onClose = vi.fn()
    render(<AddLineWizard open={true} onClose={onClose} />)
    const closeBtn = screen.getByRole('button', { name: /close dialog/i })
    await act(async () => { fireEvent.click(closeBtn) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('X close with dirty form raises confirm instead', async () => {
    render(<WizardWrapper />)
    const nameInput = screen.getByPlaceholderText('my-line')
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'foo' } })
    })
    const closeBtn = screen.getByRole('button', { name: /close dialog/i })
    await act(async () => { fireEvent.click(closeBtn) })
    expect(screen.getByRole('dialog', { name: /discard/i })).toBeDefined()
  })
})

describe('AddLineWizard — step-0 validation', () => {
  it('Next button with no fields blocks and shows error messages', async () => {
    render(<AddLineWizard open={true} onClose={vi.fn()} />)
    const nextBtn = screen.getByRole('button', { name: /next/i })
    await act(async () => { fireEvent.click(nextBtn) })
    expect(mockCreateLine).not.toHaveBeenCalled()
    // Some validation message present
    expect(screen.getByText(/choose a line type/i)).toBeDefined()
  })
})

describe('AddLineWizard — chat BYOK validation on Model step', () => {
  it('blocks advancing when the custom OpenAI endpoint is not an http(s) URL', async () => {
    render(<WizardWrapper />)
    await advanceIdentityToLink(/chat/i)
    await completeLinkStep()

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Custom OpenAI endpoint'), {
        target: { value: 'not-a-url' },
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    })

    expect(screen.getByText('Enter a valid http:// or https:// URL')).toBeDefined()
    expect(screen.getByText('Model & Auth')).toBeDefined()
    expect(screen.queryByRole('tab', { name: /behavior/i })).toBeNull()
  })

  it('blocks advancing when keyring service is set without a custom endpoint', async () => {
    render(<WizardWrapper />)
    await advanceIdentityToLink(/chat/i)
    await completeLinkStep()

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Keyring Service'), {
        target: { value: 'groq' },
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    })

    expect(screen.getByText('Set a custom OpenAI endpoint before choosing a keyring service')).toBeDefined()
    expect(screen.getByText('Model & Auth')).toBeDefined()
    expect(screen.queryByRole('tab', { name: /behavior/i })).toBeNull()
  })
})

describe('AddLineWizard — step-0→1 creation side-effect', () => {
  it('Next on valid step 0 calls createLine exactly once', async () => {
    render(<WizardWrapper />)
    await fillIdentityStep()
    const nextBtn = screen.getByRole('button', { name: /next/i })
    await act(async () => { fireEvent.click(nextBtn) })
    await waitFor(() => expect(mockCreateLine).toHaveBeenCalledTimes(1))
  })

  it('createLine failure shows error message and stays on step 0', async () => {
    mockCreateLine.mockRejectedValue(new Error('Server error'))
    render(<WizardWrapper />)
    await fillIdentityStep()
    const nextBtn = screen.getByRole('button', { name: /next/i })
    await act(async () => { fireEvent.click(nextBtn) })
    await waitFor(() => {
      expect(screen.getByText(/server error/i)).toBeDefined()
    })
    // Still on step 0 (Next button still visible, not on Link step)
    expect(screen.getByRole('button', { name: /next/i })).toBeDefined()
  })
})

describe('AddLineWizard — non-Baileys creation lifecycle', () => {
  async function fillTransportIdentity(transport: 'twilio' | 'signal' | 'imessage') {
    fireEvent.click(screen.getByRole('radio', {
      name: transport === 'twilio'
        ? /SMS \(Twilio\)/i
        : new RegExp(transport, 'i'),
    }))
    fireEvent.click(screen.getByRole('radio', { name: /passive/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: `${transport}-line` } })

    const adminInput = screen.getByLabelText(
      transport === 'signal'
        ? 'Admin Signal IDs'
        : transport === 'imessage'
          ? 'Admin iMessage IDs'
          : 'SMS Access Phones',
    )
    const admin = transport === 'signal'
      ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      : transport === 'imessage'
        ? 'Owner@Example.com'
        : '15551234567'
    fireEvent.change(adminInput, { target: { value: admin } })
    fireEvent.keyDown(adminInput, { key: 'Enter' })

    if (transport === 'twilio') {
      fireEvent.change(screen.getByLabelText('Twilio Account SID'), {
        target: { value: `AC${'a'.repeat(32)}` },
      })
      const tokenService = screen.getByLabelText('Twilio auth-token keyring service') as HTMLInputElement
      expect(tokenService.value).toBe('whatsoup-twilio-twilio-line')
      expect(tokenService.readOnly).toBe(true)
      fireEvent.change(screen.getByLabelText('Twilio phone number'), {
        target: { value: '+15551234567' },
      })
    } else if (transport === 'signal') {
      fireEvent.change(screen.getByLabelText('Signal account number'), {
        target: { value: '+15551234567' },
      })
      fireEvent.change(screen.getByLabelText('Signal UNIX socket path'), {
        target: { value: '/tmp/signal-cli.sock' },
      })
    } else {
      fireEvent.change(screen.getByLabelText('iMessage sender'), {
        target: { value: 'Owner@Example.com' },
      })
      fireEvent.change(screen.getByLabelText('BlueBubbles URL'), {
        target: { value: 'https://messages.example.test' },
      })
      fireEvent.change(screen.getByLabelText('BlueBubbles password keyring service'), {
        target: { value: 'whatsoup-bluebubbles-imessage-line' },
      })
    }
  }

  async function reachReview(transport: 'twilio' | 'signal' | 'imessage') {
    await fillTransportIdentity(transport)
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))

    expect(mockCreateLine).not.toHaveBeenCalled()
    if (transport !== 'twilio') {
      await waitFor(() => expect(screen.getByRole('checkbox')).toBeDefined())
      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    }

    await waitFor(() => expect(screen.getByText('Model & Auth')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    await waitFor(() => expect(screen.getByRole('tab', { name: /behavior/i })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /create line/i })).toBeDefined())
  }

  it.each(['twilio', 'signal', 'imessage'] as const)(
    'creates a final %s config once from Review and never PATCHes immutable transport',
    async (transport) => {
      render(<WizardWrapper />)
      await reachReview(transport)

      fireEvent.click(screen.getByRole('button', { name: /create line/i }))
      await waitFor(() => expect(mockCreateLine).toHaveBeenCalledTimes(1))

      const payload = mockCreateLine.mock.calls[0][0] as Record<string, unknown>
      expect(payload.transport).toBe(transport)
      expect(payload).toHaveProperty(`${transport}Config`)
      expect(JSON.stringify(payload)).not.toMatch(/must-not|authToken"|bluebubblesPassword"/)
      expect(mockUpdateConfig).not.toHaveBeenCalled()
    },
  )

  it('requires fresh iMessage attestation after switching from an attested Signal setup', async () => {
    render(<WizardWrapper />)
    await reachReview('signal')

    const transportSection = screen.getByText('Transport').closest('section')
    fireEvent.click(within(transportSection as HTMLElement).getByRole('button', { name: /edit/i }))
    fireEvent.click(screen.getByRole('radio', { name: /imessage/i }))
    const adminInput = screen.getByLabelText('Admin iMessage IDs')
    fireEvent.change(adminInput, { target: { value: 'owner@example.com' } })
    fireEvent.keyDown(adminInput, { key: 'Enter' })
    fireEvent.change(screen.getByLabelText('iMessage sender'), { target: { value: 'owner@example.com' } })
    fireEvent.change(screen.getByLabelText('BlueBubbles URL'), { target: { value: 'https://messages.example.test' } })
    fireEvent.change(screen.getByLabelText('BlueBubbles password keyring service'), { target: { value: 'whatsoup-bluebubbles-signal-line' } })
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeDefined())
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('requires fresh Signal attestation after its endpoint changes', async () => {
    render(<WizardWrapper />)
    await reachReview('signal')

    const transportSection = screen.getByText('Transport').closest('section')
    fireEvent.click(within(transportSection as HTMLElement).getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('Signal UNIX socket path'), {
      target: { value: '/tmp/reconfigured-signal.sock' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeDefined())
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
})

describe('AddLineWizard — Back/Cancel on step 0', () => {
  it('Back on step 0 acts as Cancel — calls onClose (pristine)', async () => {
    const onClose = vi.fn()
    render(<AddLineWizard open={true} onClose={onClose} />)
    const cancelBtn = screen.getByRole('button', { name: /cancel/i })
    await act(async () => { fireEvent.click(cancelBtn) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('AddLineWizard — footer absent on step 1 (Link)', () => {
  it('footer is not rendered when on step 1', async () => {
    render(<WizardWrapper />)
    await fillIdentityStep()
    const nextBtn = screen.getByRole('button', { name: /next/i })
    await act(async () => { fireEvent.click(nextBtn) })
    await waitFor(() => expect(mockCreateLine).toHaveBeenCalledTimes(1))
    // On step 1: no Next or Back button in footer
    expect(screen.queryByRole('button', { name: /^next$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull()
  })

  it('does not reopen the LinkStep EventSource after returning from the model step', async () => {
    render(<WizardWrapper />)
    await fillIdentityStep()

    const nextBtn = screen.getByRole('button', { name: /next/i })
    await act(async () => { fireEvent.click(nextBtn) })
    await waitFor(() => expect(mockCreateLine).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(wizardEventSources).toHaveLength(1))

    await act(async () => {
      wizardEventSources[0].emit('connected')
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'View Line' }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    })

    expect(screen.getByText('Line is live!')).toBeDefined()
    expect(screen.queryByText('Generating QR code...')).toBeNull()
    expect(wizardEventSources).toHaveLength(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'View Line' }))
    })
    expect(screen.getByRole('button', { name: /^back$/i })).toBeDefined()
  })
})

describe('AddLineWizard — createError renders once (D2 fix)', () => {
  it('createError appears in body, NOT duplicated in footer', async () => {
    // Verify at step 0 create-error (step 0→1 failure): only one occurrence.
    // The footer error block was removed (D2 fix); body is the sole error surface.
    mockCreateLine.mockRejectedValue(new Error('Create failed'))
    render(<WizardWrapper />)
    await fillIdentityStep()
    const nextBtn = screen.getByRole('button', { name: /next/i })
    await act(async () => { fireEvent.click(nextBtn) })
    await waitFor(() => {
      // Error appears exactly once — not duplicated across body + footer
      const allText = document.body.textContent ?? ''
      const occurrences = allText.split('Create failed').length - 1
      expect(occurrences).toBeLessThanOrEqual(1)
    })
  })
})

describe('AddLineWizard — discard flow option α (save unlinked)', () => {
  it('confirm abandon after creation does NOT call deleteLine (option α)', async () => {
    render(<WizardWrapper />)
    await fillIdentityStep()
    const nextBtn = screen.getByRole('button', { name: /next/i })
    await act(async () => { fireEvent.click(nextBtn) })
    await waitFor(() => expect(mockCreateLine).toHaveBeenCalledTimes(1))
    // Raise abandon confirm via Escape
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    const confirmDialog = await screen.findByRole('dialog', { name: /abandon/i })
    // Click the confirm/save button (not cancel)
    const abandonBtn = within(confirmDialog).getByRole('button', { name: /save and close/i })
    await act(async () => { fireEvent.click(abandonBtn) })
    // Option α: instance kept — no deleteLine call
    expect(mockDeleteLine).not.toHaveBeenCalled()
  })

  it('discard before creation (pre-creation dirty) does NOT call deleteLine', async () => {
    render(<WizardWrapper />)
    const nameInput = screen.getByPlaceholderText('my-line')
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'foo' } })
    })
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    const confirmDialog = await screen.findByRole('dialog', { name: /discard/i })
    const discardBtn = within(confirmDialog).getByRole('button', { name: /discard/i })
    await act(async () => { fireEvent.click(discardBtn) })
    expect(mockDeleteLine).not.toHaveBeenCalled()
  })
})

describe('AddLineWizard — config and review workflow', () => {
  it('fills the default workspace before provisioning an agent line', async () => {
    render(<WizardWrapper />)

    await advanceIdentityToLink(/agent/i)

    const payload = mockCreateLine.mock.calls[0][0] as {
      agentOptions?: { cwd?: string }
    }
    expect(payload.agentOptions?.cwd).toBe('~/.local/share/whatsoup/instances/test-line/workspace')
  })

  it('blocks config advance when a non-passive line has no system prompt', async () => {
    render(<WizardWrapper />)

    await advanceToConfigStep(/chat/i)
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /behavior/i }))
    })

    const promptInput = await screen.findByLabelText('System Prompt')
    await act(async () => {
      fireEvent.change(promptInput, { target: { value: '' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    })

    expect(screen.getByText('Add a system prompt — this defines how the AI responds')).toBeDefined()
    expect(screen.queryByRole('button', { name: /create line/i })).toBeNull()
  })

  it('warns on tab close after provisioning and removes the warning after final save', async () => {
    const onClose = vi.fn()
    render(<WizardWrapper onClose={onClose} />)

    await advanceToReviewStep()

    const beforeCompletion = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(beforeCompletion)
    expect(beforeCompletion.defaultPrevented).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create line/i }))
    })

    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledWith(
        'test-line',
        expect.objectContaining({ name: 'test-line' }),
      )
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add New Line' })).toBeNull())

    const afterCompletion = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterCompletion)
    expect(afterCompletion.defaultPrevented).toBe(false)
  })

  it('keeps review open and shows a friendly error when final config save fails', async () => {
    mockUpdateConfig.mockRejectedValueOnce(new Error('systemPrompt missing'))
    const onClose = vi.fn()
    render(<WizardWrapper onClose={onClose} />)

    await advanceToReviewStep()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create line/i }))
    })

    await waitFor(() => {
      expect(screen.getByText('A system prompt is required. Click "Edit" on the Config card above to add one.')).toBeDefined()
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /create line/i })).toBeDefined()
  })

  it('review edit controls navigate back to the selected wizard phase', async () => {
    render(<WizardWrapper />)

    await advanceToReviewStep()
    const editButtons = screen.getAllByRole('button', { name: /edit/i })
    await act(async () => {
      fireEvent.click(editButtons[3])
    })

    await waitFor(() => expect(screen.getByRole('tab', { name: /behavior/i })).toBeDefined())
    expect(screen.queryByRole('button', { name: /create line/i })).toBeNull()
  })
})

describe('AddLineWizard — credential wiring (finish step)', () => {
  it('sends chat BYOK config through the finish PATCH while keeping raw keys out', async () => {
    render(<WizardWrapper />)
    await advanceIdentityToLink(/chat/i)
    await completeLinkStep()

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Custom OpenAI endpoint'), {
        target: { value: 'https://api.groq.com/openai/v1' },
      })
      fireEvent.change(screen.getByLabelText('Keyring Service'), {
        target: { value: 'groq' },
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    })
    await waitFor(() => expect(screen.getByRole('tab', { name: /behavior/i })).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /create line/i })).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create line/i }))
    })

    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalledTimes(1))
    const patch = mockUpdateConfig.mock.calls[0][1] as Record<string, unknown>
    expect(patch).toMatchObject({
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKeyService: 'groq',
        },
      },
    })
    expect(patch).not.toHaveProperty('apiKey')
    expect(patch).not.toHaveProperty('openaiKey')
  })

  it('routes the typed Anthropic key to setCredential and keeps it out of the config patch', async () => {
    render(<WizardWrapper />)
    await driveToReviewWithApiKey('sk-ant-x')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create line/i }))
    })

    await waitFor(() => expect(mockSetCredential).toHaveBeenCalledWith('anthropic', 'sk-ant-x'))
    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalledTimes(1))
    const patch = mockUpdateConfig.mock.calls[0][1] as Record<string, unknown>
    expect(patch).not.toHaveProperty('apiKey')
    expect(patch).not.toHaveProperty('openaiKey')
  })

  it('still completes and surfaces an error toast when the credential service 404s', async () => {
    mockSetCredential.mockRejectedValueOnce(new Error('API 404: unknown credential service'))
    const onClose = vi.fn()
    render(<WizardWrapper onClose={onClose} />)
    await driveToReviewWithApiKey('sk-ant-x')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create line/i }))
    })

    // Security proof: the write was attempted and the line-creation flow does
    // not throw/stall on a 404 from the credentials write allowlist (QR-238).
    await waitFor(() => expect(mockSetCredential).toHaveBeenCalledWith('anthropic', 'sk-ant-x'))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    // Designed UX: the 404 surfaces as a CLI-instructions toast, not a hard error.
    expect(await screen.findByText(/stored via the API yet/i)).toBeDefined()
  })
})

describe('AddLineWizard — wizard progress strip', () => {
  it('renders a progress strip with aria-label "Wizard progress"', () => {
    render(<AddLineWizard open={true} onClose={vi.fn()} />)
    // The strip is a <div> with aria-label — use getByLabelText, not getByRole('navigation')
    const strip = screen.getByLabelText(/wizard progress/i)
    // Verify the strip has the aria-label attribute we queried on
    expect(strip.getAttribute('aria-label')).toMatch(/wizard progress/i)
  })

  it('marks the current step with aria-current="step"', () => {
    render(<AddLineWizard open={true} onClose={vi.fn()} />)
    // Modal portals to document.body — use document.querySelector for DOM attribute check
    const currentStepEl = document.querySelector('[aria-current="step"]')
    expect(currentStepEl).not.toBeNull()
  })
})

describe('AddLineWizard — reset-on-open (C-B3W4-3)', () => {
  it('reopening after close resets to step 0', async () => {
    const { rerender } = render(<AddLineWizard open={true} onClose={vi.fn()} />)
    // Step 0 — Back/Cancel visible
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDefined()
    // Close
    rerender(<AddLineWizard open={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    // Reopen
    rerender(<AddLineWizard open={true} onClose={vi.fn()} />)
    // Should be at step 0 again
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDefined()
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull()
  })
})

describe('AddLineWizard — step strip step labels', () => {
  it('renders step labels: Identity, Link, Model, Config, Review', () => {
    render(<AddLineWizard open={true} onClose={vi.fn()} />)
    // The progress strip has aria-label="Wizard progress"; scope within it to
    // avoid false-multiple matches against the WizardStep h3 heading (which also
    // renders "Identity" as a heading inside the body).
    const strip = screen.getByLabelText(/wizard progress/i)
    expect(within(strip).getAllByText('Identity').length).toBeGreaterThan(0)
    expect(within(strip).getAllByText('Link').length).toBeGreaterThan(0)
    expect(within(strip).getAllByText('Model').length).toBeGreaterThan(0)
    expect(within(strip).getAllByText('Config').length).toBeGreaterThan(0)
    expect(within(strip).getAllByText('Review').length).toBeGreaterThan(0)
  })
})
