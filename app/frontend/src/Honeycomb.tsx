// Subtle hexagonal pattern fading from the bottom-right corner.
// Distance from origin → opacity (quadratic falloff).
export default function Honeycomb() {
  const s = 28
  const rows = 14
  const cols = 22
  const w = s * Math.sqrt(3)
  const h = s * 1.5
  const cells: { x: number; y: number; o: number }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * w + (r % 2 ? w / 2 : 0)
      const y = r * h
      const dx = cols * w - x
      const dy = rows * h - y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const max = Math.sqrt((cols * w) ** 2 + (rows * h) ** 2)
      const o = Math.max(0, 0.18 - (dist / max) ** 2 * 0.18)
      if (o > 0.005) cells.push({ x, y, o })
    }
  }
  const points = (cx: number, cy: number) =>
    [0, 60, 120, 180, 240, 300]
      .map((deg) => {
        const a = ((deg - 30) * Math.PI) / 180
        return `${cx + s * Math.cos(a)},${cy + s * Math.sin(a)}`
      })
      .join(' ')
  return (
    <svg
      className="honeycomb"
      viewBox={`0 0 ${cols * w} ${rows * h}`}
      preserveAspectRatio="xMaxYMax meet"
      aria-hidden
    >
      {cells.map((cell, i) => (
        <polygon
          key={i}
          points={points(cell.x, cell.y)}
          fill="var(--accent)"
          fillOpacity={cell.o * 0.6}
          stroke="var(--accent)"
          strokeOpacity={cell.o}
          strokeWidth={0.5}
        />
      ))}
    </svg>
  )
}
