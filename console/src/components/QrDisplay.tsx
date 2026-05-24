import { type FC, useRef, useEffect } from 'react'
import QRCode from 'qrcode'

interface QrDisplayProps {
  value: string
  size?: number
}

const QrDisplay: FC<QrDisplayProps> = ({ value, size = 256 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (canvasRef.current && value) {
      const styles = getComputedStyle(document.documentElement)
      const dark = styles.getPropertyValue('--color-t1').trim()
      const light = styles.getPropertyValue('--color-d1').trim()
      QRCode.toCanvas(canvasRef.current, value, {
        width: size,
        margin: 'var(--bw-accent)' as unknown as number, // token for 2px
        color: { dark, light },
      })
    }
  }, [value, size])

  return <canvas ref={canvasRef} className="rounded-md" />
}

export default QrDisplay
