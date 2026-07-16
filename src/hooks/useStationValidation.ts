import { useEffect, useState } from 'react'
import type { StationValidationIssue } from '../../electron/shared/types'

/** Tracks scanner/camera assignment problems (missing or duplicated) across
 *  all enabled stations - pushed from the main process whenever config, the
 *  camera list, or the scanner list changes, so this never goes stale while
 *  the operator is mid-setup in Settings or Device Pairing. */
export function useStationValidation(): StationValidationIssue[] {
  const [issues, setIssues] = useState<StationValidationIssue[]>([])

  useEffect(() => {
    window.electronAPI.stations.getValidation().then(setIssues)
    return window.electronAPI.stations.onValidationChanged(setIssues)
  }, [])

  return issues
}
