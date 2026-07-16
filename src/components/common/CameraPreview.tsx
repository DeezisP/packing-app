import type { ReactNode } from 'react'
import { useCameraPreview } from '../../hooks/useCameraPreview'
import { strings } from '../../lib/strings'
import type { CameraDevice } from '../../../electron/shared/types'

interface CameraPreviewProps {
  /** Unique CameraDevice.id currently resolvable from the live camera list -
   *  null both when nothing is configured AND when the configured camera is
   *  temporarily disconnected (see `configured` to tell those apart). */
  cameraId: string | null
  /** The current full camera list - needed to disambiguate identical-name
   *  devices when matching the browser's own getUserMedia device list. */
  cameras: CameraDevice[]
  /** Ownership label reported to the main process (see CameraManager) so it
   *  can log and coordinate who currently holds this camera - a station id,
   *  or a synthetic id like 'diagnostics' for a preview not tied to one. */
  stationId: string
  /** Whether a camera is assigned in config at all, independent of live
   *  connectivity - drives the "no camera assigned" placeholder. Defaults to
   *  Boolean(cameraId), which is correct when the caller already knows the
   *  camera is connected (e.g. TestCameraModal only opens for one that is). */
  configured?: boolean
  overlay?: ReactNode
  placeholderText?: string
  className?: string
  children?: ReactNode
}

/** The live <video> element wired to one specific camera device (by unique
 *  id, never by friendly name - see useCameraPreview), plus the shared
 *  "no camera / preview unavailable" states. Used by StationCard and
 *  TestCameraModal so the preview wiring only exists in one place. */
export function CameraPreview({
  cameraId,
  cameras,
  stationId,
  configured,
  overlay,
  placeholderText,
  className,
  children
}: CameraPreviewProps): JSX.Element {
  const { videoRef, error, releasedForRecording } = useCameraPreview(cameraId, cameras, stationId)
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
      {cameraId && releasedForRecording && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-slate-300 text-sm px-4 text-center">
          {strings.camera.previewPausedForRecording}
        </div>
      )}
      {cameraId && !releasedForRecording && error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-warn-500 text-sm px-4 text-center">
          {strings.camera.previewUnavailable(error)}
        </div>
      )}
      {children}
    </div>
  )
}
