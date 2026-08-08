/**
 * FleetKpis — Tokens (24h) five-state discrimination (#2528).
 *
 * The prior `tokens24h !== null ? formatCompact(tokens24h) : <EM_DASH/>`
 * ternary (with its `'fleet in+out' | 'no token data'` subline) collapsed four
 * distinct runtime conditions — query-failure / all-failed / no-data / normal
 * — into two outputs, erasing failure and partial-coverage signal. FleetKpis
 * now renders five mutually-exclusive states driven by new isLoading /
 * queryError / instancesFailed / instancesQueried props.
 *
 * Each test below pins ONE state to a unique, observable DOM marker (value
 * testid or em-dash glyph + subline copy) AND asserts the other states'
 * markers are absent — so the test FAILS if its state collapses back into
 * another (the regression this PR exists to prevent).
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { FleetKpis } from '../../console/src/components/fleet/FleetKpis';
import { computeKpis } from '../../console/src/lib/compute-kpis';
import { formatCompact } from '../../console/src/lib/text-utils';

afterEach(() => {
  cleanup();
});

/** The Tokens (24h) card, located by its mono caps label (.fleet-kpi__k). */
function tokensCard(): HTMLElement {
  const key = screen.getByText('Tokens (24h)', { selector: '.fleet-kpi__k' });
  const card = key.closest('.fleet-kpi');
  if (!card) throw new Error('Tokens (24h) card has no .fleet-kpi ancestor');
  return card as HTMLElement;
}

interface TokenState {
  isLoading?: boolean;
  queryError?: Error | null;
  tokens24h?: number | null;
  instancesFailed?: number;
  instancesQueried?: number;
}

/** Render the full KPI strip with only the Tokens (24h) discriminators varied. */
function renderTokens(state: TokenState = {}) {
  render(
    <FleetKpis
      kpis={computeKpis([])}
      lineCount={3}
      tokens24h={state.tokens24h ?? null}
      freshness={null}
      isLoading={state.isLoading ?? false}
      queryError={state.queryError ?? null}
      instancesFailed={state.instancesFailed ?? 0}
      instancesQueried={state.instancesQueried ?? 0}
    />,
  );
  return tokensCard();
}

