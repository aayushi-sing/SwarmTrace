import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { login, register } from '../api/client'
import { saveSession } from '../session'
import Icon from '../components/Icon'
import '../trace-detail.css'
import '../login.css'

function authenticationError(error) {
  const detail = error.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map(item => item.msg).filter(Boolean).join('. ') || 'Check your details and try again.'
  return error.message || 'Unable to connect. Please try again.'
}

export default function Login() {
  const [tab, setTab] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(null)
  const navigate = useNavigate()
  const busy = pending !== null
  const registering = tab === 'register'

  async function handleSubmit(event) {
    event.preventDefault()
    if (busy) return
    if (registering && !name.trim()) {
      setError('Enter your name to create an account.')
      return
    }
    setPending(tab)
    setError(null)
    try {
      const response = registering
        ? await register({ email: email.trim(), password, name: name.trim() })
        : await login({ email: email.trim(), password })
      saveSession(response.data)
      navigate('/', { replace: true })
    } catch (failure) {
      setError(authenticationError(failure))
    } finally {
      setPending(null)
    }
  }

  async function handleDemo() {
    if (busy) return
    setPending('demo')
    setError(null)
    try {
      const response = await login({ email: 'demo@swarmtrace.dev', password: 'demo1234' })
      saveSession(response.data)
      navigate('/', { replace: true })
    } catch (failure) {
      setError(!failure.response
        ? 'Cannot connect to the demo backend. Please try again when the server is available.'
        : failure.response.status === 401
          ? 'The shared demo account is unavailable. Please contact the administrator.'
          : 'The demo service could not complete sign-in. Please try again.')
    } finally {
      setPending(null)
    }
  }

  return <div className="auth-page">
    <div className="auth-layout">
      <section className="auth-form-region" aria-labelledby="auth-title">
        <div className="eyebrow">WORKSPACE ACCESS</div>
        <h1 id="auth-title">{registering ? 'Create your account' : 'Sign in to SwarmTrace'}</h1>
        <p className="auth-description">{registering ? 'A workspace for your agents, traces, and investigations.' : 'Pick up where your last investigation left off.'}</p>
        <div className="auth-mode-switch" role="group" aria-label="Authentication mode">
          <button type="button" aria-pressed={!registering} disabled={busy} onClick={() => { setTab('login'); setError(null) }}>Sign in</button>
          <button type="button" aria-pressed={registering} disabled={busy} onClick={() => { setTab('register'); setError(null) }}>Create account</button>
        </div>
        <form className="auth-form" onSubmit={handleSubmit} aria-busy={busy} aria-describedby={error ? 'auth-error' : undefined}>
          <fieldset disabled={busy}>
            <legend className="sr-only">{registering ? 'Create account details' : 'Sign-in details'}</legend>
            {registering && <label className="auth-field" htmlFor="auth-name"><span>Name</span><input id="auth-name" name="name" autoComplete="name" required value={name} onChange={event => setName(event.target.value)} placeholder="Your name"/></label>}
            <label className="auth-field" htmlFor="auth-email"><span>Email address</span><input id="auth-email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com"/></label>
            <label className="auth-field" htmlFor="auth-password"><span>Password</span><input id="auth-password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} required value={password} onChange={event => setPassword(event.target.value)} placeholder={registering ? 'Choose a password' : 'Enter your password'}/></label>
            {error && <div id="auth-error" className="auth-error" role="alert">{error}</div>}
            <button type="submit" className="button primary auth-submit">{pending === 'login' ? 'Signing in…' : pending === 'register' ? 'Creating account…' : registering ? 'Create account' : 'Sign in'}{!busy && <Icon name="arrow" size={15}/>}</button>
          </fieldset>
        </form>
        <div className="auth-divider"><span>or explore first</span></div>
        <button type="button" className="button auth-demo" disabled={busy} onClick={handleDemo}>{pending === 'demo' ? 'Opening demo…' : 'Open live demo'}{pending !== 'demo' && <Icon name="arrow" size={15}/>}</button>
        <p className="auth-demo-note">Use the demo account. No sign-up required.</p>
        <p className="auth-status" role="status">{busy ? pending === 'demo' ? 'Connecting to the demo workspace…' : registering ? 'Creating your workspace account…' : 'Signing in to your workspace…' : ''}</p>
      </section>
    </div>
  </div>
}
