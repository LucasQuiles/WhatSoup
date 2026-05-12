/**
 * GroupsTab — behavior coverage for console/src/components/line-detail/GroupsTab.tsx.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { GroupInfo } from '../../console/src/types';

const getGroupsMock = vi.fn();

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getGroups: (...args: [string]) => getGroupsMock(...args),
  },
}));

const groupDetailModalProps = vi.fn();
const createGroupModalProps = vi.fn();

vi.mock('../../console/src/components/line-detail/GroupDetailModal', () => ({
  GroupDetailModal: (props: { open: boolean; group: GroupInfo | null; onClose: () => void }) => {
    groupDetailModalProps(props);
    return props.open ? (
      <div data-testid="group-detail-modal">
        <span data-testid="group-detail-subject">{props.group?.subject ?? ''}</span>
        <button type="button" onClick={props.onClose}>close-detail</button>
      </div>
    ) : null;
  },
}));

vi.mock('../../console/src/components/line-detail/CreateGroupModal', () => ({
  CreateGroupModal: (props: { open: boolean; onClose: () => void; onCreated: () => void }) => {
    createGroupModalProps(props);
    return props.open ? (
      <div data-testid="create-group-modal">
        <button type="button" onClick={props.onClose}>close-create</button>
        <button type="button" onClick={props.onCreated}>fire-created</button>
      </div>
    ) : null;
  },
}));

// Import after vi.mock so the component picks up the mocked modules.
const { GroupsTab } = await import('../../console/src/components/line-detail/GroupsTab');

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
    },
  });
}

function Wrapper({ client, children }: { client: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Synthetic JIDs (hygiene-guard friendly):
// - user JIDs start with 1555 (whitelisted)
// - group JIDs avoid the 120363\d{6,}@g.us shape
const groupA: GroupInfo = {
  id: '1555000001@g.us',
  subject: 'Team Atlas',
  participants: [
    { id: '1555000111@s.whatsapp.net' },
    { id: '1555000112@s.whatsapp.net', admin: 'admin' },
  ],
};

const groupB: GroupInfo = {
  id: '1555000002@g.us',
  subject: 'Solo Channel',
  participants: [{ id: '1555000113@s.whatsapp.net' }],
};

beforeEach(() => {
  getGroupsMock.mockReset();
  groupDetailModalProps.mockReset();
  createGroupModalProps.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('GroupsTab', () => {
  it('does not call getGroups when lineName is empty (query disabled)', () => {
    const client = makeClient();
    getGroupsMock.mockResolvedValue({ groups: [] });

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="" />
      </Wrapper>,
    );

    expect(getGroupsMock).not.toHaveBeenCalled();
    // Header still renders zero-count text with no groups.
    expect(screen.getByText('0 groups')).toBeTruthy();
    expect(screen.getByText('No groups')).toBeTruthy();
  });

  it('shows a loading EmptyState while the groups query is pending', async () => {
    const client = makeClient();
    const pending = deferred<{ groups: GroupInfo[] }>();
    getGroupsMock.mockReturnValue(pending.promise);

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" />
      </Wrapper>,
    );

    await waitFor(() => expect(getGroupsMock).toHaveBeenCalledTimes(1));
    expect(getGroupsMock).toHaveBeenCalledWith('line-a');
    expect(screen.getByText('Loading groups...')).toBeTruthy();
    // Header bar is suppressed during the loading state.
    expect(screen.queryByRole('button', { name: /Create Group/ })).toBeNull();

    pending.resolve({ groups: [] });
    await waitFor(() => expect(screen.queryByText('Loading groups...')).toBeNull());
  });

  it('renders the empty "No groups" state and a singular header when zero groups are returned', async () => {
    const client = makeClient();
    getGroupsMock.mockResolvedValue({ groups: [] });

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('No groups')).toBeTruthy());
    expect(screen.getByText('0 groups')).toBeTruthy();
    expect(screen.getByText('Groups this instance participates in will appear here.')).toBeTruthy();
    // Create Group control is visible in the empty state.
    expect(screen.getByRole('button', { name: /Create Group/ })).toBeTruthy();
  });

  it('renders one card per group with subject and participant pluralization', async () => {
    const client = makeClient();
    getGroupsMock.mockResolvedValue({ groups: [groupA, groupB] });

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('Team Atlas')).toBeTruthy());
    expect(screen.getByText('Solo Channel')).toBeTruthy();
    expect(screen.getByText('2 groups')).toBeTruthy();
    // Plural "participants" for groupA (2), singular "participant" for groupB (1).
    expect(screen.getByText(/2 participants/)).toBeTruthy();
    expect(screen.getByText(/1 participant\b/)).toBeTruthy();
    // The "No groups" empty state must not appear when groups exist.
    expect(screen.queryByText('No groups')).toBeNull();
  });

  it('uses singular "1 group" header when exactly one group is returned', async () => {
    const client = makeClient();
    getGroupsMock.mockResolvedValue({ groups: [groupB] });

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('Solo Channel')).toBeTruthy());
    expect(screen.getByText('1 group')).toBeTruthy();
    // Make sure we're not matching the plural form.
    expect(screen.queryByText('1 groups')).toBeNull();
  });

  it('renders an error EmptyState when the query rejects', async () => {
    const client = makeClient();
    getGroupsMock.mockRejectedValue(new Error('socket down'));

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('Failed to load groups')).toBeTruthy());
    expect(screen.getByText('socket down')).toBeTruthy();
    // The header / Create button should not render in the error state.
    expect(screen.queryByRole('button', { name: /Create Group/ })).toBeNull();
  });

  it('falls back to the generic MCP error description when the rejection is not an Error', async () => {
    const client = makeClient();
    getGroupsMock.mockRejectedValue('string-only failure');

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('Failed to load groups')).toBeTruthy());
    expect(screen.getByText('MCP socket may not be available.')).toBeTruthy();
  });

  it('clicking a group card opens GroupDetailModal with that group', async () => {
    const client = makeClient();
    getGroupsMock.mockResolvedValue({ groups: [groupA, groupB] });

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" myJid="1555000112@s.whatsapp.net" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('Team Atlas')).toBeTruthy());
    // GroupDetailModal stays closed before any card is clicked.
    expect(screen.queryByTestId('group-detail-modal')).toBeNull();

    fireEvent.click(screen.getByText('Team Atlas').closest('button')!);

    expect(screen.getByTestId('group-detail-modal')).toBeTruthy();
    expect(screen.getByTestId('group-detail-subject').textContent).toBe('Team Atlas');

    // Closing the modal clears the selected group.
    fireEvent.click(screen.getByText('close-detail'));
    expect(screen.queryByTestId('group-detail-modal')).toBeNull();
  });

  it('clicking Create Group opens CreateGroupModal and closing it dismisses the modal', async () => {
    const client = makeClient();
    getGroupsMock.mockResolvedValue({ groups: [] });

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('No groups')).toBeTruthy());
    expect(screen.queryByTestId('create-group-modal')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Create Group/ }));

    expect(screen.getByTestId('create-group-modal')).toBeTruthy();

    fireEvent.click(screen.getByText('close-create'));
    expect(screen.queryByTestId('create-group-modal')).toBeNull();
  });

  it('CreateGroupModal.onCreated invalidates the groups query for the current line', async () => {
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    getGroupsMock.mockResolvedValue({ groups: [] });

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('No groups')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Create Group/ }));
    fireEvent.click(screen.getByText('fire-created'));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['groups', 'line-a'] });
  });

  it('treats a response without a "groups" field as an empty list', async () => {
    const client = makeClient();
    getGroupsMock.mockResolvedValue({});

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('No groups')).toBeTruthy());
    expect(screen.getByText('0 groups')).toBeTruthy();
  });

  it('forwards myJid through to GroupDetailModal when a group is opened', async () => {
    const client = makeClient();
    getGroupsMock.mockResolvedValue({ groups: [groupA] });

    render(
      <Wrapper client={client}>
        <GroupsTab lineName="line-a" myJid="1555000112@s.whatsapp.net" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('Team Atlas')).toBeTruthy());
    fireEvent.click(screen.getByText('Team Atlas').closest('button')!);

    const lastCall = groupDetailModalProps.mock.calls.at(-1)?.[0] as {
      open: boolean;
      lineName: string;
      myJid?: string;
    };
    expect(lastCall.open).toBe(true);
    expect(lastCall.lineName).toBe('line-a');
    expect(lastCall.myJid).toBe('1555000112@s.whatsapp.net');
  });
});
