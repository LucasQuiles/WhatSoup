import { Keyboard } from 'lucide-react';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

const SHORTCUTS = [
  { keys: [`${mod}+K`], label: 'Focus search' },
  { keys: ['1'], label: 'Go to Soup Kitchen' },
  { keys: ['2'], label: 'Go to Inbox' },
  { keys: ['3'], label: 'Go to Ops' },
  { keys: ['Esc'], label: 'Close modals' },
  { keys: ['?'], label: 'Show this help' },
];

export function KeyboardShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-[var(--overlay)] z-[var(--z-overlay)]"
      onClick={onClose}
    >
      <div
        className="c-dialog font-mono w-[var(--panel-shortcuts)] max-w-[90vw] p-[var(--sp-5)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kbd-shortcuts-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-[var(--sp-4)]">
          <Keyboard size={16} strokeWidth={1.75} className="text-t3" />
          <span id="kbd-shortcuts-title" className="text-body font-sans font-semibold text-t1">
            Keyboard Shortcuts
          </span>
        </div>

        <div className="flex flex-col gap-[var(--sp-2h)]">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between">
              <span className="text-data text-t3">{s.label}</span>
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

        <div className="text-xs text-t5 text-center mt-[var(--sp-4)]">
          Press <kbd className="c-kbd">?</kbd> or <kbd className="c-kbd">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
