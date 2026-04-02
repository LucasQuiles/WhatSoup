import { type FC } from 'react'
import { X, Link2 } from 'lucide-react'
import LinkStep from './wizard/LinkStep'

interface RelinkModalProps {
  lineName: string
  open: boolean
  onClose: () => void
  onLinked: () => void
}

const RelinkModal: FC<RelinkModalProps> = ({ lineName, open, onClose, onLinked }) => {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--overlay)' }}
      onClick={onClose}
    >
      <div
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
            <span className="font-sans font-semibold" style={{ fontSize: 'var(--font-size-lg)' }}>
              Re-link {lineName}
            </span>
          </div>
          <button onClick={onClose} className="c-btn c-btn-ghost">
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
