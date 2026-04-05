import { Component, type ErrorInfo, type ReactNode } from 'react'
import EmptyState from './EmptyState'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('route render failed', error, errorInfo)
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex-1 flex items-center justify-center" style={{ padding: 'var(--sp-4)' }} role="alert">
        <div className="c-card" style={{ width: 'min(100%, 32rem)', padding: 'var(--sp-2)' }}>
          <EmptyState
            variant="error"
            title="This page crashed"
            description={this.state.error?.message || 'An unexpected render error occurred.'}
            onRetry={this.handleRetry}
            retryLabel="Retry"
          />
        </div>
      </div>
    )
  }
}
