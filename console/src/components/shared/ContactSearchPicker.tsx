/**
 * ContactSearchPicker.tsx — multi-select contact combobox (DD-16, B2).
 *
 * Rebuilt on the Popover primitive (select.md-canonical). Prior version had NO
 * Escape or outside-click dismissal at all (P2-1); Popover + useDismissable
 * provides both by construction.
 *
 * Amendment A: selected-contact chips use Pill removable variant. The prior
 * re-rolled span chips carried labeled remove buttons — the Pill removes carry
 * the same accessible name ("Remove <name>") via the ActionButton inside Pill.
 *
 * Public props contract is UNCHANGED — GroupDetailModal + CreateGroupModal
 * callers are untouched:
 *   lineName / selected / onAdd / onRemove / placeholder
 *
 * Keyboard contract (from usePopoverKeyboard):
 *   Down  — open panel / move active option down (clamped)
 *   Up    — move active option up (clamped)
 *   Enter — select active option + close
 *   Escape — close via useDismissable capture-phase stack (single-fire)
 *
 * Debounce: 300ms, min 2 chars (unchanged from prior version).
 * In-flight guard: generation token prevents stale responses from reopening
 * a closed panel or setting state after unmount.
 *
 * C-B2-4: SearchInput import and usage preserved — structural tests pin this.
 */
import { useState, useCallback, useRef, useId, useEffect } from 'react';
import { UserPlus } from 'lucide-react';
import { api } from '../../lib/api.js';
import type { ContactResult } from '../../types.js';
import { SearchInput } from './SearchInput.js';
import { Pill } from '../primitives/Pill.js';
import { Popover, popoverOptionId, usePopoverKeyboard } from '../primitives/Popover.js';
import type { PopoverOption } from '../primitives/Popover.js';

interface ContactSearchPickerProps {
  lineName: string;
  selected: ContactResult[];
  onAdd: (contact: ContactResult) => void;
  onRemove: (jid: string) => void;
  placeholder?: string;
}

function contactLabel(c: ContactResult): string {
  return c.name ?? c.notify ?? c.number ?? c.jid;
}

export function ContactSearchPicker({
  lineName,
  selected,
  onAdd,
  onRemove,
  placeholder = 'Search contacts...',
}: ContactSearchPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContactResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);

  // Wrapper div: anchor ref for Popover positioning.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // Debounce timer ref.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation token: incremented on every close/unmount to discard stale responses.
  const generationRef = useRef(0);

  // Clear timer on unmount.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const selectedJids = new Set(selected.map((c) => c.jid));

  // Exclude already-selected contacts from results.
  const visibleResults = results.filter((r) => !selectedJids.has(r.jid));

  const options: PopoverOption[] = visibleResults.map((contact) => ({
    value: contact.jid,
    label: contactLabel(contact),
    selected: false,
    renderOption: () => (
      <span className="flex items-center gap-2 min-w-0 w-full">
        <UserPlus size={14} className="text-text-2 flex-shrink-0" />
        <span title={contactLabel(contact)} className="c-data min-w-0 truncate">{contactLabel(contact)}</span>
        {contact.number && (
          <span className="c-label flex-shrink-0">{contact.number}</span>
        )}
      </span>
    ),
  }));

  function close() {
    generationRef.current += 1;
    setOpen(false);
    setActiveValue(null);
  }

  function handleSelect(value: string) {
    const contact = visibleResults.find((r) => r.jid === value);
    if (contact) {
      onAdd(contact);
      setQuery('');
      setResults([]);
    }
    close();
  }

  const doSearch = useCallback(
    (q: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (q.length < 2) {
        setResults([]);
        return;
      }
      const gen = generationRef.current;
      timerRef.current = setTimeout(async () => {
        setSearching(true);
        try {
          const res = await api.searchContacts(lineName, q);
          // Discard if panel was closed before response arrived.
          if (gen !== generationRef.current) return;
          const contacts = (res as { contacts?: ContactResult[] }).contacts ?? [];
          setResults(contacts);
          setOpen(contacts.length > 0);
        } catch {
          if (gen !== generationRef.current) return;
          setResults([]);
        } finally {
          if (gen === generationRef.current) setSearching(false);
        }
      }, 300);
    },
    [lineName],
  );

  const { handleKeyDown } = usePopoverKeyboard({
    open,
    options,
    activeValue,
    onOpen: () => setOpen(true),
    onClose: close,
    onSelect: handleSelect,
    onActiveChange: setActiveValue,
  });

  // aria-activedescendant: only when panel is open and an option is active.
  const activeDescendant =
    open && activeValue ? popoverOptionId(listboxId, activeValue) : undefined;

  return (
    <div className="flex flex-col gap-[var(--sp-2)]">
      {/* Chip row — selected contacts as Pill removable */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((c) => (
            <Pill
              key={c.jid}
              variant="removable"
              tone="neutral"
              onRemove={() => onRemove(c.jid)}
              removeLabel={`Remove ${contactLabel(c)}`}
            >
              {contactLabel(c)}
            </Pill>
          ))}
        </div>
      )}
      {/* Search input + Popover results */}
      <div ref={wrapperRef} className="relative">
        <SearchInput
          value={query}
          onChange={(e) => {
            const val = e.target.value;
            setQuery(val);
            setActiveValue(null);
            doSearch(val);
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={activeDescendant}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          onKeyDown={handleKeyDown}
          endAdornment={searching ? <span className="c-meta">...</span> : null}
        />
        <Popover
          open={open && options.length > 0}
          onClose={close}
          anchorRef={wrapperRef}
          options={options}
          activeValue={activeValue}
          onSelect={handleSelect}
          listboxLabel={placeholder}
          listboxId={listboxId}
          placement="span"
        />
      </div>
    </div>
  );
}
