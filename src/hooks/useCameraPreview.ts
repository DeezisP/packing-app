import { useEffect, useRef, useState } from 'react'

/** Attaches a live getUserMedia preview for the webcam whose label matches
 *  cameraName (the same DirectShow friendly name ffmpeg uses to record).
 *  This is a preview only - actual recording is done by ffmpeg in the main
 *  process so the browser-side stream never touches the saved file. */
export function useCameraPreview(cameraName: string | null): {
  videoRef: React.RefObject<HTMLVideoElement>
  error: string | null
} {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!cameraName) {
      setError(null)
      return
    }

    let stream: MediaStream | null = null
    let cancelled = false

    async function attach(): Promise<void> {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const match = devices.find((d) => d.kind === 'videoinput' && d.label === cameraName)

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
  }, [cameraName])

  return { videoRef, error }
}
