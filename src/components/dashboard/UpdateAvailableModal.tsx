import { AnimatedDialog } from '../common/AnimatedDialog'
import { AnimatedButton } from '../common/AnimatedButton'
import { UpdatePanel } from '../common/UpdatePanel'
import { strings } from '../../lib/strings'
import type { UpdateState } from '../../../electron/shared/types'

interface Props {
  state: UpdateState
  onDownload: () => void
  onInstall: () => void
  onLater: () => void
}

export function UpdateAvailableModal({ state, onDownload, onInstall, onLater }: Props): JSX.Element {
  return (
    <AnimatedDialog onClose={onLater}>
      <h2 className="text-lg font-semibold text-slate-100">
        {state.status === 'downloaded' ? strings.updateModal.readyTitle : strings.updateModal.availableTitle}
      </h2>
      {state.latestVersion && <p className="text-sm text-slate-400 mt-1">{strings.updateModal.version(state.latestVersion)}</p>}

      <div className="mt-4">
        <UpdatePanel state={state} onCheck={() => undefined} onDownload={onDownload} onInstall={onInstall} showCheckButton={false} />
      </div>

      <div className="flex justify-end gap-3 mt-6">
        <AnimatedButton onClick={onLater}>{strings.updateModal.later}</AnimatedButton>
      </div>
    </AnimatedDialog>
  )
}
