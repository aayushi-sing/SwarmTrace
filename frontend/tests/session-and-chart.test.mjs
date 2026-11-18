import test from 'node:test'
import assert from 'node:assert/strict'
import { traceCountScale } from '../src/chartScale.js'
import { saveSession, clearSession, getSessionToken, readCachedUser } from '../src/session.js'

test('count axes have unique whole-number ticks and sensible ceilings', () => {
  for (const counts of [[], [0], [1], [2], [3], [4], [7], [11], [1001], ['1', '3']]) {
    const { ceiling, ticks } = traceCountScale(counts)
    assert.equal(ticks.at(-1), 0)
    assert.equal(new Set(ticks).size, ticks.length)
    assert.ok(ticks.every(Number.isInteger))
    assert.ok(ceiling >= Math.max(0, ...counts))
    assert.ok(ticks.length <= 5)
    assert.ok(ticks.every((v, i) => !i || ticks[i - 1] > v))
  }
  assert.deepEqual(traceCountScale([1]).ticks, [1, 0])
  assert.deepEqual(traceCountScale([7]).ticks, [10, 5, 0])
})

test('logout clears only session data and not the selected theme', () => {
  const storage = new Map([['swt_theme', 'light'], ['swt_project', 'old-project']])
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  }
  globalThis.window = new EventTarget()
  let updates = 0
  window.addEventListener('swt-session-change', () => updates++)
  saveSession({ access_token: 'test-token', user_id: 'test-user', name: 'Test User', email: 'test@example.invalid' })
  assert.equal(getSessionToken(), 'test-token')
  assert.equal(readCachedUser().email, 'test@example.invalid')
  clearSession()
  assert.equal(getSessionToken(), null)
  assert.equal(readCachedUser(), null)
  assert.equal(localStorage.getItem('swt_project'), null)
  assert.equal(localStorage.getItem('swt_theme'), 'light')
  assert.equal(updates, 2)
})

test('project selection is retained only for the same authenticated account', () => {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  }
  globalThis.window = new EventTarget()
  saveSession({ user_id: 'user-a', access_token: 'token-a' })
  localStorage.setItem('swt_project', 'project-a')
  saveSession({ user_id: 'user-a', access_token: 'token-a-renewed' })
  assert.equal(localStorage.getItem('swt_project'), 'project-a')
  saveSession({ user_id: 'user-b', access_token: 'token-b' })
  assert.equal(localStorage.getItem('swt_project'), null)
})
