import StatusBadge from './StatusBadge'
import { Link } from 'react-router-dom'
import JsonPanel, { CopyButton } from './JsonPanel'
import { formatCost, formatDuration, formatTime, isReplayInput, spanError, spanLabel } from '../traceUtils'

export default function SpanInspector({ span }) {
  const replay = isReplayInput(span) ? span.input_payload?.replay : null
  const fields = [
    ['Agent', span.agent_name || 'Not recorded'],
    ['Duration', replay ? 'Not applicable — no model execution' : formatDuration(span.latency_ms)],
    ['Estimated cost', replay ? 'No model call' : formatCost(span.estimated_cost_usd)],
    ['Recorded at', formatTime(span.created_at)],
    ['Start time', formatTime(span.start_time ?? span.started_at)],
    ['End time', formatTime(span.end_time ?? span.ended_at)],
  ]
  return <div className="inspector-details">
    <div className="inspector-title"><span className="eyebrow">SELECTED SPAN</span><h3>{spanLabel(span)}</h3><StatusBadge status={span.status} emptyLabel="Not recorded"/></div>
    <div className="span-identity"><code>{span.span_id}</code><CopyButton value={span.span_id} label="span ID"/></div>
    {replay && <div className="replay-provenance help-text"><p>This is {replay.mode === 'overridden' ? 'overridden' : 'reused'} checkpoint output, not a newly executed {span.agent_name} reasoning span.</p>{replay.source_trace_id && <Link className="parent-link" to={`/trace/${replay.source_trace_id}`}>Source trace: {replay.source_trace_id}</Link>}{replay.source_span_id && <p className="mono">Source span: {replay.source_span_id}</p>}</div>}
    <dl className="span-facts">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {span.parent_span_id && <div className="parent-span-id"><span>Parent span</span><code>{span.parent_span_id}</code></div>}
    <JsonPanel title="Input" value={span.input_payload}/>
    <JsonPanel title="Output" value={span.output_payload}/>
    <JsonPanel title="Error details" value={spanError(span)} empty="No error details recorded"/>
    <JsonPanel title="Token usage" value={span.token_usage} empty={replay ? 'Not applicable — no model execution' : 'Not recorded'}/>
    <JsonPanel title="Metadata" value={span.metadata}/>
  </div>
}
