export default function StatusBadge({ status, emptyLabel = 'Unknown' }) {
  const tone = { SUCCESS: 'success', RUNNING: 'running', FAILED: 'failed', ERROR: 'failed', LOOP_DETECTED: 'warning' }[status] || 'neutral'
  return <span className={`status-badge ${tone}`}><span className="status-dot"/>{status?.replaceAll('_', ' ').toLowerCase() || emptyLabel}</span>
}
