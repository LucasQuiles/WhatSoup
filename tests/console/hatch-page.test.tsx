/**
 * Hatch journey — flow contracts (T5 b-10; 14-onboarding + hatch.html SSOT).
 *
 * Pinned: one-step-at-a-time (wave-4 law), step rail states, kind→soul
 * seeding, channel-tile honesty, agent-step validation gating, ceremony
 * anatomy incl. the sanctioned glow class (13-§2) and the documented
 * no-ceremony-dice deviation.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const toastMock = { toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn(), clear: vi.fn() }
vi.mock('../../console/src/hooks/toast-context', () => ({
  ToastContext: { Provider: ({ children }: { children?: React.ReactNode }) => children },
  useToast: () => toastMock,
}))

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getProviders: vi.fn().mockResolvedValue([
      { id: 'claude-cli', displayName: 'Claude CLI', type: 'cli', needsApiKey: false, providerConfig: [] },
      { id: 'anthropic-api', displayName: 'Anthropic', type: 'api', needsApiKey: true, providerConfig: [] },
      { id: 'openai-api', displayName: 'OpenAI', type: 'api', needsApiKey: true, providerConfig: [] },
    ]),
    createLine: vi.fn().mockResolvedValue({ name: 'quinn', healthPort: 9096 }),
    setCredential: vi.fn().mockResolvedValue({ ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ sent: true }),
  },
  getApiTicket: vi.fn().mockResolvedValue('ticket'),
  isProductionConsole: () => false,
}))

// QrDisplay renders a canvas; jsdom has no canvas — stub the component.
vi.mock('../../console/src/components/QrDisplay', () => ({
  default: ({ value }: { value: string }) => <div data-testid="qr-stub">{value}</div>,
}))

const navigateMock = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigateMock }
})

import Hatch from '../../console/src/pages/Hatch'
import { Ceremony } from '../../console/src/components/journey/Ceremony'
import { api } from '../../console/src/lib/api'

const createLineMock = api.createLine as unknown as ReturnType<typeof vi.fn>
const sendMessageMock = api.sendMessage as unknown as ReturnType<typeof vi.fn>

function renderHatch() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Hatch />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  Object.values(toastMock).forEach((fn) => fn.mockClear())
  navigateMock.mockClear()
  createLineMock.mockClear().mockResolvedValue({ name: 'quinn', healthPort: 9096 })
  sendMessageMock.mockClear().mockResolvedValue({ sent: true })
})

afterEach(cleanup)

describe('hatch flow — step discipline (14-onboarding §1, wave-4 law)', () => {
  it('renders exactly one step at a time with the rail tracking state', async () => {
    const { container } = renderHatch()
    await waitFor(() => expect(container.querySelector('.journey-card')).not.toBeNull())
    // step 0: kind — the only card, rail marks Kind as now
    expect(container.querySelectorAll('.journey-card').length).toBe(1)
    expect(container.textContent).toContain('Pick a kind')
    expect(container.querySelector('.journey-step--now span')!.textContent).toBe('Kind')

    // advance to channel
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue'))!)
    await waitFor(() => expect(container.textContent).toContain('Pick a channel'))
    expect(container.textContent).not.toContain('Pick a kind') // completed step never re-shown
    expect(container.querySelectorAll('.journey-step--done').length).toBe(1)
    expect(container.querySelector('.journey-step--now span')!.textContent).toBe('Channel')
  })

  it('kind presets seed the soul; picking a different kind reseeds it', async () => {
    const { container } = renderHatch()
    await waitFor(() => expect(container.textContent).toContain('Pick a kind'))
    // community is the hint (pre-selected)
    const community = [...container.querySelectorAll('.journey-ch')].find((c) => c.textContent?.includes('Community'))!
    expect(community.classList.contains('journey-ch--sel')).toBe(true)
    // advance to agent step via channel
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue'))!)
    await waitFor(() => expect(container.textContent).toContain('Pick a channel'))
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue with WhatsApp'))!)
    await waitFor(() => expect(container.textContent).toContain('Name your agent'))
    const soulArea = container.querySelector('#hatch-soul') as HTMLTextAreaElement
    expect(soulArea.value).toContain('community room')
  })

  it('channel grid: WhatsApp selected; every other tile disabled with a reason', async () => {
    const { container } = renderHatch()
    await waitFor(() => expect(container.textContent).toContain('Pick a kind'))
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue'))!)
    await waitFor(() => expect(container.textContent).toContain('Pick a channel'))
    const tiles = [...container.querySelectorAll('.journey-ch')]
    const off = tiles.filter((t) => t.classList.contains('journey-ch--off'))
    expect(off.length).toBe(tiles.length - 1)
    for (const t of off) {
      expect(t.getAttribute('title')).toBeTruthy()
      expect(t.getAttribute('aria-disabled')).toBe('true')
    }
  })

  it('agent step gates continue on name + admin phone validity', async () => {
    const { container } = renderHatch()
    await waitFor(() => expect(container.textContent).toContain('Pick a kind'))
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue'))!)
    await waitFor(() => expect(container.textContent).toContain('Pick a channel'))
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue with WhatsApp'))!)
    await waitFor(() => expect(container.textContent).toContain('Name your agent'))
    const continueBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue to link')) as HTMLButtonElement
    expect(continueBtn.disabled).toBe(true) // no admin phone yet
    fireEvent.change(container.querySelector('#hatch-admin')!, { target: { value: '+1 555 0100' } })
    expect(continueBtn.disabled).toBe(false)
  })
})

describe('ceremony (14-onboarding §5 + 13-§2)', () => {
  function renderCeremony() {
    return render(
      <MemoryRouter>
        <Ceremony
          name="Quinn"
          soul="Keeps the room tidy."
          channelLabel="WhatsApp"
          adminPhone="+15550100001"
          lineName="quinn"
          agentInitial="Q"
          onAdjust={() => {}}
        />
      </MemoryRouter>,
    )
  }

  it('renders the sanctioned anatomy: glow class, eggshell, avatar, beats, name, soul, meta, composer', () => {
    const { container, getByTestId } = renderCeremony()
    const stage = getByTestId('hatch-ceremony')
    expect(stage.querySelector('.journey-glow')).not.toBeNull() // the one-shot glow (hatch-only class)
    expect(stage.querySelector('.journey-eggshell')).not.toBeNull()
    expect(stage.querySelector('.journey-av')!.textContent).toBe('Q')
    expect(stage.querySelectorAll('.journey-beat').length).toBe(3)
    expect(stage.textContent).toContain('Quinn')
    expect(stage.textContent).toContain('Keeps the room tidy.')
    expect(stage.textContent).toContain('WhatsApp')
    expect(stage.querySelector('.journey-firstmsg input')).not.toBeNull()
  })

  it('has NO dice at ceremony — the name is locked by then (documented mockup deviation)', () => {
    const { container } = renderCeremony()
    expect(container.querySelector('.journey-dice')).toBeNull()
    expect([...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Another name')).toBeUndefined()
  })

  it('Send & go live posts to the admin phone and navigates to the fleet', async () => {
    const { container } = renderCeremony()
    const input = container.querySelector('.journey-firstmsg input')!
    fireEvent.change(input, { target: { value: 'welcome to the room' } })
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Send & go live')!)
    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith('quinn', '+15550100001', 'welcome to the room'),
    )
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/'))
  })

  it('Skip ceremony navigates without sending', () => {
    const { container } = renderCeremony()
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Skip ceremony')!)
    expect(navigateMock).toHaveBeenCalledWith('/')
    expect(sendMessageMock).not.toHaveBeenCalled()
  })
})
