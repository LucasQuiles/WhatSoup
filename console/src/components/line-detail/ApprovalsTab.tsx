import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Card, Pill, Button } from '../primitives'
import ConfirmDialog from '../ConfirmDialog'
import { api } from '../../lib/api'
import { useToast } from '../../hooks/toast-context'
import { statusBadgeStyle } from '../../lib/status-severity'
import { formatRelative } from '../../lib/format-time'
import type { Freshness } from '../../lib/freshness'
import type { ApprovalEntry, ApprovalsPayload } from '../../types'

/**
 * ApprovalsTab — the console decision queue (D-4 build; design:
 * docs/proposals/2026-07-19-approval-queue.md).
 *
 * Renders the line's pending AskUserQuestion polls and delivers the
 * operator's decision through the fleet → instance poll-resolution path —
 * the SAME path an in-chat vote takes (UX-20 parity). Console button,
 * poll vote, and reaction are three renderings of one decision; first
 * resolution wins, and a stale decision surfaces the race honestly (409
 * → error toast, no fake success). textFallback entries are answerable
 * from the console (v1.1): the decision delivers as the typed answer
 * through the same poll-resolution path. Fail-closed: a fleet read error
 * renders an error panel — never a fake-empty queue (PDR-3 invariant).
 */

function truncateMiddle(s: string, max = 25): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) * 0.55)
  const tail = Math.floor((max - 1) * 0.45)
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

interface PendingDecision {
  entry: ApprovalEntry
  questionIndex: number
  selectedOptions: string[]
}

export function ApprovalsTab({ payload, isLoading, freshness, lineName }: {
  payload: ApprovalsPayload | undefined;
  isLoading: boolean;
  freshness: Freshness;
  /** Owning line — the decision api target + invalidate key. */
  lineName: string;
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null)
  const [executing, setExecuting] = useState(false)
  const executingRef = useRef(false)

  const executeDecision = async () => {
    if (!pendingDecision || executingRef.current) return
    executingRef.current = true
    setExecuting(true)
    const { entry, questionIndex, selectedOptions } = pendingDecision
    try {
      await api.postApprovalDecision(lineName, {
        mapKey: entry.mapKey,
        questionIndex,
        selectedOptions,
      })
      toast.success(`Decision delivered on ${lineName} — the runtime resumes through its own poll-resolution path`)
      queryClient.invalidateQueries({ queryKey: ['approvals', lineName] })
    } catch (e) {
      toast.error(`Decision failed: ${(e as Error).message}`)
    } finally {
      executingRef.current = false
      setExecuting(false)
      setPendingDecision(null)
    }
  }

  const entries = payload?.approvals ?? []

  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      {/* Freshness/summary strip — same contract as the other line tabs */}
      <div className="flex items-center gap-[var(--sp-2)] flex-wrap">
        <Pill variant="static" tone={entries.length > 0 ? 'warn' : 'neutral'} size="sm">
          {`${entries.length} pending`}
        </Pill>
        {(payload?.parseErrors ?? 0) > 0 && (
          <Pill variant="static" tone="warn" size="sm">
            {`${payload!.parseErrors} unreadable`}
          </Pill>
        )}
        <span
          className={`c-label${freshness.stale || payload?.readError ? ' text-s-warn' : ''}`}
          title={payload ? `observed ${payload.observedAt}` : undefined}
        >
          {payload?.readError
            ? 'read unavailable'
            : payload
              ? `observed ${formatRelative(payload.observedAt)}${freshness.stale ? ' (stale)' : ''}`
              : 'not observed'}
        </span>
      </div>

      {isLoading || !payload ? (
        <span className="c-label">Loading…</span>
      ) : payload.readError ? (
        <Card variant="base" className="py-[var(--sp-4)] px-[var(--sp-5)]">
          <span className="c-label text-s-warn">
            Approval data unavailable — the fleet could not read this instance's database. This is a read failure, not an empty queue.
          </span>
        </Card>
      ) : entries.length === 0 ? (
        <Card variant="base" className="py-[var(--sp-4)] px-[var(--sp-5)]">
          <span className="c-label text-text-2">No pending decisions — the line is not waiting on you for anything.</span>
        </Card>
      ) : (
        entries.map((entry) => (
          <ApprovalCard
            key={entry.mapKey}
            entry={entry}
            observedAt={payload ? new Date(payload.observedAt).getTime() : 0}
            onDecide={(questionIndex, selectedOptions) => setPendingDecision({ entry, questionIndex, selectedOptions })}
          />
        ))
      )}

      <ConfirmDialog
        open={!!pendingDecision}
        title="Deliver this decision?"
        confirmLabel="Confirm decision"
        confirmVariant="primary"
        confirmDisabled={executing}
        confirmLoading={executing}
        onConfirm={executeDecision}
        onCancel={() => setPendingDecision(null)}
      >
        {pendingDecision && (
          <>
            Answer <strong>{pendingDecision.selectedOptions.join(', ')}</strong> to
            “{pendingDecision.entry.questions[pendingDecision.questionIndex]?.question}” on
            instance <strong>{lineName}</strong>. The decision resolves through the same
            poll-resolution path an in-chat vote takes — if it was already answered
            elsewhere, the server will say so honestly.
          </>
        )}
      </ConfirmDialog>
    </div>
  )
}

