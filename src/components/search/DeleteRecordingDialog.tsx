import { AnimatedDialog } from '../common/AnimatedDialog'
import { AnimatedButton } from '../common/AnimatedButton'
import { strings } from '../../lib/strings'
import type { RecordingRecord } from '../../../electron/shared/types'

interface Props {
  recording: RecordingRecord
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

const T = strings.search

export function DeleteRecordingDialog({ recording, busy, onConfirm, onCancel }: Props): JSX.Element {
  return (
    <AnimatedDialog onClose={busy ? undefined : onCancel} closeOnBackdrop={!busy}>
      <h2 className="text-lg font-semibold text-slate-100">{T.deleteDialogTitle}</h2>
      <p className="text-sm text-slate-400 mt-2">{T.deleteDialogBody}</p>
      <p className="text-sm font-mono text-slate-200 mt-3">{T.deleteDialogBarcode(recording.barcode)}</p>

      <div className="mt-3 bg-surface-800/60 border border-white/10 rounded-lg p-3">
        <p className="text-xs text-slate-400">{T.deleteDialogWillDelete}</p>
        <ul className="text-xs text-slate-500 mt-1 space-y-0.5 list-disc list-inside">
          <li>packing.mp4</li>
          <li>thumbnail.jpg</li>
          <li>metadata.json</li>
          <li>{T.deleteDialogAnyRelatedFiles}</li>
        </ul>
      </div>

      <p className="text-xs text-rec-500 mt-3 font-medium">{T.deleteDialogIrreversible}</p>

      <div className="flex justify-end gap-3 mt-6">
        <AnimatedButton onClick={onCancel} disabled={busy}>
          {strings.common.cancel}
        </AnimatedButton>
        <AnimatedButton variant="danger" onClick={onConfirm} disabled={busy}>
          {busy ? T.deleting : T.actionDelete}
        </AnimatedButton>
      </div>
    </AnimatedDialog>
  )
}
