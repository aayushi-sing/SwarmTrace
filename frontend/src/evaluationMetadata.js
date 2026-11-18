export function evaluationMetadata(evaluation) {
  const feedback = evaluation?.feedback || ''
  const match = feedback.match(/^\[swt-eval:([^\]]+)\] /)
  if (match) {
    try {
      const data = JSON.parse(feedback.slice(match[0].length))
      return { ...data, rubric: match[1] }
    } catch { /* Keep malformed metadata readable as ordinary feedback. */ }
  }
  return { rubric: 'legacy (unversioned)', summary: feedback, method: 'llm' }
}

export function latestEvaluations(evaluations) {
  const latest = new Map()
  for (const evaluation of evaluations) latest.set(evaluation.span_id, evaluation)
  return [...latest.values()]
}
