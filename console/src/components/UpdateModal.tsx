/**
 * UpdateModal — migrated to Modal primitive (B3 wave-3).
 *
 * Migration:
 *   - Removes ad-hoc backdrop div, stopPropagation, bubble-phase Escape effect,
 *     and `if (!open) return null` gate.
 *   - dismissable=false: constant across all six phases per C-B3W3-8.
 *     Before update: destructive-confirm rule (modal.md). During update: prevents
 *     silent stream abort mid-fleet-restart. After update: explicit verbs own
 *     dismissal. Escape and header X remain available at every phase via the
 *     useDismissable stack contract.
 *   - Download header icon dropped per modal.md anatomy. Download icon KEPT on
 *     the footer confirm-phase Update button (footer-icon precedent).
 *   - Width: --panel-confirm 420px → size="sm" 480px (RelinkModal precedent;
 *     tokens-v3 §6.12). --panel-confirm token deleted (last consumer gone).
 *   - Actions moved to conditional ModalFooter (confirm/error/restart-instances
 *     phases). Phases without actions (updating/restarting-fleet/done) omit the
 *     footer region.
 *   - Raw c-btn buttons → Button primitives (header X plus footer actions:
 *     Cancel, Update, Close, Try again, Skip, Restart Selected).
 *   - GAINS: stacking-aware Escape, focus trap, focus restoration.
 *   - handleClose is the single onClose target — wired through Modal's onClose
 *     prop so Escape, header X, and any future path share the same cleanup.
 *   - initialFocus: NONE — Modal default first-focusable (header close X).
 *     modal.md forbids defaulting to the destructive Update button (C-B3W3-8).
 *   - Public prop interface, reducer, SSE pipeline, refs, reset effect,
 *     fleet-restart poller, and instance restart pipeline are UNCHANGED.
 */
