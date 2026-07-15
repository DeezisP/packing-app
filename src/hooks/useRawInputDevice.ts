import { useEffect, useRef } from 'react'

const STALE_MS = 3000

/** Tracks which physical scanner most recently sent a keystroke, using main
 *  process Raw Input events. A short staleness window means a scan is only
 *  attributed to a device if that device was actually active moments ago -
 *  guards against a stale reading lingering after a device goes quiet. */
export function useRawInputDevice(): () => string | null {
  const lastDeviceId = useRef<string | null>(null)
  const lastAt = useRef(0)

  useEffect(() => {
    return window.electronAPI.scanners.onRawKeydown(({ deviceId, timestamp }) => {
      lastDeviceId.current = deviceId
      lastAt.current = timestamp
    })
  }, [])

  return () => {
    if (Date.now() - lastAt.current > STALE_MS) return null
    return lastDeviceId.current
  }
}
