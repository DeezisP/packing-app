import { useEffect, useRef } from 'react'
import { drawOverlayOnCanvas } from '../lib/canvasOverlay'
import { labelMatchesDeviceName } from '../lib/deviceMatching'
import { formatHms, formatDateLocal, formatTimeLocal } from '../../electron/shared/types'
import type { CaptureBeginPayload, CaptureEndPayload } from '../../electron/shared/types'

interface ActiveCapture {
  sessionId: string
  recorder: MediaRecorder
  /** A mutable box (not a plain number) because the rAF loop reschedules
   *  itself every frame - `requestAnimationFrame` returns a new handle each
   *  call, and only the most recently scheduled one can actually be
   *  cancelled. Sharing this object by reference between the loop and
   *  `stopActiveCapture` is what lets cancellation always target the
   *  current handle instead of the stale first one. Null when there's no
   *  canvas loop at all (overlay disabled). */
  rafRef: { current: number | null } | null
  /** Tracks this capture created itself (a cloned camera track, a canvas
   *  track, a mic track) - stopped on cleanup. Never includes the live
   *  preview's own track, so cleanup can never affect what's on screen. */
  ownedTracks: MediaStreamTrack[]
}

/** Chromium ships VP8/VP9 webm encoding in every build with no proprietary
 *  codec dependency, unlike H.264 encoding via MediaRecorder which isn't
 *  guaranteed available - probed once and cached for the renderer's
 *  lifetime, same pattern as useCameraPreview's label-unlock probe. */
let cachedMimeType: string | null = null
function resolveMimeType(): string {
  if (cachedMimeType) return cachedMimeType
  const candidates = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm']
  cachedMimeType = candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? 'video/webm'
  return cachedMimeType
}

/** The main-process validation that gates `beginCapture` (camera connected,
 *  preset supported, disk space, etc.) runs entirely independently of the
 *  renderer's own getUserMedia attach, which could still be in flight (app
 *  just started, camera just reconnected) when the broadcast arrives - this
 *  is a real, not theoretical, race the old architecture never had to
 *  handle (CameraManager's claim/release handshake covered it implicitly).
 *  Polls briefly instead of failing instantly on the first check. */
