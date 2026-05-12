/**
 * Behavioral contract-lock for wizard form-primitives.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

import {
  Field,
  TextInput,
  NumberInput,
  SelectInput,
  TextArea,
  CheckboxField,
} from '../../console/src/components/wizard/form-primitives'

afterEach(() => cleanup())

function expectBorderColor(element: HTMLElement, color: string): void {
  expect(element.getAttribute('style')).toContain(`border-color: ${color}`)
}

// Field

describe('Field', () => {
  it('associates its label with the rendered control', () => {
    render(
      <Field label="Name">
        {id => <TextInput id={id} value="Ada" onChange={() => {}} />}
      </Field>,
    )

    const input = screen.getByLabelText('Name') as HTMLInputElement
    const label = screen.getByText('Name') as HTMLLabelElement

    expect(input.value).toBe('Ada')
    expect(input.id).toBeTruthy()
    expect(label.htmlFor).toBe(input.id)
  })

  it('shows errors instead of helper text and confirmed indicator', () => {
    const { container } = render(
      <Field label="Field" error="bad value" helper="should be hidden" confirmed>
        {id => <TextInput id={id} value="" onChange={() => {}} />}
      </Field>,
    )

    expect(screen.getByText('bad value')).toBeDefined()
    expect(screen.queryByText('should be hidden')).toBeNull()
    expect(container.querySelector('.wizard-check')).toBeNull()
  })

  it('shows helper text and confirmed indicator when no error is present', () => {
    const { container } = render(
      <Field label="Field" helper="try this" confirmed>
        {id => <TextInput id={id} value="" onChange={() => {}} />}
      </Field>,
    )

    expect(screen.getByText('try this')).toBeDefined()
    expect(container.querySelector('.wizard-check')).toBeDefined()
  })
})

// TextInput

describe('TextInput', () => {
  it('renders attributes and updates observable text state through DOM input', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [value, setValue] = useState('hello')
      return (
        <TextInput
          aria-label="Greeting"
          value={value}
          placeholder="enter"
          className="extra-cls"
          onChange={event => setValue(event.target.value)}
        />
      )
    }

    render(<Harness />)

    const input = screen.getByLabelText('Greeting') as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    expect(input.value).toBe('hello')
    expect(input.placeholder).toBe('enter')
    expect(input.classList.contains('c-input')).toBe(true)
    expect(input.classList.contains('font-mono')).toBe(true)
    expect(input.classList.contains('extra-cls')).toBe(true)
    expectBorderColor(input, 'var(--b2)')

    await user.clear(input)
    await user.type(input, 'changed')
    expect(input.value).toBe('changed')
  })

  it('uses error border before confirmed border for observable state styling', () => {
    const { rerender } = render(<TextInput aria-label="Status" value="" onChange={() => {}} error />)
    const input = screen.getByLabelText('Status') as HTMLInputElement

    expectBorderColor(input, 'var(--color-s-crit)')

    rerender(<TextInput aria-label="Status" value="" onChange={() => {}} confirmed />)
    expectBorderColor(input, 'var(--wizard-accent)')

    rerender(<TextInput aria-label="Status" value="" onChange={() => {}} error confirmed />)
    expectBorderColor(input, 'var(--color-s-crit)')
  })
})

// NumberInput

describe('NumberInput', () => {
  it('renders number attributes and updates observable numeric state through DOM input', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [value, setValue] = useState(5)
      return (
        <NumberInput
          aria-label="Retries"
          value={value}
          min={0}
          max={10}
          step={1}
          className="num-extra"
          onChange={event => setValue(Number(event.target.value))}
        />
      )
    }

    render(<Harness />)

    const input = screen.getByLabelText('Retries') as HTMLInputElement
    expect(input.type).toBe('number')
    expect(input.value).toBe('5')
    expect(input.min).toBe('0')
    expect(input.max).toBe('10')
    expect(input.step).toBe('1')
    expect(input.classList.contains('c-input')).toBe(true)
    expect(input.classList.contains('c-input-number')).toBe(true)
    expect(input.classList.contains('font-mono')).toBe(true)
    expect(input.classList.contains('num-extra')).toBe(true)

    await user.clear(input)
    await user.type(input, '7')
    expect(input.value).toBe('7')
  })

  it('uses error and confirmed border styling', () => {
    const { rerender } = render(<NumberInput aria-label="Amount" value={1} onChange={() => {}} error />)
    const input = screen.getByLabelText('Amount') as HTMLInputElement

    expectBorderColor(input, 'var(--color-s-crit)')

    rerender(<NumberInput aria-label="Amount" value={1} onChange={() => {}} confirmed />)
    expectBorderColor(input, 'var(--wizard-accent)')
  })
})

// SelectInput

describe('SelectInput', () => {
  it('renders options and updates observable selection through DOM input', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [value, setValue] = useState('b')
      return (
        <SelectInput
          aria-label="Mode"
          value={value}
          className="sel-extra"
          onChange={event => setValue(event.target.value)}
        >
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </SelectInput>
      )
    }

    render(<Harness />)

    const select = screen.getByLabelText('Mode') as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.value).toBe('b')
    expect(screen.getByRole('option', { name: 'Alpha' })).toBeDefined()
    expect(screen.getByRole('option', { name: 'Beta' })).toBeDefined()
    expect(select.classList.contains('c-input')).toBe(true)
    expect(select.classList.contains('c-select')).toBe(true)
    expect(select.classList.contains('sel-extra')).toBe(true)

    await user.selectOptions(select, 'a')
    expect(select.value).toBe('a')
  })

  it('uses error and confirmed border styling', () => {
    const { rerender } = render(
      <SelectInput aria-label="Mode" value="" onChange={() => {}} error>
        <option value="">Choose</option>
      </SelectInput>,
    )
    const select = screen.getByLabelText('Mode') as HTMLSelectElement

    expectBorderColor(select, 'var(--color-s-crit)')

    rerender(
      <SelectInput aria-label="Mode" value="" onChange={() => {}} confirmed>
        <option value="">Choose</option>
      </SelectInput>,
    )
    expectBorderColor(select, 'var(--wizard-accent)')
  })
})

// TextArea

describe('TextArea', () => {
  it('renders attributes and updates observable text state through DOM input', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [value, setValue] = useState('body')
      return (
        <TextArea
          aria-label="Body"
          value={value}
          rows={4}
          minHeight={200}
          className="ta-extra"
          onChange={event => setValue(event.target.value)}
        />
      )
    }

    render(<Harness />)

    const textarea = screen.getByLabelText('Body') as HTMLTextAreaElement
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea.value).toBe('body')
    expect(textarea.rows).toBe(4)
    expect(textarea.classList.contains('c-input')).toBe(true)
    expect(textarea.classList.contains('font-mono')).toBe(true)
    expect(textarea.classList.contains('ta-extra')).toBe(true)
    expect(textarea.getAttribute('style')).toContain('min-height: 200px')
    expect(textarea.getAttribute('style')).toContain('resize: vertical')

    await user.clear(textarea)
    await user.type(textarea, 'updated')
    expect(textarea.value).toBe('updated')
  })

  it('defaults minHeight and uses error and confirmed border styling', () => {
    const { rerender } = render(<TextArea aria-label="Body" value="" onChange={() => {}} error />)
    const textarea = screen.getByLabelText('Body') as HTMLTextAreaElement

    expect(textarea.getAttribute('style')).toContain('min-height: 80px')
    expectBorderColor(textarea, 'var(--color-s-crit)')

    rerender(<TextArea aria-label="Body" value="" onChange={() => {}} confirmed />)
    expectBorderColor(textarea, 'var(--wizard-accent)')
  })
})

// CheckboxField

describe('CheckboxField', () => {
  it('renders checked state, label text, and helper text', () => {
    render(
      <CheckboxField
        label="Enable feature"
        checked
        helper="Only applies to new messages"
        onChange={() => {}}
      />,
    )

    const checkbox = screen.getByRole('checkbox', { name: 'Enable feature' }) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    expect(screen.getByText('Only applies to new messages')).toBeDefined()
  })

  it('omits helper text when helper is not provided', () => {
    render(<CheckboxField label="Enable feature" checked={false} onChange={() => {}} />)

    expect(screen.getByRole('checkbox', { name: 'Enable feature' })).toBeDefined()
    expect(screen.queryByText('Only applies to new messages')).toBeNull()
  })

  it('changes checked state through user interaction', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    function Harness() {
      const [checked, setChecked] = useState(false)
      return (
        <CheckboxField
          label="Enable feature"
          checked={checked}
          onChange={next => {
            onChange(next)
            setChecked(next)
          }}
        />
      )
    }

    render(<Harness />)

    const checkbox = screen.getByRole('checkbox', { name: 'Enable feature' }) as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    await user.click(checkbox)
    expect(checkbox.checked).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith(true)

    await user.click(checkbox)
    expect(checkbox.checked).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith(false)
  })
})
