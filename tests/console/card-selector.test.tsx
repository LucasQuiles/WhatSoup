/**
 * CardSelector — radio-style card picker behaviour and wash-color regressions.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CardSelector from '../../console/src/components/CardSelector'

afterEach(() => cleanup())

const ICON_TEST_ID = 'card-icon'

function makeOptions() {
  return [
    {
      value: 'pas',
      label: 'Passive Line',
      description: 'Manual oversight only',
      icon: <span data-testid={`${ICON_TEST_ID}-pas`}>P</span>,
      color: 'var(--color-m-pas)',
    },
    {
      value: 'agt',
      label: 'Agent Line',
      description: 'Autonomous responses',
      icon: <span data-testid={`${ICON_TEST_ID}-agt`}>A</span>,
      color: 'var(--color-m-agt)',
    },
    {
      value: 'cht',
      label: 'Chat Bot',
      description: 'Direct LLM',
      icon: <span data-testid={`${ICON_TEST_ID}-cht`}>C</span>,
      color: 'var(--color-unknown)',
    },
  ]
}

describe('CardSelector', () => {
  it('renders one button per option with label, description, and icon', () => {
    const options = makeOptions()
    render(<CardSelector options={options} selected={null} onChange={vi.fn()} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(screen.getByText('Passive Line')).toBeDefined()
    expect(screen.getByText('Manual oversight only')).toBeDefined()
    expect(screen.getByText('Agent Line')).toBeDefined()
    expect(screen.getByText('Autonomous responses')).toBeDefined()
    expect(screen.getByText('Chat Bot')).toBeDefined()
    expect(screen.getByTestId(`${ICON_TEST_ID}-pas`)).toBeDefined()
    expect(screen.getByTestId(`${ICON_TEST_ID}-agt`)).toBeDefined()
    expect(screen.getByTestId(`${ICON_TEST_ID}-cht`)).toBeDefined()
  })

  it('forwards the clicked option value to onChange', () => {
    const onChange = vi.fn()
    const options = makeOptions()
    render(<CardSelector options={options} selected={null} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: /Agent Line/ }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('agt')
  })

  it('visually distinguishes the selected option with its color border and wash background', () => {
    const options = makeOptions()
    render(<CardSelector options={options} selected="pas" onChange={vi.fn()} />)

    const buttons = screen.getAllByRole('button')
    const [pasBtn, agtBtn] = buttons
    expect(pasBtn).toBeDefined()
    expect(agtBtn).toBeDefined()
    // Selected uses the mapped wash variable and color border
    expect(pasBtn!.style.background).toBe('var(--m-pas-wash)')
    expect(pasBtn!.style.border).toContain('var(--color-m-pas)')
    // Unselected falls back to neutral surface and default border
    expect(agtBtn!.style.background).toBe('var(--color-d3)')
    expect(agtBtn!.style.border).toContain('var(--b2)')
  })

  it('falls back to the default wash for unmapped colors when selected', () => {
    const options = makeOptions()
    render(<CardSelector options={options} selected="cht" onChange={vi.fn()} />)

    const chtBtn = screen.getByRole('button', { name: /Chat Bot/ })
    expect(chtBtn.style.background).toBe('var(--color-d4)')
    expect(chtBtn.style.border).toContain('var(--color-unknown)')
  })

  it('switches selection only when onChange is wired by the parent', () => {
    const onChange = vi.fn()
    const options = makeOptions()
    const { rerender } = render(
      <CardSelector options={options} selected="pas" onChange={onChange} />,
    )

    const initialSelected = screen.getByRole('button', { name: /Passive Line/ })
    expect(initialSelected.style.background).toBe('var(--m-pas-wash)')

    fireEvent.click(screen.getByRole('button', { name: /Chat Bot/ }))
    expect(onChange).toHaveBeenCalledWith('cht')

    // Selection is controlled by the parent — until rerender, pas stays styled-selected
    expect(initialSelected.style.background).toBe('var(--m-pas-wash)')

    rerender(<CardSelector options={options} selected="cht" onChange={onChange} />)
    const newSelected = screen.getByRole('button', { name: /Chat Bot/ })
    expect(newSelected.style.background).toBe('var(--color-d4)')
  })

  it('renders nothing actionable for an empty options array', () => {
    const { container } = render(
      <CardSelector options={[]} selected={null} onChange={vi.fn()} />,
    )

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    // The flex wrapper should still exist so layout remains stable
    expect(container.firstElementChild?.tagName).toBe('DIV')
  })
})
