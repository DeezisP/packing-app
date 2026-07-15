import { NotificationToast } from '../common/NotificationToast'
import { strings } from '../../lib/strings'
import type { WrongBarcodeEvent } from '../../../electron/shared/types'

export function WrongBarcodeToast({ event }: { event: WrongBarcodeEvent }): JSX.Element {
  return (
    <NotificationToast tone="warning" title={strings.wrongBarcode.title}>
      <p>
        {strings.wrongBarcode.bodyPrefix} <span className="font-mono">{event.scannedBarcode}</span>{' '}
        {strings.wrongBarcode.bodySuffix}
      </p>
      <p className="font-mono">{event.activeBarcode}</p>
      <p className="text-xs opacity-80">{strings.wrongBarcode.note}</p>
    </NotificationToast>
  )
}
