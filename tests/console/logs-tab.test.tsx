/**
 * LogsTab — level-filter pill behaviour, row rendering, and timestamp formatting.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LogsTab } from '../../console/src/components/line-detail/LogsTab'
import { formatTime } from '../../console/src/lib/format-time'
import { levelColor, levelBg, levelLineBg } from '../../console/src/lib/log-theme'
import type { LogEntry } from '../../console/src/types'

afterEach(() => cleanup())

const LEVELS = ['all', 'info', 'warn', 'error', 'debug'] as const

function makeLogs(): LogEntry[] {
  return [
    { timestamp: '2026-05-12T10:00:00Z', level: 'info', msg: 'startup ok', source: 'core' },
    { timestamp: '2026-05-12T10:01:00Z', level: 'warn', msg: 'queue slow', source: 'transport' },
    { timestamp: '2026-05-12T10:02:00Z', level: 'error', msg: 'send failed', source: 'mcp' },
    { timestamp: '2026-05-12T10:03:00Z', level: 'debug', msg: 'tick', source: 'metrics' },
    { timestamp: '2026-05-12T10:04:00Z', level: 'info', msg: 'second info', source: 'core' },
  ]
}

function getPill(label: string): HTMLButtonElement {
  return screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }) as HTMLButtonElement
}

describe('LogsTab', () => {
  it('renders one filter pill per level plus all log rows when filter is "all"', () => {
    const logs = makeLogs()
    render(<LogsTab logs={logs} filter="all" onFilterChange={vi.fn()} />)

    expect(screen.getByText('Logs')).toBeDefined()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(LEVELS.length)
    for (const lvl of LEVELS) {
      expect(getPill(lvl)).toBeDefined()
    }
    // Every log message should be present
    expect(screen.getByText('startup ok')).toBeDefined()
    expect(screen.getByText('queue slow')).toBeDefined()
    expect(screen.getByText('send failed')).toBeDefined()
    expect(screen.getByText('tick')).toBeDefined()
    expect(screen.getByText('second info')).toBeDefined()
  })

  it('renders the formatted timestamp for each entry via formatTime', () => {
    const logs = makeLogs()
    render(<LogsTab logs={logs} filter="all" onFilterChange={vi.fn()} />)

    for (const log of logs) {
      const formatted = formatTime(log.timestamp)
      // Each timestamp appears at least once (some timestamps may format the same minute in test tz);
      // getAllByText guards against single-match assumption while ensuring presence.
      const matches = screen.getAllByText(formatted)
      expect(matches.length).toBeGreaterThan(0)
    }
  })

  it('filters rows by level when a non-"all" filter is applied', () => {
    const logs = makeLogs()
    const { rerender } = render(
      <LogsTab logs={logs} filter="info" onFilterChange={vi.fn()} />,
    )

    expect(screen.getByText('startup ok')).toBeDefined()
    expect(screen.getByText('second info')).toBeDefined()
    expect(screen.queryByText('queue slow')).toBeNull()
    expect(screen.queryByText('send failed')).toBeNull()
    expect(screen.queryByText('tick')).toBeNull()

    rerender(<LogsTab logs={logs} filter="error" onFilterChange={vi.fn()} />)
    expect(screen.getByText('send failed')).toBeDefined()
    expect(screen.queryByText('startup ok')).toBeNull()
    expect(screen.queryByText('queue slow')).toBeNull()
    expect(screen.queryByText('tick')).toBeNull()
    expect(screen.queryByText('second info')).toBeNull()

    rerender(<LogsTab logs={logs} filter="debug" onFilterChange={vi.fn()} />)
    expect(screen.getByText('tick')).toBeDefined()
    expect(screen.queryByText('startup ok')).toBeNull()
    expect(screen.queryByText('queue slow')).toBeNull()
    expect(screen.queryByText('send failed')).toBeNull()
  })

  it('forwards the clicked pill value to onFilterChange', () => {
    const onFilterChange = vi.fn()
    render(<LogsTab logs={makeLogs()} filter="all" onFilterChange={onFilterChange} />)

    fireEvent.click(getPill('warn'))
    fireEvent.click(getPill('error'))
    fireEvent.click(getPill('debug'))
    fireEvent.click(getPill('info'))
    fireEvent.click(getPill('all'))

    expect(onFilterChange).toHaveBeenCalledTimes(5)
    expect(onFilterChange.mock.calls.map(c => c[0])).toEqual(['warn', 'error', 'debug', 'info', 'all'])
  })

  it('visually distinguishes the active pill via aria-pressed and active class set', () => {
    const logs = makeLogs()
    render(<LogsTab logs={logs} filter="error" onFilterChange={vi.fn()} />)

    const active = getPill('error')
    const inactive = getPill('info')

    expect(active.getAttribute('aria-pressed')).toBe('true')
    expect(inactive.getAttribute('aria-pressed')).toBe('false')

    // Active pill carries the configured activeColor (error → text-s-crit), inactive does not
    expect(active.className).toContain('text-s-crit')
    expect(active.className).toContain('bg-d4')
    expect(inactive.className).not.toContain('text-s-crit')
    expect(inactive.className).toContain('text-t4')

    // Active border style differs from inactive (var(--b3) vs var(--b1))
    expect(active.style.border).toContain('var(--b3)')
    expect(inactive.style.border).toContain('var(--b1)')
  })

  it('renders nothing in the body when entries=[] but keeps the toolbar', () => {
    render(<LogsTab logs={[]} filter="all" onFilterChange={vi.fn()} />)

    // Toolbar still renders all pills + heading
    expect(screen.getByText('Logs')).toBeDefined()
    expect(screen.getAllByRole('button')).toHaveLength(LEVELS.length)
    // No log messages
    expect(screen.queryByText('startup ok')).toBeNull()
    expect(screen.queryByText('send failed')).toBeNull()
  })

  it('renders nothing in the body when no entries match the active filter', () => {
    // Logs contain only info/warn/error/debug — filter to a level with no entries
    const logs: LogEntry[] = [
      { timestamp: '2026-05-12T10:00:00Z', level: 'info', msg: 'only info', source: 'core' },
    ]
    render(<LogsTab logs={logs} filter="error" onFilterChange={vi.fn()} />)

    expect(screen.queryByText('only info')).toBeNull()
    // Toolbar persists
    expect(screen.getAllByRole('button')).toHaveLength(LEVELS.length)
  })

  it('renders level badge, source, and message with the level-themed classes per entry', () => {
    const logs: LogEntry[] = [
      { timestamp: '2026-05-12T10:00:00Z', level: 'error', msg: 'boom', source: 'mcp' },
      { timestamp: '2026-05-12T10:01:00Z', level: 'warn', msg: 'careful', source: 'queue' },
      { timestamp: '2026-05-12T10:02:00Z', level: 'info', msg: 'okay', source: 'core' },
      { timestamp: '2026-05-12T10:03:00Z', level: 'debug', msg: 'trace', source: 'inner' },
    ]
    const { container } = render(
      <LogsTab logs={logs} filter="all" onFilterChange={vi.fn()} />,
    )

    // Source labels
    expect(screen.getByText('mcp')).toBeDefined()
    expect(screen.getByText('queue')).toBeDefined()
    expect(screen.getByText('core')).toBeDefined()
    expect(screen.getByText('inner')).toBeDefined()

    // Badge: the exact text "error", "warn", "info", "debug" appears at least twice
    // (once inside the pill toolbar, once inside the row badge); badges carry the levelBg style.
    const errorNodes = screen.getAllByText('error')
    const warnNodes = screen.getAllByText('warn')
    const infoNodes = screen.getAllByText('info')
    const debugNodes = screen.getAllByText('debug')
    expect(errorNodes.length).toBeGreaterThanOrEqual(2)
    expect(warnNodes.length).toBeGreaterThanOrEqual(2)
    expect(infoNodes.length).toBeGreaterThanOrEqual(2)
    expect(debugNodes.length).toBeGreaterThanOrEqual(2)

    // The badge node (a <span> inside the row, not the <button> pill) must carry levelColor + levelBg
    const errorBadge = errorNodes.find(n => n.tagName === 'SPAN' && n.style.background === levelBg.error)
    const warnBadge = warnNodes.find(n => n.tagName === 'SPAN' && n.style.background === levelBg.warn)
    const infoBadge = infoNodes.find(n => n.tagName === 'SPAN' && n.style.background === levelBg.info)
    const debugBadge = debugNodes.find(n => n.tagName === 'SPAN' && n.style.background === levelBg.debug)
    expect(errorBadge).toBeDefined()
    expect(warnBadge).toBeDefined()
    expect(infoBadge).toBeDefined()
    expect(debugBadge).toBeDefined()
    expect(errorBadge!.className).toContain(levelColor.error!)
    expect(warnBadge!.className).toContain(levelColor.warn!)
    expect(infoBadge!.className).toContain(levelColor.info!)
    expect(debugBadge!.className).toContain(levelColor.debug!)

    // Message text inherits the level color class on its container
    const boomMsg = screen.getByText('boom')
    expect(boomMsg.className).toContain(levelColor.error!)
    const carefulMsg = screen.getByText('careful')
    expect(carefulMsg.className).toContain(levelColor.warn!)

    // Row background uses levelLineBg only for warn/error (info/debug have no entry → empty string)
    const rows = container.querySelectorAll('.c-row-hover')
    expect(rows).toHaveLength(4)
    const [errorRow, warnRow, infoRow, debugRow] = rows as unknown as HTMLElement[]
    expect(errorRow!.style.background).toBe(levelLineBg.error)
    expect(warnRow!.style.background).toBe(levelLineBg.warn)
    expect(infoRow!.style.background).toBe('')
    expect(debugRow!.style.background).toBe('')
  })
})
