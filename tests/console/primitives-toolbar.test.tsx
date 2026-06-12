/**
 * @vitest-environment jsdom
 *
 * Primitive tests: Toolbar (toolbar.md).
 *
 * Covers (§8 test plan):
 *   - Toolbar: role="toolbar" + aria-label
 *   - ToolbarFilters: role="group" + aria-label
 *   - ToolbarTimeRange: role="group" + label; aria-pressed exactly-one-true
 *   - ToolbarTimeRange: seg button onChange is called
 *   - ToolbarSearch: accessible label; renders input[type=search]
 *   - ToolbarSpring: renders aria-hidden spring element
 *   - DOM order matches the anatomy: filters -> time-range -> spring -> search -> primary
 *   - flush variant applies soup-toolbar--flush class
 *   - Primary Button is reachable (last in DOM order)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  Toolbar,
  ToolbarFilters,
  ToolbarTimeRange,
  ToolbarSearch,
  ToolbarSpring,
} from '../../console/src/components/primitives/Toolbar';
import { Pill } from '../../console/src/components/primitives/Pill';
import { Button } from '../../console/src/components/primitives/Button';

afterEach(() => { cleanup(); });

const TIME_OPTIONS = [
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
];

// ---------------------------------------------------------------------------
// Toolbar shell
// ---------------------------------------------------------------------------

describe('Toolbar — shell', () => {
  it('renders with role="toolbar"', () => {
    render(<Toolbar aria-label="Fleet toolbar">content</Toolbar>);
    expect(screen.getByRole('toolbar')).toBeDefined();
  });

  it('aria-label is set on the toolbar', () => {
    render(<Toolbar aria-label="Fleet toolbar">content</Toolbar>);
    expect(screen.getByRole('toolbar').getAttribute('aria-label')).toBe('Fleet toolbar');
  });

  it('applies soup-toolbar class', () => {
    render(<Toolbar aria-label="test">content</Toolbar>);
    expect(document.querySelector('.soup-toolbar')).not.toBeNull();
  });

  it('flush=true applies soup-toolbar--flush class', () => {
    render(<Toolbar aria-label="test" flush>content</Toolbar>);
    const el = document.querySelector('.soup-toolbar')!;
    expect(el.classList.contains('soup-toolbar--flush')).toBe(true);
  });

  it('flush=false (default) does not apply soup-toolbar--flush class', () => {
    render(<Toolbar aria-label="test">content</Toolbar>);
    const el = document.querySelector('.soup-toolbar')!;
    expect(el.classList.contains('soup-toolbar--flush')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ToolbarFilters
// ---------------------------------------------------------------------------

describe('ToolbarFilters — group role + label', () => {
  it('renders with role="group"', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarFilters label="Mode filter">
          <Pill variant="interactive" pressed={false} onClick={() => {}}>All</Pill>
        </ToolbarFilters>
      </Toolbar>,
    );
    const group = screen.getByRole('group', { name: 'Mode filter' });
    expect(group).toBeDefined();
  });

  it('aria-label matches the label prop', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarFilters label="Status filter">
          <Pill variant="interactive" pressed={false} onClick={() => {}}>Active</Pill>
        </ToolbarFilters>
      </Toolbar>,
    );
    const group = screen.getByRole('group', { name: 'Status filter' });
    expect(group.getAttribute('aria-label')).toBe('Status filter');
  });

  it('applies soup-toolbar-filters class', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarFilters label="Filters">
          <span>child</span>
        </ToolbarFilters>
      </Toolbar>,
    );
    expect(document.querySelector('.soup-toolbar-filters')).not.toBeNull();
  });

  it('renders children (interactive pills)', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarFilters label="Mode filter">
          <Pill variant="interactive" pressed={true} onClick={() => {}}>Agent</Pill>
          <Pill variant="interactive" pressed={false} onClick={() => {}}>Passive</Pill>
        </ToolbarFilters>
      </Toolbar>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ToolbarTimeRange
// ---------------------------------------------------------------------------

describe('ToolbarTimeRange — seg control', () => {
  it('renders with role="group"', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarTimeRange label="Time range" options={TIME_OPTIONS} value="24h" onChange={() => {}} />
      </Toolbar>,
    );
    const group = screen.getByRole('group', { name: 'Time range' });
    expect(group).toBeDefined();
  });

  it('aria-label matches the label prop', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarTimeRange label="Time range" options={TIME_OPTIONS} value="7d" onChange={() => {}} />
      </Toolbar>,
    );
    expect(screen.getByRole('group', { name: 'Time range' }).getAttribute('aria-label')).toBe('Time range');
  });

  it('exactly one button has aria-pressed="true" (the selected value)', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarTimeRange label="Time range" options={TIME_OPTIONS} value="7d" onChange={() => {}} />
      </Toolbar>,
    );
    const pressedBtns = screen
      .getAllByRole('button')
      .filter((btn) => btn.getAttribute('aria-pressed') === 'true');
    expect(pressedBtns.length).toBe(1);
    expect(pressedBtns[0].textContent).toBe('7d');
  });

  it('unselected buttons have aria-pressed="false"', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarTimeRange label="Time range" options={TIME_OPTIONS} value="24h" onChange={() => {}} />
      </Toolbar>,
    );
    const unpressedBtns = screen
      .getAllByRole('button')
      .filter((btn) => btn.getAttribute('aria-pressed') === 'false');
    expect(unpressedBtns.length).toBe(2);
  });

  it('clicking an option calls onChange with the option value', () => {
    const onChange = vi.fn();
    render(
      <Toolbar aria-label="test">
        <ToolbarTimeRange label="Time range" options={TIME_OPTIONS} value="24h" onChange={onChange} />
      </Toolbar>,
    );
    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('30d');
  });

  it('seg buttons are real <button> elements', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarTimeRange label="Time range" options={TIME_OPTIONS} value="24h" onChange={() => {}} />
      </Toolbar>,
    );
    const btns = screen.getAllByRole('button');
    for (const btn of btns) {
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.getAttribute('type')).toBe('button');
    }
  });

  it('applies soup-toolbar-seg class', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarTimeRange label="Time range" options={TIME_OPTIONS} value="24h" onChange={() => {}} />
      </Toolbar>,
    );
    expect(document.querySelector('.soup-toolbar-seg')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ToolbarSearch
// ---------------------------------------------------------------------------

describe('ToolbarSearch — accessible input', () => {
  it('renders an input[type=search]', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarSearch label="Search lines" value="" onChange={() => {}} />
      </Toolbar>,
    );
    const input = screen.getByRole('searchbox');
    expect(input.tagName).toBe('INPUT');
  });

  it('aria-label matches the label prop', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarSearch label="Search lines" value="" onChange={() => {}} />
      </Toolbar>,
    );
    const input = screen.getByRole('searchbox');
    expect(input.getAttribute('aria-label')).toBe('Search lines');
  });

  it('applies soup-toolbar-search class', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarSearch label="Search" value="" onChange={() => {}} />
      </Toolbar>,
    );
    expect(document.querySelector('.soup-toolbar-search')).not.toBeNull();
  });

  it('onChange is called when input value changes', () => {
    const onChange = vi.fn();
    render(
      <Toolbar aria-label="test">
        <ToolbarSearch label="Search" value="" onChange={onChange} />
      </Toolbar>,
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('placeholder is rendered', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarSearch label="Search" value="" onChange={() => {}} placeholder="Filter by name" />
      </Toolbar>,
    );
    expect(screen.getByPlaceholderText('Filter by name')).toBeDefined();
  });

  it('label text is present in the DOM (visually hidden but accessible)', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarSearch label="Search lines" value="" onChange={() => {}} />
      </Toolbar>,
    );
    // The label element wraps the input; the label text is in a visually-hidden span.
    expect(screen.getByText('Search lines')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ToolbarSpring
// ---------------------------------------------------------------------------

describe('ToolbarSpring', () => {
  it('renders with aria-hidden="true"', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarSpring />
      </Toolbar>,
    );
    const spring = document.querySelector('.soup-toolbar-spring')!;
    expect(spring).not.toBeNull();
    expect(spring.getAttribute('aria-hidden')).toBe('true');
  });

  it('applies soup-toolbar-spring class', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarSpring />
      </Toolbar>,
    );
    expect(document.querySelector('.soup-toolbar-spring')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DOM order — anatomy: filters -> time-range -> spring -> search -> primary
// ---------------------------------------------------------------------------

describe('Toolbar — DOM order', () => {
  it('sections appear in correct anatomy order in the DOM', () => {
    render(
      <Toolbar aria-label="Fleet toolbar">
        <ToolbarFilters label="Mode filter">
          <Pill variant="interactive" pressed={false} onClick={() => {}}>All</Pill>
        </ToolbarFilters>
        <ToolbarTimeRange label="Time range" options={TIME_OPTIONS} value="24h" onChange={() => {}} />
        <ToolbarSpring />
        <ToolbarSearch label="Search lines" value="" onChange={() => {}} />
        <Button variant="primary" size="sm">Add line</Button>
      </Toolbar>,
    );

    const toolbar = screen.getByRole('toolbar');
    const children = Array.from(toolbar.children);

    // filters group is first
    expect(children[0].getAttribute('role')).toBe('group');
    expect(children[0].getAttribute('aria-label')).toBe('Mode filter');

    // time-range group is second
    expect(children[1].getAttribute('role')).toBe('group');
    expect(children[1].getAttribute('aria-label')).toBe('Time range');

    // spring is third
    expect(children[2].classList.contains('soup-toolbar-spring')).toBe(true);

    // search wrapper is fourth
    expect(children[3].querySelector('input[type="search"]')).not.toBeNull();

    // primary button is last
    const lastChild = children[children.length - 1];
    expect(lastChild.tagName).toBe('BUTTON');
  });

  it('primary Button is accessible by keyboard (reachable in DOM)', () => {
    render(
      <Toolbar aria-label="test">
        <ToolbarFilters label="Mode filter">
          <Pill variant="interactive" pressed={false} onClick={() => {}}>All</Pill>
        </ToolbarFilters>
        <ToolbarSpring />
        <ToolbarSearch label="Search" value="" onChange={() => {}} />
        <Button variant="primary" size="sm">Add line</Button>
      </Toolbar>,
    );
    // The primary button is in the DOM and has type=button
    const primaryBtn = screen.getByRole('button', { name: 'Add line' });
    expect(primaryBtn).toBeDefined();
    expect(primaryBtn.getAttribute('type')).toBe('button');
  });
});
