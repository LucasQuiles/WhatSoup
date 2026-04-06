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
      className="c-dialog-backdrop"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="overflow-hidden bg-d2 border border-[var(--b2)] rounded-lg w-[var(--panel-confirm)] shadow-[var(--shadow-lg)]"
        style={{
          maxWidth: '90%',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between py-[var(--sp-4)] px-[var(--sp-5)] c-border-b"
        >
          <span id="confirm-dialog-title" className="font-sans font-semibold text-[var(--font-size-lg)]">
            {title}
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close dialog"
            className="c-btn c-btn-ghost c-btn-sm"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div className="p-[var(--sp-5)]">
          <div className="text-t2 leading-relaxed text-[var(--font-size-body)]">
            {children}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex justify-end gap-2 py-[var(--sp-3)] px-[var(--sp-5)] c-border-t bg-d1"
        >
          <button
            type="button"
            onClick={onCancel}
            className="c-btn c-btn-ghost"
          >
            Cancel
          </button>
          <button
            type="button"
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
