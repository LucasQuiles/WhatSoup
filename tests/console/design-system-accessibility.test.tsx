/**
 * Design system accessibility regressions for the console.
 * Covers the Shannon-assigned a11y fixes: label association, role/img labeling,
 * interactive node buttons, and wizard dialog semantics.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

import { Field, TextInput } from '../../console/src/components/primitives/FormControl'
import HeartbeatStrip from '../../console/src/components/HeartbeatStrip'
import { PipelineTab } from '../../console/src/components/line-detail/PipelineTab'
import AddLineWizard from '../../console/src/components/AddLineWizard'
import { ToastProvider } from '../../console/src/hooks/use-toast'

// framer-motion mock removed (B3W4): AddLineWizard no longer uses framer-motion

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
  it('dialog role wired via Modal; aria-labelledby resolves to the title element', () => {
    // AddLineWizard now uses open prop (C-B3W4-3 latched-mount contract)
    // AddLineWizard calls useToast() unconditionally, so it needs a ToastProvider ancestor.
    render(createElement(AddLineWizard, { open: true, onClose: vi.fn() }), { wrapper: ToastProvider })

    const dialog = screen.getByRole('dialog', { name: 'Add New Line' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // aria-labelledby resolves to the generated id from Modal/ModalHeader — not the literal "wizard-title"
    const labelledById = dialog.getAttribute('aria-labelledby')
    expect(labelledById).toBeTruthy()
    const titleEl = document.getElementById(labelledById!)
    expect(titleEl).toBeTruthy()
    expect(titleEl!.textContent).toBe('Add New Line')
    // ModalHeader renders a span, not a heading (consistent with every migrated dialog)
    expect(screen.queryByRole('heading', { name: 'Add New Line' })).toBeNull()
  })
})
