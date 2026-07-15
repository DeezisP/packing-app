import { AnimatedDialog } from '../common/AnimatedDialog'
import { AnimatedButton } from '../common/AnimatedButton'
import { strings } from '../../lib/strings'
import type { DuplicateBarcodeEvent } from '../../../electron/shared/types'

interface Props {
  event: DuplicateBarcodeEvent
  onClose: () => void
}

export function DuplicateBarcodeDialog({ event, onClose }: Props): JSX.Element {
  async function handleOpenFolder(): Promise<void> {
    await window.electronAPI.barcode.openExistingFolder(event.existingFolder)
    onClose()
  }

  return (
    <AnimatedDialog onClose={onClose}>
      <h2 className="text-lg font-semibold text-slate-100">{strings.duplicateBarcode.title}</h2>
      <p className="text-sm text-slate-400 mt-2">
        {strings.duplicateBarcode.body(event.barcode)}
      </p>
      <p className="text-sm text-slate-300 mt-3">{strings.duplicateBarcode.question}</p>
      <div className="flex justify-end gap-3 mt-6">
        <AnimatedButton onClick={onClose}>{strings.common.no}</AnimatedButton>
        <AnimatedButton variant="primary" onClick={handleOpenFolder}>
          {strings.common.yes}
        </AnimatedButton>
      </div>
    </AnimatedDialog>
  )
}
