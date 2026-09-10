import type { FC } from 'react'
import { SelectInput, type SelectInputProps } from './primitives'
import { useProviders } from '../hooks/use-fleet'

export interface ProviderSelectProps
  extends Omit<SelectInputProps, 'children' | 'onChange' | 'value'> {
  value: string
  onChange: (value: string) => void
  allowEmpty?: boolean
  emptyLabel?: string
  showStatus?: boolean
}

/**
 * Execution-provider selector backed by the fleet server's current registry.
 *
 * Unknown providers are never manufactured client-side. A configured value
 * that the server no longer reports is retained visibly so opening a form
 * during drift or an outage cannot silently replace operator intent.
 */
const ProviderSelect: FC<ProviderSelectProps> = ({
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = 'Select provider',
  showStatus = true,
  id,
  disabled,
  'aria-describedby': describedBy,
  ...selectProps
}) => {
  const query = useProviders()
  const providers = query.data ?? []
  const currentReported = providers.some((provider) => provider.id === value)
  const statusId = showStatus && id ? `${id}-catalogue-status` : undefined
  const inputDescription = [describedBy, statusId].filter(Boolean).join(' ') || undefined

  let status: string
  if (query.isPending) {
    status = 'Loading the server provider catalogue…'
  } else if (query.catalogueStatus === 'request-failed') {
    status = 'Provider catalogue request failed; preserving the configured selection.'
  } else {
    status = `${providers.length} execution provider${providers.length === 1 ? '' : 's'} reported by this server.`
  }

  return (
    <div>
      <SelectInput
        {...selectProps}
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || (!value && !allowEmpty && providers.length === 0)}
        aria-describedby={inputDescription}
      >
        {allowEmpty ? <option value="">{emptyLabel}</option> : null}
        {!allowEmpty && !value ? <option value="" disabled>{emptyLabel}</option> : null}
        {value && !currentReported ? (
          <option value={value}>{value} (configured; not reported)</option>
        ) : null}
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>{provider.displayName}</option>
        ))}
      </SelectInput>
      {showStatus ? (
        <div id={statusId} className="c-helper" data-testid="provider-catalogue-status" aria-live="polite">
          {status}
        </div>
      ) : null}
    </div>
  )
}

export default ProviderSelect
