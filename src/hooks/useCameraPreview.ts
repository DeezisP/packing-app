import { useEffect, useRef, useState } from 'react'
import { labelMatchesDeviceName } from '../lib/deviceMatching'
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

/** Attaches a live getUserMedia preview for a specific camera, identified by
 *  its unique `id` (ffmpeg's DirectShow device path) rather than its
 *  friendly name - two identical camera models report the exact same
 *  `navigator.mediaDevices` label, so matching by label alone can't tell
 *  them apart.
 *
 *  Recording is now owned entirely by ffmpeg in the main process (see
 *  LiveRecordingService), opening the physical camera directly rather than
 *  reading this hook's MediaStream - and this camera hardware cannot be
 *  opened by two processes at once (confirmed against real hardware). So
 *  when `stationId` is provided, this hook also answers the main process's
 *  release/resume handshake (see CameraPreviewReleaseRequest in
 *  shared/types.ts): on a release request for this exact camera, it stops
 *  only the video track(s) - never clearing `videoRef.current.srcObject` -
 *  so the `<video>` element keeps displaying its last decoded frame as a
 *  natural "frozen preview" with zero extra frame-capture code, then acks.
 *  On the matching resume signal, it reattaches exactly like a fresh mount.
 *  `stationId` is omitted by callers that never record (e.g.
 *  TestCameraModal), which then behaves exactly as before: attach once, stay
 *  attached.
 *
 *  Chromium's device list and the DirectShow list this app's cameraId values
 *  come from are two separate id namespaces with no shared key, so for a
 *  genuine duplicate-name pair this falls back to a best-effort correlation:
 *  both APIs enumerate USB cameras of the same model in the same relative
 *  order in practice, so "the Nth device named X in the configured list" is
 *  matched to "the Nth device named X" in the browser's list. This is not a
 *  documented guarantee, only an observed convention - but it only affects
 *  which of two *identical-model* live previews is shown; the recording this
 *  preview feeds is always the exact physical device the operator is looking
 *  at, since StationManager resolves cameras by this same unique id. */
export function useCameraPreview(
  cameraId: string | null,
  cameras: CameraDevice[],
  externalVideoRef?: React.RefObject<HTMLVideoElement>,
  /** Requested as `ideal` (never `exact`) getUserMedia constraints - a
   *  camera that can't hit this exact mode still attaches at its closest
   *  supported one instead of failing outright. Purely a live-preview
   *  quality hint now (recording is ffmpeg's own dshow capture at the
   *  station's configured preset, independent of this stream) - omitted for
   *  a preview not tied to a specific station's preset (e.g.
   *  TestCameraModal), which attaches at the camera's own default mode. */
  preset?: { width: number; height: number; fps: number },
  /** Station this preview belongs to - only provided by callers whose
   *  preview can be recorded (StationCard), which is what this hook needs to
   *  know to answer the main process's release/resume handshake. See this
   *  function's own doc comment. */
  stationId?: string
): {
  videoRef: React.RefObject<HTMLVideoElement>
  error: string | null
} {
  const ownVideoRef = useRef<HTMLVideoElement>(null)
  const videoRef = externalVideoRef ?? ownVideoRef
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
        const matches = devices.filter((d) => d.kind === 'videoinput' && labelMatchesDeviceName(d.label, target!.name))
        const match = matches[occurrence] ?? matches[0]

        window.electronAPI.system.log('info', 'Preview stage: attaching camera', {
          cameraId: target!.id,
          cameraName: target!.name,
          occurrence,
          chromiumDeviceId: match?.deviceId ?? null,
          chromiumMatchCount: matches.length,
          chromiumAllDeviceIds: matches.map((m) => m.deviceId)
        })

        const videoConstraints: MediaTrackConstraints = {
          ...(match ? { deviceId: { exact: match.deviceId } } : {}),
          ...(preset
            ? { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps } }
            : {})
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: Object.keys(videoConstraints).length > 0 ? videoConstraints : true
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

    // Narrow, acknowledged race: if a recording starts while this initial
    // attach() is still in flight (getUserMedia not yet resolved), `stream`
    // is still null when the release request arrives below, so there's
    // nothing to stop yet - the ack still fires immediately, and the
    // in-flight attach may go on to open the camera a moment after ffmpeg
    // already did. Only possible in the first getUserMedia round-trip after
    // mount/reconfigure, not during any steady-state recording start; ffmpeg's
    // own retry-on-busy (LiveRecordingService) absorbs it if it ever happens.
    let offRelease: (() => void) | undefined
    let offResume: (() => void) | undefined
    if (stationId) {
      offRelease = window.electronAPI.capture.onPreviewRelease(({ requestId, stationId: sid, cameraId: releaseCameraId }) => {
        if (sid !== stationId || releaseCameraId !== target!.id) return
        stream?.getVideoTracks().forEach((t) => t.stop())
        window.electronAPI.capture.acknowledgePreviewRelease(requestId)
      })
      offResume = window.electronAPI.capture.onPreviewResume(({ stationId: sid, cameraId: resumeCameraId }) => {
        if (sid !== stationId || resumeCameraId !== target!.id) return
        attach()
      })
    }

    return () => {
      cancelled = true
      offRelease?.()
      offResume?.()
      if (stream) {
        stream.getTracks().forEach((t) => t.stop())
      }
    }
    // Depends on preset's primitive fields rather than the object reference,
    // so a caller passing a fresh `{ width, height, fps }` literal every
    // render (e.g. derived from QUALITY_PRESETS each time) doesn't
    // needlessly re-attach the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, occurrence, preset?.width, preset?.height, preset?.fps, stationId])

  return { videoRef, error }
}
