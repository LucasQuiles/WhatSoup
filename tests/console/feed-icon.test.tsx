/**
 * Design contract-lock for console/src/components/FeedIcon.tsx.
 *
 * This pins the rendered SVG icon class, semantic Tailwind color token, and
 * shared lucide sizing/stroke attributes per routing path.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import FeedIcon from '../../console/src/components/FeedIcon'
import type { FeedEvent } from '../../console/src/types'

afterEach(() => cleanup())

function feed(detail?: FeedEvent['detail']): FeedEvent {
  const event: FeedEvent = { time: '2026-05-12T00:00:00Z', mode: 'agent', text: 't' }
  if (detail) event.detail = detail
  return event
}

function renderSvg(event: FeedEvent): SVGSVGElement {
  const { container } = render(<FeedIcon event={event} />)
  const svgs = container.querySelectorAll('svg')
  expect(svgs).toHaveLength(1)

  const svg = svgs.item(0)
  expect(svg.tagName.toLowerCase()).toBe('svg')
  return svg
}

const routes: Array<{
  name: string
  detail?: FeedEvent['detail']
  iconClass: string
  colorClass: string
}> = [
  { name: 'missing detail fallback', iconClass: 'lucide-circle-dot', colorClass: 'text-t5' },
  { name: 'generic detail fallback', detail: { type: 'generic' }, iconClass: 'lucide-circle-dot', colorClass: 'text-t5' },
  { name: 'connection state="connected"', detail: { type: 'connection', state: 'connected' }, iconClass: 'lucide-wifi', colorClass: 'text-s-ok' },
  { name: 'connection state="disconnected"', detail: { type: 'connection', state: 'disconnected' }, iconClass: 'lucide-wifi-off', colorClass: 'text-s-crit' },
  { name: 'connection statusCode without reconnecting', detail: { type: 'connection', statusCode: 401 }, iconClass: 'lucide-wifi-off', colorClass: 'text-s-crit' },
  { name: 'connection reconnecting precedence over connecting state', detail: { type: 'connection', reconnecting: true, state: 'connecting' }, iconClass: 'lucide-plug', colorClass: 'text-s-warn' },
  { name: 'connection state="connecting"', detail: { type: 'connection', state: 'connecting' }, iconClass: 'lucide-plug', colorClass: 'text-t4' },
  { name: 'connection default with no fields', detail: { type: 'connection' }, iconClass: 'lucide-plug', colorClass: 'text-t4' },
  { name: 'message direction="inbound"', detail: { type: 'message', direction: 'inbound' }, iconClass: 'lucide-arrow-down-left', colorClass: 'text-m-cht' },
  { name: 'message direction="outbound"', detail: { type: 'message', direction: 'outbound' }, iconClass: 'lucide-arrow-up-right', colorClass: 'text-m-agt' },
  { name: 'tool_error', detail: { type: 'tool_error', toolName: 'x', error: 'e' }, iconClass: 'lucide-triangle-alert', colorClass: 'text-s-crit' },
  { name: 'tool_use', detail: { type: 'tool_use', toolName: 'x' }, iconClass: 'lucide-terminal', colorClass: 'text-m-agt' },
  { name: 'session', detail: { type: 'session', action: 'start' }, iconClass: 'lucide-terminal', colorClass: 'text-m-agt' },
  { name: 'health status="online"', detail: { type: 'health', status: 'online' }, iconClass: 'lucide-heart-pulse', colorClass: 'text-s-ok' },
  { name: 'health status="unreachable"', detail: { type: 'health', status: 'unreachable' }, iconClass: 'lucide-heart-pulse', colorClass: 'text-s-crit' },
  { name: 'health status="logged_out"', detail: { type: 'health', status: 'logged_out' }, iconClass: 'lucide-heart-pulse', colorClass: 'text-s-crit' },
  { name: 'health status="config_error"', detail: { type: 'health', status: 'config_error' }, iconClass: 'lucide-heart-pulse', colorClass: 'text-s-crit' },
  { name: 'health status="unknown"', detail: { type: 'health', status: 'unknown' }, iconClass: 'lucide-heart-pulse', colorClass: 'text-s-warn' },
  { name: 'health non-online/non-unreachable status', detail: { type: 'health', status: 'degraded' }, iconClass: 'lucide-heart-pulse', colorClass: 'text-s-warn' },
  { name: 'import', detail: { type: 'import' }, iconClass: 'lucide-database', colorClass: 'text-t4' },
]

describe('FeedIcon rendered icon and color design contract', () => {
  it.each(routes)('$name routes to $iconClass and $colorClass with shared lucide SVG attributes', ({ detail, iconClass, colorClass }) => {
    const svg = renderSvg(feed(detail))

    expect(svg.classList.contains('lucide')).toBe(true)
    expect(svg.classList.contains(iconClass)).toBe(true)
    expect(svg.classList.contains(colorClass)).toBe(true)
    expect(svg.getAttribute('width')).toBe('14')
    expect(svg.getAttribute('height')).toBe('14')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('fill')).toBe('none')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('stroke-width')).toBe('1.75')
    expect(svg.getAttribute('stroke-linecap')).toBe('round')
    expect(svg.getAttribute('stroke-linejoin')).toBe('round')
  })
})
