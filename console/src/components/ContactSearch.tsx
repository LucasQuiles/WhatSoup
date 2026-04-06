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
    <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
      <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
        <Search size={14} className="text-t5 flex-shrink-0" />
        <input
          type="text"
          className="c-input flex-1"
          placeholder="Search contacts..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
          style={{ padding: 'var(--sp-1) var(--sp-2)', fontSize: 'var(--font-size-data)' }}
        />
        <button
          className="c-btn c-btn-sm c-btn-ghost"
          onClick={handleSearch}
          disabled={loading || !query.trim()}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : 'Go'}
        </button>
      </div>

      {searched && results.length === 0 && (
        <div className="text-t5 font-mono text-center" style={{ fontSize: 'var(--font-size-xs)', padding: 'var(--sp-2)' }}>
          No contacts found
        </div>
      )}

      {results.length > 0 && (
        <div className="flex flex-col" style={{ gap: '1px', maxHeight: '200px', overflowY: 'auto' }}>
          {results.map((c) => (
            <button
              key={c.jid}
              type="button"
              className="flex items-center gap-2 text-left c-hover cursor-pointer"
              style={{
                padding: 'var(--sp-1h) var(--sp-2)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--font-size-data)',
              }}
              onClick={() => onSelect?.(c)}
            >
              <User size={14} className="text-t4 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-t2 truncate">
                  {c.name ?? c.notify ?? c.number ?? c.jid}
                </div>
                {c.number && (
                  <div className="font-mono text-t5" style={{ fontSize: 'var(--font-size-xs)' }}>
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
