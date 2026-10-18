import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import { api } from '../lib/api'
import { addDays, getDays, fmtMoney, fmtDateTime } from '../lib/utils'
import { StatusChip } from '../components/Badge'
import { useAuth, canManage } from '../contexts/AuthContext'

type Tab     = 'pending' | 'summary' | 'all' | 'analytics' | 'caja'
type GroupBy = 'day' | 'month'

const PALETTE = ['#4f7cff','#22c55e','#f59e0b','#a855f7','#ec4899','#06b6d4','#f97316','#84cc16']

function firstOfMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`
}
function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function daysBetween(a: string, b: string) {
  return Math.round((new Date(b+'T12:00:00').getTime() - new Date(a+'T12:00:00').getTime()) / 86400000)
}
function getMonths(from: string, to: string) {
  const res: string[] = []
  const d = new Date(from+'T12:00:00'); d.setDate(1)
  const end = new Date(to+'T12:00:00')
  while (d <= end) { res.push(d.toISOString().slice(0,7)); d.setMonth(d.getMonth()+1) }
  return res
}
function byDayMap(list: any[]) {
  const m: Record<string,{count:number;revenue:number}> = {}
  for (const r of list) {
    const k = r.checkInDate
    m[k] ??= {count:0,revenue:0}
    m[k].count++; m[k].revenue += +r.total || 0
  }
  return m
}
function byMonthMap(list: any[]) {
  const m: Record<string,{count:number;revenue:number}> = {}
  for (const r of list) {
    const k = r.checkInDate.slice(0,7)
    m[k] ??= {count:0,revenue:0}
    m[k].count++; m[k].revenue += +r.total || 0
  }
  return m
}
function fmtDayLbl(iso: string) {
  return new Date(iso+'T12:00:00').toLocaleDateString('es-ES',{day:'numeric',month:'short'})
}
function fmtMonthLbl(iso: string) {
  return new Date(iso+'-01T12:00:00').toLocaleDateString('es-ES',{month:'short',year:'2-digit'})
}

export default function BillingView() {
  const navigate   = useNavigate()
  const { user }   = useAuth()
  const admin      = canManage(user)
  const [from,     setFrom]     = useState(admin ? firstOfMonth() : todayISO())
  const [to,       setTo]       = useState(todayISO())
  const [tab,      setTab]      = useState<Tab>('pending')
  const [data,     setData]     = useState<any[]>([])
  const [meta,     setMeta]     = useState<any>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string|null>(null)

  // Analytics
  const [groupBy,       setGroupBy]       = useState<GroupBy>('day')
  const [compareActive, setCompareActive] = useState(false)
  const [cFrom,         setCFrom]         = useState('')
  const [cTo,           setCTo]           = useState('')
  const [cData,         setCData]         = useState<any[]>([])
  const [cMeta,         setCMeta]         = useState<any>(null)

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setError(null)
    try {
      const res: any = await api.billingReport({ dateFrom: f, dateTo: t })
      setData(res.data); setMeta(res.meta)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(from, to) }, []) // eslint-disable-line

  useEffect(() => {
    if (!compareActive || !cFrom || !cTo) return
    api.billingReport({ dateFrom: cFrom, dateTo: cTo })
      .then((r: any) => { setCData(r.data); setCMeta(r.meta) })
      .catch(() => {})
  }, [compareActive, cFrom, cTo])

  const apply = () => load(from, to)

  const activateCompare = () => {
    if (compareActive) { setCompareActive(false); return }
    const n = daysBetween(from, to) + 1
    setCFrom(addDays(from, -n)); setCTo(addDays(to, -n)); setCompareActive(true)
  }

  const totalRevenue = parseFloat(meta?.totalRevenue ?? '0')
  const totalPaid    = parseFloat(meta?.totalPaid    ?? '0')
  const totalDue     = parseFloat(meta?.totalDue     ?? '0')
  const byChannel    = meta?.byChannel ?? {}

  // pendingBalance ya descuenta los depósitos retenidos sin cobrar (no son
  // pago de la estancia hasta que se cobran de verdad) — ver dashboard.ts.
  const withDue = data
    .filter(r => (r.pendingBalance ?? 0) > 0.01)
    .sort((a,b) => (b.pendingBalance ?? 0) - (a.pendingBalance ?? 0))

  // ── Analytics chart data ───────────────────────────────────────────────────
  const days    = getDays(from, to)
  const months  = getMonths(from, to)
  const aDayM   = byDayMap(data)
  const aMonM   = byMonthMap(data)
  const bDays   = compareActive && cFrom && cTo ? getDays(cFrom, cTo) : []
  const bMonths = compareActive && cFrom && cTo ? getMonths(cFrom, cTo) : []
  const bDayM   = byDayMap(cData)
  const bMonM   = byMonthMap(cData)

  const chartData = groupBy === 'day'
    ? days.map((day, i) => ({
        label:  fmtDayLbl(day),
        actual: +(aDayM[day]?.revenue ?? 0).toFixed(2),
        ...(compareActive ? { anterior: +(bDayM[bDays[i]??'']?.revenue ?? 0).toFixed(2) } : {}),
      }))
    : months.map((m, i) => ({
        label:  fmtMonthLbl(m),
        actual: +(aMonM[m]?.revenue ?? 0).toFixed(2),
        ...(compareActive ? { anterior: +(bMonM[bMonths[i]??'']?.revenue ?? 0).toFixed(2) } : {}),
      }))

  const channelData = Object.entries(byChannel)
    .sort(([,a]:any,[,b]:any) => b.revenue - a.revenue)
    .map(([name, v]: any) => ({ name, value: +v.revenue.toFixed(2), count: v.count }))

  const cTotalRev  = parseFloat(cMeta?.totalRevenue ?? '0')
  const avgTicket  = meta?.count > 0 ? totalRevenue / meta.count : 0
  const cAvgTicket = cMeta?.count > 0 ? cTotalRev / cMeta.count : 0

  return (
    <>
      <div className="day-toolbar" style={{ gap: 16 }}>
        <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          <span style={{ color:'var(--text2)', fontSize:12 }}>{admin ? 'Del' : 'Día'}</span>
          <input type="date" value={from}
            onChange={e => { const v = e.target.value; if (v && new Date(v+'T12:00:00').getFullYear() > 1900) { setFrom(v); if (!admin) setTo(v) } }}
            className="plan-date-input" />
          {admin && <>
            <span style={{ color:'var(--text2)', fontSize:12 }}>al</span>
            <input type="date" value={to}
              onChange={e => { const v = e.target.value; if (v && new Date(v+'T12:00:00').getFullYear() > 1900) setTo(v) }}
              className="plan-date-input" />
          </>}
          <button className="btn btn-ghost btn-sm" onClick={apply}>Aplicar</button>
        </div>
        <div className="tab-bar">
          {(['pending','summary','all','analytics','caja'] as Tab[]).map(t => (
            <button key={t} className={`tab-btn${tab===t?' active':''}`} onClick={() => setTab(t)}>
              {t==='pending'?'Pendiente':t==='summary'?'Resumen':t==='all'?'Todas':t==='analytics'?'Gráficas':'Caja'}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="loading">Cargando…</div>}
      {error   && <div className="empty"><p style={{ color:'var(--red)' }}>{error}</p></div>}

      {!loading && !error && meta && (
        <>
          <div className="billing-cards">
            <div className="billing-card">
              <span className="billing-card-label">Facturado</span>
              <span className="billing-card-num">{fmtMoney(totalRevenue)}</span>
              <span className="billing-card-sub">{meta.count} reservas</span>
            </div>
            <div className="billing-card green">
              <span className="billing-card-label">Cobrado</span>
              <span className="billing-card-num">{fmtMoney(totalPaid)}</span>
              <span className="billing-card-sub">{totalRevenue>0 ? Math.round(totalPaid/totalRevenue*100) : 0}% del total</span>
            </div>
            <div className={`billing-card ${totalDue>0?'red':'green'}`}>
              <span className="billing-card-label">Pendiente</span>
              <span className="billing-card-num">{fmtMoney(totalDue)}</span>
              <span className="billing-card-sub">{data.filter(r=>(r.pendingBalance ?? 0) > 0.01).length} reservas con saldo</span>
            </div>
          </div>

          {tab === 'pending' && (
            withDue.length === 0
              ? <div className="empty"><div className="icon">✓</div><p>Sin saldos pendientes en el período</p></div>
              : <ReservationTable rows={withDue} navigate={navigate} />
          )}

          {tab === 'summary' && (
            Object.keys(byChannel).length === 0
              ? <div className="empty"><p>Sin datos de canal</p></div>
              : <div className="table-wrap"><table className="data-table">
                  <thead><tr><th>Canal</th><th>Reservas</th><th>Facturado</th><th>Cobrado</th><th>Pendiente</th></tr></thead>
                  <tbody>
                    {Object.entries(byChannel).sort(([,a]:any,[,b]:any)=>b.revenue-a.revenue).map(([ch,v]:any) => {
                      const due = v.revenue - v.paid
                      return <tr key={ch}>
                        <td>{ch}</td><td>{v.count}</td>
                        <td>{fmtMoney(v.revenue)}</td><td>{fmtMoney(v.paid)}</td>
                        <td style={{ color: due>0.01?'var(--red)':'var(--green)' }}>{fmtMoney(due)}</td>
                      </tr>
                    })}
                  </tbody>
                </table></div>
          )}

          {tab === 'all' && (
            data.length === 0
              ? <div className="empty"><div className="icon">📭</div><p>Sin reservas en el período</p></div>
              : <ReservationTable rows={data} navigate={navigate} />
          )}

          {tab === 'caja' && <CajaTab />}

          {tab === 'analytics' && (
            <div className="analytics-wrap">
              {/* Controles */}
              <div className="analytics-toolbar">
                <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                  <span style={{ fontSize:12, color:'var(--text2)' }}>Agrupar:</span>
                  <select className="plan-date-input" value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)}>
                    <option value="day">Por día</option>
                    <option value="month">Por mes</option>
                  </select>
                  <button className={`btn btn-sm ${compareActive?'btn-primary':'btn-ghost'}`} onClick={activateCompare}>
                    {compareActive ? '◼ Comparando' : '⊞ Comparar períodos'}
                  </button>
                </div>
                {compareActive && (
                  <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', marginTop:8 }}>
                    <span style={{ fontSize:12, color:'var(--text2)' }}>Período B:</span>
                    <input type="date" value={cFrom}
                      onChange={e => { const v = e.target.value; if (v && new Date(v+'T12:00:00').getFullYear() > 1900) setCFrom(v) }}
                      className="plan-date-input" />
                    <span style={{ fontSize:12, color:'var(--text2)' }}>—</span>
                    <input type="date" value={cTo}
                      onChange={e => { const v = e.target.value; if (v && new Date(v+'T12:00:00').getFullYear() > 1900) setCTo(v) }}
                      className="plan-date-input" />
                    <button className="btn btn-ghost btn-sm" onClick={() => {
                      const n = daysBetween(from, to)+1
                      setCFrom(addDays(from,-n)); setCTo(addDays(to,-n))
                    }}>Período anterior</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => {
                      setCFrom(addDays(from,-365)); setCTo(addDays(to,-365))
                    }}>Año anterior</button>
                  </div>
                )}
              </div>

              {/* KPIs comparación */}
              {compareActive && cMeta && (
                <div className="billing-cards" style={{ marginBottom: 0 }}>
                  <CompareKpi label="Facturado"   aVal={totalRevenue} bVal={cTotalRev}  fmt={fmtMoney} />
                  <CompareKpi label="Reservas"    aVal={meta.count}   bVal={cMeta.count} fmt={String} />
                  <CompareKpi label="Ticket medio" aVal={avgTicket}   bVal={cAvgTicket}  fmt={fmtMoney} />
                </div>
              )}

              {/* Gráfico temporal */}
              <div className="chart-box">
                <div className="chart-box-header">
                  <h3 className="chart-box-title">Ingresos {groupBy==='day'?'por día':'por mes'}</h3>
                  {compareActive && (
                    <div className="chart-legend-row">
                      <span className="chart-legend-dot" style={{ background:'#4f7cff' }}/>Período A
                      <span className="chart-legend-dot" style={{ background:'#f59e0b', marginLeft:12 }}/>Período B
                    </div>
                  )}
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={chartData} margin={{ top:8, right:12, left:8, bottom:8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.07)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill:'var(--text2)', fontSize:10 }} axisLine={false} tickLine={false}
                      interval={Math.max(0, Math.ceil(chartData.length/18)-1)} />
                    <YAxis tick={{ fill:'var(--text2)', fontSize:10 }} axisLine={false} tickLine={false}
                      tickFormatter={v => v>=1000 ? `${(v/1000).toFixed(0)}k` : v} width={44} />
                    <Tooltip
                      contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }}
                      formatter={(v: any) => [fmtMoney(v), '']}
                    />
                    <Bar dataKey="actual"   fill="#4f7cff" radius={[3,3,0,0]} maxBarSize={32} />
                    {compareActive && <Bar dataKey="anterior" fill="#f59e0b" radius={[3,3,0,0]} maxBarSize={32} />}
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Fila inferior: donut + barras por canal */}
              <div className="chart-grid-2">
                <div className="chart-box">
                  <h3 className="chart-box-title">Por canal</h3>
                  {channelData.length === 0
                    ? <div className="empty" style={{ minHeight:200 }}><p>Sin datos</p></div>
                    : <ResponsiveContainer width="100%" height={220}>
                        <PieChart>
                          <Pie data={channelData} dataKey="value" nameKey="name"
                            cx="50%" cy="50%" outerRadius={80} innerRadius={48}
                            paddingAngle={2}
                          >
                            {channelData.map((_, i) => <Cell key={i} fill={PALETTE[i%PALETTE.length]} />)}
                          </Pie>
                          <Tooltip
                            contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }}
                            formatter={(v: any, _n: any, p: any) => [`${fmtMoney(v)} · ${p.payload.count} res.`, p.payload.name]}
                          />
                          <Legend iconType="circle" iconSize={8}
                            formatter={(value: string) => <span style={{ color:'var(--text)', fontSize:11 }}>{value}</span>}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                  }
                </div>
                <div className="chart-box">
                  <h3 className="chart-box-title">Ingresos por canal</h3>
                  {channelData.length === 0
                    ? <div className="empty" style={{ minHeight:200 }}><p>Sin datos</p></div>
                    : <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={channelData} layout="vertical" margin={{ top:4, right:16, left:8, bottom:4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.07)" horizontal={false} />
                          <XAxis type="number" tick={{ fill:'var(--text2)', fontSize:10 }} axisLine={false} tickLine={false}
                            tickFormatter={v => v>=1000?`${(v/1000).toFixed(0)}k`:v} />
                          <YAxis type="category" dataKey="name" tick={{ fill:'var(--text)', fontSize:11 }} axisLine={false} tickLine={false} width={80} />
                          <Tooltip
                            contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }}
                            formatter={(v: any) => [fmtMoney(v), 'Facturado']}
                          />
                          <Bar dataKey="value" radius={[0,3,3,0]} maxBarSize={20}>
                            {channelData.map((_, i) => <Cell key={i} fill={PALETTE[i%PALETTE.length]} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                  }
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ─── Caja Tab ─────────────────────────────────────────────────────────────────

const METHOD_LABEL: Record<string, string> = {
  cash:                 'Efectivo',
  credit_card:          'Tarjeta',
  bank_transfer:        'Transferencia',
  stripe:               'Stripe',
  booking_virtual_card: 'Tarjeta virtual (Booking)',
  deposit:              'Depósito efectivo',
  deposit_cc:           'Depósito CC',
  jumbo_credit:         'Jumbo a crédito',
  other:                'Otros',
}
const METHOD_COLOR: Record<string, string> = {
  cash:                 '#22c55e',
  credit_card:          '#4f7cff',
  bank_transfer:        '#06b6d4',
  stripe:               '#a855f7',
  booking_virtual_card: '#f59e0b',
  deposit:              '#f97316',
  deposit_cc:           '#fb923c',
  jumbo_credit:         '#e879f9',
  other:                '#84cc16',
}

function parseEuroAmt(s: string): number {
  const c = s.trim()
  if (c.includes(',') && c.includes('.')) return parseFloat(c.replace(/\./g,'').replace(',','.'))
  if (c.includes(',')) return parseFloat(c.replace(',','.'))
  return parseFloat(c)
}

function parseBankRows(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/\s{2,}|\t/).map(p => p.trim()).filter(Boolean)
    let iso = '', amt = ''
    for (const p of parts) {
      const m = p.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
      if (m) { iso = `${m[3]!}-${m[2]!.padStart(2,'0')}-${m[1]!.padStart(2,'0')}`; continue }
      if (/^\d{4}-\d{2}-\d{2}$/.test(p)) { iso = p; continue }
      if (!amt && /^[\d.,]+$/.test(p)) amt = p
    }
    if (!iso || !amt) continue
    const v = parseEuroAmt(amt)
    if (!isNaN(v)) out[iso] = (out[iso] ?? 0) + v
  }
  return out
}

type Preset = 'today' | 'yesterday' | 'day2' | 'week' | 'month' | 'custom'

function isoToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function isoOffset(n: number) {
  const d = new Date(); d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function presetRange(p: Preset, cFrom: string, cTo: string): [string, string] {
  switch (p) {
    case 'today':     return [isoToday(),    isoToday()]
    case 'yesterday': return [isoOffset(-1), isoOffset(-1)]
    case 'day2':      return [isoOffset(-2), isoOffset(-2)]
    case 'week':      return [isoOffset(-6), isoToday()]
    case 'month':     return [isoOffset(-29),isoToday()]
    case 'custom':    return [cFrom, cTo]
  }
}

function CajaTab() {
  const [preset,        setPreset]        = useState<Preset>('today')
  const [cFrom,         setCFrom]         = useState(isoToday())
  const [cTo,           setCTo]           = useState(isoToday())
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState<string|null>(null)
  const [meta,          setMeta]          = useState<any>(null)
  const [txs,           setTxs]           = useState<any[]>([])
  const [bankText,      setBankText]      = useState('')
  const [reconcileAcct, setReconcileAcct] = useState('__all__')

  const load = useCallback(async (p: Preset, cf: string, ct: string) => {
    const [from, to] = presetRange(p, cf, ct)
    if (!from || !to) return
    setLoading(true); setError(null)
    try {
      const res: any = await api.paymentSummary({ dateFrom: from, dateTo: to })
      setMeta(res.meta); setTxs(res.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(preset, cFrom, cTo) }, []) // eslint-disable-line

  const applyPreset = (p: Preset) => { setPreset(p); load(p, cFrom, cTo) }
  const applyCustom = () => load('custom', cFrom, cTo)

  const PRESETS: { id: Preset; label: string }[] = [
    { id: 'today',     label: 'Hoy' },
    { id: 'yesterday', label: 'Ayer' },
    { id: 'day2',      label: 'Anteayer' },
    { id: 'week',      label: 'Última semana' },
    { id: 'month',     label: 'Último mes' },
    { id: 'custom',    label: 'Personalizado' },
  ]

  const total      = parseFloat(meta?.total ?? '0')
  const byMethod   = meta?.byMethod   ?? {}
  const byAccount  = meta?.byAccount  ?? {}
  const methodRows = Object.entries(byMethod)
    .sort(([,a]:any,[,b]:any) => b.total - a.total) as [string, {count:number;total:number}][]
  const accountRows = Object.entries(byAccount)
    .sort(([,a]:any,[,b]:any) => b.total - a.total) as [string, {count:number;total:number}][]

  const bankByDay = parseBankRows(bankText)
  const dailyPMS: Record<string, number> = {}
  for (const t of txs) {
    if (reconcileAcct !== '__all__' && (t.financialAccount?.name ?? '—') !== reconcileAcct) continue
    const k: string = t.transactionDate
    dailyPMS[k] = (dailyPMS[k] ?? 0) + parseFloat(t.amount ?? '0')
  }
  const reconcileDates = Array.from(new Set([...Object.keys(dailyPMS), ...Object.keys(bankByDay)])).sort()

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Selector de período */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
        {PRESETS.map(p => (
          <button key={p.id}
            className={`btn btn-sm ${preset===p.id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => applyPreset(p.id)}
          >{p.label}</button>
        ))}
        {preset === 'custom' && (
          <>
            <input type="date" value={cFrom}
              onChange={e => setCFrom(e.target.value)}
              className="plan-date-input" style={{ marginLeft:8 }} />
            <span style={{ color:'var(--text2)', fontSize:12 }}>—</span>
            <input type="date" value={cTo}
              onChange={e => setCTo(e.target.value)}
              className="plan-date-input" />
            <button className="btn btn-sm btn-ghost" onClick={applyCustom}>Aplicar</button>
          </>
        )}
      </div>

      {loading && <div className="loading">Cargando…</div>}
      {error   && <div className="empty"><p style={{ color:'var(--red)' }}>{error}</p></div>}

      {!loading && !error && meta && (
        <>
          {/* KPI total */}
          <div className="billing-cards">
            <div className="billing-card green">
              <span className="billing-card-label">Total imputado</span>
              <span className="billing-card-num">{fmtMoney(total)}</span>
              <span className="billing-card-sub">{meta.count} transacción{meta.count!==1?'es':''}</span>
            </div>
          </div>

          {meta.count === 0
            ? <div className="empty"><div className="icon">📭</div><p>Sin pagos en el período</p></div>
            : (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                {/* Por forma de pago */}
                <div className="card">
                  <div className="card-header"><h3>Por forma de pago</h3></div>
                  <table>
                    <thead><tr><th>Método</th><th style={{textAlign:'right'}}>Pagos</th><th style={{textAlign:'right'}}>Total</th></tr></thead>
                    <tbody>
                      {methodRows.map(([method, v]) => (
                        <tr key={method}>
                          <td>
                            <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                              <span style={{ width:8, height:8, borderRadius:'50%', background: METHOD_COLOR[method]??'var(--text2)', display:'inline-block' }} />
                              {METHOD_LABEL[method] ?? method}
                            </span>
                          </td>
                          <td style={{ textAlign:'right', color:'var(--text2)', fontSize:13 }}>{v.count}</td>
                          <td style={{ textAlign:'right', fontWeight:600 }}>{fmtMoney(v.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Por caja */}
                <div className="card">
                  <div className="card-header"><h3>Por caja</h3></div>
                  <table>
                    <thead><tr><th>Cuenta</th><th style={{textAlign:'right'}}>Pagos</th><th style={{textAlign:'right'}}>Total</th></tr></thead>
                    <tbody>
                      {accountRows.map(([name, v]) => (
                        <tr key={name}>
                          <td>{name}</td>
                          <td style={{ textAlign:'right', color:'var(--text2)', fontSize:13 }}>{v.count}</td>
                          <td style={{ textAlign:'right', fontWeight:600 }}>{fmtMoney(v.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          }

          {/* Conciliación bancaria */}
          <div className="card">
            <div className="card-header"><h3>Conciliación bancaria por día</h3></div>
            <div style={{ display:'flex', flexDirection:'column', gap:14, padding:'0 0 4px' }}>
              <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
                <span style={{ fontSize:12, color:'var(--text2)' }}>Caja:</span>
                <select className="plan-date-input" value={reconcileAcct} onChange={e => setReconcileAcct(e.target.value)}>
                  <option value="__all__">Todas</option>
                  {accountRows.map(([name]) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontSize:12, color:'var(--text2)', marginBottom:4 }}>
                  Pega los movimientos del banco (Fecha{'\t'}Importe, una línea por día):
                </div>
                <textarea
                  value={bankText}
                  onChange={e => setBankText(e.target.value)}
                  placeholder={"01/07/2026\t2680,96\n02/07/2026\t1693,4\n03/07/2026\t3022,73"}
                  rows={5}
                  style={{
                    width:'100%', boxSizing:'border-box', fontFamily:'monospace', fontSize:12,
                    background:'var(--bg2)', color:'var(--text)', border:'1px solid var(--border)',
                    borderRadius:8, padding:'8px 10px', resize:'vertical', outline:'none',
                  }}
                />
                {Object.keys(bankByDay).length > 0 && (
                  <div style={{ fontSize:11, color:'var(--text2)', marginTop:4 }}>
                    {Object.keys(bankByDay).length} días · total banco {fmtMoney(Object.values(bankByDay).reduce((s,v)=>s+v,0))}
                  </div>
                )}
              </div>
              <div style={{ overflowX:'auto' }}>
                <table className="data-table" style={{ minWidth:380 }}>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th style={{ textAlign:'right' }}>Sistema</th>
                      <th style={{ textAlign:'right' }}>Banco</th>
                      <th style={{ textAlign:'right' }}>Diferencia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconcileDates.length === 0 && (
                      <tr><td colSpan={4} style={{ textAlign:'center', padding:24, color:'var(--text2)' }}>
                        Pega los movimientos del banco arriba para ver la comparativa
                      </td></tr>
                    )}
                    {reconcileDates.map(d => {
                      const pms  = dailyPMS[d]  ?? 0
                      const bank = bankByDay[d] ?? 0
                      const diff = +(pms - bank).toFixed(2)
                      const ok   = Math.abs(diff) < 0.02
                      return (
                        <tr key={d}>
                          <td style={{ fontSize:12, whiteSpace:'nowrap', color:'var(--text2)' }}>
                            {new Date(d+'T12:00:00').toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'})}
                          </td>
                          <td style={{ textAlign:'right', fontFamily:'monospace', fontSize:13 }}>
                            {dailyPMS[d] != null ? fmtMoney(pms) : <span style={{ color:'var(--text2)' }}>—</span>}
                          </td>
                          <td style={{ textAlign:'right', fontFamily:'monospace', fontSize:13 }}>
                            {bankByDay[d] != null ? fmtMoney(bank) : <span style={{ color:'var(--text2)' }}>—</span>}
                          </td>
                          <td style={{
                            textAlign:'right', fontFamily:'monospace', fontSize:13,
                            fontWeight: ok ? 400 : 600,
                            color: ok ? 'var(--green)' : Math.abs(diff) < 1 ? 'var(--text2)' : 'var(--red)',
                          }}>
                            {ok ? '✓' : `${diff > 0 ? '+' : ''}${fmtMoney(diff)}`}
                          </td>
                        </tr>
                      )
                    })}
                    {reconcileDates.length > 1 && (() => {
                      const totPMS  = reconcileDates.reduce((s,d) => s + (dailyPMS[d]  ?? 0), 0)
                      const totBank = reconcileDates.reduce((s,d) => s + (bankByDay[d] ?? 0), 0)
                      const totDiff = +(totPMS - totBank).toFixed(2)
                      const ok = Math.abs(totDiff) < 0.02
                      return (
                        <tr style={{ fontWeight:700, borderTop:'2px solid var(--border)' }}>
                          <td style={{ color:'var(--text2)', fontSize:12 }}>Total</td>
                          <td style={{ textAlign:'right', fontFamily:'monospace', fontSize:13 }}>{fmtMoney(totPMS)}</td>
                          <td style={{ textAlign:'right', fontFamily:'monospace', fontSize:13 }}>{fmtMoney(totBank)}</td>
                          <td style={{
                            textAlign:'right', fontFamily:'monospace', fontSize:13, fontWeight:700,
                            color: ok ? 'var(--green)' : 'var(--red)',
                          }}>
                            {ok ? '✓' : `${totDiff > 0 ? '+' : ''}${fmtMoney(totDiff)}`}
                          </td>
                        </tr>
                      )
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Listado de transacciones */}
          {txs.length > 0 && (
            <div className="card">
              <div className="card-header"><h3>Transacciones del período</h3></div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <th>Fecha</th><th>Método</th><th>Caja</th><th>Nº de pedido</th><th>Reserva</th><th>Huésped</th><th>Cobrado en otro turno</th><th style={{textAlign:'right'}}>Importe</th>
                  </tr></thead>
                  <tbody>
                    {txs.map((t: any) => (
                      <tr key={t.id}>
                        <td style={{ fontSize:12, color:'var(--text2)' }}>{t.transactionDate}</td>
                        <td>
                          <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
                            <span style={{ width:7, height:7, borderRadius:'50%', background: METHOD_COLOR[t.paymentMethod]??'var(--text2)', display:'inline-block' }} />
                            {METHOD_LABEL[t.paymentMethod] ?? t.paymentMethod}
                          </span>
                        </td>
                        <td style={{ fontSize:12 }}>{t.financialAccount?.name ?? '—'}</td>
                        <td style={{ fontSize:12, color:'var(--text2)', fontFamily:'monospace', whiteSpace:'nowrap' }}>
                          {t.cardOperationNumber ?? '—'}
                        </td>
                        <td style={{ fontFamily:'monospace', fontSize:12, color:'var(--text2)' }}>
                          {t.reservation?.externalCode ?? (t.reservationId ? `#${t.reservationId}` : '—')}
                        </td>
                        <td style={{ fontSize:13 }}>
                          {t.reservation?.guest ? `${t.reservation.guest.firstName} ${t.reservation.guest.lastName}` : '—'}
                        </td>
                        <td style={{ fontSize:12, color:'var(--text2)', whiteSpace:'nowrap' }}>
                          {t.paidByUser
                            ? <span title={t.collectedAt ? fmtDateTime(t.collectedAt) : undefined}>
                                Sí — {t.paidByUser.firstName} {t.paidByUser.lastName}{t.collectedAt ? ` (${fmtDateTime(t.collectedAt)})` : ''}
                              </span>
                            : '—'}
                        </td>
                        <td style={{ textAlign:'right', fontWeight:600 }}>{fmtMoney(parseFloat(t.amount))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Comparación KPI ──────────────────────────────────────────────────────────

function CompareKpi({ label, aVal, bVal, fmt }: {
  label: string; aVal: number; bVal: number; fmt: (v: any) => string
}) {
  const delta = aVal - bVal
  const pct   = bVal !== 0 ? (delta / Math.abs(bVal)) * 100 : (aVal !== 0 ? 100 : 0)
  const up    = delta >= 0
  return (
    <div className="billing-card" style={{ flex:'1 1 150px' }}>
      <span className="billing-card-label">{label}</span>
      <span className="billing-card-num" style={{ fontSize:18 }}>{fmt(aVal)}</span>
      <span className="billing-card-sub" style={{ color: up?'var(--green)':'var(--red)', fontWeight:600, fontSize:12 }}>
        vs {fmt(bVal)}&ensp;({up?'+':''}{pct.toFixed(1)}%)
      </span>
    </div>
  )
}

// ─── Tabla de reservas ────────────────────────────────────────────────────────

function ReservationTable({ rows, navigate }: { rows: any[]; navigate: (p: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr>
          <th>Hab.</th><th>Huésped</th><th>Estancia</th><th>Canal</th>
          <th>Total</th><th>Pagado</th><th>Saldo</th><th>Estado</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map((r: any) => {
            // paid/due: no cuentan los depósitos retenidos sin cobrar como
            // pago de la estancia — vienen siempre calculados así desde
            // /dashboard/billing (ver realPaid/pendingBalance en dashboard.ts).
            // Sin fallback a total-amountPaid: reintroduciría el bug de
            // contar depósitos como pago si esta tabla se alimentara alguna
            // vez de otra fuente que no los precalculara.
            const total = parseFloat(r.total??'0')
            const paid  = r.realPaid ?? 0
            const due   = r.pendingBalance ?? 0
            return (
              <tr key={r.id}>
                <td><span className="badge">{r.room?.code??'—'}</span></td>
                <td>
                  <a href="#" onClick={e => { e.preventDefault(); navigate(`/reservations/${r.id}`) }}>
                    {r.guest?.firstName} {r.guest?.lastName}
                  </a>
                </td>
                <td style={{ fontSize:12, color:'var(--text2)' }}>{r.checkInDate} → {r.checkOutDate}</td>
                <td style={{ fontSize:12 }}>{r.bookingChannel?.name??'—'}</td>
                <td>{total>0?fmtMoney(total):'—'}</td>
                <td>{paid>0?fmtMoney(paid):'—'}</td>
                <td style={{ color:due>0.01?'var(--red)':'var(--green)', fontWeight:due>0.01?600:400 }}>
                  {due>0.01?fmtMoney(due):'✓'}
                </td>
                <td><StatusChip status={r.status} /></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => navigate(`/reservations/${r.id}`)}>Ver</button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
