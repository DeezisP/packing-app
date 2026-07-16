import { motion } from 'framer-motion'
import { CameraPreview } from '../common/CameraPreview'
import { buildCameraDisplayNames } from '../../../electron/shared/types'
import { strings } from '../../lib/strings'
import type { CameraDevice } from '../../../electron/shared/types'

interface Props {
  camera: CameraDevice
  cameras: CameraDevice[]
  onClose: () => void
}

export function TestCameraModal({ camera, cameras, onClose }: Props): JSX.Element {
  const displayName = buildCameraDisplayNames(cameras).get(camera.id) ?? camera.name

  return (
    <motion.div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="glass glass-strong overflow-hidden w-full max-w-2xl"
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span className="text-sm font-semibold text-slate-100">{displayName}</span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm">
            {strings.common.close}
          </button>
        </div>
        <CameraPreview cameraId={camera.id} cameras={cameras} stationId="diagnostics" configured />
      </motion.div>
    </motion.div>
  )
}
