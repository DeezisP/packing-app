import { motion } from 'framer-motion'

interface ToggleProps {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}

/** Shared switch control - spring-animated thumb instead of the abrupt
 *  translate-x jump, used by every toggle across Settings. */
export function Toggle({ checked, onChange, disabled }: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`w-11 h-6 rounded-full relative transition-colors duration-200 disabled:opacity-50 ${
        checked ? 'bg-accent-600' : 'bg-surface-600'
      }`}
    >
      <motion.span
        className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow"
        animate={{ x: checked ? 20 : 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
      />
    </button>
  )
}
