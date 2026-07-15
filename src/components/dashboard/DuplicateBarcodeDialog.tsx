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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface-900 border border-surface-700 rounded-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold text-slate-100">Recording already exists</h2>
        <p className="text-sm text-slate-400 mt-2">
          A recording for barcode <span className="font-mono text-slate-200">{event.barcode}</span> already exists.
          It will not be overwritten.
        </p>
        <p className="text-sm text-slate-300 mt-3">Open folder?</p>
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-surface-700 hover:bg-surface-600 text-slate-200"
          >
            No
          </button>
          <button
            onClick={handleOpenFolder}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-accent-600 hover:bg-accent-500 text-white"
          >
            Yes
          </button>
        </div>
      </div>
    </div>
  )
}
