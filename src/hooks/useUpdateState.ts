import { useEffect, useState } from 'react'
import type { UpdateState } from '../../electron/shared/types'

const EMPTY_STATE: UpdateState = {
  status: 'idle',
  currentVersion: '',
  latestVersion: null,
  releaseNotes: null,
  progressPercent: null,
  error: null
}

export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>(EMPTY_STATE)

  useEffect(() => {
    window.electronAPI.update.getState().then(setState)
    return window.electronAPI.update.onStateChanged(setState)
  }, [])

  return state
}
