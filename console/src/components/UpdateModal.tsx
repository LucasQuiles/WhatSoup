import { type FC, useReducer, useEffect, useCallback, useRef } from 'react'
import { X, Download, Check, Loader2, AlertCircle, RotateCcw } from 'lucide-react'
import { api } from '../lib/api'
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
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    phase: 'confirm' as Phase,
    steps: makeInitialSteps(),
    error: null,
    instanceToggles: buildToggles(lines),
    instanceStatus: {},
  }))
  const { phase, steps, error, instanceToggles, instanceStatus } = state
  const eventSourceRef = useRef<EventSource | null>(null)

  // Only reset when the modal opens — NOT when lines changes (that would
  // reset mid-update when the fleet restarts and health poller refetches).
  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      dispatch({ type: 'reset', toggles: buildToggles(lines) })
    }
    prevOpenRef.current = open
  }, [open, lines])

  const waitForFleetRestart = useCallback(() => {
    dispatch({ type: 'setPhase', phase: 'restarting-fleet' })
    // Wait a beat for the old process to fully die before polling
    let seenDown = false
    const poll = setInterval(async () => {
      try {
        const ver = await api.getVersion()
        if (seenDown || ver.sha !== currentSha) {
          // Fleet is back (either we saw it go down, or the SHA changed)
          clearInterval(poll)
          dispatch({ type: 'setPhase', phase: 'restart-instances' })
        }
      } catch {
        // Fleet not responding — it's restarting
        seenDown = true
      }
    }, 2000)

    setTimeout(() => {
      clearInterval(poll)
      dispatch({ type: 'setPhase', phase: 'restart-instances' })
    }, 60_000)
  }, [currentSha])

  const startUpdate = useCallback(() => {
    dispatch({ type: 'setPhase', phase: 'updating' })

    const token = document.querySelector<HTMLMetaElement>('meta[name="fleet-token"]')?.content
    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    fetch('/api/update', {
      method: 'POST',
      headers,
    }).then(response => {
      if (!response.ok) {
        dispatch({ type: 'setError', message: `Update failed: ${response.status}` })
        return
      }

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const read = (): Promise<void> => reader.read().then(({ done, value }) => {
        if (done) {
          // Connection closed — fleet is restarting
          waitForFleetRestart()
          return
        }

        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop()! // keep incomplete chunk

        for (const block of chunks) {
          const eventMatch = block.match(/^event: (\w+)/)
          const dataMatch = block.match(/^data: (.+)$/m)
          if (!eventMatch || !dataMatch) continue

          const event = eventMatch[1]
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = JSON.parse(dataMatch[1]) as any

          if (event === 'progress') {
            dispatch({ type: 'stepProgress', step: data.step, status: data.status as StepStatus, message: data.message })
            if (data.step === 'restart' && data.status === 'running') {
              dispatch({ type: 'setPhase', phase: 'restarting-fleet' })
            }
          } else if (event === 'error') {
            dispatch({ type: 'setError', message: data.message, step: data.step })
          }
        }

        return read()
      }).catch(() => {
        // Connection dropped — expected during restart
        waitForFleetRestart()
      })

      return read()
    }).catch(() => {
      waitForFleetRestart()
    })
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
        window.location.reload()
      }, 2200)
    }
  }, [instanceToggles, onClose])

  const handleClose = () => {
    eventSourceRef.current?.close()
    onClose()
    if (phase === 'restart-instances' || phase === 'done') {
      window.location.reload()
    }
  }

  if (!open) return null

  const stepIcon = (status: StepStatus) => {
    switch (status) {
      case 'pending': return <span className="text-t5" style={{ width: 16, textAlign: 'center', display: 'inline-block' }}>○</span>
      case 'running': return <Loader2 size={16} className="text-m-cht animate-spin" />
      case 'done': return <Check size={16} className="text-s-ok" />
      case 'skip': return <span className="text-t5" style={{ width: 16, textAlign: 'center', display: 'inline-block' }}>–</span>
      case 'error': return <AlertCircle size={16} className="text-s-crit" />
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--overlay)' }}
      onClick={handleClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'var(--panel-confirm)',
          maxWidth: '90%',
          background: 'var(--color-d2)',
          borderWidth: 'var(--bw)',
          borderStyle: 'solid',
          borderColor: 'var(--b2)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between"
          style={{ padding: 'var(--sp-4) var(--sp-5)', borderBottom: 'var(--bw) solid var(--b1)' }}
        >
          <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
            <Download size={16} className="text-m-cht" />
            <span className="font-sans font-semibold" style={{ fontSize: 'var(--font-size-lg)' }}>
              {phase === 'restart-instances' || phase === 'done' ? 'Update Complete' : 'Update WhatSoup'}
            </span>
          </div>
          <button onClick={handleClose} className="c-btn c-btn-ghost">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
          {/* Phase: confirm */}
          {phase === 'confirm' && (
            <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
              <p className="text-t3" style={{ fontSize: 'var(--font-size-body)' }}>
                Pull latest code, rebuild, and restart the fleet server?
              </p>
              <div className="flex justify-end" style={{ gap: 'var(--sp-2)' }}>
                <button onClick={handleClose} className="c-btn c-btn-ghost">Cancel</button>
                <button onClick={startUpdate} className="c-btn c-btn-primary">
                  <Download size={14} />
                  Update
                </button>
              </div>
            </div>
          )}

          {/* Phase: updating / restarting-fleet */}
          {(phase === 'updating' || phase === 'restarting-fleet') && (
            <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
              {steps.map(s => (
                <div key={s.step} className="flex items-center" style={{ gap: 'var(--sp-2)', padding: 'var(--sp-1) 0' }}>
                  {stepIcon(s.status)}
                  <span className={`font-mono ${s.status === 'skip' ? 'text-t5' : 'text-t2'}`}
                    style={{ fontSize: 'var(--font-size-data)' }}>
                    {STEP_LABELS[s.step] ?? s.step}
                  </span>
                  {s.message && s.status !== 'error' && (
                    <span className="text-t5 font-mono" style={{ fontSize: 'var(--font-size-xs)' }}>
                      {s.message}
                    </span>
                  )}
                </div>
              ))}
              {phase === 'restarting-fleet' && (
                <div className="flex items-center" style={{ gap: 'var(--sp-2)', padding: 'var(--sp-2) 0' }}>
                  <Loader2 size={16} className="text-m-cht animate-spin" />
                  <span className="text-t3 font-mono" style={{ fontSize: 'var(--font-size-data)' }}>
                    Waiting for fleet server...
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Phase: error */}
          {phase === 'error' && error && (
            <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
              <div className="flex items-start" style={{
                gap: 'var(--sp-2)',
                padding: 'var(--sp-3)',
                background: 'var(--s-crit-soft)',
                borderRadius: 'var(--radius-md)',
              }}>
                <AlertCircle size={16} className="text-s-crit flex-shrink-0" style={{ marginTop: 2 }} />
                <span className="text-t2 font-mono" style={{ fontSize: 'var(--font-size-data)' }}>{error}</span>
              </div>
              <div className="flex justify-end">
                <button onClick={handleClose} className="c-btn c-btn-ghost">Close</button>
              </div>
            </div>
          )}

          {/* Phase: restart-instances */}
          {phase === 'restart-instances' && (
            <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
              <p className="text-t3 font-medium" style={{ fontSize: 'var(--font-size-body)' }}>
                Restart instances with update?
              </p>
              <div className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
                {lines.map(line => {
                  const isRestarting = instanceStatus[line.name] === 'restarting'
                  const isDone = instanceStatus[line.name] === 'done'
                  const isError = instanceStatus[line.name] === 'error'
                  const disabled = line.status !== 'online' || isRestarting || isDone
                  return (
                    <label
                      key={line.name}
                      className={`flex items-center cursor-pointer${disabled && !isDone ? ' opacity-50' : ''}`}
                      style={{
                        gap: 'var(--sp-2)',
                        padding: 'var(--sp-1h) var(--sp-2)',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={instanceToggles[line.name] ?? false}
                        disabled={disabled}
                        onChange={(e) => dispatch({ type: 'toggleInstance', name: line.name, on: e.target.checked })}
                        className="accent-[var(--color-m-cht)]"
                      />
                      <span className="font-mono text-t2" style={{ fontSize: 'var(--font-size-data)', flex: 1 }}>
                        {line.name}
                      </span>
                      <span className="font-mono text-t5" style={{ fontSize: 'var(--font-size-xs)' }}>
                        {isRestarting ? (
                          <Loader2 size={12} className="text-m-cht animate-spin" />
                        ) : isDone ? (
                          <Check size={12} className="text-s-ok" />
                        ) : isError ? (
                          <AlertCircle size={12} className="text-s-crit" />
                        ) : (
                          line.status
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
              <div className="flex justify-end" style={{ gap: 'var(--sp-2)', paddingTop: 'var(--sp-2)' }}>
                <button onClick={handleClose} className="c-btn c-btn-ghost">Skip</button>
                <button
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
            <div className="flex items-center justify-center" style={{ gap: 'var(--sp-2)', padding: 'var(--sp-4) 0' }}>
              <Check size={20} className="text-s-ok" />
              <span className="text-t2 font-medium" style={{ fontSize: 'var(--font-size-body)' }}>
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
