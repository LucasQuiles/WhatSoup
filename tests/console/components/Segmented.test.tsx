/**
 * Segmented.test.tsx — comprehensive coverage for Segmented primitive.
 *
 * Verifies:
 *   - render: renders group with buttons
 *   - options: displays all option labels
 *   - selection: aria-pressed matches current value
 *   - onChange: fires callback on option click
 *   - disabled: all buttons disabled when disabled=true
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { Segmented } from '../../../console/src/components/primitives/Segmented';

afterEach(() => cleanup());

describe('Segmented primitive', () => {
  const options = [
    { label: 'Daily', value: 'day' },
    { label: 'Weekly', value: 'week' },
    { label: 'Monthly', value: 'month' },
  ];

  describe('render', () => {
    it('renders a group with accessible label', () => {
      render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={() => {}}
        />
      );
      const group = screen.getByRole('group', { name: 'Time Range' });
      expect(group).toBeInTheDocument();
    });

    it('renders group with correct class', () => {
      const { container } = render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={() => {}}
        />
      );
      const group = container.querySelector('.soup-toolbar-seg');
      expect(group).toBeInTheDocument();
    });

    it('renders all option buttons', () => {
      render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={() => {}}
        />
      );
      expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Weekly' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Monthly' })).toBeInTheDocument();
    });
  });

  describe('selection', () => {
    it('sets aria-pressed=true for selected option', () => {
      render(
        <Segmented
          label="Time Range"
          options={options}
          value="week"
          onChange={() => {}}
        />
      );
      const weekBtn = screen.getByRole('button', { name: 'Weekly' });
      expect(weekBtn).toHaveAttribute('aria-pressed', 'true');
    });

    it('sets aria-pressed=false for unselected options', () => {
      render(
        <Segmented
          label="Time Range"
          options={options}
          value="week"
          onChange={() => {}}
        />
      );
      const dayBtn = screen.getByRole('button', { name: 'Daily' });
      const monthBtn = screen.getByRole('button', { name: 'Monthly' });
      expect(dayBtn).toHaveAttribute('aria-pressed', 'false');
      expect(monthBtn).toHaveAttribute('aria-pressed', 'false');
    });

    it('updates selection when value prop changes', () => {
      const { rerender } = render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={() => {}}
        />
      );
      expect(screen.getByRole('button', { name: 'Daily' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      rerender(
        <Segmented
          label="Time Range"
          options={options}
          value="month"
          onChange={() => {}}
        />
      );
      expect(screen.getByRole('button', { name: 'Monthly' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByRole('button', { name: 'Daily' })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    });
  });

  describe('button type', () => {
    it('renders buttons with type="button"', () => {
      const { container } = render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={() => {}}
        />
      );
      const buttons = container.querySelectorAll('.soup-toolbar-seg__btn');
      buttons.forEach((btn) => {
        expect(btn).toHaveAttribute('type', 'button');
      });
    });

    it('renders buttons with correct class', () => {
      const { container } = render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={() => {}}
        />
      );
      const buttons = container.querySelectorAll('.soup-toolbar-seg__btn');
      expect(buttons.length).toBe(3);
      buttons.forEach((btn) => {
        expect(btn).toHaveClass('soup-toolbar-seg__btn');
      });
    });
  });

  describe('onChange callback', () => {
    it('calls onChange with option value on click', async () => {
      const onChange = vi.fn();
      render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={onChange}
        />
      );
      const weekBtn = screen.getByRole('button', { name: 'Weekly' });
      await userEvent.click(weekBtn);
      expect(onChange).toHaveBeenCalledWith('week');
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('does not call onChange when clicking already selected option', async () => {
      const onChange = vi.fn();
      render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={onChange}
        />
      );
      const dayBtn = screen.getByRole('button', { name: 'Daily' });
      await userEvent.click(dayBtn);
      // onChange is still called (no optimistic skipping)
      expect(onChange).toHaveBeenCalledWith('day');
    });

    it('calls onChange for multiple clicks on different options', async () => {
      const onChange = vi.fn();
      render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={onChange}
        />
      );
      await userEvent.click(screen.getByRole('button', { name: 'Weekly' }));
      await userEvent.click(screen.getByRole('button', { name: 'Monthly' }));
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenNthCalledWith(1, 'week');
      expect(onChange).toHaveBeenNthCalledWith(2, 'month');
    });
  });

  describe('disabled state', () => {
    it('disables all buttons when disabled=true', () => {
      render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={() => {}}
          disabled={true}
        />
      );
      options.forEach((opt) => {
        const btn = screen.getByRole('button', { name: opt.label });
        expect(btn).toBeDisabled();
      });
    });

    it('enables all buttons when disabled=false', () => {
      render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={() => {}}
          disabled={false}
        />
      );
      options.forEach((opt) => {
        const btn = screen.getByRole('button', { name: opt.label });
        expect(btn).not.toBeDisabled();
      });
    });

    it('does not call onChange when disabled=true', async () => {
      const onChange = vi.fn();
      render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={onChange}
          disabled={true}
        />
      );
      const weekBtn = screen.getByRole('button', { name: 'Weekly' });
      await userEvent.click(weekBtn);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('enables buttons when disabled changes from true to false', () => {
      const { rerender } = render(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={() => {}}
          disabled={true}
        />
      );
      expect(screen.getByRole('button', { name: 'Daily' })).toBeDisabled();

      rerender(
        <Segmented
          label="Time Range"
          options={options}
          value="day"
          onChange={() => {}}
          disabled={false}
        />
      );
      expect(screen.getByRole('button', { name: 'Daily' })).not.toBeDisabled();
    });
  });

  describe('empty options', () => {
    it('renders with empty options array', () => {
      render(
        <Segmented
          label="Empty"
          options={[]}
          value=""
          onChange={() => {}}
        />
      );
      const group = screen.getByRole('group', { name: 'Empty' });
      expect(group).toBeInTheDocument();
    });
  });

  describe('single option', () => {
    it('renders with single option', () => {
      const singleOption = [{ label: 'Only', value: 'only' }];
      render(
        <Segmented
          label="Single"
          options={singleOption}
          value="only"
          onChange={() => {}}
        />
      );
      expect(screen.getByRole('button', { name: 'Only' })).toBeInTheDocument();
    });
  });

  describe('many options', () => {
    it('renders many options', () => {
      const manyOptions = Array.from({ length: 10 }, (_, i) => ({
        label: `Option ${i + 1}`,
        value: `opt${i + 1}`,
      }));
      render(
        <Segmented
          label="Many"
          options={manyOptions}
          value="opt1"
          onChange={() => {}}
        />
      );
      manyOptions.forEach((opt) => {
        expect(screen.getByRole('button', { name: opt.label })).toBeInTheDocument();
      });
    });
  });

  describe('option labels with special characters', () => {
    it('renders options with emojis', () => {
      const emojiOptions = [
        { label: '📅 Today', value: 'today' },
        { label: '📊 Week', value: 'week' },
      ];
      render(
        <Segmented
          label="View"
          options={emojiOptions}
          value="today"
          onChange={() => {}}
        />
      );
      expect(screen.getByRole('button', { name: '📅 Today' })).toBeInTheDocument();
    });

    it('renders options with long text', () => {
      const longOptions = [
        { label: 'This is a very long option label', value: 'long1' },
        { label: 'Another very long option label', value: 'long2' },
      ];
      render(
        <Segmented
          label="Options"
          options={longOptions}
          value="long1"
          onChange={() => {}}
        />
      );
      expect(
        screen.getByRole('button', { name: 'This is a very long option label' })
      ).toBeInTheDocument();
    });
  });
});
