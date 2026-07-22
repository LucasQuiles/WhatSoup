import { type FC, useState, useEffect, useCallback, useRef } from 'react'
import { CheckCircle2, XCircle, Loader2, Clock, BookOpen, Server } from 'lucide-react'
import QrDisplay from '../QrDisplay'
import { parseAuthErrorMessage, parseQrPayload } from './link-step-events'
import { getApiTicket, isProductionConsole } from '../../lib/api'
import { Button } from '../primitives/Button'
import { Checkbox } from '../primitives/Checkbox'
import { isTransportKind, type TransportKind } from '../../lib/transport-meta'

interface LinkStepProps {
  lineName: string
  onComplete: () => void
  alreadyLinked?: boolean
  transport?: TransportKind | string | null
}

type LinkStatus = 'waiting' | 'connected' | 'error'

const LinkStep: FC<LinkStepProps> = ({ lineName, onComplete, alreadyLinked = false, transport }) => {
  const kind: TransportKind | null = transport == null
    ? 'baileys'
    : isTransportKind(transport) ? transport : null
  const [status, setStatus] = useState<LinkStatus>(alreadyLinked ? 'connected' : 'waiting')
  const [qrValue, setQrValue] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [retryKey, setRetryKey] = useState(0)
  const [qrAge, setQrAge] = useState(0)
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const retryCountRef = useRef(0)
  const twilioAdvancedRef = useRef(false)
  const [selfAttested, setSelfAttested] = useState(false)

  useEffect(() => {
    if (kind !== 'twilio' || alreadyLinked || twilioAdvancedRef.current) return
    twilioAdvancedRef.current = true
    onComplete()
  }, [alreadyLinked, kind, onComplete])

  useEffect(() => {
    let es: EventSource | null = null
    let cancelled = false

    function clearQrTimer(): void {
      if (!qrTimerRef.current) return
      clearInterval(qrTimerRef.current)
      qrTimerRef.current = null
    }

    if (alreadyLinked || kind !== 'baileys') {
      return () => {
        cancelled = true
        clearQrTimer()
      }
    }

    async function openEventSource(): Promise<void> {
      let url = `/api/lines/${encodeURIComponent(lineName)}/auth`
      if (isProductionConsole()) {
        try {
          const ticket = await getApiTicket('sse')
          url += `?ticket=${encodeURIComponent(ticket)}`
        } catch {
          if (cancelled) return
          setStatus('error')
          setErrorMsg('Unable to authenticate with the fleet server.')
          return
        }
      }
      if (cancelled) return
      const source = new EventSource(url)
      es = source
      wireEventSource(source)
    }

    function wireEventSource(source: EventSource): void {
      source.addEventListener('qr', (e: MessageEvent) => {
        const nextQr = parseQrPayload(e.data)
        if (!nextQr) {
          setStatus('error')
          setErrorMsg('Received an invalid QR code from the authentication server.')
          clearQrTimer()
          source.close()
          return
        }
        setQrValue(nextQr)
        setStatus('waiting')
        setErrorMsg('')
        setQrAge(0)
        clearQrTimer()
        qrTimerRef.current = setInterval(() => setQrAge((a) => a + 1), 1000)
      })

      source.addEventListener('connected', () => {
        setStatus('connected')
        clearQrTimer()
        source.close()
      })

      // Server-sent named 'error' events (event: error\ndata: ...)
      source.addEventListener('error', (e: MessageEvent) => {
        setStatus('error')
        setErrorMsg(parseAuthErrorMessage(e.data))
        clearQrTimer()
        source.close()
      })

      // Native connection errors — fires on 401, network failure, etc.
      source.onerror = () => {
        if (cancelled || es !== source) return
        source.close()
        clearQrTimer()
        retryCountRef.current++
        if (retryCountRef.current >= 5) {
          setStatus('error')
          setErrorMsg('Unable to connect to the authentication server after multiple attempts.')
          return
        }
        // EventSource reconnects reuse the original URL. Since SSE tickets are
        // single-use, own the retry loop here so each attempt gets a fresh one.
        void openEventSource()
      }
    }

    // Audience-scoped ticket (#313): mint an sse-audience ticket via
    // POST /api/auth-ticket so the root fleet token never appears in the
    // EventSource URL. In dev (no meta-tag) we open without a ticket and
    // let the Vite proxy handle auth.
    void openEventSource()

    return () => {
      cancelled = true
      if (es) es.close()
      clearQrTimer()
    }
  }, [alreadyLinked, kind, lineName, retryKey])

  const handleRetry = useCallback(() => {
    setStatus('waiting')
    setQrValue('')
    setErrorMsg('')
    retryCountRef.current = 0
    setRetryKey((k) => k + 1)
  }, [])

  if (kind === null) {
    return (
      <div className="flex flex-col items-center text-center gap-[var(--sp-4)] py-[var(--sp-6)] px-0">
        <XCircle size={48} strokeWidth={1.5} className="text-s-crit" />
        <div className="flex flex-col gap-[var(--sp-1)]">
          <span className="c-heading text-lg">Unsupported transport</span>
          <span className="c-body text-text-2">
            This line cannot use QR authentication until its transport configuration is repaired.
          </span>
        </div>
      </div>
    )
  }

  if (status === 'connected') {
    const isBaileys = kind === 'baileys'
    return (
      <div
        className="flex flex-col items-center text-center gap-[var(--sp-4)] py-[var(--sp-6)] px-0"
      >
        <CheckCircle2
          size={48}
          strokeWidth={1.5}
          className="text-s-ok"
        />
        <div className="flex flex-col gap-[var(--sp-1)]">
          <span className="c-heading text-lg">
            {isBaileys ? 'Line is live!' : 'Setup acknowledged'}
          </span>
          <span className="c-body text-text-2">
            {isBaileys
              ? <><strong>{lineName}</strong> is now connected and running.</>
              : <>The external setup for <strong>{lineName}</strong> was acknowledged.</>}
          </span>
        </div>
        <Button variant="primary" onClick={onComplete}>
          {isBaileys ? 'View Line' : 'Continue'}
        </Button>
      </div>
    )
  }

  if (status === 'error') {
    const isTimeout = errorMsg.toLowerCase().includes('timed out')
    return (
      <div
        className="flex flex-col items-center text-center gap-[var(--sp-4)] py-[var(--sp-6)] px-0"
      >
        <XCircle
          size={48}
          strokeWidth={1.5}
          className="text-s-crit"
        />
        <div className="flex flex-col gap-[var(--sp-1)]">
          <span className="c-heading text-lg">
            {isTimeout ? 'Session timed out' : 'Authentication failed'}
          </span>
          <span className="c-body text-text-2">
            {errorMsg || 'An unexpected error occurred. Check that the fleet server is running.'}
          </span>
        </div>
        <Button variant="primary" onClick={handleRetry}>
          Try Again
        </Button>
      </div>
    )
  }

  if (kind === 'signal' || kind === 'imessage') {
    const isSignal = kind === 'signal'
    const runbookUrl = `https://github.com/LucasQuiles/WhatSoup/blob/main/docs/runbooks/${kind}-transport.md`
    return (
      <div className="flex flex-col items-start text-left gap-[var(--sp-4)] py-[var(--sp-4)] px-0 max-w-xl">
        <div className="flex items-center gap-[var(--sp-3)]">
          <Server size={32} strokeWidth={1.5} className="text-text-2" />
          <span className="c-heading text-lg">
            {isSignal ? 'Attest the signal-cli link' : 'Attest the iMessage backend'}
          </span>
        </div>
        <p className="c-body text-text-2">
          {isSignal
            ? 'Confirm that signal-cli is registered for the configured number and its JSON-RPC endpoint is running.'
            : 'Confirm that the configured imsg or BlueBubbles backend is reachable from this host.'}
        </p>
        <a
          href={runbookUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-[var(--sp-2)] text-brand-accent c-body"
        >
          <BookOpen size={16} />
          Open the full {isSignal ? 'Signal' : 'iMessage'} runbook
        </a>
        <Checkbox
          checked={selfAttested}
          onChange={setSelfAttested}
          label={isSignal ? 'signal-cli is linked and registered' : 'Backend is reachable'}
        />
        <Button variant="primary" onClick={onComplete} disabled={!selfAttested}>
          Continue
        </Button>
      </div>
    )
  }

  // waiting state
  const qrExpiring = qrAge > 45 // QR codes expire after ~60s, warn at 45
  return (
    <div
      className="flex flex-col items-center text-center gap-[var(--sp-4)] py-[var(--sp-4)] px-0"
    >
      {qrValue ? (
        <QrDisplay value={qrValue} size={256} />
      ) : (
        <div
          className="flex items-center justify-center w-[var(--qr-size)] h-[var(--qr-size)]"
        >
          <Loader2
            size={32}
            className="animate-spin text-text-2"
          />
        </div>
      )}

      <div className="flex flex-col gap-[var(--sp-1)]">
        <span className="c-heading">Scan with WhatsApp</span>
        <span className="c-body text-text-2">
          Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
        </span>
      </div>

      <div
        className={`flex items-center gap-[var(--sp-2)] ${qrExpiring ? 'text-s-warn' : 'text-text-2'}`}
      >
        {qrValue ? (
          qrExpiring ? (
            <>
              <Clock size={14} />
              <span className="c-body text-sm">
                QR code expiring soon — a new one will appear automatically
              </span>
            </>
          ) : (
            <>
              <Loader2 size={14} className="animate-spin" />
              <span className="c-body text-sm">
                Waiting for scan...
              </span>
            </>
          )
        ) : (
          <span className="c-body text-sm">
            Generating QR code...
          </span>
        )}
      </div>
    </div>
  )
}

export default LinkStep
