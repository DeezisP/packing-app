import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AnimatedButton } from '../common/AnimatedButton'
import { formatDuration } from '../../lib/format'
import { strings } from '../../lib/strings'
import type { RecordingRecord } from '../../../electron/shared/types'

interface Props {
  recording: RecordingRecord
  onClose: () => void
}

export function VideoPlayerModal({ recording, onClose }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    window.electronAPI.recordings.markViewed(recording.id)
  }, [recording.id])

  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      }
      if (e.key === 'ArrowRight') stepFrame(1)
      if (e.key === 'ArrowLeft') stepFrame(-1)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function togglePlay(): void {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play()
    } else {
      v.pause()
    }
  }

  function stepFrame(direction: 1 | -1): void {
    const v = videoRef.current
    if (!v) return
    v.pause()
    v.currentTime = Math.max(0, v.currentTime + direction * (1 / recording.fps))
  }

  function seek(value: number): void {
    const v = videoRef.current
    if (!v) return
    v.currentTime = value
  }

  function toggleFullscreen(): void {
    if (!containerRef.current) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      containerRef.current.requestFullscreen()
    }
  }

  return (
    <motion.div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        ref={containerRef}
        className="glass glass-strong overflow-hidden w-full max-w-4xl flex flex-col"
        initial={{ opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 10 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div>
            <p className="font-mono text-sm text-slate-200">{recording.barcode}</p>
            <p className="text-xs text-slate-500">
              {strings.videoPlayer.meta(recording.station, recording.camera, recording.resolution, recording.fps)}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm">
            {strings.common.close}
          </button>
        </div>

        <video
          ref={videoRef}
          src={recording.videoUrl}
          className="w-full bg-black max-h-[60vh]"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        />

        <div className="p-4 space-y-3">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={currentTime}
            onChange={(e) => seek(Number(e.target.value))}
            className="w-full accent-accent-500"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AnimatedButton size="sm" onClick={() => stepFrame(-1)} title={strings.videoPlayer.prevFrame}>
                ⏮
              </AnimatedButton>
              <AnimatedButton variant="primary" onClick={togglePlay}>
                {playing ? strings.videoPlayer.pause : strings.videoPlayer.play}
              </AnimatedButton>
              <AnimatedButton size="sm" onClick={() => stepFrame(1)} title={strings.videoPlayer.nextFrame}>
                ⏭
              </AnimatedButton>
              <span className="text-xs text-slate-500 font-mono ml-2">
                {formatDuration(currentTime)} / {formatDuration(duration || 0)}
              </span>
            </div>
            <AnimatedButton onClick={toggleFullscreen}>{strings.videoPlayer.fullscreen}</AnimatedButton>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
