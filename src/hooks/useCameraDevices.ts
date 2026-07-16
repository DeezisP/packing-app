import { useEffect, useState } from 'react'
import type { CameraDevice } from '../../electron/shared/types'

/** Fetches the current camera/microphone list once, then stays in sync via
 *  cameraManager's push updates (plugged in / unplugged, no restart needed).
 *  Centralized here so Dashboard, Settings, and Device Pairing all see
 *  exactly the same list instead of each re-implementing the same
 *  fetch+subscribe effect. */
export function useCameraDevices(): { cameras: CameraDevice[]; mics: string[] } {
  const [cameras, setCameras] = useState<CameraDevice[]>([])
  const [mics, setMics] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.cameras.list().then(({ video, audio }) => {
      if (cancelled) return
      setCameras(video)
      setMics(audio)
      window.electronAPI.system.log('info', 'UI stage: camera list received', {
        cameras: video.map((c) => ({ id: c.id, name: c.name })),
        mics: audio
      })
    })
    const off = window.electronAPI.cameras.onListChanged(({ video, audio }) => {
      setCameras(video)
      setMics(audio)
      window.electronAPI.system.log('info', 'UI stage: camera list changed', {
        cameras: video.map((c) => ({ id: c.id, name: c.name })),
        mics: audio
      })
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  return { cameras, mics }
}
