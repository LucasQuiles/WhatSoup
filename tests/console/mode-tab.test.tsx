/**
 * ModeTab — behavior coverage for passive vs configured modes.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModeTab } from '../../console/src/components/line-detail/ModeTab'
import type { LineInstance, Mode } from '../../console/src/types'

afterEach(() => cleanup())

function line(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'line-x',
    phone: '15550000000',
    mode: 'chat' as Mode,
    status: 'online',
    accessMode: 'allowList',
    healthPort: 9200,
    uptime: '1m',
    messagesTotal: 0,
    health: null,
    heartbeat: ['up'],
    lastActive: '2026-05-12T00:00:00.000Z',
    error: null,
    ...overrides,
  }
}

describe('ModeTab passive mode', () => {
  it('renders the read-only empty state and a single Change Mode button', () => {
    const onEditConfig = vi.fn()
    const onChangeMode = vi.fn()
    const { container } = render(
      <ModeTab
        mode="passive"
        line={line({ mode: 'passive' })}
        onEditConfig={onEditConfig}
        onChangeMode={onChangeMode}
      />,
    )

    expect(screen.getByText('Read-only Mode')).toBeDefined()
    expect(
      screen.getByText('Passive instances listen and store — no configuration required.'),
    ).toBeDefined()

    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(1)
    expect(buttons[0].textContent).toContain('Change Mode')
    // No Edit Configuration affordance in passive mode
    expect(screen.queryByText(/Edit Configuration/)).toBeNull()
  })

  it('invokes onChangeMode and never onEditConfig when the passive Change Mode button is clicked', () => {
    const onEditConfig = vi.fn()
    const onChangeMode = vi.fn()
    render(
      <ModeTab
        mode="passive"
        line={line({ mode: 'passive' })}
        onEditConfig={onEditConfig}
        onChangeMode={onChangeMode}
      />,
    )

    const btn = screen.getByRole('button', { name: /Change Mode/ })
    fireEvent.click(btn)

    expect(onChangeMode).toHaveBeenCalledTimes(1)
    expect(onEditConfig).not.toHaveBeenCalled()
  })

  it('ignores line.config entirely in passive mode', () => {
    const onEditConfig = vi.fn()
    const onChangeMode = vi.fn()
    render(
      <ModeTab
        mode="passive"
        line={line({ mode: 'passive', config: { someKey: 'shouldNotAppear' } })}
        onEditConfig={onEditConfig}
        onChangeMode={onChangeMode}
      />,
    )

    expect(screen.queryByText('someKey')).toBeNull()
    expect(screen.queryByText('shouldNotAppear')).toBeNull()
    expect(screen.queryByText(/Configuration/)).toBeNull()
  })
})

describe('ModeTab configured-mode header', () => {
  it('renders the mode-named header and both Edit and Change action buttons for chat mode', () => {
    const onEditConfig = vi.fn()
    const onChangeMode = vi.fn()
    const { container } = render(
      <ModeTab
        mode="chat"
        line={line({ mode: 'chat', config: {} })}
        onEditConfig={onEditConfig}
        onChangeMode={onChangeMode}
      />,
    )

    const header = container.querySelector('.c-col-header') as HTMLElement | null
    expect(header).not.toBeNull()
    expect(header?.textContent).toContain('chat')
    expect(header?.textContent).toContain('Configuration')

    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(2)
    expect(buttons[0].textContent).toContain('Edit Configuration')
    expect(buttons[1].textContent).toContain('Change Mode')
  })

  it('renders agent in the header text when mode is agent', () => {
    const { container } = render(
      <ModeTab
        mode="agent"
        line={line({ mode: 'agent', config: {} })}
        onEditConfig={vi.fn()}
        onChangeMode={vi.fn()}
      />,
    )

    const header = container.querySelector('.c-col-header') as HTMLElement | null
    expect(header?.textContent).toContain('agent')
    expect(header?.textContent).toContain('Configuration')
  })

  it('routes each header button to its own callback exactly once', () => {
    const onEditConfig = vi.fn()
    const onChangeMode = vi.fn()
    render(
      <ModeTab
        mode="chat"
        line={line({ mode: 'chat', config: {} })}
        onEditConfig={onEditConfig}
        onChangeMode={onChangeMode}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Edit Configuration/ }))
    expect(onEditConfig).toHaveBeenCalledTimes(1)
    expect(onChangeMode).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Change Mode/ }))
    expect(onEditConfig).toHaveBeenCalledTimes(1)
    expect(onChangeMode).toHaveBeenCalledTimes(1)
  })
})

describe('ModeTab configured-mode empty config', () => {
  it('renders the empty-config message when line.config is an empty object', () => {
    const { container } = render(
      <ModeTab
        mode="chat"
        line={line({ mode: 'chat', config: {} })}
        onEditConfig={vi.fn()}
        onChangeMode={vi.fn()}
      />,
    )

    expect(screen.getByText('No configuration values.')).toBeDefined()
    // The grid container should not be present when there are no entries
    const grids = container.querySelectorAll('div.bg-surface-inset')
    expect(grids.length).toBe(0)
  })

  it('renders the empty-config message when line.config is undefined', () => {
    render(
      <ModeTab
        mode="chat"
        line={line({ mode: 'chat', config: undefined })}
        onEditConfig={vi.fn()}
        onChangeMode={vi.fn()}
      />,
    )

    expect(screen.getByText('No configuration values.')).toBeDefined()
  })

  it('renders the empty-config message when every key is excluded (name/type/paths/healthPort)', () => {
    render(
      <ModeTab
        mode="chat"
        line={line({
          mode: 'chat',
          config: { name: 'x', type: 'y', paths: {}, healthPort: 9000 },
        })}
        onEditConfig={vi.fn()}
        onChangeMode={vi.fn()}
      />,
    )

    expect(screen.getByText('No configuration values.')).toBeDefined()
  })
})

describe('ModeTab configured-mode populated grid', () => {
  it('renders one key/value pair per non-excluded config entry', () => {
    const { container } = render(
      <ModeTab
        mode="chat"
        line={line({
          mode: 'chat',
          config: {
            provider: 'anthropic',
            maxTokens: 4096,
            // Excluded keys must not render
            name: 'should-not-render',
            healthPort: 9123,
          },
        })}
        onEditConfig={vi.fn()}
        onChangeMode={vi.fn()}
      />,
    )

    expect(screen.getByText('provider')).toBeDefined()
    expect(screen.getByText('anthropic')).toBeDefined()
    expect(screen.getByText('maxTokens')).toBeDefined()
    expect(screen.getByText('4096')).toBeDefined()

    expect(screen.queryByText('name')).toBeNull()
    expect(screen.queryByText('should-not-render')).toBeNull()
    expect(screen.queryByText('healthPort')).toBeNull()
    expect(screen.queryByText('9123')).toBeNull()
    expect(screen.queryByText('No configuration values.')).toBeNull()

    // Grid container should now exist
    const grid = container.querySelector('div.bg-surface-inset') as HTMLElement | null
    expect(grid).not.toBeNull()
    expect((grid as HTMLElement).classList.contains('grid')).toBe(true)
  })

  it('color-codes string vs number vs path entries via TYPE_COLOR', () => {
    const { container } = render(
      <ModeTab
        mode="chat"
        line={line({
          mode: 'chat',
          config: {
            provider: 'anthropic',
            maxTokens: 4096,
            cwd: '/var/lib/whatsoup/line-x',
          },
        })}
        onEditConfig={vi.fn()}
        onChangeMode={vi.fn()}
      />,
    )

    const grid = container.querySelector('div.bg-surface-inset') as HTMLElement
    const valueSpans = Array.from(grid.querySelectorAll(':scope > span'))
    // 3 entries × 2 spans (key + value) = 6
    expect(valueSpans.length).toBe(6)

    const stringColor = (valueSpans[1] as HTMLElement).style.color
    const numberColor = (valueSpans[3] as HTMLElement).style.color
    const pathColor = (valueSpans[5] as HTMLElement).style.color

    expect(stringColor.length).toBeGreaterThan(0)
    expect(numberColor.length).toBeGreaterThan(0)
    expect(pathColor.length).toBeGreaterThan(0)
    expect(new Set([stringColor, numberColor, pathColor]).size).toBe(3)
  })

  it('renders boolean entries with a status dot whose background reflects truthiness', () => {
    const { container } = render(
      <ModeTab
        mode="agent"
        line={line({
          mode: 'agent',
          config: {
            agentOptions: {
              sandboxPerChat: true,
              'mcp': { inheritUserConfig: false },
            },
          },
        })}
        onEditConfig={vi.fn()}
        onChangeMode={vi.fn()}
      />,
    )

    expect(screen.getByText('agentOptions.sandboxPerChat')).toBeDefined()
    expect(screen.getByText('agentOptions.mcp.inheritUserConfig')).toBeDefined()

    const trueValue = screen.getByText('true')
    const falseValue = screen.getByText('false')
    const trueDot = trueValue.parentElement?.querySelector('span.inline-block') as HTMLElement | null
    const falseDot = falseValue.parentElement?.querySelector('span.inline-block') as HTMLElement | null

    expect(trueDot).not.toBeNull()
    expect(falseDot).not.toBeNull()
    expect(trueDot?.style.background).toBe('var(--status-ok-solid)')
    expect(falseDot?.style.background).toBe('var(--text-3)')
  })
})
