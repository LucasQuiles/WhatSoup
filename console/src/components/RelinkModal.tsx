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
        style={{
          width: 'var(--panel-confirm)',
          maxWidth: '90%',
          background: 'var(--color-d2)',
          borderWidth: 'var(--bw)',
          borderStyle: 'solid',
          borderColor: 'var(--b2)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between"
          style={{ padding: 'var(--sp-4) var(--sp-5)', borderBottom: 'var(--bw) solid var(--b1)' }}
        >
          <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
            <Link2 size={16} className="text-t3" />
            <span id="relink-dialog-title" className="font-sans font-semibold" style={{ fontSize: 'var(--font-size-lg)' }}>
              Re-link {lineName}
            </span>
          </div>
          <button onClick={onClose} aria-label="Close" className="c-btn c-btn-ghost">
            <X size={16} />
          </button>
        </div>

        {/* LinkStep content */}
        <div style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
          <LinkStep lineName={lineName} onComplete={onLinked} />
        </div>
      </div>
    </div>
  )
}

export default RelinkModal
