import { useEffect, useRef, useState } from 'react'
import type { CameraDevice } from '../../electron/shared/types'

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
        const devices = await navigator.mediaDevices.enumerateDevices()
        const matches = devices.filter((d) => d.kind === 'videoinput' && d.label === target!.name)
        const match = matches[occurrence] ?? matches[0]

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
        if (!cancelled) setError((err as Error).message)
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
