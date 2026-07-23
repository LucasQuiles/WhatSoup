/**
 * Agents surface (T5 b-04) — jsdom contracts against the mockup agents.html
 * anatomy: roster cards (avatar + kind + presence shape + meta), hatch card,
 * detail head (xl avatar, h2, presence pill, soul, meta), and the six panels
 * (Brain + swapbar, Tool toggles, Assigned lines, Instances, Skills, Memory).
 *
 * Honesty law pins: no fabricated archetypes/dreams/grants/memory stats;
 * unavailable data renders EM_DASH or an explicit note, never invented
 * numbers. Presence maps from REAL line status only.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { cleanup, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Module mocks — hooks + api (no network), realtime inert, wizard stubbed.
// ---------------------------------------------------------------------------

const useLinesMock = vi.hoisted(() => vi.fn());
const useLineMock = vi.hoisted(() => vi.fn());
const useProviderStatusMock = vi.hoisted(() => vi.fn());
const useLiveSessionsMock = vi.hoisted(() => vi.fn());

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: useLinesMock,
  useLine: useLineMock,
  useProviderStatus: useProviderStatusMock,
  useLiveSessions: useLiveSessionsMock,
}));

const updateConfigMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('../../console/src/lib/api', () => ({
  api: { updateConfig: updateConfigMock },
}));

vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: false }),
}));

vi.mock('../../console/src/components/AddLineWizard', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="hatch-wizard">wizard</div> : null),
}));

import Agents from '../../console/src/pages/Agents';
import { AgentAvatar, AgentPresenceShape } from '../../console/src/components/agents/AgentAvatar';
import { agentHueIndex, agentInitials } from '../../console/src/components/agents/agent-hue';
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context';
import type { LineInstance, LiveSessionsPayload, ProviderStatus } from '../../console/src/types';

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Fixtures + render helper
// ---------------------------------------------------------------------------

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
};

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'quinn',
    phone: '+15550001234',
    mode: 'agent',
    status: 'online',
    accessMode: 'open',
    healthPort: 9100,
    uptime: '2h',
    messagesTotal: 128,
    health: null,
    heartbeat: [],
    lastActive: new Date().toISOString(),
    error: null,
    ...overrides,
  };
}

function makeProviderStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    primary: { provider: 'test-provider', model: 'test-model-1', keyPresent: true },
    fallback: {
      provider: 'fallback-provider',
      model: 'fallback-model-1',
      keyPresent: true,
      active: false,
      activeUntil: null,
      effectiveProvider: null,
      turnsServed: null,
      turnsEmpty: null,
      probeAttempts: null,
      lastTurnAt: null,
    } as ProviderStatus['fallback'],
    ...overrides,
  } as ProviderStatus;
}

function makeSessions(payload: Partial<LiveSessionsPayload> = {}): LiveSessionsPayload {
  return {
    observedAt: new Date().toISOString(),
    anomalyCount: 0,
    sessions: [],
    ...payload,
  };
}

function LocationProbe(): ReactElement | null {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter initialEntries={['/agents']}>
          <Routes>
            <Route path="/agents" element={<Agents />} />
            <Route path="/lines/:name" element={<div data-testid="line-detail" />} />
            <Route path="/skills" element={<div data-testid="skills-hub" />} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </ToastContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useLinesMock.mockReturnValue({ data: [makeLine()] });
  useLineMock.mockReturnValue({
    data: makeLine({
      // detail payload extras (config rides the detail endpoint)
      // @ts-expect-error -- the list type omits the detail-only `config` field; expires 2026-12-31
      config: {
        claudeMd: '# Quinn\n\nKeeps the room tidy, answers fast.',
        agentOptions: {
          provider: 'test-provider',
          model: 'test-model-1',
          sessionScope: 'per_chat',
          sandboxPerChat: true,
          sandbox: { bash: { enabled: true, pathRestricted: true } },
          mcp: { send_media: false },
          enabledPlugins: { 'commit-commands@test-hub': true, 'plugin-dev@test-hub': false },
        },
        memory: { pinecone: { index: 'test-index' }, conversation: { recent: 20 } },
      },
    }),
  });
  useProviderStatusMock.mockReturnValue({ data: makeProviderStatus() });
  useLiveSessionsMock.mockReturnValue({ data: makeSessions() });
});

// ---------------------------------------------------------------------------
// Page row + roster
// ---------------------------------------------------------------------------

describe('page row (single-h1 law + hatch action)', () => {
  it('the surface owns exactly one h1 and the crumb names the selected agent', () => {
    renderPage();
    const h1s = document.querySelectorAll('h1');
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe('Agents');
    expect(document.querySelector('.agents-crumb')?.textContent).toContain('ROSTER /');
  });

  it('Hatch agent opens the creation wizard', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /hatch agent/i }));
    expect(await screen.findByTestId('hatch-wizard')).toBeTruthy();
  });
});

describe('roster (mockup .acard anatomy)', () => {
  it('renders one card per agent-mode line and excludes chat/passive lines', () => {
    useLinesMock.mockReturnValue({
      data: [
        makeLine({ name: 'quinn' }),
        makeLine({ name: 'lumen' }),
        makeLine({ name: 'chatline', mode: 'chat' }),
        makeLine({ name: 'quietline', mode: 'passive' }),
      ],
    });
    renderPage();
    const cards = document.querySelectorAll('.agents-roster .agents-acard:not(.agents-acard--hatch)');
    expect(cards.length).toBe(2);
    expect(screen.queryByText('chatline')).toBeNull();
  });

  it('maps real line status to the §4 presence shapes — never color-only', () => {
    useLinesMock.mockReturnValue({
      data: [
        makeLine({ name: 'liveone', status: 'online', health: { status: 'ok', uptime_seconds: 1, messages_total: 1, whatsapp: { connected: true, connection: { state: 'connected' } }, sqlite: { messages_total: 1, schema_version: 42 } } }),
        makeLine({ name: 'slowone', status: 'degraded' }),
        makeLine({ name: 'deadone', status: 'unreachable' }),
      ],
    });
    renderPage();
    expect(document.querySelector('.agents-presence--live')).toBeTruthy();
    expect(document.querySelector('.agents-presence--paused')).toBeTruthy();
    expect(document.querySelector('.agents-presence--deactivated')).toBeTruthy();
  });

  it('selection marks the card aria-pressed and swaps the detail', () => {
    useLinesMock.mockReturnValue({
      data: [makeLine({ name: 'quinn' }), makeLine({ name: 'lumen' })],
    });
    renderPage();
    const lumenCard = screen.getByText('lumen').closest('button')!;
    expect(lumenCard.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(lumenCard);
    expect(lumenCard.getAttribute('aria-pressed')).toBe('true');
  });

  it('search narrows by name and phone', () => {
    useLinesMock.mockReturnValue({
      data: [makeLine({ name: 'quinn' }), makeLine({ name: 'lumen', phone: '+15550009999' })],
    });
    renderPage();
    const roster = document.querySelector('.agents-roster') as HTMLElement;
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: '9999' } });
    expect(within(roster).queryByText('quinn')).toBeNull();
    expect(within(roster).getByText('lumen')).toBeTruthy();
    // the selected agent's detail is unaffected by roster search
    expect(screen.getByRole('heading', { level: 2, name: 'quinn' })).toBeTruthy();
  });

  it('the hatch card opens the wizard', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /hatch an agent/i }));
    expect(await screen.findByTestId('hatch-wizard')).toBeTruthy();
  });

  it('empty fleet renders the honest empty state, never phantom agents', () => {
    useLinesMock.mockReturnValue({ data: [] });
    renderPage();
    expect(screen.getByText('No agents hatched yet')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Avatar identity (12-agent-identity §1)
// ---------------------------------------------------------------------------

describe('avatar identity (12-agent-identity §1)', () => {
  it('hue is deterministic per name and inside the locked 8-hue set', () => {
    const a = agentHueIndex('Quinn');
    expect(agentHueIndex('Quinn')).toBe(a);
    expect(agentHueIndex('quinn')).toBe(a); // case-insensitive
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(8);
  });

  it('initials: two words → two letters; one word → two chars; uppercase', () => {
    expect(agentInitials('Quinn Prime')).toBe('QP');
    expect(agentInitials('quinn')).toBe('QU');
    expect(agentInitials('  ')).toBe('?');
  });

  it('avatar fill consumes the agent-hue token, never an inline palette', () => {
    const { container } = render(<AgentAvatar name="Quinn" />);
    const av = container.querySelector('.agents-av') as HTMLElement;
    expect(av.style.background).toMatch(/^var\(--agent-hue-[0-7]\)$/);
  });

  it('presence shape renders separately from the fill with an accessible label', () => {
    const { container } = render(<AgentPresenceShape presence="paused" />);
    const shape = container.querySelector('.agents-presence--paused');
    expect(shape).toBeTruthy();
    expect(shape?.getAttribute('aria-label')).toBe('paused');
  });
});

// ---------------------------------------------------------------------------
// Detail head
// ---------------------------------------------------------------------------

describe('detail head (mockup .dhead)', () => {
  it('renders the h2, presence pill, soul from the real persona config, and meta', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 2, name: 'quinn' })).toBeTruthy();
    const pill = document.querySelector('.agents-pill');
    expect(pill?.textContent).toMatch(/deactivated|paused|live/);
    // soul = first non-heading line of the config's claudeMd, quoted
    expect(document.querySelector('.agents-dhead__soul')?.textContent).toContain('Keeps the room tidy');
    expect(document.querySelector('.agents-dhead__sub')?.textContent).toContain('test-provider');
  });

  it('omits the soul line when the config carries no persona — never fabricated', () => {
    useLineMock.mockReturnValue({ data: makeLine() });
    renderPage();
    expect(document.querySelector('.agents-dhead__soul')).toBeNull();
  });

  it('Open line navigates to the line detail', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /open line/i }));
    expect(screen.getByTestId('location').textContent).toBe('/lines/quinn');
  });
});

// ---------------------------------------------------------------------------
// Brain panel + swapbar
// ---------------------------------------------------------------------------

describe('brain panel (mockup kv + swapbar)', () => {
  it('renders provider/model/fallback from the provider-status payload', () => {
    renderPage();
    const panel = screen.getByText('Brain').closest('.agents-panel')!;
    expect(within(panel as HTMLElement).getByText('test-provider')).toBeTruthy();
    expect(within(panel as HTMLElement).getAllByText('test-model-1').length).toBeGreaterThan(0);
    expect(panel.textContent).toContain('fallback-provider');
  });

  it('marks a live fallback window honestly', () => {
    useProviderStatusMock.mockReturnValue({
      data: makeProviderStatus({
        fallback: { ...makeProviderStatus().fallback, active: true } as ProviderStatus['fallback'],
      }),
    });
    renderPage();
    const panel = screen.getByText('Brain').closest('.agents-panel')!;
    expect(panel.textContent).toContain('serving now');
  });

  it('renders EM_DASH when the payload is absent — never an invented brain', () => {
    useProviderStatusMock.mockReturnValue({ data: undefined });
    renderPage();
    const panel = screen.getByText('Brain').closest('.agents-panel')!;
    expect(panel.textContent).toContain('—');
  });

  it('swap writes agentOptions.model via configUpdate and reports success', async () => {
    renderPage();
    const input = screen.getByLabelText('new model');
    fireEvent.change(input, { target: { value: 'test-model-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => {
      expect(updateConfigMock).toHaveBeenCalledWith('quinn', { agentOptions: { model: 'test-model-2' } });
    });
    expect(toastValue.success).toHaveBeenCalled();
  });

  it('swap stays disabled with an empty draft', () => {
    renderPage();
    const swap = screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement;
    expect(swap.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool permissions panel
// ---------------------------------------------------------------------------

describe('tool permissions (mockup .trow/.tgl)', () => {
  it('renders toggles only for knobs the config declares', () => {
    renderPage();
    expect(screen.getByRole('switch', { name: 'Shell' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'MCP send media' })).toBeTruthy();
    // sandboxPerChat + memory are read-only states
    expect(screen.getByRole('switch', { name: /sandbox per chat/i })).toBeTruthy();
  });

  it('bash toggle writes the deep-merge-safe patch', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('switch', { name: 'Shell' }));
    await waitFor(() => {
      expect(updateConfigMock).toHaveBeenCalledWith('quinn', {
        agentOptions: { sandbox: { bash: { enabled: false } } },
      });
    });
  });

  it('read-only rows are disabled with an honest aria note', () => {
    renderPage();
    const ro = screen.getByRole('switch', { name: /sandbox per chat \(read-only/i });
    expect((ro as HTMLButtonElement).disabled).toBe(true);
  });

  it('no declared knobs renders the honest empty note', () => {
    useLineMock.mockReturnValue({
      data: makeLine({
        // @ts-expect-error -- detail-only `config` field (see beforeEach fixture); expires 2026-12-31
        config: { agentOptions: {} },
      }),
    });
    renderPage();
    expect(screen.getByText(/No tool knobs declared/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Assigned lines panel
// ---------------------------------------------------------------------------

describe('assigned lines (mockup .lrow/.g)', () => {
  it('renders the bound line with the hidden-by-default grant chip (R3-13)', () => {
    renderPage();
    const panel = screen.getByText('Assigned lines').closest('.agents-panel')!;
    expect(panel.textContent).toContain('quinn');
    const chip = panel.querySelector('.agents-grant--hid');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('title')).toContain('Grant API');
  });

  it('channel label comes from the generic transport kind, capitalized', () => {
    useLinesMock.mockReturnValue({
      data: [
        makeLine({
          health: {
            status: 'ok',
            uptime_seconds: 1,
            messages_total: 1,
            transport: { kind: 'signal' },
            sqlite: { messages_total: 1, schema_version: 42 },
          },
        }),
      ],
    });
    renderPage();
    const panel = screen.getByText('Assigned lines').closest('.agents-panel')!;
    expect(panel.textContent).toContain('Signal');
  });
});

// ---------------------------------------------------------------------------
// Instances panel
// ---------------------------------------------------------------------------

describe('instances (mockup .irow)', () => {
  const session = (over = {}) => ({
    conversationKey: '1555000001000@g.us',
    sessionStatus: 'active',
    resumable: true,
    claudePid: 4242,
    pidAlive: true,
    pidState: 'S',
    pidEtimeSeconds: 125,
    anomaly: null,
    ...over,
  });

  it('renders rows with masked conversation ids and process ages', () => {
    useLiveSessionsMock.mockReturnValue({
      data: makeSessions({ sessions: [session()] }),
    });
    renderPage();
    const panel = screen.getByText('Instances').closest('.agents-panel')!;
    expect(panel.textContent).toContain('15550000···000@g.us');
    expect(panel.textContent).not.toContain('1555000001000@g.us');
    expect(panel.textContent).toContain('2m');
  });

  it('flags anomalies and dead pids with shape, not color-only', () => {
    useLiveSessionsMock.mockReturnValue({
      data: makeSessions({
        sessions: [
          session({ conversationKey: '1555000002111@g.us', pidAlive: false, anomaly: 'resumable-but-pid-dead' }),
          session({ conversationKey: '1555111222333@s.whatsapp.net', sessionStatus: 'paused' }),
        ],
        anomalyCount: 1,
      }),
    });
    renderPage();
    const panel = screen.getByText('Instances').closest('.agents-panel')!;
    expect(panel.querySelector('.agents-irow__st--dead')).toBeTruthy();
    expect(panel.querySelector('.agents-irow__st--paused')).toBeTruthy();
    expect(panel.textContent).toContain('resumable-but-pid-dead');
  });

  it('collapses beyond four rows and expands on demand', () => {
    useLiveSessionsMock.mockReturnValue({
      data: makeSessions({
        sessions: [1, 2, 3, 4, 5, 6].map((i) => session({ conversationKey: `cid${i}333444555@g.us` })),
      }),
    });
    renderPage();
    expect(screen.getByRole('button', { name: /show all 6 instances/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /show all 6 instances/i }));
    expect(screen.getByRole('button', { name: /show fewer/i })).toBeTruthy();
  });

  it('probe failure renders the honest failure note — never a fake calm empty', () => {
    useLiveSessionsMock.mockReturnValue({
      data: makeSessions({ probeError: true }),
    });
    renderPage();
    expect(screen.getByText(/Session probe failed/)).toBeTruthy();
  });

  it('pause/kill actions are replaced by the honest no-endpoint note', () => {
    renderPage();
    const panel = screen.getByText('Instances').closest('.agents-panel')!;
    expect(panel.textContent).toContain('session-control API');
    expect(within(panel as HTMLElement).queryByRole('button', { name: /kill/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Skills panel
// ---------------------------------------------------------------------------

describe('skills (mockup .chips)', () => {
  it('renders declared plugins with on/off state from the config', () => {
    renderPage();
    const panel = screen.getByText('Skills').closest('.agents-panel')!;
    expect(panel.textContent).toContain('commit-commands@test-hub');
    expect(panel.textContent).toContain('plugin-dev@test-hub');
  });

  it('add from Hub navigates to the Skills surface', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /add from Hub/i }));
    expect(screen.getByTestId('location').textContent).toBe('/skills');
  });

  it('no declared plugins renders the honest default note', () => {
    useLineMock.mockReturnValue({
      data: makeLine({
        // @ts-expect-error -- detail-only `config` field (see beforeEach fixture); expires 2026-12-31
        config: { agentOptions: {} },
      }),
    });
    renderPage();
    expect(screen.getByText(/No plugins declared/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Memory panel
// ---------------------------------------------------------------------------

describe('memory (mockup .mem-stats)', () => {
  it('vector count is always EM_DASH until the fleet API instruments the store', () => {
    renderPage();
    const panel = screen.getByText('Memory').closest('.agents-panel')!;
    expect(panel.textContent).toContain('not instrumented');
    expect(panel.textContent).toContain('test-index');
  });

  it('absent memory config renders honest no-config states', () => {
    useLineMock.mockReturnValue({ data: makeLine() });
    renderPage();
    const panel = screen.getByText('Memory').closest('.agents-panel')!;
    expect(panel.textContent).toContain('no vector store configured');
  });
});
