import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModeTab } from '../../console/src/pages/LineDetail.tsx'
import type { LineInstance, Mode } from '../../console/src/types.ts'

function makeLine(mode: Mode): LineInstance {
  return {
    name: `${mode}-line`,
    phone: '+15555550123',
    mode,
    status: 'online',
    accessMode: 'all',
    healthPort: 9099,
    uptime: '1h',
    messagesTotal: 42,
    health: null,
    heartbeat: ['up'],
    lastActive: '2026-04-05T00:00:00.000Z',
    error: null,
    config: mode === 'passive' ? {} : { apiKey: 'secret-key', prompt: 'hello world' },
  }
}

describe('ModeTab', () => {
  it('shows only a change-mode action for passive lines', () => {
    const html = renderToStaticMarkup(createElement(ModeTab, {
      mode: 'passive',
      line: makeLine('passive'),
      onEditConfig: () => {},
      onChangeMode: () => {},
    }))

    expect(html).toContain('Change Mode')
    expect(html).not.toContain('Edit Configuration')
  })

  it('shows edit and change-mode actions for chat and agent lines', () => {
    for (const mode of ['chat', 'agent'] as const) {
      const html = renderToStaticMarkup(createElement(ModeTab, {
        mode,
        line: makeLine(mode),
        onEditConfig: () => {},
        onChangeMode: () => {},
      }))

      expect(html).toContain('Edit Configuration')
      expect(html).toContain('Change Mode')
    }
  })
})
