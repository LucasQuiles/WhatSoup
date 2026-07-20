import { type FC, useState, useEffect, useCallback, useRef } from 'react'
import { CheckCircle2, XCircle, Loader2, Clock, BookOpen, Server } from 'lucide-react'
import QrDisplay from '../QrDisplay'
import { parseAuthErrorMessage, parseQrPayload } from './link-step-events'
import { getApiTicket, isProductionConsole } from '../../lib/api'
import { isTransportKind, type TransportKind } from '../../lib/transport-meta'
import { Button } from '../primitives/Button'
import { Checkbox } from '../primitives/Checkbox'

interface LinkStepProps {
  lineName: string
  onComplete: () => void
  alreadyLinked?: boolean
  /** Line transport from the wizard Identity step (S3 design). */
  transport?: TransportKind | string | null
}

type LinkStatus = 'waiting' | 'connected' | 'error'

const LinkStep: FC<LinkStepProps> = ({ lineName, onComplete, alreadyLinked = false, transport }) => {
  const kind: TransportKind = isTransportKind(transport) ? transport : 'baileys'
  const [status, setStatus] = useState<LinkStatus>(alreadyLinked ? 'connected' : 'waiting')
  const [qrValue, setQrValue] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [retryKey, setRetryKey] = useState(0)
  const [qrAge, setQrAge] = useState(0)
  const [selfAttested, setSelfAttested] = useState(false)
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const retryCountRef = useRef(0)

  // Twilio has no link step — API credentials carry the auth. Auto-advance
  // when the operator reaches this step (S3 design).
  useEffect(() => {
    if (kind === 'twilio' && !alreadyLinked) {
      onComplete()
    }
  }, [kind, alreadyLinked, onComplete])

  useEffect(() => {
    let es: EventSource | null = null
    let cancelled = false

    function clearQrTimer(): void {
      if (!qrTimerRef.current) return
      clearInterval(qrTimerRef.current)
      qrTimerRef.current = null
    }

    if (alreadyLinked) {
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
  }, [alreadyLinked, lineName, retryKey])

  const handleRetry = useCallback(() => {
    setStatus('waiting')
    setQrValue('')
    setErrorMsg('')
    retryCountRef.current = 0
    setRetryKey((k) => k + 1)
  }, [])

  if (status === 'connected') {
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
            Line is live!
          </span>
          <span className="c-body text-text-2">
            <strong>{lineName}</strong> is now connected and running.
          </span>
        </div>
        <Button variant="primary" onClick={onComplete}>
          View Line
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

  // waiting state — branch per transport (S3 design)
  if (kind === 'signal' || kind === 'imessage') {
    return (
      <div className="flex flex-col items-start text-left gap-[var(--sp-4)] py-[var(--sp-4)] px-0 max-w-xl">
        <div className="flex items-center gap-[var(--sp-3)]">
          <Server size={32} strokeWidth={1.5} className="text-text-2" />
          <span className="c-heading text-lg">
            {kind === 'signal' ? 'Link signal-cli out-of-band' : 'Link iMessage backend out-of-band'}
          </span>
        </div>

        {kind === 'signal' ? (
          <div className="flex flex-col gap-[var(--sp-2)] text-text-2 c-body">
            <p>This line uses Signal via signal-cli. Link signal-cli on this host first:</p>
            <code className="block rounded-md bg-surface-raised border border-border-subtle px-3 py-2 font-mono text-sm text-text-1">
              signal-cli -a +14155551234 link
            </code>
            <p>Scan the QR with your Signal app, then return here.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-[var(--sp-2)] text-text-2 c-body">
            <p>This line uses iMessage via a macOS host.</p>
            <ol className="list-decimal pl-5 flex flex-col gap-[var(--sp-1)]">
              <li>Install BlueBubbles Server (or imsg) on the Mac signed into iMessage.</li>
              <li>Enable the REST API and copy the server URL + password.</li>
              <li>Enter them in the Config step (next).</li>
            </ol>
          </div>
        )}

        <a
          href={kind === 'signal' ? 'docs/runbooks/signal-transport.md' : 'docs/runbooks/imessage-transport.md'}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-[var(--sp-2)] text-brand-accent c-body"
        >
          <BookOpen size={16} />
          Open the full {kind === 'signal' ? 'Signal' : 'iMessage'} runbook
        </a>

        <Checkbox
          checked={selfAttested}
          onChange={setSelfAttested}
          label={kind === 'signal' ? 'signal-cli is linked and registered' : 'Backend is reachable'}
          className="c-body text-text-1"
        />

        <Button variant="primary" onClick={onComplete} disabled={!selfAttested}>
          Continue
        </Button>
      </div>
    )
  }

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
        <span className="c-heading">
          {kind === 'twilio' ? 'Twilio credentials carry the auth' : 'Scan with WhatsApp'}
        </span>
        <span className="c-body text-text-2">
          {kind === 'twilio'
            ? 'This step is skipped — configure Twilio credentials in the next step.'
            : 'Open WhatsApp → Settings → Linked Devices → Link a Device'}
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