import { type FC, useReducer, useEffect, useCallback, useRef } from 'react'
import { Download, Check, Loader2, AlertCircle, RotateCcw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { api, apiSse, getApiTicket, isProductionConsole, SseRequestError } from '../lib/api'
import { CheckboxField, Modal, ModalHeader, ModalBody, ModalFooter } from './primitives'
import { Button } from './primitives/Button'
import type { LineInstance } from '../types'

interface UpdateModalProps {
  open: boolean
  onClose: () => void
  currentSha: string
  lines: LineInstance[]
  /** Fleet-restart poll interval (ms). Production default: 2000. */
  pollIntervalMs?: number
  /** Fleet-down fallback timeout (ms) before forcing restart-instances. Production default: 60_000. */
  fleetDownTimeoutMs?: number
  /** Auto-close delay (ms) after a successful restart. Production default: 2200. */
  autoCloseMs?: number
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
  preserve: 'Preserving failed update state',
  restart: 'Restarting fleet server',
}

const STEP_ORDER = ['pull', 'install', 'console-install', 'console-build', 'restart']
const DYNAMIC_STEP_INSERT_BEFORE: Record<string, string> = {
  preserve: 'restart',
}

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
  | { type: 'beginUpdate' }
  | { type: 'setPhase'; phase: Phase }
  | { type: 'stepProgress'; step: string; status: StepStatus; message?: string }
  | { type: 'setError'; message: string; step?: string }
  | { type: 'toggleInstance'; name: string; on: boolean }
  | { type: 'instanceStatus'; name: string; status: InstanceStatusValue }

function makeInitialSteps(): StepState[] {
  return STEP_ORDER.map(s => ({ step: s, status: 'pending' as StepStatus }))
}

function updateStepProgress(steps: StepState[], next: StepState): StepState[] {
  const existingIndex = steps.findIndex(s => s.step === next.step)
  if (existingIndex !== -1) {
    return steps.map(s => s.step === next.step ? { ...s, status: next.status, message: next.message } : s)
  }

  const beforeStep = DYNAMIC_STEP_INSERT_BEFORE[next.step]
  const beforeIndex = beforeStep ? steps.findIndex(s => s.step === beforeStep) : -1
  if (beforeIndex === -1) return [...steps, next]
  return [...steps.slice(0, beforeIndex), next, ...steps.slice(beforeIndex)]
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
    case 'beginUpdate':
      return {
        ...state,
        phase: 'updating',
        steps: makeInitialSteps(),
        error: null,
      }
    case 'setPhase':
      return { ...state, phase: action.phase }
    case 'stepProgress':
      return {
        ...state,
        steps: updateStepProgress(state.steps, {
          step: action.step,
          status: action.status,
          message: action.message,
        }),
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

const UpdateModal: FC<UpdateModalProps> = ({
  open,
  onClose,
  currentSha,
  lines,
  pollIntervalMs = 2000,
  fleetDownTimeoutMs = 60_000,
  autoCloseMs = 2200,
}) => {
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

  const clearPendingUpdate = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
  }, [])

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
    }, pollIntervalMs)
    pollRef.current = poll

    timeoutRef.current = setTimeout(() => {
      clearInterval(poll)
      pollRef.current = null
      timeoutRef.current = null
      queryClient.invalidateQueries()
      dispatch({ type: 'setPhase', phase: 'restart-instances' })
    }, fleetDownTimeoutMs)
  }, [currentSha, queryClient, pollIntervalMs, fleetDownTimeoutMs])

  const startUpdate = useCallback(() => {
    clearPendingUpdate()
    dispatch({ type: 'beginUpdate' })
    // Reset error flag for this update run (F-058).
    hasErroredRef.current = false

    // Abort controller so handleClose can cancel the in-flight fetch (RES-006)
    const controller = new AbortController()
    abortRef.current = controller

    // Audience-scoped ticket (#313): mint an api-audience ticket via the
    // console session (B1). In dev (no fleet-auth-mode meta) skip the
    // header and let the proxy handle auth.
    void (async () => {
      let headers: Record<string, string> = {}
      if (isProductionConsole()) {
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
        for await (const { event, data: rawData } of apiSse('/api/update', {
          method: 'POST',
          headers,
          signal: controller.signal,
        })) {
          // SSE payload shape is server-defined; type the fields this
          // client actually reads (retires waiver WVR-010).
          const data = JSON.parse(rawData) as {
            step?: string
            status?: string
            message?: string
          }

          if (event === 'progress') {
            // The server always sends step/status on progress events; skip
            // any malformed block rather than dispatching undefined fields.
            if (!data.step || !data.status) continue
            dispatch({ type: 'stepProgress', step: data.step, status: data.status as StepStatus, message: data.message })
            if (data.step === 'restart' && data.status === 'running') {
              dispatch({ type: 'setPhase', phase: 'restarting-fleet' })
            }
          } else if (event === 'error') {
            // Set ref before dispatch so the done-branch check (F-058) sees
            // the flag synchronously in the same microtask.
            hasErroredRef.current = true
            dispatch({ type: 'setError', message: data.message ?? 'update stream error', step: data.step })
          }
        }
        // F-058: only enter fleet-restart polling if the stream did not
        // already signal a terminal error; preserve the error phase.
        if (!hasErroredRef.current) waitForFleetRestart()
      } catch (err) {
        if (err instanceof SseRequestError) {
          hasErroredRef.current = true
          dispatch({ type: 'setError', message: `Update failed: ${err.status}` })
          return
        }
        // Aborted or network/stream error — fleet may be restarting; skip if already errored (F-058).
        if (controller.signal.aborted) return
        if (!hasErroredRef.current) waitForFleetRestart()
      }
    })()
  }, [clearPendingUpdate, waitForFleetRestart])

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
      }, autoCloseMs)
    }
  }, [instanceToggles, onClose, autoCloseMs])

  // handleClose aborts the in-flight fetch stream and clears any pending
  // poll/timeout, then delegates to onClose. Wired as the single Modal onClose
  // target so Escape, header X, and any footer Cancel/Close/Skip path all share
  // the same cleanup (C-B3W3-8).
  const handleClose = () => {
    clearPendingUpdate()
    onClose()
  }

  const stepIcon = (status: StepStatus) => {
    switch (status) {
      case 'pending': return <span className="text-text-3 inline-block text-center w-[var(--feed-col-icon)]">○</span>
      case 'running': return <Loader2 size={16} className="text-m-cht animate-spin" />
      case 'done': return <Check size={16} className="text-s-ok" />
      case 'skip': return <span className="text-text-3 inline-block text-center w-[var(--feed-col-icon)]">–</span>
      case 'error': return <AlertCircle size={16} className="text-s-crit" />
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="sm"
      dismissable={false}
    >
      <ModalHeader
        title={phase === 'restart-instances' || phase === 'done' ? 'Update Complete' : 'Update SOUP'}
        onClose={handleClose}
      />

      <ModalBody>
        {/* Phase: confirm */}
        {phase === 'confirm' && (
          <p className="text-text-2 text-body">
            In-place update has been retired — this instance runs an immutable
            release. Deploy a new release to update it. Requesting an update
            below will report the same.
          </p>
        )}

        {/* Phase: updating / restarting-fleet */}
        {(phase === 'updating' || phase === 'restarting-fleet') && (
          <div className="flex flex-col gap-[var(--sp-2)]">
            {steps.map(s => (
              <div key={s.step} className="flex items-center gap-[var(--sp-2)] py-[var(--sp-1)] px-0">
                {stepIcon(s.status)}
                <span className={`font-mono text-data ${s.status === 'skip' ? 'text-text-3' : 'text-text-2'}`}>
                  {STEP_LABELS[s.step] ?? s.step}
                </span>
                {s.message && s.status !== 'error' && (
                  <span className="text-text-3 font-mono text-label">
                    {s.message}
                  </span>
                )}
              </div>
            ))}
            {phase === 'restarting-fleet' && (
              <div className="flex items-center gap-[var(--sp-2)] py-[var(--sp-2)] px-0">
                <Loader2 size={16} className="text-m-cht animate-spin" />
                <span className="text-text-2 font-mono text-data">
                  Waiting for fleet server...
                </span>
              </div>
            )}
          </div>
        )}

        {/* Phase: error */}
        {phase === 'error' && error && (
          <div className="flex items-start gap-[var(--sp-2)] p-[var(--sp-3)] bg-[var(--s-crit-soft)] rounded-md">
            <AlertCircle size={16} className="text-s-crit flex-shrink-0 mt-[var(--bw-accent)]" />
            <span className="text-text-2 font-mono text-data">{error}</span>
          </div>
        )}

        {/* Phase: restart-instances */}
        {phase === 'restart-instances' && (
          <div className="flex flex-col gap-[var(--sp-2)]">
            <p className="text-text-2 font-medium text-body">
              Restart instances with update?
            </p>
            <div className="flex flex-col gap-[var(--sp-1)]">
              {lines.map(line => {
                const isRestarting = instanceStatus[line.name] === 'restarting'
                const isDone = instanceStatus[line.name] === 'done'
                const isError = instanceStatus[line.name] === 'error'
                const disabled = line.status !== 'online' || isRestarting || isDone
                return (
                  <CheckboxField
                    key={line.name}
                    label={line.name}
                    checked={instanceToggles[line.name] ?? false}
                    disabled={disabled}
                    onChange={(on) => dispatch({ type: 'toggleInstance', name: line.name, on })}
                    className={`cursor-pointer py-[var(--sp-1h)] px-[var(--sp-2)] rounded-sm${disabled && !isDone ? ' opacity-50' : ''}`}
                    inputClassName="accent-[var(--color-m-cht)]"
                    labelClassName="font-mono text-text-2 flex-1"
                    suffix={
                      <span className="font-mono text-text-3 text-xs">
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
                    }
                  />
                )
              })}
            </div>
          </div>
        )}

        {/* Phase: done */}
        {phase === 'done' && (
          <div className="flex items-center justify-center gap-[var(--sp-2)] py-[var(--sp-4)] px-0">
            <Check size={20} className="text-s-ok" />
            <span className="text-text-2 font-medium text-body">
              All instances restarted
            </span>
          </div>
        )}
      </ModalBody>

      {/* Footer — only in action-bearing phases; updating/restarting-fleet/done omit it */}
      {phase === 'confirm' && (
        <ModalFooter>
          <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          <Button variant="primary" onClick={startUpdate} icon={<Download size={14} />}>Update</Button>
        </ModalFooter>
      )}
      {phase === 'error' && (
        <ModalFooter>
          <Button variant="ghost" onClick={handleClose}>Close</Button>
          <Button variant="primary" onClick={startUpdate} icon={<RotateCcw size={14} />}>Try again</Button>
        </ModalFooter>
      )}
      {phase === 'restart-instances' && (
        <ModalFooter>
          <Button variant="ghost" onClick={handleClose}>Skip</Button>
          <Button
            variant="primary"
            onClick={restartSelectedInstances}
            disabled={!Object.values(instanceToggles).some(Boolean)}
            icon={<RotateCcw size={14} />}
          >
            Restart Selected
          </Button>
        </ModalFooter>
      )}
    </Modal>
  )
}

export default UpdateModal
