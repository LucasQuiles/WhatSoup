import { type FC, useState, useEffect, useCallback, useRef } from 'react'
import { CheckCircle2, XCircle, Loader2, Clock } from 'lucide-react'
import QrDisplay from '../QrDisplay'
import { parseAuthErrorMessage, parseQrPayload } from './link-step-events'
import { getApiTicket, getFleetToken } from '../../lib/api'

interface LinkStepProps {
  lineName: string
  onComplete: () => void
}

type LinkStatus = 'waiting' | 'connected' | 'error'

const LinkStep: FC<LinkStepProps> = ({ lineName, onComplete }) => {
  const [status, setStatus] = useState<LinkStatus>('waiting')
  const [qrValue, setQrValue] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [retryKey, setRetryKey] = useState(0)
  const [qrAge, setQrAge] = useState(0)
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const retryCountRef = useRef(0)

  useEffect(() => {
    let es: EventSource | null = null
    let cancelled = false

    function wireEventSource(source: EventSource): void {
      source.addEventListener('qr', (e: MessageEvent) => {
        const nextQr = parseQrPayload(e.data)
        if (!nextQr) {
          setStatus('error')
          setErrorMsg('Received an invalid QR code from the authentication server.')
          if (qrTimerRef.current) clearInterval(qrTimerRef.current)
          source.close()
          return
        }
        setQrValue(nextQr)
        setStatus('waiting')
        setErrorMsg('')
        setQrAge(0)
        if (qrTimerRef.current) clearInterval(qrTimerRef.current)
        qrTimerRef.current = setInterval(() => setQrAge((a) => a + 1), 1000)
      })

      source.addEventListener('connected', () => {
        setStatus('connected')
        if (qrTimerRef.current) clearInterval(qrTimerRef.current)
        source.close()
      })

      // Server-sent named 'error' events (event: error\ndata: ...)
      source.addEventListener('error', (e: MessageEvent) => {
        setStatus('error')
        setErrorMsg(parseAuthErrorMessage(e.data))
        if (qrTimerRef.current) clearInterval(qrTimerRef.current)
        source.close()
      })

      // Native connection errors — fires on 401, network failure, etc.
      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) {
          setStatus('error')
          setErrorMsg('Connection to server lost. Check that the fleet server is running.')
          if (qrTimerRef.current) clearInterval(qrTimerRef.current)
        }
        retryCountRef.current++
        if (retryCountRef.current >= 5) {
          setStatus('error')
          setErrorMsg('Unable to connect to the authentication server after multiple attempts.')
          if (qrTimerRef.current) clearInterval(qrTimerRef.current)
          source.close()
        }
      }
    }

    // Audience-scoped ticket (#313): mint an sse-audience ticket via
    // POST /api/auth-ticket so the root fleet token never appears in the
    // EventSource URL. In dev (no meta-tag) we open without a ticket and
    // let the Vite proxy handle auth.
    void (async () => {
      let url = `/api/lines/${encodeURIComponent(lineName)}/auth`
      if (getFleetToken()) {
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
      es = new EventSource(url)
      wireEventSource(es)
    })()

    return () => {
      cancelled = true
      if (es) es.close()
      if (qrTimerRef.current) clearInterval(qrTimerRef.current)
    }
  }, [lineName, retryKey])

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
          <span className="c-body text-t3">
            <strong>{lineName}</strong> is now connected and running.
          </span>
        </div>
        <button type="button" className="c-btn c-btn-primary" onClick={onComplete}>
          View Line
        </button>
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
          <span className="c-body text-t3">
            {errorMsg || 'An unexpected error occurred. Check that the fleet server is running.'}
          </span>
        </div>
        <button type="button" className="c-btn c-btn-primary" onClick={handleRetry}>
          Try Again
        </button>
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
            className="animate-spin text-t4"
          />
        </div>
      )}

      <div className="flex flex-col gap-[var(--sp-1)]">
        <span className="c-heading">Scan with WhatsApp</span>
        <span className="c-body text-t3">
          Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
        </span>
      </div>

      <div
        className={`flex items-center gap-[var(--sp-2)] ${qrExpiring ? 'text-s-warn' : 'text-t4'}`}
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
