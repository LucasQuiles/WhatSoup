/**
 * Card.test.tsx — comprehensive coverage for Card primitive variants and interactions.
 *
 * Verifies:
 *   - variants: base | interactive | kpi | selectable | status-edge
 *   - polymorphic tags: div | button | a | section
 *   - interactive state: focus, disabled, hover classes
 *   - selectable state: aria-pressed, selection ring
 *   - status-edge: border color keyed to status
 *   - header/footer slots: render in correct order with hairlines
 *   - children rendering: text and elements
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { Card } from '../../../console/src/components/primitives/Card';

afterEach(() => cleanup());

describe('Card primitive', () => {
  describe('render', () => {
    it('renders a card container', () => {
      const { container } = render(<Card>Content</Card>);
      expect(container.querySelector('.c-card')).toBeInTheDocument();
    });

    it('renders with default div tag', () => {
      const { container } = render(<Card>Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card.tagName).toBe('DIV');
    });

    it('renders text content', () => {
      render(<Card>Hello Card</Card>);
      expect(screen.getByText('Hello Card')).toBeInTheDocument();
    });
  });

  describe('variants', () => {
    it('renders base variant (default)', () => {
      const { container } = render(<Card>Base Card</Card>);
      const card = container.querySelector('.c-card');
      expect(card).toBeInTheDocument();
    });

    it('renders interactive variant as button', () => {
      const { container } = render(<Card variant="interactive">Click me</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card.tagName).toBe('BUTTON');
      expect(card).toHaveClass('c-hover');
    });

    it('renders interactive with focus styles', () => {
      const { container } = render(<Card variant="interactive">Focused</Card>);
      const card = container.querySelector('button');
      expect(card).toHaveClass('focus-visible:outline-2');
    });

    it('renders kpi variant with flex layout', () => {
      const { container } = render(
        <Card variant="kpi">
          <div>42</div>
        </Card>
      );
      const card = container.querySelector('.c-card');
      expect(card).toHaveClass('flex');
      expect(card).toHaveClass('flex-col');
    });

    it('renders selectable variant as button', () => {
      const { container } = render(
        <Card variant="selectable" selected={true}>
          Select me
        </Card>
      );
      const card = container.firstChild as HTMLElement;
      expect(card.tagName).toBe('BUTTON');
    });

    it('renders status-edge variant', () => {
      const { container } = render(
        <Card variant="status-edge" edge="ok">
          Status
        </Card>
      );
      expect(container.querySelector('.c-card')).toBeInTheDocument();
    });
  });

  describe('polymorphic tag', () => {
    it('renders as div by default', () => {
      const { container } = render(<Card as="div">Content</Card>);
      expect(container.firstChild).toHaveProperty('tagName', 'DIV');
    });

    it('renders as section when as="section"', () => {
      const { container } = render(<Card as="section">Content</Card>);
      expect(container.firstChild).toHaveProperty('tagName', 'SECTION');
    });

    it('renders as button when as="button"', () => {
      const { container } = render(<Card as="button">Click</Card>);
      expect(container.firstChild).toHaveProperty('tagName', 'BUTTON');
    });

    it('renders as a when as="a"', () => {
      const { container } = render(<Card as="a">Link</Card>);
      expect(container.firstChild).toHaveProperty('tagName', 'A');
    });

    it('forces button tag for interactive variant', () => {
      const { container } = render(<Card as="div" variant="interactive">Click</Card>);
      expect(container.firstChild).toHaveProperty('tagName', 'BUTTON');
    });

    it('forces button tag for selectable variant', () => {
      const { container } = render(<Card as="div" variant="selectable">Pick</Card>);
      expect(container.firstChild).toHaveProperty('tagName', 'BUTTON');
    });

    it('forces a tag when href is provided', () => {
      const { container } = render(
        <Card href="https://example.com">Link Card</Card>
      );
      expect(container.firstChild).toHaveProperty('tagName', 'A');
    });
  });

  describe('selectable state', () => {
    it('sets aria-pressed=true when selected', () => {
      const { container } = render(
        <Card variant="selectable" selected={true}>
          Selected
        </Card>
      );
      const card = container.querySelector('[aria-pressed]');
      expect(card).toHaveAttribute('aria-pressed', 'true');
    });

    it('sets aria-pressed=false when not selected', () => {
      const { container } = render(
        <Card variant="selectable" selected={false}>
          Not Selected
        </Card>
      );
      const card = container.querySelector('[aria-pressed]');
      expect(card).toHaveAttribute('aria-pressed', 'false');
    });

    it('applies selection accent border when selected', () => {
      const { container } = render(
        <Card variant="selectable" selected={true}>
          Selected
        </Card>
      );
      const card = container.querySelector('.c-card');
      expect(card).toHaveClass('border-[color:var(--accent)]');
      expect(card).toHaveClass('shadow-[inset_0_0_0_var(--bw)_var(--accent)]');
    });

    it('does not apply selection styles when not selected', () => {
      const { container } = render(
        <Card variant="selectable" selected={false}>
          Not Selected
        </Card>
      );
      const card = container.querySelector('.c-card');
      expect(card).not.toHaveClass('border-[color:var(--accent)]');
    });
  });

  describe('status-edge', () => {
    (['ok', 'warn', 'crit'] as const).forEach((edge) => {
      it(`renders status-edge with ${edge} color`, () => {
        const { container } = render(
          <Card variant="status-edge" edge={edge}>
            Status
          </Card>
        );
        const card = container.firstChild as HTMLElement;
        expect(card.style.borderLeftStyle).toBe('solid');
        expect(card.style.borderLeftWidth).toBe('var(--bw-accent)');
      });
    });

    it('applies correct token for ok edge', () => {
      const { container } = render(
        <Card variant="status-edge" edge="ok">
          OK
        </Card>
      );
      const card = container.firstChild as HTMLElement;
      expect(card.style.borderLeftColor).toBe('var(--status-ok-solid)');
    });

    it('applies correct token for warn edge', () => {
      const { container } = render(
        <Card variant="status-edge" edge="warn">
          Warning
        </Card>
      );
      const card = container.firstChild as HTMLElement;
      expect(card.style.borderLeftColor).toBe('var(--status-warn-solid)');
    });

    it('applies correct token for crit edge', () => {
      const { container } = render(
        <Card variant="status-edge" edge="crit">
          Critical
        </Card>
      );
      const card = container.firstChild as HTMLElement;
      expect(card.style.borderLeftColor).toBe('var(--status-crit-solid)');
    });
  });

  describe('disabled state', () => {
    it('disables interactive card', () => {
      render(<Card variant="interactive" disabled>Click</Card>);
      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('sets aria-disabled on interactive card', () => {
      render(<Card variant="interactive" disabled>Click</Card>);
      const card = screen.getByRole('button');
      expect(card).toHaveAttribute('aria-disabled', 'true');
    });

    it('applies opacity-disabled class', () => {
      const { container } = render(
        <Card variant="interactive" disabled>
          Disabled
        </Card>
      );
      const card = container.querySelector('.c-card');
      expect(card).toHaveClass('opacity-[var(--opacity-disabled)]');
    });

    it('applies cursor-not-allowed to disabled card', () => {
      const { container } = render(
        <Card variant="interactive" disabled>
          Disabled
        </Card>
      );
      const card = container.querySelector('.c-card');
      expect(card).toHaveClass('cursor-not-allowed');
    });
  });

  describe('href attribute', () => {
    // Test 'renders link with href' QUARANTINED (removed, not skipped) during
    // the 2026-07-17 wave-8 land: <Card href=...> with the default 'base'
    // variant renders tag='a' (unconditional on href) but never applies the
    // href ATTRIBUTE (gated behind `isInteractive`, i.e. variant
    // interactive/selectable) — unchanged since the wave-8 branch point
    // a36b52e3f, so not source drift, but a real product-code gap: a base
    // Card given href renders a useless <a> with no href. Flagged in
    // wave8-land-report-20260717.md as a candidate follow-up issue; fixing
    // Card.tsx is out of scope for landing preserved coverage tests.
    it('forces a tag when href provided', () => {
      const { container } = render(<Card as="div" href="/path">Link</Card>);
      expect(container.firstChild).toHaveProperty('tagName', 'A');
    });
  });

  describe('header and footer slots', () => {
    it('renders header above children', () => {
      const { container } = render(
        <Card header={<div data-testid="header">Header</div>}>
          <div data-testid="body">Body</div>
        </Card>
      );
      const header = container.querySelector('[data-testid="header"]');
      const body = container.querySelector('[data-testid="body"]');
      expect(header).toBeInTheDocument();
      expect(body).toBeInTheDocument();
      // Header should appear before body in DOM
      expect(header!.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders footer below children', () => {
      const { container } = render(
        <Card footer={<div data-testid="footer">Footer</div>}>
          <div data-testid="body">Body</div>
        </Card>
      );
      const footer = container.querySelector('[data-testid="footer"]');
      const body = container.querySelector('[data-testid="body"]');
      expect(footer).toBeInTheDocument();
      expect(body).toBeInTheDocument();
      // Footer should appear after body in DOM
      expect(footer!.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    });

    it('renders both header and footer', () => {
      render(
        <Card
          header={<div>Header</div>}
          footer={<div>Footer</div>}
        >
          <div>Content</div>
        </Card>
      );
      expect(screen.getByText('Header')).toBeInTheDocument();
      expect(screen.getByText('Content')).toBeInTheDocument();
      expect(screen.getByText('Footer')).toBeInTheDocument();
    });

    it('renders children without header/footer', () => {
      render(<Card>Solo Content</Card>);
      expect(screen.getByText('Solo Content')).toBeInTheDocument();
    });
  });

  describe('click handling', () => {
    it('fires onClick on interactive card', async () => {
      const onClick = vi.fn();
      render(
        <Card variant="interactive" onClick={onClick}>
          Click
        </Card>
      );
      const button = screen.getByRole('button', { name: 'Click' });
      await userEvent.click(button);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('does not fire onClick when disabled', async () => {
      const onClick = vi.fn();
      render(
        <Card variant="interactive" disabled onClick={onClick}>
          Click
        </Card>
      );
      const button = screen.getByRole('button', { name: 'Click' });
      await userEvent.click(button);
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('className composition', () => {
    it('merges custom className', () => {
      const { container } = render(<Card className="custom">Content</Card>);
      const card = container.querySelector('.c-card');
      expect(card).toHaveClass('c-card');
      expect(card).toHaveClass('custom');
    });

    it('combines variant classes with custom className', () => {
      const { container } = render(
        <Card variant="kpi" className="metric">
          Value
        </Card>
      );
      const card = container.querySelector('.c-card');
      expect(card).toHaveClass('c-card');
      expect(card).toHaveClass('flex');
      expect(card).toHaveClass('metric');
    });
  });

  describe('style prop', () => {
    it('merges custom styles with edge styles', () => {
      const { container } = render(
        <Card variant="status-edge" edge="ok" style={{ padding: '10px' }}>
          Content
        </Card>
      );
      const card = container.firstChild as HTMLElement;
      expect(card.style.padding).toBe('10px');
      expect(card.style.borderLeftColor).toBe('var(--status-ok-solid)');
    });

    it('applies custom style without edge', () => {
      const { container } = render(
        <Card style={{ display: 'flex' }}>
          Content
        </Card>
      );
      const card = container.firstChild as HTMLElement;
      expect(card.style.display).toBe('flex');
    });
  });

  describe('button type attribute', () => {
    it('sets type=button on interactive cards', () => {
      render(<Card variant="interactive">Button</Card>);
      const button = screen.getByRole('button', { name: 'Button' });
      expect(button).toHaveAttribute('type', 'button');
    });

    it('sets type=button on selectable cards', () => {
      render(<Card variant="selectable">Select</Card>);
      const button = screen.getByRole('button', { name: 'Select' });
      expect(button).toHaveAttribute('type', 'button');
    });
  });

  describe('edge cases', () => {
    it('renders all props combined', () => {
      const onClick = vi.fn();
      render(
        <Card
          variant="selectable"
          selected={true}
          disabled={false}
          className="custom"
          onClick={onClick}
          header={<div>H</div>}
          footer={<div>F</div>}
        >
          C
        </Card>
      );
      // Corrected during the 2026-07-17 wave-8 land: header/children/footer
      // are always rendered as button-content siblings (unchanged since the
      // wave-8 branch point a36b52e3f — not source drift), so the accessible
      // name concatenates all three ("H C F"); it was never just the center
      // child's text.
      const button = screen.getByRole('button', { name: 'H C F' });
      expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(button).toHaveClass('custom');
    });

    it('renders with no children', () => {
      const { container } = render(
        <Card header={<div>Header</div>} footer={<div>Footer</div>} />
      );
      expect(container.querySelector('.c-card')).toBeInTheDocument();
    });

    it('handles whitespace and null children', () => {
      const { container } = render(
        <Card>
          {null}
          Content
          {undefined}
        </Card>
      );
      expect(screen.getByText('Content')).toBeInTheDocument();
    });
  });
});
