import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { postReplay } from '../api/client'
import JsonPanel from './JsonPanel'

export default function ReplayPanel({ span, traceId, parentTraceId, onReplayDone }) {
  const defaultStep = { researcher: 1, writer: 2, critic: 3 }[span?.agent_name] ?? 1
  const [stepNumber, setStep] = useState(defaultStep)
  const [overrideText, setOverrideText] = useState(() => JSON.stringify(span?.output_payload ?? {}, null, 2))
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  if (!span) return null
  const diffSourceId = parentTraceId || traceId

  async function handleReplay(event) {
    event.preventDefault()
    if (loading) return
    const submittedOverride = overrideText
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      let overrides
      try { overrides = JSON.parse(submittedOverride) } catch { overrides = { raw: submittedOverride } }
      const res = await postReplay({ trace_id: traceId, step_number: stepNumber, overrides })
      if (!mounted.current) return
      setResult(res.data)
      onReplayDone?.(res.data.forked_trace_id)
    } catch (e) {
      if (mounted.current) {
        const detail = e.response?.data?.detail || e.message
        setError(typeof detail === 'string' ? detail : JSON.stringify(detail))
      }
    } finally { if (mounted.current) setLoading(false) }
  }

  return <div className="replay-panel">
    <h3>Fork & replay</h3><p className="help-text">Override the selected span’s output and resume the workflow from a saved step. The original run is preserved.</p>
    <JsonPanel title="Input (read-only)" value={span.input_payload}/>
    <form onSubmit={handleReplay}>
      <label className="replay-field"><span>Workflow step</span><select aria-label="Replay step" value={stepNumber} onChange={e => { setStep(Number(e.target.value)); setResult(null) }} disabled={loading}><option value={1}>1 · Researcher</option><option value={2}>2 · Writer</option><option value={3}>3 · Critic</option></select></label>
      <p className="help-text">Defaults to the selected agent’s step. A saved snapshot must exist for the chosen step.</p>
      <label className="replay-field"><span>Output override</span><textarea aria-label="Output override" value={overrideText} onChange={e => setOverrideText(e.target.value)} rows={9} spellCheck={false}/></label>
      <p className="help-text">JSON is sent as structured overrides. Plain text is sent in the existing raw field.</p>
      <button className="button primary replay-submit" type="submit" disabled={loading}>{loading ? 'Replaying…' : 'Fork & replay from this step'}</button>
    </form>
    {loading && <p className="operation-status" role="status">Replaying the workflow. Waiting for the server… Edits remain available and apply to your next submission.</p>}
    {result && <div className="replay-result" role="status"><h3>Fork created</h3><code>{result.forked_trace_id}</code><p>Forked from step {result.forked_from_step}. Opening the forked trace…</p><div className="result-actions"><Link className="button" to={`/trace/${result.forked_trace_id}`}>Open fork</Link><Link className="button" to={`/diff/${diffSourceId}/${result.forked_trace_id}`}>Compare runs</Link></div></div>}
    {error && <div className="operation-error" role="alert"><strong>Replay failed</strong><p>{error}</p></div>}
  </div>
}
