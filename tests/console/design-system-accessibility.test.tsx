/**
 * Design system accessibility regressions for the console.
 * Covers the Shannon-assigned a11y fixes: label association, role/img labeling,
 * interactive node buttons, and wizard dialog semantics.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Field, TextInput } from '../../console/src/components/wizard/form-primitives'
import HeartbeatStrip from '../../console/src/components/HeartbeatStrip'
import { PipelineTab } from '../../console/src/components/line-detail/PipelineTab'

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
    const source = readFileSync(resolve(__dirname, '../../console/src/components/AddLineWizard.tsx'), 'utf8')
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-modal="true"')
    expect(source).toContain('aria-labelledby="wizard-title"')
    expect(source).toContain('id="wizard-title"')
  })
})
