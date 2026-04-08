import { useState, useCallback } from 'react';
import { Search, User, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import type { ContactResult } from '../types';

/**
 * Inline contact search — queries the instance's WhatsApp contact list
 * via MCP proxy. Renders results as a compact list.
 */
export function ContactSearch({
  lineName,
  onSelect,
}: {
  lineName: string;
  onSelect?: (contact: ContactResult) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContactResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim() || !lineName) return;
    setLoading(true);
    try {
      const data = await api.searchContacts(lineName, query.trim());
      setResults(data.contacts);
      setSearched(true);
    } catch {
      setResults([]);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }, [query, lineName]);

  return (
    <div className="flex flex-col gap-[var(--sp-2)]">
      <div className="flex items-center gap-[var(--sp-2)]">
        <Search size={14} className="text-t5 flex-shrink-0" />
        <input
          type="text"
          placeholder="Search contacts..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
          className="c-input flex-1 py-[var(--sp-1)] px-[var(--sp-2)] text-[var(--font-size-data)]"
        />
        <button
          type="button"
          className="c-btn c-btn-sm c-btn-ghost"
          onClick={handleSearch}
          disabled={loading || !query.trim()}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : 'Go'}
        </button>
      </div>

      {searched && results.length === 0 && (
        <div className="text-t5 font-mono text-center p-[var(--sp-2)] text-[var(--font-size-xs)]">
          No contacts found
        </div>
      )}

      {results.length > 0 && (
        <div className="flex flex-col gap-[var(--bw)] max-h-[var(--contact-search-max-h)] overflow-y-auto">
          {results.map((c) => (
            <button
              key={c.jid}
              type="button"
              className="flex items-center gap-2 text-left c-hover cursor-pointer rounded-sm py-[var(--sp-1h)] px-[var(--sp-2)] text-[var(--font-size-data)]"
              onClick={() => onSelect?.(c)}
            >
              <User size={14} className="text-t4 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-t2 truncate">
                  {c.name ?? c.notify ?? c.number ?? c.jid}
                </div>
                {c.number && (
                  <div className="font-mono text-t5 text-[var(--font-size-xs)]">
                    {c.number}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
