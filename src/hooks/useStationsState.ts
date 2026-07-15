import { useEffect, useState, useCallback } from 'react'
import type { StationRuntimeState, WrongBarcodeEvent, DuplicateBarcodeEvent } from '../../electron/shared/types'

export function useStationsState(): {
  states: Record<string, StationRuntimeState>
  wrongBarcode: WrongBarcodeEvent | null
  duplicateBarcode: DuplicateBarcodeEvent | null
  dismissWrongBarcode: () => void
  dismissDuplicateBarcode: () => void
} {
  const [states, setStates] = useState<Record<string, StationRuntimeState>>({})
  const [wrongBarcode, setWrongBarcode] = useState<WrongBarcodeEvent | null>(null)
  const [duplicateBarcode, setDuplicateBarcode] = useState<DuplicateBarcodeEvent | null>(null)

  useEffect(() => {
    let cancelled = false

    window.electronAPI.stations.getState().then((initial) => {
      if (cancelled) return
      const map: Record<string, StationRuntimeState> = {}
      for (const s of initial) map[s.stationId] = s
      setStates(map)
    })

    const offState = window.electronAPI.stations.onStateChanged((state) => {
      setStates((prev) => ({ ...prev, [state.stationId]: state }))
    })

    const offWrong = window.electronAPI.stations.onWrongBarcode((event) => {
      setWrongBarcode(event)
      window.setTimeout(() => setWrongBarcode((current) => (current === event ? null : current)), 4000)
    })

    const offDuplicate = window.electronAPI.stations.onDuplicateBarcode((event) => {
      setDuplicateBarcode(event)
    })

    return () => {
      cancelled = true
      offState()
      offWrong()
      offDuplicate()
    }
  }, [])

  const dismissWrongBarcode = useCallback(() => setWrongBarcode(null), [])
  const dismissDuplicateBarcode = useCallback(() => setDuplicateBarcode(null), [])

  return { states, wrongBarcode, duplicateBarcode, dismissWrongBarcode, dismissDuplicateBarcode }
}
