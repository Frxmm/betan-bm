import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { api } from '../lib/api'

const CHANNEL_COLORS: Record<string, string> = {
  'Directo':        'var(--green)',
  'Booking.com':    '#003580',
  'Airbnb':         '#ff5a5f',
  'Expedia':        '#ffc700',
  'HotelBeds':      '#4a90d9',
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  confirmed:    { label: 'Confirmada',  cls: 'badge-confirmed' },
  tentative:    { label: 'Provisional', cls: 'badge-tentative' },
  arriving:     { label: 'Por llegar',  cls: 'badge-tentative' },
  checked_in:   { label: 'En casa',     cls: 'badge-checked-in' },
  checking_out: { label: 'Saliendo',    cls: 'badge-checking-out' },
  checked_out:  { label: 'Ha salido',   cls: 'badge-checked-out' },
  cancelled:    { label: 'Cancelada',   cls: 'badge-cancelled' },
  no_show:      { label: 'No show',     cls: 'badge-no-show' },
}

const ARR_STATUS_ORDER: Record<string, number> = { arriving: 0, tentative: 0, confirmed: 1, checked_in: 2 }
const DEP_STATUS_ORDER: Record<string, number> = { checking_out: 0, checked_in: 1, confirmed: 2, checked_out: 3 }

type SortDir = 'asc' | 'desc'

function Badge({ status }: { status: string }) {
  const s = STATUS_LABELS[status] ?? { label: status, cls: '' }
  return <span className={`badge ${s.cls}`}>{s.label}</span>
}

function fmtMoney(n: number) {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })
}

function SortTh({ col, cur, dir, onSort, children }: {
  col: string; cur: string; dir: SortDir; onSort: (c: string) => void; children: React.ReactNode
}) {
  const active = cur === col
  return (
    <th onClick={() => onSort(col)} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
      {children}{' '}
      <span style={{ opacity: active ? 1 : 0.25, fontSize: 11 }}>{active ? (dir === 'asc' ? '↑' : '↓') : '↕'}</span>
    </th>
  )
}

function useSortable(initial: string) {
  const [col, setCol] = useState(initial)
  const [dir, setDir] = useState<SortDir>('asc')
  const onSort = (c: string) => {
    if (col === c) setDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setCol(c); setDir('asc') }
  }
  return { col, dir, onSort }
}

