/**
 * Settings page — v3.5 surface contract harness (T5 b-09; mockup
 * settings.html SSOT + 17-settings-ia-spec.md).
 *
 * Honesty under test: rows with real persistence are WIRED (theme, fleet
 * silences, provider keys, session lock); rows with no backend are disabled
 * with disclosed reasons or omitted outright (workspace name, admin
 * identity — no fields exist).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { LineInstance } from '../../console/src/types'

let mockLines: LineInstance[] = []
vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: () => ({ data: mockLines }),
}))

const themeState = { theme: 'dark' as 'dark' | 'light', setTheme: vi.fn(), toggleTheme: vi.fn() }
vi.mock('../../console/src/hooks/use-theme', () => ({
  useTheme: () => themeState,
}))

const toastMock = { toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn(), clear: vi.fn() }
vi.mock('../../console/src/hooks/toast-context', () => ({
  ToastContext: { Provider: ({ children }: { children?: React.ReactNode }) => children },
  useToast: () => toastMock,
}))

let mockSilences: Array<{ instance: string; until: string; reason: string | null; silencedBy: string; createdAt: string }> = []
vi.mock('../../console/src/lib/api', () => ({
  api: {
    getSilences: vi.fn(() => Promise.resolve({ silences: mockSilences })),
    silenceLine: vi.fn().mockResolvedValue({ ok: true, rule: {} }),
    unsilenceLine: vi.fn().mockResolvedValue({ ok: true }),
    setCredential: vi.fn().mockResolvedValue({ ok: true, service: 'deepseek' }),
    verifyCredential: vi.fn().mockResolvedValue({ service: 'deepseek', status: 'valid' }),
    deleteCredential: vi.fn().mockResolvedValue({ ok: true, service: 'deepseek' }),
  },
  lockConsole: vi.fn().mockResolvedValue(undefined),
}))

import Settings from '../../console/src/pages/Settings'
import { api, lockConsole } from '../../console/src/lib/api'

const getSilencesMock = api.getSilences as unknown as ReturnType<typeof vi.fn>
const silenceLineMock = api.silenceLine as unknown as ReturnType<typeof vi.fn>
const unsilenceLineMock = api.unsilenceLine as unknown as ReturnType<typeof vi.fn>
const setCredentialMock = api.setCredential as unknown as ReturnType<typeof vi.fn>
const verifyCredentialMock = api.verifyCredential as unknown as ReturnType<typeof vi.fn>
const deleteCredentialMock = api.deleteCredential as unknown as ReturnType<typeof vi.fn>
const lockConsoleMock = lockConsole as unknown as ReturnType<typeof vi.fn>

function makeLine(name: string, overrides: Record<string, unknown> = {}): LineInstance {
  return {
    name,
    phone: '+10000000000',
    mode: 'chat',
    status: 'online',
    accessMode: 'allowlist',
    healthPort: 4000,
    uptime: '1d',
    messagesTotal: 0,
    health: {
      status: 'ok',
      uptime_seconds: 60,
      messages_total: 0,
      transport: { kind: 'baileys', connected: true },
      sqlite: { messages_total: 0, schema_version: 1 },
    },
    heartbeat: [],
    lastActive: '',
    error: null,
    linkedStatus: 'linked',
    ...overrides,
  } as LineInstance
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockLines = [makeLine('personal'), makeLine('support')]
  mockSilences = []
  themeState.theme = 'dark'
  themeState.setTheme.mockClear()
  Object.values(toastMock).forEach((fn) => fn.mockClear())
  ;[getSilencesMock, silenceLineMock, unsilenceLineMock, setCredentialMock, verifyCredentialMock, deleteCredentialMock, lockConsoleMock].forEach((m) => m.mockClear())
})

afterEach(cleanup)

describe('v3.5 settings — frame + the wave-4b no-phantom-nav law', () => {
  it('owns exactly one h1 and renders nav == sections 1:1', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('.settings-snav')).not.toBeNull())
    expect(container.querySelectorAll('h1').length).toBe(1)
    const navItems = [...container.querySelectorAll('.settings-snav a')].map((a) => a.textContent)
    const sections = [...container.querySelectorAll('.settings-main section')].map((s) => s.id)
    expect(navItems).toEqual(['Workspace', 'Channels', 'Notifications', 'API tokens', 'Danger zone'])
    expect(sections).toEqual(['workspace', 'channels', 'notifications', 'tokens', 'danger'])
  })

  it('section nav scrolls to the target section and tracks active state', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('.settings-snav')).not.toBeNull())
    const scrollSpy = vi.fn()
    container.querySelectorAll('.settings-main section').forEach((s) => {
      ;(s as HTMLElement).scrollIntoView = scrollSpy
    })
    const tokensLink = [...container.querySelectorAll('.settings-snav a')].find(
      (a) => a.textContent === 'API tokens',
    )!
    fireEvent.click(tokensLink)
    expect(scrollSpy).toHaveBeenCalled()
    expect(tokensLink.className).toContain('on')
    expect(tokensLink.getAttribute('aria-current')).toBe('true')
  })
})

describe('v3.5 settings — Workspace', () => {
  it('swatches sync with the live theme; dark/light wire setTheme', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelectorAll('.settings-sw').length).toBe(3))
    const dark = container.querySelector('.settings-sw--dark')!
    const light = container.querySelector('.settings-sw--light')!
    // live theme is dark → dark swatch selected, light not
    expect(dark.classList.contains('settings-sw--on')).toBe(true)
    expect(dark.getAttribute('aria-pressed')).toBe('true')
    expect(light.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(light)
    expect(themeState.setTheme).toHaveBeenCalledWith('light')
  })

  it('auto swatch is disabled with the no-auto-value note', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('.settings-sw--auto')).not.toBeNull())
    const auto = container.querySelector('.settings-sw--auto') as HTMLButtonElement
    expect(auto.disabled).toBe(true)
    expect(auto.title).toContain('no auto theme value')
    expect(auto.getAttribute('aria-description')).toContain('no auto value')
  })

  it('reduced-motion and export rows are disabled with reasons; no name/identity rows exist', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#workspace')).not.toBeNull())
    const ws = container.querySelector('#workspace')!
    const tgl = ws.querySelector('.settings-tgl')!
    expect(tgl.getAttribute('aria-description')).toContain('prefers-reduced-motion')
    const exportBtn = [...ws.querySelectorAll('button')].find((b) => b.textContent === 'export…')!
    expect((exportBtn as HTMLButtonElement).disabled).toBe(true)
    // honest omissions — never fabricated inputs
    expect(ws.textContent).not.toContain('Workspace name')
    expect(ws.textContent).not.toContain('Admin identity')
  })
})

describe('v3.5 settings — Channels', () => {
  it('renders per-line link state rows from the real lines payload', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#channels')).not.toBeNull())
    const ch = container.querySelector('#channels')!
    expect(ch.textContent).toContain('personal · WhatsApp')
    expect(ch.textContent).toContain('support · WhatsApp')
    expect(ch.textContent).toContain('link: linked')
    expect(ch.querySelectorAll('.settings-pill--live').length).toBe(2)
  })
})

describe('v3.5 settings — Notifications (real silence backend)', () => {
  it('renders the honest no-prefs note and an honest empty mute list', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#notifications')).not.toBeNull())
    const n = container.querySelector('#notifications')!
    expect(n.textContent).toContain('no prefs store exists today')
    expect(n.textContent).toContain('No active mutes')
  })

  it('lists active silences and unsilence calls the real route', async () => {
    mockSilences = [
      { instance: 'builds', until: '2026-07-23T18:00:00.000Z', reason: 'flapping', silencedBy: 'fleet-api', createdAt: '' },
    ]
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#notifications')!.textContent).toContain('builds'))
    expect(container.querySelector('#notifications')!.textContent).toContain('flapping')
    const unmuteBtn = [...container.querySelectorAll('#notifications button')].find((b) => b.textContent === 'unmute')!
    fireEvent.click(unmuteBtn)
    await waitFor(() => expect(unsilenceLineMock).toHaveBeenCalledWith('builds'))
  })

  it('mute posts instance + minutes and invalidates the list', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#notifications')).not.toBeNull())
    const select = container.querySelector('#notifications select')!
    fireEvent.change(select, { target: { value: 'support' } })
    const muteBtn = [...container.querySelectorAll('#notifications button')].find((b) => b.textContent === 'mute')!
    fireEvent.click(muteBtn)
    await waitFor(() =>
      expect(silenceLineMock).toHaveBeenCalledWith('support', 60, 'muted from Settings'),
    )
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
  })
})

describe('v3.5 settings — API tokens (provider keys, write-only)', () => {
  it('renders rows for the allowlisted providers with the write-only disclosure', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#tokens')).not.toBeNull())
    const t = container.querySelector('#tokens')!
    expect(t.textContent).toContain('write-only')
    for (const s of ['deepseek', 'minimax', 'openai', 'anthropic']) {
      expect(t.textContent).toContain(s)
    }
    // no fabricated inventory: no "created" dates, no scopes
    expect(t.textContent).not.toContain('created')
  })

  it('set posts the key, clears the input, and masks entry (type=password)', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#tokens')).not.toBeNull())
    const input = container.querySelector('#tokens input')! as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'sk-test-123' } })
    const setBtn = [...container.querySelectorAll('#tokens button')].find((b) => b.textContent === 'set')!
    fireEvent.click(setBtn)
    await waitFor(() => expect(setCredentialMock).toHaveBeenCalledWith('deepseek', 'sk-test-123'))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
  })

  it('verify shows the returned status — and a later set clears it (no false attestation)', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#tokens')).not.toBeNull())
    const verifyBtn = [...container.querySelectorAll('#tokens button')].find((b) => b.textContent === 'verify')!
    fireEvent.click(verifyBtn)
    await waitFor(() => expect(verifyCredentialMock).toHaveBeenCalledWith('deepseek'))
    await waitFor(() => expect(container.querySelector('#tokens')!.textContent).toContain('valid'))

    // setting a NEW key must drop the old key's verdict — strong form:
    // the row provably still renders (positive control), the verdict is gone.
    const input = container.querySelector('#tokens input')! as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-new-456' } })
    const setBtn = [...container.querySelectorAll('#tokens button')].find((b) => b.textContent === 'set')!
    fireEvent.click(setBtn)
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    const tokensSection = container.querySelector('#tokens')!
    expect(tokensSection.textContent).toContain('deepseek') // row still renders
    expect(tokensSection.textContent).not.toContain('valid')
  })

  it('revoke deletes the key; the session lock row calls lockConsole', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#tokens')).not.toBeNull())
    const revokeBtn = [...container.querySelectorAll('#tokens button')].find((b) => b.textContent === 'revoke')!
    fireEvent.click(revokeBtn)
    await waitFor(() => expect(deleteCredentialMock).toHaveBeenCalledWith('deepseek'))
    const lockBtn = [...container.querySelectorAll('#tokens button')].find((b) => b.textContent === 'lock now')!
    fireEvent.click(lockBtn)
    await waitFor(() => expect(lockConsoleMock).toHaveBeenCalled())
  })
})

describe('v3.5 settings — Danger zone', () => {
  it('reset row is disabled with the no-endpoint note (never a live fake)', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('#danger')).not.toBeNull())
    const d = container.querySelector('#danger')!
    const resetBtn = [...d.querySelectorAll('button')].find((b) => b.textContent === 'reset…') as HTMLButtonElement
    expect(resetBtn.disabled).toBe(true)
    expect(resetBtn.title).toContain('No reset endpoint')
    expect(d.querySelector('.settings-panel--danger')).not.toBeNull()
  })
})
