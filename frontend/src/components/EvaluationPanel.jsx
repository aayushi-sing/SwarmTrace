import JsonPanel from './JsonPanel'
import { evaluationMetadata } from '../evaluationMetadata'

export function EvaluationResult({ evaluation }) {
  const failed = evaluation.verdict === 'ERROR'
  const metadata = evaluationMetadata(evaluation)
  return <div className="evaluation-result">
    <div className="result-heading"><h3>{metadata.method === 'deterministic' ? 'Workflow assessment' : 'Judge assessment'}</h3><span className={`verdict ${evaluation.verdict === 'PASS' ? 'pass' : 'fail'}`}>{evaluation.verdict || 'Not recorded'}</span></div>
    <p className="rubric-label">Rubric: <strong>{metadata.rubric}</strong>{metadata.method === 'deterministic' ? ' · Recorded-evidence checks' : ''}</p>
    <dl className="judge-scores">{['relevance', 'reasoning', 'quality', 'overall'].map(label => <div key={label}><dt>{label}</dt><dd>{(failed && metadata.rubric === 'legacy (unversioned)') || evaluation[label] == null ? 'Unscored' : <>{Number(evaluation[label]).toFixed(1)}<span> / 10</span></>}</dd></div>)}</dl>
    {metadata.summary && <p className={failed ? 'evaluation-error' : 'judge-feedback'}>{metadata.summary}</p>}
    {metadata.criteria?.map(criterion => <div className="workflow-criterion" key={criterion.criterion}><strong>{criterion.criterion.replaceAll('_', ' ')}</strong><span>{criterion.state}</span><p>{criterion.evidence}</p></div>)}
    {metadata.unavailable?.length > 0 && <p className="help-text">Unavailable: {metadata.unavailable.join('; ')}</p>}
    {metadata.context && <p className="help-text">Full payload context · {metadata.context.bytes?.toLocaleString()} bytes · no content omitted</p>}
    <p className="judge-model">{metadata.method === 'deterministic' ? 'Evaluator' : 'Judge model'}: <code>{evaluation.judge_model || 'Not recorded'}</code></p>
  </div>
}

export default function EvaluationPanel({ span, evaluation, history = [], onSelectEvaluation, loading, error, evaluated, onEvaluate }) {
  return <div className="evaluation-panel">
    <h3>Evaluate execution</h3><p className="help-text">Run the current role-specific rubric. New assessments are appended; historical scores and errors are preserved. Completed assessments for the current rubric are kept.</p>
    <button className="button primary" onClick={onEvaluate} disabled={loading}>{loading ? 'Evaluating…' : evaluated ? 'Re-evaluate trace' : 'Evaluate trace'}</button>
    <p className="operation-status" role="status">{loading ? 'Waiting for judge results…' : ''}</p>
    {error && <div className="operation-error" role="alert">{error}</div>}
    {history.length > 1 && <label className="evaluation-history">Assessment history<select aria-label="Assessment history" value={evaluation?.eval_id || ''} onChange={event => onSelectEvaluation?.(event.target.value)}>{[...history].reverse().map((item, index) => <option key={item.eval_id} value={item.eval_id}>{evaluationMetadata(item).rubric} · {item.verdict} · {item.created_at ? new Date(item.created_at).toLocaleString() : `assessment ${history.length - index}`}</option>)}</select></label>}
    {evaluation ? <EvaluationResult evaluation={evaluation}/> : <div className="inspector-empty"><h3>{loading ? 'Evaluation in progress' : 'No evaluation for this span'}</h3><p>{span.span_type !== 'AGENT_REASONING' ? 'The judge evaluates agent reasoning spans. Tool and handoff spans may have no evaluation.' : 'Run an evaluation to inspect the judge’s scores and feedback.'}</p></div>}
    {span.judge_scores && <JsonPanel title="Recorded judge scores" value={span.judge_scores}/>}
  </div>
}
