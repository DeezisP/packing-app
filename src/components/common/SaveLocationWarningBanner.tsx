import { useSaveLocationStatus } from '../../hooks/useSaveLocationStatus'

/** Persistent, app-wide banner - shown on every tab, not just Settings -
 *  because an unwritable save folder blocks new recordings everywhere. */
export function SaveLocationWarningBanner(): JSX.Element | null {
  const status = useSaveLocationStatus()

  if (!status || status.writable) return null

  return (
    <div className="bg-rec-600/90 text-white text-sm px-6 py-2 flex items-center justify-between">
      <span>
        <strong>Save folder unavailable:</strong> {status.error ?? 'the configured folder cannot be written to.'}{' '}
        New recordings are blocked until a valid folder is selected in Settings.
      </span>
      <span className="font-mono text-xs opacity-80">{status.path}</span>
    </div>
  )
}
