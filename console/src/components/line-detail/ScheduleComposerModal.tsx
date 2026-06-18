/**
 * ScheduleComposerModal — migrated to Modal primitive (B3 wave-2).
 *
 * Migration:
 *   - Removes ad-hoc backdrop div, stopPropagation, bubble-phase Escape effect,
 *     and `if (!open) return null` gate.
 *   - dismissable=false: backdrop click was silently destroying eight fields of
 *     state with no recovery path. modal.md: explicit Cancel/Schedule verbs exist
 *     — protective default applied. Inverts a tested behaviour (C-B3W2-2).
 *   - Header Clock icon dropped per modal.md anatomy (ConfirmDialog/CreateGroupModal
 *     precedent). Clock on the footer primary button is KEPT.
 *   - Width: --panel-composer 540px → size="md" 560px (+20px, CreateGroupModal
 *     precedent, tokens-v3 §6.12).
 *   - Two binary toggle pairs (Text/Media, Recurring/One-shot) → ToolbarTimeRange
 *     segmented control (DD-15 closure for this file; C-B3W2-4: toolbar-namespaced
 *     name in modal body accepted this wave).
 *   - Stray empty style={{ }} on datetime input dropped in passing.
 *   - Token deletions: --panel-composer, --panel-max-inline-wide, --modal-max-h-lg
 *     retired (last consumers gone; verified zero remaining references).
 *   - GAINS: stacking-aware Escape (replaces hand-rolled bubble-phase handler),
 *     pointerdown outside-click semantics, focus trap, focus restoration.
 *   - Public prop interface, reset-on-open, submit pipeline, toasts unchanged.
 *   - Phase A datetime primitive: the prior `<input type="datetime-local">` +
 *     recurring toggle + preset buttons + free-text cron box is replaced with
 *     `<DateTimePicker>` from `primitives/DateTimePicker.tsx`. The `recurring`
 *     boolean + `cronExpr` state collapse to a single `RecurrenceValue` state,
 *     with `recurrenceToCron`/`cronToRecurrence` making submit/edit-load a
 *     one-liner.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Clock } from 'lucide-react'
import { api } from '../../lib/api.js'
import { useToast } from '../../hooks/toast-context.js'
import { ChatPicker } from '../shared/ChatPicker.js'
import type { ChatItem, ScheduledMessage } from '../../types.js'
import {
  Modal,
  ModalHeader,
  ModalBody,
  ModalFooter,
  TextArea,
  TextInput,
  DateTimePicker,
  type RecurrenceValue,
  recurrenceToCron,
  cronToRecurrence,
} from '../primitives'
import { Button } from '../primitives/Button'
import { ToolbarTimeRange } from '../primitives/Toolbar'

export interface ScheduleComposerModalProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
  lineName: string
  chats: ChatItem[]
  editMessage?: ScheduledMessage
}

type ContentType = 'text' | 'media'

const CONTENT_TYPE_OPTIONS = [
  { label: 'Text',  value: 'text' },
  { label: 'Media', value: 'media' },
]

/** Convert a unix timestamp (seconds) to datetime-local input value (local time) */
function tsToDatetimeLocal(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** Convert datetime-local input value to unix timestamp (seconds) */
function datetimeLocalToTs(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000)
}

/** Default datetime: now + 1 hour, rounded to next quarter */
function defaultDatetimeLocal(): string {
  const d = new Date()
  d.setHours(d.getHours() + 1)
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0)
  return tsToDatetimeLocal(Math.floor(d.getTime() / 1000))
}


