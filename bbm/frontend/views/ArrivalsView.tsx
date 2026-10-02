import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { today, addDays, toast, fmtMoney } from '../lib/utils'
import { StatusChip } from '../components/Badge'

type SortDir = 'asc' | 'desc'

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

export default function ArrivalsView() {
  const navigate = useNavigate()
  const [date,    setDate]    = useState(today())
  const [data,    setData]    = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [sortCol, setSortCol] = useState('status')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const load = useCallback(async (d: string) => {
    setLoading(true); setError(null)
    try { const res: any = await api.arrivals(d); setData(res.data) }
    catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(date) }, [date, load])

  const shift = (n: number) => setDate(d => addDays(d, n))

  const doCheckIn = async (id: number) => {
    try { await api.checkIn(id); toast('Check-in realizado'); load(date) }
    catch (e: any) { toast(e.message, 'err') }
  }

  const onSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const getVal = (r: any, col: string) => {
    switch (col) {
      case 'room':    return r.room?.code ?? ''
      case 'guest':   return `${r.guest?.lastName ?? ''} ${r.guest?.firstName ?? ''}`.toLowerCase()
      case 'type':    return r.room?.roomType?.name ?? ''
      case 'nights':  return r.nights ?? 0
      case 'people':  return r.people ?? 1
      case 'channel': return r.bookingChannel?.name ?? ''
      case 'balance': return r.pendingBalance ?? 0
      case 'status':  return ({ arriving: 0, tentative: 0, confirmed: 1, checked_in: 2, checking_out: 3, checked_out: 4 } as Record<string,number>)[r.status] ?? 9
      default:        return ''
    }
  }

  const sorted = sortCol
    ? [...data].sort((a, b) => {
        const va = getVal(a, sortCol), vb = getVal(b, sortCol)
        const cmp = typeof va === 'number' && typeof vb === 'number'
          ? va - vb : String(va).localeCompare(String(vb), 'es')
        return sortDir === 'asc' ? cmp : -cmp
      })
    : data

  const pending = sorted.filter(r => r.status === 'tentative' || r.status === 'arriving' || r.status === 'confirmed')
  const arrived = sorted.filter(r => r.status === 'checked_in' || r.status === 'checking_out' || r.status === 'checked_out')

  return (
    <>
      <div className="day-toolbar">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => shift(-1)}>‹</button>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="plan-date-input" />
          <button className="btn btn-ghost btn-sm" onClick={() => shift(1)}>›</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setDate(today())}>Hoy</button>
        </div>
      </div>

      {loading && <div className="loading">Cargando…</div>}
      {error   && <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>}

      {!loading && !error && (
        <>
          <div className="day-stats">
            <div className="day-stat">
              <span className="day-stat-num">{pending.length}</span>
              <span className="day-stat-label">Por llegar</span>
            </div>
            <div className="day-stat checked">
              <span className="day-stat-num">{arrived.length}</span>
              <span className="day-stat-label">Llegaron</span>
            </div>
            <div className="day-stat total">
              <span className="day-stat-num">{sorted.length}</span>
              <span className="day-stat-label">Total llegadas</span>
            </div>
          </div>

          {sorted.length === 0
            ? <div className="empty"><div className="icon">📭</div><p>Sin llegadas para este día</p></div>
            : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <SortTh col="room"    cur={sortCol} dir={sortDir} onSort={onSort}>Hab.</SortTh>
                    <SortTh col="guest"   cur={sortCol} dir={sortDir} onSort={onSort}>Huésped</SortTh>
                    <SortTh col="type"    cur={sortCol} dir={sortDir} onSort={onSort}>Tipo</SortTh>
                    <SortTh col="nights"  cur={sortCol} dir={sortDir} onSort={onSort}>Noches</SortTh>
                    <SortTh col="people"  cur={sortCol} dir={sortDir} onSort={onSort}>Personas</SortTh>
                    <SortTh col="channel" cur={sortCol} dir={sortDir} onSort={onSort}>Canal</SortTh>
                    <SortTh col="balance" cur={sortCol} dir={sortDir} onSort={onSort}>Saldo</SortTh>
                    <SortTh col="status"  cur={sortCol} dir={sortDir} onSort={onSort}>Estado</SortTh>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    {sorted.map((r: any) => {
                      const canCheckIn = r.status === 'tentative' || r.status === 'arriving' || r.status === 'confirmed'
                      const due = r.pendingBalance ?? 0
                      return (
                        <tr key={r.id}>
                          <td><span className="badge">{r.room?.code ?? '—'}</span></td>
                          <td>
                            <a href="#" onClick={e => { e.preventDefault(); navigate(`/reservations/${r.id}`) }}>
                              {r.guest?.firstName} {r.guest?.lastName}
                            </a>
                          </td>
                          <td style={{ color: 'var(--text2)', fontSize: 12 }}>{r.room?.roomType?.name ?? '—'}</td>
                          <td>{r.nights}</td>
                          <td>{r.people ?? 1}</td>
                          <td style={{ fontSize: 12 }}>{r.bookingChannel?.name ?? '—'}</td>
                          <td style={{ color: due > 0 ? 'var(--red)' : 'var(--green)', fontWeight: due > 0 ? 600 : 400 }}>
                            {Math.abs(due) > 0.01 ? fmtMoney(due) : '✓'}
                          </td>
                          <td><StatusChip status={r.status} /></td>
                          <td>
                            {canCheckIn
                              ? <button className="btn btn-primary btn-sm" onClick={() => doCheckIn(r.id)}>Check-in</button>
                              : <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/reservations/${r.id}`)}>Ver</button>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </>
      )}
    </>
  )
}
