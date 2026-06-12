/**
 * CreateGroupModal — migrated to Modal primitive (B3 wave-1).
 *
 * Migration:
 *   - Removes ad-hoc backdrop div, stopPropagation, and document-level Escape effect.
 *   - dismissable=false: backdrop click was silently destroying subject and every picked
 *     participant (no recovery path). modal.md: explicit Cancel/Create verbs exist —
 *     protective default applied. Backdrop click data destruction removed.
 *   - Icon drop: Users header icon removed per modal.md anatomy (ConfirmDialog precedent).
 *   - Width: --panel-composer 540px → size="md" 560px (tokens-v3 §6.12).
 *   - initialFocus on subject input (C-B3W1-1).
 *   - Footer raw c-btn buttons → Button primitives.
 *   - Gains: stacking-aware Escape, focus trap, focus restoration.
 *   - Public prop interface, reset-on-open, submit pipeline, toasts unchanged.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Users } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import { useToast } from '../../hooks/toast-context.js'
import { ContactSearchPicker } from '../shared/ContactSearchPicker.js'
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../primitives'
import { Button } from '../primitives/Button'
import type { ContactResult } from '../../types.js'

interface CreateGroupModalProps {
  open: boolean
  lineName: string
  onClose: () => void
  onCreated: () => void
}

export function CreateGroupModal({ open, lineName, onClose, onCreated }: CreateGroupModalProps) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [subject, setSubject] = useState('')
  const [participants, setParticipants] = useState<ContactResult[]>([])
  const [submitting, setSubmitting] = useState(false)
  const subjectInputRef = useRef<HTMLInputElement>(null)

  // Reset on open
  useEffect(() => {
    if (open) {
      setSubject('')
      setParticipants([])
    }
  }, [open])

  const handleCreate = useCallback(async () => {
    if (!subject.trim()) {
      toast.error('Group subject is required')
      return
    }
    if (participants.length === 0) {
      toast.error('Add at least one participant')
      return
    }
    setSubmitting(true)
    try {
      await api.createGroup(lineName, subject.trim(), participants.map(p => p.jid))
      toast.success(`Group "${subject.trim()}" created`)
      queryClient.invalidateQueries({ queryKey: ['groups', lineName] })
      onCreated()
      onClose()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }, [subject, participants, lineName, toast, queryClient, onCreated, onClose])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      dismissable={false}
      initialFocus={subjectInputRef}
    >
      <ModalHeader title="Create Group" onClose={onClose} />
      <ModalBody>
        <div>
          <label
            htmlFor="create-group-subject"
            className="c-field-label"
          >
            Group subject <span className="text-s-crit">*</span>
          </label>
          <input
            ref={subjectInputRef}
            id="create-group-subject"
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Enter group name..."
            className="c-input font-mono text-t2"
          />
        </div>

        <div>
          <label className="c-field-label">
            Participants <span className="text-s-crit">*</span>
            {participants.length > 0 && (
              <span className="text-t4 ml-[var(--sp-2)]">
                ({participants.length} selected)
              </span>
            )}
          </label>
          <ContactSearchPicker
            lineName={lineName}
            selected={participants}
            onAdd={c => setParticipants(prev => [...prev, c])}
            onRemove={jid => setParticipants(prev => prev.filter(p => p.jid !== jid))}
            placeholder="Search contacts..."
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleCreate}
          disabled={submitting || !subject.trim() || participants.length === 0}
          icon={<Users size={13} strokeWidth={1.75} />}
        >
          {submitting ? 'Creating...' : 'Create Group'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
