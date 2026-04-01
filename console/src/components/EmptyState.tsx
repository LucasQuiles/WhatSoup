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
      style={{ padding: 'var(--sp-8) var(--sp-6)' }}
    >
      <div className="text-t5 mb-4" style={{ width: 'var(--icon-empty)', height: 'var(--icon-empty)' }}>
        {icon}
      </div>
      <div
        className="font-sans font-semibold text-t3"
        style={{ fontSize: 'var(--font-size-lg)', marginBottom: '6px' }}
      >
        {title}
      </div>
      {description && (
        <div
          className="text-t4 leading-relaxed"
          style={{ fontSize: 'var(--font-size-body)', maxWidth: 'var(--empty-max-w)' }}
        >
          {description}
        </div>
      )}
    </div>
  )
}

export default EmptyState
