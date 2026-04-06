import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ErrorBoundary from '../../console/src/components/ErrorBoundary.tsx'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')

describe('ErrorBoundary', () => {
  it('derives fallback state from render errors and resets state on retry', () => {
    expect(typeof ErrorBoundary).toBe('function')

    const derived = (ErrorBoundary as typeof ErrorBoundary & {
      getDerivedStateFromError: (error: Error) => { hasError: boolean; error: Error }
    }).getDerivedStateFromError(new Error('route exploded'))

    expect(derived.hasError).toBe(true)
    expect(derived.error!.message).toBe('route exploded')

    const boundary = new (ErrorBoundary as unknown as new (props: { children: null }) => {
      state: { hasError: boolean; error: Error | null }
      props: { children: null }
      setState: (next: { hasError: boolean; error: Error | null }) => void
      handleRetry: () => void
    })({ children: null })

    boundary.state = { hasError: true, error: new Error('route exploded') }
    boundary.setState = (next) => {
      boundary.state = next
    }

    boundary.handleRetry()

    expect(boundary.state).toEqual({ hasError: false, error: null })
  })

  it('wraps each top-level route in App.tsx and uses EmptyState error fallback UI', () => {
    const app = read('console/src/App.tsx')
    const boundary = read('console/src/components/ErrorBoundary.tsx')

    expect(app).toContain("import ErrorBoundary from './components/ErrorBoundary'")
    expect(app).toContain('element={<ErrorBoundary><SoupKitchen /></ErrorBoundary>}')
    expect(app).toContain('element={<ErrorBoundary><LineDetail /></ErrorBoundary>}')
    expect(app).toContain('element={<ErrorBoundary><Inbox /></ErrorBoundary>}')
    expect(app).toContain('element={<ErrorBoundary><Ops /></ErrorBoundary>}')

    expect(boundary).toMatch(/className="c-card[\s"]/)
    expect(boundary).toContain('variant="error"')
    expect(boundary).toContain('onRetry={this.handleRetry}')
  })
})
