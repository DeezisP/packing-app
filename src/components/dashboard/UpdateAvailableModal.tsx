import { UpdatePanel } from '../common/UpdatePanel'
import type { UpdateState } from '../../../electron/shared/types'

interface Props {
  state: UpdateState
  onDownload: () => void
  onInstall: () => void
  onLater: () => void
}

export function UpdateAvailableModal({ state, onDownload, onInstall, onLater }: Props): JSX.Element {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface-900 border border-surface-700 rounded-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold text-slate-100">
          {state.status === 'downloaded' ? 'Update ready to install' : 'A new version is available'}
        </h2>
        {state.latestVersion && <p className="text-sm text-slate-400 mt-1">Version {state.latestVersion}</p>}

        <div className="mt-4">
          <UpdatePanel state={state} onCheck={() => undefined} onDownload={onDownload} onInstall={onInstall} showCheckButton={false} />
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onLater}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-surface-700 hover:bg-surface-600 text-slate-200"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  )
}
