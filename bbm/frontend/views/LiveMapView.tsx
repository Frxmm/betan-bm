import { useState, useEffect, useCallback, useRef } from 'react'

const API = (path: string) => fetch(`/api/housekeeping${path}`, { credentials: 'include' })

interface Task {
  roomId: number
  roomCode: string
  taskType: 'stay' | 'departure'
  status: 'pending' | 'done' | 'dnd'
  dnd: boolean
  assignedTo: number | null
  completedAt: string | null
  completedBy: number | null
  people: number | null
  checkedOut: boolean
}

interface Cleaner { id: number; firstName: string; lastName: string }

interface BlockedBed {
  roomId: number
  blockDate: string
  reason: string | null
  lockedByDirection: boolean
  room?: { code: string }
}

interface Badge { code: string; cx: number; cy: number }
interface FloorData { width: number; height: number; badges: Badge[] }

const FLOORS = [
  { id: 'floor1', label: 'Planta 1' },
  { id: 'floor2', label: 'Planta 2' },
  { id: 'floor3', label: 'Planta 3' },
  { id: 'floor4', label: 'Planta 4' },
  { id: 'floor5', label: 'Planta 5' },
]

// Mismos estados que maneja Housekeeping (housekeepingTasks.status/taskType) —
// esta vista solo los pinta en el plano real, no inventa un estado nuevo.
const STATUS_STYLE = {
  vacant:            { fill: '#c7c2b6', label: 'Libre' },
  stay_pending:      { fill: '#f59e0b', label: 'Ocupada, repaso pendiente' },
  stay_done:         { fill: '#22c55e', label: 'Ocupada, limpia' },
  departure_pending: { fill: '#ef4444', label: 'Salida, falta limpiar' },
  departure_done:    { fill: '#86efac', label: 'Salida, limpia' },
  dnd:               { fill: '#8b5cf6', label: 'No molestar' },
  blocked:           { fill: '#44403c', label: 'Bloqueada' },
} as const

// Mismos colores que CLEANER_COLORS en HousekeepingView.tsx (versión sólida,
// para trazo en vez de fondo), así el recorrido usa el mismo color que ya
// identifica a cada limpiadora en el resto del panel.
const ROUTE_COLORS = ['#63b3ed', '#9acd64', '#f6ad55', '#b794f4', '#fc8181', '#4cd2c8', '#f8c864', '#a0aec0']

type StatusKey = keyof typeof STATUS_STYLE

// Una habitación bloqueada hoy (blocked_beds) manda sobre cualquier estado de
// limpieza — fuera de servicio es fuera de servicio, esté limpia o no.
function statusKey(task: Task | undefined, blocked: boolean): StatusKey {
  if (blocked) return 'blocked'
  if (!task) return 'vacant'
  if (task.status === 'dnd' || task.dnd) return 'dnd'
  if (task.taskType === 'departure') return task.status === 'done' ? 'departure_done' : 'departure_pending'
  return task.status === 'done' ? 'stay_done' : 'stay_pending'
}

const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date())

