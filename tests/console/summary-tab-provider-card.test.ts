/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'

import { SummaryTab } from '../../console/src/components/line-detail/SummaryTab'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import { getProvider } from '../../console/src/lib/providers'
import type { LineInstance } from '../../console/src/types'

afterEach(() => cleanup())

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}

function withToast(node: ReturnType<typeof createElement>) {
  return createElement(ToastContext.Provider, { value: toastValue }, node)
}

describe('SummaryTab provider card contract', () => {
  it('adds a provider card to agent summary metrics', () => {
    const line: LineInstance = {
      name: 'agent-line',
      phone: '+15551234567',
      mode: 'agent',
      provider: 'codex-cli',
      status: 'online',
      accessMode: 'allowlist',
      healthPort: 9001,
      uptime: '5m',
      messagesTotal: 0,
      heartbeat: ['up', 'up', 'up'],
      activeSessions: 1,
      health: {
        status: 'ok',
        uptime_seconds: 300,
        messages_total: 0,
        connection: { state: 'connected' },
        sqlite: { messages_total: 0, schema_version: 1 },
      },
      config: { agentOptions: { provider: 'openai-api' } },
    }

    render(withToast(createElement(SummaryTab, {
      line,
      onEditConfig: vi.fn(),
      onChangeMode: vi.fn(),
    })))

    const providerLabel = screen.getByText('PROVIDER')
    const card = providerLabel.closest('div.c-card') as HTMLElement
    expect(card).toBeTruthy()
    expect(within(card).getByText(getProvider('codex-cli')!.displayName)).toBeDefined()
  })
})
