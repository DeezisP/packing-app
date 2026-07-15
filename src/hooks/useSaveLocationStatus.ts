import { useEffect, useState } from 'react'
import type { SaveLocationStatus } from '../../electron/shared/types'

/** Tracks the health of the *currently configured* save folder (not a draft
 *  path being edited in Settings) so a global warning can be shown the
 *  moment it becomes unwritable - e.g. a network share drops mid-shift. */
export function useSaveLocationStatus(): SaveLocationStatus | null {
  const [status, setStatus] = useState<SaveLocationStatus | null>(null)

  useEffect(() => {
    window.electronAPI.config.getSaveLocationStatus().then((s) => {
      if (s) setStatus(s)
    })
    return window.electronAPI.config.onSaveLocationStatus(setStatus)
  }, [])

  return status
}
