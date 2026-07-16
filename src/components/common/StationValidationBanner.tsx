import { motion } from 'framer-motion'
import { strings } from '../../lib/strings'
import type { StationValidationIssue } from '../../../electron/shared/types'

interface Props {
  issues: StationValidationIssue[]
}

const T = strings.stationValidation

function messageFor(issue: StationValidationIssue): string {
  switch (issue.type) {
    case 'scannerMissing':
      return T.scannerMissing(issue.stationName)
    case 'cameraMissing':
      return T.cameraMissing(issue.stationName)
    case 'scannerDuplicate':
      return T.scannerDuplicate(issue.stationName)
    case 'cameraDuplicate':
      return T.cameraDuplicate(issue.stationName)
  }
}

/** App-wide (not just Settings) banner listing every current
 *  scanner/camera assignment problem - a station missing a device, or two
 *  stations pointing at the same one - so a broken Scanner -> Station ->
 *  Camera chain is visible immediately instead of only being discovered the
 *  next time someone scans a barcode. Mirrors SaveLocationWarningBanner's
 *  pattern: driven by pushed main-process state, no dismiss button, so it
 *  disappears on its own the moment the underlying config is fixed. */
export function StationValidationBanner({ issues }: Props): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="bg-warn-500/15 backdrop-blur-sm text-warn-500 text-sm px-6 py-2 overflow-hidden"
    >
      <div className="flex items-start gap-2 flex-wrap">
        <strong className="shrink-0">{T.title}</strong>
        <ul className="flex-1 min-w-0 space-y-0.5">
          {issues.map((issue) => (
            <li key={`${issue.stationId}-${issue.type}`} className="truncate">
              {messageFor(issue)}
            </li>
          ))}
        </ul>
      </div>
    </motion.div>
  )
}
