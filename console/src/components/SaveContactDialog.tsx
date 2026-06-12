/**
 * SaveContactDialog — extracted from pages/Inbox.tsx (B3 wave-1).
 *
 * Owns the contact-name input state; callers provide the async save handler.
 * Uses Modal primitive with dismissable=false (explicit Save/Cancel verbs;
 * backdrop click would silently discard the typed name — modal.md protective default).
 * initialFocus lands on the name input (C-B3W1-1 pass-through).
 * Enter-to-save and name-trim preserved from the original inline dialog.
 *
 * State reset strategy: name is cleared on close (both explicit cancel and post-save),
 * avoiding a setState-in-effect pattern. The caller (Inbox.tsx) passes a key derived
 * from saveContactChat so that switching to a different chat also unmount-resets state.
 */
import { type FC, useRef, useState } from 'react'
import { UserPlus } from 'lucide-react'
import { Modal, ModalHeader, ModalBody, ModalFooter } from './primitives'
import { Button } from './primitives/Button'

export interface SaveContactDialogProps {
  /** Controls visibility. */
  open: boolean
  /** True while the parent is executing the save API call. */
  busy: boolean
  /** Called with the TRIMMED name when the user submits. */
  onSave: (name: string) => void
  /** Called when the user cancels (header X, footer Cancel, Escape). */
  onClose: () => void
}

export const SaveContactDialog: FC<SaveContactDialogProps> = ({
  open,
  busy,
  onSave,
  onClose,
}) => {
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleClose = () => {
    setName('')
    onClose()
  }

  const handleSave = () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    onSave(trimmed)
    setName('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSave()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="sm"
      dismissable={false}
      initialFocus={inputRef}
    >
      <ModalHeader title="Save Contact" onClose={handleClose} />
      <ModalBody>
        <div>
          <label htmlFor="save-contact-name-input" className="c-field-label block mb-[var(--sp-2)]">
            Contact name
          </label>
          <input
            ref={inputRef}
            id="save-contact-name-input"
            type="text"
            className="c-input font-mono w-full"
            placeholder="First Last"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!name.trim() || busy}
          icon={<UserPlus size={14} strokeWidth={1.75} />}
        >
          Save
        </Button>
      </ModalFooter>
    </Modal>
  )
}
