/**
 * LineTags — internal tag deriver coverage.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import LineTags from '../../console/src/components/LineTags'
import type { LineInstance, Mode } from '../../console/src/types'

afterEach(() => cleanup())

function line(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'line-x',
    phone: '15550000000',
    mode: 'passive' as Mode,
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

function tagLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('span'))
    .map(s => s.textContent?.trim() ?? '')
    .filter(t => t.length > 0)
}

describe('LineTags access mode', () => {
  it('renders canonical access mode tags from fleet config values', () => {
    const { container: cSelf } = render(<LineTags line={line({ accessMode: 'self_only' })} />)
    expect(tagLabels(cSelf)).toContain('self only')

    const { container: cAllow } = render(<LineTags line={line({ accessMode: 'allowlist' })} />)
    expect(tagLabels(cAllow)).toContain('allowlist')

    const { container: cOpen } = render(<LineTags line={line({ accessMode: 'open_dm' })} />)
    expect(tagLabels(cOpen)).toContain('open')

    const { container: cGroups } = render(<LineTags line={line({ accessMode: 'groups_only' })} />)
    expect(tagLabels(cGroups)).toContain('groups only')
  })

  it('renders open tag for allowAll and open_dm', () => {
    const { container: c1 } = render(<LineTags line={line({ accessMode: 'allowAll' })} />)
    expect(tagLabels(c1)).toContain('open')

    const { container: c2 } = render(<LineTags line={line({ accessMode: 'open_dm' })} />)
    expect(tagLabels(c2)).toContain('open')
  })

  it('renders allowlist tag for allowList', () => {
    const { container } = render(<LineTags line={line({ accessMode: 'allowList' })} />)
    expect(tagLabels(container)).toContain('allowlist')
  })

  it('renders deny all tag for denyAll', () => {
    const { container } = render(<LineTags line={line({ accessMode: 'denyAll' })} />)
    expect(tagLabels(container)).toContain('deny all')
  })

  it('renders nothing when access mode is unrecognized and no other tags apply', () => {
    const { container } = render(<LineTags line={line({ accessMode: 'unknownMode' })} />)
    expect(container.textContent).toBe('')
    expect(container.querySelectorAll('span').length).toBe(0)
  })

  it('applies distinct colors per access mode', () => {
    const { container: cOpen } = render(<LineTags line={line({ accessMode: 'allowAll' })} />)
    const { container: cAllow } = render(<LineTags line={line({ accessMode: 'allowList' })} />)
    const { container: cDeny } = render(<LineTags line={line({ accessMode: 'denyAll' })} />)

    const openColor = (cOpen.querySelector('span') as HTMLElement).style.color
    const allowColor = (cAllow.querySelector('span') as HTMLElement).style.color
    const denyColor = (cDeny.querySelector('span') as HTMLElement).style.color

    expect(openColor.length).toBeGreaterThan(0)
    expect(allowColor.length).toBeGreaterThan(0)
    expect(denyColor.length).toBeGreaterThan(0)
    expect(new Set([openColor, allowColor, denyColor]).size).toBe(3)
  })
})

describe('LineTags model fallback', () => {
  it('shows openai fb tag when fallback model contains gpt', () => {
    const { container } = render(
      <LineTags line={line({ accessMode: 'unknown', models: { fallback: 'gpt-4o-mini' } })} />,
    )
    expect(tagLabels(container)).toContain('openai fb')
  })

  it('shows openai fb tag when fallback model contains openai (case-insensitive)', () => {
    const { container } = render(
      <LineTags line={line({ accessMode: 'unknown', models: { fallback: 'OpenAI-Custom-Endpoint' } })} />,
    )
    expect(tagLabels(container)).toContain('openai fb')
  })

  it('does not show openai fb tag for non-openai fallback', () => {
    const { container } = render(
      <LineTags line={line({ accessMode: 'unknown', models: { fallback: 'claude-sonnet-4-5' } })} />,
    )
    expect(tagLabels(container)).not.toContain('openai fb')
    expect(container.querySelectorAll('span').length).toBe(0)
  })

  it('does not show openai fb tag when models is null or fallback is missing', () => {
    const { container: c1 } = render(<LineTags line={line({ accessMode: 'unknown', models: null })} />)
    expect(tagLabels(c1)).not.toContain('openai fb')
    expect(c1.querySelectorAll('span').length).toBe(0)

    const { container: c2 } = render(
      <LineTags line={line({ accessMode: 'unknown', models: { conversation: 'claude-sonnet-4-5' } })} />,
    )
    expect(tagLabels(c2)).not.toContain('openai fb')
    expect(c2.querySelectorAll('span').length).toBe(0)
  })
})

describe('LineTags provider mismatch', () => {
  it('shows restart needed when agent config provider differs from running provider', () => {
    const { container } = render(
      <LineTags
        line={line({
          mode: 'agent',
          accessMode: 'unknown',
          config: { agentOptions: { provider: 'anthropic' } },
          health: {
            status: 'ok',
            uptime_seconds: 60,
            messages_total: 0,
            whatsapp: { connection: { state: 'open' } },
            sqlite: { messages_total: 0, schema_version: 1 },
            instance: {
              name: 'line-x',
              mode: 'agent',
              accessMode: 'unknown',
              socketPath: null,
              provider: 'bedrock',
            },
          },
        })}
      />,
    )
    expect(tagLabels(container)).toContain('restart needed')
  })

  it('omits restart needed when providers match', () => {
    const { container } = render(
      <LineTags
        line={line({
          mode: 'agent',
          accessMode: 'unknown',
          config: { agentOptions: { provider: 'anthropic' } },
          health: {
            status: 'ok',
            uptime_seconds: 60,
            messages_total: 0,
            whatsapp: { connection: { state: 'open' } },
            sqlite: { messages_total: 0, schema_version: 1 },
            instance: {
              name: 'line-x',
              mode: 'agent',
              accessMode: 'unknown',
              socketPath: null,
              provider: 'anthropic',
            },
          },
        })}
      />,
    )
    expect(tagLabels(container)).not.toContain('restart needed')
    expect(container.querySelectorAll('span').length).toBe(0)
  })

  it('omits restart needed for non-agent modes even if providers differ', () => {
    const { container } = render(
      <LineTags
        line={line({
          mode: 'chat',
          accessMode: 'unknown',
          config: { agentOptions: { provider: 'anthropic' } },
          health: {
            status: 'ok',
            uptime_seconds: 60,
            messages_total: 0,
            whatsapp: { connection: { state: 'open' } },
            sqlite: { messages_total: 0, schema_version: 1 },
            instance: {
              name: 'line-x',
              mode: 'chat',
              accessMode: 'unknown',
              socketPath: null,
              provider: 'bedrock',
            },
          },
        })}
      />,
    )
    expect(tagLabels(container)).not.toContain('restart needed')
  })

  it('omits restart needed when configProvider is missing', () => {
    const { container } = render(
      <LineTags
        line={line({
          mode: 'agent',
          accessMode: 'unknown',
          config: {},
          health: {
            status: 'ok',
            uptime_seconds: 60,
            messages_total: 0,
            whatsapp: { connection: { state: 'open' } },
            sqlite: { messages_total: 0, schema_version: 1 },
            instance: {
              name: 'line-x',
              mode: 'agent',
              accessMode: 'unknown',
              socketPath: null,
              provider: 'bedrock',
            },
          },
        })}
      />,
    )
    expect(tagLabels(container)).not.toContain('restart needed')
  })

  it('omits restart needed when runningProvider is missing (health fetch failed or legacy)', () => {
    const { container } = render(
      <LineTags
        line={line({
          mode: 'agent',
          accessMode: 'unknown',
          config: { agentOptions: { provider: 'anthropic' } },
          health: null,
        })}
      />,
    )
    expect(tagLabels(container)).not.toContain('restart needed')
  })
})

describe('LineTags combinations and edge cases', () => {
  it('renders sandbox + access + openai + mismatch tags together for agent line', () => {
    const { container } = render(
      <LineTags
        line={line({
          mode: 'agent',
          accessMode: 'allowList',
          sandboxPerChat: true,
          models: { fallback: 'gpt-4o' },
          config: { agentOptions: { provider: 'anthropic' } },
          health: {
            status: 'ok',
            uptime_seconds: 60,
            messages_total: 0,
            whatsapp: { connection: { state: 'open' } },
            sqlite: { messages_total: 0, schema_version: 1 },
            instance: {
              name: 'line-x',
              mode: 'agent',
              accessMode: 'allowList',
              socketPath: null,
              provider: 'bedrock',
            },
          },
        })}
      />,
    )
    const labels = tagLabels(container)
    expect(labels).toContain('sandbox')
    expect(labels).toContain('allowlist')
    expect(labels).toContain('openai fb')
    expect(labels).toContain('restart needed')
    expect(labels.length).toBe(4)
  })

  it('omits sandbox tag when mode is not agent even if sandboxPerChat is true', () => {
    const { container } = render(
      <LineTags line={line({ mode: 'chat', accessMode: 'allowList', sandboxPerChat: true })} />,
    )
    const labels = tagLabels(container)
    expect(labels).not.toContain('sandbox')
    expect(labels).toContain('allowlist')
  })

  it('returns null when no tags apply', () => {
    const { container } = render(
      <LineTags line={line({ mode: 'passive', accessMode: 'unrecognized', models: null })} />,
    )
    expect(container.querySelectorAll('span').length).toBe(0)
    expect(container.querySelectorAll('div').length).toBe(0)
  })

  it('preserves declaration order: sandbox, access, openai, mismatch', () => {
    const { container } = render(
      <LineTags
        line={line({
          mode: 'agent',
          accessMode: 'denyAll',
          sandboxPerChat: true,
          models: { fallback: 'gpt-5' },
          config: { agentOptions: { provider: 'anthropic' } },
          health: {
            status: 'ok',
            uptime_seconds: 60,
            messages_total: 0,
            whatsapp: { connection: { state: 'open' } },
            sqlite: { messages_total: 0, schema_version: 1 },
            instance: {
              name: 'line-x',
              mode: 'agent',
              accessMode: 'denyAll',
              socketPath: null,
              provider: 'openai',
            },
          },
        })}
      />,
    )
    expect(tagLabels(container)).toEqual(['sandbox', 'deny all', 'openai fb', 'restart needed'])
  })
})