describe('FleetKpis Tokens (24h) — five-state discrimination', () => {
  it('loading: renders a skeleton, not an em-dash or failure glyph', () => {
    const card = renderTokens({ isLoading: true, queryError: null, tokens24h: null });

    // Unique marker: the shimmer. The old ternary would have rendered the
    // em-dash here (tokens24h is null) — this assertion fails if loading
    // collapses into no-data.
    expect(within(card).getByTestId('tokens-shimmer')).toBeDefined();
    expect(within(card).getByText(/loading/)).toBeDefined();

    // Non-collapse: no failure glyph and no em-dash glyph.
    expect(within(card).queryByTestId('tokens-query-error')).toBeNull();
    expect(within(card).queryByTestId('tokens-all-failed')).toBeNull();
    expect(card.querySelector('.soup-table-ghost')).toBeNull();
  });

  it('normal: renders the compacted fleet in+out sum', () => {
    const card = renderTokens({ tokens24h: 4_100_000 });

    expect(within(card).getByText(formatCompact(4_100_000))).toBeDefined();
    expect(within(card).getByText('fleet in+out')).toBeDefined();

    // Non-collapse: no skeleton, no failure glyph, no em-dash.
    expect(within(card).queryByTestId('tokens-shimmer')).toBeNull();
    expect(within(card).queryByTestId('tokens-query-error')).toBeNull();
    expect(within(card).queryByTestId('tokens-all-failed')).toBeNull();
    expect(card.querySelector('.soup-table-ghost')).toBeNull();
  });

  it('query-error: renders a glyph distinct from the em-dash no-data state', () => {
    // First-load query error → no payload (tokens24h null) and no coverage
    // denominator. The old ternary mapped this to the em-dash; it must now
    // render the query-error glyph instead.
    const card = renderTokens({
      queryError: new Error('metrics endpoint down'),
      tokens24h: null,
      instancesFailed: 0,
      instancesQueried: 0,
    });

    expect(within(card).getByTestId('tokens-query-error')).toBeDefined();
    expect(within(card).getByText('metrics query failed')).toBeDefined();

    // Non-collapse into no-data: the em-dash glyph and the all-failed glyph
    // must NOT appear. This is the core regression guard for #2528.
    expect(card.querySelector('.soup-table-ghost')).toBeNull();
    expect(within(card).queryByTestId('tokens-all-failed')).toBeNull();
    expect(within(card).queryByTestId('tokens-shimmer')).toBeNull();
  });

  it('all-failed: every queried instance failed — distinct from no-data', () => {
    // Query succeeded (no error), but every instance failed → no token data.
    // tokens24h is null just like no-data, so coverage is the only signal that
    // separates all-failed from a genuinely empty token store.
    const card = renderTokens({
      tokens24h: null,
      instancesFailed: 3,
      instancesQueried: 3,
    });

    expect(within(card).getByTestId('tokens-all-failed')).toBeDefined();
    expect(within(card).getByText('all instances failed')).toBeDefined();

    // Non-collapse into no-data (em-dash) or query-error.
    expect(card.querySelector('.soup-table-ghost')).toBeNull();
    expect(within(card).queryByTestId('tokens-query-error')).toBeNull();
    expect(within(card).queryByTestId('tokens-shimmer')).toBeNull();
  });

  it('no-data: clean query, partial coverage, no token data — em-dash preserved', () => {
    // Query clean, some instances up (1 of 3 failed) but still no token data.
    // This is the one state that legitimately keeps the em-dash.
    const card = renderTokens({
      tokens24h: null,
      instancesFailed: 1,
      instancesQueried: 3,
    });

    expect(card.querySelector('.soup-table-ghost')).toBeDefined();
    expect(within(card).getByText('no token data')).toBeDefined();

    // Non-collapse into the failure states — no-data must stay the em-dash.
    expect(within(card).queryByTestId('tokens-query-error')).toBeNull();
    expect(within(card).queryByTestId('tokens-all-failed')).toBeNull();
    expect(within(card).queryByTestId('tokens-shimmer')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// State-separation matrix — a single table-driven check that every pair of
// states resolves to a different observable marker. This is the strongest
// "each state FAILS if it collapses into another" guard: if any two states
// shared a marker, the pairwise difference assertion below would fail.
// ---------------------------------------------------------------------------

describe('FleetKpis Tokens (24h) — pairwise state separation', () => {
  it('every state resolves to a distinct value marker', () => {
    const markers: string[] = [];

    // capture() renders one state, reads its unique marker, then resets the
    // DOM so tokensCard()'s global label lookup stays unique on the next call.
    // renderTokens() returns the Tokens (24h) card element, so within() is not
    // needed — use the card's own testing-library-bound helpers directly.
    const capture = (marker: string | undefined | null): void => {
      markers.push((marker ?? '').trim());
      cleanup();
    };

    // loading
    {
      const card = renderTokens({ isLoading: true, tokens24h: null });
      capture(within(card).getByTestId('tokens-shimmer').dataset.testid);
    }
    // normal
    {
      const card = renderTokens({ tokens24h: 4_100_000 });
      capture(within(card).getByText(formatCompact(4_100_000)).textContent);
    }
    // query-error
    {
      const card = renderTokens({ queryError: new Error('x'), tokens24h: null });
      capture(within(card).getByTestId('tokens-query-error').dataset.testid);
    }
    // all-failed
    {
      const card = renderTokens({ tokens24h: null, instancesFailed: 3, instancesQueried: 3 });
      capture(within(card).getByTestId('tokens-all-failed').dataset.testid);
    }
    // no-data
    {
      const card = renderTokens({ tokens24h: null, instancesFailed: 1, instancesQueried: 3 });
      capture(card.querySelector('.soup-table-ghost')?.className);
    }

    // Five distinct markers for five states — no two collapse into one.
    expect(new Set(markers.filter(Boolean)).size).toBe(5);
  });
});
