import { type FC } from 'react'

/**
 * Animated typing indicator — three dots that bounce sequentially.
 * Shows who is typing in a chat conversation.
 */
const TypingIndicator: FC<{ name?: string }> = ({ name }) => {
  return (
    <div className="flex items-center self-start" style={{ gap: 'var(--sp-2)', padding: 'var(--sp-1) 0' }}>
      {name && (
        <span className="c-label" style={{ fontSize: 'var(--font-size-xs)' }}>{name}</span>
      )}
      <div className="flex items-center" style={{ gap: '3px' }}>
        <span className="typing-dot" style={{ animationDelay: '0ms' }} />
        <span className="typing-dot" style={{ animationDelay: '150ms' }} />
        <span className="typing-dot" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  )
}

export default TypingIndicator
