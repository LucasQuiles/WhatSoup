import { SlidersHorizontal, GitBranch, Bot } from 'lucide-react'
import EmptyState from '../EmptyState'
import { buildConfigEntries, TYPE_COLOR } from './config-helpers'
import type { ConfigEntryType } from './config-helpers'
import type { Mode, LineInstance } from './types'

function ConfigValue({ value, type }: { value: string; type: ConfigEntryType }) {
  return <span style={{ color: TYPE_COLOR[type] }}>{value}</span>
}

export function ModeTab({
  mode,
  line,
  onEditConfig,
  onChangeMode,
}: {
  mode: Mode
  line: LineInstance
  onEditConfig: () => void
  onChangeMode: () => void
}) {
  if (mode === 'passive') {
    return (
      <div
        style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', padding: 'var(--sp-7)' }}
      >
        <EmptyState
          icon={<Bot size={40} strokeWidth={1.25} />}
          title="Read-only Mode"
          description="Passive instances listen and store — no configuration required."
        />
        <div className="flex justify-center" style={{ marginTop: 'var(--sp-5)' }}>
          <button
            onClick={onChangeMode}
            className="c-btn"
            style={{ fontSize: 'var(--font-size-label)' }}
          >
            <GitBranch size={13} strokeWidth={1.75} /> Change Mode
          </button>
        </div>
      </div>
    )
  }

  const rawConfig = line.config ?? {}
  const config = buildConfigEntries(rawConfig)

  return (
    <div
      style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', padding: 'var(--sp-7)' }}
    >
      <div
        className="flex items-center justify-between flex-wrap"
        style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-5)' }}
      >
        <div className="c-col-header">
          {mode} Configuration
        </div>
        <div className="flex flex-wrap" style={{ gap: 'var(--sp-2)' }}>
          <button
            onClick={onEditConfig}
            className="c-btn"
            style={{ fontSize: 'var(--font-size-label)' }}
          >
            <SlidersHorizontal size={13} strokeWidth={1.75} /> Edit Configuration
          </button>
          <button
            onClick={onChangeMode}
            className="c-btn"
            style={{ fontSize: 'var(--font-size-label)' }}
          >
            <GitBranch size={13} strokeWidth={1.75} /> Change Mode
          </button>
        </div>
      </div>
      {/* c-config block — syntax-highlighted JSON-like display */}
      <div
        className="font-mono overflow-x-auto whitespace-pre leading-relaxed"
        style={{
          background: 'var(--color-d1)',
          borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--msg-pad-h) var(--sp-4)',
          fontSize: 'var(--font-size-data)',
          color: 'var(--color-t2)',
        }}
      >
        {'{\n'}
        {config.map((entry, i) => (
          <span key={entry.key}>
            {'  '}<span style={{ color: 'var(--color-m-cht)' }}>{entry.key}</span>
            <span style={{ color: 'var(--color-t5)' }}>: </span>
            <ConfigValue value={entry.value} type={entry.type} />
            {i < config.length - 1 ? ',' : ''}
            {'\n'}
          </span>
        ))}
        {'}'}
      </div>
    </div>
  )
}
