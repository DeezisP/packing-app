import type { ReactNode } from 'react'
import { useCameraPreview } from '../../hooks/useCameraPreview'
import { PreviewLatencyOverlay } from './PreviewLatencyOverlay'
import { strings } from '../../lib/strings'
import type { CameraDevice } from '../../../electron/shared/types'

interface CameraPreviewProps {
  /** Unique CameraDevice.id currently resolvable from the live camera list -
   *  null both when nothing is configured AND when the configured camera is
   *  temporarily disconnected (see `configured` to tell those apart). */
  cameraId: string | null
  /** The current full camera list - needed to disambiguate identical-name
   *  devices when matching the browser's own getUserMedia device list
   *  (used only when `allowGetUserMediaFallback` - see useCameraPreview). */
  cameras: CameraDevice[]
  /** getUserMedia quality hint, used only when `allowGetUserMediaFallback`.
   *  A camera under persistent capture ignores this - its real mode was
   *  already negotiated when capture started. */
  preset?: { width: number; height: number; fps: number }
  /** Whether this preview may fall back to a plain getUserMedia attach when
   *  the camera has no active persistent capture session. Defaults to true
   *  (TestCameraModal: previewing a spare/candidate camera with no station
   *  assignment, where persistent capture will never exist). StationCard
   *  passes `false` explicitly - a station-owned camera's persistent
   *  session is expected to exist or come up shortly, and letting the
   *  renderer race it for the device would deadlock both (see
   *  useCameraPreview's own doc comment). */
  allowGetUserMediaFallback?: boolean
  /** Whether a camera is assigned in config at all, independent of live
   *  connectivity - drives the "no camera assigned" placeholder. Defaults to
   *  Boolean(cameraId), which is correct when the caller already knows the
   *  camera is connected (e.g. TestCameraModal only opens for one that is). */
  configured?: boolean
  overlay?: ReactNode
  placeholderText?: string
  className?: string
  children?: ReactNode
  /** Shows the preview-latency verification overlay (see
   *  PreviewLatencyOverlay) - temporary, off by default. Only ever produces
   *  data in MSE mode (a persistent-capture-backed preview), never for a
   *  plain getUserMedia fallback attach. */
  showLatencyDebug?: boolean
}

/** The live <video> element wired to one specific camera device (by unique
 *  id, never by friendly name - see useCameraPreview), plus the shared
 *  "no camera / preview unavailable" states. Used by StationCard and
 *  TestCameraModal so the preview wiring only exists in one place.
 *
 *  Continuous regardless of recording status: a camera under persistent
 *  capture (see PersistentCaptureService) plays that same live encoded
 *  stream via Media Source Extensions the entire time, with no reconnect,
 *  freeze, or component swap when a recording starts or stops - see
 *  useCameraPreview's own doc comment for why. */
export function CameraPreview({
  cameraId,
  cameras,
  preset,
  allowGetUserMediaFallback = true,
  configured,
  overlay,
  placeholderText,
  className,
  children,
  showLatencyDebug
}: CameraPreviewProps): JSX.Element {
  const { videoRef, error, connecting, latencyDebug } = useCameraPreview(cameraId, cameras, undefined, preset, allowGetUserMediaFallback)
  const isConfigured = configured ?? Boolean(cameraId)

  return (
    <div className={`relative aspect-video bg-black overflow-hidden ${className ?? ''}`}>
      <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
      {overlay}
      {!isConfigured && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm">
          {placeholderText ?? strings.stationCard.noCameraAssigned}
        </div>
      )}
      {cameraId && isConfigured && connecting && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm">
          {strings.camera.connecting}
        </div>
      )}
      {cameraId && error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-warn-500 text-sm px-4 text-center">
          {strings.camera.previewUnavailable(error)}
        </div>
      )}
      {children}
      {showLatencyDebug && latencyDebug && <PreviewLatencyOverlay debug={latencyDebug} />}
    </div>
  )
}
