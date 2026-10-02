import { useState, useEffect, useCallback } from 'react'
import { useAuth, canManage } from '../contexts/AuthContext'
import { toast } from '../lib/utils'
import { armBreakfastLock } from '../components/BreakfastLockGuard'

const API = (path: string) => fetch(`/api/housekeeping${path}`, { credentials: 'include' })
const PATCH = (path: string, body: any) =>
  fetch(`/api/housekeeping${path}`, {
    method: 'PATCH', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

interface Task {
  id: number
  roomId: number
  roomCode: string
  taskType: 'stay' | 'departure'
  assignedTo: number | null
  status: 'pending' | 'done' | 'dnd'
  linenChanges: string[]
  dnd: boolean
  notes: string | null
  completedAt: string | null
  stolenItemsReported: boolean
  checkedOut: boolean
}

interface Cleaner { id: number; firstName: string; lastName: string }

interface CommonArea {
  id: number
  key: string
  label: string
  isBathroom: boolean
  assignedTo: number | null
  assignedToName: string | null
  status: 'pending' | 'done'
  completedAt: string | null
  completedByName: string | null
  paperRefilledAt: string | null
  paperRefilledByName: string | null
}

function fmtDate(d: string) {
  const [y, m, day] = d.split('-')
  const names = ['dom','lun','mar','mié','jue','vie','sáb']
  const wd = new Date(d + 'T12:00:00').getDay()
  return `${names[wd]} ${day}/${m}/${y}`
}

function shiftDate(d: string, delta: number) {
  const dt = new Date(d + 'T12:00:00')
  dt.setDate(dt.getDate() + delta)
  return dt.toISOString().slice(0, 10)
}

export default function HousekeepingView() {
  const { user } = useAuth()
  const admin     = canManage(user)
  const todayStr  = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date())

  const [date,      setDate]      = useState(todayStr)
  const [tab,       setTab]       = useState<'stay' | 'departure' | 'common-areas' | 'breakfast'>('stay')
  const [tasks,     setTasks]     = useState<Task[]>([])
  const [cleaners,  setCleaners]  = useState<Cleaner[]>([])
  const [loading,   setLoading]   = useState(true)
  const [selected,  setSelected]  = useState<Set<number>>(new Set())
  const [onlyMine,  setOnlyMine]  = useState(false)
  const [breakfast, setBreakfast] = useState<{ rateBreakfasts: any[]; extraBreakfasts: any[]; noService: boolean; serviceRating?: { rating: number; notes: string | null } | null } | null>(null)
  const [bfLoading, setBfLoading] = useState(false)
  const [commonAreas,   setCommonAreas]   = useState<CommonArea[]>([])
  const [caCleaners,    setCaCleaners]    = useState<Cleaner[]>([])
  const [caLoading,     setCaLoading]     = useState(false)
  const [caSelected,    setCaSelected]    = useState<Set<number>>(new Set())

  const load = useCallback(async (d = date) => {
    setLoading(true)
    try {
      const r = await API(`?date=${d}`)
      const j = await r.json()
      setTasks(j.data)
      setCleaners(j.cleaners)
    } catch { toast('Error cargando housekeeping', 'err') }
    finally { setLoading(false) }
  }, [date])

  const loadBreakfast = useCallback(async (d = date) => {
    setBfLoading(true)
    try {
      const r = await API(`/breakfast?date=${d}`)
      const j = await r.json()
      setBreakfast(j)
    } catch { toast('Error cargando desayunos', 'err') }
    finally { setBfLoading(false) }
  }, [date])

  const loadCommonAreas = useCallback(async (d = date) => {
    setCaLoading(true)
    try {
      const r = await API(`/common-areas?date=${d}`)
      const j = await r.json()
      setCommonAreas(j.data)
      setCaCleaners(j.cleaners)
    } catch { toast('Error cargando zonas comunes', 'err') }
    finally { setCaLoading(false) }
  }, [date])

  const patchCommonArea = async (id: number, body: Partial<CommonArea> & { paperRefilled?: boolean }) => {
    const r = await PATCH(`/common-areas/${id}`, body)
    const j = await r.json()
    if (!r.ok) { toast(j.error ?? 'Error', 'err'); return }
    loadCommonAreas(date)
  }

  const toggleCaSelect = (id: number) =>
    setCaSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const assignCaBulk = async (assignedTo: number | null) => {
    if (caSelected.size === 0) return
    const r = await fetch('/api/housekeeping/common-areas/assign-bulk', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, taskIds: [...caSelected], assignedTo }),
    })
    const j = await r.json()
    if (!r.ok) { toast(j.error ?? 'Error', 'err'); return }
    toast(`${j.count} zona(s) asignadas`)
    setCaSelected(new Set())
    loadCommonAreas(date)
  }

  const toggleNoService = async () => {
    if (!breakfast) return
    const method = breakfast.noService ? 'DELETE' : 'POST'
    await fetch('/api/housekeeping/breakfast/no-service', {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
    })
    loadBreakfast(date)
  }

  const toggleServed = async (reservationId: number, served: boolean, extraId?: number | null) => {
    const method = served ? 'DELETE' : 'POST'
    await fetch('/api/housekeeping/breakfast/serve', {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservationId, date, extraId: extraId ?? null }),
    })
    loadBreakfast(date)
  }

  useEffect(() => { load(date) }, [date])
  useEffect(() => { if (tab === 'breakfast') { loadBreakfast(date); if (date === todayStr && user) armBreakfastLock(user.id) } }, [date, tab])
  useEffect(() => { if (tab === 'common-areas') loadCommonAreas(date) }, [date, tab])

  useEffect(() => {
    const id = setInterval(() => {
      load(date)
      if (tab === 'breakfast')      loadBreakfast(date)
      if (tab === 'common-areas')   loadCommonAreas(date)
    }, 60_000)
    return () => clearInterval(id)
  }, [date, tab, load, loadBreakfast, loadCommonAreas])

  const patch = async (id: number, body: Partial<Task>) => {
    const r = await PATCH(`/${id}`, body)
    const j = await r.json()
    if (!r.ok) { toast(j.error ?? 'Error', 'err'); return }
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...j.data } : t))
  }

  const toggleStolen = async (id: number, current: boolean) => {
    const r = await fetch(`/api/housekeeping/${id}/stolen-items`, { method: current ? 'DELETE' : 'POST', credentials: 'include' })
    const j = await r.json()
    if (!r.ok) { toast(j.error ?? 'Error', 'err'); return }
    toast(current ? 'Aviso de objetos robados quitado' : 'Marcado — se avisará hasta registrar un depósito nuevo o desmarcarlo')
    setTasks(prev => prev.map(t => t.id === id ? { ...t, stolenItemsReported: !current } : t))
  }

  const byTab          = tasks.filter(t => t.taskType === tab)
  const visible        = onlyMine ? byTab.filter(t => t.assignedTo === user?.id) : byTab
  const stayCount      = tasks.filter(t => t.taskType === 'stay').length
  const departureCount = tasks.filter(t => t.taskType === 'departure').length
  const doneCount      = visible.filter(t => t.status === 'done').length
  const isCleaner      = cleaners.some(c => c.id === user?.id)

  const toggleSelect = (id: number) =>
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const assignBulk = async (assignedTo: number | null) => {
    if (selected.size === 0) return
    const r = await fetch('/api/housekeeping/assign-bulk', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, taskIds: [...selected], assignedTo }),
    })
    const j = await r.json()
    if (!r.ok) { toast(j.error ?? 'Error', 'err'); return }
    toast(`${j.count} habitación(es) asignadas`)
    setSelected(new Set())
    load(date)
  }

  return (
    <div className="hk-view">
      {/* ── Cabecera ── */}
      <div className="view-header">
        <div>
          <h2>Housekeeping</h2>
          <p className="view-subtitle">{fmtDate(date)}</p>
        </div>
        <div className="hk-date-nav">
          <button className="btn btn-ghost btn-xs" onClick={() => setDate(d => shiftDate(d, -1))}>‹</button>
          <button className="btn btn-ghost btn-xs" onClick={() => setDate(todayStr)} disabled={date === todayStr}>Hoy</button>
          <button className="btn btn-ghost btn-xs" onClick={() => setDate(d => shiftDate(d, +1))}>›</button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="hk-tabs">
        <button className={`hk-tab${tab === 'stay' ? ' active' : ''}`} onClick={() => setTab('stay')}>
          Clientes <span className="hk-tab-count">{stayCount}</span>
        </button>
        <button className={`hk-tab${tab === 'departure' ? ' active' : ''}`} onClick={() => setTab('departure')}>
          Salidas <span className="hk-tab-count">{departureCount}</span>
        </button>
        <button className={`hk-tab${tab === 'common-areas' ? ' active' : ''}`} onClick={() => setTab('common-areas')}>
          Zonas Comunes
        </button>
        <button className={`hk-tab${tab === 'breakfast' ? ' active' : ''}`} onClick={() => setTab('breakfast')}>
          Desayunos
        </button>
        {isCleaner && (tab === 'stay' || tab === 'departure') && (
          <button
            className={`hk-tab${onlyMine ? ' active' : ''}`}
            onClick={() => setOnlyMine(v => !v)}
            style={{ marginLeft: 'auto' }}
          >
            Mis tareas
          </button>
        )}
        {(tab === 'stay' || tab === 'departure') && (
          <span className="hk-progress">
            {doneCount}/{visible.length} limpias
            {visible.length > 0 && (
              <span className="hk-progress-bar">
                <span style={{ width: `${(doneCount / visible.length) * 100}%` }} />
              </span>
            )}
          </span>
        )}
        {tab === 'common-areas' && commonAreas.length > 0 && (
          <span className="hk-progress">
            {commonAreas.filter(a => a.status === 'done').length}/{commonAreas.length} limpias
            <span className="hk-progress-bar">
              <span style={{ width: `${(commonAreas.filter(a => a.status === 'done').length / commonAreas.length) * 100}%` }} />
            </span>
          </span>
        )}
      </div>

      {/* ── Toolbar de asignación (solo admin) ── */}
      {admin && tab !== 'common-areas' && selected.size > 0 && (
        <div className="hk-assign-bar">
          <span>{selected.size} seleccionadas</span>
          <select defaultValue="" onChange={e => {
            const v = e.target.value
            assignBulk(v === '' ? null : Number(v))
            e.target.value = ''
          }}>
            <option value="" disabled>Asignar a…</option>
            <option value="">Sin asignar</option>
            {cleaners.map(c => (
              <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>
            ))}
          </select>
          <button className="btn btn-ghost btn-xs" onClick={() => setSelected(new Set())}>Cancelar</button>
        </div>
      )}
      {admin && tab === 'common-areas' && caSelected.size > 0 && (
        <div className="hk-assign-bar">
          <span>{caSelected.size} seleccionadas</span>
          <select defaultValue="" onChange={e => {
            const v = e.target.value
            assignCaBulk(v === '' ? null : Number(v))
            e.target.value = ''
          }}>
            <option value="" disabled>Asignar a…</option>
            <option value="">Sin asignar</option>
            {caCleaners.map(c => (
              <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>
            ))}
          </select>
          <button className="btn btn-ghost btn-xs" onClick={() => setCaSelected(new Set())}>Cancelar</button>
        </div>
      )}

      {/* ── Lista limpieza ── */}
      {(tab === 'stay' || tab === 'departure') && (
        loading ? (
          <div className="loading">Cargando…</div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <p>
              {onlyMine
                ? 'No tienes tareas asignadas para este día'
                : `No hay ${tab === 'stay' ? 'clientes' : 'salidas'} para este día`}
            </p>
          </div>
        ) : (
          <div className="hk-list">
            {visible.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                cleaners={cleaners}
                admin={admin}
                userId={user?.id ?? null}
                selected={selected.has(task.id)}
                isPast={date < todayStr}
                onSelect={() => toggleSelect(task.id)}
                onPatch={(body) => patch(task.id, body)}
                onToggleStolen={() => toggleStolen(task.id, task.stolenItemsReported)}
              />
            ))}
          </div>
        )
      )}

      {/* ── Pestaña Zonas Comunes ── */}
      {tab === 'common-areas' && (
        caLoading ? (
          <div className="loading">Cargando…</div>
        ) : (
          <div className="hk-list">
            {commonAreas.map(area => (
              <CommonAreaRow
                key={area.id}
                area={area}
                cleaners={caCleaners}
                admin={admin}
                userId={user?.id ?? null}
                selected={caSelected.has(area.id)}
                isPast={date < todayStr}
                onSelect={() => toggleCaSelect(area.id)}
                onPatch={(body) => patchCommonArea(area.id, body)}
              />
            ))}
          </div>
        )
      )}

      {/* ── Pestaña Desayunos ── */}
      {tab === 'breakfast' && (
        bfLoading ? (
          <div className="loading">Cargando…</div>
        ) : !breakfast ? null : (
          <div style={{ padding: '0 0 24px' }}>
            {/* Confirmación de no-servicio (solo hoy y cuando nada está servido) */}
            {date === todayStr && !breakfast.rateBreakfasts.some((r: any) => r.served) && !breakfast.extraBreakfasts.some((e: any) => e.served) && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 4px', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={breakfast.noService}
                  onChange={toggleNoService}
                  style={{ width: 16, height: 16, cursor: 'pointer' }}
                />
                <span style={{ fontSize: 14, color: breakfast.noService ? 'var(--text2)' : 'inherit', fontWeight: breakfast.noService ? 400 : 500 }}>
                  No se ha servido ningún desayuno
                </span>
              </label>
            )}
            {/* Incluidos en tarifa */}
            {breakfast.rateBreakfasts.length > 0 && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-header">
                  <h3 style={{ fontSize: 14, fontWeight: 600 }}>Incluido en tarifa</h3>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                    Total: {breakfast.rateBreakfasts.reduce((s: number, r: any) => s + (r.people ?? 1), 0)} desayunos
                  </span>
                </div>
                <table className="data-table">
                  <thead><tr>
                    <th>Hab.</th><th>Huésped</th><th>Tarifa</th>
                    <th style={{ textAlign: 'center' }}>Personas</th><th></th>
                  </tr></thead>
                  <tbody>
                    {breakfast.rateBreakfasts.map((r: any) => (
                      <tr key={r.reservation_id} style={{ opacity: r.served ? 0.6 : 1 }}>
                        <td>
                          <span className="badge">{r.room_code}{r.extra_room_codes ? `, ${r.extra_room_codes}` : ''}</span>
                        </td>
                        <td><strong>{r.first_name} {r.last_name}</strong></td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{r.rate_title}</td>
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>{r.people ?? 1}</td>
                        <td>
                          <button
                            className={`btn btn-sm ${r.served ? 'btn-ghost' : 'btn-green'}`}
                            onClick={() => toggleServed(r.reservation_id, r.served, null)}
                          >
                            {r.served ? '✓ Servido' : 'Servir'}
                          </button>
                          {r.served && r.served_by_name && (
                            <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2 }}>por {r.served_by_name}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Extras comprados */}
            {breakfast.extraBreakfasts.length > 0 && (
              <div className="card">
                <div className="card-header">
                  <h3 style={{ fontSize: 14, fontWeight: 600 }}>Extras comprados</h3>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                    Total: {breakfast.extraBreakfasts.reduce((s: number, e: any) => s + e.remaining, 0)} desayunos
                  </span>
                </div>
                <table className="data-table">
                  <thead><tr>
                    <th>Hab.</th><th>Huésped</th><th>Concepto</th>
                    <th style={{ textAlign: 'center' }} title="Personas de la reserva — cada vez que se sirve se descuentan tantas unidades como personas">Pers.</th>
                    <th style={{ textAlign: 'center' }}>Comprados</th>
                    <th style={{ textAlign: 'center' }}>Restantes</th><th></th>
                  </tr></thead>
                  <tbody>
                    {breakfast.extraBreakfasts.map((e: any) => (
                      <tr key={e.extra_id} style={{ opacity: e.served ? 0.6 : 1 }}>
                        <td><span className="badge">{e.room_code}</span></td>
                        <td><strong>{e.first_name} {e.last_name}</strong></td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{e.item_title}</td>
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>{e.people ?? 1}</td>
                        <td style={{ textAlign: 'center' }}>{e.quantity}</td>
                        <td style={{ textAlign: 'center' }}>
                          <span style={{
                            background: 'var(--accent)', color: '#fff',
                            borderRadius: 20, padding: '2px 10px', fontWeight: 700, fontSize: 13
                          }}>{e.remaining}</span>
                        </td>
                        <td>
                          <button
                            className={`btn btn-sm ${e.served ? 'btn-ghost' : 'btn-green'}`}
                            onClick={() => toggleServed(e.reservation_id, e.served, e.extra_id)}
                          >
                            {e.served ? '✓ Servido' : 'Servir'}
                          </button>
                          {e.served && e.served_by_name && (
                            <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2 }}>por {e.served_by_name}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {breakfast.rateBreakfasts.length === 0 && breakfast.extraBreakfasts.length === 0 && (
              <div className="empty"><p>Sin desayunos para este día</p></div>
            )}
          </div>
        )
      )}
    </div>
  )
}

// ─── Colores por limpiador ───────────────────────────────────────────────────

const CLEANER_COLORS = [
  { bg: 'rgba(99,179,237,0.13)',  border: 'rgba(99,179,237,0.45)'  }, // azul
  { bg: 'rgba(154,205,100,0.13)', border: 'rgba(154,205,100,0.45)' }, // verde
  { bg: 'rgba(246,173,85,0.13)',  border: 'rgba(246,173,85,0.45)'  }, // naranja
  { bg: 'rgba(183,148,244,0.13)', border: 'rgba(183,148,244,0.45)' }, // violeta
  { bg: 'rgba(252,129,129,0.13)', border: 'rgba(252,129,129,0.45)' }, // rojo
  { bg: 'rgba(76,210,200,0.13)',  border: 'rgba(76,210,200,0.45)'  }, // turquesa
  { bg: 'rgba(248,200,100,0.13)', border: 'rgba(248,200,100,0.45)' }, // amarillo
  { bg: 'rgba(160,174,192,0.13)', border: 'rgba(160,174,192,0.45)' }, // gris
]

function cleanerColor(cleaners: { id: number }[], cleanerId: number | null) {
  if (!cleanerId) return null
  const idx = cleaners.findIndex(c => c.id === cleanerId)
  return idx >= 0 ? CLEANER_COLORS[idx % CLEANER_COLORS.length] : null
}

// ─── Fila de tarea ──────────────────────────────────────────────────────────

const LINEN: { key: string; label: string }[] = [
  { key: 'sabanas',        label: 'Sábanas' },
  { key: 'toalla_grande',  label: 'T. Grande' },
  { key: 'toalla_pequena', label: 'T. Pequeña' },
  { key: 'almohada',       label: 'Almohada' },
  { key: 'funda_almohada', label: 'Funda' },
  { key: 'edredon',        label: 'Edredón' },
  { key: 'cojines',        label: 'Cojines' },
  { key: 'cortinas',       label: 'Cortinas' },
  { key: 'alfombrilla',    label: 'Alfombrilla' },
  { key: 'papel_hig',      label: 'Papel Hig.' },
]

function fmtTime(dt: string | null) {
  if (!dt) return null
  const d = new Date(dt)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function TaskRow({ task, cleaners, admin, userId, selected, isPast, onSelect, onPatch, onToggleStolen }: {
  task: Task
  cleaners: Cleaner[]
  admin: boolean
  userId: number | null
  selected: boolean
  isPast: boolean
  onSelect: () => void
  onPatch: (body: any) => void
  onToggleStolen: () => void
}) {
  const [showNotes, setShowNotes] = useState(false)
  const [noteText,  setNoteText]  = useState(task.notes ?? '')

  const isDone = task.status === 'done'
  const isDnd  = task.status === 'dnd' || task.dnd
  const isStay = task.taskType === 'stay'
  const checkoutTime = !isStay ? fmtTime(task.completedAt) : null
  const doneTime     = isDone ? fmtTime(task.completedAt) : null

  const toggleLinen = (key: string) => {
    const next = task.linenChanges.includes(key)
      ? task.linenChanges.filter(k => k !== key)
      : [...task.linenChanges, key]
    onPatch({ linenChanges: next })
  }

  const toggleDone = () => {
    if (isPast || isDnd) return
    onPatch({ status: isDone ? 'pending' : 'done' })
  }

  const toggleDnd = () => {
    onPatch({ status: isDnd ? 'pending' : 'dnd', dnd: !isDnd })
  }

  const saveNote = () => {
    onPatch({ notes: noteText.trim() || null })
    setShowNotes(false)
  }

  const assignedName = task.assignedTo
    ? cleaners.find(c => c.id === task.assignedTo)
    : null

  const canEdit = !isPast
  const color   = cleanerColor(cleaners, task.assignedTo)

  return (
    <div
      className={`hk-row${isDone ? ' hk-row-done' : ''}${isDnd ? ' hk-row-dnd' : ''}${selected ? ' hk-row-selected' : ''}${isPast ? ' hk-row-past' : ''}`}
      style={color && !isDnd && !selected ? { background: color.bg, borderColor: color.border, borderLeftWidth: 4 } : undefined}
    >

      {/* Checkbox de selección (admin) + número habitación */}
      <div className="hk-room">
        {admin && canEdit && (
          <input type="checkbox" className="hk-select" checked={selected} onChange={onSelect} />
        )}
        {isStay ? (
          <span className="hk-room-num">{task.roomCode}</span>
        ) : (
          <div className="hk-room-info">
            <span className="hk-room-num">{task.roomCode}</span>
            <span className="hk-tag-salida">
              SALIDA{checkoutTime ? ` ${checkoutTime}` : ''}
            </span>
            {task.checkedOut && (
              <span className="hk-tag-checkedout" title="El huésped ya ha hecho check-out">
                <span aria-hidden="true">🚪</span>
                <span className="hk-tag-label"> Ha salido</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Asignación */}
      <div className="hk-assigned">
        {admin && canEdit ? (
          <select
            value={task.assignedTo ?? ''}
            onChange={e => onPatch({ assignedTo: e.target.value ? Number(e.target.value) : null })}
            className="hk-cleaner-select"
          >
            <option value="">Sin asignar</option>
            {cleaners.map(c => (
              <option key={c.id} value={c.id}>{c.firstName} {c.lastName.charAt(0)}.</option>
            ))}
          </select>
        ) : canEdit && userId ? (
          task.assignedTo === userId ? (
            <button className="btn btn-ghost btn-xs" onClick={() => onPatch({ assignedTo: null })}>
              ✓ Asignada a mí
            </button>
          ) : (
            <button className="btn btn-ghost btn-xs" onClick={() => onPatch({ assignedTo: userId })}>
              {assignedName ? `${assignedName.firstName} ${assignedName.lastName.charAt(0)}.` : 'Sin asignar'} → Asignarme
            </button>
          )
        ) : (
          <span className="hk-cleaner-name">
            {assignedName ? `${assignedName.firstName} ${assignedName.lastName}` : '—'}
          </span>
        )}
      </div>

      {/* Lencería — solo en vista de clientes (stay) */}
      {isStay && (
        <div className="hk-linen">
          {LINEN.map(item => (
            <button
              key={item.key}
              className={`hk-linen-chip${task.linenChanges.includes(item.key) ? ' active' : ''}`}
              onClick={() => canEdit && toggleLinen(item.key)}
              disabled={!canEdit}
              title={item.label}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* Acciones */}
      <div className="hk-actions">
        {/* DND — solo en stay */}
        {isStay && (
          <button
            className={`hk-btn-dnd${isDnd ? ' active' : ''}`}
            title={isDnd ? 'Cartel rojo — clic para quitar' : 'Marcar cartel rojo (No molestar)'}
            onClick={() => canEdit && toggleDnd()}
            disabled={!canEdit}
          >
            🚫
          </button>
        )}

        {/* Objetos robados — solo en salidas */}
        {!isStay && (
          <button
            className={`hk-btn-stolen${task.stolenItemsReported ? ' active' : ''}`}
            title={task.stolenItemsReported
              ? 'Objetos robados marcados — clic para quitar el aviso (o se quita al registrar un depósito nuevo)'
              : 'Marcar objetos robados en la habitación'}
            onClick={onToggleStolen}
          >
            <span aria-hidden="true">🥷</span>
            <span className="hk-btn-label">Items robados</span>
          </button>
        )}

        {/* Notas */}
        {(canEdit || task.notes) && (
          <button
            className={`hk-btn-note${task.notes ? ' has-note' : ''}`}
            title="Observaciones"
            onClick={() => setShowNotes(v => !v)}
          >
            💬
          </button>
        )}

        {/* Hecha */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <button
            className={`hk-btn-done${isDone ? ' done' : ''}`}
            onClick={toggleDone}
            disabled={isPast || isDnd}
            title={isPast ? 'Día pasado — solo lectura' : isDone ? 'Marcar como pendiente' : 'Marcar como limpia'}
          >
            {isDone ? '✓' : '○'}
          </button>
          {doneTime && (
            <span style={{ fontSize: 10, color: '#22c55e', fontWeight: 600, lineHeight: 1 }}>{doneTime}</span>
          )}
        </div>
      </div>

      {/* Panel de notas expandible */}
      {showNotes && (
        <div className="hk-notes-panel">
          {!canEdit ? (
            <p style={{ fontSize: 13, color: 'var(--text2)', margin: '4px 0' }}>{task.notes || '—'}</p>
          ) : (
            <>
              <textarea
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                placeholder="Observación breve…"
                maxLength={300}
                rows={2}
                autoFocus
              />
              <div className="hk-notes-actions">
                <button className="btn btn-ghost btn-xs" onClick={() => setShowNotes(false)}>Cancelar</button>
                <button className="btn btn-primary btn-xs" onClick={saveNote}>Guardar</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Fila de zona común ─────────────────────────────────────────────────────
// Versión simplificada de TaskRow: sin lencería, DND ni objetos robados —
// solo asignación y marcar limpio (quién y a qué hora). Las zonas de baño
// llevan además un botón aparte para marcar reposición de papel higiénico,
// independiente de si la zona está limpia.

function CommonAreaRow({ area, cleaners, admin, userId, selected, isPast, onSelect, onPatch }: {
  area: CommonArea
  cleaners: Cleaner[]
  admin: boolean
  userId: number | null
  selected: boolean
  isPast: boolean
  onSelect: () => void
  onPatch: (body: any) => void
}) {
  const isDone = area.status === 'done'
  const doneTime = isDone ? fmtTime(area.completedAt) : null
  const paperRefilled = !!area.paperRefilledAt
  const paperTime = paperRefilled ? fmtTime(area.paperRefilledAt) : null

  const canEdit = !isPast
  const color   = cleanerColor(cleaners, area.assignedTo)

  const toggleDone = () => {
    if (isPast) return
    onPatch({ status: isDone ? 'pending' : 'done' })
  }

  const togglePaper = () => {
    if (isPast) return
    onPatch({ paperRefilled: !paperRefilled })
  }

  return (
    <div
      className={`hk-row hk-row-area${isDone ? ' hk-row-done' : ''}${selected ? ' hk-row-selected' : ''}${isPast ? ' hk-row-past' : ''}`}
      style={color && !selected ? { background: color.bg, borderColor: color.border, borderLeftWidth: 4 } : undefined}
    >
      <div className="hk-room">
        {admin && canEdit && (
          <input type="checkbox" className="hk-select" checked={selected} onChange={onSelect} />
        )}
        <span className="hk-area-label">{area.label}</span>
      </div>

      {/* Asignación */}
      <div className="hk-assigned">
        {admin && canEdit ? (
          <select
            value={area.assignedTo ?? ''}
            onChange={e => onPatch({ assignedTo: e.target.value ? Number(e.target.value) : null })}
            className="hk-cleaner-select"
          >
            <option value="">Sin asignar</option>
            {cleaners.map(c => (
              <option key={c.id} value={c.id}>{c.firstName} {c.lastName.charAt(0)}.</option>
            ))}
          </select>
        ) : canEdit && userId ? (
          area.assignedTo === userId ? (
            <button className="btn btn-ghost btn-xs" onClick={() => onPatch({ assignedTo: null })}>
              ✓ Asignada a mí
            </button>
          ) : (
            <button className="btn btn-ghost btn-xs" onClick={() => onPatch({ assignedTo: userId })}>
              {area.assignedToName ?? 'Sin asignar'} → Asignarme
            </button>
          )
        ) : (
          <span className="hk-cleaner-name">{area.assignedToName ?? '—'}</span>
        )}
      </div>

      {/* Acciones */}
      <div className="hk-actions">
        {area.isBathroom && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <button
              className={`hk-btn-note${paperRefilled ? ' has-note' : ''}`}
              onClick={togglePaper}
              disabled={!canEdit}
              title={paperRefilled ? `Papel repuesto${area.paperRefilledByName ? ` por ${area.paperRefilledByName}` : ''} — clic para desmarcar` : 'Marcar papel higiénico repuesto'}
            >
              🧻
            </button>
            {paperTime && (
              <span style={{ fontSize: 10, color: 'var(--text2)', fontWeight: 600, lineHeight: 1 }}>{paperTime}</span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <button
            className={`hk-btn-done${isDone ? ' done' : ''}`}
            onClick={toggleDone}
            disabled={isPast}
            title={isPast ? 'Día pasado — solo lectura' : isDone ? 'Marcar como pendiente' : 'Marcar como limpia'}
          >
            {isDone ? '✓' : '○'}
          </button>
          {doneTime && (
            <span style={{ fontSize: 10, color: '#22c55e', fontWeight: 600, lineHeight: 1 }}>{doneTime}</span>
          )}
        </div>
      </div>
    </div>
  )
}
