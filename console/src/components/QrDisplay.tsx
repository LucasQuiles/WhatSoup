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
        margin: 2,
        color: { dark, light },
      })
    }
  }, [value, size])

  return <canvas ref={canvasRef} style={{ borderRadius: 'var(--radius-md)' }} />
}

export default QrDisplay
