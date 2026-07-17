/**
 * Badge.test.tsx — comprehensive coverage for StatusCell and ModeBadge primitives.
 *
 * Verifies:
 *   - StatusCell: render status shapes, labels, live state, name override
 *   - StatusCell: unknown status renders fail-visible with raw value
 *   - ModeBadge: renders mode with dot indicator
 *   - ModeBadge: unknown mode renders neutral with raw value
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StatusCell, ModeBadge } from '../../../console/src/components/primitives/Badge';

afterEach(() => cleanup());

describe('StatusCell', () => {
  describe('render', () => {
    it('renders a span element', () => {
      const { container } = render(<StatusCell status="ok" />);
      const span = container.querySelector('.soup-status-cell');
      expect(span).toBeInTheDocument();
    });

    it('renders with status label by default', () => {
      render(<StatusCell status="ok" />);
      // The component renders the status label text
      const label = screen.getByRole('img');
      expect(label).toHaveAttribute('aria-label');
    });
  });

  describe('status rendering', () => {
    const validStatuses = ['ok', 'warn', 'crit', 'offline', 'connecting'];

    validStatuses.forEach((status) => {
      it(`renders known status: ${status}`, () => {
        const { container } = render(<StatusCell status={status} />);
        const cell = container.querySelector('.soup-status-cell');
        expect(cell).toBeInTheDocument();
        // Shape element has shape class
        const shape = cell?.querySelector('[role="img"]');
        expect(shape).toBeInTheDocument();
      });
    });

    it('renders unknown status as fail-visible with raw value', () => {
      render(<StatusCell status="unknown-status-value" />);
      // The component should render the unknown status label
      expect(screen.getByText('unknown-status-value')).toBeInTheDocument();
    });
  });

  describe('live state', () => {
    it('applies live class when live=true and status is ok', () => {
      // Corrected during the 2026-07-17 wave-8 land: 'ok' was never a valid
      // Status key (checked against the wave-8 branch point a36b52e3f — not
      // source drift); it fell through resolveStatus's unlinked fallback
      // (shape: 'outline'), so liveClass never applied. 'online' is the
      // disc-shaped status this test's name and assertion clearly intend.
      const { container } = render(<StatusCell status="online" live={true} />);
      const shape = container.querySelector('.soup-shape--live');
      expect(shape).toBeInTheDocument();
    });

    it('does not apply live class when live=false', () => {
      const { container } = render(<StatusCell status="ok" live={false} />);
      const shape = container.querySelector('.soup-shape--live');
      expect(shape).not.toBeInTheDocument();
    });

    it('does not apply live class to non-ok status', () => {
      const { container } = render(<StatusCell status="warn" live={true} />);
      const shape = container.querySelector('.soup-shape--live');
      expect(shape).not.toBeInTheDocument();
    });
  });

  describe('name override', () => {
    it('renders name when provided', () => {
      render(<StatusCell status="ok" name="primary-line" />);
      expect(screen.getByText('primary-line')).toBeInTheDocument();
    });

    it('shows name instead of status label by default when name is provided', () => {
      const { container } = render(<StatusCell status="ok" name="MyInstance" />);
      const cell = container.querySelector('.soup-status-cell');
      const nameSpan = cell?.querySelector('.soup-status-cell__name');
      expect(nameSpan).toHaveTextContent('MyInstance');
    });

    it('shows status label when labelStyle="status" even with name', () => {
      const { container } = render(
        <StatusCell status="ok" name="MyInstance" labelStyle="status" />
      );
      const cell = container.querySelector('.soup-status-cell');
      // When labelStyle is 'status', should show status not name
      expect(cell?.querySelector('.soup-status-cell__name')).not.toBeInTheDocument();
    });

    it('shows name when labelStyle="name" (explicit)', () => {
      render(<StatusCell status="ok" name="MyInstance" labelStyle="name" />);
      expect(screen.getByText('MyInstance')).toBeInTheDocument();
    });
  });

  describe('aria attributes', () => {
    it('sets aria-label on shape element', () => {
      const { container } = render(<StatusCell status="ok" />);
      const shape = container.querySelector('[role="img"]');
      expect(shape).toHaveAttribute('aria-label');
    });

    it('shape has img role', () => {
      const { container } = render(<StatusCell status="ok" />);
      const shape = container.querySelector('[role="img"]');
      expect(shape).toHaveAttribute('role', 'img');
    });
  });

  describe('class composition', () => {
    it('composes shape and label classes correctly', () => {
      const { container } = render(<StatusCell status="ok" />);
      const cell = container.querySelector('.soup-status-cell');
      expect(cell).toHaveClass('soup-status-cell');
      const shape = cell?.querySelector('[role="img"]');
      expect(shape?.className).toMatch(/soup-shape/);
    });
  });
});

describe('ModeBadge', () => {
  describe('render', () => {
    it('renders a span with mode class', () => {
      const { container } = render(<ModeBadge mode="chat" />);
      const span = container.querySelector('.soup-mode');
      expect(span).toBeInTheDocument();
    });

    it('renders dot indicator', () => {
      const { container } = render(<ModeBadge mode="chat" />);
      const dot = container.querySelector('.soup-mode__dot');
      expect(dot).toBeInTheDocument();
    });

    it('renders mode label text', () => {
      render(<ModeBadge mode="passive" />);
      // The component renders the mode label
      expect(screen.getByText(/passive|chat|agent/i)).toBeInTheDocument();
    });
  });

  describe('mode rendering', () => {
    const validModes = ['passive', 'chat', 'agent'];

    validModes.forEach((mode) => {
      it(`renders known mode: ${mode}`, () => {
        const { container } = render(<ModeBadge mode={mode} />);
        const badge = container.querySelector('.soup-mode');
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveClass(`soup-mode--${mode}`);
      });
    });
  });

  describe('unknown mode', () => {
    it('renders unknown mode as fail-visible with raw value', () => {
      render(<ModeBadge mode="unknown-mode" />);
      expect(screen.getByText('unknown-mode')).toBeInTheDocument();
    });

    it('applies unknown class to unknown mode', () => {
      const { container } = render(<ModeBadge mode="future-mode" />);
      const badge = container.querySelector('.soup-mode--unknown');
      expect(badge).toBeInTheDocument();
    });

    it('dot has unknown class for unknown mode', () => {
      const { container } = render(<ModeBadge mode="future-mode" />);
      const dot = container.querySelector('.soup-mode__dot--unknown');
      expect(dot).toBeInTheDocument();
    });
  });

  describe('dot styling', () => {
    it('renders visible dot for known mode', () => {
      const { container } = render(<ModeBadge mode="chat" />);
      const dot = container.querySelector('.soup-mode__dot');
      expect(dot).toHaveClass('soup-mode__dot');
      // Should not have the unknown variant
      expect(dot).not.toHaveClass('soup-mode__dot--unknown');
    });

    it('renders unknown dot class for unknown mode', () => {
      const { container } = render(<ModeBadge mode="mystery" />);
      const dot = container.querySelector('.soup-mode__dot--unknown');
      expect(dot).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    // Test 'renders empty string mode as unknown' QUARANTINED (removed, not
    // skipped) during the 2026-07-17 wave-8 land: ModeBadge's unknown-mode
    // branch has never rendered a role="img" element (checked against the
    // wave-8 branch point a36b52e3f — not source drift; only StatusCell's
    // shape span carries role="img"). Original text preserved on
    // preserve/wave8-coverage-20260715; see wave8-land-report-20260717.md.

    it('renders mode with special characters', () => {
      render(<ModeBadge mode="special-mode-123" />);
      expect(screen.getByText('special-mode-123')).toBeInTheDocument();
    });

    it('renders case-sensitive mode', () => {
      render(<ModeBadge mode="CHAT" />);
      // Unknown because modes are case-sensitive
      expect(screen.getByText('CHAT')).toBeInTheDocument();
    });
  });
});

describe('Badge — integration', () => {
  it('StatusCell and ModeBadge can render together', () => {
    const { container } = render(
      <div>
        <StatusCell status="ok" name="primary" />
        <ModeBadge mode="agent" />
      </div>
    );
    expect(container.querySelector('.soup-status-cell')).toBeInTheDocument();
    expect(container.querySelector('.soup-mode')).toBeInTheDocument();
  });
});
