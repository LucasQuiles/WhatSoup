/**
 * ChatPicker.tsx — searchable chat combobox (DD-16, B2).
 *
 * Rebuilt on the Popover primitive (select.md-canonical). Replaces hand-rolled
 * lifetime-mounted document.addEventListener mousedown/keydown listeners with
 * useDismissable (via Popover) and usePopoverKeyboard.
 *
 * Escape-layering fix: the Popover registers on the useDismissable stack with
 * capture-phase + stopPropagation. When ChatPicker is open inside a legacy
 * dialog (ScheduleComposerModal) whose Escape handler runs in bubble phase,
 * the Popover consumes Escape FIRST — panel closes, dialog stays open.
 * Before B2: both bubble handlers fired, closing panel AND dialog together.
 *
 * Public props contract is UNCHANGED — ScheduleComposerModal caller untouched:
 *   chats / selected / onSelect / onClear / placeholder
 *
 * Keyboard contract (from usePopoverKeyboard):
 *   Down  — open panel / move active option down (clamped)
 *   Up    — move active option up (clamped)
 *   Enter — select active option + close
 *   Escape — close via useDismissable capture-phase stack (single-fire)
 *
 * Focus stays on SearchInput throughout (autoFocus: false, trapFocus: false via Popover).
 * aria-activedescendant on the SearchInput tracks the active option id.
 * Anchor positioning uses the wrapper div ref; aria wiring uses the listboxId directly.
 *
 * C-B2-4: SearchInput import and usage preserved — structural tests pin this.
 */
import { useState, useMemo, useRef, useId } from 'react';
import { MessageSquare, Users, X } from 'lucide-react';
import type { ChatItem } from '../../types.js';
import { SearchInput } from './SearchInput.js';
import { Button } from '../primitives/Button.js';
import { Popover, popoverOptionId, usePopoverKeyboard } from '../primitives/Popover.js';
import type { PopoverOption } from '../primitives/Popover.js';
import { resolveDisplayName } from '../../lib/text-utils.js';

interface ChatPickerProps {
  chats: ChatItem[];
  selected: ChatItem | null;
  onSelect: (chat: ChatItem) => void;
  onClear: () => void;
  placeholder?: string;
}

function chatLabel(chat: ChatItem): string {
  const identity = typeof chat.name === 'string' && chat.name.trim() ? chat.name : chat.conversationKey;
  return resolveDisplayName(identity);
}

export function ChatPicker({
  chats,
  selected,
  onSelect,
  onClear,
  placeholder = 'Search chats...',
}: ChatPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  // Wrapper div: anchor ref for Popover positioning.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const filtered = useMemo(() => {
    if (!query) return chats;
    const q = query.toLowerCase();
    return chats.filter(
      (c) =>
        chatLabel(c).toLowerCase().includes(q) ||
        c.conversationKey.toLowerCase().includes(q),
    );
  }, [chats, query]);

  // Build PopoverOption list from filtered chats.
  const options: PopoverOption[] = filtered.map((chat) => ({
    value: chat.conversationKey,
    label: chatLabel(chat),
    selected: false,
    renderOption: () => (
      <span className="flex items-center gap-2 min-w-0">
        {chat.isGroup ? (
          <Users size={14} className="text-text-2 flex-shrink-0" />
        ) : (
          <MessageSquare size={14} className="text-text-2 flex-shrink-0" />
        )}
        <span title={chatLabel(chat)} className="c-data truncate">{chatLabel(chat)}</span>
      </span>
    ),
  }));

  function close() {
    setOpen(false);
    setActiveValue(null);
  }

  function handleSelect(value: string) {
    const chat = chats.find((c) => c.conversationKey === value);
    if (chat) {
      onSelect(chat);
      setQuery('');
    }
    close();
  }

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

  // ---- Selected state display ----
  if (selected) {
    return (
      <div className="flex items-center gap-2 py-[var(--sp-2)] px-[var(--sp-3)] bg-surface-inset rounded-md [border:var(--bw)_solid_var(--border-hairline)]">
        {selected.isGroup ? (
          <Users size={14} className="text-text-2" />
        ) : (
          <MessageSquare size={14} className="text-text-2" />
        )}
        <span title={chatLabel(selected)} className="c-data flex-1 truncate">{chatLabel(selected)}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          aria-label="Clear selection"
        >
          <X size={14} />
        </Button>
      </div>
    );
  }

  // ---- Search panel (combobox trigger + Popover) ----
  return (
    <div ref={wrapperRef} className="relative">
      <SearchInput
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          // Reset active option when query changes so active tracks visible options.
          setActiveValue(null);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        onKeyDown={handleKeyDown}
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
  );
}
