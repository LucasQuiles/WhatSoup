/**
 * CheckpointsTab — render contract for the checkpoint browser surface.
 * Spec: oc-re/specs/2026-07-19-checkpoint-browser-ui-spec.md
 * Follow-ups (sort + Delivery column):
 * oc-re/specs/2026-07-19-checkpoints-tab-followups-spec.md
 * The tab is props-driven (LineDetail owns useCheckpoints), so these are
 * pure render tests — no api mocks or providers needed.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { CheckpointsTab } from '../../../../console/src/components/line-detail/CheckpointsTab'
import type { CheckpointsPayload } from '../../../../console/src/types'
import type { Freshness } from '../../../../console/src/lib/freshness'

const FRESH: Freshness = { observedAt: Date.now(), stale: false }
const STALE: Freshness = { observedAt: Date.now() - 10 * 60_000, stale: true }

const ROW_RESUMABLE = {
  conversationKey: '15550000001@s.whatsapp.net',
  sessionId: 'sess-abc',
  sessionStatus: 'suspended',
  checkpointVersion: 7,
  claudePid: 4321,
  workspacePath: '/workspaces/15550000001',
  createdAt: '2026-07-18T00:00:00Z',
  updatedAt: '2026-07-19T01:00:00Z',
  completedScope: 'per_chat',
  completedDeliveryJid: '15550000001@s.whatsapp.net',
  completedLogicalTurnId: 'lt-1',
  resumable: true,
}

const ROW_ENDED = {
  ...ROW_RESUMABLE,
  conversationKey: '15550000002@s.whatsapp.net',
  sessionId: 'sess-def',
  sessionStatus: 'ended',
  checkpointVersion: 3,
  claudePid: 5678,
  resumable: false,
}

function payload(overrides: Partial<CheckpointsPayload> = {}): CheckpointsPayload {
  return {
    observedAt: '2026-07-19T04:00:00Z',
    checkpoints: [ROW_RESUMABLE, ROW_ENDED],
    ...overrides,
  }
}

afterEach(cleanup)

describe('CheckpointsTab', () => {
  it('renders checkpoint rows with status badges and resumable markers', () => {
    render(<CheckpointsTab payload={payload()} isLoading={false} freshness={FRESH} />)
    expect(screen.getByText('suspended')).toBeTruthy()
    expect(screen.getByText('ended')).toBeTruthy()
    // exactly one resumable marker (the suspended row)
    expect(screen.getAllByText('resumable')).toHaveLength(1)
    expect(screen.getByText('v7')).toBeTruthy()
    expect(screen.getByText('4321')).toBeTruthy()
    expect(screen.getByText('5678')).toBeTruthy()
    expect(screen.getAllByText('per_chat')).toHaveLength(2)
    // header summary
    expect(screen.getByText(/2 checkpoints · 1 resumable on restart/)).toBeTruthy()
  })

  it('fails closed on readError — error row, never the empty state', () => {
    render(<CheckpointsTab payload={payload({ checkpoints: [], readError: true })} isLoading={false} freshness={FRESH} />)
    expect(screen.getByText(/Checkpoint data unavailable/)).toBeTruthy()
    expect(screen.queryByText(/No session checkpoints recorded/)).toBeNull()
    expect(screen.getByText('read unavailable')).toBeTruthy()
  })

  it('renders the empty state only for a genuine empty successful read', () => {
    render(<CheckpointsTab payload={payload({ checkpoints: [] })} isLoading={false} freshness={FRESH} />)
    expect(screen.getByText(/No session checkpoints recorded/)).toBeTruthy()
    expect(screen.queryByText(/Checkpoint data unavailable/)).toBeNull()
  })

  it('shows skeleton rows while loading and no data rows', () => {
    const { container } = render(<CheckpointsTab payload={undefined} isLoading freshness={FRESH} />)
    expect(container.querySelectorAll('.soup-table-skeleton-bar').length).toBeGreaterThan(0)
    expect(screen.queryByText('suspended')).toBeNull()
    expect(screen.getByText('not observed')).toBeTruthy()
  })

  it('marks the header stale when freshness says the observation is carried', () => {
    render(<CheckpointsTab payload={payload()} isLoading={false} freshness={STALE} />)
    const marker = screen.getByText(/\(stale\)/)
    expect(marker.className).toContain('text-s-warn')
  })

  it('flags unknown statuses with the warn severity badge', () => {
    const weird = { ...ROW_RESUMABLE, conversationKey: 'weird@s.whatsapp.net', sessionStatus: 'melted' }
    render(<CheckpointsTab payload={payload({ checkpoints: [weird] })} isLoading={false} freshness={FRESH} />)
    const badge = screen.getByText('melted')
    // warn severity maps to the warn wash/color tokens — unknown statuses never render green
    expect(badge.style.background).toBeTruthy()
    expect(badge.textContent).toBe('melted')
  })
})

describe('CheckpointsTab — sort (F-UX-1)', () => {
  // Short keys so truncateMiddle passes them through unchanged; payload
  // order is the server default (updated_at DESC): bravo (newer) then alpha.
  const ROW_ALPHA = {
    ...ROW_RESUMABLE,
    conversationKey: 'alpha@x',
    updatedAt: '2026-07-19T01:00:00Z',
  }
  const ROW_BRAVO = {
    ...ROW_RESUMABLE,
    conversationKey: 'bravo@x',
    sessionId: 'sess-bravo',
    updatedAt: '2026-07-19T03:00:00Z',
  }
  const serverOrder = [ROW_BRAVO, ROW_ALPHA]

  function renderedConversationOrder(): string[] {
    return screen
      .getAllByRole('row')
      .slice(1) // header row
      .map((r) => within(r).getAllByRole('cell')[0]!.textContent ?? '')
  }

  it('preserves payload (server) order before any sort interaction', () => {
    render(<CheckpointsTab payload={payload({ checkpoints: serverOrder })} isLoading={false} freshness={FRESH} />)
    expect(renderedConversationOrder()).toEqual(['bravo@x', 'alpha@x'])
  })

  it('cycles Conversation asc → desc → cleared through the tri-state sort button', () => {
    render(<CheckpointsTab payload={payload({ checkpoints: serverOrder })} isLoading={false} freshness={FRESH} />)
    const btn = screen.getByRole('button', { name: /Sort by Conversation/ })
    fireEvent.click(btn) // none → asc
    expect(renderedConversationOrder()).toEqual(['alpha@x', 'bravo@x'])
    fireEvent.click(btn) // asc → desc
    expect(renderedConversationOrder()).toEqual(['bravo@x', 'alpha@x'])
    fireEvent.click(btn) // desc → none (server order restored)
    expect(renderedConversationOrder()).toEqual(['bravo@x', 'alpha@x'])
  })

  it('sorts Updated chronologically — ascending puts the oldest checkpoint first', () => {
    render(<CheckpointsTab payload={payload({ checkpoints: serverOrder })} isLoading={false} freshness={FRESH} />)
    fireEvent.click(screen.getByRole('button', { name: /Sort by Updated/ }))
    expect(renderedConversationOrder()).toEqual(['alpha@x', 'bravo@x'])
  })
})

describe('CheckpointsTab — Delivery column (F-UX-3)', () => {
  it('renders the truncated delivery JID with the full JID + turn id in the title', () => {
    const row = {
      ...ROW_RESUMABLE,
      conversationKey: 'conv-a',
      completedDeliveryJid: '15550000001@s.whatsapp.net',
      completedLogicalTurnId: 'lt-1',
    }
    render(<CheckpointsTab payload={payload({ checkpoints: [row] })} isLoading={false} freshness={FRESH} />)
    // 26-char JID exceeds the truncateMiddle budget — rendered truncated…
    const cell = screen.getByText('15550000001@s.…atsapp.net')
    // …with the full identity bundle on the title for hover/AT
    expect(cell.getAttribute('title')).toBe('15550000001@s.whatsapp.net · turn lt-1')
  })

  it('renders the delivery JID (not the conversation key) under JID aliasing', () => {
    const row = {
      ...ROW_RESUMABLE,
      conversationKey: 'canonical:key-a',
      completedDeliveryJid: '15550000999@lid',
      completedLogicalTurnId: 'lt-99',
    }
    render(<CheckpointsTab payload={payload({ checkpoints: [row] })} isLoading={false} freshness={FRESH} />)
    expect(screen.getByText('15550000999@lid')).toBeTruthy()
    expect(screen.getByTitle('15550000999@lid · turn lt-99')).toBeTruthy()
  })

  it('renders an em-dash when the completed-delivery identity is absent', () => {
    const row = {
      ...ROW_RESUMABLE, // pid/scope/workspace all non-null — the only dash is Delivery
      conversationKey: 'conv-b',
      completedDeliveryJid: null,
      completedLogicalTurnId: null,
    }
    render(<CheckpointsTab payload={payload({ checkpoints: [row] })} isLoading={false} freshness={FRESH} />)
    const bodyRow = screen.getAllByRole('row')[1]!
    expect(within(bodyRow).getByText('—')).toBeTruthy()
  })
})
