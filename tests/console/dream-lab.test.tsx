/**
 * Dream Lab surface (T5 b-06) — jsdom contracts against the mockup
 * dream-lab.html anatomy: queued pill, queue cards (avatar, kind — summary,
 * type tag, italic rationale, provenance), filters strip, recently-decided
 * rows, and the review pane (rhead, rationale, 72ch-capped diff, impact
 * columns, decision actions).
 *
 * Honesty law pins: no Dream backend exists — the live page renders an
 * honest empty queue, honest zero-count pill, disabled history/filters with
 * explanatory titles, and an empty review state. The dream anatomy is
 * proven against synthetic fixtures here, never shipped as mock data in the
 * page.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import DreamLab from '../../console/src/pages/DreamLab';
import { DreamCard, DreamAvatar } from '../../console/src/components/dream/DreamCard';
import { DreamReview } from '../../console/src/components/dream/DreamReview';
import { dreamHueIndex, dreamInitials, type Dream } from '../../console/src/components/dream/types';

afterEach(() => cleanup());

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/dream-lab']}>
      <DreamLab />
    </MemoryRouter>,
  );
}

function makeDream(overrides: Partial<Dream> = {}): Dream {
  return {
    id: 'd-1',
    agentName: 'Quinn',
    kind: 'persona',
    summary: 'tone',
    rationale: 'The room writes in short, warm bursts. I would match it.',
    suggestedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    instanceLabel: '15550000···000@g.us',
    state: 'queued',
    diffTarget: 'SOUL.md — persona section',
    diff: [
      {
        title: 'Tone',
        lines: [
          { kind: 'del', text: 'Replies are complete and professional, with full greetings and sign-offs.' },
          { kind: 'add', text: 'Replies are short and warm. Open with the answer.' },
          { kind: 'keep', text: 'Never sacrifice accuracy for brevity.' },
        ],
      },
      {
        title: 'Formatting',
        lines: [{ kind: 'add', text: 'One idea per message.' }],
      },
    ],
    impact: {
      appliesTo: 'Quinn · all instances',
      reversible: 'one-click rollback',
      risk: 'low — tone only',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Live page — honest empties (no Dream backend)
// ---------------------------------------------------------------------------

describe('live page honesty (no Dream API today)', () => {
  it('the surface owns exactly one h1 and the pill reports zero queued', () => {
    renderPage();
    const h1s = document.querySelectorAll('h1');
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe('Dream Lab');
    expect(screen.getByTestId('dream-qpill').textContent).toContain('0 dreams queued');
  });

  it('the queue renders the honest empty state — never phantom dreams', () => {
    renderPage();
    expect(screen.getByTestId('dream-queue-empty').textContent).toContain('No dreams queued');
    expect(document.querySelectorAll('.dream-dcard').length).toBe(0);
  });

  it('history and filters are disabled with explanatory titles', () => {
    renderPage();
    const history = screen.getByRole('button', { name: 'history' }) as HTMLButtonElement;
    expect(history.disabled).toBe(true);
    expect(history.title).toContain('Dream API');
    const filters = screen.getByRole('button', { name: /agent: all/i }) as HTMLButtonElement;
    expect(filters.disabled).toBe(true);
    expect(filters.title).toContain('queue is empty');
  });

  it('recently decided renders its honest empty row', () => {
    renderPage();
    expect(screen.getByTestId('dream-history-empty').textContent).toContain('Nothing decided yet');
  });

  it('the review pane renders the empty selection state', () => {
    renderPage();
    expect(screen.getByText('No dream selected')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Queue card anatomy (fixtures prove the mockup shape)
// ---------------------------------------------------------------------------

describe('dream card (mockup .dcard anatomy)', () => {
  it('renders avatar, kind — summary, type tag, quoted rationale, provenance', () => {
    const dream = makeDream();
    const { container } = render(
      <MemoryRouter>
        <DreamCard dream={dream} selected={false} onSelect={() => {}} whenLabel="2h ago" />
      </MemoryRouter>,
    );
    const card = container.querySelector('.dream-dcard')!;
    expect(card.querySelector('.dream-av')).toBeTruthy();
    expect(card.querySelector('.dream-dcard__nm')?.textContent).toBe('Quinn');
    expect(card.querySelector('.dream-dcard__what')?.textContent).toContain('persona — tone');
    expect(card.querySelector('.dream-dtag--persona')?.textContent).toBe('persona');
    expect(card.querySelector('.dream-dcard__why')?.textContent).toContain('short, warm bursts');
    expect(card.querySelector('.dream-dcard__when')?.textContent).toContain('2h ago');
    expect(card.querySelector('.dream-dcard__when')?.textContent).toContain('15550000···000@g.us');
  });

  it('selection rides aria-pressed and fires onSelect', () => {
    const onSelect = vi.fn();
    const dream = makeDream();
    const { container, rerender } = render(
      <MemoryRouter>
        <DreamCard dream={dream} selected={false} onSelect={onSelect} whenLabel="2h ago" />
      </MemoryRouter>,
    );
    const btn = container.querySelector('button')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith('d-1');
    rerender(
      <MemoryRouter>
        <DreamCard dream={dream} selected onSelect={onSelect} whenLabel="2h ago" />
      </MemoryRouter>,
    );
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.dream-dcard--sel')).toBeTruthy();
  });

  it('avatar fill consumes the agent-hue token deterministically', () => {
    const { container } = render(<DreamAvatar name="Quinn" />);
    const av = container.querySelector('.dream-av') as HTMLElement;
    expect(av.style.background).toBe(`var(--agent-hue-${dreamHueIndex('Quinn')})`);
    expect(dreamHueIndex('Quinn')).toBe(dreamHueIndex('quinn'));
    expect(dreamInitials('Quinn Prime')).toBe('QP');
    expect(dreamInitials('quinn')).toBe('QU');
  });
});

// ---------------------------------------------------------------------------
// Review pane anatomy
// ---------------------------------------------------------------------------

describe('review pane (mockup .review anatomy)', () => {
  function renderReview(decide = vi.fn()) {
    const dream = makeDream();
    render(
      <MemoryRouter>
        <DreamReview dream={dream} metaLine="quinn · persona · suggested 2h ago from instance 15550000···000@g.us" onDecide={decide} />
      </MemoryRouter>,
    );
    return { dream, decide };
  }

  it('renders rhead (lg avatar, h2, meta), rationale quote with the dream accent', () => {
    renderReview();
    expect(screen.getByRole('heading', { level: 2, name: 'Persona edit — tone' })).toBeTruthy();
    expect(document.querySelector('.dream-av--lg')).toBeTruthy();
    const rationale = document.querySelector('.dream-rationale')!;
    expect(rationale.querySelector('.dream-rationale__ic')?.textContent).toBe('✦');
    expect(rationale.textContent).toContain('short, warm bursts');
    expect(document.querySelector('.dream-rhead__meta')?.textContent).toContain('suggested 2h ago');
  });

  it('renders the diff with section heads and del/add/keep line recipes', () => {
    renderReview();
    const diff = document.querySelector('.dream-diff')!;
    const secs = diff.querySelectorAll('.dream-diff__sec');
    expect(Array.from(secs).map((s) => s.textContent)).toEqual(['Tone', 'Formatting']);
    expect(diff.querySelector('.dream-diff__line--del')?.textContent).toContain('complete and professional');
    expect(diff.querySelector('.dream-diff__line--add')?.textContent).toContain('short and warm');
    expect(diff.querySelector('.dream-diff__line--keep')?.textContent).toContain('Never sacrifice accuracy');
    expect(document.querySelector('.dream-panel__tag')?.textContent).toBe('SOUL.md — persona section');
  });

  it('renders the impact columns from the fixture data', () => {
    renderReview();
    const impact = document.querySelector('.dream-impact')!;
    expect(impact.textContent).toContain('Quinn · all instances');
    expect(impact.textContent).toContain('one-click rollback');
    expect(impact.textContent).toContain('low — tone only');
  });

  it('decision actions fire the decide callback with the dream id', () => {
    const decide = vi.fn();
    renderReview(decide);
    fireEvent.click(screen.getByRole('button', { name: /approve & apply/i }));
    expect(decide).toHaveBeenCalledWith('d-1', 'approved');
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    expect(decide).toHaveBeenCalledWith('d-1', 'rejected');
  });

  it('kind vocab: skills and routine dreams title correctly', () => {
    const { unmount } = render(
      <MemoryRouter>
        <DreamReview dream={makeDream({ id: 'd-2', kind: 'skills', summary: 'add calendar-read' })} metaLine="m" onDecide={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Skills edit — add calendar-read' })).toBeTruthy();
    unmount();
    render(
      <MemoryRouter>
        <DreamReview dream={makeDream({ id: 'd-3', kind: 'routine', summary: 'daily summary' })} metaLine="m" onDecide={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Routine edit — daily summary' })).toBeTruthy();
  });
});
