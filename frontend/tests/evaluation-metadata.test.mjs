import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluationMetadata, latestEvaluations } from '../src/evaluationMetadata.js'

test('versioned feedback is decoded and legacy feedback remains readable',()=>{
  assert.equal(evaluationMetadata({feedback:'Original explanation'}).rubric,'legacy (unversioned)')
  assert.equal(evaluationMetadata({feedback:'Original explanation'}).summary,'Original explanation')
  const feedback='[swt-eval:role-v2] '+JSON.stringify({summary:'Evidence checks passed',method:'deterministic',criteria:[]})
  assert.equal(evaluationMetadata({feedback}).rubric,'role-v2')
  assert.equal(evaluationMetadata({feedback}).method,'deterministic')
  assert.equal(evaluationMetadata({feedback:'[swt-eval:role-v2] malformed'}).summary,'[swt-eval:role-v2] malformed')
})

test('latest per-span assessment does not mutate or discard historical records',()=>{
  const history=[{eval_id:'old',span_id:'a',overall:1.33},{eval_id:'other',span_id:'b',overall:8},{eval_id:'new',span_id:'a',overall:10}]
  const snapshot=JSON.stringify(history)
  const latest=latestEvaluations(history)
  assert.equal(latest.length,2)
  assert.equal(latest.find(row=>row.span_id==='a').eval_id,'new')
  assert.equal(JSON.stringify(history),snapshot)
})
