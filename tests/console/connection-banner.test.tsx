/**
 * Behavior tests for console/src/components/ConnectionBanner.tsx
 *
 * Covers:
 *   - renders only when disconnected (nothing when connected)
 *   - role="status" + aria-live="polite" (live region contract)
 *   - WARN channel tokens (warn ink/wash/border, never crit)
 *   - shape + text co-signal: a WifiOff icon AND copy, not color alone
 *   - per-status copy (offline vs reconnecting)
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import ConnectionBanner from '../../console/src/components/ConnectionBanner'

afterEach(() => cleanup())

describe('ConnectionBanner — visibility', () => {
  it('renders nothing when isDisconnected is false', () => {
    const { container } = render(
      <ConnectionBanner status="connected" isDisconnected={false} />,
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders the banner when isDisconnected is true', () => {
    render(<ConnectionBanner status="reconnecting" isDisconnected={true} />)
    expect(screen.getByRole('status')).not.toBeNull()
  })
})

describe('ConnectionBanner — live-region contract', () => {
  it('exposes role=status and aria-live=polite', () => {
    render(<ConnectionBanner status="offline" isDisconnected={true} />)
    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
  })
})

describe('ConnectionBanner — warn channel + co-signal', () => {
  it('uses warn-channel ink and never the crit channel', () => {
    render(<ConnectionBanner status="offline" isDisconnected={true} />)
    const region = screen.getByRole('status')
    expect(region.className).toContain('text-s-warn')
    expect(region.className).not.toContain('text-s-crit')
    // Background + border are tokenized warn surfaces.
    expect(region.style.backgroundColor).toContain('--s-warn-wash')
    expect(region.style.borderColor).toContain('--s-warn-border')
  })

  it('carries a shape co-signal: a WifiOff lucide icon alongside the copy', () => {
    const { container } = render(
      <ConnectionBanner status="offline" isDisconnected={true} />,
    )
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('class') ?? '').toMatch(/lucide-wifi-off/)
  })
})

describe('ConnectionBanner — per-status copy', () => {
  it('offline copy mentions syncing when the connection returns', () => {
    render(<ConnectionBanner status="offline" isDisconnected={true} />)
    expect(
      screen.getByText(/changes will sync when your connection returns/i),
    ).not.toBeNull()
  })

  it('reconnecting copy mentions showing the last known data', () => {
    render(<ConnectionBanner status="reconnecting" isDisconnected={true} />)
    expect(screen.getByText(/showing the last known data/i)).not.toBeNull()
  })
})
