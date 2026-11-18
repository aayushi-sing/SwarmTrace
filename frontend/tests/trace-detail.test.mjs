import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutSpans, mergeSpan, flattenSpans, formatCost, formatDuration, formatTime, spanLabel, spanError } from '../src/traceUtils.js'

test('graph preserves real hierarchy, centers parents, and spaces sibling subtrees', () => {
  const tree = [{ span_id: 'root', children: [{ span_id: 'a', parent_span_id: 'root', children: [{ span_id: 'leaf', parent_span_id: 'a' }] }, { span_id: 'b', parent_span_id: 'root' }] }]
  const { nodes, edges } = layoutSpans(tree)
  const position = id => nodes.find(n => n.id === id).position
  assert.equal(nodes.length, 4)
  assert.equal(edges.length, 3)
  assert.deepEqual(edges.map(e => [e.source,e.target]), [['a','leaf'],['root','a'],['root','b']])
  assert.equal(position('root').x, (position('a').x + position('b').x) / 2)
  assert.ok(position('leaf').y > position('a').y)
  assert.ok(position('b').x - position('a').x >= 274)
  assert.equal(nodes[0].data.status, undefined)
})

test('streamed spans attach out-of-order parents and deduplicate updates', () => {
  let tree = mergeSpan([], { span_id: 'child', parent_span_id: 'parent', output_payload: { result: 1 } })
  tree = mergeSpan(tree, { span_id: 'parent', parent_span_id: null })
  tree = mergeSpan(tree, { span_id: 'child', parent_span_id: 'parent', output_payload: { result: 2 } })
  assert.equal(tree.length, 1)
  assert.equal(tree[0].children.length, 1)
  assert.equal(flattenSpans(tree).length, 2)
  assert.equal(tree[0].children[0].output_payload.result, 2)
  assert.equal(tree[0].status, undefined)
})

test('display helpers retain zero values and leave unavailable information explicit', () => {
  assert.equal(formatDuration(0), '0 ms')
  assert.equal(formatCost(0), '$0.000000')
  assert.equal(formatDuration(null), 'Not recorded')
  assert.equal(formatTime(undefined), 'Not recorded')
  assert.equal(spanLabel({ span_type: 'TOOL_EXECUTION' }), 'tool execution')
  assert.equal(spanLabel({ span_name: 'Fetch sources', span_type: 'TOOL_EXECUTION' }), 'Fetch sources')
  assert.equal(spanError({ output_payload: { error: 'Tool timeout' } }), 'Tool timeout')
  assert.equal(spanError({ output_payload: {} }), null)
})
