/**
 * RelinkModal — migrated to Modal primitive (B3 wave-1).
 *
 * Migration:
 *   - Removes ad-hoc backdrop div, stopPropagation, and document-level Escape effect.
 *   - dismissable=true: backdrop click closes (preserved behaviour — no form state to lose;
 *     existing test names it "a cancel action").
 *   - Icon drop: Link2 header icon removed per modal.md anatomy (ConfirmDialog precedent).
 *   - Width: --panel-confirm 420px → size="sm" 480px (tokens-v3 §6.12).
 *   - Gains: stacking-aware Escape, focus trap, focus restoration.
 *   - Public prop interface unchanged — zero consumer breakage.
 */
import { type FC } from 'react'
import { Modal, ModalHeader, ModalBody } from './primitives'
import LinkStep from './wizard/LinkStep'

interface RelinkModalProps {
  lineName: string
  transport?: string | null
  open: boolean
  onClose: () => void
  onLinked: () => void
}

const RelinkModal: FC<RelinkModalProps> = ({ lineName, transport, open, onClose, onLinked }) => {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      dismissable={true}
    >
      <ModalHeader title={`Re-link ${lineName}`} onClose={onClose} />
      <ModalBody>
        <LinkStep lineName={lineName} transport={transport} onComplete={onLinked} />
      </ModalBody>
    </Modal>
  )
}

export default RelinkModal
