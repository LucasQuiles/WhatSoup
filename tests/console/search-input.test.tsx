/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SearchInput } from '../../console/src/components/shared/SearchInput'

describe('SearchInput', () => {
  it('preserves text input semantics, change handling, classes, and adornment', async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    render(
      <SearchInput
        aria-label="Search contacts"
        placeholder="Search"
        onChange={handleChange}
        endAdornment={<button type="button">Clear</button>}
        shortcutTarget
      />,
    )

    const input = screen.getByRole('textbox', { name: 'Search contacts' })
    expect(input.getAttribute('type')).toBe('text')
    expect(input.className).toContain('c-input-search')
    expect(input.getAttribute('placeholder')).toBe('Search')
    expect(input.getAttribute('data-search-shortcut-target')).toBe('true')
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()

    await user.type(input, 'abc')
    expect(handleChange).toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe('abc')
  })
})