export default function DashboardView() {
  const navigate = useNavigate()

  const stats      = useApi(() => api.dashboard())
  const arrivals   = useApi(() => api.arrivals())
  const departures = useApi(() => api.departures())
  const recent     = useApi(() => api.recentReservations(25))

  const arrSort = useSortable('status')
  const depSort = useSortable('status')

  const loading = stats.loading || arrivals.loading || departures.loading
  const error   = stats.error || arrivals.error || departures.error

  if (loading) return <div className="loading">Cargando…</div>
  if (error)   return <div className="empty"><p style={{ color: 'var(--red)' }}>Error: {error}</p></div>

  const s = stats.data!.data

  const sortRows = (rows: any[], col: string, dir: SortDir, statusOrder: Record<string, number>) => {
    return [...rows].sort((a, b) => {
      let va: any, vb: any
      switch (col) {
        case 'guest':   va = `${a.guest?.lastName ?? ''} ${a.guest?.firstName ?? ''}`.toLowerCase()
                        vb = `${b.guest?.lastName ?? ''} ${b.guest?.firstName ?? ''}`.toLowerCase(); break
        case 'room':    va = a.room?.code ?? ''; vb = b.room?.code ?? ''; break
        case 'nights':  va = a.nights ?? 0;      vb = b.nights ?? 0; break
        case 'balance': va = a.pendingBalance ?? 0
                        vb = b.pendingBalance ?? 0; break
        case 'status':  va = statusOrder[a.status] ?? 9; vb = statusOrder[b.status] ?? 9; break
        default:        va = ''; vb = ''
      }
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb : String(va).localeCompare(String(vb), 'es')
      return dir === 'asc' ? cmp : -cmp
    })
  }

  const arr = sortRows(arrivals.data!.data,   arrSort.col, arrSort.dir, ARR_STATUS_ORDER)
  const dep = sortRows(departures.data!.data, depSort.col, depSort.dir, DEP_STATUS_ORDER)

  return (
    <>
      <div className="stats-grid">
        <div className="stat-card blue">
          <div className="label">Llegadas hoy</div>
          <div className="value">{s.arrivals}</div>
          <div className="sub">pendientes de check-in</div>
        </div>
        <div className="stat-card green">
          <div className="label">Salidas hoy</div>
          <div className="value">{s.departures}</div>
          <div className="sub">pendientes de check-out</div>
        </div>
        <div className="stat-card yellow">
          <div className="label">En casa</div>
          <div className="value">{s.inHouse}</div>
          <div className="sub">reservas activas</div>
        </div>
        <div className="stat-card">
          <div className="label">Nuevas hoy</div>
          <div className="value">{s.newReservations}</div>
          <div className="sub">reservas creadas</div>
        </div>
      </div>

      {/* Feed de reservas recientes */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Últimas reservas</h2>
          {recent.loading && <span style={{ fontSize: 12, color: 'var(--text2)' }}>Cargando…</span>}
        </div>
        {recent.error
          ? <div className="empty" style={{ padding: '12px 0', color: 'var(--red)', fontSize: 13 }}>{recent.error}</div>
          : (recent.data?.data?.length ?? 0) === 0
            ? <div className="empty" style={{ padding: '16px 0' }}>Sin reservas</div>
            : (
              <div style={{ maxHeight: 460, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 2 }}>
                {(recent.data?.data ?? []).map(r => {
                  const nights    = Math.round((new Date(r.checkOutDate + 'T12:00:00').getTime() - new Date(r.checkInDate + 'T12:00:00').getTime()) / 86400000)
                  const ch        = (r as any).bookingChannel?.name as string | undefined
                  const chColor   = CHANNEL_COLORS[ch ?? ''] ?? 'var(--text2)'
                  const bookedAt  = r.bookedAt ? new Date(r.bookedAt) : null
                  const todayStr2 = new Date().toLocaleDateString('es-ES')
                  const isToday   = bookedAt?.toLocaleDateString('es-ES') === todayStr2
                  const dateLabel = bookedAt
                    ? isToday
                      ? bookedAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                      : bookedAt.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' +
                        bookedAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
                    : '—'
                  const ciDate    = new Date(r.checkInDate + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
                  const coDate    = new Date(r.checkOutDate + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
                  const roomType  = (r as any).room?.roomType?.name ?? (r as any).room?.code
                  const rate      = (r as any).rate?.title
                  return (
                    <div
                      key={r.id}
                      onClick={() => navigate(`/reservations/${r.id}`)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr auto',
                        gap: '0 14px',
                        alignItems: 'center',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 10,
                        padding: '11px 14px',
                        cursor: 'pointer',
                        transition: 'border-color .12s, box-shadow .12s',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--primary)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 0 0 2px color-mix(in srgb, var(--primary) 12%, transparent)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.boxShadow = '' }}
                    >
                      {/* Timestamp + canal */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, minWidth: 70 }}>
                        <span style={{ fontSize: 11, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{dateLabel}</span>
                        {ch && (
                          <span style={{ fontSize: 10, fontWeight: 800, color: chColor, background: `color-mix(in srgb, ${chColor} 12%, transparent)`, padding: '2px 7px', borderRadius: 99, whiteSpace: 'nowrap', border: `1px solid color-mix(in srgb, ${chColor} 25%, transparent)` }}>
                            {ch}
                          </span>
                        )}
                      </div>

                      {/* Info central */}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                          <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.guest ? `${r.guest.lastName}, ${r.guest.firstName}` : '—'}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text2)', flexShrink: 0 }}>#{r.id}</span>
                          {r.externalCode && <span style={{ fontSize: 10, color: 'var(--text2)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.externalCode}</span>}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text2)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          <span>{ciDate} → {coDate} · {nights}n</span>
                          {roomType && <span>· {roomType}</span>}
                          {rate     && <span style={{ color: 'var(--text3, var(--text2))' }}>· {rate}</span>}
                        </div>
                        {r.extraField2 && (
                          <div style={{ marginTop: 5, display: 'flex', alignItems: 'flex-start', gap: 5 }}>
                            <span style={{ fontSize: 13 }}>💬</span>
                            <span style={{
                              fontSize: 12, fontStyle: 'italic',
                              background: '#fef9c3', color: '#92400e',
                              border: '1px solid #fde68a',
                              borderRadius: 6, padding: '2px 8px',
                              lineHeight: 1.4,
                            }}>
                              {r.extraField2}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Total + estado */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0 }}>
                        <span style={{ fontWeight: 800, fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(Number(r.total ?? 0))}</span>
                        <Badge status={r.status} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )
        }
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div className="card">
          <div className="card-header"><h2>Llegadas ({arr.length})</h2></div>
          {arr.length === 0
            ? <div className="empty" style={{ padding: '20px 0' }}>Sin llegadas pendientes</div>
            : (
              <table>
                <thead><tr>
                  <SortTh col="guest"  cur={arrSort.col} dir={arrSort.dir} onSort={arrSort.onSort}>Huésped</SortTh>
                  <SortTh col="room"   cur={arrSort.col} dir={arrSort.dir} onSort={arrSort.onSort}>Habitación</SortTh>
                  <SortTh col="nights" cur={arrSort.col} dir={arrSort.dir} onSort={arrSort.onSort}>Noches</SortTh>
                  <SortTh col="status" cur={arrSort.col} dir={arrSort.dir} onSort={arrSort.onSort}>Estado</SortTh>
                </tr></thead>
                <tbody>
                  {arr.map(r => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/reservations/${r.id}`)}>
                      <td>
                        <strong>{r.guest?.firstName} {r.guest?.lastName}</strong><br />
                        <span style={{ color: 'var(--text2)', fontSize: 12 }}>{r.externalCode}</span>
                      </td>
                      <td>{r.room?.code ?? '—'}</td>
                      <td>{r.nights}</td>
                      <td><Badge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        <div className="card">
          <div className="card-header"><h2>Salidas ({dep.length})</h2></div>
          {dep.length === 0
            ? <div className="empty" style={{ padding: '20px 0' }}>Sin salidas pendientes</div>
            : (
              <table>
                <thead><tr>
                  <SortTh col="guest"   cur={depSort.col} dir={depSort.dir} onSort={depSort.onSort}>Huésped</SortTh>
                  <SortTh col="room"    cur={depSort.col} dir={depSort.dir} onSort={depSort.onSort}>Habitación</SortTh>
                  <SortTh col="balance" cur={depSort.col} dir={depSort.dir} onSort={depSort.onSort}>Pendiente</SortTh>
                  <SortTh col="status"  cur={depSort.col} dir={depSort.dir} onSort={depSort.onSort}>Estado</SortTh>
                </tr></thead>
                <tbody>
                  {dep.map(r => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/reservations/${r.id}`)}>
                      <td><strong>{r.guest?.firstName} {r.guest?.lastName}</strong></td>
                      <td>{r.room?.code ?? '—'}</td>
                      <td>{fmtMoney(r.pendingBalance ?? 0)}</td>
                      <td><Badge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </div>
    </>
  )
}
