import { Handle, Position } from '@xyflow/react'
import StatusBadge from './StatusBadge'
import { formatDuration, isReplayInput, spanError, spanLabel } from '../traceUtils'

export default function SpanNode({ data, selected }) {
  const error = spanError(data)
  const problematic = error != null || ['FAILED', 'ERROR', 'LOOP_DETECTED'].includes(data.status)
  const colors = { orchestrator: 'var(--accent-blue)', researcher: 'var(--accent-purple)', writer: 'var(--accent-green)', critic: 'var(--accent-yellow)' }
  return <div className={`span-node ${selected ? 'is-selected' : ''} ${problematic ? 'has-error' : ''}`} style={{ '--agent-color': colors[data.agent_name] || 'var(--text-muted)' }}>
    <Handle type="target" position={Position.Top}/>
    <div className="span-node-agent"><span className="agent-marker"/>{data.agent_name || 'Agent not recorded'}</div>
    <div className="span-node-name" title={spanLabel(data)}>{spanLabel(data)}</div>
    <div className="span-node-footer">{isReplayInput(data) ? <><span>Replay boundary</span><span>No model call</span></> : <><StatusBadge status={data.status} emptyLabel="Not recorded"/><span>{formatDuration(data.latency_ms)}</span></>}</div>
    {problematic && <div className="span-node-error">{error != null ? 'Error details recorded' : data.status.replaceAll('_', ' ').toLowerCase()}</div>}
    <Handle type="source" position={Position.Bottom}/>
  </div>
}
