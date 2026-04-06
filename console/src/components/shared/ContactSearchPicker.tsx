import { useState, useCallback, useRef, useEffect } from 'react'
import { X, UserPlus } from 'lucide-react'
import { api } from '../../lib/api.js'
import type { ContactResult } from '../../types.js'
import { SearchInput } from './SearchInput.js'

interface ContactSearchPickerProps {
  lineName: string
  selected: ContactResult[]
  onAdd: (contact: ContactResult) => void
  onRemove: (jid: string) => void
  placeholder?: string
}

export function ContactSearchPicker({ lineName, selected, onAdd, onRemove, placeholder = 'Search contacts...' }: ContactSearchPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ContactResult[]>([])
  const [searching, setSearching] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const doSearch = useCallback((q: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (q.length < 2) { setResults([]); return }
    timerRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await api.searchContacts(lineName, q)
        setResults((res as { contacts?: ContactResult[] }).contacts ?? [])
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 300)
  }, [lineName])

  const selectedJids = new Set(selected.map((c) => c.jid))

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((c) => (
            <span
              key={c.jid}
              className="inline-flex items-center gap-1 font-mono"
              style={{
                fontSize: 'var(--font-size-xs)',
                padding: 'var(--bw) var(--sp-2)',
                background: 'var(--color-d1)',
                borderRadius: 'var(--radius-sm)',
                borderWidth: 'var(--bw)',
                borderStyle: 'solid',
                borderColor: 'var(--b1)',
              }}
            >
              {c.name ?? c.notify ?? c.jid}
              <button type="button" onClick={() => onRemove(c.jid)} className="c-btn c-btn-ghost" style={{ padding: 'var(--sp-0)' }} aria-label={`Remove ${c.name ?? c.jid}`}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <SearchInput
          value={query}
          onChange={(e) => { setQuery(e.target.value); doSearch(e.target.value) }}
          placeholder={placeholder}
          aria-label={placeholder}
          endAdornment={searching ? <span className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>...</span> : null}
        />
        {results.length > 0 && (
          <div
            className="c-card absolute left-0 right-0 z-50 overflow-y-auto"
            style={{ top: '100%', marginTop: 'var(--sp-1)', maxHeight: 'calc(var(--sp-10) * 5)' }}
          >
            {results.filter((r) => !selectedJids.has(r.jid)).map((contact) => (
              <button
                key={contact.jid}
                type="button"
                className="w-full flex items-center gap-2 c-hover text-left"
                style={{ padding: 'var(--sp-2) var(--sp-3)' }}
                onClick={() => { onAdd(contact); setQuery(''); setResults([]) }}
              >
                <UserPlus size={14} className="text-t4" />
                <span className="font-mono text-t2" style={{ fontSize: 'var(--font-size-data)' }}>{contact.name ?? contact.notify ?? contact.jid}</span>
                {contact.number && <span className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>{contact.number}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
