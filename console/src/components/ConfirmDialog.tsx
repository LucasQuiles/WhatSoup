/**
 * ConfirmDialog — migrated to Modal primitive (C2 migration, modal.md).
 *
 * Public prop interface is PRESERVED for zero consumer breakage.
 * The migration:
 *   - Uses Modal (useDismissable: stacking-aware Escape, focus trap, focus restoration)
 *   - Removes the ad-hoc `useEffect` Escape handler (was the double-close bug source)
 *   - dismissable=false: no outside-click dismissal. Escape and the X remain available — they CANCEL (safe action).
 *   - confirm button is NOT default-focused (modal.md: destructive never default-focused)
 *   - Maps variant prop to Button primitive classes
 */
import { type FC, type ReactNode } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter } from './primitives'
import { Button } from './primitives/Button'

interface ConfirmDialogProps {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel?: string
  confirmVariant?: 'danger' | 'primary' | 'warning'
  confirmIcon?: ReactNode
  confirmDisabled?: boolean
  confirmLoading?: boolean
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
  confirmDisabled = false,
  confirmLoading = false,
  onConfirm,
  onCancel,
}) => {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      dismissable={false}
    >
      <ModalHeader title={title} onClose={onCancel} />
      <ModalBody>
        <div className="text-body leading-relaxed text-text-2">
          {children}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant={confirmVariant}
          onClick={onConfirm}
          icon={confirmIcon}
          disabled={confirmDisabled}
          loading={confirmLoading}
        >
          {confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

export default ConfirmDialog