async function waitForSourceStream(
  videoRef: React.RefObject<HTMLVideoElement>,
  timeoutMs = 3000
): Promise<MediaStream> {
  const start = Date.now()
  for (;;) {
    const stream = videoRef.current?.srcObject as MediaStream | null | undefined
    if (stream && stream.getVideoTracks().length > 0) return stream
    if (Date.now() - start >= timeoutMs) throw new Error('Live camera preview did not attach in time')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function stopActiveCapture(active: ActiveCapture): void {
  if (active.rafRef && active.rafRef.current !== null) cancelAnimationFrame(active.rafRef.current)
  if (active.recorder.state !== 'inactive') {
    active.recorder.stop()
  }
}

/** Captures a station's already-live camera preview into a recording -
 *  never opens or renegotiates the camera itself (see useCameraPreview,
 *  CaptureIngestService's class doc comment). Reacts purely to
 *  `capture:beginCapture`/`capture:endCapture` broadcasts from
 *  StationManager; the visible <video> element this reads frames from is
 *  never touched by any of this, recording or not. */
export function useRecordingCapture(stationId: string, videoRef: React.RefObject<HTMLVideoElement>): void {
  const activeRef = useRef<ActiveCapture | null>(null)

  useEffect(() => {
    async function beginCapture(payload: CaptureBeginPayload): Promise<void> {
      if (payload.stationId !== stationId) return
      if (activeRef.current) {
        // Shouldn't happen - StationManager never starts a new session for a
        // station whose previous one is still 'recording' - but never leak a
        // stale MediaRecorder if it somehow does.
        stopActiveCapture(activeRef.current)
        activeRef.current = null
      }

      const ownedTracks: MediaStreamTrack[] = []
      const rafRef: { current: number | null } = { current: null }

      try {
        const sourceStream = await waitForSourceStream(videoRef)
        const video = videoRef.current
        if (!video) throw new Error('Live camera preview element is gone')
        const sourceTrack = sourceStream.getVideoTracks()[0]

        let videoTrack: MediaStreamTrack

        if (payload.overlay) {
          const canvas = document.createElement('canvas')
          canvas.width = payload.preset.width
          canvas.height = payload.preset.height
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('Canvas 2D context unavailable')

          const { config, staticData } = payload.overlay
          const startedAtMs = new Date(payload.startedAt).getTime()

          const draw = (): void => {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            const now = new Date()
            drawOverlayOnCanvas(ctx, config, {
              barcode: staticData.barcode,
              date: formatDateLocal(now),
              time: formatTimeLocal(now),
              timer: formatHms(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))),
              station: staticData.station,
              camera: staticData.camera
            })
            rafRef.current = requestAnimationFrame(draw)
          }
          rafRef.current = requestAnimationFrame(draw)

          videoTrack = canvas.captureStream(payload.preset.fps).getVideoTracks()[0]
        } else {
          // No overlay to burn in - record the raw camera track directly.
          // Cloned (not the original) so stopping it on cleanup can never
          // affect the preview's own track.
          videoTrack = sourceTrack.clone()
        }
        ownedTracks.push(videoTrack)

        const tracks: MediaStreamTrack[] = [videoTrack]

        if (payload.micName) {
          const devices = await navigator.mediaDevices.enumerateDevices()
          const match = devices.find((d) => d.kind === 'audioinput' && labelMatchesDeviceName(d.label, payload.micName!))
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: match ? { deviceId: { exact: match.deviceId } } : true
          })
          const micTrack = micStream.getAudioTracks()[0]
          if (!micTrack) throw new Error('Microphone track unavailable')
          tracks.push(micTrack)
          ownedTracks.push(micTrack)
        }

        const mimeType = resolveMimeType()
        const recorder = new MediaRecorder(new MediaStream(tracks), {
          mimeType,
          videoBitsPerSecond: payload.preset.bitrateKbps * 1000,
          ...(payload.micName ? { audioBitsPerSecond: 128000 } : {})
        })

        const active: ActiveCapture = {
          sessionId: payload.sessionId,
          recorder,
          rafRef: payload.overlay ? rafRef : null,
          ownedTracks
        }
        activeRef.current = active

        // Every chunk send (including the final sentinel) is chained onto
        // this so they're strictly ordered AND the sentinel can only fire
        // once every real chunk's send has actually completed -
        // MediaRecorder fires 'dataavailable' for the last chunk before
        // 'stop', but that handler's own send is async (blob.arrayBuffer()
        // is a promise), while 'stop' would otherwise run its own handler
        // synchronously - without this chaining, the sentinel could
        // reach the main process before the last real chunk did, and
        // CaptureIngestService closes the file the moment it sees `final`.
        let sendQueue: Promise<void> = Promise.resolve()
        let seq = 0

        recorder.ondataavailable = (event) => {
          if (event.data.size === 0) return
          const blob = event.data
          sendQueue = sendQueue.then(async () => {
            const data = await blob.arrayBuffer()
            seq += 1
            window.electronAPI.capture.sendChunk({ sessionId: payload.sessionId, seq, data, final: false })
          })
        }
        recorder.onerror = (event) => {
          const message = (event as unknown as { error?: DOMException }).error?.message ?? 'MediaRecorder error'
          window.electronAPI.capture.reportError({ sessionId: payload.sessionId, stationId, message })
        }
        recorder.onstop = () => {
          active.ownedTracks.forEach((t) => t.stop())
          if (activeRef.current === active) activeRef.current = null
          sendQueue = sendQueue.then(() => {
            seq += 1
            window.electronAPI.capture.sendChunk({
              sessionId: payload.sessionId,
              seq,
              data: new ArrayBuffer(0),
              final: true
            })
          })
        }

        recorder.start(1000)
        window.electronAPI.system.log('info', 'Recording capture: started', {
          stationId,
          sessionId: payload.sessionId,
          mimeType,
          overlay: Boolean(payload.overlay),
          hasAudio: Boolean(payload.micName)
        })
      } catch (err) {
        const message = (err as Error).message
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
        ownedTracks.forEach((t) => t.stop())
        if (activeRef.current?.sessionId === payload.sessionId) activeRef.current = null
        window.electronAPI.system.log('warn', 'Recording capture: failed to start', {
          stationId,
          sessionId: payload.sessionId,
          error: message
        })
        window.electronAPI.capture.reportError({ sessionId: payload.sessionId, stationId, message })
      }
    }

    function endCapture(payload: CaptureEndPayload): void {
      if (payload.stationId !== stationId) return
      const active = activeRef.current
      if (!active || active.sessionId !== payload.sessionId) return
      stopActiveCapture(active)
    }

    const offBegin = window.electronAPI.capture.onBeginCapture((payload) => void beginCapture(payload))
    const offEnd = window.electronAPI.capture.onEndCapture(endCapture)

    return () => {
      offBegin()
      offEnd()
      if (activeRef.current) {
        stopActiveCapture(activeRef.current)
        activeRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId])
}
