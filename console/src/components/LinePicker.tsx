/**
 * LinePicker.tsx — line-selector combobox (DD-12, B2).
 *
 * Rebuilt on the Popover primitive (select.md-canonical). Replaces hand-rolled
 * document.addEventListener mousedown/keydown listeners with useDismissable
 * (via Popover) and usePopoverKeyboard. The panel is a portaled listbox with
 * StatusCell + name + ModeBadge + phone rows (toolbar) or StatusCell + display
 * name + ModeBadge rows (compact).
 *
 * Public props contract is UNCHANGED — Ops and Inbox callers are untouched:
 *   lines / activeLine / onSelect / variant
 *
 * Keyboard contract (from usePopoverKeyboard):
 *   Down  — open panel / move active option down (clamped)
 *   Up    — move active option up (clamped)
 *   Enter — select active option + close
 *   Escape — close via useDismissable capture-phase stack (single-fire)
 *
 * Focus stays on trigger throughout (autoFocus: false, trapFocus: false via Popover).
 * aria-activedescendant on the trigger tracks the active option id.
 */
import { useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { StatusCell, ModeBadge } from './primitives/Badge';
import { Button } from './primitives/Button';
import { Popover, popoverOptionId, usePopoverKeyboard } from './primitives/Popover';
import type { PopoverOption } from './primitives/Popover';
import type { LineInstance } from '../types';
import { displayInstanceName, lineIdentity } from '../lib/text-utils';

// ---------------------------------------------------------------------------
// Props — public contract preserved
// ---------------------------------------------------------------------------

interface LinePickerProps {
  lines: LineInstance[];
  activeLine: string;
  onSelect: (name: string) => void;
  variant?: 'toolbar' | 'compact';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build PopoverOption list from lines. value = line.name. */
function buildOptions(lines: LineInstance[]): PopoverOption[] {
  return lines.map((l) => ({ value: l.name, label: l.name }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LinePicker({
  lines,
  activeLine,
  onSelect,
  variant = 'toolbar',
}: LinePickerProps) {
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  const currentLine = lines.find((l) => l.name === activeLine);
  const options = buildOptions(lines);

  function close() {
    setOpen(false);
    setActiveValue(null);
  }

  function handleSelect(value: string) {
    onSelect(value);
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

  // ---------------------------------------------------------------------------
  // Option rows with renderOption for custom cell anatomy
  // ---------------------------------------------------------------------------

  const toolbarOptionRows = lines.map(
    (line): PopoverOption => ({
      value: line.name,
      label: line.name,
      selected: line.name === activeLine,
      renderOption: () => (
        <span className="flex items-center gap-[var(--sp-2)] w-full min-w-0">
          <StatusCell status={line.status} />
          <span title={line.name} className="flex-1 min-w-0 truncate">{line.name}</span>
          <ModeBadge mode={line.mode} />
          <span className="c-label ml-auto flex-shrink-0">{lineIdentity(line)}</span>
        </span>
      ),
    }),
  );

  const compactOptionRows = lines.map(
    (line): PopoverOption => ({
      value: line.name,
      label: line.name,
      selected: line.name === activeLine,
      renderOption: () => (
        <span className="flex items-center gap-2 min-w-0">
          <StatusCell status={line.status} />
          <span title={line.name} className="font-mono min-w-0 truncate">
            {displayInstanceName(line.name)}
          </span>
          <ModeBadge mode={line.mode} />
        </span>
      ),
    }),
  );

  // ---------------------------------------------------------------------------
  // Render: toolbar variant
  // ---------------------------------------------------------------------------

  if (variant === 'toolbar') {
    return (
      <>
        <Button
          ref={triggerRef}
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={activeDescendant}
          aria-haspopup="listbox"
          aria-label={activeLine ? activeLine : 'Select a line'}
          onClick={() => (open ? close() : setOpen(true))}
          onKeyDown={handleKeyDown}
          className="text-body w-full flex items-center justify-between font-sans text-text-1 hover:bg-btn-neutral-bg cursor-pointer bg-surface-raised c-toolbar c-hover c-border-b min-h-[var(--toolbar-h)]"
        >
          <div className="flex items-center gap-[var(--sp-2)]">
            {currentLine && <StatusCell status={currentLine.status} />}
            <span className="font-medium">{activeLine || 'Select a line'}</span>
            {currentLine && <ModeBadge mode={currentLine.mode} />}
          </div>
          <ChevronDown
            size={14}
            className={`text-text-2 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </Button>

        <Popover
          open={open}
          onClose={close}
          anchorRef={triggerRef}
          options={toolbarOptionRows}
          activeValue={activeValue}
          onSelect={handleSelect}
          listboxLabel="Select a line"
          listboxId={listboxId}
          placement="span"
        />
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: compact variant
  // ---------------------------------------------------------------------------

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        aria-haspopup="listbox"
        aria-label={activeLine ? displayInstanceName(activeLine) : 'Select line'}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={handleKeyDown}
        className="text-label flex items-center gap-2 font-mono cursor-pointer c-hover text-text-1 bg-btn-neutral-bg tracking-[var(--tracking-pill)] py-[var(--dot-badge)] px-[var(--sp-3)] rounded-sm c-border-b2"
      >
        {currentLine && <StatusCell status={currentLine.status} />}
        <span className="font-medium">
          {activeLine ? displayInstanceName(activeLine) : 'Select line'}
        </span>
        <ChevronDown
          size={11}
          strokeWidth={1.75}
          className={`text-text-2 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </Button>

      <Popover
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        options={compactOptionRows}
        activeValue={activeValue}
        onSelect={handleSelect}
        listboxLabel="Select line"
        listboxId={listboxId}
        placement="start"
      />
    </>
  );
}
