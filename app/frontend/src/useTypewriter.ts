import { useEffect, useMemo, useRef, useState } from 'react'

// Reveal `text` token-by-token (word + its trailing whitespace) at ~`wps`
// words per second. Returns the visible tokens as an array so the consumer
// can wrap each in its own motion element for a per-word fade.
//
// Rate is intentionally slower than network arrival — the buffer fills faster
// than we reveal, so bursty token deltas never show up as jumps. When the
// stream ends (`done=true`) we snap to the full text immediately.
export function useTypewriter(text: string, done: boolean, wps = 30): string[] {
  const tokens = useMemo(
    () => text.match(/\S+\s*/g) ?? [],
    [text],
  )
  const total = tokens.length

  const [revealed, setRevealed] = useState<number>(() => (done ? total : 0))
  const rafRef = useRef<number | null>(null)
  const lastRef = useRef<number>(0)
  const carryRef = useRef<number>(0)

  useEffect(() => {
    if (done) {
      setRevealed(total)
      return
    }
    const tick = (now: number) => {
      if (lastRef.current === 0) lastRef.current = now
      const dt = now - lastRef.current
      lastRef.current = now
      carryRef.current += (dt / 1000) * wps
      const step = Math.floor(carryRef.current)
      if (step > 0) {
        carryRef.current -= step
        setRevealed((r) => Math.min(r + step, total))
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastRef.current = 0
    }
  }, [total, done, wps])

  return tokens.slice(0, revealed)
}
