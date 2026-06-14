/**
 * Behavioral contract-lock for the FormControl primitive.
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
  RadioField,
  CheckboxField,
} from '../../console/src/components/primitives/FormControl'

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

    const input = screen.getByLabelText('Field') as HTMLInputElement
    const error = screen.getByText('bad value')

    expect(error).toBeDefined()
    expect(error.id).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
    expect(screen.queryByText('should be hidden')).toBeNull()
    expect(container.querySelector('.wizard-check')).toBeNull()
  })

  it('shows helper text and confirmed indicator when no error is present', () => {
    const { container } = render(
      <Field label="Field" helper="try this" confirmed>
        {id => <TextInput id={id} value="" onChange={() => {}} />}
      </Field>,
    )

    const input = screen.getByLabelText('Field') as HTMLInputElement
    const helper = screen.getByText('try this')

    expect(helper).toBeDefined()
    expect(helper.id).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(input.getAttribute('aria-describedby')).toBe(helper.id)
    expect(container.querySelector('.wizard-check')).toBeDefined()
  })

  it('merges existing control descriptions with Field helper text', () => {
    render(
      <Field label="Field" helper="try this">
        {id => <TextInput id={id} aria-describedby="external-note" value="" onChange={() => {}} />}
      </Field>,
    )

    const input = screen.getByLabelText('Field') as HTMLInputElement
    const helper = screen.getByText('try this')

    expect(input.getAttribute('aria-describedby')).toBe(`external-note ${helper.id}`)
  })

  it('marks required controls without invoking native validation', () => {
    render(
      <Field label="Field" required>
        {id => <TextInput id={id} value="" onChange={() => {}} />}
      </Field>,
    )

    const input = screen.getByLabelText('Field') as HTMLInputElement

    expect(input.getAttribute('aria-required')).toBe('true')
    expect(input.required).toBe(false)
    expect(screen.getByText('*').getAttribute('aria-hidden')).toBe('true')
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
    expectBorderColor(input, 'var(--border-subtle)')

    await user.clear(input)
    await user.type(input, 'changed')
    expect(input.value).toBe('changed')
  })

  it('uses error border before confirmed border for observable state styling', () => {
    const { rerender } = render(<TextInput aria-label="Status" value="" onChange={() => {}} error />)
    const input = screen.getByLabelText('Status') as HTMLInputElement

    expectBorderColor(input, 'var(--status-crit-fg)')

    rerender(<TextInput aria-label="Status" value="" onChange={() => {}} confirmed />)
    expectBorderColor(input, 'var(--wizard-accent)')

    rerender(<TextInput aria-label="Status" value="" onChange={() => {}} error confirmed />)
    expectBorderColor(input, 'var(--status-crit-fg)')
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

    expectBorderColor(input, 'var(--status-crit-fg)')

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

    expectBorderColor(select, 'var(--status-crit-fg)')

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

  it('supports tokenized sizing and dimmed styling for read-only inspection fields', () => {
    render(
      <TextArea
        aria-label="JSON"
        value="{}"
        onChange={() => {}}
        readOnly
        minHeight="calc(var(--sp-10) + var(--sp-5))"
        dimmed
      />,
    )

    const textarea = screen.getByLabelText('JSON') as HTMLTextAreaElement
    expect(textarea.readOnly).toBe(true)
    expect(textarea.getAttribute('style')).toContain('min-height: calc(var(--sp-10) + var(--sp-5))')
    expect(textarea.getAttribute('style')).toContain('filter: brightness(0.7)')
  })

  it('defaults minHeight and uses error and confirmed border styling', () => {
    const { rerender } = render(<TextArea aria-label="Body" value="" onChange={() => {}} error />)
    const textarea = screen.getByLabelText('Body') as HTMLTextAreaElement

    expect(textarea.getAttribute('style')).toContain('min-height: 80px')
    expectBorderColor(textarea, 'var(--status-crit-fg)')

    rerender(<TextArea aria-label="Body" value="" onChange={() => {}} confirmed />)
    expectBorderColor(textarea, 'var(--wizard-accent)')
  })

  it('supports bounded non-resizable sans textareas without a style escape hatch', () => {
    render(
      <TextArea
        aria-label="Reply"
        value=""
        onChange={() => {}}
        textFace="sans"
        minHeight={0}
        maxHeight="var(--feed-preview-max)"
        overflow="hidden"
        resize="none"
      />,
    )

    const textarea = screen.getByLabelText('Reply') as HTMLTextAreaElement
    expect(textarea.classList.contains('font-sans')).toBe(true)
    expect(textarea.classList.contains('font-mono')).toBe(false)
    expect(textarea.getAttribute('style')).toContain('min-height: 0')
    expect(textarea.getAttribute('style')).toContain('max-height: var(--feed-preview-max)')
    expect(textarea.getAttribute('style')).toContain('overflow: hidden')
    expect(textarea.getAttribute('style')).toContain('resize: none')
  })
})

// RadioField

describe('RadioField', () => {
  it('renders checked state, label text, value, and optional classes', () => {
    render(
      <RadioField
        label="API key"
        name="authMethod"
        value="api_key"
        checked
        onChange={() => {}}
        className="row-extra"
        inputClassName="accent-extra"
        labelClassName="label-extra"
      />,
    )

    const radio = screen.getByRole('radio', { name: 'API key' }) as HTMLInputElement
    const row = radio.closest('label')
    const labelText = screen.getByText('API key')

    expect(radio.checked).toBe(true)
    expect(radio.name).toBe('authMethod')
    expect(radio.value).toBe('api_key')
    expect(radio.classList.contains('accent-extra')).toBe(true)
    expect(row?.classList.contains('c-checkbox-row')).toBe(true)
    expect(row?.classList.contains('row-extra')).toBe(true)
    expect(labelText.classList.contains('label-extra')).toBe(true)
  })

  it('emits the selected value through user interaction', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    function Harness() {
      const [selected, setSelected] = useState('api_key')
      const handleChange = (next: string) => {
        onChange(next)
        setSelected(next)
      }

      return (
        <div role="radiogroup" aria-label="Auth method">
          <RadioField
            label="API key"
            name="authMethod"
            value="api_key"
            checked={selected === 'api_key'}
            onChange={handleChange}
          />
          <RadioField
            label="Existing session"
            name="authMethod"
            value="oauth"
            checked={selected === 'oauth'}
            onChange={handleChange}
          />
        </div>
      )
    }

    render(<Harness />)

    const apiKey = screen.getByRole('radio', { name: 'API key' }) as HTMLInputElement
    const oauth = screen.getByRole('radio', { name: 'Existing session' }) as HTMLInputElement
    expect(apiKey.checked).toBe(true)
    expect(oauth.checked).toBe(false)

    await user.click(oauth)
    expect(apiKey.checked).toBe(false)
    expect(oauth.checked).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith('oauth')
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

  it('supports disabled state, input class, row class, label class, and suffix content', () => {
    render(
      <CheckboxField
        label="Restart line"
        checked={false}
        disabled
        onChange={() => {}}
        className="row-extra"
        inputClassName="accent-extra"
        labelClassName="label-extra"
        suffix={<span data-testid="suffix">offline</span>}
      />,
    )

    const checkbox = screen.getByRole('checkbox', { name: 'Restart line' }) as HTMLInputElement
    const row = checkbox.closest('label')
    const labelText = screen.getByText('Restart line')

    expect(checkbox.disabled).toBe(true)
    expect(checkbox.classList.contains('accent-extra')).toBe(true)
    expect(row?.classList.contains('c-checkbox-row')).toBe(true)
    expect(row?.classList.contains('row-extra')).toBe(true)
    expect(labelText.classList.contains('label-extra')).toBe(true)
    expect(screen.getByTestId('suffix').textContent).toBe('offline')
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
