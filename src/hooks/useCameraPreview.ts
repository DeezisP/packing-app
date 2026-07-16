import { useEffect, useRef, useState } from 'react'
import type { CameraDevice } from '../../electron/shared/types'

/** Chromium redacts every device's `label` (and gives every device the same
 *  unstable placeholder `deviceId`) in `enumerateDevices()` until the current
 *  page has completed at least one actually-granted `getUserMedia()` call -
 *  an Electron `setPermissionRequestHandler`/`setPermissionCheckHandler` that
 *  auto-approves media does NOT by itself unlock this; Chromium still waits
 *  for a real capture grant to have happened in this session. Confirmed via
 *  this app's own diagnostic logging: on a fresh window, the very first
 *  `enumerateDevices()` call returns 0 labeled matches for a target camera
 *  name that is definitely connected. Call once, lazily, before the first
 *  real attach; safe to call repeatedly - once unlocked it stays unlocked
 *  for the life of the renderer. */
let labelsUnlocked = false
async function ensureDeviceLabelsUnlocked(): Promise<void> {
  if (labelsUnlocked) return
  const before = await navigator.mediaDevices.enumerateDevices()
  const needsPrimer = before.some((d) => d.kind === 'videoinput' && !d.label)
  window.electronAPI.system.log('info', 'Preview stage: label-unlock check', {
    needsPrimer,
    videoInputCount: before.filter((d) => d.kind === 'videoinput').length,
    labels: before.filter((d) => d.kind === 'videoinput').map((d) => d.label)
  })
  if (needsPrimer) {
    try {
      const primer = await navigator.mediaDevices.getUserMedia({ video: true })
      primer.getTracks().forEach((t) => t.stop())
      const after = await navigator.mediaDevices.enumerateDevices()
      window.electronAPI.system.log('info', 'Preview stage: label-unlock primer result', {
        labels: after.filter((d) => d.kind === 'videoinput').map((d) => d.label)
      })
    } catch (err) {
      window.electronAPI.system.log('warn', 'Preview stage: label-unlock primer failed', {
        error: (err as Error).message
      })
    }
  }
  labelsUnlocked = true
}

/** Chromium's camera label is not always exactly the DirectShow friendly
 *  name ffmpeg reports: once it can see there are multiple devices sharing a
 *  name, it appends a `" (vendorId:productId)"` suffix to help JS-side
 *  disambiguation, e.g. ffmpeg's `"EMEET SmartCam S600"` shows up from
 *  Chromium as `"EMEET SmartCam S600 (328f:00e6)"`. A strict `===` against
 *  ffmpeg's plain name therefore matches nothing at all (confirmed via this
 *  app's own diagnostic logging: chromiumMatchCount stayed 0 even after
 *  labels were unlocked) - and both identical-model cameras get the *same*
 *  suffix (same vendor/product id), so it doesn't finish the disambiguation
 *  by itself either. Matching on a name-boundary prefix handles both: it
 *  still requires the base name to match exactly (not just contain it
 *  anywhere), so it can't accidentally match an unrelated device whose name
 *  happens to start the same way. */
function labelMatchesCameraName(label: string, name: string): boolean {
  return label === name || label.startsWith(`${name} (`)
}

/** Attaches a live getUserMedia preview for a specific camera, identified by
 *  its unique `id` (ffmpeg's DirectShow device path) rather than its
 *  friendly name - two identical camera models report the exact same
 *  `navigator.mediaDevices` label, so matching by label alone can't tell
 *  them apart.
 *
 *  Chromium's device list and ffmpeg's dshow list are two separate id
 *  namespaces with no shared key, so for a genuine duplicate-name pair this
 *  falls back to a best-effort correlation: both APIs enumerate USB cameras
 *  of the same model in the same relative order in practice, so "the Nth
 *  device named X in ffmpeg's list" is matched to "the Nth device named X"
 *  in the browser's list. This is not a documented guarantee, only an
 *  observed convention - but it only affects which of two *identical-model*
 *  live previews is shown; actual recording is always exact regardless,
 *  since ffmpeg opens the unique device path directly (see RecordingEngine). */
export function useCameraPreview(
  cameraId: string | null,
  cameras: CameraDevice[]
): {
  videoRef: React.RefObject<HTMLVideoElement>
  error: string | null
} {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  const target = cameraId ? (cameras.find((c) => c.id === cameraId) ?? null) : null
  const occurrence = target
    ? cameras
        .filter((c) => c.name === target.name)
        .sort((a, b) => a.index - b.index)
        .findIndex((c) => c.id === target.id)
    : -1

  useEffect(() => {
    if (!target) {
      setError(null)
      return
    }

    let stream: MediaStream | null = null
    let cancelled = false

    async function attach(): Promise<void> {
      try {
        await ensureDeviceLabelsUnlocked()
        if (cancelled) return

        const devices = await navigator.mediaDevices.enumerateDevices()
        const matches = devices.filter((d) => d.kind === 'videoinput' && labelMatchesCameraName(d.label, target!.name))
        const match = matches[occurrence] ?? matches[0]

        window.electronAPI.system.log('info', 'Preview stage: attaching camera', {
          cameraId: target!.id,
          cameraName: target!.name,
          occurrence,
          chromiumDeviceId: match?.deviceId ?? null,
          chromiumMatchCount: matches.length,
          chromiumAllDeviceIds: matches.map((m) => m.deviceId)
        })

        stream = await navigator.mediaDevices.getUserMedia({
          video: match ? { deviceId: { exact: match.deviceId } } : true
        })

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
        setError(null)
      } catch (err) {
        const message = (err as Error).message
        window.electronAPI.system.log('warn', 'Preview stage: attach failed', {
          cameraId: target!.id,
          cameraName: target!.name,
          error: message
        })
        if (!cancelled) setError(message)
      }
    }

    attach()

    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, occurrence])

  return { videoRef, error }
}
