/**
 * LogsTab — level-filter pill behaviour, row rendering, and timestamp formatting.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LogsTab } from '../../console/src/components/line-detail/LogsTab'
import type { LogEntry } from '../../console/src/types'

afterEach(() => cleanup())

const LEVELS = ['all', 'info', 'warn', 'error', 'debug'] as const

function makeLogs(): LogEntry[] {
  return [
    { timestamp: '2026-05-12T10:00:00', level: 'info', msg: 'startup ok', source: 'core' },
    { timestamp: '2026-05-12T10:01:00', level: 'warn', msg: 'queue slow', source: 'transport' },
    { timestamp: '2026-05-12T10:02:00', level: 'error', msg: 'send failed', source: 'mcp' },
    { timestamp: '2026-05-12T10:03:00', level: 'debug', msg: 'tick', source: 'metrics' },
    { timestamp: '2026-05-12T10:04:00', level: 'info', msg: 'second info', source: 'core' },
  ]
}

function getPill(label: string): HTMLButtonElement {
  return screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }) as HTMLButtonElement
}

function getRowByMessage(message: string): HTMLElement {
  const row = screen.getByText(message).closest('[role="listitem"]')
  expect(row).toBeDefined()
  return row as HTMLElement
}

describe('LogsTab', () => {
  it('renders one filter pill per level plus all log rows when filter is "all"', () => {
    const logs = makeLogs()
    render(<LogsTab logs={logs} filter="all" onFilterChange={vi.fn()} />)

    // Toolbar still renders heading and all pills
    expect(screen.getByText('Logs')).toBeDefined()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(LEVELS.length)
    for (const lvl of LEVELS) {
      expect(getPill(lvl)).toBeDefined()
    }
    // Every log message should be present in LogStream rows
    expect(screen.getByText('startup ok')).toBeDefined()
    expect(screen.getByText('queue slow')).toBeDefined()
    expect(screen.getByText('send failed')).toBeDefined()
    expect(screen.getByText('tick')).toBeDefined()
    expect(screen.getByText('second info')).toBeDefined()
    // LogStream renders role="list" with role="listitem" rows
    expect(screen.getByRole('list')).toBeDefined()
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('renders a readable timestamp for each entry without showing raw ISO values', () => {
    const logs = makeLogs()
    render(<LogsTab logs={logs} filter="all" onFilterChange={vi.fn()} />)

    // LogsTab pre-formats timestamps via formatTime before passing to LogStream
    expect(screen.getByText('10:00 AM')).toBeDefined()
    expect(screen.getByText('10:01 AM')).toBeDefined()
    expect(screen.getByText('10:02 AM')).toBeDefined()
    expect(screen.getByText('10:03 AM')).toBeDefined()
    expect(screen.getByText('10:04 AM')).toBeDefined()

    for (const log of logs) expect(screen.queryByText(log.timestamp)).toBeNull()
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

    // Active error pill carries the crit channel tone via the Pill primitive
    // (pill.md: caller color overrides are consolidated into the tone prop).
    expect(active.className).toContain('soup-pill--crit')
    expect(active.className).toContain('soup-pill--pressed')
    expect(inactive.className).not.toContain('soup-pill--crit')
    expect(inactive.className).not.toContain('soup-pill--pressed')

    // Border treatment is owned by the Pill primitive classes now (no inline styles)
    expect(active.getAttribute('style') ?? '').not.toContain('border')
  })

  it('renders the empty state in the list when entries is empty', () => {
    render(<LogsTab logs={[]} filter="all" onFilterChange={vi.fn()} />)

    // Toolbar still renders all pills + heading
    expect(screen.getByText('Logs')).toBeDefined()
    expect(screen.getAllByRole('button')).toHaveLength(LEVELS.length)
    // LogStream renders empty state as a listitem
    expect(screen.getByRole('list')).toBeDefined()
    expect(screen.getByRole('listitem')).toBeDefined()
    // No log messages
    expect(screen.queryByText('startup ok')).toBeNull()
    expect(screen.queryByText('send failed')).toBeNull()
  })

  it('shows filtered-empty message when no entries match the active filter', () => {
    const logs: LogEntry[] = [
      { timestamp: '2026-05-12T10:00:00', level: 'info', msg: 'only info', source: 'core' },
    ]
    render(<LogsTab logs={logs} filter="error" onFilterChange={vi.fn()} />)

    expect(screen.queryByText('only info')).toBeNull()
    // LogStream renders the filteredEmptyMessage when isFiltered=true and entries=[].
    expect(screen.getByText('No error logs.')).toBeDefined()
    // Toolbar persists
    expect(screen.getAllByRole('button')).toHaveLength(LEVELS.length)
  })

  it('renders level letter tags (E/W/I/D) and source for each entry', () => {
    const logs: LogEntry[] = [
      { timestamp: '2026-05-12T10:00:00', level: 'error', msg: 'boom', source: 'mcp' },
      { timestamp: '2026-05-12T10:01:00', level: 'warn', msg: 'careful', source: 'queue' },
      { timestamp: '2026-05-12T10:02:00', level: 'info', msg: 'okay', source: 'core' },
      { timestamp: '2026-05-12T10:03:00', level: 'debug', msg: 'trace', source: 'inner' },
    ]
    const { container } = render(
      <LogsTab logs={logs} filter="all" onFilterChange={vi.fn()} />,
    )

    // Source labels visible in LogStream source lane
    expect(screen.getByText('mcp')).toBeDefined()
    expect(screen.getByText('queue')).toBeDefined()
    expect(screen.getByText('core')).toBeDefined()
    expect(screen.getByText('inner')).toBeDefined()

    // LogStream renders single-letter level tags: E/W/I/D (spec §Anatomy)
    const levelTags = Array.from(container.querySelectorAll('.soup-log__lvl')) as HTMLElement[]
    expect(levelTags).toHaveLength(4)
    expect(levelTags.map(el => el.textContent)).toEqual(['E', 'W', 'I', 'D'])

    // Level tag modifier classes carry severity channel (triple-channel: color + border + letter)
    expect(levelTags[0]!.className).toContain('soup-log__lvl--error')
    expect(levelTags[1]!.className).toContain('soup-log__lvl--warn')
    expect(levelTags[2]!.className).toContain('soup-log__lvl--info')
    expect(levelTags[3]!.className).toContain('soup-log__lvl--debug')

    // Error/warn rows carry severity wash via LogStream row modifier classes
    const errorRow = getRowByMessage('boom')
    expect(errorRow.className).toContain('soup-log__row--error')
    const warnRow = getRowByMessage('careful')
    expect(warnRow.className).toContain('soup-log__row--warn')

    // Info/debug rows carry no severity row modifier
    const infoRow = getRowByMessage('okay')
    expect(infoRow.className).not.toContain('soup-log__row--error')
    expect(infoRow.className).not.toContain('soup-log__row--warn')
  })

  it('shows per-level counts in the filter pills', () => {
    const logs = makeLogs() // 2 info, 1 warn, 1 error, 1 debug
    const { container } = render(<LogsTab logs={logs} filter="all" onFilterChange={vi.fn()} />)

    // Counts appear in the soup-pill__count span (aria-hidden, visible text)
    const countSpans = Array.from(container.querySelectorAll('.soup-pill__count')) as HTMLElement[]
    // 4 non-"all" pills have counts (info=2, warn=1, error=1, debug=1)
    expect(countSpans).toHaveLength(4)
    const countValues = countSpans.map(el => Number(el.textContent))
    expect(countValues).toContain(2) // info count
    expect(countValues).toContain(1) // warn, error, debug counts
  })
})
