// Integer count ticks with 1/2/5 intervals; a single execution uses only 0 and 1.
export function traceCountScale(counts) {
  const max = Math.max(0, ...counts.map(Number).filter(Number.isFinite))
  if (max <= 1) return { ceiling: 1, ticks: [1, 0] }
  const rawStep = max / 3
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const step = Math.max(1, [1, 2, 5, 10].find(n => n * magnitude >= rawStep) * magnitude)
  const ceiling = Math.ceil(max / step) * step
  return { ceiling, ticks: Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => ceiling - i * step) }
}
