import { useState, useEffect, useCallback } from 'react'
import { X, Users } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import { useToast } from '../../hooks/toast-context.js'
import { ContactSearchPicker } from '../shared/ContactSearchPicker.js'
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

  // Reset on open
  useEffect(() => {
    if (open) {
      setSubject('')
      setParticipants([])
    }
  }, [open])

  // Escape key
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

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

  if (!open) return null

  const inputStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-data)',
    padding: 'var(--sp-2) var(--sp-3)',
    background: 'var(--color-d1)',
    borderWidth: 'var(--bw)',
    borderStyle: 'solid',
    borderColor: 'var(--b1)',
    borderRadius: 'var(--radius-md)',
    width: '100%',
    outline: 'none',
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'var(--overlay)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-group-dialog-title"
        className="flex flex-col overflow-hidden"
        style={{
          background: 'var(--color-d2)',
          borderWidth: 'var(--bw)',
          borderStyle: 'solid',
          borderColor: 'var(--b2)',
          borderRadius: 'var(--radius-lg)',
          width: 'var(--panel-composer)',
          maxWidth: '90%',
          maxHeight: '80vh',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between flex-shrink-0"
          style={{ padding: 'var(--sp-4) var(--sp-5)', borderBottom: 'var(--bw) solid var(--b1)' }}
        >
          <div className="flex items-center gap-2">
            <Users size={16} strokeWidth={1.75} className="text-t4" />
            <span id="create-group-dialog-title" className="font-sans font-semibold" style={{ fontSize: 'var(--font-size-lg)' }}>
              Create Group
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="c-btn c-btn-ghost c-btn-sm">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto" style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
          <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>

            {/* Subject */}
            <div>
              <label
                htmlFor="create-group-subject"
                className="font-mono text-t4 block"
                style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--sp-1)' }}
              >
                Group subject <span style={{ color: 'var(--color-s-crit)' }}>*</span>
              </label>
              <input
                id="create-group-subject"
                type="text"
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="Enter group name..."
                className="font-mono text-t2"
                style={inputStyle}
                autoFocus
              />
            </div>

            {/* Participants */}
            <div>
              <label
                className="font-mono text-t4 block"
                style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--sp-1)' }}
              >
                Participants <span style={{ color: 'var(--color-s-crit)' }}>*</span>
                {participants.length > 0 && (
                  <span className="text-t4" style={{ marginLeft: 'var(--sp-2)' }}>
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

          </div>
        </div>

        {/* Footer */}
        <div
          className="flex justify-end gap-2 flex-shrink-0"
          style={{
            padding: 'var(--sp-3) var(--sp-5)',
            borderTop: 'var(--bw) solid var(--b1)',
            background: 'var(--color-d1)',
          }}
        >
          <button type="button" onClick={onClose} className="c-btn c-btn-ghost" disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={submitting || !subject.trim() || participants.length === 0}
            className="c-btn c-btn-primary font-mono flex items-center gap-1"
            style={{ fontSize: 'var(--font-size-data)' }}
          >
            <Users size={13} strokeWidth={1.75} />
            {submitting ? 'Creating...' : 'Create Group'}
          </button>
        </div>
      </div>
    </div>
  )
}
