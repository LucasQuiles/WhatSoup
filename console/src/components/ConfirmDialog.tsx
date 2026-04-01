import { type FC, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel?: string
  confirmVariant?: 'danger' | 'primary'
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
  if (!open) return null

  const confirmStyles = confirmVariant === 'danger'
    ? { background: 'transparent', borderColor: 'var(--s-crit-soft)', color: 'var(--color-s-crit)' }
    : { background: 'var(--color-m-cht)', borderColor: 'var(--color-m-cht)', color: 'var(--color-d0)' }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'var(--overlay)' }}
      onClick={onCancel}
    >
      <div
        className="overflow-hidden"
        style={{
          background: 'var(--color-d2)',
          border: 'var(--bw) solid var(--b2)',
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
          <span className="font-sans font-semibold" style={{ fontSize: 'var(--font-size-lg)' }}>
            {title}
          </span>
          <button
            onClick={onCancel}
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
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md font-sans text-t3 hover:text-t2 hover:bg-d4 cursor-pointer c-hover"
            style={{ fontSize: 'var(--font-size-heading)', border: 'none', background: 'transparent' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md font-sans font-medium cursor-pointer c-hover"
            style={{
              fontSize: 'var(--font-size-heading)',
              border: `var(--bw) solid ${confirmStyles.borderColor}`,
              background: confirmStyles.background,
              color: confirmStyles.color,
            }}
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
