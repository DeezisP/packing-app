import { strings } from '../../lib/strings'

interface DeviceStatusProps {
  label: string
  connected: boolean
  /** Device/scanner/camera display name shown next to the label. */
  detail?: string | null
  /** Overrides the default "not paired / not assigned" text when there's no device at all. */
  emptyText?: string
}

/** A single label + dot + connection-state row, shared by StationCard,
 *  DevicePairingPage's scanner cards, and the camera table - one definition
 *  for the "green dot connected / red dot disconnected" pattern used
 *  throughout the app. */
export function DeviceStatus({ label, connected, detail, emptyText }: DeviceStatusProps): JSX.Element {
  if (!detail) {
    return (
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-300">{emptyText ?? strings.common.notAssigned}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="flex items-center gap-1.5 text-slate-300">
        <span
          className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${connected ? 'bg-ok-500' : 'bg-rec-500'}`}
        />
        {detail}
        <span className={connected ? 'text-ok-500' : 'text-rec-500'}>
          ({connected ? strings.common.connected : strings.common.disconnected})
        </span>
      </span>
    </div>
  )
}
