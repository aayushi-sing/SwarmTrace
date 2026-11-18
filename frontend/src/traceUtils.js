export const isReplayInput = span => span.span_type === 'REPLAY_INPUT'
export const spanLabel = span => isReplayInput(span) ? ({ overridden: 'Overridden replay input', reused: 'Reused replay input' }[span.input_payload?.replay?.mode] || 'Replay input') : span.span_name || span.name || span.span_type?.replaceAll('_', ' ').toLowerCase() || 'Unnamed span'
export const spanError = span => span.error ?? span.error_details ?? span.output_payload?.error ?? null
export const formatDuration = value => value == null ? 'Not recorded' : `${Number(value).toLocaleString()} ms`
export const formatCost = value => value == null ? 'Not recorded' : `$${Number(value).toFixed(6)}`
export function formatTime(value) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}
export function flattenSpans(spans) {
  return spans.flatMap(span => [span, ...flattenSpans(span.children || [])])
}

// Attach stream updates by ID, including children that arrive before a parent.
export function mergeSpan(spans, incoming) {
  const records = new Map(flattenSpans(spans).map(span => [span.span_id, span]))
  records.set(incoming.span_id, { ...records.get(incoming.span_id), ...incoming })
  const copies = new Map([...records].map(([id, span]) => [id, { ...span, children: [] }]))
  const roots = []
  for (const span of copies.values()) {
    const parent = copies.get(span.parent_span_id)
    if (parent && parent !== span) parent.children.push(span)
    else roots.push(span)
  }
  return roots
}

// Leaves occupy distinct columns; parents are centered over their children.
export function layoutSpans(spans) {
  const nodes = []
  const edges = []
  let column = 0
  function visit(span, depth, parentId) {
    const children = span.children || []
    const positions = children.map(child => visit(child, depth + 1, span.span_id))
    const x = positions.length ? (positions[0] + positions.at(-1)) / 2 : column++ * 274
    nodes.push({ id: span.span_id, type: 'spanNode', position: { x, y: depth * 194 }, data: span, ariaLabel: `${span.agent_name || 'Agent'}: ${spanLabel(span)}` })
    if (parentId) edges.push({ id: `${parentId}->${span.span_id}`, source: parentId, target: span.span_id, type: 'smoothstep' })
    return x
  }
  spans.forEach(span => { visit(span, 0, null); column += 0.5 })
  return { nodes, edges }
}
