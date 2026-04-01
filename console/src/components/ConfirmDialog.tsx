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
    ? { background: 'transparent', borderColor: 'rgba(252,129,129,0.3)', color: 'var(--color-s-crit)' }
    : { background: 'var(--color-m-cht)', borderColor: 'var(--color-m-cht)', color: 'var(--color-d0)' }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(5,7,9,0.75)' }}
      onClick={onCancel}
    >
      <div
        className="overflow-hidden"
        style={{
          background: 'var(--color-d2)',
          border: '1px solid var(--b2)',
          borderRadius: '12px',
          width: '420px',
          maxWidth: '90%',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between"
          style={{ padding: '16px 20px', borderBottom: '1px solid var(--b1)' }}
        >
          <span className="font-sans font-semibold" style={{ fontSize: '0.95rem' }}>
            {title}
          </span>
          <button
            onClick={onCancel}
            className="text-t4 hover:text-t2 cursor-pointer transition-colors"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px' }}>
          <div className="text-t2" style={{ fontSize: '0.88rem', lineHeight: 1.7 }}>
            {children}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex justify-end gap-2"
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--b1)',
            background: 'var(--color-d1)',
          }}
        >
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md font-sans text-t3 hover:text-t2 hover:bg-d4 cursor-pointer transition-colors"
            style={{ fontSize: '0.82rem', border: 'none', background: 'transparent' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md font-sans font-medium cursor-pointer transition-colors"
            style={{
              fontSize: '0.82rem',
              border: `1px solid ${confirmStyles.borderColor}`,
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
