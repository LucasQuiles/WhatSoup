/**
 * CardSelector — radiogroup semantics, roving tabindex, arrow-key selection,
 * and wash-color regressions.
 *
 * Change justification:
 * - DD-14 (WAI radiogroup pattern): elements are now role="radio" not role="button".
 *   All existing queries updated from getAllByRole('button') to getAllByRole('radio').
 * - Arrow keys move AND select (WAI radio: selection follows focus) — new cases.
 * - roving tabindex: checked=0, others=-1; when none checked, first is 0 — new cases.
 * - aria-checked reflects selected state — new asserts added to style cases.
 * - radiogroup/aria-label contract — new case.
 * - Space selects the focused option — new case.
 * - Wrap-around navigation (end→first, first→end) — new cases.
 * - Visual styling logic (background/border) unchanged; style asserts preserved.
 *
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

// ---------------------------------------------------------------------------
// Rendering and roles
// ---------------------------------------------------------------------------

describe('CardSelector rendering', () => {
  it('renders a radiogroup with the provided accessible label', () => {
    render(<CardSelector label="Card type" options={makeOptions()} selected={null} onChange={vi.fn()} />)
    const group = screen.getByRole('radiogroup', { name: 'Card type' })
    expect(group.getAttribute('aria-label')).toBe('Card type')
  })

  it('forwards validation aria attributes to the radiogroup', () => {
    render(
      <>
        <CardSelector
          label="Card type"
          options={makeOptions()}
          selected={null}
          onChange={vi.fn()}
          aria-invalid
          aria-describedby="card-type-error"
        />
        <div id="card-type-error">Card type is required</div>
      </>,
    )

    const group = screen.getByRole('radiogroup', { name: 'Card type' })
    expect(group.getAttribute('aria-invalid')).toBe('true')
    expect(group.getAttribute('aria-describedby')).toBe('card-type-error')
  })

  it('renders one radio per option with label, description, and icon', () => {
    render(<CardSelector label="Card type" options={makeOptions()} selected={null} onChange={vi.fn()} />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(screen.getByText('Passive Line')).toBeDefined()
    expect(screen.getByText('Manual oversight only')).toBeDefined()
    expect(screen.getByText('Agent Line')).toBeDefined()
    expect(screen.getByText('Autonomous responses')).toBeDefined()
    expect(screen.getByText('Chat Bot')).toBeDefined()
    expect(screen.getByTestId(`${ICON_TEST_ID}-pas`)).toBeDefined()
    expect(screen.getByTestId(`${ICON_TEST_ID}-agt`)).toBeDefined()
    expect(screen.getByTestId(`${ICON_TEST_ID}-cht`)).toBeDefined()
  })

  it('renders nothing actionable for an empty options array', () => {
    const { container } = render(
      <CardSelector label="Empty" options={[]} selected={null} onChange={vi.fn()} />,
    )
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    // The radiogroup wrapper should still exist so layout remains stable
    expect(container.firstElementChild?.getAttribute('role')).toBe('radiogroup')
  })
})

// ---------------------------------------------------------------------------
// aria-checked state
// ---------------------------------------------------------------------------

describe('aria-checked', () => {
  it('marks the selected option aria-checked=true and others aria-checked=false', () => {
    render(<CardSelector label="Card type" options={makeOptions()} selected="pas" onChange={vi.fn()} />)
    const radios = screen.getAllByRole('radio')
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true')
    expect(radios[1]?.getAttribute('aria-checked')).toBe('false')
    expect(radios[2]?.getAttribute('aria-checked')).toBe('false')
  })

  it('marks all radios aria-checked=false when selected is null', () => {
    render(<CardSelector label="Card type" options={makeOptions()} selected={null} onChange={vi.fn()} />)
    const radios = screen.getAllByRole('radio')
    radios.forEach(r => expect(r.getAttribute('aria-checked')).toBe('false'))
  })
})

// ---------------------------------------------------------------------------
// Click selection
// ---------------------------------------------------------------------------

describe('click selection', () => {
  it('forwards the clicked option value to onChange', () => {
    const onChange = vi.fn()
    render(<CardSelector label="Card type" options={makeOptions()} selected={null} onChange={onChange} />)

    fireEvent.click(screen.getByRole('radio', { name: /Agent Line/ }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('agt')
  })

  it('switches selection only when onChange is wired by the parent (controlled)', () => {
    const onChange = vi.fn()
    const options = makeOptions()
    const { rerender } = render(
      <CardSelector label="Card type" options={options} selected="pas" onChange={onChange} />,
    )

    const initialSelected = screen.getByRole('radio', { name: /Passive Line/ })
    expect(initialSelected.style.background).toBe('var(--m-pas-wash)')

    fireEvent.click(screen.getByRole('radio', { name: /Chat Bot/ }))
    expect(onChange).toHaveBeenCalledWith('cht')

    // Selection is controlled by the parent — until rerender, pas stays styled-selected
    expect(initialSelected.style.background).toBe('var(--m-pas-wash)')

    rerender(<CardSelector label="Card type" options={options} selected="cht" onChange={onChange} />)
    const newSelected = screen.getByRole('radio', { name: /Chat Bot/ })
    expect(newSelected.style.background).toBe('var(--btn-neutral-bg)')
  })

  it('keeps a disabled selector inert for click and keyboard activation', () => {
    const onChange = vi.fn()
    render(
      <CardSelector
        label="Card type"
        options={makeOptions()}
        selected="pas"
        onChange={onChange}
        disabled
      />,
    )
    const group = screen.getByRole('radiogroup')
    const radios = screen.getAllByRole('radio')

    expect(group.getAttribute('aria-disabled')).toBe('true')
    radios.forEach((radio) => {
      expect(radio.getAttribute('aria-disabled')).toBe('true')
      expect(radio.tabIndex).toBe(-1)
    })
    fireEvent.click(radios[1]!)
    radios[0]!.focus()
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    fireEvent.keyDown(group, { key: ' ' })
    expect(onChange).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Visual styling (regression: wash/border unchanged by the semantic addition)
// ---------------------------------------------------------------------------

describe('visual styling', () => {
  it('visually distinguishes the selected option with its color border and wash background', () => {
    render(<CardSelector label="Card type" options={makeOptions()} selected="pas" onChange={vi.fn()} />)

    const radios = screen.getAllByRole('radio')
    const [pasCard, agtCard] = radios
    // Selected uses the mapped wash variable and color border
    expect(pasCard!.style.background).toBe('var(--m-pas-wash)')
    expect(pasCard!.style.border).toContain('var(--color-m-pas)')
    // Unselected falls back to neutral surface and default border
    expect(agtCard!.style.background).toBe('var(--surface-raised)')
    expect(agtCard!.style.border).toContain('var(--border-subtle)')
  })

  it('falls back to the default wash for unmapped colors when selected', () => {
    render(<CardSelector label="Card type" options={makeOptions()} selected="cht" onChange={vi.fn()} />)

    const chtCard = screen.getByRole('radio', { name: /Chat Bot/ })
    expect(chtCard.style.background).toBe('var(--btn-neutral-bg)')
    expect(chtCard.style.border).toContain('var(--color-unknown)')
  })
})

// ---------------------------------------------------------------------------
// Roving tabindex
// ---------------------------------------------------------------------------

describe('roving tabindex', () => {
  it('gives tabIndex=0 to the selected option and -1 to others', () => {
    render(<CardSelector label="Card type" options={makeOptions()} selected="agt" onChange={vi.fn()} />)
    const radios = screen.getAllByRole('radio')
    expect(radios[0]?.tabIndex).toBe(-1) // pas — not selected
    expect(radios[1]?.tabIndex).toBe(0)  // agt — selected
    expect(radios[2]?.tabIndex).toBe(-1) // cht — not selected
  })

  it('gives tabIndex=0 to the first option when nothing is selected', () => {
    render(<CardSelector label="Card type" options={makeOptions()} selected={null} onChange={vi.fn()} />)
    const radios = screen.getAllByRole('radio')
    expect(radios[0]?.tabIndex).toBe(0)  // first — tabbable fallback
    expect(radios[1]?.tabIndex).toBe(-1)
    expect(radios[2]?.tabIndex).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// Arrow-key navigation (WAI radiogroup: selection follows focus)
// ---------------------------------------------------------------------------

describe('arrow-key navigation', () => {
  it('ArrowRight moves focus and selects the next option', () => {
    const onChange = vi.fn()
    render(<CardSelector label="Card type" options={makeOptions()} selected="pas" onChange={onChange} />)
    const group = screen.getByRole('radiogroup')
    const radios = screen.getAllByRole('radio')

    radios[0]!.focus()
    fireEvent.keyDown(group, { key: 'ArrowRight' })

    expect(onChange).toHaveBeenCalledWith('agt')
  })

  it('ArrowDown moves focus and selects the next option', () => {
    const onChange = vi.fn()
    render(<CardSelector label="Card type" options={makeOptions()} selected="pas" onChange={onChange} />)
    const group = screen.getByRole('radiogroup')
    const radios = screen.getAllByRole('radio')

    radios[0]!.focus()
    fireEvent.keyDown(group, { key: 'ArrowDown' })

    expect(onChange).toHaveBeenCalledWith('agt')
  })

  it('ArrowLeft moves focus and selects the previous option', () => {
    const onChange = vi.fn()
    render(<CardSelector label="Card type" options={makeOptions()} selected="agt" onChange={onChange} />)
    const group = screen.getByRole('radiogroup')
    const radios = screen.getAllByRole('radio')

    radios[1]!.focus()
    fireEvent.keyDown(group, { key: 'ArrowLeft' })

    expect(onChange).toHaveBeenCalledWith('pas')
  })

  it('ArrowUp moves focus and selects the previous option', () => {
    const onChange = vi.fn()
    render(<CardSelector label="Card type" options={makeOptions()} selected="agt" onChange={onChange} />)
    const group = screen.getByRole('radiogroup')
    const radios = screen.getAllByRole('radio')

    radios[1]!.focus()
    fireEvent.keyDown(group, { key: 'ArrowUp' })

    expect(onChange).toHaveBeenCalledWith('pas')
  })

  it('ArrowRight wraps from last to first', () => {
    const onChange = vi.fn()
    render(<CardSelector label="Card type" options={makeOptions()} selected="cht" onChange={onChange} />)
    const group = screen.getByRole('radiogroup')
    const radios = screen.getAllByRole('radio')

    radios[2]!.focus()
    fireEvent.keyDown(group, { key: 'ArrowRight' })

    expect(onChange).toHaveBeenCalledWith('pas')
  })

  it('ArrowLeft wraps from first to last', () => {
    const onChange = vi.fn()
    render(<CardSelector label="Card type" options={makeOptions()} selected="pas" onChange={onChange} />)
    const group = screen.getByRole('radiogroup')
    const radios = screen.getAllByRole('radio')

    radios[0]!.focus()
    fireEvent.keyDown(group, { key: 'ArrowLeft' })

    expect(onChange).toHaveBeenCalledWith('cht')
  })
})

// ---------------------------------------------------------------------------
// Space key selects focused option
// ---------------------------------------------------------------------------

describe('Space key', () => {
  it('selects the currently focused option via Space', () => {
    const onChange = vi.fn()
    render(<CardSelector label="Card type" options={makeOptions()} selected="pas" onChange={onChange} />)
    const group = screen.getByRole('radiogroup')
    const radios = screen.getAllByRole('radio')

    radios[1]!.focus()
    fireEvent.keyDown(group, { key: ' ' })

    expect(onChange).toHaveBeenCalledWith('agt')
  })

  it('does not call onChange when Space is pressed with no focused option', () => {
    const onChange = vi.fn()
    render(<CardSelector label="Card type" options={makeOptions()} selected="pas" onChange={onChange} />)
    const group = screen.getByRole('radiogroup')

    // Dispatch Space without first focusing a radio (focusedIndex will be -1)
    fireEvent.keyDown(group, { key: ' ' })

    expect(onChange).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Unrecognised keys are not intercepted
// ---------------------------------------------------------------------------

describe('unrelated keys', () => {
  it('does not call onChange for non-navigation keys (e.g. Tab)', () => {
    const onChange = vi.fn()
    render(<CardSelector label="Card type" options={makeOptions()} selected="pas" onChange={onChange} />)
    const group = screen.getByRole('radiogroup')

    fireEvent.keyDown(group, { key: 'Tab' })
    fireEvent.keyDown(group, { key: 'Enter' })

    expect(onChange).not.toHaveBeenCalled()
  })
})
