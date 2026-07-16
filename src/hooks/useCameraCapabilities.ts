import { useEffect, useState } from 'react'
import type { CameraCapabilityOption } from '../../electron/shared/types'

/** Fetches (and re-fetches on change) the resolution/frame-rate modes a
 *  specific camera reports supporting, for disabling unsupported quality
 *  presets in Settings. Returns null while unresolved/unknown (no camera
 *  assigned) - callers should treat that the same as "can't tell, allow
 *  anything" (see isPresetSupported's empty-array fail-open behavior). */
export function useCameraCapabilities(cameraId: string | null): CameraCapabilityOption[] | null {
  const [capabilities, setCapabilities] = useState<CameraCapabilityOption[] | null>(null)

  useEffect(() => {
    if (!cameraId) {
      setCapabilities(null)
      return
    }
    let cancelled = false
    setCapabilities(null)
    window.electronAPI.cameras.getCapabilities(cameraId).then((result) => {
      if (!cancelled) setCapabilities(result)
    })
    return () => {
      cancelled = true
    }
  }, [cameraId])

  return capabilities
}
