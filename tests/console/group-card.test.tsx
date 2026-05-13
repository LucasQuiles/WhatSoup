/**
 * GroupCard — behavior coverage for the line-detail group row.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GroupCard } from '../../console/src/components/line-detail/GroupCard'
import type { GroupInfo, GroupParticipant } from '../../console/src/types'

afterEach(() => cleanup())

function group(overrides: Partial<GroupInfo> = {}): GroupInfo {
  const participants: GroupParticipant[] = [
    { id: '15551234567@s.whatsapp.net' },
    { id: '15557654321@s.whatsapp.net' },
  ]
  return {
    id: 'group-1@g.us',
    subject: 'Project Alpha',
    participants,
    ...overrides,
  }
}

describe('GroupCard', () => {
  it('renders the subject and 2-letter avatar initials', () => {
    render(<GroupCard group={group()} onSelect={() => {}} />)

    expect(screen.getByText('Project Alpha')).toBeDefined()
    expect(screen.getByText('PA')).toBeDefined()
  })

  it('renders participant count with plural noun when count !== 1', () => {
    render(<GroupCard group={group()} onSelect={() => {}} />)

    expect(screen.getByText(/2 participants/)).toBeDefined()
  })

  it('renders singular participant noun when count === 1', () => {
    const g = group({ participants: [{ id: '15551234567@s.whatsapp.net' }] })
    render(<GroupCard group={g} onSelect={() => {}} />)

    expect(screen.getByText(/1 participant(?!s)/)).toBeDefined()
    expect(screen.queryByText(/1 participants/)).toBeNull()
  })

  it('omits the role badge when myJid is not provided', () => {
    const { container } = render(<GroupCard group={group()} onSelect={() => {}} />)

    expect(screen.queryByText('Admin')).toBeNull()
    expect(screen.queryByText('Owner')).toBeNull()
    // Only the Users icon should render (no Shield icon for badge)
    expect(container.querySelectorAll('svg').length).toBe(1)
  })

  it('renders the Admin badge when myJid matches an admin participant by full JID', () => {
    const g = group({
      participants: [
        { id: '15551234567@s.whatsapp.net', admin: 'admin' },
        { id: '15557654321@s.whatsapp.net' },
      ],
    })
    const { container } = render(
      <GroupCard group={g} onSelect={() => {}} myJid="15551234567@s.whatsapp.net" />,
    )

    expect(screen.getByText('Admin')).toBeDefined()
    expect(container.querySelectorAll('svg').length).toBe(2)
  })

  it('renders the Owner badge when myJid matches a superadmin via phone-prefix on a @lid variant', () => {
    const g = group({
      participants: [
        { id: '15551234567@lid', admin: 'superadmin' },
      ],
    })
    render(
      <GroupCard group={g} onSelect={() => {}} myJid="15551234567@s.whatsapp.net" />,
    )

    expect(screen.getByText('Owner')).toBeDefined()
  })

  it('omits the role badge when the matched participant has no admin role', () => {
    render(
      <GroupCard
        group={group()}
        onSelect={() => {}}
        myJid="15551234567@s.whatsapp.net"
      />,
    )

    expect(screen.queryByText('Admin')).toBeNull()
    expect(screen.queryByText('Owner')).toBeNull()
    expect(screen.queryByText('Member')).toBeNull()
  })

  it('appends a short description verbatim and truncates long descriptions to 77 chars + ellipsis', () => {
    const shortDesc = 'A brief description'
    const longDesc = 'x'.repeat(200)

    const { unmount } = render(
      <GroupCard group={group({ desc: shortDesc })} onSelect={() => {}} />,
    )
    expect(screen.getByText(new RegExp(`· ${shortDesc}$`))).toBeDefined()
    unmount()

    render(<GroupCard group={group({ desc: longDesc })} onSelect={() => {}} />)
    const truncated = 'x'.repeat(77) + '...'
    expect(screen.getByText(new RegExp(`· ${truncated}$`))).toBeDefined()
  })

  it('renders without a description segment when desc is missing or empty', () => {
    render(<GroupCard group={group({ desc: '' })} onSelect={() => {}} />)

    expect(screen.queryByText(/·/)).toBeNull()
  })

  it('invokes onSelect with the full group object when clicked', () => {
    const onSelect = vi.fn()
    const g = group()
    render(<GroupCard group={g} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button'))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(g)
  })

  it('renders the host as a type="button" so it does not submit ambient forms', () => {
    render(<GroupCard group={group()} onSelect={() => {}} />)
    const btn = screen.getByRole('button')

    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('renders an empty initials node when the subject is blank without crashing', () => {
    const { container } = render(
      <GroupCard group={group({ subject: '' })} onSelect={() => {}} />,
    )

    expect(container.querySelector('button')).toBeDefined()
    // Avatar initials node still renders but with empty text content
    expect(screen.queryByText('PA')).toBeNull()
  })
})
