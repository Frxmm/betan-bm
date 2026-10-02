import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, type Reservation } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import AgentFloat from './AgentFloat'

const TITLE_MAP: Record<string, string> = {
  '/dashboard':      'Dashboard',
  '/planning':       'Planning',
  '/arrivals':       'Entradas',
  '/departures':     'Salidas',
  '/billing':        'Facturación',
  '/rates':          'Tarifas',
  '/rates/calendar': 'Calendario de Precios',
  '/reservations':   'Reservas',
  '/guests':         'Huéspedes',
  '/rooms':          'Habitaciones',
  '/agent':          'Asistente IA',
  '/settings':       'Apariencia',
  '/alerts':         'Alertas',
}

const TODAY = new Date().toLocaleDateString('es-ES', {
  weekday: 'short', day: 'numeric', month: 'short',
})

function initials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

const AVATAR_COLORS = ['#4f7cff','#22c55e','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899']
function avatarColor(id: number) { return AVATAR_COLORS[id % AVATAR_COLORS.length] }

export default function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<Reservation[]>([])
  const [open, setOpen]         = useState(false)
  const [active, setActive]     = useState(-1)
  const [online, setOnline]     = useState<{ id: number; name: string }[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Ping de presencia + poll de usuarios conectados
  useEffect(() => {
    if (!user) return
    const ping = async () => {
      await fetch('/api/users/presence/ping', { method: 'POST', credentials: 'include' }).catch(() => {})
      const r = await fetch('/api/users/presence', { credentials: 'include' }).catch(() => null)
      if (r?.ok) { const j = await r.json(); setOnline(j.data ?? []) }
    }
    ping()
    const iv = setInterval(ping, 60_000)
    return () => clearInterval(iv)
  }, [user])

  const title = location.pathname.startsWith('/reservations/')
    ? `Reserva #${location.pathname.split('/').pop()}`
    : (TITLE_MAP[location.pathname] ?? '')

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setOpen(false); return }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        const res = await api.searchReservations(query)
        setResults(res?.data ?? [])
        setOpen(true)
        setActive(-1)
      } catch { setResults([]) }
    }, 220)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [query])

  const open_ = (id: number) => {
    navigate(`/reservations/${id}`)
    setQuery('')
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown')  { setActive(a => Math.min(a + 1, results.length - 1)); e.preventDefault() }
    else if (e.key === 'ArrowUp') { setActive(a => Math.max(a - 1, 0)); e.preventDefault() }
    else if (e.key === 'Enter' && active >= 0) open_(results[active]!.id)
    else if (e.key === 'Escape') { setOpen(false); setQuery('') }
  }

  return (
    <header id="topbar">
      <button className="nav-hamburger" onClick={onMenuClick} aria-label="Menú">
        <span /><span /><span />
      </button>
      <h1 id="page-title">{title}</h1>

      <div id="gsearch-wrap">
        <span className="gsearch-icon">⌕</span>
        <input
          id="gsearch-input"
          type="search"
          autoComplete="off"
          placeholder="Buscar reserva, huésped o habitación…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && results.length > 0 && (
          <div id="gsearch-dropdown">
            {results.map((r, i) => (
              <div
                key={r.id}
                className={`gsearch-item${i === active ? ' active' : ''}`}
                onMouseDown={() => open_(r.id)}
              >
                <span className="gsearch-id">#{r.id}</span>
                <span className="gsearch-name">
                  {r.guest?.firstName} {r.guest?.lastName}
                </span>
                <span className="gsearch-room">{r.room?.code}</span>
                <span className="gsearch-dates">
                  {r.checkInDate} → {r.checkOutDate}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {online.length > 0 && (
        <div className="topbar-presence" title={online.map(u => u.name).join(', ')}>
          {online.slice(0, 5).map(u => (
            <span
              key={u.id}
              className="topbar-avatar"
              style={{ background: avatarColor(u.id) }}
              title={u.name}
            >
              {initials(u.name)}
            </span>
          ))}
          {online.length > 5 && (
            <span className="topbar-avatar" style={{ background: '#64748b' }}>+{online.length - 5}</span>
          )}
        </div>
      )}
      <AgentFloat />
      <span className="topbar-date">{TODAY}</span>
    </header>
  )
}
