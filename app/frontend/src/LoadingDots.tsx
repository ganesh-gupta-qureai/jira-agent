import { motion } from 'framer-motion'

// Three pulsing dots — shown while we're waiting for the first token.
// Lifted directly from tytona's pattern.
export default function LoadingDots() {
  return (
    <div className="loading-dots" aria-label="thinking">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="loading-dots__dot"
          animate={{ y: [0, -4, 0] }}
          transition={{
            duration: 0.6,
            repeat: Infinity,
            repeatType: 'reverse',
            delay: i * 0.12,
          }}
        />
      ))}
    </div>
  )
}
