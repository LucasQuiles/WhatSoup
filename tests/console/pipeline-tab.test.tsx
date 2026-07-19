/**
 * PipelineTab — per-mode node rendering, active/inactive state, click-to-expand detail card.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PipelineTab } from '../../console/src/components/line-detail/PipelineTab'
import type { LineInstance, Mode } from '../../console/src/types'

afterEach(() => cleanup())

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'demo',
    phone: '+15550000000',
    mode: 'passive',
    status: 'online',
    accessMode: 'allowlist',
    healthPort: 0,
    uptime: '0s',
    messagesTotal: 0,
    health: null,
    heartbeat: [],
    lastActive: '',
    error: null,
    ...overrides,
  }
}

function renderTab(mode: Mode, line: LineInstance, modeColor = 'pas') {
  return render(<PipelineTab mode={mode} line={line} modeColor={modeColor} />)
}

describe('PipelineTab — passive mode', () => {
  it('renders Inbound, Store, Done nodes (3 total) when online', () => {
    renderTab('passive', makeLine({ status: 'online', unread: 0 }), 'pas')
    expect(screen.getByRole('button', { name: /^Inbound$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Store$/ })).toBeTruthy()
    // Done is a non-clickable span
    expect(screen.getByText('Done')).toBeTruthy()
    // 2 clickable nodes (Inbound, Store) — Done is static
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('marks Done active when online with zero unread, inactive when unread > 0', () => {
    const { unmount } = renderTab('passive', makeLine({ status: 'online', unread: 0 }), 'pas')
    const doneActive = screen.getByText('Done')
    // Active styling uses var(--m-pas-wash) background; inactive uses --btn-neutral-bg
    expect((doneActive as HTMLElement).getAttribute('style')).toContain('--m-pas-wash')
    unmount()
    renderTab('passive', makeLine({ status: 'online', unread: 5 }), 'pas')
    const doneInactive = screen.getByText('Done')
    expect((doneInactive as HTMLElement).getAttribute('style')).toContain('--btn-neutral-bg')
  })

  it('expands Inbound detail card with status + messagesToday on click; toggles closed on re-click', () => {
    renderTab('passive', makeLine({ status: 'online', messagesToday: 17 }), 'pas')
    const btn = screen.getByRole('button', { name: /^Inbound$/ })
    fireEvent.click(btn)
    expect(screen.getByText('Status')).toBeTruthy()
    expect(screen.getByText('online')).toBeTruthy()
    expect(screen.getByText('Messages today')).toBeTruthy()
    expect(screen.getByText('17')).toBeTruthy()
    fireEvent.click(btn)
    expect(screen.queryByText('Messages today')).toBeNull()
  })
})

describe('PipelineTab — chat mode', () => {
  it('renders 6 clickable nodes (Inbound, Access, Queue, Enrich, API, Outbound)', () => {
    renderTab('chat', makeLine({ status: 'online', accessMode: 'allowlist', queueDepth: 0, enrichmentUnprocessed: 0 }), 'cht')
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(6)
    expect(screen.getByRole('button', { name: /Inbound/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Access/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Queue/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Enrich/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /API/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Outbound/ })).toBeTruthy()
  })

  it('shows queue depth inline and marks Queue active when depth > 0', () => {
    renderTab('chat', makeLine({ status: 'online', queueDepth: 4 }), 'cht')
    expect(screen.getByText('depth: 4')).toBeTruthy()
    const queueBtn = screen.getByRole('button', { name: /Queue/ }) as HTMLButtonElement
    expect(queueBtn.getAttribute('style')).toContain('--m-cht-wash')
  })

  it('shows pending enrichments only when > 0; marks Enrich inactive at 0', () => {
    const { unmount } = renderTab('chat', makeLine({ status: 'online', enrichmentUnprocessed: 0 }), 'cht')
    expect(screen.queryByText(/pending/)).toBeNull()
    unmount()
    renderTab('chat', makeLine({ status: 'online', enrichmentUnprocessed: 3 }), 'cht')
    expect(screen.getByText('3 pending')).toBeTruthy()
  })

  it('marks Access inactive when accessMode is self_only', () => {
    renderTab('chat', makeLine({ status: 'online', accessMode: 'self_only' }), 'cht')
    const accessBtn = screen.getByRole('button', { name: /Access/ }) as HTMLButtonElement
    expect(accessBtn.getAttribute('style')).toContain('--btn-neutral-bg')
  })

  it('expands API detail card with model + token usage', () => {
    renderTab('chat', makeLine({
      status: 'online',
      models: { conversation: 'claude-opus-4-7' },
      tokenUsage: { input: 12345, output: 6789 },
    }), 'cht')
    fireEvent.click(screen.getByRole('button', { name: /API/ }))
    expect(screen.getByText('Model')).toBeTruthy()
    expect(screen.getByText('claude-opus-4-7')).toBeTruthy()
    expect(screen.getByText('12,345')).toBeTruthy()
    expect(screen.getByText('6,789')).toBeTruthy()
  })
})

describe('PipelineTab — agent mode', () => {
  it('renders 5 clickable nodes (Inbound, Router, SDK Loop, Tools, Outbound)', () => {
    renderTab('agent', makeLine({ status: 'online', activeSessions: 2 }), 'agt')
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(5)
    expect(screen.getByRole('button', { name: /SDK Loop/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Router/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Tools/ })).toBeTruthy()
    expect(screen.getByText('sessions: 2')).toBeTruthy()
  })

  it('marks SDK Loop, Tools, Outbound inactive when activeSessions is 0', () => {
    renderTab('agent', makeLine({ status: 'online', activeSessions: 0 }), 'agt')
    const sdkBtn = screen.getByRole('button', { name: /SDK Loop/ }) as HTMLButtonElement
    expect(sdkBtn.getAttribute('style')).toContain('--btn-neutral-bg')
    const toolsBtn = screen.getByRole('button', { name: /Tools/ }) as HTMLButtonElement
    expect(toolsBtn.getAttribute('style')).toContain('--btn-neutral-bg')
  })

  it('expands SDK Loop detail card with session counts and last status', () => {
    renderTab('agent', makeLine({
      status: 'online',
      activeSessions: 3,
      lastSessionStatus: 'completed',
      totalSessions: 42,
    }), 'agt')
    fireEvent.click(screen.getByRole('button', { name: /SDK Loop/ }))
    expect(screen.getByText('Active sessions')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('Last session')).toBeTruthy()
    expect(screen.getByText('completed')).toBeTruthy()
    expect(screen.getByText('Total sessions')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
  })

  it('expands Router detail card with access mode and chat counts', () => {
    renderTab('agent', makeLine({
      status: 'online',
      accessMode: 'allowlist',
      chatCounts: { chats: 7, groups: 2 },
    }), 'agt')
    fireEvent.click(screen.getByRole('button', { name: /Router/ }))
    expect(screen.getByText('Access mode')).toBeTruthy()
    expect(screen.getByText('allowlist')).toBeTruthy()
    expect(screen.getByText('Chats')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
    expect(screen.getByText('Groups')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
  })
})

describe('PipelineTab — offline state', () => {
  it('marks Inbound inactive across all modes when status is unreachable', () => {
    const offline = makeLine({ status: 'unreachable' })
    const { unmount: u1 } = renderTab('passive', offline, 'pas')
    let inbound = screen.getByRole('button', { name: /^Inbound$/ }) as HTMLButtonElement
    expect(inbound.getAttribute('style')).toContain('--btn-neutral-bg')
    u1()
    const { unmount: u2 } = renderTab('chat', offline, 'cht')
    inbound = screen.getByRole('button', { name: /^Inbound$/ }) as HTMLButtonElement
    expect(inbound.getAttribute('style')).toContain('--btn-neutral-bg')
    u2()
    renderTab('agent', offline, 'agt')
    inbound = screen.getByRole('button', { name: /^Inbound$/ }) as HTMLButtonElement
    expect(inbound.getAttribute('style')).toContain('--btn-neutral-bg')
  })

  it('does not render detail card before any node is clicked', () => {
    renderTab('chat', makeLine({ status: 'online' }), 'cht')
    // detail card contains a grid with auto 1fr; no detail labels should be present yet
    expect(screen.queryByText('Status')).toBeNull()
    expect(screen.queryByText('Queue depth')).toBeNull()
  })
})

describe('PipelineTab — freshness note (GUI-5)', () => {
  it('labels pipeline telemetry stale when the line health snapshot is carried forward', () => {
    renderTab('passive', makeLine({ status: 'online', unread: 0, stale: true, healthObservedAt: new Date(Date.now() - 300_000).toISOString() }), 'pas')
    const marker = screen.getByText(/^stale · /)
    expect(marker.className).toContain('c-label')
    expect(marker.className).toContain('text-s-warn')
    // telemetry stays visible — stale labels, never hides
    expect(screen.getByRole('button', { name: /^Inbound$/ })).toBeTruthy()
  })

  it('shows a quiet observation age when the snapshot is fresh', () => {
    renderTab('passive', makeLine({ status: 'online', unread: 0, stale: false, healthObservedAt: new Date(Date.now() - 5_000).toISOString() }), 'pas')
    const marker = screen.getByText(/^observed /)
    expect(marker.className).toContain('c-label')
    expect(marker.className).not.toContain('text-s-warn')
  })

  it('renders no note when the line carries no freshness data', () => {
    renderTab('passive', makeLine({ status: 'online', unread: 0 }), 'pas')
    expect(screen.queryByText(/^stale · /)).toBeNull()
    expect(screen.queryByText(/^observed /)).toBeNull()
  })
})
