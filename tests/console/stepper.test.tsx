/** @vitest-environment jsdom */
/**
 * Stepper primitive contract (stepper.md):
 *
 * Non-interactive progress strip rendering the locked v2 .soup-wiz-steps
 * anatomy: numbered circles + 1px hairline separators + per-step
 * active/done modifier classes. a11y: container aria-label (default
 * "Progress"), active step aria-current="step", separators aria-hidden.
 *
 * Class-only assertions prove the CSS hook exists, not the rendered ink.
 * Behavioural assertions cover the prop contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Stepper } from '../../console/src/components/primitives';

afterEach(() => cleanup());

describe('Stepper — container + a11y wiring', () => {
  it('renders a container with default aria-label "Progress"', () => {
    const { container } = render(<Stepper steps={['A', 'B', 'C']} currentStep={0} />);
    const root = container.querySelector('.soup-wiz-steps');
    expect(root).not.toBeNull();
    expect(root!.getAttribute('aria-label')).toBe('Progress');
  });

  it('honours a custom ariaLabel', () => {
    const { container } = render(
      <Stepper steps={['A', 'B']} currentStep={0} ariaLabel="Wizard progress" />,
    );
    const root = container.querySelector('.soup-wiz-steps');
    expect(root!.getAttribute('aria-label')).toBe('Wizard progress');
  });

  it('is non-interactive (no button/role="tab" inside the strip)', () => {
    const { container } = render(<Stepper steps={['A', 'B', 'C']} currentStep={1} />);
    const root = container.querySelector('.soup-wiz-steps')!;
    expect(root.querySelectorAll('button').length).toBe(0);
    expect(root.querySelectorAll('[role="tab"]').length).toBe(0);
  });
});

describe('Stepper — step list rendering', () => {
  it('renders one .soup-wiz-steps__item per label in order', () => {
    const { container } = render(
      <Stepper steps={['Identity', 'Link', 'Model', 'Config', 'Review']} currentStep={0} />,
    );
    const items = container.querySelectorAll('.soup-wiz-steps__item');
    expect(items.length).toBe(5);
  });

  it('renders each label inside a .soup-wiz-steps__label span', () => {
    const { container } = render(
      <Stepper steps={['Identity', 'Link', 'Model', 'Config', 'Review']} currentStep={0} />,
    );
    const labels = container.querySelectorAll('.soup-wiz-steps__label');
    const text = Array.from(labels).map((n) => n.textContent);
    expect(text).toEqual(['Identity', 'Link', 'Model', 'Config', 'Review']);
  });

  it('renders circle numbers 1..N inside .soup-wiz-steps__circle spans', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C']} currentStep={0} />,
    );
    const circles = container.querySelectorAll('.soup-wiz-steps__circle');
    expect(Array.from(circles).map((n) => n.textContent)).toEqual(['1', '2', '3']);
  });
});

describe('Stepper — separators (N-1, aria-hidden)', () => {
  it('renders exactly N-1 separators', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C', 'D', 'E']} currentStep={2} />,
    );
    const seps = container.querySelectorAll('.soup-wiz-steps__sep');
    expect(seps.length).toBe(4);
  });

  it('every separator carries aria-hidden="true"', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C']} currentStep={0} />,
    );
    const seps = container.querySelectorAll('.soup-wiz-steps__sep');
    seps.forEach((sep) => expect(sep.getAttribute('aria-hidden')).toBe('true'));
  });

  it('the first item has no separator before it (no leading sep)', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C']} currentStep={0} />,
    );
    const firstItem = container.querySelectorAll('.soup-wiz-steps__item')[0]!;
    expect(firstItem.querySelector('.soup-wiz-steps__sep')).toBeNull();
  });
});

describe('Stepper — active / done modifier classes', () => {
  it('marks the current step with --active and aria-current="step"', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C', 'D']} currentStep={2} />,
    );
    const items = container.querySelectorAll('.soup-wiz-steps__item');
    const activeStep = items[2]!.querySelector('.soup-wiz-steps__step')!;
    expect(activeStep.classList.contains('soup-wiz-steps__step--active')).toBe(true);
    expect(activeStep.getAttribute('aria-current')).toBe('step');
  });

  it('marks steps before current with --done (no aria-current on them)', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C', 'D']} currentStep={2} />,
    );
    const items = container.querySelectorAll('.soup-wiz-steps__item');
    for (let i = 0; i < 2; i++) {
      const step = items[i]!.querySelector('.soup-wiz-steps__step')!;
      expect(step.classList.contains('soup-wiz-steps__step--done')).toBe(true);
      expect(step.classList.contains('soup-wiz-steps__step--active')).toBe(false);
      expect(step.getAttribute('aria-current')).toBeNull();
    }
  });

  it('steps after current carry neither --active nor --done', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C', 'D']} currentStep={1} />,
    );
    const items = container.querySelectorAll('.soup-wiz-steps__item');
    const future = items[3]!.querySelector('.soup-wiz-steps__step')!;
    expect(future.classList.contains('soup-wiz-steps__step--active')).toBe(false);
    expect(future.classList.contains('soup-wiz-steps__step--done')).toBe(false);
    expect(future.getAttribute('aria-current')).toBeNull();
  });

  it('only the current step carries aria-current="step" (single-fire)', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C', 'D', 'E']} currentStep={3} />,
    );
    const currents = container.querySelectorAll('[aria-current="step"]');
    expect(currents.length).toBe(1);
  });
});

describe('Stepper — checkOnDone (showcase §23 forward treatment)', () => {
  it('defaults off: done steps still render their number, no --forward modifier', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C']} currentStep={2} />,
    );
    const root = container.querySelector('.soup-wiz-steps')!;
    expect(root.classList.contains('soup-wiz-steps--forward')).toBe(false);
    const circles = container.querySelectorAll('.soup-wiz-steps__circle');
    // done steps 0,1 keep numbers when checkOnDone is off
    expect(circles[0]!.textContent).toBe('1');
    expect(circles[1]!.textContent).toBe('2');
  });

  it('adds the --forward root modifier when enabled', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C']} currentStep={2} checkOnDone />,
    );
    const root = container.querySelector('.soup-wiz-steps')!;
    expect(root.classList.contains('soup-wiz-steps--forward')).toBe(true);
  });

  it('renders ✓ on completed steps, numbers on active/upcoming', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C', 'D']} currentStep={2} checkOnDone />,
    );
    const circles = container.querySelectorAll('.soup-wiz-steps__circle');
    expect(circles[0]!.textContent).toBe('✓'); // done
    expect(circles[1]!.textContent).toBe('✓'); // done
    expect(circles[2]!.textContent).toBe('3');  // active
    expect(circles[3]!.textContent).toBe('4');  // upcoming
  });

  it('renders the ✓ glyph as decorative (aria-hidden) — status reaches AT via text, not glyph', () => {
    const { container } = render(
      <Stepper steps={['A', 'B']} currentStep={1} checkOnDone />,
    );
    const glyph = container.querySelector('.soup-wiz-steps__circle [aria-hidden="true"]')!;
    expect(glyph).not.toBeNull();
    expect(glyph.textContent).toBe('✓');
  });
});

describe('Stepper — showStateText (§12 status law: state as text)', () => {
  it('defaults on: every step emits a visually-hidden state label', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C']} currentStep={1} />,
    );
    const labels = container.querySelectorAll('.soup-wiz-steps__sr');
    expect(Array.from(labels).map((n) => n.textContent)).toEqual([
      'Completed',     // step 0 (before current)
      'Current step',  // step 1 (current)
      'Upcoming',      // step 2 (after current)
    ]);
  });

  it('omits the state labels when showStateText is false', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C']} currentStep={1} showStateText={false} />,
    );
    expect(container.querySelectorAll('.soup-wiz-steps__sr').length).toBe(0);
  });

  it('state text is independent of checkOnDone (both can apply together)', () => {
    const { container } = render(
      <Stepper steps={['A', 'B', 'C']} currentStep={2} checkOnDone />,
    );
    const labels = container.querySelectorAll('.soup-wiz-steps__sr');
    expect(Array.from(labels).map((n) => n.textContent)).toEqual([
      'Completed',
      'Completed',
      'Current step',
    ]);
  });
});