// Muñeco simple (cabeza + cuerpo), centrado en (0,0) — se posiciona con <g transform>.
function PersonIcon({ x, y, scale }: { x: number; y: number; scale: number }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`} fill="#2a2820">
      <circle cy="-0.1" r="0.08" />
      <ellipse cy="0.08" rx="0.11" ry="0.14" />
    </g>
  )
}

export default function LiveMapView() {
  const [floor, setFloor]             = useState<string>(FLOORS[0]!.id)
  const [svgByFloor, setSvgByFloor]   = useState<Record<string, string>>({})
  const [dataByFloor, setDataByFloor] = useState<Record<string, FloorData>>({})
  const [tasks, setTasks]             = useState<Task[]>([])
  const [cleaners, setCleaners]       = useState<Cleaner[]>([])
  const [blockedBeds, setBlockedBeds] = useState<BlockedBed[]>([])
  const [loading, setLoading]         = useState(true)
  const [selected, setSelected]       = useState<string | null>(null)

  // Tamaño real disponible para el plano (sin scroll): se mide el hueco de
  // verdad en vez de usar un zoom fijo (antes el plano se pintaba a 32px por
  // unidad siempre, y si eso no cabía en la pantalla, scroll lateral/
  // vertical). Con el tamaño medido se calcula abajo el mayor zoom que cabe
  // entero (ver boxScale), igual que un "object-fit: contain".
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect
      setBoxSize({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Plano base (paredes) + posiciones de habitación de cada planta: se piden
  // una sola vez la primera vez que se visita. El SVG base nunca se vuelve a
  // tocar después de insertarlo — todo lo que cambia (color, ocupación,
  // recorrido) se pinta aparte, con React, en una capa superpuesta.
  useEffect(() => {
    if (svgByFloor[floor]) return
    Promise.all([
      fetch(`/api/floorplans/${floor}/svg`, { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('sin plano'); return r.text() }),
      fetch(`/api/floorplans/${floor}/json`, { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('sin plano'); return r.json() }),
    ]).then(([svg, data]) => {
      setSvgByFloor(prev => ({ ...prev, [floor]: svg }))
      setDataByFloor(prev => ({ ...prev, [floor]: data }))
    }).catch(() => {})
  }, [floor, svgByFloor])

  const load = useCallback(async () => {
    const today = todayISO()
    try {
      const [hk, blocked]: [any, any] = await Promise.all([
        API(`?date=${today}`).then(r => r.json()),
        fetch('/api/rooms/blocked-beds', { credentials: 'include' }).then(r => r.json()),
      ])
      setTasks(hk.data ?? [])
      setCleaners(hk.cleaners ?? [])
      setBlockedBeds((blocked.data ?? []).filter((b: BlockedBed) => b.blockDate === today))
    } catch {
      // mantiene el plano con el último estado conocido en vez de vaciarlo
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  // Refresco automático — es un mapa "en vivo", no una foto fija de cuando se abrió la pestaña.
  useEffect(() => {
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  const taskByCode = new Map(tasks.map(t => [t.roomCode, t]))
  const blockedCodes = new Set(blockedBeds.map(b => b.room?.code).filter((c): c is string => !!c))
  const blockedReasonByCode = new Map(blockedBeds.map(b => [b.room?.code, b]))

  // Ocupación real = reservations.people (viene ya resuelto en cada tarea de
  // housekeeping) — no filas de reservation_nights, que puede no tener fila
  // para el acompañante si no tiene huésped nombrado todavía, o faltar del
  // todo en reservas sin reservation_nights generadas (p. ej. Jumbo).
  const occupancyByCode = new Map<string, number>()
  for (const t of tasks) {
    if (!t.people) continue
    if (t.taskType === 'departure' && t.checkedOut) continue  // ya se ha ido, habitación vacía
    occupancyByCode.set(t.roomCode, t.people)
  }

  // Orden real en que cada limpiadora ha ido completando habitaciones hoy
  // (housekeepingTasks.completedAt), una lista por cleanerId.
  const routeByCleaner = new Map<number, { code: string; completedAt: string }[]>()
  for (const t of tasks) {
    if (t.status !== 'done' || !t.completedBy || !t.completedAt) continue
    const list = routeByCleaner.get(t.completedBy) ?? []
    list.push({ code: t.roomCode, completedAt: t.completedAt })
    routeByCleaner.set(t.completedBy, list)
  }
  for (const list of routeByCleaner.values()) list.sort((a, b) => a.completedAt.localeCompare(b.completedAt))

  const cleanerColorIdx = (id: number) => {
    const idx = cleaners.findIndex(c => c.id === id)
    return idx >= 0 ? idx % ROUTE_COLORS.length : 0
  }

  const cleanerName = (id: number | null) => {
    if (!id) return null
    const c = cleaners.find(c => c.id === id)
    return c ? `${c.firstName} ${c.lastName}` : null
  }

  const selectedTask = selected ? taskByCode.get(selected) : undefined
  const selectedBlocked = selected ? blockedCodes.has(selected) : false
  const selectedBlockReason = selected ? blockedReasonByCode.get(selected) : undefined
  const selectedOccupancy = selected ? occupancyByCode.get(selected) ?? 0 : 0

  const floorData = dataByFloor[floor]
  const positionByCode = new Map((floorData?.badges ?? []).map(b => [b.code, b]))

  // Mayor zoom que cabe entero en el hueco medido (boxSize), preservando la
  // proporción real del plano — igual que "object-fit: contain", pero
  // calculado a mano porque el tamaño final (renderW/renderH) hace falta en
  // píxeles concretos para que el SVG base (width/height "100%") y la capa
  // de badges tengan algo real sobre lo que estirarse.
  const scale  = floorData && boxSize.w > 0 && boxSize.h > 0
    ? Math.min(boxSize.w / floorData.width, boxSize.h / floorData.height)
    : 0
  const renderW = floorData ? floorData.width  * scale : 0
  const renderH = floorData ? floorData.height * scale : 0

  return (
    <div className="live-map-page">
      <div className="tabs" style={{ margin: '0 0 12px', flex: 'none' }}>
        {FLOORS.map(f => (
          <button
            key={f.id}
            className={`tab-btn${floor === f.id ? ' active' : ''}`}
            onClick={() => { setFloor(f.id); setSelected(null) }}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="live-map-row" style={{ display: 'flex', gap: 16, alignItems: 'stretch', flex: '1 1 auto', minHeight: 0 }}>
        <div className="card" style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, padding: 8, display: 'flex', overflow: 'hidden' }}>
          <div ref={boxRef} style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {svgByFloor[floor] && floorData && scale > 0 ? (
            <div style={{ position: 'relative', width: renderW, height: renderH, flex: 'none' }}>
              <div
                style={{ position: 'absolute', inset: 0 }}
                dangerouslySetInnerHTML={{ __html: svgByFloor[floor] }}
              />
              <svg
                viewBox={`0 0 ${floorData.width} ${floorData.height}`}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              >
                {[...routeByCleaner.entries()].map(([cleanerId, stops]) => {
                  const pts = stops.map(s => positionByCode.get(s.code)).filter((p): p is Badge => !!p)
                  if (pts.length === 0) return null
                  const color = ROUTE_COLORS[cleanerColorIdx(cleanerId)]
                  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.cx} ${p.cy}`).join(' ')
                  return (
                    <g key={cleanerId}>
                      {pts.length >= 2 && (
                        <path d={d} fill="none" stroke={color} strokeWidth={0.12} strokeDasharray="0.3,0.22" strokeLinecap="round" opacity={0.85} />
                      )}
                      {pts.map((p, i) => (
                        <g key={i}>
                          <circle cx={p.cx} cy={p.cy - 0.95} r={0.26} fill={color} stroke="white" strokeWidth={0.04} />
                          <text x={p.cx} y={p.cy - 0.86} fontSize={0.26} textAnchor="middle" fill="white">{i + 1}</text>
                        </g>
                      ))}
                    </g>
                  )
                })}

                {floorData.badges.map(b => {
                  const blocked = blockedCodes.has(b.code)
                  const fill = STATUS_STYLE[statusKey(taskByCode.get(b.code), blocked)].fill
                  const count = occupancyByCode.get(b.code) ?? 0
                  const shown = Math.min(count, 4)
                  const spacing = 0.6
                  const iconY = b.cy + 0.55
                  const startX = b.cx - ((shown - 1) * spacing) / 2
                  return (
                    <g
                      key={b.code}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setSelected(b.code)}
                    >
                      <circle cx={b.cx} cy={b.cy} r={0.6} fill={fill} stroke="#8a857a" strokeWidth={0.05} />
                      <text x={b.cx} y={b.cy + 0.18} fontSize={0.42} textAnchor="middle" fill="#2a2820">{b.code}</text>
                      {Array.from({ length: shown }, (_, i) => (
                        <PersonIcon key={i} x={startX + i * spacing} y={iconY} scale={1.9} />
                      ))}
                      {count > shown && (
                        <text x={b.cx + shown * spacing / 2 + 0.3} y={iconY + 0.1} fontSize={0.5} fill="#2a2820">+{count - shown}</text>
                      )}
                    </g>
                  )
                })}
              </svg>
            </div>
          ) : (
            <div className="loading">Cargando plano…</div>
          )}
          </div>
        </div>

        <aside className="card" style={{ flex: '0 0 260px', minWidth: 220, overflow: 'auto' }}>
          <h3 style={{ marginTop: 0 }}>Leyenda</h3>
          {(Object.entries(STATUS_STYLE) as [StatusKey, typeof STATUS_STYLE[StatusKey]][]).map(([key, s]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
              <span style={{ width: 14, height: 14, borderRadius: 4, background: s.fill, flex: 'none' }} />
              <span>{s.label}</span>
            </div>
          ))}

          {cleaners.filter(c => (routeByCleaner.get(c.id)?.length ?? 0) > 0).length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>Recorrido de limpieza</h3>
              {cleaners.filter(c => (routeByCleaner.get(c.id)?.length ?? 0) > 0).map(c => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
                  <span style={{ width: 14, height: 14, borderRadius: '50%', background: ROUTE_COLORS[cleanerColorIdx(c.id)], flex: 'none' }} />
                  <span>{c.firstName} {c.lastName} ({routeByCleaner.get(c.id)!.length})</span>
                </div>
              ))}
            </>
          )}

          {selected && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <h3 style={{ margin: '0 0 6px' }}>Habitación {selected}</h3>
              <p style={{ margin: '4px 0' }}>{STATUS_STYLE[statusKey(selectedTask, selectedBlocked)].label}</p>
              {selectedOccupancy > 0 && (
                <p style={{ margin: '4px 0', color: 'var(--text2)' }}>
                  {selectedOccupancy} {selectedOccupancy === 1 ? 'persona alojada' : 'personas alojadas'}
                </p>
              )}
              {cleanerName(selectedTask?.assignedTo ?? null) && (
                <p style={{ margin: '4px 0', color: 'var(--text2)' }}>
                  Asignada a {cleanerName(selectedTask?.assignedTo ?? null)}
                </p>
              )}
              {selectedBlocked && (
                <p style={{ margin: '4px 0', color: 'var(--text2)' }}>
                  {selectedBlockReason?.reason ?? 'Sin motivo registrado'}
                  {selectedBlockReason?.lockedByDirection ? ' (bloqueo de Dirección)' : ''}
                </p>
              )}
            </div>
          )}
        </aside>
      </div>

      {loading && tasks.length === 0 && <div className="loading">Cargando estado de habitaciones…</div>}
    </div>
  )
}
