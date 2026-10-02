import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { fmtMoney, today, addDays, toast } from '../lib/utils'
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

export default function DeparturesView() {
  const navigate = useNavigate()
  const [date,    setDate]    = useState(today())
  const [data,    setData]    = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [sortCol, setSortCol] = useState('status')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const load = useCallback(async (d: string) => {
    setLoading(true); setError(null)
    try { const res: any = await api.departures(d); setData(res.data) }
    catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(date) }, [date, load])

  const shift = (n: number) => setDate(d => addDays(d, n))

  const doCheckOut = async (id: number) => {
    if (!confirm('¿Confirmar check-out?')) return
    try { await api.checkOut(id); toast('Check-out realizado'); load(date) }
    catch (e: any) { toast(e.message, 'err') }
  }

  const onSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const getVal = (r: any, col: string) => {
    switch (col) {
      case 'room':     return r.room?.code ?? ''
      case 'guest':    return `${r.guest?.lastName ?? ''} ${r.guest?.firstName ?? ''}`.toLowerCase()
      case 'checkIn':  return r.checkInDate ?? ''
      case 'nights':   return r.nights ?? 0
      case 'channel':  return r.bookingChannel?.name ?? ''
      case 'total':    return parseFloat(r.total ?? '0')
      // paid/balance: no cuentan los depósitos retenidos sin cobrar como pago
      // de la estancia (r.realPaid/r.pendingBalance, ver dashboard.ts).
      case 'paid':     return r.realPaid ?? 0
      case 'balance':  return r.pendingBalance ?? 0
      case 'status':   return ({ checking_out: 0, checked_in: 1, confirmed: 2, checked_out: 3 } as Record<string,number>)[r.status] ?? 9
      default:         return ''
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

  const pending    = sorted.filter(r => r.status === 'confirmed' || r.status === 'checked_in' || r.status === 'checking_out')
  const checkedOut = sorted.filter(r => r.status === 'checked_out')

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
              <span className="day-stat-label">Por salir</span>
            </div>
            <div className="day-stat checked">
              <span className="day-stat-num">{checkedOut.length}</span>
              <span className="day-stat-label">Ya salieron</span>
            </div>
            <div className="day-stat total">
              <span className="day-stat-num">{sorted.length}</span>
              <span className="day-stat-label">Total salidas</span>
            </div>
          </div>

          {sorted.length === 0
            ? <div className="empty"><div className="icon">📭</div><p>Sin salidas para este día</p></div>
            : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <SortTh col="room"    cur={sortCol} dir={sortDir} onSort={onSort}>Hab.</SortTh>
                    <SortTh col="guest"   cur={sortCol} dir={sortDir} onSort={onSort}>Huésped</SortTh>
                    <SortTh col="checkIn" cur={sortCol} dir={sortDir} onSort={onSort}>Llegada</SortTh>
                    <SortTh col="nights"  cur={sortCol} dir={sortDir} onSort={onSort}>Noches</SortTh>
                    <SortTh col="channel" cur={sortCol} dir={sortDir} onSort={onSort}>Canal</SortTh>
                    <SortTh col="total"   cur={sortCol} dir={sortDir} onSort={onSort}>Total</SortTh>
                    <SortTh col="paid"    cur={sortCol} dir={sortDir} onSort={onSort}>Pagado</SortTh>
                    <SortTh col="balance" cur={sortCol} dir={sortDir} onSort={onSort}>Saldo</SortTh>
                    <SortTh col="status"  cur={sortCol} dir={sortDir} onSort={onSort}>Estado</SortTh>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    {sorted.map((r: any) => {
                      const total = parseFloat(r.total ?? '0')
                      // paid/due: no cuentan los depósitos retenidos sin cobrar como
                      // pago de la estancia (r.realPaid/r.pendingBalance, ver dashboard.ts).
                      const paid  = r.realPaid ?? 0
                      const due   = r.pendingBalance ?? 0
                      const canCheckOut = r.status === 'confirmed' || r.status === 'checked_in' || r.status === 'checking_out'
                      return (
                        <tr key={r.id}>
                          <td><span className="badge">{r.room?.code ?? '—'}</span></td>
                          <td>
                            <a href="#" onClick={e => { e.preventDefault(); navigate(`/reservations/${r.id}`) }}>
                              {r.guest?.firstName} {r.guest?.lastName}
                            </a>
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--text2)' }}>{r.checkInDate}</td>
                          <td>{r.nights}</td>
                          <td style={{ fontSize: 12 }}>{r.bookingChannel?.name ?? '—'}</td>
                          <td>{total > 0 ? fmtMoney(total) : '—'}</td>
                          <td>{paid > 0 ? fmtMoney(paid) : '—'}</td>
                          <td style={{ color: due > 0 ? 'var(--red)' : 'var(--green)', fontWeight: due > 0 ? 600 : 400 }}>
                            {due > 0.01 ? fmtMoney(due) : '✓'}
                          </td>
                          <td><StatusChip status={r.status} /></td>
                          <td>
                            {canCheckOut
                              ? <button className="btn btn-yellow btn-sm" onClick={() => doCheckOut(r.id)}>Check-out</button>
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
