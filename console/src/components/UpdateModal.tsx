import { type FC, useReducer, useEffect, useCallback, useRef } from 'react'
import { X, Download, Check, Loader2, AlertCircle, RotateCcw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { api, getApiTicket, getFleetToken } from '../lib/api'
import type { LineInstance } from '../types'

interface UpdateModalProps {
  open: boolean
  onClose: () => void
  currentSha: string
  lines: LineInstance[]
}

type StepStatus = 'pending' | 'running' | 'done' | 'skip' | 'error'

interface StepState {
  step: string
  status: StepStatus
  message?: string
}

const STEP_LABELS: Record<string, string> = {
  pull: 'Pulling latest code',
  install: 'Installing dependencies',
  'console-install': 'Installing console dependencies',
  'console-build': 'Building console',
  restart: 'Restarting fleet server',
}

const STEP_ORDER = ['pull', 'install', 'console-install', 'console-build', 'restart']

type Phase = 'confirm' | 'updating' | 'restarting-fleet' | 'restart-instances' | 'done' | 'error'

type InstanceStatusValue = 'pending' | 'restarting' | 'done' | 'error'

interface ModalState {
  phase: Phase
  steps: StepState[]
  error: string | null
  instanceToggles: Record<string, boolean>
  instanceStatus: Record<string, InstanceStatusValue>
}

type ModalAction =
  | { type: 'reset'; toggles: Record<string, boolean> }
  | { type: 'setPhase'; phase: Phase }
  | { type: 'stepProgress'; step: string; status: StepStatus; message?: string }
  | { type: 'setError'; message: string; step?: string }
  | { type: 'toggleInstance'; name: string; on: boolean }
  | { type: 'instanceStatus'; name: string; status: InstanceStatusValue }

function makeInitialSteps(): StepState[] {
  return STEP_ORDER.map(s => ({ step: s, status: 'pending' as StepStatus }))
}

function reducer(state: ModalState, action: ModalAction): ModalState {
  switch (action.type) {
    case 'reset':
      return {
        phase: 'confirm',
        steps: makeInitialSteps(),
        error: null,
        instanceToggles: action.toggles,
        instanceStatus: {},
      }
    case 'setPhase':
      return { ...state, phase: action.phase }
    case 'stepProgress':
      return {
        ...state,
        steps: state.steps.map(s =>
          s.step === action.step ? { ...s, status: action.status, message: action.message } : s
        ),
      }
    case 'setError':
      return {
        ...state,
        phase: 'error',
        error: action.message,
        steps: action.step
          ? state.steps.map(s => s.step === action.step ? { ...s, status: 'error', message: action.message } : s)
          : state.steps,
      }
    case 'toggleInstance':
      return { ...state, instanceToggles: { ...state.instanceToggles, [action.name]: action.on } }
    case 'instanceStatus':
      return { ...state, instanceStatus: { ...state.instanceStatus, [action.name]: action.status } }
  }
}

function buildToggles(lines: LineInstance[]): Record<string, boolean> {
  const toggles: Record<string, boolean> = {}
  for (const line of lines) {
    toggles[line.name] = line.status === 'online'
  }
  return toggles
}

const UpdateModal: FC<UpdateModalProps> = ({ open, onClose, currentSha, lines }) => {
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    phase: 'confirm' as Phase,
    steps: makeInitialSteps(),
    error: null,
    instanceToggles: buildToggles(lines),
    instanceStatus: {},
  }))
  const { phase, steps, error, instanceToggles, instanceStatus } = state
  const abortRef = useRef<AbortController | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // hasErroredRef is set synchronously when a terminal error is dispatched so
  // that async closures can check it before React re-renders (F-058).
  const hasErroredRef = useRef(false)

  // Only reset when the modal opens — NOT when lines changes (that would
  // reset mid-update when the fleet restarts and health poller refetches).
  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      dispatch({ type: 'reset', toggles: buildToggles(lines) })
    }
    prevOpenRef.current = open
  }, [open, lines])

  // Close on Escape key
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const waitForFleetRestart = useCallback(() => {
    // Guard: if already polling, don't spawn duplicate intervals (RES-002)
    if (pollRef.current) return
    dispatch({ type: 'setPhase', phase: 'restarting-fleet' })
    let seenDown = false
    const poll = setInterval(async () => {
      try {
        const ver = await api.getVersion()
        if (seenDown || ver.sha !== currentSha) {
          clearInterval(poll)
          pollRef.current = null
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
          // Fleet is back — invalidate all cached queries so the dashboard
          // immediately shows fresh data without a page reload
          queryClient.invalidateQueries()
          dispatch({ type: 'setPhase', phase: 'restart-instances' })
        }
      } catch {
        seenDown = true
      }
    }, 2000)
    pollRef.current = poll

    timeoutRef.current = setTimeout(() => {
      clearInterval(poll)
      pollRef.current = null
      timeoutRef.current = null
      queryClient.invalidateQueries()
      dispatch({ type: 'setPhase', phase: 'restart-instances' })
    }, 60_000)
  }, [currentSha, queryClient])

  const startUpdate = useCallback(() => {
    dispatch({ type: 'setPhase', phase: 'updating' })
    // Reset error flag for this update run (F-058).
    hasErroredRef.current = false

    // Abort controller so handleClose can cancel the in-flight fetch (RES-006)
    const controller = new AbortController()
    abortRef.current = controller

    // Audience-scoped ticket (#313): mint an api-audience ticket rather than
    // sending the root meta-tag token directly. In dev (no meta-tag) skip
    // the header and let the proxy handle auth.
    void (async () => {
      let headers: Record<string, string> = {}
      if (getFleetToken()) {
        try {
          const ticket = await getApiTicket('api')
          headers = { 'Authorization': `Bearer ${ticket}` }
        } catch {
          hasErroredRef.current = true
          dispatch({ type: 'setError', message: 'Update failed: unable to authenticate' })
          return
        }
      }

      try {
        const response = await fetch('/api/update', {
          method: 'POST',
          headers,
          signal: controller.signal,
        })

        if (!response.ok) {
          hasErroredRef.current = true
          dispatch({ type: 'setError', message: `Update failed: ${response.status}` })
          return
        }

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        const read = async (): Promise<void> => {
          try {
            const { done, value } = await reader.read()
            if (done) {
              // F-058: only enter fleet-restart polling if the stream did not
              // already signal a terminal error; preserve the error phase.
              if (!hasErroredRef.current) waitForFleetRestart()
              return
            }
            buffer += decoder.decode(value, { stream: true })
            const chunks = buffer.split('\n\n')
            buffer = chunks.pop()!

            for (const block of chunks) {
              const eventMatch = block.match(/^event: (\w+)/)
              const dataMatch = block.match(/^data: (.+)$/m)
              if (!eventMatch || !dataMatch) continue

              const event = eventMatch[1]
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SSE stream JSON has no typed schema; expires 2026-07-01
              const data = JSON.parse(dataMatch[1]) as any

              if (event === 'progress') {
                dispatch({ type: 'stepProgress', step: data.step, status: data.status as StepStatus, message: data.message })
                if (data.step === 'restart' && data.status === 'running') {
                  dispatch({ type: 'setPhase', phase: 'restarting-fleet' })
                }
              } else if (event === 'error') {
                // Set ref before dispatch so the done-branch check (F-058) sees
                // the flag synchronously in the same microtask.
                hasErroredRef.current = true
                dispatch({ type: 'setError', message: data.message, step: data.step })
              }
            }
            await read()
          } catch {
            // Connection dropped — expected during restart; skip if already errored (F-058).
            if (!hasErroredRef.current) waitForFleetRestart()
          }
        }
        await read()
      } catch {
        // Aborted or network error — fleet may be restarting; skip if already errored (F-058).
        if (!hasErroredRef.current) waitForFleetRestart()
      }
    })()
  }, [waitForFleetRestart])

  const restartSelectedInstances = useCallback(async () => {
    const selected = Object.entries(instanceToggles).filter(([, on]) => on).map(([name]) => name)
    let allOk = true
    for (const name of selected) {
      dispatch({ type: 'instanceStatus', name, status: 'restarting' })
      try {
        await api.restart(name)
        dispatch({ type: 'instanceStatus', name, status: 'done' })
      } catch {
        dispatch({ type: 'instanceStatus', name, status: 'error' })
        allOk = false
      }
    }
    if (allOk && selected.length > 0) {
      dispatch({ type: 'setPhase', phase: 'done' })
      setTimeout(() => {
        onClose()
      }, 2200)
    }
  }, [instanceToggles, onClose])

  const handleClose = () => {
    // Abort in-flight fetch stream (RES-006)
    abortRef.current?.abort()
    abortRef.current = null
    // Clear any pending poll/timeout (RES-002)
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
    onClose()
  }

  if (!open) return null

  const stepIcon = (status: StepStatus) => {
    switch (status) {
      case 'pending': return <span className="text-t5 inline-block text-center w-[var(--feed-col-icon)]">○</span>
      case 'running': return <Loader2 size={16} className="text-m-cht animate-spin" />
      case 'done': return <Check size={16} className="text-s-ok" />
      case 'skip': return <span className="text-t5 inline-block text-center w-[var(--feed-col-icon)]">–</span>
      case 'error': return <AlertCircle size={16} className="text-s-crit" />
    }
  }

  return (
    <div
      className="c-dialog-backdrop"
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        onClick={(e) => e.stopPropagation()}
        className="w-[var(--panel-confirm)] max-w-[90%] bg-d2 c-border rounded-lg shadow-[var(--shadow-lg)] overflow-hidden"
      >
        {/* Header */}
        <div
          className="flex items-center justify-between py-[var(--sp-4)] px-[var(--sp-5)] c-border-b"
        >
          <div className="flex items-center gap-[var(--sp-2)]">
            <Download size={16} className="text-m-cht" />
            <span id="update-dialog-title" className="font-sans font-semibold text-lg">
              {phase === 'restart-instances' || phase === 'done' ? 'Update Complete' : 'Update WhatSoup'}
            </span>
          </div>
          <button type="button" onClick={handleClose} aria-label="Close" className="c-btn c-btn-ghost">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="py-[var(--sp-4)] px-[var(--sp-5)]">
          {/* Phase: confirm */}
          {phase === 'confirm' && (
            <div className="flex flex-col gap-[var(--sp-4)]">
              <p className="text-t3 text-body">
                Pull latest code, rebuild, and restart the fleet server?
              </p>
              <div className="flex justify-end gap-[var(--sp-2)]">
                <button type="button" onClick={handleClose} aria-label="Close" className="c-btn c-btn-ghost">Cancel</button>
                <button type="button" onClick={startUpdate} className="c-btn c-btn-primary">
                  <Download size={14} />
                  Update
                </button>
              </div>
            </div>
          )}

          {/* Phase: updating / restarting-fleet */}
          {(phase === 'updating' || phase === 'restarting-fleet') && (
            <div className="flex flex-col gap-[var(--sp-2)]">
              {steps.map(s => (
                <div key={s.step} className="flex items-center gap-[var(--sp-2)] py-[var(--sp-1)] px-0">
                  {stepIcon(s.status)}
                  <span className={`font-mono text-data ${s.status === 'skip' ? 'text-t5' : 'text-t2'}`}>
                    {STEP_LABELS[s.step] ?? s.step}
                  </span>
                  {s.message && s.status !== 'error' && (
                    <span className="text-t5 font-mono text-label">
                      {s.message}
                    </span>
                  )}
                </div>
              ))}
              {phase === 'restarting-fleet' && (
                <div className="flex items-center gap-[var(--sp-2)] py-[var(--sp-2)] px-0">
                  <Loader2 size={16} className="text-m-cht animate-spin" />
                  <span className="text-t3 font-mono text-data">
                    Waiting for fleet server...
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Phase: error */}
          {phase === 'error' && error && (
            <div className="flex flex-col gap-[var(--sp-3)]">
              <div className="flex items-start gap-[var(--sp-2)] p-[var(--sp-3)] bg-[var(--s-crit-soft)] rounded-md">
                <AlertCircle size={16} className="text-s-crit flex-shrink-0 mt-[var(--bw-accent)]" />
                <span className="text-t2 font-mono text-data">{error}</span>
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={handleClose} aria-label="Close" className="c-btn c-btn-ghost">Close</button>
              </div>
            </div>
          )}

          {/* Phase: restart-instances */}
          {phase === 'restart-instances' && (
            <div className="flex flex-col gap-[var(--sp-3)]">
              <p className="text-t3 font-medium text-body">
                Restart instances with update?
              </p>
              <div className="flex flex-col gap-[var(--sp-1)]">
                {lines.map(line => {
                  const isRestarting = instanceStatus[line.name] === 'restarting'
                  const isDone = instanceStatus[line.name] === 'done'
                  const isError = instanceStatus[line.name] === 'error'
                  const disabled = line.status !== 'online' || isRestarting || isDone
                  return (
                    <label
                      key={line.name}
                      className={`flex items-center cursor-pointer gap-[var(--sp-2)] py-[var(--sp-1h)] px-[var(--sp-2)] rounded-sm${disabled && !isDone ? ' opacity-50' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={instanceToggles[line.name] ?? false}
                        disabled={disabled}
                        onChange={(e) => dispatch({ type: 'toggleInstance', name: line.name, on: e.target.checked })}
                        className="accent-[var(--color-m-cht)]"
                      />
                      <span className="font-mono text-t2 flex-1 text-data">
                        {line.name}
                      </span>
                      <span className="font-mono text-t5 text-xs">
                        {isRestarting ? (
                          <Loader2 size={12} strokeWidth={1.75} className="text-m-cht animate-spin" />
                        ) : isDone ? (
                          <Check size={12} strokeWidth={1.75} className="text-s-ok" />
                        ) : isError ? (
                          <AlertCircle size={12} strokeWidth={1.75} className="text-s-crit" />
                        ) : (
                          line.status
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
              <div className="flex justify-end gap-[var(--sp-2)] pt-[var(--sp-2)]">
                <button type="button" onClick={handleClose} aria-label="Close" className="c-btn c-btn-ghost">Skip</button>
                <button
                  type="button"
                  onClick={restartSelectedInstances}
                  className="c-btn c-btn-primary"
                  disabled={!Object.values(instanceToggles).some(Boolean)}
                >
                  <RotateCcw size={14} />
                  Restart Selected
                </button>
              </div>
            </div>
          )}

          {/* Phase: done */}
          {phase === 'done' && (
            <div className="flex items-center justify-center gap-[var(--sp-2)] py-[var(--sp-4)] px-0">
              <Check size={20} className="text-s-ok" />
              <span className="text-t2 font-medium text-body">
                All instances restarted
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default UpdateModal
