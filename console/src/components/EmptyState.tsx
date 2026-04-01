import { type FC, type ReactNode } from 'react'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description?: string
}

const EmptyState: FC<EmptyStateProps> = ({ icon, title, description }) => {
  return (
    <div
      className="flex flex-col items-center justify-center text-center"
      style={{ padding: '32px 24px' }}
    >
      <div className="text-t5 mb-4" style={{ width: '40px', height: '40px' }}>
        {icon}
      </div>
      <div
        className="font-sans font-semibold text-t3"
        style={{ fontSize: '1rem', marginBottom: '6px' }}
      >
        {title}
      </div>
      {description && (
        <div
          className="text-t4"
          style={{ fontSize: '0.85rem', maxWidth: '320px', lineHeight: 1.6 }}
        >
          {description}
        </div>
      )}
    </div>
  )
}

export default EmptyState
