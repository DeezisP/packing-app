import type { WrongBarcodeEvent } from '../../../electron/shared/types'

export function WrongBarcodeToast({ event }: { event: WrongBarcodeEvent }): JSX.Element {
  return (
    <div className="fixed bottom-6 right-6 bg-warn-500 text-surface-950 rounded-lg shadow-xl px-5 py-4 max-w-sm z-50">
      <p className="font-semibold">Wrong barcode.</p>
      <p className="text-sm mt-1">
        Scanned <span className="font-mono">{event.scannedBarcode}</span> but this station is currently recording:
      </p>
      <p className="text-sm font-mono mt-1">{event.activeBarcode}</p>
      <p className="text-xs mt-2 opacity-80">Recording continues uninterrupted.</p>
    </div>
  )
}
