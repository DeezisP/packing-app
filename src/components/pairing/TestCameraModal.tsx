import { useCameraPreview } from '../../hooks/useCameraPreview'

interface Props {
  cameraName: string
  onClose: () => void
}

export function TestCameraModal({ cameraName, onClose }: Props): JSX.Element {
  const { videoRef, error } = useCameraPreview(cameraName)

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
      <div className="bg-surface-900 border border-surface-700 rounded-xl overflow-hidden w-full max-w-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-800">
          <span className="text-sm font-semibold text-slate-100">{cameraName}</span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm">
            Close
          </button>
        </div>
        <div className="relative aspect-video bg-black">
          <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-warn-500 text-sm px-4 text-center">
              Preview unavailable: {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