export function ScheduleComposerModal({
  open,
  onClose,
  onCreated,
  lineName,
  chats,
  editMessage,
}: ScheduleComposerModalProps) {
  const toast = useToast()
  const isEditing = !!editMessage && editMessage.id > 0

  // --- State ---
  const [selectedChat, setSelectedChat] = useState<ChatItem | null>(null)
  const [contentType, setContentType] = useState<ContentType>('text')
  const [text, setText] = useState('')
  const [mediaPath, setMediaPath] = useState('')
  const [caption, setCaption] = useState('')
  const [datetimeLocal, setDatetimeLocal] = useState(defaultDatetimeLocal)
  const [recurrence, setRecurrence] = useState<RecurrenceValue>({ kind: 'once' })
  const [submitting, setSubmitting] = useState(false)

  // Populate from editMessage when opening. Keyed on the open/editMessage identity via a
  // ref so it fires exactly once per open (or edit-target change) — NOT every time the
  // `chats` array reference churns (chats refetch on window focus / unreadCount updates),
  // which would otherwise clobber the operator's in-progress edits with a silent reset.
  const populatedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      populatedKeyRef.current = null
      return
    }
    const key = editMessage ? `edit:${editMessage.id}` : 'new'
    if (key === populatedKeyRef.current) return
    populatedKeyRef.current = key
    if (editMessage) {
      const match = chats.find(c => c.conversationKey === editMessage.chatJid) ?? null
      setSelectedChat(match)
      setContentType((editMessage.contentType === 'text' ? 'text' : 'media') as ContentType)
      setText((editMessage.payload.text as string) ?? '')
      setMediaPath((editMessage.payload.path as string) ?? '')
      setCaption((editMessage.payload.caption as string) ?? '')
      setDatetimeLocal(tsToDatetimeLocal(editMessage.scheduledAt))
      setRecurrence(cronToRecurrence(editMessage.recurrence))
    } else {
      // Reset for new message
      setSelectedChat(null)
      setContentType('text')
      setText('')
      setMediaPath('')
      setCaption('')
      setDatetimeLocal(defaultDatetimeLocal())
      setRecurrence({ kind: 'once' })
    }
  }, [open, editMessage, chats])

  // Resolve the edit target's chat once `chats` loads (if it arrived after the modal
  // opened). Only fills an unset selection — never overwrites other in-progress edits.
  useEffect(() => {
    if (!open || !editMessage || selectedChat) return
    const match = chats.find(c => c.conversationKey === editMessage.chatJid)
    if (match) setSelectedChat(match)
  }, [open, editMessage, chats, selectedChat])

  const handleSubmit = useCallback(async () => {
    if (!selectedChat) {
      toast.error('Please select a chat')
      return
    }
    const scheduledAt = datetimeLocalToTs(datetimeLocal)
    if (isNaN(scheduledAt) || scheduledAt <= 0) {
      toast.error('Please set a valid scheduled time')
      return
    }

    if (contentType === 'text') {
      if (!text.trim()) { toast.error('Message text is required'); return }
    } else {
      if (!mediaPath.trim()) { toast.error('File path is required'); return }
    }

    // Validate scheduled time is in the future
    if (scheduledAt <= Math.floor(Date.now() / 1000)) {
      toast.error('Scheduled time must be in the future')
      return
    }

    // Build the MCP schedule_message params — the backend infers content type from filePath extension
    const body: Record<string, unknown> = {
      chatJid: selectedChat.conversationKey,
      chatName: selectedChat.name,
      scheduled_at: scheduledAt,
    }
    if (contentType === 'text') {
      body.text = text.trim()
    } else {
      body.filePath = mediaPath.trim()
      if (caption.trim()) body.caption = caption.trim()
    }

    const cron = recurrenceToCron(recurrence)
    if (cron) {
      body.recurrence = cron
    }

    setSubmitting(true)
    try {
      if (isEditing && editMessage) {
        await api.updateScheduled(lineName, editMessage.id, body)
        toast.success('Scheduled message updated')
      } else {
        await api.createScheduled(lineName, body)
        toast.success('Message scheduled')
      }
      onCreated()
      onClose()
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSubmitting(false)
    }
  }, [
    selectedChat, datetimeLocal, contentType, text, mediaPath, caption,
    recurrence, lineName, isEditing, editMessage, toast, onCreated, onClose,
  ])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      dismissable={false}
    >
      <ModalHeader
        title={isEditing ? 'Edit Scheduled Message' : 'Schedule Message'}
        onClose={onClose}
      />

      <ModalBody>
        {/* Chat picker */}
        <div>
          <label className="c-field-label">
            Target chat
          </label>
          <ChatPicker
            chats={chats}
            selected={selectedChat}
            onSelect={setSelectedChat}
            onClear={() => setSelectedChat(null)}
            placeholder="Search chats..."
          />
        </div>

        {/* Content type selector — ToolbarTimeRange seg (DD-15, C-B3W2-4) */}
        <div>
          <label className="c-field-label">
            Content type
          </label>
          <ToolbarTimeRange
            label="Content type"
            options={CONTENT_TYPE_OPTIONS}
            value={contentType}
            onChange={(v) => setContentType(v as ContentType)}
          />
        </div>

        {/* Composer area */}
        {contentType === 'text' ? (
          <div>
            <label
              htmlFor="composer-text"
              className="c-field-label"
            >
              Message text
            </label>
            <TextArea
              id="composer-text"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Type your message..."
              rows={4}
              minHeight={96}
              className="text-text-2 h-auto"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-[var(--sp-3)]">
            <div>
              <label
                htmlFor="composer-path"
                className="c-field-label"
              >
                File path
              </label>
              <TextInput
                id="composer-path"
                type="text"
                value={mediaPath}
                onChange={e => setMediaPath(e.target.value)}
                placeholder="/path/to/file.jpg"
                className="text-text-2"
              />
            </div>
            <div>
              <label
                htmlFor="composer-caption"
                className="c-field-label"
              >
                Caption (optional)
              </label>
              <TextArea
                id="composer-caption"
                value={caption}
                onChange={e => setCaption(e.target.value)}
                placeholder="Optional caption..."
                rows={2}
                className="text-text-2 h-auto"
              />
            </div>
          </div>
        )}

        {/* DateTime picker + segmented recurrence row (Phase A primitive) */}
        <DateTimePicker
          value={datetimeLocal}
          onChange={setDatetimeLocal}
          recurrence={recurrence}
          onRecurrenceChange={setRecurrence}
        />

      </ModalBody>

      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={submitting || !selectedChat}
          icon={<Clock size={13} strokeWidth={1.75} />}
        >
          {submitting ? 'Saving...' : isEditing ? 'Update' : 'Schedule'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
