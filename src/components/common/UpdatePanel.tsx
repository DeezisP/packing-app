import type { UpdateState } from '../../../electron/shared/types'

interface Props {
  state: UpdateState
  onCheck: () => void
  onDownload: () => void
  onInstall: () => void
  showCheckButton?: boolean
}

export function UpdatePanel({ state, onCheck, onDownload, onInstall, showCheckButton = true }: Props): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="block text-xs text-slate-500">Current Version</span>
          <span className="font-mono text-slate-200">{state.currentVersion || '-'}</span>
        </div>
        <div>
          <span className="block text-xs text-slate-500">Latest Version</span>
          <span className="font-mono text-slate-200">{state.latestVersion ?? '-'}</span>
        </div>
      </div>

      <StatusLine state={state} />

      {state.status === 'available' && state.releaseNotes && (
        <div className="bg-surface-800 border border-surface-700 rounded-lg p-3 text-xs text-slate-300 max-h-32 overflow-auto whitespace-pre-wrap">
          {state.releaseNotes}
        </div>
      )}

      {state.status === 'downloading' && (
        <div className="w-full h-2 bg-surface-700 rounded-full overflow-hidden">
          <div className="h-full bg-accent-500 transition-all" style={{ width: `${state.progressPercent ?? 0}%` }} />
        </div>
      )}

      <div className="flex gap-2">
        {showCheckButton && state.status !== 'downloading' && state.status !== 'downloaded' && (
          <button onClick={onCheck} className="px-3 py-1.5 rounded-lg text-sm bg-surface-700 hover:bg-surface-600">
            {state.status === 'checking' ? 'Checking...' : 'Check for Updates'}
          </button>
        )}
        {state.status === 'available' && (
          <button
            onClick={onDownload}
            className="px-3 py-1.5 rounded-lg text-sm bg-accent-600 hover:bg-accent-500 text-white font-medium"
          >
            Download & Install
          </button>
        )}
        {state.status === 'downloaded' && (
          <div className="flex flex-col gap-1">
            <button
              onClick={onInstall}
              className="px-3 py-1.5 rounded-lg text-sm bg-ok-500 hover:opacity-90 text-surface-950 font-medium"
            >
              Restart & Install
            </button>
            <span className="text-xs text-slate-500">
              The app will close, update in the background, and reopen automatically on the new
              version - no installer window, nothing else to do.
            </span>
          </div>
        )}
        {state.status === 'error' && !showCheckButton && (
          <button onClick={onCheck} className="px-3 py-1.5 rounded-lg text-sm bg-surface-700 hover:bg-surface-600">
            Retry
          </button>
        )}
      </div>
    </div>
  )
}

function StatusLine({ state }: { state: UpdateState }): JSX.Element {
  switch (state.status) {
    case 'idle':
      return <p className="text-sm text-slate-500">Update status unknown - click Check for Updates.</p>
    case 'checking':
      return <p className="text-sm text-slate-400">Checking for updates...</p>
    case 'available':
      return <p className="text-sm text-accent-500">A new version is available.</p>
    case 'not-available':
      return <p className="text-sm text-ok-500">You are using the latest version.</p>
    case 'downloading':
      return <p className="text-sm text-slate-400">Downloading update... {state.progressPercent ?? 0}%</p>
    case 'downloaded':
      return <p className="text-sm text-ok-500">Update downloaded and ready to install.</p>
    case 'error':
      return <p className="text-sm text-rec-500">{state.error ?? 'Unable to check for updates. Please try again later.'}</p>
    default:
      return <></>
  }
}
