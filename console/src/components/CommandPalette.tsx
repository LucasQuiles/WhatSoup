/**
 * CommandPalette.tsx — the ⌘K command palette overlay (showcase §17, v1).
 *
 * v1 is READ-ONLY: switch routes + jump to a line's detail. No mutations, no
 * confirm dialogs, no line actions (later slices).
 *
 * Built on the Modal primitive (the one sanctioned dialog surface — soup/no-adhoc-modal):
 * Modal owns role="dialog"/aria-modal, focus trap + restoration (useDismissable),
 * background-inert, stack-aware Escape, scrim outside-click, and exit presence. The
 * palette renders a sanctioned combobox query input (TextInput primitive — satisfies
 * soup/no-raw-form-control) over a filtered listbox.
 *
 * a11y:
 *   - dialog   role/aria-modal/aria-labelledby owned by Modal (labelled by the sr-only title).
 *   - input    role="combobox" aria-expanded aria-controls=<listbox id> aria-autocomplete="list"
 *              aria-activedescendant=<active option id>
 *   - list     role="listbox"; rows role="option" aria-selected
 *
 * Keyboard: typing filters + ranks (fuzzy over label); ↑/↓ move the active row
 * (wrap-around); Enter executes the active row + closes. Escape/scrim close via Modal.
 *
 * The results list is the single scroll owner; long line names truncate with `title`
 * so the full name stays discoverable (no-unsafe-truncation).
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import { Modal } from './primitives';
import { TextInput } from './primitives/FormControl';
import { useLines } from '../hooks/use-fleet';
import { fuzzyMatch } from '../lib/fuzzy';
import type { LineInstance } from '../types';

export interface CommandPaletteProps {
  /** Controls visibility. */
  open: boolean;
  /** Called when the palette should close (Escape, scrim-click, after execute). */
  onClose: () => void;
}

interface Command {
  /** Stable id; also used as the option id suffix. */
  id: string;
  /** Display label (also the fuzzy target). */
  label: string;
  /** Optional right-aligned keyboard hint (e.g. "1" for the Kitchen route). */
  hint?: string;
  /** Execute the command: navigation. Closing is handled by the caller. */
  run: () => void;
}

/** Static Go routes — ordering matches the rail (Kitchen/Inbox/Metrics/Operator). */
const STATIC_ROUTES: Array<{ path: string; label: string; hint?: string }> = [
  { path: '/', label: 'Kitchen', hint: '1' },
  { path: '/inbox', label: 'Inbox', hint: '2' },
  { path: '/metrics', label: 'Metrics' },
  { path: '/operator', label: 'Operator', hint: '3' },
];

/** Build a safe option id from a listbox id + raw command id. */
function optionId(listboxId: string, cmdId: string): string {
  return `${listboxId}-opt-${cmdId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function buildLineCommands(
  lines: LineInstance[] | undefined,
  navigate: (path: string) => void,
): Command[] {
  if (!lines) return [];
  return lines.map((line) => ({
    id: `line:${line.name}`,
    label: line.name,
    hint: 'line',
    run: () => navigate(`/lines/${line.name}`),
  }));
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { data: lines } = useLines();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const titleId = useId();

  // Build the full command list: routes first, then one row per line.
  const commands = useMemo<Command[]>(() => {
    const routes: Command[] = STATIC_ROUTES.map((r) => ({
      id: `route:${r.path}`,
      label: r.label,
      hint: r.hint,
      run: () => navigate(r.path),
    }));
    return [...routes, ...buildLineCommands(lines, navigate)];
  }, [lines, navigate]);

  // Filter + rank. Empty query → all commands (routes first, lines append).
  const filtered = useMemo<Command[]>(() => {
    const q = query.trim();
    if (q.length === 0) return commands;
    const scored: Array<{ cmd: Command; score: number }> = [];
    for (const cmd of commands) {
      const result = fuzzyMatch(q, cmd.label);
      if (result) scored.push({ cmd, score: result.score });
    }
    // Higher score first; stable order preserved for equal scores (input order).
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.cmd);
  }, [commands, query]);

  // Clamp the active index during render (no set-state-in-effect): every keystroke
  // already resets activeIdx to 0, so this only guards async list shrink (lines load).
  const safeActiveIdx = filtered.length === 0 ? -1 : Math.min(activeIdx, filtered.length - 1);

  // Reset on close (handler, not an effect) so the next open starts fresh while Modal
  // keeps its exit-presence dwell intact.
  const handleClose = (): void => {
    setQuery('');
    setActiveIdx(0);
    onClose();
  };

  const execute = (cmd: Command | undefined): void => {
    if (!cmd) return;
    cmd.run();
    handleClose();
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setActiveIdx((i) => (i + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execute(filtered[safeActiveIdx]);
    }
    // Escape is owned by Modal/useDismissable — do not handle it here.
  };

  const activeCmd = safeActiveIdx >= 0 ? filtered[safeActiveIdx] : undefined;
  const activeOptionId = activeCmd ? optionId(listboxId, activeCmd.id) : undefined;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      dismissable
      size="md"
      initialFocus={inputRef}
      labelledById={titleId}
    >
      <div className="soup-cmdk">
        <span id={titleId} className="sr-only">
          Command palette
        </span>
        <TextInput
          ref={inputRef}
          type="text"
          className="soup-cmdk__query"
          placeholder="Search routes and lines…"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          aria-label="Command palette search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          onKeyDown={handleKeyDown}
        />
        {/*
          Single live region announcing the filtered count to assistive tech as the query
          changes (APG combobox pattern / WCAG 4.1.3). Kept OUTSIDE the listbox — aria-live on
          the listbox itself would announce on every option render — and always mounted so the
          screen reader registers updates. It voices both the empty and non-empty cases, so the
          visual empty-state below no longer carries its own (would-be duplicate) live role.
        */}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {filtered.length === 0
            ? 'No results available'
            : `${filtered.length} result${filtered.length === 1 ? '' : 's'} available`}
        </div>
        <div id={listboxId} role="listbox" aria-label="Commands" className="soup-cmdk__list">
          {filtered.length === 0 ? (
            <div className="soup-cmdk__empty">
              No results
            </div>
          ) : (
            filtered.map((cmd, idx) => {
              const isActive = idx === safeActiveIdx;
              return (
                <div
                  key={cmd.id}
                  id={optionId(listboxId, cmd.id)}
                  role="option"
                  aria-selected={isActive}
                  className={`soup-cmdk__item${isActive ? ' soup-cmdk__item--active' : ''}`}
                  title={cmd.label}
                  onMouseMove={() => setActiveIdx(idx)}
                  onMouseDown={(e) => {
                    // Prevent the input from blurring before execute runs.
                    e.preventDefault();
                    execute(cmd);
                  }}
                >
                  <span className="soup-cmdk__item-label">{cmd.label}</span>
                  {cmd.hint && <kbd className="soup-cmdk__kbd">{cmd.hint}</kbd>}
                </div>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
