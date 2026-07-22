import { useState } from 'react'
import {
  MessageSquare,
  Image,
  Film,
  Mic,
  FileText,
  MapPin,
  UserPlus,
  BarChart3,
  Sticker,
  RefreshCw,
  Loader2,
  Trash2,
  Pencil,
  Copy,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import type { ScheduledMessage } from '../../types.js'
import { formatFullTime } from '../../lib/format-time'
import { escapeDisplayControls } from '../../lib/text-utils'
import { Button } from '../primitives/Button'
import { Card } from '../primitives'
import { statusColor, statusLabel, contentTypeLabel, cronToHuman } from './scheduled-utils.js'

interface ScheduledMessageRowProps {
  message: ScheduledMessage
  onCancel: (id: number) => void
  onEdit: (message: ScheduledMessage) => void
  onDuplicate: (message: ScheduledMessage) => void
  cancelling: number | null
}

function ContentTypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  const props = { size, strokeWidth: 1.75, className: 'text-text-2 flex-shrink-0' }
  switch (type) {
    case 'text':     return <MessageSquare {...props} />
    case 'image':    return <Image {...props} />
    case 'video':    return <Film {...props} />
    case 'audio':    return <Mic {...props} />
    case 'document': return <FileText {...props} />
    case 'location': return <MapPin {...props} />
    case 'contact':  return <UserPlus {...props} />
    case 'poll':     return <BarChart3 {...props} />
    case 'sticker':  return <Sticker {...props} />
    default:         return <MessageSquare {...props} />
  }
}

function messagePreview(message: ScheduledMessage): string {
  if (message.contentType === 'text') {
    const text = (message.payload.text as string) ?? ''
    return text.length > 100 ? text.slice(0, 97) + '...' : text
  }
  if (message.contentType === 'image' || message.contentType === 'video' || message.contentType === 'audio' || message.contentType === 'document') {
    const caption = (message.payload.caption as string) ?? ''
    if (caption) return caption.length > 100 ? caption.slice(0, 97) + '...' : caption
  }
  return contentTypeLabel(message.contentType)
}

export function ScheduledMessageRow({ message, onCancel, onEdit, onDuplicate, cancelling }: ScheduledMessageRowProps) {
  const [expanded, setExpanded] = useState(false)
  const isPending = message.status === 'pending'
  const isRecurring = !!message.recurrence
  const preview = messagePreview(message)
  const chatLabel = escapeDisplayControls(message.chatName ?? message.chatJid)
  const metaDividerStyle = { opacity: 'var(--opacity-faint)' }

  return (
    <Card
      className="overflow-hidden"
    >
      {/* Main row */}
      <div className="flex items-start gap-3 py-[var(--sp-3)] px-[var(--sp-4)]">
        {/* Content type icon */}
        <div style={{ marginTop: 'calc(var(--sp-1) / 2)' }}>
          <ContentTypeIcon type={message.contentType} />
        </div>

        {/* Body */}
        <div className="flex-1 min-w-0">
          {/* Top line: preview + status badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <span
              title={preview || undefined}
              className="c-data truncate flex-1 min-w-0"
            >
              {preview || <span className="text-text-2 italic">(no preview)</span>}
            </span>
            {/* Status badge */}
            <span
              className="flex-shrink-0 c-meta inline-flex items-center gap-[var(--sp-1)]"
              style={{
                color: statusColor(message.status),
              }}
            >
              <span
                className="inline-block shrink-0 w-[var(--radius-md)] h-[var(--radius-md)] rounded-full"
                style={{
                  background: statusColor(message.status),
                }}
              />
              {statusLabel(message.status)}
            </span>
          </div>

          {/* Second line: target + scheduled time */}
          <div className="flex items-center gap-2 flex-wrap c-label mt-[var(--sp-0h)]">
            <span title={chatLabel}>{chatLabel}</span>
            <span style={metaDividerStyle}>·</span>
            <span>{formatFullTime(message.scheduledAt)}</span>

            {/* Recurrence indicator */}
            {isRecurring && (
              <>
                <span style={metaDividerStyle}>·</span>
                <span className="flex items-center gap-1 text-m-cht">
                  <RefreshCw size={10} strokeWidth={1.75} />
                  {cronToHuman(message.recurrence!)}
                </span>
              </>
            )}

            {/* Run count */}
            {isRecurring && message.runCount > 0 && (
              <>
                <span style={metaDividerStyle}>·</span>
                <span>Sent {message.runCount}×</span>
              </>
            )}
          </div>

          {/* Error message if failed */}
          {message.status === 'failed' && message.error && (
            <div
              className="c-label text-s-crit mt-[var(--sp-0h)]"
            >
              {message.error}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {isPending && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onEdit(message)}
                aria-label="Edit scheduled message"
                className="font-mono"
                icon={<Pencil size={15} strokeWidth={1.75} />}
              />
              <Button
                variant="danger"
                size="sm"
                onClick={() => onCancel(message.id)}
                disabled={cancelling === message.id}
                aria-label={`Cancel scheduled message to ${chatLabel}`}
                className="font-mono"
                icon={cancelling === message.id
                  ? <Loader2 size={15} className="animate-spin" />
                  : <Trash2 size={15} strokeWidth={1.75} />}
              />
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDuplicate(message)}
            aria-label="Duplicate as new scheduled message"
            className="font-mono"
            title="Duplicate"
            icon={<Copy size={15} strokeWidth={1.75} />}
          />
          {/* Expand/collapse for next run + extra details */}
          {(isRecurring || message.retryCount > 0) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? 'Collapse details' : 'Expand details'}
              aria-expanded={expanded}
              aria-controls={`sched-details-${message.id}`}
              icon={expanded
                ? <ChevronUp size={15} strokeWidth={1.75} />
                : <ChevronDown size={15} strokeWidth={1.75} />}
            />
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          id={`sched-details-${message.id}`}
          className="c-label flex flex-wrap py-[var(--sp-2)] px-[var(--sp-4)] bg-surface-inset [border-top:var(--bw)_solid_var(--border-hairline)] gap-[var(--sp-3)]"
        >
          {message.nextRunAt && (
            <span>Next run: {formatFullTime(message.nextRunAt)}</span>
          )}
          {message.sentAt && (
            <span>Last sent: {formatFullTime(message.sentAt)}</span>
          )}
          {message.retryCount > 0 && (
            <span>Retries: {message.retryCount}</span>
          )}
          <span>ID: {message.id}</span>
          <span>Created: {formatFullTime(message.createdAt)}</span>
        </div>
      )}
    </Card>
  )
}
