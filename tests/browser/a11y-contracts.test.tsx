/**
 * @file tests/browser/a11y-contracts.test.tsx
 *
 * D1.3 browser a11y-contract lane.
 *
 * This is not an axe gate. It proves real-browser contracts that jsdom cannot:
 * trusted keyboard focus-visible, top-layer Escape behavior, App-shell
 * landmark ownership with route sentinels, and reduced-height focus-ring
 * visibility.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import { MemoryRouter } from 'react-router-dom';
import '../../console/src/index.css';

// ---------------------------------------------------------------------------
// App-shell mocks. Keep explicit-shape factories; browser-mode vi.mock cannot
// rely on async importOriginal spread factories reliably. Route mocks are
// sentinels: they prove the shell does not duplicate landmarks/headings, not
// each real page's final content.
// ---------------------------------------------------------------------------

vi.mock('../../console/src/hooks/use-console-session', () => ({
  useConsoleSession: () => ({
    state: 'unlocked',
    onLock: vi.fn(),
    onUnlocked: vi.fn(),
  }),
}));

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: () => ({ data: [] }),
}));

vi.mock('../../console/src/hooks/use-update-check', () => ({
  getStaticVersion: () => 'test-sha',
  useUpdateCheck: () => ({
    data: null,
    showUpdateModal: false,
    openUpdateModal: vi.fn(),
    closeUpdateModal: vi.fn(),
  }),
}));

vi.mock('../../console/src/hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcuts: () => undefined,
}));

vi.mock('../../console/src/components/UpdateModal', () => ({
  default: () => null,
}));

vi.mock('../../console/src/pages/SoupKitchen', () => ({
  default: () => <section aria-label="Fleet route"><h1>Fleet</h1></section>,
}));

vi.mock('../../console/src/pages/LineDetail', () => ({
  default: () => <section aria-label="Line route"><h1>Line detail</h1></section>,
}));

vi.mock('../../console/src/pages/Inbox', () => ({
  default: () => <section aria-label="Inbox route"><h1>Inbox</h1></section>,
}));

// Deployments graduated from the stub at T5 b-08: mocked here with the same
// landmark-shaped sentinel so the app-shell law stays pinned per-route.
vi.mock('../../console/src/pages/Deployments', () => ({
  default: () => <section aria-label="Deployments route"><h1>Deployments</h1></section>,
}));

vi.mock('../../console/src/pages/Operator', () => ({
  default: () => <section aria-label="Ops route"><h1>Ops</h1></section>,
}));

// T5 b-04: /agents graduated off SurfaceStub onto the real surface — mock it
// like the other graduated pages (landmark law is pinned app-shell-wide; the
// surface's own contracts live in tests/console/agents.test.tsx).
vi.mock('../../console/src/pages/Agents', () => ({
  default: () => <section aria-label="Agents route"><h1>Agents</h1></section>,
}));

// T5 b-05: /skills graduated off SurfaceStub onto the real surface — mock it
// like the other graduated pages (landmark law is pinned app-shell-wide; the
// surface's own contracts live in tests/console/skills-hub.test.tsx).
vi.mock('../../console/src/pages/SkillsHub', () => ({
  default: () => <section aria-label="Skills Hub route"><h1>Skills Hub</h1></section>,
}));

// T5 b-06: /dream-lab graduated off SurfaceStub onto the real surface — mock
// it like the other graduated pages (landmark law is pinned app-shell-wide;
// the surface's own contracts live in tests/console/dream-lab.test.tsx).
vi.mock('../../console/src/pages/DreamLab', () => ({
  default: () => <section aria-label="Dream Lab route"><h1>Dream Lab</h1></section>,
}));

// ChatPicker reaches lib/api for async contact search. Stub it so the browser
// network sentinel remains quiet.
vi.mock('../../console/src/lib/api', () => ({
  isProductionConsole: () => false,
  unlockConsole: vi.fn(() => Promise.resolve({ expiresIn: 3600 })),
  lockConsole: vi.fn(() => Promise.resolve()),
  getApiTicket: vi.fn(() => Promise.resolve('browser-test-ticket')),
  api: {
    searchContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
    restart: vi.fn(() => Promise.resolve()),
    deleteLine: vi.fn(() => Promise.resolve()),
  },
}));

import App from '../../console/src/App';
import { ToastProvider } from '../../console/src/hooks/use-toast';
import { ChatPicker } from '../../console/src/components/shared/ChatPicker';
import ChatList from '../../console/src/components/ChatList';
import { Button, Modal, ModalBody, ModalFooter, ModalHeader } from '../../console/src/components/primitives';
import type { ChatItem } from '../../console/src/types';

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await page.viewport(1280, 800);
});

async function waitForDom(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeChat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    conversationKey: overrides.conversationKey ?? 'conv-1',
    name: overrides.name ?? 'Alice',
    lastMessagePreview: '',
    lastMessageAt: new Date().toISOString(),
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  };
}

const CHATS: ChatItem[] = [
  makeChat({ conversationKey: 'conv-alice', name: 'Alice' }),
  makeChat({ conversationKey: 'conv-bob', name: 'Bob' }),
];

function AppRoute({ path }: { path: string }) {
  // App calls useToast at the shell level (connection-status reconnect toast),
  // mirroring production where main.tsx nests ToastProvider above <App />.
  return (
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('D1.3 App-shell landmark contract', () => {
  const routes = [
    ['Fleet', '/'],
    ['Line detail', '/lines/support'],
    ['Inbox', '/inbox'],
    ['Ops', '/ops'],
    ['Agents', '/agents'],
    ['Skills Hub', '/skills'],
    ['Dream Lab', '/dream-lab'],
    ['Deployments', '/deployments'],
    ['Settings', '/settings'],
  ] as const;

  for (const [heading, path] of routes) {
    it(`${path} exposes exactly one app-owned main landmark and a route sentinel heading`, async () => {
      await render(<AppRoute path={path} />);
      await waitForDom(() => {
        const main = document.querySelector('main');
        return main?.textContent?.includes(heading) ?? false;
      }, `${path} route`);

      const mains = document.querySelectorAll('main');
      expect(mains).toHaveLength(1);
      expect(mains[0].textContent).toContain(heading);
      expect(document.querySelectorAll('nav[aria-label="Main navigation"]')).toHaveLength(1);
      expect(document.querySelectorAll('h1')).toHaveLength(1);
    });
  }
});

describe('D1.3 Escape stack contract', () => {
  function ModalWithChatPicker({ onClose }: { onClose: () => void }) {
    return (
      <Modal open onClose={onClose} size="md">
        <ModalHeader title="Schedule message" onClose={onClose} />
        <ModalBody>
          <ChatPicker
            chats={CHATS}
            selected={null}
            onSelect={vi.fn()}
            onClear={vi.fn()}
            placeholder="Choose chat"
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="neutral" onClick={onClose}>Cancel</Button>
        </ModalFooter>
      </Modal>
    );
  }

  it('Escape closes the open Popover first and leaves the Modal open; next Escape closes the Modal', async () => {
    const onClose = vi.fn();
    const { getByRole } = await render(<ModalWithChatPicker onClose={onClose} />);

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();

    const combobox = getByRole('combobox');
    await userEvent.click(combobox);
    await userEvent.keyboard('{ArrowDown}');
    expect(combobox.element().getAttribute('aria-expanded')).toBe('true');

    await userEvent.keyboard('{Escape}');
    expect(combobox.element().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onClose).toHaveBeenCalledTimes(0);

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('D1.3 trusted focus-visible and clipping contract', () => {
  function assertVisibleFocusBox(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const styles = window.getComputedStyle(el);
    const outlineWidth = Number.parseFloat(styles.outlineWidth) || 0;
    const outlineOffset = Number.parseFloat(styles.outlineOffset) || 0;
    const halo = Math.max(0, outlineWidth + Math.abs(outlineOffset));

    expect(el.matches(':focus-visible')).toBe(true);
    expect(rect.left - halo).toBeGreaterThanOrEqual(0);
    expect(rect.top - halo).toBeGreaterThanOrEqual(0);
    expect(rect.right + halo).toBeLessThanOrEqual(window.innerWidth);
    expect(rect.bottom + halo).toBeLessThanOrEqual(window.innerHeight);
  }

  it('trusted Tab focus-visible ring remains inside the reduced-height viewport', async () => {
    await page.viewport(390, 480);
    const { getByRole } = await render(
      <div style={{ minHeight: '480px', padding: '96px 24px' }}>
        <Button variant="primary">Keyboard action</Button>
      </div>,
    );

    await userEvent.tab();
    const button = getByRole('button', { name: 'Keyboard action' }).element() as HTMLElement;
    expect(document.activeElement).toBe(button);
    assertVisibleFocusBox(button);
  });

  it('Modal focus path keeps focused controls inside viewport at reduced height', async () => {
    await page.viewport(390, 480);
    await render(
      <Modal open onClose={() => undefined} size="sm">
        <ModalHeader title="Viewport fit" onClose={() => undefined} />
        <ModalBody>
          <p>Short modal body.</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="primary">Apply</Button>
        </ModalFooter>
      </Modal>,
    );

    await userEvent.tab();
    const active = document.activeElement as HTMLElement | null;
    expect(active?.tagName).toBe('BUTTON');
    assertVisibleFocusBox(active!);
  });

  it('ChatList option rows expose a visible focus treatment under trusted Tab focus', async () => {
    const { getByRole } = await render(
      <ChatList chats={CHATS} selectedChat={null} onSelect={vi.fn()} />,
    );

    await userEvent.tab();
    const row = getByRole('option', { name: 'Open conversation with Alice' }).element() as HTMLElement;
    const styles = window.getComputedStyle(row);

    expect(document.activeElement).toBe(row);
    expect(row.matches(':focus-visible')).toBe(true);
    expect(styles.outlineStyle).not.toBe('none');
    expect(styles.outlineWidth).not.toBe('0px');
    expect(styles.boxShadow).not.toBe('none');
  });
});