function ApprovalCard({ entry, observedAt, onDecide }: {
  entry: ApprovalEntry;
  /** Fleet-stamped observation time (payload.observedAt) — the amber
   *  threshold derives from props, never wall-clock (react-hooks/purity). */
  observedAt: number;
  onDecide: (questionIndex: number, selectedOptions: string[]) => void;
}) {
  const answeredCount = Object.keys(entry.answersCollected).length

  return (
    <Card variant="base" className="overflow-hidden">
      <div className="flex items-center justify-between c-toolbar bg-surface-raised c-border-b">
        <span className="font-mono text-data" title={entry.chatJid}>
          {truncateMiddle(entry.chatJid)}
        </span>
        <span className="flex items-center gap-[var(--sp-2)]">
          {entry.source === 'askuser' && (
            <span className="c-label" style={statusBadgeStyle('ok')}>blocking</span>
          )}
          {entry.hardClosesAt !== null && (
            <span
              className={`c-label${entry.hardClosesAt - observedAt < 60_000 ? ' text-s-warn' : ''}`}
              title={new Date(entry.hardClosesAt).toISOString()}
            >
              {`closes ${formatRelative(new Date(entry.hardClosesAt).toISOString())}`}
            </span>
          )}
        </span>
      </div>
      <div className="flex flex-col py-[var(--sp-3)] px-[var(--sp-4)] gap-[var(--sp-3)]">
        {entry.questions.map((q, qi) => (
          <QuestionBlock
            key={qi}
            questionIndex={qi}
            question={q}
            answered={entry.answersCollected[qi] !== undefined}
            isCurrent={qi === entry.currentQuestionIndex}
            readOnly={false}
            onDecide={onDecide}
          />
        ))}
        {answeredCount > 0 && (
          <span className="c-label text-text-2">{`${answeredCount} of ${entry.questions.length} answered`}</span>
        )}
        {entry.mode === 'textFallback' && (
          <span className="c-label text-text-2">
            Chat-text fallback mode — your decision is delivered as the typed answer through the same poll-resolution path.
          </span>
        )}
      </div>
    </Card>
  )
}

function QuestionBlock({ questionIndex, question, answered, isCurrent, readOnly, onDecide }: {
  questionIndex: number;
  question: ApprovalEntry['questions'][number];
  answered: boolean;
  isCurrent: boolean;
  readOnly: boolean;
  onDecide: (questionIndex: number, selectedOptions: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = (label: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-[var(--sp-2)]">
      <span className="text-body">
        {question.question}
        {!isCurrent && !answered && <span className="c-label text-text-2"> (queued)</span>}
      </span>
      {answered ? (
        <span className="c-label" style={statusBadgeStyle('ok')}>answered</span>
      ) : readOnly ? null : question.multiSelect ? (
        <>
          <div className="flex items-center flex-wrap gap-[var(--sp-2)]">
            {question.options.map((o) => (
              <Button
                key={o.label}
                size="xs"
                variant={selected.has(o.label) ? 'primary' : 'neutral'}
                title={o.description}
                onClick={() => toggle(o.label)}
                aria-pressed={selected.has(o.label)}
              >
                {o.label}
              </Button>
            ))}
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={selected.size === 0}
            onClick={() => onDecide(questionIndex, Array.from(selected))}
          >
            Submit {selected.size > 0 ? `${selected.size} selected` : 'decision'}
          </Button>
        </>
      ) : (
        <div className="flex items-center flex-wrap gap-[var(--sp-2)]">
          {question.options.map((o) => (
            <Button
              key={o.label}
              size="sm"
              variant="neutral"
              title={o.description}
              onClick={() => onDecide(questionIndex, [o.label])}
            >
              {o.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

export default ApprovalsTab
