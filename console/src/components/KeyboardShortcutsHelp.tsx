/**
 * KeyboardShortcutsHelp — migrated to Modal primitive (C2 migration, modal.md).
 *
 * REAL BUG FIXED: The previous implementation had no Escape handler despite the
 * UI copy reading "Press ? or Esc to close". Escape now works via useDismissable
 * inside Modal, stacking-aware.
 *
 * The outer overlay click-to-close is preserved via dismissable=true.
 */
import { Keyboard } from 'lucide-react';
import { Modal, ModalBody } from './primitives';

// userAgentData.platform where available; navigator.platform (deprecated but
// universal) as the fallback so the modifier glyph stays right on older engines.
const isMac = typeof navigator !== 'undefined'
  && /mac/i.test(
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
      ?? navigator.platform
      ?? '',
  );
const mod = isMac ? '⌘' : 'Ctrl';

const SHORTCUTS = [
  { keys: [`${mod}+K`], label: 'Focus search' },
  { keys: ['1'], label: 'Go to Fleet' },
  { keys: ['2'], label: 'Go to Inbox' },
  { keys: ['3'], label: 'Go to Ops' },
  { keys: ['Esc'], label: 'Close modals' },
  { keys: ['?'], label: 'Show this help' },
];

export function KeyboardShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      dismissable={true}
      labelledById="kbd-shortcuts-title"
    >
      <ModalBody>
        <div className="flex items-center gap-[var(--sp-2)] mb-[var(--sp-4)]">
          <Keyboard size={16} strokeWidth={1.75} className="text-text-2" />
          <span id="kbd-shortcuts-title" className="text-body font-sans font-semibold text-text-1">
            Keyboard Shortcuts
          </span>
        </div>

        <div className="flex flex-col gap-[var(--sp-2h)] font-mono">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between">
              <span className="text-data text-text-2">{s.label}</span>
              <div className="flex gap-[var(--sp-1)]">
                {s.keys.map((k) => (
                  <kbd key={k} className="c-kbd">
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="text-xs text-text-3 text-center mt-[var(--sp-4)]">
          Press <kbd className="c-kbd">?</kbd> or <kbd className="c-kbd">Esc</kbd> to close
        </div>
      </ModalBody>
    </Modal>
  );
}
