import { useState, useEffect, useCallback } from 'react'
import { X, Clock, RefreshCw, FileText, MessageSquare } from 'lucide-react'
import { api } from '../../lib/api.js'
import { useToast } from '../../hooks/toast-context.js'
import { ChatPicker } from '../shared/ChatPicker.js'
import { cronToHuman } from './scheduled-utils.js'
import type { ChatItem, ScheduledMessage } from '../../types.js'

export interface ScheduleComposerModalProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
  lineName: string
  chats: ChatItem[]
  editMessage?: ScheduledMessage
}

type ContentType = 'text' | 'media'

const RECURRENCE_PRESETS = [
  { label: 'Daily',   cron: '0 9 * * *' },
  { label: 'Weekly',  cron: '0 9 * * 1' },
  { label: 'Monthly', cron: '0 9 1 * *' },
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
  const [recurring, setRecurring] = useState(false)
  const [cronExpr, setCronExpr] = useState('0 9 * * *')
  const [submitting, setSubmitting] = useState(false)

  // Populate from editMessage when opening
  useEffect(() => {
    if (!open) return
    if (editMessage) {
      // Find matching chat
      const match = chats.find(c => c.conversationKey === editMessage.chatJid) ?? null
      setSelectedChat(match)
      setContentType((editMessage.contentType === 'text' ? 'text' : 'media') as ContentType)
      setText((editMessage.payload.text as string) ?? '')
      setMediaPath((editMessage.payload.path as string) ?? '')
      setCaption((editMessage.payload.caption as string) ?? '')
      setDatetimeLocal(tsToDatetimeLocal(editMessage.scheduledAt))
      setRecurring(!!editMessage.recurrence)
      setCronExpr(editMessage.recurrence ?? '0 9 * * *')
    } else {
      // Reset for new message
      setSelectedChat(null)
      setContentType('text')
      setText('')
      setMediaPath('')
      setCaption('')
      setDatetimeLocal(defaultDatetimeLocal())
      setRecurring(false)
      setCronExpr('0 9 * * *')
    }
  }, [open, editMessage, chats])

  // Escape key
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

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

    if (recurring && cronExpr.trim()) {
      body.recurrence = cronExpr.trim()
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
    recurring, cronExpr, lineName, isEditing, editMessage, toast, onCreated, onClose,
  ])

  if (!open) return null

  const cronPreview = recurring ? cronToHuman(cronExpr) : ''

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'var(--overlay)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-dialog-title"
        className="flex flex-col overflow-hidden"
        style={{
          background: 'var(--color-d2)',
          borderWidth: 'var(--bw)',
          borderStyle: 'solid',
          borderColor: 'var(--b2)',
          borderRadius: 'var(--radius-lg)',
          width: 'var(--panel-composer)',
          maxWidth: '95vw',
          maxHeight: '90vh',
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
            <Clock size={16} strokeWidth={1.75} className="text-t4" />
            <span id="composer-dialog-title" className="font-sans font-semibold" style={{ fontSize: 'var(--font-size-lg)' }}>
              {isEditing ? 'Edit Scheduled Message' : 'Schedule Message'}
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="c-btn c-btn-ghost c-btn-sm">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto" style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
          <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>

            {/* Chat picker */}
            <div>
              <label className="font-mono text-t4 block" style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--sp-1)' }}>
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

            {/* Content type selector */}
            <div>
              <label className="font-mono text-t4 block" style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--sp-1)' }}>
                Content type
              </label>
              <div className="flex gap-2">
                {(['text', 'media'] as ContentType[]).map(ct => (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => setContentType(ct)}
                    className={`c-btn c-btn-sm font-mono flex items-center gap-1 ${contentType === ct ? 'c-btn-primary' : 'c-btn-ghost'}`}
                    style={{ fontSize: 'var(--font-size-xs)' }}
                  >
                    {ct === 'text' ? <MessageSquare size={12} strokeWidth={1.75} /> : <FileText size={12} strokeWidth={1.75} />}
                    {ct.charAt(0).toUpperCase() + ct.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Composer area */}
            {contentType === 'text' ? (
              <div>
                <label
                  htmlFor="composer-text"
                  className="font-mono text-t4 block"
                  style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--sp-1)' }}
                >
                  Message text
                </label>
                <textarea
                  id="composer-text"
                  value={text}
                  onChange={e => setText(e.target.value)}
                  placeholder="Type your message..."
                  rows={4}
                  className="w-full font-mono text-t2 bg-transparent outline-none resize-vertical"
                  style={{
                    fontSize: 'var(--font-size-data)',
                    padding: 'var(--sp-2) var(--sp-3)',
                    background: 'var(--color-d1)',
                    borderWidth: 'var(--bw)',
                    borderStyle: 'solid',
                    borderColor: 'var(--b1)',
                    borderRadius: 'var(--radius-md)',
                    minHeight: '96px',
                  }}
                />
              </div>
            ) : (
              <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
                <div>
                  <label
                    htmlFor="composer-path"
                    className="font-mono text-t4 block"
                    style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--sp-1)' }}
                  >
                    File path
                  </label>
                  <input
                    id="composer-path"
                    type="text"
                    value={mediaPath}
                    onChange={e => setMediaPath(e.target.value)}
                    placeholder="/path/to/file.jpg"
                    className="w-full font-mono text-t2 bg-transparent outline-none"
                    style={{
                      fontSize: 'var(--font-size-data)',
                      padding: 'var(--sp-2) var(--sp-3)',
                      background: 'var(--color-d1)',
                      borderWidth: 'var(--bw)',
                      borderStyle: 'solid',
                      borderColor: 'var(--b1)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  />
                </div>
                <div>
                  <label
                    htmlFor="composer-caption"
                    className="font-mono text-t4 block"
                    style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--sp-1)' }}
                  >
                    Caption (optional)
                  </label>
                  <textarea
                    id="composer-caption"
                    value={caption}
                    onChange={e => setCaption(e.target.value)}
                    placeholder="Optional caption..."
                    rows={2}
                    className="w-full font-mono text-t2 bg-transparent outline-none resize-vertical"
                    style={{
                      fontSize: 'var(--font-size-data)',
                      padding: 'var(--sp-2) var(--sp-3)',
                      background: 'var(--color-d1)',
                      borderWidth: 'var(--bw)',
                      borderStyle: 'solid',
                      borderColor: 'var(--b1)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  />
                </div>
              </div>
            )}

            {/* DateTime picker */}
            <div>
              <label
                htmlFor="composer-datetime"
                className="font-mono text-t4 block"
                style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--sp-1)' }}
              >
                Scheduled time (local)
              </label>
              <input
                id="composer-datetime"
                type="datetime-local"
                value={datetimeLocal}
                onChange={e => setDatetimeLocal(e.target.value)}
                className="font-mono text-t2 bg-transparent outline-none"
                style={{
                  fontSize: 'var(--font-size-data)',
                  padding: 'var(--sp-2) var(--sp-3)',
                  background: 'var(--color-d1)',
                  borderWidth: 'var(--bw)',
                  borderStyle: 'solid',
                  borderColor: 'var(--b1)',
                  borderRadius: 'var(--radius-md)',
                  colorScheme: 'dark',
                }}
              />
            </div>

            {/* Recurrence toggle */}
            <div>
              <div className="flex items-center gap-2" style={{ marginBottom: recurring ? 'var(--sp-3)' : 0 }}>
                <button
                  type="button"
                  onClick={() => setRecurring(!recurring)}
                  className={`c-btn c-btn-sm font-mono flex items-center gap-1 ${recurring ? 'c-btn-primary' : 'c-btn-ghost'}`}
                  style={{ fontSize: 'var(--font-size-xs)' }}
                >
                  <RefreshCw size={12} strokeWidth={1.75} />
                  Recurring
                </button>
                {!recurring && (
                  <span className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>
                    One-shot
                  </span>
                )}
              </div>

              {recurring && (
                <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
                  {/* Preset buttons */}
                  <div className="flex gap-2 flex-wrap">
                    {RECURRENCE_PRESETS.map(preset => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setCronExpr(preset.cron)}
                        className={`c-btn c-btn-sm font-mono ${cronExpr === preset.cron ? 'c-btn-primary' : 'c-btn-ghost'}`}
                        style={{ fontSize: 'var(--font-size-xs)' }}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  {/* Custom cron input */}
                  <input
                    type="text"
                    value={cronExpr}
                    onChange={e => setCronExpr(e.target.value)}
                    placeholder="Cron expression (min hr dom mon dow)"
                    className="font-mono text-t2 bg-transparent outline-none w-full"
                    style={{
                      fontSize: 'var(--font-size-data)',
                      padding: 'var(--sp-2) var(--sp-3)',
                      background: 'var(--color-d1)',
                      borderWidth: 'var(--bw)',
                      borderStyle: 'solid',
                      borderColor: 'var(--b1)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  />
                  {/* Preview */}
                  {cronPreview && (
                    <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-info, #3b82f6)' }}>
                      {cronPreview}
                    </div>
                  )}
                </div>
              )}
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
            onClick={handleSubmit}
            disabled={submitting || !selectedChat}
            className="c-btn c-btn-primary font-mono flex items-center gap-1"
            style={{ fontSize: 'var(--font-size-data)' }}
          >
            <Clock size={13} strokeWidth={1.75} />
            {submitting ? 'Saving...' : isEditing ? 'Update' : 'Schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}
