// Isolated browser-test data only; these records never enter application sources.
export const investigationId = 'qa-investigation'
export const investigationTrace = {
  trace_id: investigationId, root_agent: 'orchestrator', status: 'SUCCESS',
  total_latency_ms: 320, total_cost_usd: 0.00012, created_at: '2026-11-17T09:00:00Z', parent_trace_id: null,
}
const base = { trace_id: investigationId, created_at: '2026-11-17T09:00:00Z', children: [] }
export const researchSpan = { ...base, span_id: 'span-research', parent_span_id: 'span-root', agent_name: 'researcher', span_type: 'AGENT_REASONING', latency_ms: 120, estimated_cost_usd: 0.000014, token_usage: { prompt_tokens: 8, completion_tokens: 12 }, input_payload: { topic: 'Tracing' }, output_payload: { summary: 'Original research' } }
export const investigationTree = [{ ...base, span_id: 'span-root', parent_span_id: null, agent_name: 'orchestrator', span_type: 'HANDOFF', latency_ms: 0, estimated_cost_usd: 0, token_usage: null, input_payload: { sender: 'orchestrator', receiver: 'researcher' }, output_payload: {}, children: [
  { ...researchSpan, children: [{ ...base, span_id: 'span-tool', parent_span_id: 'span-research', agent_name: 'researcher', span_type: 'TOOL_EXECUTION', latency_ms: 20, estimated_cost_usd: null, token_usage: null, input_payload: { query: 'Tracing' }, output_payload: { sources: ['source-a'] } }] },
  { ...base, span_id: 'span-writer', parent_span_id: 'span-root', agent_name: 'writer', span_type: 'AGENT_REASONING', latency_ms: 0, estimated_cost_usd: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0 }, input_payload: {}, output_payload: { error: 'Provider timed out' } },
] }]
export const investigationEvaluations = [
  { eval_id: 'qa-research-old', span_id: 'span-research', agent_name: 'researcher', relevance: 8, reasoning: 9, quality: 7, overall: 8, verdict: 'PASS', feedback: 'Clear evidence and useful sources.', judge_model: 'fixture-judge' },
  { eval_id: 'qa-writer-old', span_id: 'span-writer', agent_name: 'writer', relevance: 0, reasoning: 0, quality: 0, overall: 0, verdict: 'ERROR', feedback: 'Judge error: provider unavailable', judge_model: 'fixture-judge' },
  { eval_id: 'qa-research-new', span_id: 'span-research', agent_name: 'researcher', relevance: 9, reasoning: 9, quality: 9, overall: 9, verdict: 'PASS', feedback: '[swt-eval:role-v2] ' + JSON.stringify({ rubric: 'role-v2', role: 'researcher', method: 'llm', summary: 'Complete recorded evidence supports the assessment.', context: { bytes: 3100, omitted: false }, unavailable: [] }), judge_model: 'fixture-judge' },
  { eval_id: 'qa-writer-new', span_id: 'span-writer', agent_name: 'writer', relevance: null, reasoning: null, quality: null, overall: null, verdict: 'ERROR', feedback: '[swt-eval:role-v2] ' + JSON.stringify({ rubric: 'role-v2', role: 'writer', method: 'llm', summary: 'Assessment unavailable: missing task evidence.', unavailable: ['Task evidence was not recorded'] }), judge_model: 'fixture-judge' },
]

// UI-only fork fixture: a Writer checkpoint plus freshly executed downstream work.
export const replayForkTree = [{
  span_id: 'qa-boundary', trace_id: 'qa-fork', parent_span_id: null,
  agent_name: 'writer', span_type: 'REPLAY_INPUT', latency_ms: 0,
  token_usage: null, estimated_cost_usd: null,
  input_payload: { replay: { source_trace_id: investigationId, source_span_id: 'span-writer', step_number: 2, mode: 'overridden', model_executed: false } },
  output_payload: { article: 'Plain override' },
  children: [{
    span_id: 'qa-fork-handoff', trace_id: 'qa-fork', parent_span_id: 'qa-boundary',
    agent_name: 'orchestrator', span_type: 'HANDOFF', latency_ms: 0,
    input_payload: { sender: 'writer', receiver: 'critic' }, output_payload: { status: 'handed_off' },
    children: [{ span_id: 'qa-fork-critic', trace_id: 'qa-fork', parent_span_id: 'qa-fork-handoff', agent_name: 'critic', span_type: 'AGENT_REASONING', latency_ms: 50, input_payload: { user: 'Plain override' }, output_payload: { critique: 'Fixture-only review' }, children: [] }],
  }],
}]
