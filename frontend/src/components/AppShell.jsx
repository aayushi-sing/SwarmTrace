import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from './ThemeProvider'
import Icon from './Icon'
import { getMe } from '../api/client'
import { clearSession, getSessionToken, readCachedUser, useSessionToken } from '../session'

export default function AppShell({ children }) {
  const { pathname, hash } = useLocation()
  const { theme, toggleTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [user, setUser] = useState(readCachedUser)
  const [profileError, setProfileError] = useState(false)
  const accountRef = useRef(null)
  const accountButton = useRef(null)
  const accountLogout = useRef(null)
  const navigate = useNavigate()
  const token = useSessionToken()
  const auth = pathname === '/login'
  const title = auth ? 'Account' : pathname === '/settings' ? 'Settings' : pathname.startsWith('/trace/') ? 'Trace investigation' : pathname.startsWith('/diff/') ? 'Trace comparison' : hash === '#traces' ? 'Traces' : 'Overview'
  useEffect(() => {
    setOpen(false)
    setAccountOpen(false)
  }, [pathname, hash])
  useEffect(() => {
    let cancelled = false
    setUser(token ? readCachedUser() : null)
    setProfileError(false)
    if (token) getMe().then(r => {
      if (cancelled || getSessionToken() !== token) return
      setUser(r.data)
      localStorage.setItem('swt_user', JSON.stringify({ user_id: r.data.user_id, name: r.data.name, email: r.data.email }))
    }).catch(() => { if (!cancelled) setProfileError(true) })
    return () => { cancelled = true }
  }, [token])
  useEffect(() => {
    if (!accountOpen) return
    accountLogout.current?.focus()
    function outside(event) {
      if (!accountRef.current?.contains(event.target)) setAccountOpen(false)
    }
    function escape(event) {
      if (event.key === 'Escape') {
        setAccountOpen(false)
        accountButton.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [accountOpen])
  function logout() {
    setAccountOpen(false)
    setOpen(false)
    clearSession()
    navigate('/login', { replace: true })
  }
  const nav = (to, icon, label, active) => <Link to={to} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => setOpen(false)}><Icon name={icon}/>{label}</Link>
  return <div className={auth ? 'app-shell auth-shell' : 'app-shell'}>
    {!auth && <>
      {open && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setOpen(false)}/>}
      <aside className={`sidebar ${open ? 'is-open' : ''}`}>
        <Link className="brand" to="/" onClick={() => setOpen(false)}><span className="brand-mark"><Icon name="logo" size={23}/></span>SwarmTrace</Link>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav('/', 'overview', 'Overview', pathname === '/' && hash !== '#traces')}
          {nav('/#traces', 'traces', 'Traces', (pathname === '/' && hash === '#traces') || pathname.startsWith('/trace/') || pathname.startsWith('/diff/'))}
          {nav('/settings', 'settings', 'Settings', pathname === '/settings')}
        </nav>
        <div className="sidebar-bottom">
          <div className="account-container" ref={accountRef} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setAccountOpen(false) }}>
            {accountOpen && <div id="account-dropdown" className="account-dropdown" role="region" aria-label="Account actions">
              <div className="account-details">{user?.name && <strong>{user.name}</strong>}{user?.email && <span>{user.email}</span>}{!user?.name && !user?.email && <span>{profileError ? 'Unable to load profile' : 'Loading profile…'}</span>}</div>
              <button ref={accountLogout} className="logout-action" onClick={logout}>Log out</button>
            </div>}
            <button ref={accountButton} className="account" aria-label="Open account menu" aria-expanded={accountOpen} aria-controls="account-dropdown" onClick={() => setAccountOpen(!accountOpen)}><span className="avatar">{(user?.name || user?.email || '').slice(0, 1).toUpperCase() || <Icon name="settings" size={15}/>}</span><span><strong>{user?.name || 'Account'}</strong>{user?.email && <small>{user.email}</small>}</span><Icon name="arrow" size={14}/></button>
          </div>
        </div>
      </aside>
    </>}
    <div className="app-main">
      <header className="app-header">
        <div className="breadcrumb">{!auth && <button className="icon-button mobile-menu" aria-label="Toggle navigation" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="menu"/></button>}{auth ? <Link to="/login" className="brand"><Icon name="logo"/>SwarmTrace</Link> : <><span>Workspace</span><span className="slash">/</span><strong>{title}</strong></>}</div>
        <button className="icon-button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}><Icon name={theme === 'dark' ? 'sun' : 'moon'}/></button>
      </header>
      <main id="main-content">{children}</main>
    </div>
  </div>
}
