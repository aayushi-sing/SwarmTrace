import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getTrace, evaluateTrace, getEvaluations, createSpanSocket } from '../api/client'
import SpanTree from '../components/SpanTree'
import ReplayPanel from '../components/ReplayPanel'
import SpanInspector from '../components/SpanInspector'
import EvaluationPanel from '../components/EvaluationPanel'
import StatusBadge from '../components/StatusBadge'
import Icon from '../components/Icon'
import { CopyButton } from '../components/JsonPanel'
import { flattenSpans, formatCost, formatDuration, formatTime, mergeSpan, spanLabel } from '../traceUtils'
import '../trace-detail.css'
import { latestEvaluations } from '../evaluationMetadata'

const errorMessage = e => {
  const detail = e.response?.data?.detail || e.message
  return typeof detail === 'string' ? detail : JSON.stringify(detail)
}

export default function TraceDetail() {
  const { traceId } = useParams()
  return <TraceWorkspace key={traceId} traceId={traceId}/>
}

function TraceWorkspace({ traceId }) {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedSpanId, setSelectedSpanId] = useState(null)
  const [tab, setTab] = useState('details')
  const [evaluations, setEvaluations] = useState([])
  const [selectedEvaluationId, setSelectedEvaluationId] = useState(null)
  const [evalLoading, setEvalLoading] = useState(false)
  const [evalFetching, setEvalFetching] = useState(true)
  const [evalError, setEvalError] = useState(null)
  const [evaluated, setEvaluated] = useState(false)
  const [connected, setConnected] = useState(false)
  const traceVersion = useRef(0)
  const evalVersion = useRef(0)
  const replayTimer = useRef(null)
  const streamedSpans = useRef(new Map())

  const fetchTrace = useCallback(() => {
    const version = ++traceVersion.current
    setLoading(true)
    setError(null)
    getTrace(traceId).then(r => {
      if (version !== traceVersion.current) return
      let tree = r.data.span_tree
      for (const span of streamedSpans.current.values()) tree = mergeSpan(tree, span)
      setData({ ...r.data, span_tree: tree })
    }).catch(e => { if (version === traceVersion.current) setError(errorMessage(e)) })
      .finally(() => { if (version === traceVersion.current) setLoading(false) })
  }, [traceId])

  const fetchEvaluations = useCallback(() => {
    const version = ++evalVersion.current
    setEvalFetching(true)
    setEvalError(null)
    getEvaluations(traceId).then(r => {
      if (version !== evalVersion.current) return
      setEvaluations(r.data)
      setSelectedEvaluationId(null)
      setEvaluated(r.data.length > 0)
    }).catch(e => { if (version === evalVersion.current) setEvalError(errorMessage(e)) })
      .finally(() => { if (version === evalVersion.current) setEvalFetching(false) })
  }, [traceId])

  useEffect(() => {
    fetchTrace()
    fetchEvaluations()
    return () => { traceVersion.current++; evalVersion.current++; clearTimeout(replayTimer.current) }
  }, [fetchTrace, fetchEvaluations])

  useEffect(() => {
    const ws = createSpanSocket(traceId, span => {
      if (!span?.span_id || span.trace_id !== traceId) return
      streamedSpans.current.set(span.span_id, span)
      setData(previous => previous ? { ...previous, span_tree: mergeSpan(previous.span_tree, span) } : previous)
    })
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)
    return () => { ws.onopen = null; ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close() }
  }, [traceId])

  async function handleEvaluate() {
    if (evalLoading) return
    const version = ++evalVersion.current
    setEvalLoading(true)
    setEvalFetching(false)
    setEvalError(null)
    try {
      await evaluateTrace(traceId)
      const r = await getEvaluations(traceId)
      if (version !== evalVersion.current) return
      setEvaluations(r.data)
      setSelectedEvaluationId(null)
      setEvaluated(true)
    } catch (e) { if (version === evalVersion.current) setEvalError(errorMessage(e)) }
    finally { if (version === evalVersion.current) setEvalLoading(false) }
  }

  const spans = useMemo(() => flattenSpans(data?.span_tree || []), [data?.span_tree])
  const selectedSpan = spans.find(span => span.span_id === selectedSpanId)
  const latestResults = useMemo(() => latestEvaluations(evaluations), [evaluations])
  const evaluationHistory = evaluations.filter(e => e.span_id === selectedSpanId)
  const selectedEval = evaluationHistory.find(e => e.eval_id === selectedEvaluationId) || evaluationHistory.at(-1)
  function selectSpan(span) { setSelectedSpanId(span.span_id) }
  function handleReplayDone(forkedId) {
    clearTimeout(replayTimer.current)
    replayTimer.current = setTimeout(() => navigate(`/trace/${forkedId}`), 1500)
  }

  if (!data) return <div className="trace-page"><Link className="back-link" to="/">← Overview</Link><div className="panel empty-state" role={error ? 'alert' : 'status'}><h1>{error ? 'Unable to load trace' : 'Loading trace…'}</h1><p>{error || 'Fetching execution and span data.'}</p>{error && <button className="button" onClick={fetchTrace}>Try again</button>}</div></div>
  const { trace, span_tree } = data
  return <div className="trace-page">
    <Link className="back-link" to="/">← Overview</Link>
    <header className="trace-heading"><div><div className="eyebrow">EXECUTION INVESTIGATION</div><h1>Trace detail</h1><div className="trace-identity"><code>{trace.trace_id || traceId}</code><CopyButton value={trace.trace_id || traceId} label="trace ID"/><StatusBadge status={trace.status}/></div></div><div className="trace-actions"><button className="button" onClick={fetchTrace} disabled={loading}><Icon name="refresh" size={14}/>{loading ? 'Refreshing…' : 'Refresh'}</button><button className="button primary" onClick={handleEvaluate} disabled={evalLoading}>{evalLoading ? 'Evaluating…' : evaluated ? 'Re-evaluate trace' : 'Evaluate trace'}</button></div></header>
    <dl className="trace-facts"><div><dt>Root agent</dt><dd>{trace.root_agent || 'Not recorded'}</dd></div><div><dt>Total duration</dt><dd>{formatDuration(trace.total_latency_ms)}</dd></div><div><dt>Estimated cost</dt><dd>{formatCost(trace.total_cost_usd)}</dd></div><div><dt>Recorded at</dt><dd>{formatTime(trace.created_at)}</dd></div></dl>
    {trace.parent_trace_id && <div className="trace-relationship"><span>Forked from</span><Link to={`/trace/${trace.parent_trace_id}`} className="parent-trace-link">{trace.parent_trace_id}</Link><Link className="compare-parent-link" to={`/diff/${trace.parent_trace_id}/${traceId}`}>Compare with parent →</Link></div>}
    {error && <div className="operation-error" role="alert">Could not refresh trace: {error}</div>}
    {evalError && <div className="operation-error" role="alert">Evaluation: {evalError}<button className="button" onClick={fetchEvaluations} disabled={evalLoading || evalFetching}>Reload results</button></div>}
    <div className="evaluation-summary" aria-live="polite"><span>{evalLoading ? 'Evaluation in progress…' : evalFetching ? 'Loading evaluations…' : evaluated ? `${latestResults.length} evaluated span${latestResults.length === 1 ? '' : 's'}` : 'No evaluations recorded'}</span>{latestResults.map(e => <button key={e.span_id} className="evaluation-chip" onClick={() => { setSelectedSpanId(e.span_id); setSelectedEvaluationId(null); setTab('evaluation') }}><span>{e.agent_name || e.span_id}</span><strong>{e.verdict === 'ERROR' ? 'Unscored' : e.overall != null ? `${Number(e.overall).toFixed(1)}/10` : 'Unscored'}</strong><span className={`verdict ${e.verdict === 'PASS' ? 'pass' : 'fail'}`}>{e.verdict}</span></button>)}</div>
    <div className="investigation-layout">
      <section className="panel execution-panel" aria-labelledby="execution-title"><div className="panel-heading"><div><div className="section-title"><h2 id="execution-title">Execution hierarchy</h2><span className="count-badge">{spans.length} spans</span></div><p>Select a node to inspect payloads, replay, or evaluate.</p></div><span className={`connection ${connected ? 'connected' : ''}`} role="status"><span className="status-dot"/>{connected ? 'Span stream live' : 'Span stream offline'}</span></div>
        {span_tree.length ? <SpanTree spans={span_tree} selectedSpanId={selectedSpanId} onNodeClick={selectSpan}/> : <div className="empty-state"><Icon name="traces" size={28}/><h3>No spans recorded</h3><p>{trace.status === 'RUNNING' ? 'Waiting for recorded spans from this execution.' : 'This trace has no recorded span data.'}</p></div>}
        <div className="span-picker"><label htmlFor="span-picker">Inspect span</label><select id="span-picker" value={selectedSpanId || ''} onChange={e => setSelectedSpanId(e.target.value || null)}><option value="">Select a span…</option>{spans.map(span => <option key={span.span_id} value={span.span_id}>{span.agent_name || 'Agent'} · {spanLabel(span)} · {span.span_id.slice(0, 8)}</option>)}</select></div>
        <p className="execution-note">Connections show parent-child relationships. Span status and timing are shown only when recorded.</p>
      </section>
      <aside className="panel inspector-panel" aria-label="Span inspector"><div className="panel-heading"><h2>Span inspector</h2>{selectedSpan && <span className="muted mono">{selectedSpan.agent_name}</span>}</div>{selectedSpan ? <>
        <div className="inspector-tabs" role="tablist" aria-label="Span inspection views">{['details', 'replay', 'evaluation'].map((name, i) => <button key={name} id={`tab-${name}`} role="tab" aria-selected={tab === name} aria-controls={`panel-${name}`} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)} onKeyDown={event => { const names = ['details', 'replay', 'evaluation']; const next = event.key === 'ArrowRight' ? names[(i + 1) % 3] : event.key === 'ArrowLeft' ? names[(i + 2) % 3] : event.key === 'Home' ? names[0] : event.key === 'End' ? names[2] : null; if (next) { event.preventDefault(); setTab(next); document.getElementById(`tab-${next}`)?.focus() } }}>{name}</button>)}</div>
        <div className="inspector-content" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
          {tab === 'details' && <SpanInspector span={selectedSpan}/>}
          <div hidden={tab !== 'replay'}><ReplayPanel key={selectedSpan.span_id} span={selectedSpan} traceId={traceId} parentTraceId={trace.parent_trace_id} onReplayDone={handleReplayDone}/></div>
          {tab === 'evaluation' && <EvaluationPanel span={selectedSpan} evaluation={selectedEval} history={evaluationHistory} onSelectEvaluation={setSelectedEvaluationId} loading={evalLoading} error={evalError} evaluated={evaluated} onEvaluate={handleEvaluate}/>}
        </div>
      </> : <div className="inspector-empty"><Icon name="search" size={25}/><h3>Select a span</h3><p>Choose a node in the execution hierarchy or use the span selector to inspect its input, output, tokens, and cost.</p></div>}</aside>
    </div>
  </div>
}
