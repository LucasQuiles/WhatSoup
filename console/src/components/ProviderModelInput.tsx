import type { FC } from 'react'
import { TextInput, type TextInputProps } from './primitives'
import { useProviderModels } from '../hooks/use-fleet'

export interface ProviderModelInputProps
  extends Omit<TextInputProps, 'list' | 'onChange' | 'value'> {
  provider: string
  value: string
  onChange: (value: string) => void
  showStatus?: boolean
}

/**
 * Editable provider-native model selector.
 *
 * The datalist is populated only from the backend's live catalogue receipt;
 * the text input deliberately remains editable so private, newly released, or
 * temporarily unlistable model ids are never blocked by catalogue freshness.
 */
const ProviderModelInput: FC<ProviderModelInputProps> = ({
  provider,
  value,
  onChange,
  showStatus = true,
  id,
  placeholder = 'Runtime default, or type a model ID',
  'aria-describedby': describedBy,
  ...inputProps
}) => {
  const query = useProviderModels(provider)
  const listId = id ? `${id}-catalogue` : undefined
  const statusId = showStatus && id ? `${id}-catalogue-status` : undefined
  const ids = query.data?.status === 'ok' ? query.data.ids : []
  const inputDescription = [describedBy, statusId].filter(Boolean).join(' ') || undefined

  let status: string
  if (!provider) {
    status = 'Choose a provider to load its live model catalogue.'
  } else if (query.isPending) {
    status = 'Loading the live model catalogue…'
  } else if (query.isError || query.data?.status === 'request-failed') {
    status = 'Live catalogue request failed; type a provider-native model ID manually.'
  } else if (query.data?.status === 'unavailable') {
    status = `Live catalogue unavailable (${query.data.reason.kind}); type a provider-native model ID manually.`
  } else if (query.data?.status === 'ok') {
    status = `Live options from ${query.data.sourceLabel}, captured ${query.data.asOfLabel}; another provider-native model ID may be typed manually.`
  } else {
    status = 'Live catalogue unavailable; type a provider-native model ID manually.'
  }

  return (
    <div>
      <TextInput
        {...inputProps}
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        list={ids.length > 0 ? listId : undefined}
        aria-describedby={inputDescription}
        spellCheck={false}
      />
      {ids.length > 0 && listId ? (
        <datalist id={listId}>
          {ids.map((modelId) => <option key={modelId} value={modelId} />)}
        </datalist>
      ) : null}
      {showStatus ? (
        <div id={statusId} className="c-helper" data-testid="provider-model-status" aria-live="polite">
          {status}
        </div>
      ) : null}
    </div>
  )
}

export default ProviderModelInput
