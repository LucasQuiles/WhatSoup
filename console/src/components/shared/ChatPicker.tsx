import { useState, useMemo, useRef, useEffect } from 'react'
import { Search, MessageSquare, Users, X } from 'lucide-react'
import type { ChatItem } from '../../types.js'

interface ChatPickerProps {
  chats: ChatItem[]
  selected: ChatItem | null
  onSelect: (chat: ChatItem) => void
  onClear: () => void
  placeholder?: string
}

export function ChatPicker({ chats, selected, onSelect, onClear, placeholder = 'Search chats...' }: ChatPickerProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const filtered = useMemo(() => {
    if (!query) return chats
    const q = query.toLowerCase()
    return chats.filter((c) =>
      c.name.toLowerCase().includes(q) || c.conversationKey.toLowerCase().includes(q),
    )
  }, [chats, query])

  if (selected) {
    return (
      <div className="flex items-center gap-2" style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--color-d1)', borderRadius: 'var(--radius-md)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
        {selected.isGroup ? <Users size={14} className="text-t4" /> : <MessageSquare size={14} className="text-t4" />}
        <span className="font-mono text-t2 flex-1 truncate" style={{ fontSize: 'var(--font-size-data)' }}>{selected.name}</span>
        <button type="button" onClick={onClear} className="c-btn c-btn-ghost c-btn-sm" aria-label="Clear selection">
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-2" style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--color-d1)', borderRadius: 'var(--radius-md)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
        <Search size={14} className="text-t4" />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="flex-1 bg-transparent border-none outline-none font-mono text-t2"
          style={{ fontSize: 'var(--font-size-data)' }}
        />
      </div>
      {open && filtered.length > 0 && (
        <div
          className="absolute left-0 right-0 z-50 overflow-y-auto"
          style={{ top: '100%', marginTop: 'var(--sp-1)', maxHeight: '240px', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)' }}
        >
          {filtered.map((chat) => (
            <button
              key={chat.conversationKey}
              type="button"
              className="w-full flex items-center gap-2 c-hover text-left"
              style={{ padding: 'var(--sp-2) var(--sp-3)' }}
              onClick={() => { onSelect(chat); setOpen(false); setQuery('') }}
            >
              {chat.isGroup ? <Users size={14} className="text-t4" /> : <MessageSquare size={14} className="text-t4" />}
              <span className="font-mono text-t2 truncate" style={{ fontSize: 'var(--font-size-data)' }}>{chat.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
