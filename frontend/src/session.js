import { useSyncExternalStore } from 'react'

const SESSION_EVENT = 'swt-session-change'
export const getSessionToken = () => localStorage.getItem('swt_token')

function subscribe(listener) {
  window.addEventListener(SESSION_EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(SESSION_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

export const useSessionToken = () => useSyncExternalStore(subscribe, getSessionToken, () => null)

export function readCachedUser() {
  try { return JSON.parse(localStorage.getItem('swt_user')) } catch { return null }
}

export function saveSession(data) {
  if (readCachedUser()?.user_id !== data.user_id) localStorage.removeItem('swt_project')
  localStorage.setItem('swt_token', data.access_token)
  localStorage.setItem('swt_user', JSON.stringify({ user_id: data.user_id, email: data.email, name: data.name }))
  window.dispatchEvent(new Event(SESSION_EVENT))
}

export function clearSession() {
  for (const key of ['swt_token', 'swt_user', 'swt_project']) localStorage.removeItem(key)
  window.dispatchEvent(new Event(SESSION_EVENT))
}
