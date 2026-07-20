/** @vitest-environment jsdom */
/**
 * Card primitive contract (card.md; DD-38):
 * base renders the absorbed recipe (`.soup-card`, DD-38 closeout) verbatim; interactive/selectable render a real
 * <button> (interactive-card-is-button law, never a click <div>); selectable wires
 * aria-pressed; status-edge keys a channel border to a status token; rest props,
 * className, children, and header/footer slots pass through.
 * Class/style assertions prove the CSS hook exists, not the rendered ink.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Card } from '../../console/src/components/primitives';

afterEach(() => cleanup());

describe('Card primitive (DD-38)', () => {
  it('base renders a <div> carrying the .soup-card recipe and forwards className + children', () => {
    const { container } = render(<Card className="flex flex-col">body</Card>);
    const el = container.querySelector('.soup-card');
    expect(el).not.toBeNull();
    expect(el!.tagName).toBe('DIV');
    expect(el!.className).toContain('flex flex-col');
    expect(el!.textContent).toContain('body');
  });

  it('interactive renders a real <button> (interactive-card-is-button), not a click div', () => {
    render(<Card variant="interactive" onClick={() => {}}>go</Card>);
    const btn = screen.getByRole('button', { name: 'go' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.className).toContain('soup-card');
    // the one focus recipe + hover lift hooks
    expect(btn.className).toContain('focus-visible:outline-[var(--focus-ring)]');
    expect(btn.className).toContain('c-hover');
  });

  it('selectable is a button that reflects selection via aria-pressed (not colour alone)', () => {
    const { rerender } = render(<Card variant="selectable" selected={false}>opt</Card>);
    expect(screen.getByRole('button', { name: 'opt' }).getAttribute('aria-pressed')).toBe('false');
    rerender(<Card variant="selectable" selected>opt</Card>);
    expect(screen.getByRole('button', { name: 'opt' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('status-edge keys the inset border to the canonical status channel token', () => {
    const { container } = render(<Card variant="status-edge" edge="warn">warn</Card>);
    const el = container.querySelector('.soup-card') as HTMLElement;
    // Canonical status-solid token (the legacy --color-s-* alias was migrated off).
    expect(el.style.borderLeftColor).toContain('--status-warn-solid');
    expect(el.style.borderLeftStyle).toBe('solid');
  });

  it('href forces an <a>; disabled wires aria-disabled + disabled on the button', () => {
    render(<Card variant="interactive" href="/x">link</Card>);
    expect(screen.getByRole('link', { name: 'link' }).tagName).toBe('A');
    cleanup();
    render(<Card variant="interactive" disabled>nope</Card>);
    const btn = screen.getByRole('button', { name: 'nope' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("base with as='section' renders a semantic <section> carrying .soup-card (no button/role)", () => {
    const { container } = render(<Card variant="base" as="section">body</Card>);
    const el = container.querySelector('section.soup-card');
    expect(el).not.toBeNull();
    expect(el!.tagName).toBe('SECTION');
    expect(el!.textContent).toContain('body');
    // as='section' must never force an interactive/button path.
    expect(el!.getAttribute('type')).toBeNull();
    expect(el!.getAttribute('role')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it("interactive-card-is-button wins: variant='interactive' renders a <button> even when as='section'", () => {
    render(<Card variant="interactive" as="section" onClick={() => {}}>go</Card>);
    const btn = screen.getByRole('button', { name: 'go' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('renders header/footer slots and forwards arbitrary rest props', () => {
    const { container } = render(
      <Card header={<div>H</div>} footer={<div>F</div>} data-testid="panel">mid</Card>,
    );
    const el = container.querySelector('.soup-card') as HTMLElement;
    expect(el.getAttribute('data-testid')).toBe('panel');
    expect(el.textContent).toBe('HmidF');
  });
});
