import test from 'node:test'
import assert from 'node:assert/strict'
import { isReplayInput, spanLabel, flattenSpans } from '../src/traceUtils.js'

test('replay boundaries are explicitly distinct from new model reasoning',()=>{
  const span={span_id:'boundary',agent_name:'researcher',span_type:'REPLAY_INPUT',input_payload:{replay:{mode:'overridden',model_executed:false}}}
  assert.equal(isReplayInput(span),true)
  assert.equal(spanLabel(span),'Overridden replay input')
  assert.equal(spanLabel({...span,input_payload:{replay:{mode:'reused'}}}),'Reused replay input')
  assert.equal(spanLabel({...span,input_payload:{}}),'Replay input')
  assert.equal(isReplayInput({span_type:'AGENT_REASONING'}),false)
  const tree=[{...span,children:[{span_id:'handoff',span_type:'HANDOFF',children:[{span_id:'writer',span_type:'AGENT_REASONING'}]}]}]
  assert.deepEqual(flattenSpans(tree).map(row=>row.span_id),['boundary','handoff','writer'])
})
