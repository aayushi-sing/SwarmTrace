import { useEffect, useState } from 'react'

export function CopyButton({ value, label = 'value' }) {
  const [state, setState] = useState('Copy')
  useEffect(() => { setState('Copy') }, [value])
  useEffect(() => {
    if (state === 'Copy') return
    const timer = setTimeout(() => setState('Copy'), 2500)
    return () => clearTimeout(timer)
  }, [state])
  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
      setState('Copied')
    } catch { setState('Copy unavailable') }
  }
  return <button className="copy-button" aria-label={`Copy ${label}`} onClick={copy} disabled={value == null}>{state}</button>
}

export default function JsonPanel({ title, value, empty = 'Not recorded' }) {
  return <section className="json-section"><div className="json-heading"><h3>{title}</h3>{value != null && <CopyButton value={value} label={title.toLowerCase()}/>}</div>{value == null ? <p className="field-empty">{empty}</p> : <pre tabIndex={0}>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>}</section>
}
