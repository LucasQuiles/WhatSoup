import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import StatusDot from './StatusDot'
import ModeBadge from './ModeBadge'
import type { LineInstance } from '../types'
import { displayInstanceName } from '../lib/text-utils'

interface LinePickerProps {
  lines: LineInstance[]
  activeLine: string
  onSelect: (name: string) => void
  variant?: 'toolbar' | 'compact'
}

export default function LinePicker({ lines, activeLine, onSelect, variant = 'toolbar' }: LinePickerProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const currentLine = lines.find(l => l.name === activeLine)

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  if (variant === 'toolbar') {
    return (
      <div className="relative" ref={containerRef}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between font-sans text-t1 hover:bg-d4 cursor-pointer bg-d3 c-toolbar c-hover text-[var(--font-size-body)] c-border-b min-h-[var(--toolbar-h)]"
        >
          <div className="flex items-center gap-[var(--sp-2)]">
            {currentLine && <StatusDot status={currentLine.status} size="sm" />}
            <span className="font-medium">{activeLine || 'Select a line'}</span>
            {currentLine && <ModeBadge mode={currentLine.mode} />}
          </div>
          <ChevronDown
            size={14}
            className={`text-t4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {open && (
          <div
            className="absolute top-full left-0 right-0 z-10 max-h-64 overflow-auto scrollbar-hide bg-d6 border border-b2 shadow-[var(--shadow-md)]"
            style={{
              borderTopWidth: 0,
              borderRadius: '0 0 var(--radius-md) var(--radius-md)',
            }}
          >
            {lines.map(line => (
              <button
                key={line.name}
                type="button"
                onClick={() => { onSelect(line.name); setOpen(false) }}
                className={`w-full flex items-center text-left cursor-pointer c-dropdown-item py-[var(--sp-2)] px-[var(--sp-4)] gap-[var(--sp-2)] text-[var(--font-size-body)] ${
                  line.name === activeLine ? 'bg-d4 text-t1' : 'text-t3'
                }`}
              >
                <StatusDot status={line.status} size="sm" />
                <span className="flex-1">{line.name}</span>
                <ModeBadge mode={line.mode} />
                <span className="c-label ml-auto">{line.phone}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // compact variant
  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 font-mono cursor-pointer c-hover text-t1 bg-d4 text-[var(--font-size-label)] tracking-[var(--tracking-pill)] py-px px-[var(--sp-3)] rounded-sm border border-b2"
      >
        {currentLine && <StatusDot status={currentLine.status} size="sm" />}
        <span className="font-medium">
          {activeLine ? displayInstanceName(activeLine) : 'Select line'}
        </span>
        <ChevronDown
          size={11}
          className={`text-t4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 z-20 max-h-64 overflow-auto min-w-[var(--dropdown-min-w)] bg-d6 border border-b2 rounded-md shadow-[var(--shadow-md)]"
        >
          {lines.map(line => (
            <button
              key={line.name}
              type="button"
              onClick={() => { onSelect(line.name); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer c-dropdown-item text-[var(--font-size-sm)] ${
                line.name === activeLine ? 'bg-d4 text-t1' : 'text-t3'
              }`}
            >
              <StatusDot status={line.status} size="sm" />
              <span className="font-mono">{displayInstanceName(line.name)}</span>
              <ModeBadge mode={line.mode} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
