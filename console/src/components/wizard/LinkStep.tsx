import { type FC, useState, useEffect, useCallback, useRef } from 'react'
import { CheckCircle2, XCircle, Loader2, Clock } from 'lucide-react'
import QrDisplay from '../QrDisplay'

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
    let url = `/api/lines/${encodeURIComponent(lineName)}/auth`

    // In production the fleet server injects the token into a meta tag at serve time
    const tokenMeta = document.querySelector<HTMLMetaElement>('meta[name="fleet-token"]')
    if (tokenMeta?.content) {
      url += `?token=${encodeURIComponent(tokenMeta.content)}`
    }

    const es = new EventSource(url)

    es.addEventListener('qr', (e: MessageEvent) => {
      setQrValue(JSON.parse(e.data) as string)
      setStatus('waiting')
      setErrorMsg('')
      // Reset QR age countdown on each new QR code
      setQrAge(0)
      if (qrTimerRef.current) clearInterval(qrTimerRef.current)
      qrTimerRef.current = setInterval(() => setQrAge((a) => a + 1), 1000)
    })

    es.addEventListener('connected', () => {
      setStatus('connected')
      if (qrTimerRef.current) clearInterval(qrTimerRef.current)
      es.close()
    })

    // Server-sent named 'error' events (event: error\ndata: ...)
    es.addEventListener('error', (e: MessageEvent) => {
      let msg = 'Connection lost'
      try {
        if (e.data) {
          const parsed = JSON.parse(e.data)
          if (parsed.message) msg = parsed.message
        }
      } catch { /* use default */ }
      setStatus('error')
      setErrorMsg(msg)
      if (qrTimerRef.current) clearInterval(qrTimerRef.current)
      es.close()
    })

    // Native connection errors (non-MessageEvent) — fires on 401, network failure, etc.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus('error')
        setErrorMsg('Connection to server lost. Check that the fleet server is running.')
        if (qrTimerRef.current) clearInterval(qrTimerRef.current)
      }
      // EventSource.CONNECTING means it's retrying — don't show error yet,
      // but track retry count to eventually give up
      retryCountRef.current++
      if (retryCountRef.current >= 5) {
        setStatus('error')
        setErrorMsg('Unable to connect to the authentication server after multiple attempts.')
        if (qrTimerRef.current) clearInterval(qrTimerRef.current)
        es.close()
      }
    }

    return () => {
      es.close()
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
        className="flex flex-col items-center text-center"
        style={{ gap: 'var(--sp-4)', padding: 'var(--sp-6) 0' }}
      >
        <CheckCircle2
          size={48}
          strokeWidth={1.5}
          style={{ color: 'var(--color-s-ok)' }}
        />
        <div className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
          <span className="c-heading" style={{ fontSize: 'var(--font-size-lg)' }}>
            Line is live!
          </span>
          <span className="c-body" style={{ color: 'var(--color-t3)' }}>
            <strong>{lineName}</strong> is now connected and running.
          </span>
        </div>
        <button className="c-btn c-btn-primary" onClick={onComplete}>
          View Line
        </button>
      </div>
    )
  }

  if (status === 'error') {
    const isTimeout = errorMsg.toLowerCase().includes('timed out')
    return (
      <div
        className="flex flex-col items-center text-center"
        style={{ gap: 'var(--sp-4)', padding: 'var(--sp-6) 0' }}
      >
        <XCircle
          size={48}
          strokeWidth={1.5}
          style={{ color: 'var(--color-s-crit)' }}
        />
        <div className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
          <span className="c-heading" style={{ fontSize: 'var(--font-size-lg)' }}>
            {isTimeout ? 'Session timed out' : 'Authentication failed'}
          </span>
          <span className="c-body" style={{ color: 'var(--color-t3)' }}>
            {errorMsg || 'An unexpected error occurred. Check that the fleet server is running.'}
          </span>
        </div>
        <button className="c-btn c-btn-primary" onClick={handleRetry}>
          Try Again
        </button>
      </div>
    )
  }

  // waiting state
  const qrExpiring = qrAge > 45 // QR codes expire after ~60s, warn at 45
  return (
    <div
      className="flex flex-col items-center text-center"
      style={{ gap: 'var(--sp-4)', padding: 'var(--sp-4) 0' }}
    >
      {qrValue ? (
        <QrDisplay value={qrValue} size={256} />
      ) : (
        <div
          className="flex items-center justify-center"
          style={{ width: 'var(--qr-size)', height: 'var(--qr-size)' }}
        >
          <Loader2
            size={32}
            className="animate-spin"
            style={{ color: 'var(--color-t4)' }}
          />
        </div>
      )}

      <div className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
        <span className="c-heading">Scan with WhatsApp</span>
        <span className="c-body" style={{ color: 'var(--color-t3)' }}>
          Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
        </span>
      </div>

      <div
        className="flex items-center"
        style={{ gap: 'var(--sp-2)', color: qrExpiring ? 'var(--color-s-warn)' : 'var(--color-t4)' }}
      >
        {qrValue ? (
          qrExpiring ? (
            <>
              <Clock size={14} />
              <span className="c-body" style={{ fontSize: 'var(--font-size-sm)' }}>
                QR code expiring soon — a new one will appear automatically
              </span>
            </>
          ) : (
            <>
              <Loader2 size={14} className="animate-spin" />
              <span className="c-body" style={{ fontSize: 'var(--font-size-sm)' }}>
                Waiting for scan...
              </span>
            </>
          )
        ) : (
          <span className="c-body" style={{ fontSize: 'var(--font-size-sm)' }}>
            Generating QR code...
          </span>
        )}
      </div>
    </div>
  )
}

export default LinkStep
