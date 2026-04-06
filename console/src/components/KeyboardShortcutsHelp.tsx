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
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'var(--overlay)', zIndex: 'var(--z-overlay)' }}
      onClick={onClose}
    >
      <div
        className="c-dialog font-mono"
        style={{
          width: 'var(--panel-shortcuts)',
          maxWidth: '90vw',
          padding: 'var(--sp-5)',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kbd-shortcuts-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2" style={{ marginBottom: 'var(--sp-4)' }}>
          <Keyboard size={16} strokeWidth={1.75} className="text-t3" />
          <span id="kbd-shortcuts-title" className="font-sans font-semibold text-t1" style={{ fontSize: 'var(--font-size-body)' }}>
            Keyboard Shortcuts
          </span>
        </div>

        <div className="flex flex-col" style={{ gap: 'var(--sp-2h)' }}>
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between">
              <span className="text-t3" style={{ fontSize: 'var(--font-size-data)' }}>{s.label}</span>
              <div className="flex" style={{ gap: 'var(--sp-1)' }}>
                {s.keys.map((k) => (
                  <kbd key={k} className="c-kbd">
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="text-t5 text-center" style={{ marginTop: 'var(--sp-4)', fontSize: 'var(--font-size-xs)' }}>
          Press <kbd className="c-kbd">?</kbd> or <kbd className="c-kbd">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
