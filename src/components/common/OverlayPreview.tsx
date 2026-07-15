import { buildOverlayLines } from '../../../electron/shared/types'
import type { OverlayConfig, OverlayFieldData } from '../../../electron/shared/types'

interface Props {
  config: OverlayConfig
  data: OverlayFieldData
}

// The recording burns text in at a literal pixel size relative to the actual
// output resolution (1080p by far the most common default). The preview here
// is laid over a CSS-scaled-down <video>, so font size is expressed in
// container-query width units scaled against that same reference width -
// this keeps the preview a close visual match to the real output across
// different preview element sizes without needing to measure anything in JS.
const REFERENCE_WIDTH = 1920

const POSITION_CLASSES: Record<OverlayConfig['position'], string> = {
  'top-left': 'top-0 left-0 items-start text-left',
  'top-right': 'top-0 right-0 items-end text-right',
  'bottom-left': 'bottom-0 left-0 items-start text-left',
  'bottom-right': 'bottom-0 right-0 items-end text-right'
}

export function OverlayPreview({ config, data }: Props): JSX.Element | null {
  if (!config.enabled) return null
  const lines = buildOverlayLines(config, data)
  if (lines.length === 0) return null

  const fontSizeCqw = (config.fontSize / REFERENCE_WIDTH) * 100
  const marginCqw = (20 / REFERENCE_WIDTH) * 100

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ containerType: 'inline-size' }}>
      <div
        className={`absolute flex flex-col ${POSITION_CLASSES[config.position]}`}
        style={{ margin: `${marginCqw}cqw` }}
      >
        <div
          style={{
            fontFamily: 'Arial, Helvetica, sans-serif',
            fontSize: `${fontSizeCqw}cqw`,
            lineHeight: 1.35,
            color: config.fontColor,
            backgroundColor: hexToRgba(config.backgroundColor, config.backgroundOpacity / 100),
            padding: '0.35em 0.5em',
            whiteSpace: 'pre'
          }}
        >
          {lines.join('\n')}
        </div>
      </div>
    </div>
  )
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16) || 0
  const g = parseInt(clean.slice(2, 4), 16) || 0
  const b = parseInt(clean.slice(4, 6), 16) || 0
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
