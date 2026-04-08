import { type FC, useEffect } from 'react'
import { X, Link2 } from 'lucide-react'
import LinkStep from './wizard/LinkStep'

interface RelinkModalProps {
  lineName: string
  open: boolean
  onClose: () => void
  onLinked: () => void
}

const RelinkModal: FC<RelinkModalProps> = ({ lineName, open, onClose, onLinked }) => {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="c-dialog-backdrop"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="relink-dialog-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-d2 rounded-lg shadow-[var(--shadow-lg)] overflow-hidden c-border w-[var(--panel-confirm)] max-w-[90%]"
      >
        {/* Header */}
        <div
          className="flex items-center justify-between py-[var(--sp-4)] px-[var(--sp-5)] c-border-b"
        >
          <div className="flex items-center gap-[var(--sp-2)]">
            <Link2 size={16} strokeWidth={1.75} className="text-t3" />
            <span id="relink-dialog-title" className="text-lg font-sans font-semibold">
              Re-link {lineName}
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="c-btn c-btn-ghost">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* LinkStep content */}
        <div className="py-[var(--sp-4)] px-[var(--sp-5)]">
          <LinkStep lineName={lineName} onComplete={onLinked} />
        </div>
      </div>
    </div>
  )
}

export default RelinkModal
