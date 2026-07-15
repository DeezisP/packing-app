import type { ReactNode } from 'react'
import { useCameraPreview } from '../../hooks/useCameraPreview'
import { strings } from '../../lib/strings'

interface CameraPreviewProps {
  cameraName: string | null
  overlay?: ReactNode
  placeholderText?: string
  className?: string
  children?: ReactNode
}

/** The live <video> element wired to a named DirectShow camera, plus the
 *  shared "no camera / preview unavailable" states - used by StationCard and
 *  TestCameraModal so the preview wiring only exists in one place. */
export function CameraPreview({ cameraName, overlay, placeholderText, className, children }: CameraPreviewProps): JSX.Element {
  const { videoRef, error } = useCameraPreview(cameraName)

  return (
    <div className={`relative aspect-video bg-black overflow-hidden ${className ?? ''}`}>
      <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
      {overlay}
      {!cameraName && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm">
          {placeholderText ?? strings.stationCard.noCameraAssigned}
        </div>
      )}
      {cameraName && error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-warn-500 text-sm px-4 text-center">
          {strings.camera.previewUnavailable(error)}
        </div>
      )}
      {children}
    </div>
  )
}
