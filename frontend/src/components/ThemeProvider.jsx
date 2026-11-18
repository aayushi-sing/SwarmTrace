import { createContext, useContext, useState } from 'react'

const ThemeContext = createContext(null)
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'dark')
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('swt_theme', next) } catch { /* Theme still works without storage. */ }
    setTheme(next)
  }
  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>
}
export const useTheme = () => useContext(ThemeContext)
