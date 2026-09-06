import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import Icon from './Icon.jsx'
import AccountMenu from './AccountMenu.jsx'
import { useTheme } from '../theme/ThemeContext.jsx'
import { useFetch } from '../hooks/useFetch.js'
import { alertsApi } from '../services/api.js'
import { riskRank } from '../lib/format.js'

const NAV = [
  {
    heading: 'Monitor',
    items: [
      { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
      { to: '/response', label: 'Outbreak response', icon: 'shield' },
      { to: '/map', label: 'Risk map', icon: 'map' },
      { to: '/alerts', label: 'Alerts', icon: 'alerts', badge: 'alerts' },
    ],
  },
  {
    heading: 'Model',
    items: [
      { to: '/forecast', label: 'Forecast', icon: 'forecast' },
      { to: '/models', label: 'Model comparison', icon: 'models' },
      { to: '/calibration', label: 'Calibration', icon: 'target' },
      { to: '/drivers', label: 'Drivers', icon: 'chart' },
      // Two maths pages arrived independently and overlap in subject. Both are
      // kept and routed so neither is lost; collapse them into one once it is
      // decided which framing to keep.
      { to: '/mathematics', label: 'Mathematical calculation', icon: 'sigma' },
      { to: '/methodology', label: 'Model mathematics', icon: 'sigma' },
    ],
  },
  {
    heading: 'Sources',
    items: [
      { to: '/data', label: 'Data management', icon: 'data' },
      { to: '/fixture', label: 'Synthetic fixture', icon: 'file' },
    ],
  },
]

const TITLES = {
  '/': 'Dashboard',
  '/response': 'Outbreak response',
  '/map': 'Risk map',
  '/alerts': 'Alerts',
  '/forecast': 'Forecast',
  '/models': 'Model comparison',
  '/calibration': 'Calibration',
  '/drivers': 'Drivers',
  '/mathematics': 'Mathematical calculation',
  '/methodology': 'Model mathematics',
  '/data': 'Data management',
  '/fixture': 'Synthetic fixture',
}

const THEME_LABEL = {
  light: { icon: 'sun', text: 'Light theme' },
  dark: { icon: 'moon', text: 'Dark theme' },
  system: { icon: 'monitor', text: 'Matching system theme' },
}

function ThemeToggle() {
  const { preference, cycle } = useTheme()
  const spec = THEME_LABEL[preference]
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={cycle}
      title={`${spec.text} — click to change`}
      aria-label={`${spec.text}. Activate to switch theme.`}
    >
      <Icon name={spec.icon} size={16} />
    </button>
  )
}

export default function Layout({ children }) {
  const location = useLocation()
  const [navOpen, setNavOpen] = useState(false)

  // The nav badge must agree with the Alerts page, so it reads the same source.
  const { data: alerts } = useFetch(() => alertsApi.list(), [])
  const activeAlerts = (alerts ?? []).filter((a) => riskRank(a.risk_level) >= riskRank('high')).length

  // Close the mobile drawer on navigation so a tap never leaves it hanging.
  useEffect(() => { setNavOpen(false) }, [location.pathname])

  useEffect(() => {
    if (!navOpen) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  const counts = { alerts: activeAlerts }

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>

      <aside className={`sidebar ${navOpen ? 'is-open' : ''}`} aria-label="Primary">
        <div className="brand">
          <span className="brand-glyph" aria-hidden="true">
            <Icon name="target" size={19} strokeWidth={1.8} />
          </span>
          <span className="brand-text">
            <span className="brand-name">DEWS</span>
            <span className="brand-sub">Dengue early warning</span>
          </span>
        </div>

        <nav aria-label="Sections">
          {NAV.map((group) => (
            <div className="nav-group" key={group.heading}>
              <p className="nav-heading">{group.heading}</p>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => (isActive ? 'nav-link is-active' : 'nav-link')}
                >
                  <Icon name={item.icon} size={17} />
                  {item.label}
                  {item.badge && counts[item.badge] > 0 && (
                    <span className="nav-count">
                      {counts[item.badge]}
                      <span className="sr-only"> alerts at high risk or above</span>
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="model-chip">
            <span className="model-chip-dot" aria-hidden="true" />
            <span className="model-chip-text">
              <span className="model-chip-title">Bayesian-neural hybrid</span>
              <span className="model-chip-sub">v1 · reads MySQL</span>
            </span>
          </div>
        </div>
      </aside>

      {navOpen && (
        <button type="button" className="scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />
      )}

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn nav-toggle"
            onClick={() => setNavOpen((v) => !v)}
            aria-expanded={navOpen}
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          >
            <Icon name={navOpen ? 'close' : 'menu'} size={17} />
          </button>

          <span className="topbar-title">{TITLES[location.pathname] ?? 'DEWS'}</span>

          <div className="topbar-actions">
            <ThemeToggle />
            <AccountMenu />
          </div>
        </header>

        <main className="content" id="main">{children}</main>
      </div>
    </div>
  )
}
