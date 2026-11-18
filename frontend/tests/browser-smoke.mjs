// Browser QA only. API fixtures never enter application code or persisted app data.
// Run against the local Vite server: node tests/browser-smoke.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { investigationId, investigationTrace, investigationTree, investigationEvaluations, researchSpan, replayForkTree } from './fixtures/trace-detail.mjs'
const profile = mkdtempSync(join(tmpdir(), 'swarmtrace-qa-'))
const executable = process.env.EDGE_PATH || (process.argv.includes('--chrome') ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9237', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
let ws
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const pending = new Map()
let sequence = 0
const requests = []
const exceptions = []
let activityCount = 1
let evaluationRan = false
let evaluationFails = false
let replayFails = false
let replayPayload
let replayDelay = 0
let authFailure = false
let authNetworkFailure = false
let authDelay = 0
let authProfile = null
let protectedFailure = false
let emptyProjects = false
let projectDelay = 0
let projectsPending = 0
const authSubmissions = []
function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10000)
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result) }, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
async function until(expression) {
  for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await delay(100) }
  console.log(await evaluate(`JSON.stringify({url:location.href,text:document.body?.innerText?.slice(0,1800)})`)); console.log("Requests", requests.map(u=>u.pathname), "Exceptions", exceptions); throw new Error(`Timed out: ${expression}`)
}
async function click(selector) {
  await until(`!!document.querySelector(${JSON.stringify(selector)})`)
  return evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function pointerClick(selector) {
  await until(`!!document.querySelector(${JSON.stringify(selector)})`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
  const point = await evaluate(`(() => { const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2} })()`)
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1})
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})
}
async function replaceOverride(text) {
  const selector = 'textarea[aria-label="Output override"]'
  await pointerClick(selector)
  assert.equal(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), true, 'A real click must focus the editable override')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  assert.equal(await evaluate(`(() => { const field=document.querySelector(${JSON.stringify(selector)}); return field.selectionEnd-field.selectionStart === field.value.length })()`), true, 'Ctrl+A must select the whole override')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), '', 'Backspace must clear the controlled value')
  // Send printable keys through Chrome/Edge's real editing path, not DOM setters.
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character, unmodifiedText: character })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
  }
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), text)
}
async function typeAuthField(selector, text) {
  await pointerClick(selector)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await send('Input.insertText', { text })
}
const selectFilter = (label, value) => evaluate(`{ const select = document.querySelector('[aria-label="' + ${JSON.stringify(label)} + '"]'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', {bubbles:true})); }`)
try {
  let target
  for (let i = 0; i < 80; i++) {
    try { target = (await (await fetch('http://127.0.0.1:9237/json/list')).json()).find(t => t.type === 'page'); if (target) break } catch {}
    await delay(100)
  }
  assert.ok(target, 'Edge debugging endpoint did not start')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = async event => {
    const msg = JSON.parse(event.data); if (process.env.QA_DEBUG) console.log(JSON.stringify(msg).slice(0, 600))
    if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p?.reject(new Error(msg.error.message)) : p?.resolve(msg.result); return }
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails.text)
    if (msg.method !== 'Fetch.requestPaused') return
    const { requestId, request } = msg.params
    const url = new URL(request.url)
    requests.push(url)
    if (projectsPending && ['/traces', '/metrics'].includes(url.pathname)) throw new Error('Trace data requested before accessible projects resolved')
    const traces = Array.from({ length: 7 }, (_, i) => ({ trace_id: `qa-trace-${i}`, root_agent: i === 6 ? 'writer' : 'researcher', status: i === 6 ? 'FAILED' : 'SUCCESS', total_latency_ms: 0, total_cost_usd: 0, created_at: '2026-11-17T09:00:00Z' }))
    let data = []
    let responseCode = 200
    if (url.pathname === '/auth/me') data = authProfile || { user_id: 'qa-user', name: 'Browser QA', email: 'qa@example.invalid' }
    if (['/auth/login', '/auth/register'].includes(url.pathname) && request.method === 'POST') {
      if (authNetworkFailure) { await send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }); return }
      const body = JSON.parse(request.postData)
      authSubmissions.push({ path: url.pathname, body })
      if (authDelay) await delay(authDelay)
      if (authFailure) { responseCode = url.pathname === '/auth/register' ? 409 : 401; data = { detail: url.pathname === '/auth/register' ? 'Email already registered' : 'Invalid email or password' } }
      else {
        authProfile = { user_id: 'qa-auth-user', email: body.email, name: body.name || 'Signed-in QA' }
        data = { ...authProfile, access_token: 'qa-auth-token', token_type: 'bearer' }
      }
    }
    if (url.pathname === '/projects') {
      if (projectDelay) { projectsPending++; await delay(projectDelay); projectsPending-- }
      data = emptyProjects ? [] : [{ project_id: 'qa-project', name: 'Research workflow', trace_count: 7 }, { project_id: 'qa-second', name: 'Writing workflow', trace_count: 0 }]
    }
    if (url.pathname === '/metrics') data = { summary: { total_traces: 7, success_rate: 100, avg_latency_ms: 0, total_cost_usd: 0 }, daily: [{ day: '2026-11-17', count: activityCount }] }
    if (url.pathname === '/traces') data = traces.filter(t =>
      (!url.searchParams.get('search') || t.trace_id.includes(url.searchParams.get('search'))) &&
      (!url.searchParams.get('status') || t.status === url.searchParams.get('status')) &&
      (!url.searchParams.get('root_agent') || t.root_agent === url.searchParams.get('root_agent')))
    if (emptyProjects && url.pathname === '/traces') data = []
    if (emptyProjects && url.pathname === '/metrics') data = { summary: { total_traces: 0 }, daily: [] }
    if (url.pathname.startsWith('/trace/')) data = { trace: traces.find(t => t.trace_id === url.pathname.split('/').at(-1)) || traces[0], span_tree: [] }
    if (url.pathname === `/trace/${investigationId}`) data = { trace: investigationTrace, span_tree: investigationTree }
    if (url.pathname === '/trace/qa-fork') data = { trace: { ...investigationTrace, trace_id: 'qa-fork', root_agent: 'writer', parent_trace_id: investigationId }, span_tree: replayForkTree }
    if (url.pathname === `/evaluations/${investigationId}`) data = evaluationRan ? investigationEvaluations : []
    if (url.pathname === `/evaluate/${investigationId}` && request.method === 'POST') {
      if (evaluationFails) { responseCode = 500; data = { detail: 'Judge unavailable' } }
      else { evaluationRan = true; data = { status: 'ok', evaluated: 2 } }
    }
    if (url.pathname === '/replay' && request.method === 'POST') {
      replayPayload = JSON.parse(request.postData)
      if (replayDelay) await delay(replayDelay)
      if (replayFails) { responseCode = 404; data = { detail: 'No snapshot found at this step' } }
      else data = { status: 'ok', original_trace_id: replayPayload.trace_id, forked_trace_id: 'qa-fork', forked_from_step: replayPayload.step_number }
    }
    if (url.pathname.startsWith('/alerts/')) data = null
    if (protectedFailure && url.pathname === '/projects' && request.method === 'GET') { responseCode = 401; data = { detail: 'Session expired' } }
    try {
      await send('Fetch.fulfillRequest', { requestId, responseCode, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' }, { name: 'Access-Control-Allow-Methods', value: 'GET, POST, DELETE, OPTIONS' }], body: Buffer.from(JSON.stringify(data)).toString('base64') })
    } catch (error) {
      // A protected-session redirect can cancel other requests in flight.
      if (!error.message.includes('Invalid InterceptionId')) throw error
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false })
  if (process.argv.includes('--live-demo')) {
    // Real local APIs, no fixtures or seeded browser session. Never create users here.
    await send('Page.navigate', { url: 'http://localhost:5173/login' })
    await until(`!!document.querySelector('.auth-demo')`)
    assert.equal(await evaluate(`localStorage.getItem('swt_token')`), null)
    await pointerClick('.auth-demo')
    await until(`location.pathname === '/' && document.querySelectorAll('.trace-link').length >= 2`)
    assert.equal(await evaluate(`document.querySelector('[aria-label="Active project"]').selectedOptions[0].textContent.includes('SwarmTrace Demo')`), true)
    await click('.trace-link')
    await until(`document.querySelectorAll('.react-flow__node').length === 4`)
    assert.equal(await evaluate(`document.querySelectorAll('.react-flow__edge').length`), 3)
    await click('.span-node')
    await until(`!!document.querySelector('.span-node.is-selected')`)
    await click('button.account')
    await click('.logout-action')
    await until(`location.pathname === '/login'`)
    assert.equal(await evaluate(`localStorage.getItem('swt_token')`), null)
    for (const route of ['/', '/settings', '/trace/private-test']) {
      await send('Page.navigate', { url: 'http://localhost:5173' + route })
      await until(`location.pathname === '/login' && !!document.querySelector('#auth-email')`)
    }
    // Exercise the normal form with the authorized shared account, without logging secrets.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/pages/Login.jsx', import.meta.url), 'utf8')
    const credentials = source.match(/await login\(\{ email: '([^']+)', password: '([^']+)'/)
    await typeAuthField('#auth-email', credentials[1])
    await typeAuthField('#auth-password', credentials[2])
    await pointerClick('.auth-submit')
    await until(`location.pathname === '/' && document.querySelectorAll('.trace-link').length >= 2`)
    await click('button.account')
    await click('.logout-action')
    await until(`location.pathname === '/login'`)
    assert.deepEqual(exceptions, [])
    console.log('PASS: live local backend demo login, scoped preloaded traces, trace graph/selection, logout, protected frontend routes and normal sign-in.')
  } else {
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*' }] })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__qaSockets = [];
    window.WebSocket = class { constructor(url) { this.url = url; this.listeners = {}; window.__qaSockets.push(this); setTimeout(() => { if (!this.closed) { this.listeners.open?.(); this.onopen?.() } }, 0) } addEventListener(event, callback) { this.listeners[event] = callback } send(data) { if (JSON.parse(data).type === 'AUTH') setTimeout(() => this.onmessage?.({data: JSON.stringify({type:'AUTHENTICATED'})}), 0) } close() { this.closed = true; this.onclose?.() } };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__qaClipboard = text } } });
    if (!sessionStorage.getItem('qa-initialized')) {
      localStorage.clear(); localStorage.setItem('swt_token','qa-token');
      sessionStorage.setItem('qa-initialized','true');
    }
  ` })
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
  await until(`document.querySelector('h1')?.textContent === 'Overview' && document.querySelectorAll('.trace-table tbody tr').length === 5`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('a.nav-item')].map(el => el.textContent)`), ['Overview', 'Traces', 'Settings'])
  assert.equal(await evaluate(`document.querySelectorAll('.trace-table').length`), 1)
  assert.equal(await evaluate(`!document.querySelector('[aria-label="Search trace ID"]') && !!document.querySelector('.metrics-grid') && !!document.querySelector('.activity-panel')`), true)
  assert.equal(await evaluate(`document.querySelector('.trace-link').getAttribute('href')`), '/trace/qa-trace-0')
  assert.equal(await evaluate(`document.querySelectorAll('a[href="/settings"]').length`), 1)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Active project"]').selectedOptions[0].textContent`), 'Research workflow')
  await until(`document.querySelectorAll('.chart-scale span').length === 2`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.chart-scale span')].map(e=>e.textContent)`), ['1', '0'])
  activityCount = 0
  await click('.page-heading button')
  await until(`document.querySelector('.chart-empty')?.textContent === 'No trace activity in this period'`)
  activityCount = 1
  await click('.page-heading button')
  await until(`document.querySelectorAll('.chart-scale span').length === 2`)
  await evaluate(`{ const select = document.querySelector('[aria-label="Active project"]'); select.value = 'qa-second'; select.dispatchEvent(new Event('change', {bubbles:true})); }`)
  await until(`localStorage.getItem('swt_project') === 'qa-second'`)
  await delay(150)
  assert.ok(requests.some(url => url.pathname === '/traces' && url.searchParams.get('project_id') === 'qa-second'))
  await evaluate(`{ const select = document.querySelector('[aria-label="Active project"]'); select.value = 'qa-project'; select.dispatchEvent(new Event('change', {bubbles:true})); }`)
  await until(`localStorage.getItem('swt_project') === 'qa-project'`)
  await until(`!document.querySelector('.loading-line') && document.querySelectorAll('.chart-scale span').length === 2`)
  const beforeTracesMetrics = requests.filter(url => url.pathname === '/metrics').length
  await click('a.nav-item[href="/#traces"]')
  await until(`document.querySelector('h1')?.textContent === 'Traces' && document.querySelectorAll('.trace-table tbody tr').length === 7`)
  assert.equal(await evaluate(`!!document.querySelector('.metrics-grid') || !!document.querySelector('.activity-panel')`), false)
  assert.equal(requests.filter(url => url.pathname === '/metrics').length, beforeTracesMetrics, 'Explorer must not fetch hidden dashboard metrics')
  assert.equal(await evaluate(`window.__qaSockets.filter(socket => socket.url.includes('/ws/traces') && !socket.closed).length`), 1)
  assert.equal(await evaluate(`document.querySelector('a.nav-item[href="/#traces"]').getAttribute('aria-current')`), 'page')
  for (const theme of ['light', 'dark']) {
    if (await evaluate(`document.documentElement.dataset.theme`) !== theme) await click(`button[aria-label="Switch to ${theme} theme"]`)
    assert.equal(await evaluate(`document.querySelectorAll('.trace-table tbody tr').length`), 7)
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
    assert.equal(await evaluate(`document.querySelectorAll('.app-header button[aria-label*="theme"]').length`), 1)
  }
  await evaluate(`{ const input = document.querySelector('[aria-label="Search trace ID"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'qa-trace-2'); input.dispatchEvent(new Event('input',{bubbles:true})); }`)
  await until(`document.querySelectorAll('.trace-table tbody tr').length === 1`)
  assert.ok(requests.some(url => url.pathname === '/traces' && url.searchParams.get('search') === 'qa-trace-2' && url.searchParams.get('project_id') === 'qa-project'))
  const beforeUpdate = requests.filter(url => url.pathname === '/traces').length
  await evaluate(`window.__qaSockets.at(-1).onmessage({data: JSON.stringify({type:'TRACE_UPDATE'})})`)
  await delay(300)
  assert.ok(requests.filter(url => url.pathname === '/traces').length > beforeUpdate)
  await click('.filter-toolbar .button')
  await until(`document.querySelectorAll('.trace-table tbody tr').length === 7`)
  await click('.trace-link')
  await until(`location.pathname === '/trace/qa-trace-0' && document.querySelector('.breadcrumb strong')?.textContent === 'Trace investigation'`)
  assert.equal(await evaluate(`document.querySelector('.breadcrumb strong').textContent`), 'Trace investigation')
  await click('a.nav-item[href="/"]')
  await until(`document.querySelector('h1')?.textContent === 'Overview' && document.querySelectorAll('.trace-table tbody tr').length === 5`)
  await evaluate(`history.pushState({}, '', '/diff/qa-trace-0/qa-trace-1'); dispatchEvent(new PopStateEvent('popstate'))`)
  await until(`document.querySelector('main h1')?.textContent.includes('Trace Diff')`)
  assert.equal(await evaluate(`document.querySelector('.breadcrumb strong').textContent`), 'Trace comparison')
  await click('a.nav-item[href="/"]')
  await until(`document.querySelector('h1')?.textContent === 'Overview' && document.querySelectorAll('.trace-table tbody tr').length === 5`)
  // Phase 2: use only isolated fixtures to exercise the investigation workspace.
  await evaluate(`history.pushState({}, '', '/trace/${investigationId}'); dispatchEvent(new PopStateEvent('popstate'))`)
  await until(`document.querySelectorAll('.react-flow__node').length === 4`)
  assert.equal(await evaluate(`document.querySelector('.trace-identity code').textContent`), investigationId)
  assert.equal(await evaluate(`document.querySelectorAll('.react-flow__edge').length`), 3)
  assert.equal(await evaluate(`document.querySelectorAll('.span-node .status-badge.neutral').length`), 4)
  assert.equal(await evaluate(`!!document.querySelector('[data-id="span-writer"] .span-node.has-error')`), true)
  await click('[data-id="span-research"] .span-node')
  await until(`document.querySelector('.span-identity code')?.textContent === 'span-research'`)
  assert.equal(await evaluate(`!!document.querySelector('[data-id="span-research"] .span-node.is-selected')`), true)
  assert.equal(await evaluate(`document.querySelector('.span-facts').textContent.includes('120 ms')`), true)
  assert.equal(await evaluate(`document.querySelector('.inspector-details').textContent.includes('Not recorded')`), true)
  await click('button[aria-label="Copy output"]')
  assert.deepEqual(JSON.parse(await evaluate(`window.__qaClipboard`)), researchSpan.output_payload)
  await pointerClick('#tab-replay')
  assert.equal(await evaluate(`document.querySelector('[aria-label="Replay step"]').value`), '1')
  const readonlyInput = await evaluate(`document.querySelector('.replay-panel .json-section pre').textContent`)
  assert.equal(await evaluate(`document.querySelector('.replay-panel .json-section pre').isContentEditable`), false)
  assert.equal(await evaluate(`document.querySelectorAll('.replay-panel .json-section input, .replay-panel .json-section textarea').length`), 0)
  await replaceOverride('Editable draft before submitting')
  replayFails = true
  replayDelay = 5000
  await pointerClick('.replay-submit')
  await until(`document.querySelector('.replay-submit').disabled`)
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Output override"]').disabled`), false, 'Pending replay must not lock the output editor')
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Output override"]').readOnly`), false)
  await until(`document.querySelector('.replay-panel .operation-status')?.textContent.includes('Waiting')`)
  await replaceOverride('{"summary":"QA override"}')
  assert.deepEqual(replayPayload, { trace_id: investigationId, step_number: 1, overrides: { raw: 'Editable draft before submitting' } }, 'The in-flight request must retain its submitted snapshot')
  await until(`!!document.querySelector('.replay-panel .operation-error')`)
  replayDelay = 0
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Output override"]').value`), '{"summary":"QA override"}', 'Typing during a request must survive the response')
  assert.equal(await evaluate(`document.querySelector('.replay-panel .json-section pre').textContent`), readonlyInput)
  await selectFilter('Replay step', '3')
  await replaceOverride('{"summary":"QA override"}')
  await click('#tab-details')
  await click('#tab-replay')
  assert.equal(await evaluate(`document.querySelector('[aria-label="Output override"]').value`), '{"summary":"QA override"}')
  await evaluate(`window.__qaOverrideNode=document.querySelector('textarea[aria-label="Output override"]'); true`)
  await evaluate(`window.__qaSockets.findLast(socket => socket.url.endsWith('/ws/trace/${investigationId}') && !socket.closed).onmessage({data:JSON.stringify({type:'NEW_SPAN',span:${JSON.stringify({ ...researchSpan, output_payload: { summary: 'Updated server output' } })}})})`)
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Output override"]')===window.__qaOverrideNode`), true, 'Same-span updates must not remount the editor')
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Output override"]').value`), '{"summary":"QA override"}', 'Span updates must not replace the local draft')
  await pointerClick('.trace-actions .button:not(.primary)')
  await until(`!document.querySelector('.trace-actions .button:disabled')`)
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Output override"]').value`), '{"summary":"QA override"}', 'Parent refresh must retain the edited override')
  replayFails = true
  await click('.replay-submit')
  await until(`document.querySelector('.replay-panel .operation-error')?.textContent.includes('No snapshot found')`)
  assert.deepEqual(replayPayload, { trace_id: investigationId, step_number: 3, overrides: { summary: 'QA override' } })
  await evaluate(`{ const select = document.querySelector('#span-picker'); select.value = 'span-writer'; select.dispatchEvent(new Event('change',{bubbles:true})); }`)
  await until(`document.querySelector('[aria-label="Replay step"]').value === '2'`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Output override"]').value.includes('Provider timed out')`), true)
  await click('#tab-details')
  assert.equal(await evaluate(`document.querySelector('.span-facts').textContent.includes('$0.000000')`), true)
  assert.equal(await evaluate(`document.querySelector('.span-facts').textContent.includes('0 ms')`), true)
  await click('#tab-evaluation')
  assert.equal(await evaluate(`document.querySelector('.evaluation-panel').textContent.includes('No evaluation for this span')`), true)
  evaluationFails = true
  await click('.trace-actions .primary')
  await until(`document.querySelector('.operation-error')?.textContent.includes('Judge unavailable')`)
  evaluationFails = false
  await click('.trace-actions .primary')
  await until(`document.querySelectorAll('.evaluation-chip').length === 2`)
  assert.equal(await evaluate(`document.querySelector('.evaluation-panel .judge-scores').textContent.includes('Unscored')`), true)
  await click('.evaluation-chip')
  await until(`document.querySelector('.evaluation-panel .judge-scores')?.textContent.includes('9.0')`)
  assert.equal(await evaluate(`document.querySelector('.rubric-label').textContent.includes('role-v2')`), true)
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Assessment history"] option').length`), 2)
  await selectFilter('Assessment history', 'qa-research-old')
  assert.equal(await evaluate(`document.querySelector('.evaluation-panel .judge-scores').textContent.includes('8.0')`), true)
  assert.equal(await evaluate(`document.querySelector('.rubric-label').textContent.includes('legacy')`), true)
  await selectFilter('Assessment history', 'qa-research-new')
  assert.equal(await evaluate(`document.querySelector('.evaluation-panel .judge-scores').textContent.includes('9.0')`), true)
  assert.equal(await evaluate(`document.querySelector('.judge-model').textContent.includes('fixture-judge')`), true)
  const streamSpan = { ...researchSpan, span_id: 'span-streamed', parent_span_id: 'span-research', span_type: 'TOOL_EXECUTION' }
  await evaluate(`window.__qaSockets.findLast(s => s.url.endsWith('/ws/trace/${investigationId}') && !s.closed).onmessage({data:JSON.stringify({type:'NEW_SPAN',span:${JSON.stringify(streamSpan)}})})`)
  await until(`document.querySelectorAll('.react-flow__node').length === 5`)
  await evaluate(`window.__qaSockets.findLast(s => s.url.endsWith('/ws/trace/${investigationId}') && !s.closed).onmessage({data:JSON.stringify({type:'NEW_SPAN',span:${JSON.stringify(streamSpan)}})})`)
  assert.equal(await evaluate(`document.querySelectorAll('.react-flow__node').length`), 5)
  await click('.trace-actions .button:not(.primary)')
  await until(`!document.querySelector('.trace-actions .button:disabled')`)
  assert.equal(await evaluate(`document.querySelectorAll('.react-flow__node').length`), 5)
  await click('#tab-details')
  await until(`{ const canvas = document.querySelector('.execution-canvas').getBoundingClientRect(); [...document.querySelectorAll('.react-flow__node')].every(node => { const r = node.getBoundingClientRect(); return r.left >= canvas.left && r.right <= canvas.right && r.top >= canvas.top && r.bottom <= canvas.bottom }) }`)
  for (const theme of ['light', 'dark']) {
    if (await evaluate(`document.documentElement.dataset.theme`) !== theme) await click(`button[aria-label="Switch to ${theme} theme"]`)
    assert.equal(await evaluate(`document.querySelector('.react-flow').classList.contains('${theme}')`), true)
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
    if (process.env.QA_SCREENSHOTS || process.argv.includes('--screenshots')) {
      await evaluate(`scrollTo(0,0)`)
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const output = join(tmpdir(), `swarmtrace-phase2-${theme}.png`)
      writeFileSync(output, Buffer.from(shot.data,'base64'))
      console.log(`Screenshot: ${output}`)
    }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
  await evaluate(`{ const select = document.querySelector('#span-picker'); select.value = 'span-tool'; select.dispatchEvent(new Event('change',{bubbles:true})); }`)
  await until(`document.querySelector('.span-identity code')?.textContent === 'span-tool'`)
  await click('#tab-evaluation')
  assert.equal(await evaluate(`document.querySelector('.evaluation-panel').textContent.includes('Tool and handoff spans may have no evaluation')`), true)
  await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false })
  await evaluate(`{ const select = document.querySelector('#span-picker'); select.value = 'span-research'; select.dispatchEvent(new Event('change',{bubbles:true})); }`)
  await click('#tab-replay')
  replayFails = false
  await selectFilter('Replay step', '2')
  await replaceOverride('Plain override')
  await click('.replay-submit')
  await until(`!!document.querySelector('.replay-result')`)
  assert.deepEqual(replayPayload, { trace_id: investigationId, step_number: 2, overrides: { raw: 'Plain override' } })
  assert.equal(await evaluate(`document.querySelector('.replay-result a[href^="/diff/"]').getAttribute('href')`), `/diff/${investigationId}/qa-fork`)
  await until(`location.pathname === '/trace/qa-fork' && !!document.querySelector('.parent-trace-link')`)
  assert.equal(await evaluate(`document.querySelector('.trace-relationship .compare-parent-link').getAttribute('href')`), `/diff/${investigationId}/qa-fork`)
  await until(`document.querySelectorAll('.react-flow__node').length === 3`)
  await click('[data-id="qa-boundary"] .span-node')
  await until(`document.querySelector('.span-identity code')?.textContent === 'qa-boundary'`)
  assert.equal(await evaluate(`document.querySelector('[data-id="qa-boundary"] .span-node').textContent.includes('No model call')`), true)
  assert.equal(await evaluate(`document.querySelector('.replay-provenance').textContent.includes('not a newly executed writer reasoning span')`), true)
  assert.equal(await evaluate(`document.querySelector('.span-facts').textContent.includes('No model call')`), true)
  for (const theme of ['light', 'dark']) {
    if (await evaluate(`document.documentElement.dataset.theme`) !== theme) await click(`button[aria-label="Switch to ${theme} theme"]`)
    assert.equal(await evaluate(`document.querySelector('.inspector-title h3').textContent`), 'Overridden replay input')
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
  }
  assert.equal(await evaluate(`document.querySelectorAll('.evaluation-chip').length`), 0)
  await click('.parent-trace-link')
  await until(`location.pathname === '/trace/${investigationId}' && document.querySelectorAll('.react-flow__node').length === 4`)
  await click('.back-link')
  await until(`document.querySelector('h1')?.textContent === 'Overview' && document.querySelectorAll('.trace-table tbody tr').length === 5`)
  await click('a.nav-item[href="/#traces"]')
  await until(`document.querySelector('h1')?.textContent === 'Traces' && document.querySelectorAll('.trace-table tbody tr').length === 7`)
  await selectFilter('Filter by status', 'FAILED')
  await until(`document.querySelectorAll('.trace-table tbody tr').length === 1`)
  assert.ok(requests.some(url => url.searchParams.get('status') === 'FAILED'))
  await selectFilter('Filter by root agent', 'writer')
  await until(`document.querySelector('.trace-link')?.textContent.includes('qa-trace-6') && !document.querySelector('.loading-line')`)
  assert.ok(requests.some(url => url.searchParams.get('status') === 'FAILED' && url.searchParams.get('root_agent') === 'writer' && url.searchParams.get('project_id') === 'qa-project'))
  await click('.filter-toolbar .button')
  await until(`document.querySelectorAll('.trace-table tbody tr').length === 7`)
  await click('button.account')
  await until(`document.querySelector('.account-details')?.textContent.includes('qa@example.invalid')`)
  assert.equal(await evaluate(`document.querySelector('.account-details strong').textContent`), 'Browser QA')
  assert.equal(await evaluate(`document.querySelectorAll('.account-dropdown a').length`), 0)
  assert.equal(await evaluate(`document.querySelectorAll('.account-dropdown button').length`), 1)
  assert.equal(await evaluate(`document.activeElement.classList.contains('logout-action')`), true)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  assert.equal(await evaluate(`!!document.querySelector('.account-dropdown')`), false)
  await click('button.account')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 120, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y: 120, button: 'left', clickCount: 1 })
  assert.equal(await evaluate(`!!document.querySelector('.account-dropdown')`), false)
  await click('button.account')
  await click('a.nav-item[href="/settings"]')
  await until(`location.pathname === '/settings'`)
  await until(`document.querySelector('main')?.textContent.includes('Webhook') || document.querySelector('main')?.textContent.includes('Alerts')`)
  assert.equal(await evaluate(`/sign out|log ?out/i.test(document.querySelector('main').textContent)`), false)
  assert.equal(await evaluate(`document.querySelectorAll('a.nav-item').length`), 3)
  assert.equal(await evaluate(`document.querySelector('a.nav-item[href="/settings"]').getAttribute('aria-current')`), 'page')
  for (const theme of ['light', 'dark']) {
    if (await evaluate(`document.documentElement.dataset.theme`) !== theme) await click(`button[aria-label="Switch to ${theme} theme"]`)
    assert.equal(await evaluate(`document.documentElement.dataset.theme`), theme)
    await click('button.account')
    assert.equal(await evaluate(`!document.querySelector('.account-dropdown a') && !!document.querySelector('.logout-action')`), true)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  }
  await click('a.nav-item[href="/"]')
  await until(`document.querySelector('h1')?.textContent === 'Overview'`)
  await click('button[aria-label="Switch to light theme"]')
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'light')
  await click('button[aria-label="Switch to dark theme"]')
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark')
  await click('button[aria-label="Switch to light theme"]')
  await send('Page.reload')
  await until(`document.querySelector('h1')?.textContent === 'Overview'`)
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'light')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true)
  await click('.mobile-menu')
  assert.equal(await evaluate(`document.querySelector('.sidebar').classList.contains('is-open')`), true)
  await click('a.nav-item[href="/"]')
  await until(`document.querySelector('h1')?.textContent === 'Overview'`)
  assert.equal(await evaluate(`document.querySelector('.sidebar').classList.contains('is-open')`), false)
  await click('.mobile-menu')
  await click('a.nav-item[href="/#traces"]')
  await until(`document.querySelector('h1')?.textContent === 'Traces' && document.querySelectorAll('.trace-table tbody tr').length === 7`)
  assert.equal(await evaluate(`document.querySelector('.sidebar').classList.contains('is-open')`), false)
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
  await click('.mobile-menu')
  await click('a.nav-item[href="/settings"]')
  await until(`location.pathname === '/settings'`)
  assert.equal(await evaluate(`document.querySelector('.sidebar').classList.contains('is-open')`), false)
  await click('.mobile-menu')
  await click('button.account')
  await click('.logout-action')
  await until(`location.pathname === '/login'`)
  assert.equal(await evaluate(`localStorage.getItem('swt_token')`), null)
  assert.equal(await evaluate(`localStorage.getItem('swt_user')`), null)
  assert.equal(await evaluate(`localStorage.getItem('swt_project')`), null)
  assert.equal(await evaluate(`localStorage.getItem('swt_theme')`), 'light')
  await evaluate(`history.back()`)
  await delay(400)
  assert.equal(await evaluate(`location.pathname`), '/login')
  for (const path of ['/', '/#traces', '/settings', '/trace/qa-trace-0', '/diff/qa-trace-0/qa-trace-1']) {
    await send('Page.navigate', { url: `http://127.0.0.1:5173${path}` })
    await until(`location.pathname === '/login'`)
  }
  // Authentication layout and flow: all requests are isolated browser fixtures.
  await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false })
  for (const theme of ['light', 'dark']) {
    if (await evaluate(`document.documentElement.dataset.theme`) !== theme) await click(`button[aria-label="Switch to ${theme} theme"]`)
    assert.equal(await evaluate(`document.querySelectorAll('.auth-workflow, .auth-flow-node, .auth-page .status-badge').length`), 0)
    assert.equal(await evaluate(`(() => { const form=document.querySelector('.auth-form-region').getBoundingClientRect(); const page=document.querySelector('.auth-page').getBoundingClientRect(); return form.width >= 440 && form.width <= 480 && Math.abs((form.left+form.right)/2-(page.left+page.right)/2)<2 && Math.abs((form.top+form.bottom)/2-(page.top+page.bottom)/2)<2 })()`), true)
    assert.equal(await evaluate(`document.querySelectorAll('.app-header button[aria-label*="theme"]').length`), 1)
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
    if (process.argv.includes('--screenshots')) {
      await evaluate(`scrollTo(0,0)`)
      const screenshot = await send('Page.captureScreenshot', { format: 'png' })
      const output = join(tmpdir(), `swarmtrace-login-${theme}.png`)
      writeFileSync(output, Buffer.from(screenshot.data, 'base64'))
      console.log(`Screenshot: ${output}`)
    }
  }
  await pointerClick('.auth-submit')
  assert.equal(await evaluate(`document.querySelector('#auth-email').validity.valueMissing`), true)
  assert.equal(authSubmissions.length, 0)
  await typeAuthField('#auth-email', 'invalid-email')
  await typeAuthField('#auth-password', 'fixture-password')
  await pointerClick('.auth-submit')
  assert.equal(await evaluate(`document.querySelector('#auth-email').validity.typeMismatch`), true)
  assert.equal(authSubmissions.length, 0)
  await typeAuthField('#auth-email', 'login@example.invalid')
  authFailure = true
  authDelay = 1800
  assert.equal(await evaluate(`document.querySelector('.auth-form').checkValidity()`), true)
  await pointerClick('#auth-password')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until(`document.querySelector('.auth-form')?.getAttribute('aria-busy') === 'true'`)
  assert.equal(await evaluate(`document.querySelector('.auth-demo').disabled && document.querySelector('#auth-email').matches(':disabled')`), true)
  await until(`document.querySelector('#auth-error')?.textContent === 'Invalid email or password'`)
  assert.equal(await evaluate(`location.pathname`), '/login')
  assert.equal(await evaluate(`document.querySelector('#auth-email').value`), 'login@example.invalid')
  assert.deepEqual(authSubmissions.at(-1), { path: '/auth/login', body: { email: 'login@example.invalid', password: 'fixture-password' } })
  authFailure = false
  authDelay = 0
  await pointerClick('.auth-submit')
  await until(`location.pathname === '/' && localStorage.getItem('swt_token') === 'qa-auth-token'`)
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('swt_user')).email`), 'login@example.invalid')
  await click('button.account')
  await click('.logout-action')
  await until(`location.pathname === '/login'`)
  await click('.auth-mode-switch button:nth-child(2)')
  await until(`!!document.querySelector('#auth-name') && document.querySelector('#auth-password')?.autocomplete === 'new-password'`)
  assert.equal(await evaluate(`document.querySelector('#auth-password').autocomplete`), 'new-password')
  await typeAuthField('#auth-name', 'Registration QA')
  await typeAuthField('#auth-email', 'register@example.invalid')
  await typeAuthField('#auth-password', 'registration-password')
  authFailure = true
  await pointerClick('.auth-submit')
  await until(`document.querySelector('#auth-error')?.textContent === 'Email already registered'`)
  authFailure = false
  await pointerClick('.auth-submit')
  await until(`location.pathname === '/'`)
  assert.deepEqual(authSubmissions.at(-1), { path: '/auth/register', body: { name: 'Registration QA', email: 'register@example.invalid', password: 'registration-password' } })
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('swt_user')).name`), 'Registration QA')
  await click('button.account')
  await click('.logout-action')
  await until(`location.pathname === '/login'`)
  authNetworkFailure = true
  await pointerClick('.auth-demo')
  await until(`document.querySelector('#auth-error')?.textContent === 'Cannot connect to the demo backend. Please try again when the server is available.'`)
  authNetworkFailure = false
  authFailure = true
  await pointerClick('.auth-demo')
  await until(`document.querySelector('#auth-error')?.textContent === 'The shared demo account is unavailable. Please contact the administrator.'`)
  authFailure = false
  await pointerClick('.auth-demo')
  await until(`location.pathname === '/'`)
  assert.deepEqual(authSubmissions.at(-1), { path: '/auth/login', body: { email: 'demo@swarmtrace.dev', password: 'demo1234' } })
  protectedFailure = true
  await send('Page.reload')
  await until(`location.pathname === '/login'`)
  assert.equal(await evaluate(`localStorage.getItem('swt_token')`), null)
  assert.equal(await evaluate(`localStorage.getItem('swt_user')`), null)
  protectedFailure = false
  await until(`!!document.querySelector('.auth-form-region') && !!document.querySelector('#auth-email')`)
  for (const width of [768, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true })
    assert.equal(await evaluate(`document.querySelectorAll('.auth-workflow, .auth-flow-node').length`), 0)
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
    await typeAuthField('#auth-email', 'mobile@example.invalid')
    assert.equal(await evaluate(`document.querySelector('#auth-email').value`), 'mobile@example.invalid')
  }
  await click('button[aria-label="Switch to light theme"]')
  await send('Page.reload')
  await until(`!!document.querySelector('#auth-email')`)
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'light')
  // A newly authenticated account with no memberships gets an explicit empty workspace.
  emptyProjects = true
  projectDelay = 500
  await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false })
  await evaluate(`localStorage.setItem('swt_project','previous-account-project')`)
  await pointerClick('.auth-demo')
  await until(`location.pathname === '/' && document.body.textContent.includes('You have no projects yet.')`)
  await until(`!document.body.textContent.includes('Loading traces')`)
  assert.equal(await evaluate(`document.querySelectorAll('.trace-link').length`), 0)
  assert.equal(await evaluate(`document.querySelector('.notice a').getAttribute('href')`), '/settings')
  assert.notEqual(await evaluate(`localStorage.getItem('swt_project')`), 'previous-account-project')
  assert.equal(await evaluate(`window.__qaSockets.filter(socket => socket.url.includes('/ws/') && !socket.closed).length`), 0)
  await click('button.account')
  await click('.logout-action')
  await until(`location.pathname === '/login'`)
  assert.deepEqual(exceptions, [])
  console.log('PASS: Chromium browser regression checks (isolated fixtures): sign-in/registration/demo, native validation and Enter submit, loading/errors, JWT session storage, protected 401 redirect, desktop/mobile auth layouts and theme persistence, plus existing trace/replay/evaluation/navigation checks.')
  }
} finally {
  if (ws?.readyState === WebSocket.OPEN) { try { await send('Browser.close') } catch {} ws.close() }
  browser.kill()
}




