/**
 * Design system accessibility regressions for the console.
 * Covers the Shannon-assigned a11y fixes: label association, role/img labeling,
 * interactive node buttons, and wizard dialog semantics.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

import { Field, TextInput } from '../../console/src/components/wizard/form-primitives'
import HeartbeatStrip from '../../console/src/components/HeartbeatStrip'
import { PipelineTab } from '../../console/src/components/line-detail/PipelineTab'
import AddLineWizard from '../../console/src/components/AddLineWizard'

vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: {
      div: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => React.createElement('div', props, children),
    },
  };
})

afterEach(() => cleanup())

describe('Field label association', () => {
  it('associates the label with its input', () => {
    render(
      createElement(
        Field as any,
        {
          label: 'Working Directory',
          children: (id: string) => createElement(TextInput as any, { id, placeholder: 'workspace' }),
        },
      ),
    )

    expect(screen.getByLabelText('Working Directory')).toBeDefined()
  })
})

describe('HeartbeatStrip accessibility', () => {
  it('exposes an accessible image label', () => {
    render(createElement(HeartbeatStrip, { beats: ['up', 'down', 'up'] }))
    expect(screen.getByRole('img', { name: 'Health: 2 of 3 heartbeats healthy' })).toBeDefined()
  })
})

describe('PipelineTab node interaction', () => {
  it('uses a button for clickable pipeline nodes', () => {
    render(
      createElement(PipelineTab as any, {
        mode: 'chat',
        modeColor: 'cht',
        line: {
          status: 'online',
          accessMode: 'allowlist',
          queueDepth: 2,
          enrichmentUnprocessed: 1,
        },
      }),
    )

    expect(screen.getByRole('button', { name: 'Inbound' })).toBeDefined()
  })
})

describe('AddLineWizard dialog semantics', () => {
  it('marks the wizard overlay as an accessible dialog', () => {
    render(createElement(AddLineWizard, { onClose: vi.fn() }))

    const dialog = screen.getByRole('dialog', { name: 'Add New Line' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('wizard-title')
    expect(screen.getByRole('heading', { name: 'Add New Line' }).id).toBe('wizard-title')
  })
})
