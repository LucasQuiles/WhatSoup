/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import TransportBadge from '../../console/src/components/TransportBadge'

afterEach(() => cleanup())

describe('TransportBadge', () => {
  it.each([
    ['baileys', undefined, 'WhatsApp·Baileys', 'soup-transport--baileys'],
    ['twilio', undefined, 'SMS·Twilio', 'soup-transport--twilio'],
    ['signal', undefined, 'Signal·signal-cli', 'soup-transport--signal'],
    ['imessage', 'bluebubbles', 'iMessage·BB', 'soup-transport--imessage'],
    ['imessage', 'imsg', 'iMessage·imsg', 'soup-transport--imessage'],
  ] as const)('renders %s provenance', (kind, backend, label, className) => {
    render(<TransportBadge kind={kind} backend={backend} />)

    const badge = screen.getByTitle(`Transport: ${label}`)
    expect(badge.textContent).toBe(label)
    expect(badge.className).toContain(className)
  })

  it('uses a visible neutral fallback for unknown transport values', () => {
    render(<TransportBadge kind="future-provider" />)

    const badge = screen.getByTitle('Transport: future-provider·unknown')
    expect(badge.className).toContain('soup-transport--unknown')
    expect(badge.textContent).toBe('future-provider·unknown')
  })
})
