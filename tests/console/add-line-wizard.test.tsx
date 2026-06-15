/**
 * AddLineWizard parent-state behavior coverage.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'

const createLineMock = vi.hoisted(() => vi.fn())
const updateConfigMock = vi.hoisted(() => vi.fn())
const deleteLineMock = vi.hoisted(() => vi.fn())

vi.mock('framer-motion', async () => {
  const React = await import('react')
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: {
      div: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
        React.createElement('div', props, children),
    },
  }
})

vi.mock('../../console/src/lib/api', () => ({
  api: {
    createLine: createLineMock,
    updateConfig: updateConfigMock,
    deleteLine: deleteLineMock,
  },
}))

vi.mock('../../console/src/components/wizard/IdentityStep', () => ({
  default: ({
    data,
    onChange,
    errors,
    nameLocked,
  }: {
    data: Record<string, unknown>
    onChange: (patch: Record<string, unknown>) => void
    errors: Record<string, string>
    nameLocked?: boolean
  }) => (
    <section data-testid="identity-step">
      <div>Identity mock</div>
      <div data-testid="identity-name">{String(data.name ?? '')}</div>
      {nameLocked && <div>Name locked</div>}
      {Object.values(errors).map((error) => (
        <div className="c-error" key={error}>{error}</div>
      ))}
      <button
        type="button"
        onClick={() => onChange({ type: 'passive', name: 'passive-line', adminPhones: ['15551234567'] })}
      >
        Use valid passive identity
      </button>
      <button
        type="button"
        onClick={() => onChange({ type: 'chat', name: 'chat-line', adminPhones: ['15550001111'] })}
      >
        Use valid chat identity
      </button>
      <button
        type="button"
        onClick={() =>
          onChange({
            type: 'agent',
            name: 'agent-line',
            adminPhones: ['15550002222'],
            agentOptions: { cwd: '' },
          })
        }
      >
        Use valid agent identity
      </button>
    </section>
  ),
}))

vi.mock('../../console/src/components/wizard/LinkStep', () => ({
  default: ({
    lineName,
    onComplete,
  }: {
    lineName: string
    onComplete: () => void
  }) => (
    <section data-testid="link-step">
      <div>Link mock for {lineName}</div>
      <button type="button" onClick={onComplete}>Finish link</button>
    </section>
  ),
}))

vi.mock('../../console/src/components/wizard/ModelAuthStep', () => ({
  default: ({
    data,
    onChange,
  }: {
    data: Record<string, unknown>
    onChange: (patch: Record<string, unknown>) => void
    errors: Record<string, string>
  }) => (
    <section data-testid="model-step">
      <div>Model mock for {String(data.type ?? '')}</div>
      <button type="button" onClick={() => onChange({ authMethod: 'oauth' })}>Use OAuth</button>
    </section>
  ),
}))

vi.mock('../../console/src/components/wizard/ConfigStep', () => ({
  default: ({
    data,
    onChange,
    errors,
    onSkip,
  }: {
    data: Record<string, unknown>
    onChange: (patch: Record<string, unknown>) => void
    errors: Record<string, string>
    onSkip?: () => void
  }) => (
    <section data-testid="config-step">
      <div>Config mock for {String(data.type ?? '')}</div>
      {Object.values(errors).map((error) => (
        <div className="c-error" key={error}>{error}</div>
      ))}
      <button type="button" onClick={() => onChange({ systemPrompt: 'Respond concisely.' })}>
        Set system prompt
      </button>
      <button type="button" onClick={() => onChange({ agentOptions: { cwd: '/tmp/agent-line' } })}>
        Set cwd
      </button>
      <button type="button" onClick={onSkip}>Skip config</button>
    </section>
  ),
}))

vi.mock('../../console/src/components/wizard/ReviewStep', () => ({
  default: ({
    data,
    onEditPhase,
    onCreateLine,
    creating,
    error,
  }: {
    data: Record<string, unknown>
    onEditPhase: (phase: number) => void
    onCreateLine: () => Promise<void>
    creating: boolean
    error: string | null
  }) => (
    <section data-testid="review-step">
      <div>Review mock for {String(data.name ?? '')}</div>
      {creating && <div>Saving final config</div>}
      {error && <div className="c-error">{error}</div>}
      <button type="button" onClick={() => onEditPhase(0)}>Edit identity</button>
      <button type="button" onClick={() => onEditPhase(3)}>Edit config</button>
      <button type="button" onClick={() => void onCreateLine()}>Create line</button>
    </section>
  ),
}))

import AddLineWizard from '../../console/src/components/AddLineWizard'

beforeEach(() => {
  createLineMock.mockReset()
  updateConfigMock.mockReset()
  deleteLineMock.mockReset()
  createLineMock.mockResolvedValue({})
  updateConfigMock.mockResolvedValue({})
  deleteLineMock.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderWizard() {
  const onClose = vi.fn()
  render(<AddLineWizard onClose={onClose} />)
  return { onClose }
}

async function createPassiveLine() {
  fireEvent.click(screen.getByRole('button', { name: 'Use valid passive identity' }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByTestId('link-step')
}

async function createChatLine() {
  fireEvent.click(screen.getByRole('button', { name: 'Use valid chat identity' }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByTestId('link-step')
}

async function finishLinkAndOpenConfig() {
  fireEvent.click(screen.getByRole('button', { name: 'Finish link' }))
  expect(screen.getByTestId('model-step')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByTestId('config-step')).toBeDefined()
}

async function openReviewForChatLine() {
  await createChatLine()
  await finishLinkAndOpenConfig()
  fireEvent.click(screen.getByRole('button', { name: 'Set system prompt' }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByTestId('review-step')).toBeDefined()
}

describe('AddLineWizard validation and navigation', () => {
  it('validates identity fields before provisioning a line', () => {
    renderWizard()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(screen.getByText('Choose a line type to continue')).toBeDefined()
    expect(screen.getByText('Enter a name — at least 2 characters (letters, numbers, hyphens)')).toBeDefined()
    expect(screen.getByText('Add at least one admin phone number, then press Enter')).toBeDefined()
    expect(createLineMock).not.toHaveBeenCalled()
  })

  it('creates the instance before the link step and locks the name when editing identity later', async () => {
    renderWizard()

    await createPassiveLine()

    expect(createLineMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'passive',
      name: 'passive-line',
      adminPhones: ['15551234567'],
    }))
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Finish link' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit identity' }))

    expect(screen.getByTestId('identity-step')).toBeDefined()
    expect(screen.getByText('Name locked')).toBeDefined()
  })

  it('surfaces createLine errors and keeps the wizard on identity', async () => {
    createLineMock.mockRejectedValueOnce(new Error('line already exists'))
    renderWizard()

    fireEvent.click(screen.getByRole('button', { name: 'Use valid chat identity' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('line already exists')).toBeDefined()
    expect(screen.getByTestId('identity-step')).toBeDefined()
  })

  it('validates chat config before review and supports review edit navigation', async () => {
    renderWizard()
    await createChatLine()
    await finishLinkAndOpenConfig()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByTestId('model-step')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByTestId('config-step')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Add a system prompt — this defines how the AI responds')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Set system prompt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByTestId('review-step')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Edit config' }))
    expect(screen.getByTestId('config-step')).toBeDefined()
  })
})

describe('AddLineWizard close and persistence behavior', () => {
  it('closes immediately when untouched, but confirms dirty drafts', async () => {
    const { onClose } = renderWizard()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    cleanup()
    const second = renderWizard()
    fireEvent.click(screen.getByRole('button', { name: 'Use valid passive identity' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    const discardDialog = screen.getByRole('dialog', { name: 'Discard changes?' })
    expect(discardDialog).toBeDefined()
    fireEvent.click(within(discardDialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Close wizard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(second.onClose).toHaveBeenCalledTimes(1)
    expect(deleteLineMock).not.toHaveBeenCalled()
  })

  it('guards tab close after provisioning and deletes the created line when abandoned', async () => {
    const { onClose } = renderWizard()
    await createPassiveLine()

    const beforeUnload = new Event('beforeunload', { cancelable: true })
    expect(window.dispatchEvent(beforeUnload)).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Close wizard' }))
    expect(screen.getByRole('dialog', { name: 'Abandon new line?' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Abandon' }))

    await waitFor(() => expect(deleteLineMock).toHaveBeenCalledWith('passive-line'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still closes after a discard cleanup failure and logs the warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    deleteLineMock.mockRejectedValueOnce(new Error('delete failed'))
    const { onClose } = renderWizard()
    await createPassiveLine()

    fireEvent.click(screen.getByRole('button', { name: 'Close wizard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Abandon' }))

    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      'deleteLine failed during discard:',
      expect.any(Error),
    ))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('AddLineWizard final config save', () => {
  it('saves final config and closes from review', async () => {
    const { onClose } = renderWizard()
    await openReviewForChatLine()

    fireEvent.click(screen.getByRole('button', { name: 'Create line' }))

    await waitFor(() => expect(updateConfigMock).toHaveBeenCalledWith('chat-line', expect.objectContaining({
      name: 'chat-line',
      type: 'chat',
      systemPrompt: 'Respond concisely.',
    })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces updateConfig errors without closing', async () => {
    updateConfigMock.mockRejectedValueOnce(new Error('save failed'))
    const { onClose } = renderWizard()
    await openReviewForChatLine()

    fireEvent.click(screen.getByRole('button', { name: 'Create line' }))

    await waitFor(() => expect(screen.getAllByText('save failed').length).toBeGreaterThan(0))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('defaults an agent workspace before provisioning and final save', async () => {
    const { onClose } = renderWizard()

    fireEvent.click(screen.getByRole('button', { name: 'Use valid agent identity' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByTestId('link-step')
    await finishLinkAndOpenConfig()
    fireEvent.click(screen.getByRole('button', { name: 'Set system prompt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create line' }))

    const expectedCwd = '~/.local/share/whatsoup/instances/agent-line/workspace'
    await waitFor(() => expect(createLineMock).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: expect.objectContaining({ cwd: expectedCwd }),
    })))
    expect(updateConfigMock).toHaveBeenCalledWith('agent-line', expect.objectContaining({
      agentOptions: expect.objectContaining({ cwd: expectedCwd }),
    }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
