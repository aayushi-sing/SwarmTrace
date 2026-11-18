import { useEffect, useState, useCallback, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { getTraces, getProjects, getMetrics, createTraceSocket } from '../api/client'
import Icon from '../components/Icon'
import StatusBadge from '../components/StatusBadge'
import { traceCountScale } from '../chartScale'

function Dashboard({ metrics, error }) {
  const summary = metrics?.summary
  const daily = metrics?.daily || []
  const { ceiling, ticks } = traceCountScale(daily.map(d => d.count))
  const hasActivity = daily.some(d => Number(d.count) > 0)
  const values = [
    ['Total traces', summary?.total_traces?.toLocaleString() ?? '—', summary ? `${summary.running ?? 0} currently running` : 'Awaiting metrics'],
    ['Success rate', summary?.success_rate != null ? `${summary.success_rate}%` : '—', summary ? `${summary.failed ?? 0} failed · ${summary.loops ?? 0} loops` : 'Awaiting metrics'],
    ['Average latency', summary?.avg_latency_ms != null ? `${Number(summary.avg_latency_ms).toLocaleString()} ms` : '—', 'Across project traces'],
    ['Estimated total cost', summary?.total_cost_usd != null ? `$${Number(summary.total_cost_usd).toFixed(4)}` : '—', 'Based on model token usage'],
  ]
  return <>
    {error && <div className="notice" role="alert">Metrics unavailable: {error}</div>}
    <section className="metrics-grid" aria-label="Project metrics" aria-busy={!metrics && !error}>
      {values.map(([label, value, sub]) => <div className="metric" key={label}><h2>{label}</h2><div className="metric-value">{value}</div><p>{sub}</p></div>)}
    </section>
    <section className="panel activity-panel" aria-labelledby="activity-title">
      <div className="panel-heading"><div><h2 id="activity-title">Trace activity</h2><p>Execution volume over the last seven days</p></div><span className="period-label">Last 7 days</span></div>
      {hasActivity ? <div className="activity-chart" role="img" aria-label={daily.map(d => `${d.day}: ${d.count} traces`).join('; ')}>
        <div className="chart-scale">{ticks.map(tick => <span key={tick}>{tick.toLocaleString()}</span>)}</div>
        <div className="chart-bars" style={{ '--grid-step': `${100 / (ticks.length - 1)}%` }}>{daily.map(d => <div className="chart-column" key={d.day}>
          <div className="bar-track"><div className="chart-bar" style={{ height: `${Number(d.count) / ceiling * 100}%` }} title={`${d.day}: ${d.count} traces`}/></div>
          <span className="chart-date">{new Date(`${d.day.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        </div>)}</div>
      </div> : <div className="chart-empty">{error ? 'Activity data unavailable' : metrics ? 'No trace activity in this period' : 'Loading activity…'}</div>}
    </section>
  </>
}

export default function TraceList() {
  const { hash } = useLocation()
  const exploration = hash === '#traces'
  const [traces, setTraces] = useState([])
  const [projects, setProjects] = useState([])
  const [projectsResolved, setProjectsResolved] = useState(false)
  const [metrics, setMetrics] = useState(null)
  const [activeProject, setActive] = useState(() => localStorage.getItem('swt_project') || '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [projectError, setProjectError] = useState(null)
  const [metricsError, setMetricsError] = useState(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatus] = useState('')
  const [agentFilter, setAgent] = useState('')
  const traceRequest = useRef(0)
  const metricRequest = useRef(0)

  useEffect(() => {
    let cancelled = false
    getProjects().then(r => {
      if (cancelled) return
      setProjects(r.data)
      const saved = localStorage.getItem('swt_project')
      if (saved && !r.data.some(p => p.project_id === saved)) {
        const first = r.data[0]?.project_id || ''
        setActive(first)
        localStorage.setItem('swt_project', first)
      } else if (saved === null && r.data.length) {
        setActive(r.data[0].project_id)
        localStorage.setItem('swt_project', r.data[0].project_id)
      }
      setProjectsResolved(true)
    }).catch(e => { if (!cancelled) { setProjectError(e.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  const fetchTraces = useCallback(() => {
    if (!projectsResolved) return
    const request = ++traceRequest.current
    setLoading(true)
    setError(null)
    const params = {}
    if (activeProject) params.project_id = activeProject
    if (exploration && search) params.search = search
    if (exploration && statusFilter) params.status = statusFilter
    if (exploration && agentFilter) params.root_agent = agentFilter
    getTraces(params).then(r => { if (request === traceRequest.current) setTraces(r.data) })
      .catch(e => { if (request === traceRequest.current) setError(e.message) })
      .finally(() => { if (request === traceRequest.current) setLoading(false) })
  }, [activeProject, search, statusFilter, agentFilter, exploration, projectsResolved])

  const fetchMetrics = useCallback(() => {
    if (exploration || !projectsResolved) return
    const request = ++metricRequest.current
    setMetricsError(null)
    getMetrics(activeProject || null).then(r => { if (request === metricRequest.current) setMetrics(r.data) })
      .catch(e => { if (request === metricRequest.current) { setMetrics(null); setMetricsError(e.message) } })
  }, [activeProject, exploration, projectsResolved])

  useEffect(() => { fetchTraces(); return () => { traceRequest.current++ } }, [fetchTraces])
  useEffect(() => { setMetrics(null); fetchMetrics(); return () => { metricRequest.current++ } }, [fetchMetrics])
  const refreshRef = useRef(null)
  useEffect(() => { refreshRef.current = () => { fetchTraces(); fetchMetrics() } }, [fetchTraces, fetchMetrics])
  useEffect(() => {
    if (!projectsResolved || !projects.length) return
    const ws = createTraceSocket(msg => { if (msg.type === 'TRACE_UPDATE') refreshRef.current?.() }, activeProject, () => setWsConnected(true))
    ws.onclose = () => setWsConnected(false)
    ws.onerror = () => setWsConnected(false)
    return () => { ws.onopen = null; ws.onclose = null; ws.onerror = null; ws.close(); setWsConnected(false) }
  }, [projectsResolved, projects.length, activeProject])

  function handleProjectChange(projectId) {
    setActive(projectId)
    localStorage.setItem('swt_project', projectId)
  }
  const activeProjectName = projects.find(p => p.project_id === activeProject)?.name || 'All projects'
  const filtered = exploration && (search || statusFilter || agentFilter)
  const visibleTraces = exploration ? traces : traces.slice(0, 5)
  return <div className="overview-page">
    {projectsResolved && projects.length === 0 && <div className="notice">You have no projects yet. <Link to="/settings">Create a project in Settings</Link> to start collecting traces.</div>}
    <div className="page-heading"><div><div className="eyebrow">OBSERVABILITY</div><h1>{exploration ? 'Traces' : 'Overview'}</h1><p>{exploration ? 'Search, filter, and investigate agent executions.' : 'Monitor agent executions and review recent runs.'}</p></div><button className="button" onClick={() => refreshRef.current?.()}><Icon name="refresh" size={15}/>Refresh</button></div>
    <div className="project-toolbar"><div className="project-context"><label className="project-selector"><span>Project</span><select aria-label="Active project" value={activeProject} onChange={e => handleProjectChange(e.target.value)}><option value="">All projects</option>{projects.map(p => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}</select></label>{activeProject && <span className="muted project-trace-count">{projects.find(p => p.project_id === activeProject)?.trace_count ?? '—'} traces</span>}</div><span className={`connection ${wsConnected ? 'connected' : ''}`} role="status"><span className="status-dot"/>{wsConnected ? 'Live updates connected' : 'Live updates disconnected'}</span></div>
    {projectError && <div className="notice" role="alert">Could not load projects: {projectError}</div>}
    {!exploration && <Dashboard metrics={metrics} error={metricsError}/>}
    <section className="panel traces-panel" id="traces" aria-labelledby="traces-title">
      <div className="panel-heading"><div><div className="section-title"><h2 id="traces-title">{exploration ? 'Trace explorer' : 'Recent traces'}</h2><span className="count-badge">{visibleTraces.length}</span></div><p>{exploration ? 'Search and filter all executions, newest first.' : 'The latest five executions in this project.'}</p></div>{exploration ? <span className="muted project-caption">{activeProjectName}</span> : <Link className="button quiet" to="/#traces">View all traces<Icon name="arrow" size={13}/></Link>}</div>
      {exploration && <div className="filter-toolbar"><label className="search-field"><Icon name="search" size={16}/><input aria-label="Search trace ID" placeholder="Search trace ID…" value={search} onChange={e => setSearch(e.target.value)}/></label><select aria-label="Filter by status" value={statusFilter} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{['SUCCESS', 'RUNNING', 'FAILED', 'LOOP_DETECTED'].map(s => <option key={s} value={s}>{s.replaceAll('_', ' ').toLowerCase()}</option>)}</select><select aria-label="Filter by root agent" value={agentFilter} onChange={e => setAgent(e.target.value)}><option value="">All agents</option>{['orchestrator', 'researcher', 'writer', 'critic'].map(a => <option key={a} value={a}>{a}</option>)}</select>{filtered && <button className="button quiet" onClick={() => { setSearch(''); setStatus(''); setAgent('') }}>Clear filters</button>}</div>}
      {error ? <div className="empty-state" role="alert"><h3>Unable to load traces</h3><p>{error}. Check the backend connection and try again.</p><button className="button" onClick={fetchTraces}>Try again</button></div> : <>
        {loading && <div className="loading-line" role="status">Updating traces…</div>}
        {!loading && !traces.length ? <div className="empty-state"><Icon name="traces" size={28}/><h3>{filtered ? 'No matching traces' : 'No executions yet'}</h3><p>{filtered ? 'Adjust your search or filters to find an agent run.' : "Run your agent with this project's API key to see its execution here. Manage projects and API keys in Settings from the sidebar."}</p></div> : traces.length > 0 && <div className="table-scroll" aria-busy={loading}><table className="trace-table"><thead><tr>{['Trace ID', 'Root agent', 'Status', 'Latency', 'Cost', 'Parent', 'Created'].map(h => <th key={h} className={h === 'Latency' || h === 'Cost' ? 'numeric' : ''} scope="col">{h}</th>)}</tr></thead><tbody>{visibleTraces.map(t => <tr key={t.trace_id}>
          <td><Link className="trace-link mono" to={`/trace/${t.trace_id}`} title={t.trace_id}>{t.trace_id.slice(0, 12)}<span className="muted">…</span></Link></td><td><span className="agent-name"><span className="agent-marker"/>{t.root_agent || '—'}</span></td><td><StatusBadge status={t.status}/></td><td className="numeric mono">{t.total_latency_ms != null ? `${Number(t.total_latency_ms).toLocaleString()} ms` : '—'}</td><td className="numeric mono">{t.total_cost_usd != null ? `$${Number(t.total_cost_usd).toFixed(6)}` : '—'}</td><td className="mono">{t.parent_trace_id ? <Link className="parent-link" title={t.parent_trace_id} to={`/trace/${t.parent_trace_id}`}>{t.parent_trace_id.slice(0, 8)}…</Link> : <span className="muted">—</span>}</td><td className="created-time"><time dateTime={t.created_at}>{new Date(t.created_at).toLocaleString()}</time></td>
        </tr>)}</tbody></table></div>}
      </>}
      <footer className="table-footer"><span>{exploration ? `${traces.length} ${filtered ? 'matching ' : ''}trace${traces.length === 1 ? '' : 's'}` : `Showing ${visibleTraces.length} most recent of ${traces.length} traces`}</span><span>Project-scoped execution data</span></footer>
    </section>
  </div>
}
