/**
 * Button.test.tsx — comprehensive coverage for the Button primitive.
 *
 * Verifies:
 *   - render: renders a button element
 *   - variants: primary | neutral | ghost | danger | success | warning
 *   - sizes: md (32px) | sm (28px) | xs (24px)
 *   - icon placement: icon (start) | iconEnd | loading state replaces icon
 *   - loading state: aria-busy, button inert, spinner visible
 *   - disabled state: aria-disabled, cursor not-allowed
 *   - click handling: onClick callback fires
 *   - children: renders text children
 *   - className composition: custom classes merge correctly
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { Button } from '../../../console/src/components/primitives/Button';

afterEach(() => cleanup());

describe('Button primitive', () => {
  describe('render', () => {
    it('renders a button element', () => {
      render(<Button>Click me</Button>);
      const button = screen.getByRole('button', { name: 'Click me' });
      expect(button).toBeInTheDocument();
      expect(button.tagName).toBe('BUTTON');
    });

    it('renders with default type="button"', () => {
      render(<Button>Submit</Button>);
      const button = screen.getByRole('button', { name: 'Submit' });
      expect(button).toHaveAttribute('type', 'button');
    });

    it('respects explicit type attribute', () => {
      render(<Button type="submit">Submit</Button>);
      const button = screen.getByRole('button', { name: 'Submit' });
      expect(button).toHaveAttribute('type', 'submit');
    });

    it('renders icon-only with aria-label', () => {
      render(<Button aria-label="Settings">⚙️</Button>);
      const button = screen.getByRole('button', { name: 'Settings' });
      expect(button).toBeInTheDocument();
    });
  });

  describe('variants', () => {
    const variants = ['primary', 'neutral', 'ghost', 'danger', 'success', 'warning'] as const;

    variants.forEach((variant) => {
      it(`applies ${variant} variant class`, () => {
        render(<Button variant={variant}>Test</Button>);
        const button = screen.getByRole('button');
        expect(button).toHaveClass(`soup-btn--${variant}`);
      });
    });

    it('defaults to neutral variant', () => {
      render(<Button>Test</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('soup-btn--neutral');
    });
  });

  describe('sizes', () => {
    const sizes = [
      ['md', false],
      ['sm', 'soup-btn--sm'],
      ['xs', 'soup-btn--xs'],
    ] as const;

    sizes.forEach(([size, expectedClass]) => {
      it(`applies ${size} size class`, () => {
        render(<Button size={size}>Test</Button>);
        const button = screen.getByRole('button');
        if (expectedClass) {
          expect(button).toHaveClass(expectedClass);
        } else {
          expect(button.className).not.toMatch(/soup-btn--(sm|xs)/);
        }
      });
    });

    it('defaults to md size', () => {
      render(<Button>Test</Button>);
      const button = screen.getByRole('button');
      expect(button.className).not.toMatch(/soup-btn--(sm|xs)/);
    });
  });

  describe('icons', () => {
    it('renders icon before children', () => {
      const { container } = render(
        <Button icon={<span data-testid="start-icon">★</span>}>Label</Button>
      );
      const button = container.querySelector('button');
      const iconSpan = button?.querySelector('[data-testid="start-icon"]');
      expect(iconSpan).toBeInTheDocument();
      expect(iconSpan?.textContent).toBe('★');
    });

    it('renders iconEnd after children', () => {
      const { container } = render(
        <Button iconEnd={<span data-testid="end-icon">→</span>}>Label</Button>
      );
      const button = container.querySelector('button');
      const iconSpan = button?.querySelector('[data-testid="end-icon"]');
      expect(iconSpan).toBeInTheDocument();
      expect(iconSpan?.textContent).toBe('→');
    });

    it('renders both icons with children', () => {
      const { container } = render(
        <Button
          icon={<span data-testid="start-icon">★</span>}
          iconEnd={<span data-testid="end-icon">→</span>}
        >
          Label
        </Button>
      );
      const button = container.querySelector('button');
      expect(button?.querySelector('[data-testid="start-icon"]')).toBeInTheDocument();
      expect(button?.querySelector('[data-testid="end-icon"]')).toBeInTheDocument();
    });

    it('marks icons as aria-hidden', () => {
      const { container } = render(
        <Button icon={<span data-testid="start-icon">★</span>}>Label</Button>
      );
      const span = container.querySelector('[data-testid="start-icon"]')?.parentElement;
      expect(span).toHaveAttribute('aria-hidden', 'true');
    });
  });

  describe('loading state', () => {
    it('renders spinner when loading=true', () => {
      render(<Button loading>Load</Button>);
      const button = screen.getByRole('button');
      expect(button.querySelector('svg')).toBeInTheDocument();
    });

    it('sets aria-busy when loading', () => {
      render(<Button loading>Load</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-busy', 'true');
    });

    it('disables button when loading', () => {
      render(<Button loading>Load</Button>);
      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('hides start icon when loading', () => {
      render(
        <Button loading icon={<span data-testid="icon">★</span>}>
          Load
        </Button>
      );
      const button = screen.getByRole('button');
      expect(button.querySelector('[data-testid="icon"]')).not.toBeInTheDocument();
      expect(button.querySelector('svg')).toBeInTheDocument();
    });

    it('spinner has animate-spin class', () => {
      render(<Button loading>Load</Button>);
      const spinner = screen.getByRole('button').querySelector('svg');
      expect(spinner).toHaveClass('animate-spin');
    });

    it('does not fire aria-busy when loading=false', () => {
      render(<Button>Load</Button>);
      const button = screen.getByRole('button');
      expect(button).not.toHaveAttribute('aria-busy');
    });
  });

  describe('disabled state', () => {
    it('disables button when disabled=true', () => {
      render(<Button disabled>Click</Button>);
      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('sets aria-disabled when disabled', () => {
      render(<Button disabled>Click</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-disabled', 'true');
    });

    it('does not fire aria-disabled when disabled=false', () => {
      render(<Button>Click</Button>);
      const button = screen.getByRole('button');
      expect(button).not.toHaveAttribute('aria-disabled');
    });

    it('disables even when loading=false', () => {
      render(<Button disabled loading={false}>Click</Button>);
      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });
  });

  describe('click handler', () => {
    it('fires onClick callback on click', async () => {
      const onClick = vi.fn();
      render(<Button onClick={onClick}>Click</Button>);
      const button = screen.getByRole('button');
      await userEvent.click(button);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('does not fire onClick when disabled', async () => {
      const onClick = vi.fn();
      render(<Button disabled onClick={onClick}>Click</Button>);
      const button = screen.getByRole('button');
      await userEvent.click(button);
      expect(onClick).not.toHaveBeenCalled();
    });

    it('does not fire onClick when loading', async () => {
      const onClick = vi.fn();
      render(<Button loading onClick={onClick}>Click</Button>);
      const button = screen.getByRole('button');
      await userEvent.click(button);
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('className composition', () => {
    it('merges custom className', () => {
      render(<Button className="custom-class">Test</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('soup-btn');
      expect(button).toHaveClass('custom-class');
    });

    it('combines variant, size, and custom classes', () => {
      render(
        <Button variant="danger" size="sm" className="extra">
          Delete
        </Button>
      );
      const button = screen.getByRole('button');
      expect(button).toHaveClass('soup-btn');
      expect(button).toHaveClass('soup-btn--danger');
      expect(button).toHaveClass('soup-btn--sm');
      expect(button).toHaveClass('extra');
    });
  });

  describe('children', () => {
    it('renders string children', () => {
      render(<Button>Click me</Button>);
      expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
    });

    it('renders react element children', () => {
      render(
        <Button>
          <span data-testid="child">Content</span>
        </Button>
      );
      expect(screen.getByTestId('child')).toBeInTheDocument();
    });

    it('renders multiple children', () => {
      render(
        <Button>
          <span>Part 1</span>
          <span>Part 2</span>
        </Button>
      );
      expect(screen.getByText('Part 1')).toBeInTheDocument();
      expect(screen.getByText('Part 2')).toBeInTheDocument();
    });
  });

  describe('html attributes', () => {
    it('passes through data attributes', () => {
      render(<Button data-testid="my-btn">Test</Button>);
      expect(screen.getByTestId('my-btn')).toBeInTheDocument();
    });

    it('passes through aria attributes', () => {
      render(<Button aria-label="Action">🎯</Button>);
      const button = screen.getByRole('button', { name: 'Action' });
      expect(button).toHaveAttribute('aria-label', 'Action');
    });

    it('respects title attribute', () => {
      render(<Button title="Tooltip text">Hover me</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('title', 'Tooltip text');
    });
  });

  describe('edge cases', () => {
    it('renders without children', () => {
      render(<Button aria-label="Empty" />);
      expect(screen.getByRole('button', { name: 'Empty' })).toBeInTheDocument();
    });

    it('renders with null children (no crash)', () => {
      const { container } = render(<Button>{null}</Button>);
      const button = container.querySelector('button');
      expect(button).toBeInTheDocument();
    });

    it('renders all props combined', () => {
      const onClick = vi.fn();
      const { container } = render(
        <Button
          variant="success"
          size="xs"
          icon={<span data-testid="icon">✓</span>}
          iconEnd={<span data-testid="end">→</span>}
          disabled
          className="extra"
          onClick={onClick}
          data-testid="combo"
        >
          Complete
        </Button>
      );
      const button = screen.getByTestId('combo');
      expect(button).toHaveClass('soup-btn', 'soup-btn--success', 'soup-btn--xs', 'extra');
      expect(button).toBeDisabled();
      expect(button.querySelector('[data-testid="icon"]')).toBeInTheDocument();
      expect(button.querySelector('[data-testid="end"]')).toBeInTheDocument();
    });
  });
});
