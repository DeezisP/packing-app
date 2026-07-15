import { motion, type HTMLMotionProps } from 'framer-motion'
import { forwardRef } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost'

interface AnimatedButtonProps extends Omit<HTMLMotionProps<'button'>, 'ref'> {
  variant?: Variant
  size?: 'sm' | 'md'
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-accent-600 hover:bg-accent-500 text-white',
  secondary: 'bg-surface-700/70 hover:bg-surface-600/80 text-slate-200',
  danger: 'bg-rec-600/90 hover:bg-rec-600 text-white',
  success: 'bg-ok-500 hover:opacity-90 text-surface-950 font-medium',
  ghost: 'bg-transparent hover:bg-surface-700/50 text-slate-300'
}

const SIZE_CLASSES: Record<'sm' | 'md', string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm'
}

/** Shared button primitive - consistent press/hover motion everywhere
 *  (dialogs, toolbars, cards) instead of every call site re-declaring its
 *  own hover/active color pair with no motion feedback. */
export const AnimatedButton = forwardRef<HTMLButtonElement, AnimatedButtonProps>(function AnimatedButton(
  { variant = 'secondary', size = 'md', className = '', disabled, children, ...rest },
  ref
) {
  return (
    <motion.button
      ref={ref}
      disabled={disabled}
      whileHover={disabled ? undefined : { scale: 1.02 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
      className={`rounded-lg font-medium transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {children}
    </motion.button>
  )
})
