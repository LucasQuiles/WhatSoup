import { type FC, useState, useEffect, useCallback } from 'react'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
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

  useEffect(() => {
    // Use relative URL — Vite proxy (dev) or same-origin (prod) forwards to fleet server with auth
    const url = `/api/lines/${encodeURIComponent(lineName)}/auth`
    const es = new EventSource(url)

    es.addEventListener('qr', (e: MessageEvent) => {
      setQrValue(JSON.parse(e.data) as string)
      setStatus('waiting')
      setErrorMsg('')
    })

    es.addEventListener('connected', () => {
      setStatus('connected')
      es.close()
    })

    es.addEventListener('error', () => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus('error')
        setErrorMsg('Connection lost')
      }
    })

    return () => es.close()
  }, [lineName, retryKey])

  const handleRetry = useCallback(() => {
    setStatus('waiting')
    setQrValue('')
    setErrorMsg('')
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
            Authentication failed
          </span>
          <span className="c-body" style={{ color: 'var(--color-t3)' }}>
            {errorMsg || 'An unexpected error occurred.'}
          </span>
        </div>
        <button className="c-btn c-btn-primary" onClick={handleRetry}>
          Retry
        </button>
      </div>
    )
  }

  // waiting state
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
          style={{ width: 256, height: 256 }}
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
        style={{ gap: 'var(--sp-2)', color: 'var(--color-t4)' }}
      >
        <Loader2 size={14} className="animate-spin" />
        <span className="c-body" style={{ fontSize: 'var(--font-size-sm)' }}>
          Waiting for scan...
        </span>
      </div>
    </div>
  )
}

export default LinkStep
