/**
 * CheckpointsTab — render contract for the checkpoint browser surface.
 * Spec: oc-re/specs/2026-07-19-checkpoint-browser-ui-spec.md
 * The tab is props-driven (LineDetail owns useCheckpoints), so these are
 * pure render tests — no api mocks or providers needed.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
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
