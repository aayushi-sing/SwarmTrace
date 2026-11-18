export default function Icon({ name, size = 18, ...props }) {
  const paths = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    traces: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
    settings: <><path d="m9 3-1 3-3 1v4l2 1-2 1v4l3 1 1 3h6l1-3 3-1v-4l-2-1 2-1V7l-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
    moon: <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/></>,
    logo: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9ZM4 7.5l8 5 8-5M12 12.5V21"/></>,
    arrow: <path d="m9 5 7 7-7 7"/>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.traces}</svg>
}
