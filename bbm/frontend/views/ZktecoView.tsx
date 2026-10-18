import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, canManage } from '../contexts/AuthContext'
import { api } from '../lib/api'

const EVENT_LABELS: Record<string, string> = {
  '0':  'Acceso normal',         '1':  'Contraseña incorrecta',
  '2':  'Tarjeta no existe',     '3':  'Tarjeta caducada',
  '4':  'Timeout',               '5':  'Puerta inhibida',
  '8':  'Botón salida',          '23': 'Alarma coacción',
  '27': 'Multi-tarjeta',         '32': 'Sin autorización',
  '36': 'Estado puerta',         '40': 'Auto-apertura',
  '200':'Inicio controlador',    '201':'Reset controlador',
  '202':'Estado imán',           '203':'Exceso contraseñas',
  '204':'Anti-sabotaje',         '205':'Exceso tarjetas',
  '208':'Puerta abierta sin tarjeta', '209':'Anti-passback',
}

function eventColor(type: number): { bg: string; color: string } {
  if (type === 0)                         return { bg: 'rgba(34,197,94,.15)',  color: 'var(--green)' }
  if (type === 8 || type === 40)          return { bg: 'rgba(59,130,246,.15)', color: 'var(--blue)' }
  if (type >= 200)                        return { bg: 'rgba(148,163,184,.15)',color: 'var(--text2)' }
  if (type === 23 || type === 32 || type === 204) return { bg: 'rgba(239,68,68,.15)', color: 'var(--red, #ef4444)' }
  return { bg: 'rgba(245,158,11,.15)', color: 'var(--yellow, #d97706)' }
}

interface Status { configured: boolean; reachable?: boolean; ip?: string; firmware?: string }
interface Card { user_id: string; name: string; card_number: string; room_code: string | null; card_type?: 'employee' | 'temp' | 'reservation'; note?: string }
interface AccessEvent {
  id: number; timestamp: string; door: number | null
  card_no: string | null; user_id: string | null
  event_type: number; in_out: number | null; room_code: string | null
}

const EVENTS_LOAD = 1000
const EVENTS_PAGE = 50
const CARDS_PAGE  = 20

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 365) return `hace ${Math.floor(d / 365)}a`
  if (d > 30)  return `hace ${Math.floor(d / 30)}m`
  if (d > 0)   return `hace ${d}d`
  if (h > 0)   return `hace ${h}h`
  if (m > 0)   return `hace ${m}min`
  return 'ahora'
}

function Pagination({ page, total, perPage, onChange }: {
  page: number; total: number; perPage: number; onChange: (p: number) => void
}) {
  const pages = Math.ceil(total / perPage)
  if (pages <= 1) return null
  const from = page * perPage + 1
  const to   = Math.min((page + 1) * perPage, total)
  const btnStyle = (disabled: boolean): React.CSSProperties => ({
    width: 30, height: 30, border: '1px solid var(--border)', borderRadius: 6,
    background: disabled ? 'transparent' : 'var(--bg2)',
    color: disabled ? 'var(--text3)' : 'var(--text1)',
    cursor: disabled ? 'default' : 'pointer', fontSize: 14,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  })
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 14, fontSize: 13, color: 'var(--text2)' }}>
      <button style={btnStyle(page === 0)} disabled={page === 0} onClick={() => onChange(0)}>«</button>
      <button style={btnStyle(page === 0)} disabled={page === 0} onClick={() => onChange(page - 1)}>‹</button>
      <span style={{ padding: '0 10px', fontVariantNumeric: 'tabular-nums' }}>{from}–{to} de {total}</span>
      <button style={btnStyle(page >= pages - 1)} disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>›</button>
      <button style={btnStyle(page >= pages - 1)} disabled={page >= pages - 1} onClick={() => onChange(pages - 1)}>»</button>
    </div>
  )
}

function FilterBar({ children, active, onClear }: { children: React.ReactNode; active: boolean; onClear: () => void }) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
      background: 'var(--bg2)', borderRadius: 8, padding: '10px 12px', marginBottom: 14,
    }}>
      {children}
      {active && (
        <button
          onClick={onClear}
          style={{
            marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text3)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          ✕ Limpiar filtros
        </button>
      )}
    </div>
  )
}

type EnrollType = 'employee' | 'temp' | 'reservation'

interface ResvInfo { id: number; guest_name: string; room: string; check_in: string; check_out: string; card_count: number; next_pin: string }

