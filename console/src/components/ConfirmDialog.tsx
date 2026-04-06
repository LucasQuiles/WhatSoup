import { type FC, type ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel?: string
  confirmVariant?: 'danger' | 'primary' | 'warning'
  confirmIcon?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}

const ConfirmDialog: FC<ConfirmDialogProps> = ({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  confirmVariant = 'danger',
  confirmIcon,
  onConfirm,
  onCancel,
}) => {
  // Close on Escape key
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'var(--overlay)' }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="overflow-hidden"
        style={{
          background: 'var(--color-d2)',
          borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
          borderRadius: 'var(--radius-lg)',
          width: 'var(--panel-confirm)',
          maxWidth: '90%',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between"
          style={{ padding: 'var(--sp-4) var(--sp-5)', borderBottom: 'var(--bw) solid var(--b1)' }}
        >
          <span id="confirm-dialog-title" className="font-sans font-semibold" style={{ fontSize: 'var(--font-size-lg)' }}>
            {title}
          </span>
          <button
            onClick={onCancel}
            aria-label="Close dialog"
            className="text-t4 hover:text-t2 cursor-pointer c-hover"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 'var(--sp-5)' }}>
          <div className="text-t2 leading-relaxed" style={{ fontSize: 'var(--font-size-body)' }}>
            {children}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex justify-end gap-2"
          style={{
            padding: 'var(--sp-3) var(--sp-5)',
            borderTop: 'var(--bw) solid var(--b1)',
            background: 'var(--color-d1)',
          }}
        >
          <button
            onClick={onCancel}
            className="c-btn c-btn-ghost"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`c-btn ${
              confirmVariant === 'danger' ? 'c-btn-danger'
              : confirmVariant === 'warning' ? 'c-btn-warning'
              : 'c-btn-primary'
            }`}
          >
            {confirmIcon}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
