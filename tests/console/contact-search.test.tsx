/**
 * ContactSearch — behavior coverage for console/src/components/ContactSearch.tsx.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ContactResult } from '../../console/src/types';

const searchContactsMock = vi.fn();

vi.mock('../../console/src/lib/api', () => ({
  api: {
    searchContacts: (...args: [string, string]) => searchContactsMock(...args),
  },
}));

// Import after vi.mock so the component picks up the mocked module.
const { ContactSearch } = await import('../../console/src/components/ContactSearch');

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sampleContacts: ContactResult[] = [
  { jid: '111@s.whatsapp.net', name: 'Alice', number: '+1 555 0001' },
  { jid: '222@s.whatsapp.net', notify: 'BobNotify', number: '+1 555 0002' },
  { jid: '333@s.whatsapp.net' },
];

beforeEach(() => {
  searchContactsMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ContactSearch', () => {
  it('renders empty initial state with disabled Go button and no result rows', () => {
    render(<ContactSearch lineName="line-a" />);

    const input = screen.getByPlaceholderText('Search contacts...') as HTMLInputElement;
    const goButton = screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement;

    expect(input.value).toBe('');
    expect(goButton.disabled).toBe(true);
    expect(screen.queryByText('No contacts found')).toBeNull();
    expect(searchContactsMock).not.toHaveBeenCalled();
  });

  it('does not invoke api when query is only whitespace or lineName is empty', async () => {
    const { rerender } = render(<ContactSearch lineName="line-a" />);
    const input = screen.getByPlaceholderText('Search contacts...');

    fireEvent.change(input, { target: { value: '   ' } });
    const goButton = screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement;
    expect(goButton.disabled).toBe(true);

    fireEvent.click(goButton);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(searchContactsMock).not.toHaveBeenCalled();

    // Same guard with empty lineName even when query has content.
    rerender(<ContactSearch lineName="" />);
    const input2 = screen.getByPlaceholderText('Search contacts...');
    fireEvent.change(input2, { target: { value: 'alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(searchContactsMock).not.toHaveBeenCalled();
  });

  it('clicking Go triggers searchContacts with trimmed query and lineName', async () => {
    searchContactsMock.mockResolvedValue({ contacts: sampleContacts });

    render(<ContactSearch lineName="line-a" />);
    const input = screen.getByPlaceholderText('Search contacts...');
    fireEvent.change(input, { target: { value: '  Alice  ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => {
      expect(searchContactsMock).toHaveBeenCalledTimes(1);
    });
    expect(searchContactsMock).toHaveBeenCalledWith('line-a', 'Alice');
  });

  it('pressing Enter inside the input triggers a search', async () => {
    searchContactsMock.mockResolvedValue({ contacts: [] });

    render(<ContactSearch lineName="line-a" />);
    const input = screen.getByPlaceholderText('Search contacts...');
    fireEvent.change(input, { target: { value: 'bob' } });

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(searchContactsMock).toHaveBeenCalledTimes(1);
    });
    expect(searchContactsMock).toHaveBeenCalledWith('line-a', 'bob');
  });

  it('shows a loading spinner and disables Go while the search is pending', async () => {
    const pending = deferred<{ contacts: ContactResult[] }>();
    searchContactsMock.mockReturnValue(pending.promise);

    render(<ContactSearch lineName="line-a" />);
    const input = screen.getByPlaceholderText('Search contacts...');
    fireEvent.change(input, { target: { value: 'alice' } });

    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => {
      const button = screen.getByRole('button') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
    // Spinner replaces the "Go" label while loading.
    expect(screen.queryByRole('button', { name: 'Go' })).toBeNull();
    expect(document.querySelector('.animate-spin')).not.toBeNull();

    pending.resolve({ contacts: [] });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy();
    });
  });

  it('renders "No contacts found" when api returns an empty list', async () => {
    searchContactsMock.mockResolvedValue({ contacts: [] });

    render(<ContactSearch lineName="line-a" />);
    fireEvent.change(screen.getByPlaceholderText('Search contacts...'), {
      target: { value: 'zzz' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => {
      expect(screen.getByText('No contacts found')).toBeTruthy();
    });
    // No result rows should be rendered.
    expect(document.querySelectorAll('button.c-hover').length).toBe(0);
  });

  it('renders one button per contact and falls back through name/notify/number/jid', async () => {
    searchContactsMock.mockResolvedValue({ contacts: sampleContacts });

    render(<ContactSearch lineName="line-a" />);
    fireEvent.change(screen.getByPlaceholderText('Search contacts...'), {
      target: { value: 'al' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeTruthy();
    });
    // notify is used when name is absent.
    expect(screen.getByText('BobNotify')).toBeTruthy();
    // jid is used as the final fallback for the third contact (no name/notify/number).
    expect(screen.getByText('333@s.whatsapp.net')).toBeTruthy();
    // Numbers render in their own sub-row when present.
    expect(screen.getByText('+1 555 0001')).toBeTruthy();
    expect(screen.getByText('+1 555 0002')).toBeTruthy();
    // "No contacts found" should not appear when results exist.
    expect(screen.queryByText('No contacts found')).toBeNull();
  });

  it('invokes onSelect with the full contact when a result row is clicked', async () => {
    const onSelect = vi.fn();
    searchContactsMock.mockResolvedValue({ contacts: sampleContacts });

    render(<ContactSearch lineName="line-a" onSelect={onSelect} />);
    fireEvent.change(screen.getByPlaceholderText('Search contacts...'), {
      target: { value: 'al' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => screen.getByText('Alice'));
    fireEvent.click(screen.getByText('Alice').closest('button')!);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(sampleContacts[0]);
  });

  it('is safe to click result rows when onSelect is not provided', async () => {
    searchContactsMock.mockResolvedValue({ contacts: [sampleContacts[0]] });

    render(<ContactSearch lineName="line-a" />);
    fireEvent.change(screen.getByPlaceholderText('Search contacts...'), {
      target: { value: 'al' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => screen.getByText('Alice'));
    expect(() =>
      fireEvent.click(screen.getByText('Alice').closest('button')!),
    ).not.toThrow();
  });

  it('shows "No contacts found" when the api rejects, without throwing', async () => {
    searchContactsMock.mockRejectedValue(new Error('network blew up'));

    render(<ContactSearch lineName="line-a" />);
    fireEvent.change(screen.getByPlaceholderText('Search contacts...'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => {
      expect(screen.getByText('No contacts found')).toBeTruthy();
    });
    // Go button comes back enabled — loading state cleared in finally.
    const goButton = screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement;
    expect(goButton.disabled).toBe(false);
  });

  it('keeps prior results visible until a fresh search completes', async () => {
    searchContactsMock.mockResolvedValueOnce({ contacts: sampleContacts });

    render(<ContactSearch lineName="line-a" />);
    const input = screen.getByPlaceholderText('Search contacts...');
    fireEvent.change(input, { target: { value: 'al' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => screen.getByText('Alice'));

    // Clearing the input does NOT re-trigger a search and prior results remain.
    fireEvent.change(input, { target: { value: '' } });
    expect(searchContactsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Alice')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(true);

    // A subsequent successful search with empty results replaces them.
    searchContactsMock.mockResolvedValueOnce({ contacts: [] });
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(screen.queryByText('Alice')).toBeNull());
    expect(screen.getByText('No contacts found')).toBeTruthy();
  });
});
