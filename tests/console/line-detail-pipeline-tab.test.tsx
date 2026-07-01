/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PipelineTab } from '../../console/src/components/line-detail/PipelineTab'
import { getModeColor } from '../../console/src/components/line-detail/types'
import type { LineInstance, Mode } from '../../console/src/types'

afterEach(() => cleanup())

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'test-line',
    phone: '+15550001234',
    mode: 'chat',
    status: 'online',
    accessMode: 'open',
    healthPort: 9100,
    uptime: '2h',
    messagesTotal: 50,
    health: {
      status: 'ok',
      uptime_seconds: 7200,
      messages_total: 50,
      connection: { state: 'open' },
      sqlite: { messages_total: 50, schema_version: 7 },
    },
    heartbeat: [],
    lastActive: '2026-04-05T12:00:00.000Z',
    error: null,
    ...overrides,
  }
}

function renderPipeline(line: LineInstance) {
  const mode = line.mode as Mode
  return render(<PipelineTab mode={mode} line={line} modeColor={getModeColor(mode)} />)
}

function detailValue(label: string): string | null {
  const labelNode = screen.getByText(label)
  return labelNode.nextElementSibling?.textContent ?? null
}

describe('PipelineTab node details', () => {
  it('shows passive inbound and store details, then collapses the selected node', () => {
    renderPipeline(makeLine({
      mode: 'passive',
      messagesToday: 6,
      messageStats: { received: 14, sent: 3, images: 1, audio: 0, documents: 2 },
      health: {
        status: 'ok',
        uptime_seconds: 3600,
        messages_total: 99,
        connection: { state: 'open' },
        sqlite: { messages_total: 88, schema_version: 13 },
      },
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Inbound' }))

    expect(detailValue('Status')).toBe('online')
    expect(detailValue('Messages today')).toBe('6')
    expect(detailValue('Received')).toBe('14')
    expect(detailValue('Sent')).toBe('3')

    fireEvent.click(screen.getByRole('button', { name: 'Store' }))

    expect(screen.queryByText('Messages today')).toBeNull()
    expect(detailValue('Messages stored')).toBe('88')
    expect(detailValue('Schema version')).toBe('13')

    fireEvent.click(screen.getByRole('button', { name: 'Store' }))

    expect(screen.queryByText('Messages stored')).toBeNull()
  })

  it('shows chat queue, enrichment, access, API, and outbound details', () => {
    renderPipeline(makeLine({
      mode: 'chat',
      accessMode: 'self_only',
      queueDepth: 7,
      enrichmentUnprocessed: 3,
      models: { conversation: 'gpt-4.1-mini' },
      tokenUsage: { input: 12345, output: 6789 },
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Inbound' }))
    expect(detailValue('Status')).toBe('online')

    fireEvent.click(screen.getByRole('button', { name: /^Queue/ }))
    expect(detailValue('Queue depth')).toBe('7')

    fireEvent.click(screen.getByRole('button', { name: /^Enrich/ }))
    expect(detailValue('Unprocessed')).toBe('3')

    fireEvent.click(screen.getByRole('button', { name: 'Access' }))
    expect(detailValue('Access mode')).toBe('self_only')

    fireEvent.click(screen.getByRole('button', { name: 'API' }))
    expect(detailValue('Model')).toBe('gpt-4.1-mini')
    expect(detailValue('Input tokens')).toBe('12,345')
    expect(detailValue('Output tokens')).toBe('6,789')

    fireEvent.click(screen.getByRole('button', { name: 'Outbound' }))
    expect(detailValue('Status')).toBe('online')
  })

  it('shows agent router, SDK loop, tools, and outbound details', () => {
    renderPipeline(makeLine({
      mode: 'agent',
      accessMode: 'approved_groups',
      activeSessions: 2,
      lastSessionStatus: 'running',
      totalSessions: 5,
      models: { conversation: 'line-model-agent' },
      sandboxPerChat: true,
      chatCounts: { chats: 4, groups: 6 },
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Inbound' }))
    expect(detailValue('Status')).toBe('online')

    fireEvent.click(screen.getByRole('button', { name: 'Router' }))
    expect(detailValue('Access mode')).toBe('approved_groups')
    expect(detailValue('Chats')).toBe('4')
    expect(detailValue('Groups')).toBe('6')

    fireEvent.click(screen.getByRole('button', { name: /^SDK Loop/ }))
    expect(detailValue('Active sessions')).toBe('2')
    expect(detailValue('Last session')).toBe('running')
    expect(detailValue('Total sessions')).toBe('5')

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(detailValue('Model')).toBe('line-model-agent')
    expect(detailValue('Sandbox per chat')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Outbound' }))
    expect(detailValue('Status')).toBe('online')
  })
})