function EnrollarTab({ apiFetch, ok, setError, onDone, cards }: {
  apiFetch: (path: string, opts?: RequestInit) => Promise<any>
  ok: (msg: string) => void
  setError: (e: string | null) => void
  onDone: () => void
  cards: Card[]
}) {
  const [type,        setType]        = useState<EnrollType>('employee')
  const [cardNumber,  setCardNumber]  = useState('')
  const [saving,      setSaving]      = useState(false)
  const [revokingId,  setRevokingId]  = useState<string | null>(null)

  // Empleado
  const [employees,   setEmployees]   = useState<Array<{ id: number; firstName: string; lastName: string; roles: string[] }>>([])
  const [employeeId,  setEmployeeId]  = useState<number | ''>('')

  // Temporal
  const [tempName,    setTempName]    = useState('')
  const [tempPin,     setTempPin]     = useState('')

  // Reserva
  const [resvId,      setResvId]      = useState('')
  const [resvInfo,    setResvInfo]    = useState<ResvInfo | null>(null)
  const [lookingUp,   setLookingUp]   = useState(false)
  const lookupTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.listUsers().then(r => setEmployees(r.data ?? [])).catch(() => {})
  }, [])

  // Auto-lookup reserva al escribir el ID
  useEffect(() => {
    setResvInfo(null)
    if (!resvId || !/^\d+$/.test(resvId)) return
    if (lookupTimeout.current) clearTimeout(lookupTimeout.current)
    lookupTimeout.current = setTimeout(async () => {
      setLookingUp(true)
      try {
        const d = await apiFetch(`/api/zkteco/enroller/${resvId}`)
        setResvInfo(d.data ?? null)
      } catch { setResvInfo(null) }
      finally { setLookingUp(false) }
    }, 400)
  }, [resvId])

  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--bg1, var(--bg))', color: 'var(--text1)', fontSize: 14, outline: 'none', width: '100%',
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(null)
    const rawCard = cardNumber.trim().replace(/^0+/, '') || cardNumber.trim()
    if (!rawCard || !/^\d+$/.test(rawCard)) { setError('El número de tarjeta debe ser decimal'); setSaving(false); return }
    try {
      if (type === 'employee') {
        if (!employeeId) { setError('Selecciona un empleado'); setSaving(false); return }
        const d = await apiFetch('/api/zkteco/enroll', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'employee', cardNumber: rawCard, employeeId }),
        })
        ok(`Tarjeta enrollada para ${d.data.name} (PIN ${d.data.pin})`); reset()
      } else if (type === 'temp') {
        if (!tempName.trim()) { setError('Introduce un nombre'); setSaving(false); return }
        const pin = tempPin.trim() || undefined
        const d = await apiFetch('/api/zkteco/enroll', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'temp', cardNumber: rawCard, name: tempName.trim(), pin }),
        })
        ok(`Tarjeta temporal enrollada (PIN ${d.data.pin})`); reset()
      } else {
        if (!resvInfo) { setError('Busca primero una reserva válida'); setSaving(false); return }
        await apiFetch(`/api/zkteco/enroller/${resvInfo.id}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card_no: rawCard }),
        })
        const label = resvInfo.card_count === 0 ? 'Tarjeta enrollada' : `Tarjeta extra enrollada (${resvInfo.card_count + 1}ª)`
        ok(`${label} en reserva #${resvInfo.id} — ${resvInfo.guest_name}`); reset()
      }
      onDone()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  function reset() {
    setCardNumber(''); setEmployeeId(''); setTempName(''); setTempPin('')
    setResvId(''); setResvInfo(null)
  }

  async function handleRevoke(userId: string, name: string) {
    if (!confirm(`¿Revocar acceso de "${name}" (PIN ${userId})?`)) return
    setRevokingId(userId)
    try {
      await apiFetch(`/api/zkteco/cards/${userId}`, { method: 'DELETE' })
      ok(`Tarjeta de ${name} revocada`); onDone()
    } catch (e: any) { setError(e.message) }
    finally { setRevokingId(null) }
  }

  const manualCards = cards.filter(c => c.card_type === 'employee' || c.card_type === 'temp')

  const thM: React.CSSProperties = { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text3)', padding: '8px 12px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
  const tdM = (extra?: React.CSSProperties): React.CSSProperties => ({ padding: '9px 12px', borderBottom: '1px solid var(--border-subtle, var(--border))', fontSize: 13, verticalAlign: 'middle', ...extra })

  const typeBtn = (t: EnrollType, label: string) => (
    <button type="button"
      onClick={() => { setType(t); reset() }}
      style={{
        padding: '7px 18px', borderRadius: 8, border: '1px solid var(--border)',
        cursor: 'pointer', fontSize: 13, fontWeight: 600,
        background: type === t ? 'var(--accent)' : 'var(--bg2)',
        color: type === t ? '#fff' : 'var(--text1)',
        transition: 'all .15s',
      }}>
      {label}
    </button>
  )

  return (
    <>
    <div className="card" style={{ maxWidth: 520 }}>
      <h2 style={{ margin: '0 0 20px', fontSize: 15, fontWeight: 600 }}>Enrollar tarjeta manualmente</h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {typeBtn('employee',    'Empleado')}
        {typeBtn('temp',        'Temporal')}
        {typeBtn('reservation', 'Reserva')}
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {type === 'employee' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>Empleado</span>
            <select style={{ ...inputStyle }} value={employeeId} onChange={e => setEmployeeId(Number(e.target.value) || '')}>
              <option value="">— Selecciona un empleado —</option>
              {employees.map(u => (
                <option key={u.id} value={u.id}>
                  {u.firstName} {u.lastName} ({u.roles.join(', ')})
                </option>
              ))}
            </select>
            {employeeId !== '' && (
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                PIN ZKTeco: {90_000_000_000 + Number(employeeId)}
              </span>
            )}
          </label>
        )}

        {type === 'temp' && (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Nombre</span>
              <input style={inputStyle} placeholder="Ej: Técnico instalación, Visita proveedor…"
                value={tempName} onChange={e => setTempName(e.target.value)} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>PIN ZKTeco <span style={{ fontWeight: 400, color: 'var(--text2)' }}>(opcional — se auto-genera si se deja vacío)</span></span>
              <input style={inputStyle} placeholder="Ej: 9999 — solo dígitos, máx. 10"
                value={tempPin} onChange={e => setTempPin(e.target.value.replace(/\D/g, '').slice(0, 10))} />
            </label>
          </>
        )}

        {type === 'reservation' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>Nº de reserva</span>
            <input style={inputStyle} placeholder="ID de reserva…"
              value={resvId} onChange={e => setResvId(e.target.value.replace(/\D/g, ''))} />
            {lookingUp && <span style={{ fontSize: 12, color: 'var(--text2)' }}>Buscando…</span>}
            {resvInfo && (
              <div style={{ marginTop: 4, padding: '8px 12px', background: 'var(--bg2)', borderRadius: 8, fontSize: 12, lineHeight: 1.6 }}>
                <strong>{resvInfo.guest_name || '—'}</strong> · Hab. {resvInfo.room || '—'}<br />
                {resvInfo.check_in} → {resvInfo.check_out}
                {resvInfo.card_count > 0 && (
                  <span style={{ marginLeft: 8, color: 'var(--yellow, #d97706)', fontWeight: 600 }}>
                    ⚠ {resvInfo.card_count} tarjeta{resvInfo.card_count > 1 ? 's' : ''} ya enrollada{resvInfo.card_count > 1 ? 's' : ''} — se añadirá una más
                  </span>
                )}
              </div>
            )}
            {resvId && !lookingUp && !resvInfo && (
              <span style={{ fontSize: 12, color: 'var(--red, #ef4444)' }}>Reserva no encontrada</span>
            )}
          </label>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>Nº de tarjeta <span style={{ fontWeight: 400, color: 'var(--text2)' }}>(decimal — como aparece en el lector)</span></span>
          <input style={inputStyle} placeholder="Ej: 5533773"
            value={cardNumber} onChange={e => setCardNumber(e.target.value.replace(/\D/g, ''))} />
        </label>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" className="btn btn-ghost" onClick={reset} disabled={saving}>Limpiar</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !cardNumber}>
            {saving ? 'Enrollando…' : 'Enrollar tarjeta'}
          </button>
        </div>
      </form>
    </div>

    {/* Lista de tarjetas manuales (empleado + temporal) */}
    <div className="card" style={{ marginTop: 20 }}>
      <h2 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>
        Tarjetas enrolladas manualmente
        {manualCards.length > 0 && (
          <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--text2)', fontSize: 13 }}>{manualCards.length}</span>
        )}
      </h2>
      {manualCards.length === 0 ? (
        <p style={{ color: 'var(--text2)', fontSize: 13, margin: 0 }}>No hay tarjetas de empleado ni temporales registradas</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg2)' }}>
                <th style={thM}>Tipo</th>
                <th style={thM}>Nombre</th>
                <th style={thM}>PIN ZKTeco</th>
                <th style={thM}>Nº Tarjeta</th>
                <th style={thM}></th>
              </tr>
            </thead>
            <tbody>
              {manualCards.map(c => (
                <tr key={c.user_id} style={{ transition: 'background .1s' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}>
                  <td style={tdM()}>
                    {c.card_type === 'employee' ? (
                      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: 'rgba(34,197,94,.15)', color: 'var(--green)' }}>Empleado</span>
                    ) : (
                      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: 'rgba(245,158,11,.15)', color: 'var(--yellow, #d97706)' }}>Temporal</span>
                    )}
                  </td>
                  <td style={tdM()}>{c.name || '—'}</td>
                  <td style={tdM()}>
                    <code style={{ fontSize: 11, color: 'var(--text2)' }}>{c.user_id}</code>
                  </td>
                  <td style={tdM()}>
                    <code style={{ fontSize: 11, color: 'var(--text2)' }}>{c.card_number}</code>
                  </td>
                  <td style={tdM({ textAlign: 'right' })}>
                    <button className="btn btn-danger btn-xs" disabled={revokingId === c.user_id}
                      onClick={() => handleRevoke(c.user_id, c.name)}>
                      {revokingId === c.user_id ? '…' : 'Revocar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </>
  )
}

export default function ZktecoView() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const admin = canManage(user)
  const [tab, setTab] = useState<'tarjetas' | 'accesos' | 'enrollar' | 'config'>('tarjetas')
  const [status,      setStatus]      = useState<Status | null>(null)
  const [events,      setEvents]      = useState<AccessEvent[]>([])
  const [cards,       setCards]       = useState<Card[]>([])
  const [openingDoor, setOpeningDoor] = useState<number | null>(null)
  const [syncing,     setSyncing]     = useState(false)
  const [deletingId,  setDeletingId]  = useState<string | null>(null)
  const [error,       setError]       = useState<string | null>(null)
  const [toast,       setToast]       = useState<string | null>(null)
  const [cardEnroll,  setCardEnroll]  = useState<boolean | null>(null)
  const [savingCfg,   setSavingCfg]   = useState(false)

  const [cardSearch,       setCardSearch]       = useState('')
  const [cardInactiveDays, setCardInactiveDays] = useState(0)
  const [cardsPage,        setCardsPage]        = useState(0)

  const [evtSearch,  setEvtSearch]  = useState('')
  const [evtDoor,    setEvtDoor]    = useState(0)
  const [evtType,    setEvtType]    = useState('all')
  const [evtDir,     setEvtDir]     = useState('all')
  const [eventsPage, setEventsPage] = useState(0)

  function ok(msg: string) { setToast(msg); setTimeout(() => setToast(null), 3000) }

  async function apiFetch(path: string, opts?: RequestInit) {
    const r = await fetch(path, { credentials: 'include', ...opts })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error ?? body.detail ?? `Error ${r.status}`)
    return body
  }

  const loadStatus = useCallback(async () => {
    try { setStatus(await apiFetch('/api/zkteco/status')) }
    catch { setStatus({ configured: false }) }
  }, [])

  const loadEvents = useCallback(async () => {
    try { setEvents((await apiFetch(`/api/zkteco/events?limit=${EVENTS_LOAD}&offset=0`)).data ?? []) }
    catch (e: any) { setError(e.message) }
  }, [])

  const loadCards = useCallback(async () => {
    try { setCards((await apiFetch('/api/zkteco/cards')).data ?? []) }
    catch (e: any) { setError(e.message) }
  }, [])

  const loadConfig = useCallback(async () => {
    try {
      const d = await apiFetch('/api/zkteco/config')
      setCardEnroll(d.ttlockCardEnrollEnabled)
    } catch {}
  }, [])

  useEffect(() => {
    loadStatus(); loadEvents(); loadCards(); loadConfig()
    const t = setInterval(() => { loadStatus(); loadEvents() }, 30_000)
    return () => clearInterval(t)
  }, [])

  const { lastSeenMap, usageCountMap } = useMemo(() => {
    const ls: Record<string, string> = {}
    const uc: Record<string, number> = {}
    for (const e of events) {
      if (e.card_no && e.card_no !== '0' && e.timestamp) {
        if (!ls[e.card_no] || e.timestamp > ls[e.card_no]) ls[e.card_no] = e.timestamp
        uc[e.card_no] = (uc[e.card_no] ?? 0) + 1
      }
    }
    return { lastSeenMap: ls, usageCountMap: uc }
  }, [events])

  // user_id → card info (para mostrar nombre de empleados/temporales en el log)
  const cardInfoMap = useMemo(() =>
    Object.fromEntries(cards.map(c => [c.user_id, c]))
  , [cards])

  const filteredCards = useMemo(() => {
    const q = cardSearch.toLowerCase()
    const now = Date.now()
    return cards.filter(c => {
      if (q && !c.user_id.toLowerCase().includes(q) && !c.name?.toLowerCase().includes(q) && !c.card_number.toLowerCase().includes(q)) return false
      if (cardInactiveDays > 0) {
        const ls = lastSeenMap[c.card_number]
        if (!ls) return true
        if ((now - new Date(ls).getTime()) / 86400000 < cardInactiveDays) return false
      }
      return true
    })
  }, [cards, cardSearch, cardInactiveDays, lastSeenMap])

  const pagedCards = filteredCards.slice(cardsPage * CARDS_PAGE, (cardsPage + 1) * CARDS_PAGE)

  const filteredEvents = useMemo(() => {
    const q = evtSearch.toLowerCase()
    return events.filter(e => {
      if (q && !e.card_no?.toLowerCase().includes(q) && !e.user_id?.toLowerCase().includes(q) && !e.room_code?.toLowerCase().includes(q)) return false
      if (evtDoor > 0 && e.door !== evtDoor) return false
      if (evtType === 'access' && e.event_type !== 0) return false
      if (evtType === 'error'  && e.event_type === 0) return false
      if (evtDir  === 'entry'  && e.in_out !== 0)     return false
      if (evtDir  === 'exit'   && e.in_out !== 1)     return false
      return true
    })
  }, [events, evtSearch, evtDoor, evtType, evtDir])

  const pagedEvents = filteredEvents.slice(eventsPage * EVENTS_PAGE, (eventsPage + 1) * EVENTS_PAGE)

  async function handleOpenDoor(n: number) {
    setOpeningDoor(n); setError(null)
    try { await apiFetch(`/api/zkteco/doors/${n}/open`, { method: 'POST' }); ok(`Puerta ${n} abierta`) }
    catch (e: any) { setError(e.message) }
    finally { setOpeningDoor(null) }
  }

  async function handleSync() {
    setSyncing(true); setError(null)
    try { await apiFetch('/api/zkteco/sync', { method: 'POST' }); ok('Sincronización completada'); loadCards() }
    catch (e: any) { setError(e.message) }
    finally { setSyncing(false) }
  }

  async function handleDeleteCard(userId: string) {
    if (!confirm(`¿Eliminar tarjeta del usuario ${userId} del C3-400?`)) return
    setDeletingId(userId); setError(null)
    try {
      await apiFetch(`/api/zkteco/cards/${userId}`, { method: 'DELETE' })
      ok(`Usuario ${userId} eliminado del C3-400`)
      setCards(prev => prev.filter(c => c.user_id !== userId))
    } catch (e: any) { setError(e.message) }
    finally { setDeletingId(null) }
  }

  const connected = status?.configured && status?.reachable

  const inputStyle: React.CSSProperties = {
    padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--bg1, var(--bg))', color: 'var(--text1)', fontSize: 13, outline: 'none',
  }
  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

  // Shared cell style helpers
  const th: React.CSSProperties = { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text3)', padding: '8px 12px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
  const td = (extra?: React.CSSProperties): React.CSSProperties => ({ padding: '9px 12px', borderBottom: '1px solid var(--border-subtle, var(--border))', fontSize: 13, verticalAlign: 'middle', ...extra })

  return (
    <div className="view-container" style={{ maxWidth: 1100 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Accesos Hotel — ZKTeco C3-400</h1>
        {status === null ? null : !status.configured ? (
          <span className="badge badge-cancelled">Sin configurar</span>
        ) : connected ? (
          <span className="badge badge-checkedin">Conectado · {status.ip}</span>
        ) : (
          <span className="badge badge-checking-out">Sin sesión</span>
        )}
      </div>

      {!status?.configured && status !== null && (
        <div style={{ marginBottom: 20, padding: '14px 18px', background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 8, fontSize: 13 }}>
          <strong>ZKTECO_BRIDGE_URL</strong> no está definido en <code>.env</code>.<br />
          Añade <code>ZKTECO_BRIDGE_URL</code>, <code>ZKTECO_BRIDGE_KEY</code> y reinicia el servidor.
        </div>
      )}

      {error && (
        <div className="alert-error" style={{ marginBottom: 16 }}>{error}
          <button onClick={() => setError(null)} style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, background: 'var(--green)', color: '#fff', padding: '10px 18px', borderRadius: 8, fontWeight: 600, zIndex: 9999, boxShadow: '0 4px 16px rgba(0,0,0,.25)' }}>
          {toast}
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="hk-tabs" style={{ marginBottom: 20 }}>
        <button className={`hk-tab${tab === 'tarjetas' ? ' active' : ''}`} onClick={() => setTab('tarjetas')}>
          Tarjetas
        </button>
        <button className={`hk-tab${tab === 'accesos' ? ' active' : ''}`} onClick={() => setTab('accesos')}>
          Accesos
        </button>
        {admin && (
          <button className={`hk-tab${tab === 'enrollar' ? ' active' : ''}`} onClick={() => setTab('enrollar')}>
            Enrollar tarjeta
          </button>
        )}
        {admin && (
          <button className={`hk-tab${tab === 'config' ? ' active' : ''}`} onClick={() => setTab('config')}>
            Configuración
          </button>
        )}
      </div>

      {/* ── Pestaña Tarjetas ── */}
      {tab === 'tarjetas' && (<>

      {/* Puertas */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text2)' }}>Control de puertas</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[1, 2, 3, 4].map(n => (
            <button key={n} className="btn btn-primary" style={{ minWidth: 110 }}
              disabled={!connected || openingDoor !== null} onClick={() => handleOpenDoor(n)}>
              {openingDoor === n ? 'Abriendo…' : `Puerta ${n}`}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tarjetas registradas ─────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            Tarjetas registradas
            {cards.length > 0 && (
              <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--text2)', fontSize: 13 }}>
                {filteredCards.length < cards.length ? `${filteredCards.length} / ${cards.length}` : cards.length}
              </span>
            )}
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={handleSync} disabled={syncing || !connected}>
            {syncing ? 'Sincronizando…' : '↻ Sincronizar C3-400'}
          </button>
        </div>

        <FilterBar
          active={!!(cardSearch || cardInactiveDays > 0)}
          onClear={() => { setCardSearch(''); setCardInactiveDays(0); setCardsPage(0) }}
        >
          <input style={{ ...inputStyle, minWidth: 220 }} placeholder="Buscar reserva, nombre o tarjeta…"
            value={cardSearch} onChange={e => { setCardSearch(e.target.value); setCardsPage(0) }} />
          <select style={selectStyle} value={cardInactiveDays}
            onChange={e => { setCardInactiveDays(Number(e.target.value)); setCardsPage(0) }}>
            <option value={0}>Todas las tarjetas</option>
            <option value={7}>Sin usar +7 días</option>
            <option value={30}>Sin usar +30 días</option>
            <option value={60}>Sin usar +60 días</option>
            <option value={90}>Sin usar +90 días</option>
          </select>
        </FilterBar>

        {cards.length === 0 ? (
          <p style={{ color: 'var(--text2)', fontSize: 13, margin: 0 }}>Sin tarjetas registradas</p>
        ) : filteredCards.length === 0 ? (
          <p style={{ color: 'var(--text2)', fontSize: 13, margin: 0 }}>Sin resultados para los filtros aplicados</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg2)' }}>
                    <th style={th}>Reserva</th>
                    <th style={th}>Hab.</th>
                    <th style={th}>Nombre</th>
                    <th style={th}>Nº Tarjeta</th>
                    <th style={{ ...th, textAlign: 'right' }}>Última vista</th>
                    <th style={{ ...th, textAlign: 'right' }}>Usos</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedCards.map(c => {
                    const ls = lastSeenMap[c.card_number]
                    const daysSince = ls ? (Date.now() - new Date(ls).getTime()) / 86400000 : null
                    const stale = daysSince === null || daysSince > 30
                    const uses  = usageCountMap[c.card_number] ?? 0
                    return (
                      <tr key={c.user_id} style={{ transition: 'background .1s' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
                        onMouseLeave={e => (e.currentTarget.style.background = '')}>
                        <td style={td()}>
                          {c.card_type === 'employee' || c.card_type === 'temp'
                            ? <code style={{ fontSize: 11, color: 'var(--text2)' }}>{c.user_id}</code>
                            : (() => {
                                const pin = Number(c.user_id)
                                const resvId = pin >= 1_000_000_000 ? String(pin % 1_000_000_000) : c.user_id
                                return (
                                  <a href="#" onClick={e => { e.preventDefault(); navigate(`/reservations/${resvId}`) }}
                                    style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>
                                    #{resvId}{pin >= 1_000_000_000 && <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 3 }}>+ext</span>}
                                  </a>
                                )
                              })()}
                        </td>
                        <td style={td()}>
                          {c.room_code
                            ? <span className="badge">{c.room_code}</span>
                            : <span style={{ color: 'var(--text3)' }}>—</span>}
                        </td>
                        <td style={td({ color: c.name ? 'var(--text1)' : 'var(--text3)' })}>
                          {c.name || '—'}
                        </td>
                        <td style={td()}>
                          <code style={{ fontSize: 11, color: 'var(--text2)' }}>{c.card_number}</code>
                        </td>
                        <td style={td({ textAlign: 'right' })}>
                          {ls ? (
                            <span title={ls.slice(0, 16).replace('T', ' ')}
                              style={{ fontSize: 12, color: stale ? 'var(--yellow, #d97706)' : 'var(--text2)' }}>
                              {relativeTime(ls)}
                            </span>
                          ) : (
                            <span style={{ fontSize: 12, color: 'var(--text3)' }}>Nunca</span>
                          )}
                        </td>
                        <td style={td({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>
                          <span style={{
                            display: 'inline-block', minWidth: 28, textAlign: 'center',
                            padding: '1px 6px', borderRadius: 10, fontSize: 12, fontWeight: 600,
                            background: uses === 0 ? 'var(--bg2)' : 'rgba(59,130,246,.12)',
                            color: uses === 0 ? 'var(--text3)' : 'var(--blue, #3b82f6)',
                          }}>
                            {uses}
                          </span>
                        </td>
                        <td style={td({ textAlign: 'right' })}>
                          <button className="btn btn-danger btn-xs" disabled={deletingId === c.user_id}
                            onClick={() => handleDeleteCard(c.user_id)}>
                            {deletingId === c.user_id ? '…' : 'Eliminar'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={cardsPage} total={filteredCards.length} perPage={CARDS_PAGE} onChange={setCardsPage} />
          </>
        )}
      </div>

      </>)}

      {/* ── Pestaña Accesos ── */}
      {tab === 'accesos' && (
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            Log de accesos
            {events.length > 0 && (
              <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--text2)', fontSize: 13 }}>
                {filteredEvents.length < events.length ? `${filteredEvents.length} / ${events.length}` : events.length} registros
              </span>
            )}
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={loadEvents}>↺ Actualizar</button>
        </div>

        <FilterBar
          active={!!(evtSearch || evtDoor > 0 || evtType !== 'all' || evtDir !== 'all')}
          onClear={() => { setEvtSearch(''); setEvtDoor(0); setEvtType('all'); setEvtDir('all'); setEventsPage(0) }}
        >
          <input style={{ ...inputStyle, minWidth: 180 }} placeholder="Tarjeta, reserva o habitación…"
            value={evtSearch} onChange={e => { setEvtSearch(e.target.value); setEventsPage(0) }} />
          <select style={selectStyle} value={evtDoor} onChange={e => { setEvtDoor(Number(e.target.value)); setEventsPage(0) }}>
            <option value={0}>Todas las puertas</option>
            {[1,2,3,4].map(n => <option key={n} value={n}>Puerta {n}</option>)}
          </select>
          <select style={selectStyle} value={evtType} onChange={e => { setEvtType(e.target.value); setEventsPage(0) }}>
            <option value="all">Todos los eventos</option>
            <option value="access">Solo accesos</option>
            <option value="error">Solo errores/alertas</option>
          </select>
          <select style={selectStyle} value={evtDir} onChange={e => { setEvtDir(e.target.value); setEventsPage(0) }}>
            <option value="all">Entrada y salida</option>
            <option value="entry">Solo entrada</option>
            <option value="exit">Solo salida</option>
          </select>
        </FilterBar>

        {events.length === 0 ? (
          <p style={{ color: 'var(--text2)', fontSize: 13, margin: 0 }}>Sin registros</p>
        ) : filteredEvents.length === 0 ? (
          <p style={{ color: 'var(--text2)', fontSize: 13, margin: 0 }}>Sin resultados para los filtros aplicados</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg2)' }}>
                    <th style={th}>Hora</th>
                    <th style={th}>Puerta</th>
                    <th style={th}>Tarjeta</th>
                    <th style={th}>Reserva</th>
                    <th style={th}>Hab.</th>
                    <th style={th}>Evento</th>
                    <th style={th}>Dir.</th>
                    <th style={{ ...th, textAlign: 'right' }}>Última vista</th>
                    <th style={{ ...th, textAlign: 'right' }}>Usos</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedEvents.map(e => {
                    const label   = EVENT_LABELS[String(e.event_type)] ?? `Evento ${e.event_type}`
                    const eColor  = eventColor(e.event_type)
                    const isEntry = e.in_out === 0
                    const isExit  = e.in_out === 1
                    const cardNo  = e.card_no && e.card_no !== '0' ? e.card_no : null
                    const ls      = cardNo ? lastSeenMap[cardNo] : null
                    const uses    = cardNo ? (usageCountMap[cardNo] ?? 0) : null
                    const stale   = ls ? (Date.now() - new Date(ls).getTime()) / 86400000 > 30 : false
                    return (
                      <tr key={e.id} style={{ transition: 'background .1s' }}
                        onMouseEnter={ev => (ev.currentTarget.style.background = 'var(--bg2)')}
                        onMouseLeave={ev => (ev.currentTarget.style.background = '')}>
                        <td style={td({ color: 'var(--text2)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' })}>
                          {e.timestamp?.slice(0, 16).replace('T', ' ')}
                        </td>
                        <td style={td()}>
                          {e.door ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', background: 'var(--bg2)', border: '1px solid var(--border)', fontWeight: 700, fontSize: 12 }}>
                              {e.door}
                            </span>
                          ) : <span style={{ color: 'var(--text3)' }}>—</span>}
                        </td>
                        <td style={td()}>
                          <code style={{ fontSize: 11, color: cardNo ? 'var(--text1)' : 'var(--text3)' }}>
                            {cardNo ?? '—'}
                          </code>
                        </td>
                        <td style={td()}>
                          {(() => {
                            const uid = e.user_id
                            if (!uid || uid === '0') return <span style={{ color: 'var(--text3)' }}>—</span>
                            const cardInfo = cardInfoMap[uid]
                            if (cardInfo?.card_type === 'employee' || cardInfo?.card_type === 'temp') {
                              return (
                                <span style={{ fontSize: 12 }}>
                                  <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 8, fontSize: 10, fontWeight: 600, marginRight: 5,
                                    background: cardInfo.card_type === 'employee' ? 'rgba(34,197,94,.15)' : 'rgba(245,158,11,.15)',
                                    color:      cardInfo.card_type === 'employee' ? 'var(--green)'         : 'var(--yellow, #d97706)' }}>
                                    {cardInfo.card_type === 'employee' ? 'Emp.' : 'Temp.'}
                                  </span>
                                  {cardInfo.name || uid}
                                </span>
                              )
                            }
                            const pin = Number(uid)
                            const resvId = pin >= 1_000_000_000 ? String(pin % 1_000_000_000) : uid
                            return (
                              <a href="#" onClick={ev => { ev.preventDefault(); navigate(`/reservations/${resvId}`) }}
                                style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>
                                #{resvId}{pin >= 1_000_000_000 && <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 3 }}>+ext</span>}
                              </a>
                            )
                          })()}
                        </td>
                        <td style={td()}>
                          {e.room_code
                            ? <span className="badge">{e.room_code}</span>
                            : <span style={{ color: 'var(--text3)' }}>—</span>}
                        </td>
                        <td style={td()}>
                          <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: eColor.bg, color: eColor.color, whiteSpace: 'nowrap' }}>
                            {label}
                          </span>
                        </td>
                        <td style={td()}>
                          {isEntry ? <span style={{ color: 'var(--green)', fontWeight: 600, fontSize: 12 }}>↓ Entrada</span>
                           : isExit ? <span style={{ color: 'var(--blue)',  fontWeight: 600, fontSize: 12 }}>↑ Salida</span>
                           : <span style={{ color: 'var(--text3)' }}>—</span>}
                        </td>
                        <td style={td({ textAlign: 'right' })}>
                          {ls ? (
                            <span title={ls.slice(0, 16).replace('T', ' ')}
                              style={{ fontSize: 12, color: stale ? 'var(--yellow, #d97706)' : 'var(--text2)' }}>
                              {relativeTime(ls)}
                            </span>
                          ) : (
                            <span style={{ fontSize: 12, color: 'var(--text3)' }}>—</span>
                          )}
                        </td>
                        <td style={td({ textAlign: 'right' })}>
                          {uses !== null ? (
                            <span style={{
                              display: 'inline-block', minWidth: 28, textAlign: 'center',
                              padding: '1px 6px', borderRadius: 10, fontSize: 12, fontWeight: 600,
                              background: uses === 0 ? 'var(--bg2)' : 'rgba(59,130,246,.12)',
                              color: uses === 0 ? 'var(--text3)' : 'var(--blue, #3b82f6)',
                            }}>
                              {uses}
                            </span>
                          ) : <span style={{ color: 'var(--text3)' }}>—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={eventsPage} total={filteredEvents.length} perPage={EVENTS_PAGE} onChange={setEventsPage} />
            {events.length >= EVENTS_LOAD && (
              <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 10, marginBottom: 0, textAlign: 'center' }}>
                Mostrando los últimos {EVENTS_LOAD.toLocaleString()} registros — usa los filtros para acotar la búsqueda.
              </p>
            )}
          </>
        )}
      </div>

      )}

      {/* ── Pestaña Enrollar tarjeta (solo admin) ── */}
      {tab === 'enrollar' && admin && (
        <EnrollarTab apiFetch={apiFetch} ok={ok} setError={setError} onDone={loadCards} cards={cards} />
      )}

      {/* ── Pestaña Configuración (solo admin) ── */}
      {tab === 'config' && admin && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Enrolar tarjeta IC en TTLock al hacer check-in</div>
              <div style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 480 }}>
                Cuando el enrolador registra una tarjeta Mifare (código completo de 4 bytes) y la habitación tiene cerradura TTLock configurada,
                se añade automáticamente la tarjeta a la cerradura vía gateway.
                Solo aplica a tarjetas Mifare HF (no T5577 ni entrada manual).
              </div>
            </div>
            <button
              disabled={cardEnroll === null || savingCfg}
              onClick={async () => {
                const next = !cardEnroll
                setSavingCfg(true)
                try {
                  await apiFetch('/api/zkteco/config', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ttlockCardEnrollEnabled: next }),
                  })
                  setCardEnroll(next)
                  ok(next ? 'Enroll TTLock activado' : 'Enroll TTLock desactivado')
                } catch (e: any) { setError(e.message) }
                finally { setSavingCfg(false) }
              }}
              style={{
                flexShrink: 0, marginLeft: 24,
                width: 48, height: 26, borderRadius: 13,
                border: 'none', cursor: cardEnroll === null ? 'default' : 'pointer',
                background: cardEnroll ? 'var(--green, #22c55e)' : 'var(--border)',
                transition: 'background .2s',
                position: 'relative',
              }}
            >
              <span style={{
                position: 'absolute', top: 3,
                left: cardEnroll ? 26 : 4,
                width: 20, height: 20, borderRadius: '50%',
                background: '#fff', transition: 'left .2s',
                boxShadow: '0 1px 3px rgba(0,0,0,.3)',
              }} />
            </button>
          </div>
        </div>
      )}

    </div>
  )
}
