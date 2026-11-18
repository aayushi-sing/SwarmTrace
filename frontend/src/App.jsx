import { Fragment } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import TraceList from './pages/TraceList'
import TraceDetail from './pages/TraceDetail'
import TraceDiff from './pages/TraceDiff'
import Login from './pages/Login'
import Settings from './pages/Settings'
import AppShell from './components/AppShell'
import { ThemeProvider } from './components/ThemeProvider'
import { useSessionToken } from './session'

function PrivateRoute({ children }) {
  const token = useSessionToken()
  return token ? <Fragment key={token}>{children}</Fragment> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <ThemeProvider><BrowserRouter><AppShell>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<PrivateRoute><TraceList /></PrivateRoute>} />
        <Route path="/trace/:traceId" element={<PrivateRoute><TraceDetail /></PrivateRoute>} />
        <Route path="/diff/:originalId/:forkedId" element={<PrivateRoute><TraceDiff /></PrivateRoute>} />
        <Route path="/settings" element={<PrivateRoute><Settings /></PrivateRoute>} />
      </Routes>
    </AppShell></BrowserRouter></ThemeProvider>
  )
}
