import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ComposedChart, Bar, Line, BarChart, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  Legend, ResponsiveContainer, Cell,
} from 'recharts'
import { api, type Rate } from '../lib/api'
import { useAuth, canManage, hasRole } from '../contexts/AuthContext'
import { Badge } from '../components/Badge'
import { Modal } from '../components/Modal'
import CorporateReport from './CorporateView'
import FeedbackReport from './FeedbackView'

type GroupBy = 'day' | 'week' | 'month' | 'year'

const GROUP_LABEL: Record<GroupBy, string> = { day: 'Días', week: 'Semanas', month: 'Meses', year: 'Años' }

interface OccupancyItem {
  period: string
  label: string
  daysInPeriod: number
  roomNightsAvailable: number
  roomNightsOccupied: number
  occupancyPct: number
  revenue: number
  adr: number
  revpar: number
  arrivals: number
  avgPrice: number | null
}

function barColor(pct: number) {
  if (pct >= 80) return '#22c55e'
  if (pct >= 60) return '#3b82f6'
  if (pct >= 40) return '#f59e0b'
  return '#94a3b8'
}

function fmtEur(n: number) {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 })
}
function fmt1(n: number) {
  return n.toLocaleString('es-ES', { maximumFractionDigits: 1 })
}
function fmtSecs(s: number) {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="card stat-card" style={{ padding: '14px 18px', textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? 'var(--text1)', letterSpacing: '-0.5px' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: color ?? 'var(--text2)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function OccupancyBadge({ pct }: { pct: number }) {
  const [bg, fg] = pct >= 80
    ? ['#dcfce7', '#166534']
    : pct >= 60
    ? ['#dbeafe', '#1e40af']
    : pct >= 40
    ? ['#fef3c7', '#92400e']
    : ['#f1f5f9', '#475569']
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 12,
      fontSize: 12, fontWeight: 600, background: bg, color: fg,
    }}>
      {pct}%
    </span>
  )
}

interface CustomTooltipProps { active?: boolean; payload?: any[]; label?: string }
function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  const d: OccupancyItem = payload[0]?.payload
  if (!d) return null
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 14px', fontSize: 12,
      boxShadow: '0 4px 16px rgba(0,0,0,0.18)', minWidth: 200,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>{d.label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '3px 12px' }}>
        <span style={{ color: 'var(--text2)' }}>Ocupación</span><strong>{d.occupancyPct}%</strong>
        <span style={{ color: 'var(--text2)' }}>Hab. ocupadas</span>
        <strong>{d.roomNightsOccupied} / {d.roomNightsAvailable}</strong>
        <span style={{ color: 'var(--text2)' }}>Ingresos</span><strong>{fmtEur(d.revenue)}</strong>
        <span style={{ color: 'var(--text2)' }}>ADR</span><strong>{fmtEur(d.adr)}</strong>
        <span style={{ color: 'var(--text2)' }}>RevPAR</span><strong>{fmtEur(d.revpar)}</strong>
        {d.avgPrice !== null && (
          <><span style={{ color: '#b45309' }}>Precio tarifa</span><strong style={{ color: '#b45309' }}>{fmtEur(d.avgPrice)}</strong></>
        )}
      </div>
    </div>
  )
}

// ── DateRangeFilter ─────────────────────────────────────────────────────────

function DateRangeFilter({
  from, to, appliedFrom, appliedTo, onFromChange, onToChange, onApply, maxDays,
  group, onGroupChange, groupOptions = ['day', 'week', 'month'],
}: {
  from: string; to: string; appliedFrom: string; appliedTo: string
  onFromChange: (v: string) => void; onToChange: (v: string) => void; onApply: () => void
  maxDays?: number; group?: GroupBy; onGroupChange?: (g: GroupBy) => void; groupOptions?: GroupBy[]
}) {
  const rangeError = (() => {
    if (!from || !to || from > to) return null
    if (maxDays) {
      const days = (new Date(to).getTime() - new Date(from).getTime()) / 86400000
      if (days > maxDays) return `El rango máximo es de ${maxDays} días.`
    }
    return null
  })()
  const datesChanged = from !== appliedFrom || to !== appliedTo
  return (
    <div className="card" style={{ marginBottom: 16, padding: '14px 18px' }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Desde</div>
          <input type="date" value={from} onChange={e => onFromChange(e.target.value)}
            style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13 }} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Hasta</div>
          <input type="date" value={to} onChange={e => onToChange(e.target.value)}
            style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13 }} />
        </div>
        <div style={{ alignSelf: 'flex-end' }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={onApply}
            disabled={!!rangeError || !from || !to || from > to}
            style={{ position: 'relative', paddingRight: datesChanged && !rangeError ? 28 : undefined }}
          >
            Mostrar
            {datesChanged && !rangeError && (
              <span style={{
                position: 'absolute', top: -5, right: -5,
                width: 10, height: 10, borderRadius: '50%',
                background: 'var(--yellow)', border: '2px solid var(--bg2)',
              }} />
            )}
          </button>
        </div>
        {group && onGroupChange && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Agrupar por</div>
            <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              {groupOptions.map((g, i) => (
                <button
                  key={g}
                  onClick={() => onGroupChange(g)}
                  style={{
                    padding: '5px 14px', fontSize: 13, border: 'none', cursor: 'pointer',
                    background: group === g ? 'var(--accent)' : 'var(--bg2)',
                    color: group === g ? '#fff' : 'var(--text)',
                    fontWeight: group === g ? 600 : 400,
                    borderRight: i !== groupOptions.length - 1 ? '1px solid var(--border)' : undefined,
                  }}
                >
                  {GROUP_LABEL[g]}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {rangeError && (
        <div style={{
          background: 'rgba(239,68,68,.1)', border: '1px solid var(--red)',
          borderRadius: 8, padding: '10px 16px', marginTop: 10,
          fontSize: 13, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          ⚠ {rangeError}
        </div>
      )}
    </div>
  )
}

// ── Rango de fechas por mes (compartido por todas las pestañas de Informes) ────

// YYYY-MM-DD a partir de los componentes LOCALES de una fecha — a diferencia de
// .toISOString() (que convierte a UTC y en Europe/Madrid puede restar un día,
// p.ej. 1 de agosto local → "31/7" si se usa toISOString().slice(0,10)).
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// Primer día del mes actual + `offsetMonths` (0 = mes actual, -1 = anterior, 1 = siguiente)
function monthStart(offsetMonths: number): string {
  const d = new Date()
  return ymd(new Date(d.getFullYear(), d.getMonth() + offsetMonths, 1))
}
// Último día de ese mismo mes
function monthEnd(offsetMonths: number): string {
  const d = new Date()
  return ymd(new Date(d.getFullYear(), d.getMonth() + offsetMonths + 1, 0))
}

// Estado de rango de fechas de un informe, con el mes completo actual como
// valor por defecto y un atajo para saltar de mes en mes.
function useMonthRange() {
  const [from,        setFrom]        = useState(monthStart(0))
  const [to,          setTo]          = useState(monthEnd(0))
  const [appliedFrom, setAppliedFrom] = useState(monthStart(0))
  const [appliedTo,   setAppliedTo]   = useState(monthEnd(0))

  const applyDates = () => {
    if (!from || !to || from > to) return
    setAppliedFrom(from); setAppliedTo(to)
  }
  const quickMonth = (offset: number) => {
    const f = monthStart(offset), t = monthEnd(offset)
    setFrom(f); setTo(t); setAppliedFrom(f); setAppliedTo(t)
  }

  return { from, to, appliedFrom, appliedTo, setFrom, setTo, setAppliedFrom, setAppliedTo, applyDates, quickMonth }
}

// Botones de atajo: mes anterior / actual / siguiente
function MonthQuickButtons({ onQuick }: { onQuick: (offset: number) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
      <button className="btn btn-ghost btn-sm" onClick={() => onQuick(-1)}>‹ Mes anterior</button>
      <button className="btn btn-ghost btn-sm" onClick={() => onQuick(0)}>Mes actual</button>
      <button className="btn btn-ghost btn-sm" onClick={() => onQuick(1)}>Mes siguiente ›</button>
    </div>
  )
}

// ── OcupacionReport ─────────────────────────────────────────────────────────

function OcupacionReport() {
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, setAppliedFrom, setAppliedTo, quickMonth } = useMonthRange()
  const [group,       setGroup]       = useState<GroupBy>('day')
  const [showPrice,   setShowPrice]   = useState(false)
  const [rateId,      setRateId]      = useState<number | null>(null)
  const [includeCancelled, setIncludeCancelled] = useState(false)
  const [rates,       setRates]       = useState<Rate[]>([])
  const [data,        setData]        = useState<OccupancyItem[]>([])
  const [avgLeadDays, setAvgLeadDays] = useState<number | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  useEffect(() => { api.listRates().then(r => setRates(r.data)).catch(() => {}) }, [])

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo || appliedFrom > appliedTo) return
    setLoading(true); setError(null)
    try {
      const params: Record<string, string> = { from: appliedFrom, to: appliedTo, group }
      if (showPrice && rateId) params.rateId = String(rateId)
      if (includeCancelled) params.includeCancelled = 'true'
      const r: any = await api.getOccupancyReport(params)
      setData(r.data)
      setAvgLeadDays(r.totals?.avgLeadDays ?? null)
    } catch (e: any) {
      setError(e.message)
    } finally { setLoading(false) }
  }, [appliedFrom, appliedTo, group, showPrice, rateId, includeCancelled])

  useEffect(() => { load() }, [load])

  const applyDates = () => {
    const days = (new Date(to).getTime() - new Date(from).getTime()) / 86400000
    if (!from || !to || from > to || days > 92) return
    setAppliedFrom(from); setAppliedTo(to)
  }

  const totalRevenue = data.reduce((s, d) => s + d.revenue, 0)
  const totalNights  = data.reduce((s, d) => s + d.roomNightsOccupied, 0)
  const totalAvail   = data.reduce((s, d) => s + d.roomNightsAvailable, 0)
  const avgOcc       = totalAvail > 0 ? totalNights / totalAvail * 100 : 0
  const avgAdr       = totalNights > 0 ? totalRevenue / totalNights : 0
  const avgRevpar    = totalAvail  > 0 ? totalRevenue / totalAvail  : 0

  const hasPriceData = showPrice && data.some(d => d.avgPrice !== null)
  const maxPrice     = hasPriceData ? Math.ceil(Math.max(...data.map(d => d.avgPrice ?? 0)) * 1.2 / 10) * 10 : undefined
  const tickAngle    = data.length > 20 ? -40 : 0
  const tickInterval = data.length > 60 ? 6 : data.length > 30 ? 2 : 0

  return (
    <>
      <MonthQuickButtons onQuick={quickMonth} />
      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates} maxDays={92}
        group={group} onGroupChange={setGroup}
      />
      {/* Extra filter: overlay price */}
      <div className="card" style={{ marginBottom: 16, padding: '10px 18px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showPrice} onChange={e => setShowPrice(e.target.checked)} />
            Superponer precios
          </label>
          {showPrice && (
            <select
              value={rateId ?? ''}
              onChange={e => setRateId(e.target.value ? Number(e.target.value) : null)}
              style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13 }}
            >
              <option value="">— elige tarifa —</option>
              {rates.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginLeft: 12 }}>
            <input type="checkbox" checked={includeCancelled} onChange={e => setIncludeCancelled(e.target.checked)} />
            Contar canceladas
          </label>
        </div>
      </div>

      {!loading && data.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, marginBottom: 16 }}>
          <StatCard label="Ocupación media" value={fmt1(avgOcc) + '%'} />
          <StatCard label="Ingresos totales" value={fmtEur(totalRevenue)} />
          <StatCard label="ADR" value={fmtEur(avgAdr)} />
          <StatCard label="RevPAR" value={fmtEur(avgRevpar)} />
          <StatCard
            label="Lead time medio"
            value={avgLeadDays != null ? `${fmt1(avgLeadDays)} días` : '—'}
            sub="de las reservas hechas en el rango"
          />
        </div>
      )}

      <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12, color: 'var(--text1)' }}>
          Ocupación{hasPriceData ? ' y precio por noche' : ''}
        </div>
        {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
        {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}
        {!loading && !error && data.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Sin datos para el período seleccionado</div>
        )}
        {!loading && !error && data.length > 0 && (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={data} margin={{ top: 4, right: hasPriceData ? 60 : 20, left: 8, bottom: tickAngle !== 0 ? 40 : 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text2)' }} angle={tickAngle}
                textAnchor={tickAngle !== 0 ? 'end' : 'middle'} interval={tickInterval} />
              <YAxis yAxisId="left" domain={[0, 100]} tickFormatter={v => v + '%'}
                tick={{ fontSize: 11, fill: 'var(--text2)' }} width={44} />
              {hasPriceData && (
                <YAxis yAxisId="right" orientation="right" domain={[0, maxPrice ?? 'auto']}
                  tickFormatter={v => v + '€'} tick={{ fontSize: 11, fill: '#b45309' }} width={52} />
              )}
              <RTooltip content={<CustomTooltip />} />
              <Legend formatter={(v) => v === 'occupancyPct' ? 'Ocupación (%)' : 'Precio tarifa (€)'} wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="left" dataKey="occupancyPct" name="occupancyPct" radius={[3, 3, 0, 0]}>
                {data.map((entry, i) => <Cell key={i} fill={barColor(entry.occupancyPct)} />)}
              </Bar>
              {hasPriceData && (
                <Line yAxisId="right" dataKey="avgPrice" name="avgPrice" stroke="#f59e0b"
                  strokeWidth={2} dot={{ r: 3, fill: '#f59e0b' }} activeDot={{ r: 5 }} connectNulls />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {!loading && data.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Período</th>
                <th style={{ textAlign: 'right' }}>Hab. disp.</th>
                <th style={{ textAlign: 'right' }}>Hab. ocup.</th>
                <th style={{ textAlign: 'right' }}>Ocupación</th>
                <th style={{ textAlign: 'right' }}>Llegadas</th>
                <th style={{ textAlign: 'right' }}>Ingresos</th>
                <th style={{ textAlign: 'right' }}>ADR</th>
                <th style={{ textAlign: 'right' }}>RevPAR</th>
                {hasPriceData && <th style={{ textAlign: 'right' }}>Precio tarifa</th>}
              </tr>
            </thead>
            <tbody>
              {data.map(d => (
                <tr key={d.period}>
                  <td style={{ fontWeight: 500 }}>{d.label}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{d.roomNightsAvailable}</td>
                  <td style={{ textAlign: 'right' }}>{d.roomNightsOccupied}</td>
                  <td style={{ textAlign: 'right' }}><OccupancyBadge pct={d.occupancyPct} /></td>
                  <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{d.arrivals}</td>
                  <td style={{ textAlign: 'right', fontWeight: 500 }}>{fmtEur(d.revenue)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{fmtEur(d.adr)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{fmtEur(d.revpar)}</td>
                  {hasPriceData && (
                    <td style={{ textAlign: 'right', color: '#b45309', fontWeight: 500 }}>
                      {d.avgPrice !== null ? fmtEur(d.avgPrice) : '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                <td>Total / Promedio</td>
                <td style={{ textAlign: 'right' }}>{totalAvail}</td>
                <td style={{ textAlign: 'right' }}>{totalNights}</td>
                <td style={{ textAlign: 'right' }}><OccupancyBadge pct={Math.round(avgOcc * 10) / 10} /></td>
                <td />
                <td style={{ textAlign: 'right' }}>{fmtEur(totalRevenue)}</td>
                <td style={{ textAlign: 'right' }}>{fmtEur(avgAdr)}</td>
                <td style={{ textAlign: 'right' }}>{fmtEur(avgRevpar)}</td>
                {hasPriceData && <td />}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  )
}

// ── RoomAccessVisitsReport ────────────────────────────────────────────────────
// Uso del QR de habitación: nº de visitas (cargas de página con éxito) por
// día, sea cual sea la habitación — ver room_access_visits / GET
// /api/room-access/reservation.

function RoomAccessVisitsReport() {
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, applyDates, quickMonth } = useMonthRange()
  const [rows,    setRows]    = useState<Awaited<ReturnType<typeof api.getRoomAccessVisits>>['data']>([])
  const [meta,    setMeta]    = useState<Awaited<ReturnType<typeof api.getRoomAccessVisits>>['meta'] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo || appliedFrom > appliedTo) return
    setLoading(true); setError(null)
    try {
      const r = await api.getRoomAccessVisits(appliedFrom, appliedTo)
      setRows(r.data); setMeta(r.meta)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [appliedFrom, appliedTo])

  useEffect(() => { load() }, [load])

  return (
    <>
      <MonthQuickButtons onQuick={quickMonth} />
      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates} maxDays={366}
      />
      <div className="card" style={{ marginBottom: 16, padding: '12px 18px', fontSize: 13, color: 'var(--text2)' }}>
        Cada visita es una carga con éxito de la página de la estancia desde el QR físico de la habitación
        (confirmando apellido) — cuenta una vez por sesión abierta, no cada acción que haga dentro (ver detalle, extras, feedback...).
      </div>

      {meta && meta.totalVisits > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
          <StatCard label="Visitas totales"  value={String(meta.totalVisits)} />
          <StatCard label="Días con visitas" value={String(meta.daysWithVisits)} />
          <StatCard label="Media por día"    value={meta.avgPerDay.toLocaleString('es-ES', { maximumFractionDigits: 1 })} />
          {meta.busiestDay && (
            <StatCard label="Día con más visitas" value={`${meta.busiestDay.visits} (${fmtDate(meta.busiestDay.day)})`} />
          )}
        </div>
      )}

      <div className="card">
        {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
        {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}
        {!loading && !error && rows.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Sin visitas registradas en el período</div>
        )}
        {!loading && !error && rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th style={{ textAlign: 'right' }}>Visitas</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.day}>
                    <td>{fmtDate(r.day)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.visits}</td>
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

// ── CarritosAbandonadosReport ───────────────────────────────────────────────

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
}

function CarritosAbandonadosReport() {
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, applyDates, quickMonth } = useMonthRange()
  const navigate = useNavigate()
  const [carts,   setCarts]   = useState<Awaited<ReturnType<typeof api.getAbandonedCarts>>['carts']>([])
  const [meta,    setMeta]    = useState<{ carts: number; amount: number; emailsSent: number; recovered: number; recoveredAmount: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo || appliedFrom > appliedTo) return
    setLoading(true); setError(null)
    try {
      const r = await api.getAbandonedCarts(appliedFrom, appliedTo)
      setCarts(r.carts); setMeta(r.meta)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [appliedFrom, appliedTo])

  useEffect(() => { load() }, [load])

  return (
    <>
      <MonthQuickButtons onQuick={quickMonth} />
      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates} maxDays={366}
      />
      <div className="card" style={{ marginBottom: 16, padding: '12px 18px', fontSize: 13, color: 'var(--text2)' }}>
        Reservas web iniciadas sin completar el pago. Pasados unos minutos se les envía un email (y WhatsApp si hay teléfono)
        con enlace de recuperación y descuento. Cada fila lleva a la reserva provisional (o cancelada, si ya caducó) que
        generó el carrito.
      </div>

      {meta && meta.carts > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
          <StatCard label="Carritos"           value={String(meta.carts)} />
          <StatCard label="Importe perdido"    value={fmtEur(meta.amount)} />
          <StatCard label="Emails enviados"    value={String(meta.emailsSent)} />
          <StatCard label="Recuperados"        value={`${meta.recovered} (${meta.carts > 0 ? Math.round(meta.recovered / meta.carts * 100) : 0}%)`} />
          <StatCard label="Importe recuperado" value={fmtEur(meta.recoveredAmount)} />
        </div>
      )}

      <div className="card">
        {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
        {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}
        {!loading && !error && carts.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Sin carritos abandonados en el período</div>
        )}
        {!loading && !error && carts.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Huésped</th>
                  <th>Email intentado</th>
                  <th>Teléfono</th>
                  <th style={{ textAlign: 'right' }}>Importe</th>
                  <th>Fechas estancia</th>
                  <th>Email recuperación</th>
                  <th>WhatsApp</th>
                  <th>Reserva</th>
                  <th>Recuperado</th>
                </tr>
              </thead>
              <tbody>
                {carts.map(c => (
                  <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/reservations/${c.reservationId}`)}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDateTime(c.createdAt)}</td>
                    <td>{c.guestName || '—'}</td>
                    <td style={{ fontSize: 12 }}>{c.email || '—'}</td>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{c.phone || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{fmtEur(parseFloat(c.amount))}</td>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{c.checkIn ?? '—'} → {c.checkOut ?? '—'}</td>
                    <td>
                      {c.emailSentAt ? (
                        <span style={{ color: 'var(--green)', fontSize: 12 }} title={`Enviado ${fmtDateTime(c.emailSentAt)}`}>✓ Enviado</span>
                      ) : c.emailError ? (
                        <span style={{ color: 'var(--red)', fontSize: 12 }} title={c.emailError}>✗ {c.emailError.slice(0, 40)}{c.emailError.length > 40 ? '…' : ''}</span>
                      ) : (
                        <span style={{ color: 'var(--text2)', fontSize: 12, cursor: c.emailSkipReason ? 'help' : undefined }} title={c.emailSkipReason ?? undefined}>
                          — no intentado
                        </span>
                      )}
                    </td>
                    <td>
                      {c.whatsappSentAt ? (
                        <span style={{ color: 'var(--green)', fontSize: 12 }} title={`Enviado ${fmtDateTime(c.whatsappSentAt)}`}>✓ Enviado</span>
                      ) : c.whatsappError ? (
                        <span style={{ color: 'var(--red)', fontSize: 12 }} title={c.whatsappError}>✗ {c.whatsappError.slice(0, 40)}{c.whatsappError.length > 40 ? '…' : ''}</span>
                      ) : (
                        <span style={{ color: 'var(--text2)', fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td><Badge status={c.reservationStatus} /></td>
                    <td>
                      {c.recoveredAt
                        ? <span style={{ color: 'var(--green)', fontWeight: 600 }}>✓ {fmtEur(parseFloat(c.recoveredAmount ?? '0'))}</span>
                        : <span style={{ color: 'var(--text2)' }}>—</span>}
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

// ── VentasCanalReport ───────────────────────────────────────────────────────

const DEFAULT_DIRECT = 'walk-in, web directa, booking engine, direct'
const DEFAULT_OTA    = 'booking.com, expedia, agoda'

function VentasCanalReport() {
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, applyDates, quickMonth } = useMonthRange()
  const [group,       setGroup]       = useState<GroupBy>('month')
  const [directNames, setDirectNames] = useState(DEFAULT_DIRECT)
  const [otaNames,    setOtaNames]    = useState(DEFAULT_OTA)
  const [data,        setData]        = useState<any[]>([])
  const [meta,        setMeta]        = useState<any>(null)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo) return
    setLoading(true); setError(null)
    try {
      const r = await api.getChannelSalesReport({ from: appliedFrom, to: appliedTo, group, directNames, otaNames })
      setData(r.data); setMeta(r.meta)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [appliedFrom, appliedTo, group, directNames, otaNames])

  useEffect(() => { load() }, [load])

  const tickAngle    = data.length > 12 ? -40 : 0
  const tickInterval = data.length > 24 ? 3 : 0

  return (
    <>
      <MonthQuickButtons onQuick={quickMonth} />
      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates}
        group={group} onGroupChange={setGroup}
      />

      <div className="card" style={{ marginBottom: 16, padding: '14px 18px' }}>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
          Clasificación de canales por nombre parcial (separados por coma, sin distinción de mayúsculas)
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Directos</div>
            <input
              value={directNames}
              onChange={e => setDirectNames(e.target.value)}
              onBlur={load}
              placeholder="walk-in, web directa, booking engine"
              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>OTAs</div>
            <input
              value={otaNames}
              onChange={e => setOtaNames(e.target.value)}
              onBlur={load}
              placeholder="booking.com, expedia, agoda"
              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13 }}
            />
          </div>
        </div>
      </div>

      {meta && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          <StatCard label="Ventas directas" value={String(meta.totalDirectCount)} />
          <StatCard label="Ingresos directos" value={fmtEur(meta.totalDirectRevenue)} />
          <StatCard label="Ventas OTA" value={String(meta.totalOtaCount)} />
          <StatCard label="Ingresos OTA" value={fmtEur(meta.totalOtaRevenue)} />
        </div>
      )}

      <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Ventas por canal — Nº de reservas</div>
        {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
        {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}
        {!loading && !error && data.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Sin datos</div>}
        {!loading && !error && data.length > 0 && (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data} margin={{ top: 4, right: 20, left: 8, bottom: tickAngle !== 0 ? 40 : 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text2)' }} angle={tickAngle}
                textAnchor={tickAngle !== 0 ? 'end' : 'middle'} interval={tickInterval} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text2)' }} width={36} allowDecimals={false} />
              <RTooltip
                contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }}
                formatter={(v: any, n: any) => [v, n === 'direct_count' ? 'Directas' : n === 'ota_count' ? 'OTA' : 'Otros'] as any}
              />
              <Legend formatter={(n) => n === 'direct_count' ? 'Directas' : n === 'ota_count' ? 'OTA' : 'Otros'} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="direct_count" name="direct_count" fill="#3b82f6" radius={[3, 3, 0, 0]} stackId="a" />
              <Bar dataKey="ota_count"    name="ota_count"    fill="#f59e0b" radius={[3, 3, 0, 0]} stackId="b" />
              <Bar dataKey="other_count"  name="other_count"  fill="#94a3b8" radius={[3, 3, 0, 0]} stackId="c" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Ventas por canal — Ingresos</div>
        {!loading && !error && data.length > 0 && (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data} margin={{ top: 4, right: 20, left: 8, bottom: tickAngle !== 0 ? 40 : 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text2)' }} angle={tickAngle}
                textAnchor={tickAngle !== 0 ? 'end' : 'middle'} interval={tickInterval} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text2)' }} width={60} tickFormatter={v => fmtEur(v)} />
              <RTooltip
                contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }}
                formatter={(v: any, n: any) => [fmtEur(Number(v)), n === 'direct_revenue' ? 'Directas' : n === 'ota_revenue' ? 'OTA' : 'Otros'] as any}
              />
              <Legend formatter={(n) => n === 'direct_revenue' ? 'Directas' : n === 'ota_revenue' ? 'OTA' : 'Otros'} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="direct_revenue" name="direct_revenue" fill="#3b82f6" radius={[3, 3, 0, 0]} stackId="a" />
              <Bar dataKey="ota_revenue"    name="ota_revenue"    fill="#f59e0b" radius={[3, 3, 0, 0]} stackId="b" />
              <Bar dataKey="other_revenue"  name="other_revenue"  fill="#94a3b8" radius={[3, 3, 0, 0]} stackId="c" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {!loading && data.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Período</th>
                <th style={{ textAlign: 'right' }}>Directas</th>
                <th style={{ textAlign: 'right' }}>Ingresos directos</th>
                <th style={{ textAlign: 'right' }}>OTA</th>
                <th style={{ textAlign: 'right' }}>Ingresos OTA</th>
                <th style={{ textAlign: 'right' }}>Otros</th>
                <th style={{ textAlign: 'right' }}>Ingresos otros</th>
              </tr>
            </thead>
            <tbody>
              {data.map(d => (
                <tr key={d.period}>
                  <td style={{ fontWeight: 500 }}>{d.label}</td>
                  <td style={{ textAlign: 'right', color: '#3b82f6', fontWeight: 500 }}>{d.direct_count}</td>
                  <td style={{ textAlign: 'right' }}>{fmtEur(d.direct_revenue)}</td>
                  <td style={{ textAlign: 'right', color: '#f59e0b', fontWeight: 500 }}>{d.ota_count}</td>
                  <td style={{ textAlign: 'right' }}>{fmtEur(d.ota_revenue)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{d.other_count}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{fmtEur(d.other_revenue)}</td>
                </tr>
              ))}
            </tbody>
            {meta && (
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                  <td>Total</td>
                  <td style={{ textAlign: 'right', color: '#3b82f6' }}>{meta.totalDirectCount}</td>
                  <td style={{ textAlign: 'right' }}>{fmtEur(meta.totalDirectRevenue)}</td>
                  <td style={{ textAlign: 'right', color: '#f59e0b' }}>{meta.totalOtaCount}</td>
                  <td style={{ textAlign: 'right' }}>{fmtEur(meta.totalOtaRevenue)}</td>
                  <td /><td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </>
  )
}

// ── ComisionesReport ─────────────────────────────────────────────────────────
// Comisión de OTAs (Booking.com y otras) por canal y período. El % es
// ajustable por canal (se guarda en booking_channels.commission_pct) — nunca
// se inventa un valor, solo Booking.com trae 15% por defecto vía migración.

function ChannelCommissionEditor({ channels, onSaved }: {
  channels: { id: number; name: string; commissionPct: string | null }[]
  onSaved: () => void
}) {
  const { user } = useAuth()
  const editable = canManage(user)   // el PATCH ya lo exige en el servidor; esto evita la falsa sensación de poder editar
  const [values, setValues] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<Set<number>>(new Set())

  useEffect(() => {
    setValues(Object.fromEntries(channels.map(ch => [ch.id, ch.commissionPct ?? ''])))
  }, [channels])

  const save = async (channelId: number) => {
    const raw = (values[channelId] ?? '').trim()
    const pct = raw === '' ? null : Number(raw)
    if (pct != null && (isNaN(pct) || pct < 0 || pct > 100)) return
    setSaving(prev => new Set([...prev, channelId]))
    try {
      await api.updateChannelCommission(channelId, pct)
      onSaved()
    } catch { /* silencioso, el input mantiene lo que se escribió */ }
    finally { setSaving(prev => { const n = new Set(prev); n.delete(channelId); return n }) }
  }

  return (
    <div className="card" style={{ marginBottom: 16, padding: '14px 18px' }}>
      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>
        {editable
          ? '% de comisión por canal sobre el total de la reserva — déjalo en blanco para no aplicar comisión a ese canal'
          : '% de comisión por canal (solo dirección puede ajustarlo)'}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {channels.map(ch => (
          <label key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
            border: '1px solid var(--border)', borderRadius: 8, padding: '5px 10px', background: 'var(--bg2)' }}>
            {ch.name}
            <input
              type="number" min={0} max={100} step={0.5}
              value={values[ch.id] ?? ''}
              disabled={!editable || saving.has(ch.id)}
              onChange={e => setValues(v => ({ ...v, [ch.id]: e.target.value }))}
              onBlur={() => save(ch.id)}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              placeholder="—"
              style={{ width: 56, padding: '3px 6px', borderRadius: 5, border: '1px solid var(--border)',
                background: 'var(--bg1)', color: 'var(--text)', fontSize: 13 }}
            />%
          </label>
        ))}
      </div>
    </div>
  )
}

function ComisionesReport() {
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, applyDates, quickMonth } = useMonthRange()
  const [group,       setGroup]       = useState<GroupBy>('month')
  const [data,        setData]        = useState<any[]>([])
  const [channels,    setChannels]    = useState<{ id: number; name: string; commissionPct: string | null }[]>([])
  const [meta,        setMeta]        = useState<any>(null)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo) return
    setLoading(true); setError(null)
    try {
      const r = await api.getCommissionsReport({ from: appliedFrom, to: appliedTo, group })
      setData(r.data); setChannels(r.channels); setMeta(r.meta)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [appliedFrom, appliedTo, group])

  useEffect(() => { load() }, [load])

  // Canales directos sin comisión OTA — no tiene sentido configurarles % ni
  // verlos en este informe (fuera de esta pestaña siguen apareciendo igual,
  // p.ej. en el selector de canal de una reserva o en Ventas por canal).
  const HIDDEN_CHANNELS = ['phone', 'email', 'walk-in']
  const visibleChannels = channels.filter(ch => !HIDDEN_CHANNELS.includes(ch.name.trim().toLowerCase()))

  // Canales que aparecen en la tabla: con % configurado, o con comisión real
  // ya calculada en los datos (bm_commission que trae FDM, aunque no haya %
  // configurado a mano) — los que no tienen ni una cosa ni la otra no aportan
  // nada a un informe de comisiones.
  const commissionChannels = visibleChannels.filter(ch =>
    parseFloat(ch.commissionPct ?? '0') > 0
    || data.some(d => (d[`ch_${ch.id}_commission`] ?? 0) > 0))

  // % efectivo de esa fila (comisión / ingresos), no el configurado del canal:
  // puede venir de bm_commission (real, por reserva) y no coincidir exactamente
  // con el % fijo si FDM aplicó condiciones distintas a alguna reserva.
  const effectivePct = (revenue: number, commission: number) =>
    revenue > 0 ? `${((commission / revenue) * 100).toFixed(1)}%` : '—'

  return (
    <>
      <ChannelCommissionEditor channels={visibleChannels} onSaved={load} />

      <MonthQuickButtons onQuick={quickMonth} />

      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates}
        group={group} onGroupChange={setGroup} groupOptions={['month', 'year']}
      />

      {meta && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
          <StatCard label="Precio original (sin extras/ampliaciones)" value={fmtEur(meta.totalRevenue)} />
          <StatCard label="Comisión total" value={fmtEur(meta.totalCommission)} color="#f59e0b" />
        </div>
      )}

      {commissionChannels.length === 0 && !loading && (
        <div className="card" style={{ padding: 20, textAlign: 'center', color: 'var(--text2)' }}>
          Ningún canal tiene comisión configurada — ajusta el % arriba (Booking.com suele ser 15%).
        </div>
      )}

      {commissionChannels.length > 0 && (
        <div className="card">
          <div style={{ padding: '12px 18px 0', fontSize: 12, color: 'var(--text2)' }}>
            "Precio original" = precio de la reserva al importarla, sin extras ni ampliaciones (esas no llevan comisión).
            La comisión usa el importe real que reporta FDM cuando está disponible; si no, aplica el % configurado arriba.
            Este dato solo se guarda al importar reservas nuevas desde FDM a partir de ahora — en reservas más antiguas
            "precio original" cae al total completo (sí puede incluir extras/ampliaciones si las tuvo).
            Solo cuentan las reservas con algo cobrado — una reserva a 0 € cobrados no suma aquí.
          </div>
          {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
          {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}
          {!loading && !error && data.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Sin datos</div>}
          {!loading && !error && data.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Período</th>
                  <th>Canal</th>
                  <th style={{ textAlign: 'right' }}>Reservas</th>
                  <th style={{ textAlign: 'right' }}>Precio original</th>
                  <th style={{ textAlign: 'right' }}>%</th>
                  <th style={{ textAlign: 'right' }}>Comisión</th>
                </tr>
              </thead>
              <tbody>
                {[...data].reverse().flatMap(d => commissionChannels
                  .filter(ch => (d[`ch_${ch.id}_revenue`] ?? 0) > 0)
                  .map(ch => (
                    <tr key={`${d.period}-${ch.id}`}>
                      <td style={{ fontWeight: 500 }}>{d.label}</td>
                      <td>{ch.name}</td>
                      <td style={{ textAlign: 'right' }}>{d[`ch_${ch.id}_count`]}</td>
                      <td style={{ textAlign: 'right' }}>{fmtEur(d[`ch_${ch.id}_revenue`])}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{effectivePct(d[`ch_${ch.id}_revenue`], d[`ch_${ch.id}_commission`])}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: '#f59e0b' }}>{fmtEur(d[`ch_${ch.id}_commission`])}</td>
                    </tr>
                  )))}
              </tbody>
              {meta && (
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                    <td colSpan={3}>Total</td>
                    <td style={{ textAlign: 'right' }}>{fmtEur(meta.totalRevenue)}</td>
                    <td />
                    <td style={{ textAlign: 'right', color: '#f59e0b' }}>{fmtEur(meta.totalCommission)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      )}
    </>
  )
}

// ── CancelacionesReport ─────────────────────────────────────────────────────

function CancelacionesReport() {
  const navigate = useNavigate()
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, applyDates, quickMonth } = useMonthRange()
  const [data,         setData]         = useState<any[]>([])
  const [byCancelDate, setByCancelDate] = useState<any[]>([])
  const [byStayDate,   setByStayDate]   = useState<any[]>([])
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState<string | null>(null)

  const [detail,        setDetail]        = useState<{ date: string; by: 'cancel' | 'stay'; label: string } | null>(null)
  const [detailData,    setDetailData]    = useState<any[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError,   setDetailError]   = useState<string | null>(null)

  const [recoveries,     setRecoveries]     = useState<any[]>([])
  const [recoveriesMeta, setRecoveriesMeta] = useState<{ count: number; emailsSent: number; recovered: number; recoveredAmount: number } | null>(null)

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo) return
    setLoading(true); setError(null)
    try {
      const [r, rec] = await Promise.all([
        api.getCancellationsReport({ from: appliedFrom, to: appliedTo }),
        api.getCancellationRecoveries(appliedFrom, appliedTo),
      ])
      setData(r.data)
      setByCancelDate(r.byCancelDate ?? [])
      setByStayDate(r.byStayDate ?? [])
      setRecoveries(rec.data)
      setRecoveriesMeta(rec.meta)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [appliedFrom, appliedTo])

  useEffect(() => { load() }, [load])

  const openDetail = useCallback(async (date: string, by: 'cancel' | 'stay', label: string) => {
    if (!appliedFrom || !appliedTo) return
    setDetail({ date, by, label }); setDetailData([]); setDetailError(null); setDetailLoading(true)
    try {
      const r = await api.getCancellationsDetail({ from: appliedFrom, to: appliedTo, date, by })
      setDetailData(r.data)
    } catch (e: any) { setDetailError(e.message) }
    finally { setDetailLoading(false) }
  }, [appliedFrom, appliedTo])

  const totalAll        = data.reduce((s, d) => s + d.total, 0)
  const totalCancelled  = data.reduce((s, d) => s + d.cancelled, 0)
  const globalRate      = totalAll > 0 ? Math.round(totalCancelled / totalAll * 1000) / 10 : 0

  const cancelDateTickAngle = byCancelDate.length > 20 ? -40 : 0
  const stayDateTickAngle   = byStayDate.length > 20 ? -40 : 0

  return (
    <>
      <MonthQuickButtons onQuick={quickMonth} />
      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates}
      />
      <div className="card" style={{ marginBottom: 16, padding: '12px 18px', fontSize: 13, color: 'var(--text2)' }}>
        No cuentan los carritos del motor de reservas (web directa) que nunca llegaron a pagarse — se cancelan
        automáticamente al caducar, pero no son cancelaciones reales, son intentos de reserva abandonados antes de pagar.
      </div>

      {!loading && data.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
          <StatCard label="Total reservas" value={String(totalAll)} />
          <StatCard label="Canceladas" value={String(totalCancelled)} />
          <StatCard label="Ratio global" value={`${globalRate}%`} />
        </div>
      )}

      {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
      {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && data.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Sin datos</div>}

      {!loading && !error && data.length > 0 && (
        <>
          {byCancelDate.length > 0 && (
            <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Cancelaciones por fecha de cancelación</div>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: -8, marginBottom: 12 }}>
                Cuándo canceló la gente — para detectar picos puntuales (fallo de pago, incidencia, etc.)
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={byCancelDate} margin={{ top: 4, right: 20, left: 8, bottom: cancelDateTickAngle !== 0 ? 40 : 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text2)' }} angle={cancelDateTickAngle}
                    textAnchor={cancelDateTickAngle !== 0 ? 'end' : 'middle'} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text2)' }} width={40} allowDecimals={false} />
                  <RTooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }}
                    formatter={(v: any) => [v, 'Canceladas']} />
                  <Bar dataKey="cancelled" name="Canceladas" fill="#ef4444" radius={[3, 3, 0, 0]} cursor="pointer"
                    onClick={(d: any) => openDetail(d.date, 'cancel', d.label)} />
                </BarChart>
              </ResponsiveContainer>
              <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6 }}>Clic en una barra para ver el detalle</div>
            </div>
          )}

          {byStayDate.length > 0 && (
            <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Cancelaciones por fecha de estancia cancelada</div>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: -8, marginBottom: 12 }}>
                Fecha de check-in que se queda hueca — para ver qué fechas se ven más afectadas
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={byStayDate} margin={{ top: 4, right: 20, left: 8, bottom: stayDateTickAngle !== 0 ? 40 : 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text2)' }} angle={stayDateTickAngle}
                    textAnchor={stayDateTickAngle !== 0 ? 'end' : 'middle'} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text2)' }} width={40} allowDecimals={false} />
                  <RTooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }}
                    formatter={(v: any) => [v, 'Canceladas']} />
                  <Bar dataKey="cancelled" name="Canceladas" fill="#f59e0b" radius={[3, 3, 0, 0]} cursor="pointer"
                    onClick={(d: any) => openDetail(d.date, 'stay', d.label)} />
                </BarChart>
              </ResponsiveContainer>
              <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6 }}>Clic en una barra para ver el detalle</div>
            </div>
          )}

          <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Ratio de cancelación por canal</div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={data.slice(0, 12)}
                margin={{ top: 4, right: 20, left: 8, bottom: 60 }}
                layout="vertical"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tickFormatter={v => v + '%'} tick={{ fontSize: 11, fill: 'var(--text2)' }} />
                <YAxis type="category" dataKey="channel" width={120} tick={{ fontSize: 11, fill: 'var(--text2)' }} />
                <RTooltip
                  contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }}
                  formatter={(v: any) => [`${v}%`, 'Cancelación']}
                />
                <Bar dataKey="cancellation_rate" name="Cancelación" radius={[0, 3, 3, 0]}>
                  {data.slice(0, 12).map((entry, i) => (
                    <Cell key={i} fill={entry.cancellation_rate >= 30 ? '#ef4444' : entry.cancellation_rate >= 15 ? '#f59e0b' : '#22c55e'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Canal</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Canceladas</th>
                  <th style={{ textAlign: 'right' }}>Ratio</th>
                </tr>
              </thead>
              <tbody>
                {data.map(d => (
                  <tr key={d.channel}>
                    <td style={{ fontWeight: 500 }}>{d.channel}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{d.total}</td>
                    <td style={{ textAlign: 'right' }}>{d.cancelled}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{
                        display: 'inline-block', padding: '2px 10px', borderRadius: 12,
                        fontSize: 12, fontWeight: 600,
                        background: d.cancellation_rate >= 30 ? '#fee2e2' : d.cancellation_rate >= 15 ? '#fef3c7' : '#dcfce7',
                        color: d.cancellation_rate >= 30 ? '#991b1b' : d.cancellation_rate >= 15 ? '#92400e' : '#166534',
                      }}>
                        {d.cancellation_rate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                  <td>Total</td>
                  <td style={{ textAlign: 'right' }}>{totalAll}</td>
                  <td style={{ textAlign: 'right' }}>{totalCancelled}</td>
                  <td style={{ textAlign: 'right' }}>{globalRate}%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {!loading && !error && recoveriesMeta && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Reenganche de cancelaciones</div>
          <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 0, marginBottom: 14 }}>
            Reservas canceladas con email real a las que se les ofreció un descuento para volver a reservar.
            Configuración en Tarifas → Promociones Web.
          </p>
          {recoveriesMeta.count === 0 ? (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--text2)', fontSize: 13 }}>
              Sin ofertas de reenganche en este período — o el mecanismo está desactivado, o de momento no ha habido
              ninguna cancelación que cumpla los criterios configurados (email real, dentro de la ventana de horas)
            </div>
          ) : (
          <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
            <StatCard label="Ofertas enviadas"    value={String(recoveriesMeta.count)} />
            <StatCard label="Emails enviados"     value={String(recoveriesMeta.emailsSent)} />
            <StatCard label="Recuperadas"         value={`${recoveriesMeta.recovered} (${recoveriesMeta.count > 0 ? Math.round(recoveriesMeta.recovered / recoveriesMeta.count * 100) : 0}%)`} />
            <StatCard label="Importe recuperado"  value={fmtEur(recoveriesMeta.recoveredAmount)} />
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha oferta</th>
                  <th>Huésped</th>
                  <th>Email</th>
                  <th>Teléfono</th>
                  <th>Estancia</th>
                  <th style={{ textAlign: 'right' }}>Importe base</th>
                  <th style={{ textAlign: 'right' }}>Con descuento</th>
                  <th>Email</th>
                  <th>WhatsApp</th>
                  <th>Recuperado</th>
                </tr>
              </thead>
              <tbody>
                {recoveries.map(r => (
                  <tr key={r.id} style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/reservations/${r.newReservationId ?? r.reservationId}`)}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDateTime(r.createdAt)}</td>
                    <td>{r.guestName || '—'}</td>
                    <td style={{ fontSize: 12 }}>{r.email || '—'}</td>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{r.phone || '—'}</td>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{r.checkIn} → {r.checkOut}</td>
                    <td style={{ textAlign: 'right' }}>{fmtEur(parseFloat(r.baseAmount))}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtEur(parseFloat(r.discountedAmount))} <span style={{ color: 'var(--text2)', fontWeight: 400 }}>(-{r.discountPct}%)</span></td>
                    <td>
                      {r.emailSentAt ? (
                        <span style={{ color: 'var(--green)', fontSize: 12 }} title={`Enviado ${fmtDateTime(r.emailSentAt)}`}>✓ Enviado</span>
                      ) : r.emailError ? (
                        <span style={{ color: 'var(--red)', fontSize: 12 }} title={r.emailError}>✗ {r.emailError.slice(0, 40)}{r.emailError.length > 40 ? '…' : ''}</span>
                      ) : (
                        <span style={{ color: 'var(--text2)', fontSize: 12, cursor: r.emailSkipReason ? 'help' : undefined }} title={r.emailSkipReason ?? undefined}>
                          — no intentado
                        </span>
                      )}
                    </td>
                    <td>
                      {r.whatsappSentAt ? (
                        <span style={{ color: 'var(--green)', fontSize: 12 }} title={`Enviado ${fmtDateTime(r.whatsappSentAt)}`}>✓ Enviado</span>
                      ) : r.whatsappError ? (
                        <span style={{ color: 'var(--red)', fontSize: 12 }} title={r.whatsappError}>✗ {r.whatsappError.slice(0, 40)}{r.whatsappError.length > 40 ? '…' : ''}</span>
                      ) : (
                        <span style={{ color: 'var(--text2)', fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td>
                      {r.recoveredAt
                        ? <span style={{ color: 'var(--green)', fontWeight: 600 }}>✓ {fmtEur(parseFloat(r.recoveredAmount ?? '0'))}</span>
                        : <span style={{ color: 'var(--text2)' }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
          )}
        </div>
      )}

      {detail && (
        <Modal
          title={`Canceladas — ${detail.by === 'cancel' ? 'canceladas el' : 'estancia del'} ${detail.label}`}
          onClose={() => setDetail(null)}
          wide
        >
          {detailLoading && <div style={{ textAlign: 'center', padding: 30, color: 'var(--text2)' }}>Cargando…</div>}
          {detailError   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{detailError}</div>}
          {!detailLoading && !detailError && detailData.length === 0 && (
            <div style={{ textAlign: 'center', padding: 30, color: 'var(--text2)' }}>Sin datos</div>
          )}
          {!detailLoading && !detailError && detailData.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Huésped</th>
                  <th>Email</th>
                  <th>Teléfono</th>
                  <th>Estancia</th>
                  <th style={{ textAlign: 'right' }}>Importe original</th>
                  <th style={{ textAlign: 'right' }}>Importe hoy</th>
                </tr>
              </thead>
              <tbody>
                {detailData.map(r => {
                  const delta = r.currentAmount != null ? r.currentAmount - r.originalAmount : null
                  return (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/reservations/${r.id}`)}>
                      <td>
                        <a href="#" onClick={e => { e.preventDefault(); e.stopPropagation(); navigate(`/reservations/${r.id}`) }}>
                          #{r.id}
                        </a>
                      </td>
                      <td style={{ fontWeight: 500 }}>{r.name ?? '—'}</td>
                      <td>{r.email ?? <span style={{ color: 'var(--text2)' }}>Sin email</span>}</td>
                      <td>{r.phone ?? <span style={{ color: 'var(--text2)' }}>—</span>}</td>
                      <td style={{ color: 'var(--text2)', fontSize: 12 }}>{r.checkInDate} → {r.checkOutDate}</td>
                      <td style={{ textAlign: 'right' }}>{fmtEur(r.originalAmount)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {r.currentAmount != null ? (
                          <>
                            {fmtEur(r.currentAmount)}
                            {delta != null && Math.abs(delta) >= 0.01 && (
                              <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: delta > 0 ? '#ef4444' : '#22c55e' }}>
                                ({delta > 0 ? '+' : ''}{fmtEur(delta)})
                              </span>
                            )}
                          </>
                        ) : <span style={{ color: 'var(--text2)' }}>N/D</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </>
  )
}

// ── LeadTimeReport ──────────────────────────────────────────────────────────

function LeadTimeReport() {
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, applyDates, quickMonth } = useMonthRange()
  const [data,        setData]        = useState<any[]>([])
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo) return
    setLoading(true); setError(null)
    try {
      const r = await api.getLeadTimeReport({ from: appliedFrom, to: appliedTo })
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [appliedFrom, appliedTo])

  useEffect(() => { load() }, [load])

  const totalCount = data.reduce((s, d) => s + d.count, 0)
  const avgGlobal  = totalCount > 0 ? Math.round(data.reduce((s, d) => s + d.avg * d.count, 0) / totalCount * 10) / 10 : 0

  return (
    <>
      <MonthQuickButtons onQuick={quickMonth} />
      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates}
      />

      {!loading && data.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
          <StatCard label="Reservas analizadas" value={String(totalCount)} />
          <StatCard label="Lead time medio global" value={`${avgGlobal} días`} />
        </div>
      )}

      {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
      {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && data.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Sin datos</div>}

      {!loading && !error && data.length > 0 && (
        <>
          <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Lead time promedio por canal (días)</div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.slice(0, 12)} layout="vertical" margin={{ top: 4, right: 60, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--text2)' }} />
                <YAxis type="category" dataKey="channel" width={120} tick={{ fontSize: 11, fill: 'var(--text2)' }} />
                <RTooltip
                  contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }}
                  formatter={(v: any) => [`${v} días`, 'Promedio']}
                />
                <Bar dataKey="avg" name="Lead time" fill="#3b82f6" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Canal</th>
                  <th style={{ textAlign: 'right' }}>Reservas</th>
                  <th style={{ textAlign: 'right' }}>Mín. (días)</th>
                  <th style={{ textAlign: 'right' }}>Promedio (días)</th>
                  <th style={{ textAlign: 'right' }}>Máx. (días)</th>
                </tr>
              </thead>
              <tbody>
                {data.map(d => (
                  <tr key={d.channel}>
                    <td style={{ fontWeight: 500 }}>{d.channel}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{d.count}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{d.min}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: '#3b82f6' }}>{d.avg}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{d.max}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}

// ── RecepcionReport (errores de pagos + tiempo de check-in) ─────────────────

function RecepcionReport() {
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, applyDates, quickMonth } = useMonthRange()
  const [data,        setData]        = useState<any[]>([])
  const [byEmployee,  setByEmployee]  = useState<any[]>([])
  const [meta,        setMeta]        = useState<any>(null)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const [pcData,       setPcData]       = useState<any[]>([])
  const [pcByEmployee, setPcByEmployee] = useState<any[]>([])
  const [pcByDay,      setPcByDay]      = useState<any[]>([])
  const [pcMeta,       setPcMeta]       = useState<{ total: number } | null>(null)

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo) return
    setLoading(true); setError(null)
    try {
      const [r, pc] = await Promise.all([
        api.getCheckinTimeReport({ from: appliedFrom, to: appliedTo }),
        api.getPaymentCorrectionsReport({ from: appliedFrom, to: appliedTo }),
      ])
      setData(r.data); setByEmployee(r.byEmployee ?? []); setMeta(r.meta)
      setPcData(pc.data ?? []); setPcByEmployee(pc.byEmployee ?? []); setPcByDay(pc.byDay ?? []); setPcMeta(pc.meta ?? null)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [appliedFrom, appliedTo])

  useEffect(() => { load() }, [load])

  const tickAngle   = data.length > 20 ? -40 : 0
  const pcTickAngle = pcByDay.length > 20 ? -40 : 0

  return (
    <>
      <MonthQuickButtons onQuick={quickMonth} />
      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates}
      />

      {!loading && !error && (
        <div className="card" style={{ marginBottom: 16, padding: '16px 18px' }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Errores en el registro de pagos</div>
          <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 0, marginBottom: 14 }}>
            Pagos corregidos con "Cobrado en otra fecha" (pestaña Pagos de cada reserva) — quién los registró con la
            fecha o el usuario equivocados, y quién los corrigió.
          </p>

          {(!pcMeta || pcMeta.total === 0) ? (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text2)', fontSize: 13 }}>
              Sin correcciones en este período
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
                <StatCard label="Errores corregidos" value={String(pcMeta.total)} />
                <StatCard label="Empleados implicados" value={String(pcByEmployee.length)} />
              </div>

              {pcByDay.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={pcByDay} margin={{ top: 4, right: 20, left: 8, bottom: pcTickAngle !== 0 ? 40 : 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text2)' }} angle={pcTickAngle}
                        textAnchor={pcTickAngle !== 0 ? 'end' : 'middle'} />
                      <YAxis tick={{ fontSize: 11, fill: 'var(--text2)' }} width={40} allowDecimals={false} />
                      <RTooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }}
                        formatter={(v: any) => [v, 'Corregidos']} />
                      <Bar dataKey="count" name="Corregidos" fill="#ef4444" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              <div className="table-wrap" style={{ marginBottom: 16 }}>
                <table className="data-table">
                  <thead><tr>
                    <th>Empleado</th>
                    <th style={{ textAlign: 'right' }}>Errores</th>
                    <th>Corregidos por</th>
                  </tr></thead>
                  <tbody>
                    {pcByEmployee.map((e: any) => (
                      <tr key={e.employeeId ?? e.employeeName}>
                        <td style={{ fontWeight: 500 }}>{e.employeeName}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: e.errors >= 3 ? 'var(--red)' : 'var(--yellow)' }}>{e.errors}</td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                          {e.correctors.map((c: any) => `${c.name} (${c.count})`).join(' · ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <th>Corregido el</th><th>Empleado</th><th>Fecha registrada</th>
                    <th>Fecha/hora real</th><th>Cobró</th><th>Corregido por</th><th>Descripción</th>
                  </tr></thead>
                  <tbody>
                    {pcData.map((r: any) => (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDateTime(r.fixedAt)}</td>
                        <td>{r.employeeName}</td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{fmtDate(r.previousDate)}</td>
                        <td style={{ fontSize: 12 }}>{fmtDateTime(r.correctedAt)}</td>
                        <td style={{ fontSize: 12 }}>{r.paidByName ?? '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{r.fixedByName ?? '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.description ?? undefined}>
                          {r.description ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
      <div className="card" style={{ marginBottom: 16, padding: '12px 18px', fontSize: 13, color: 'var(--text2)' }}>
        Mide el tiempo desde que el recepcionista abre el formulario de edición del huésped durante el proceso de check-in
        hasta que la reserva pasa a estado <strong>checked_in</strong>.
        {' '}Se excluyen automáticamente los tiempos atípicos (&lt; 10 s o &gt; 40 min) para no distorsionar el promedio.
      </div>

      {meta && meta.totalCheckins > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
          <StatCard
            label="Sin contrato firmado"
            value={`${meta.skippedContract} / ${meta.totalCheckins}`}
            sub={meta.totalCheckins > 0 ? `${Math.round(meta.skippedContract / meta.totalCheckins * 100)} %` : undefined}
            color={meta.skippedContract > 0 ? 'var(--yellow)' : 'var(--green)'}
          />
          <StatCard
            label="Sin tarjeta ZKTeco"
            value={`${meta.skippedZkteco} / ${meta.totalCheckins}`}
            sub={meta.totalCheckins > 0 ? `${Math.round(meta.skippedZkteco / meta.totalCheckins * 100)} %` : undefined}
            color={meta.skippedZkteco > 0 ? 'var(--yellow)' : 'var(--green)'}
          />
          <StatCard
            label="Sin SES enviado"
            value={`${meta.skippedSes} / ${meta.totalCheckins}`}
            sub={meta.totalCheckins > 0 ? `${Math.round(meta.skippedSes / meta.totalCheckins * 100)} %` : undefined}
            color={meta.skippedSes > 0 ? 'var(--yellow)' : 'var(--green)'}
          />
        </div>
      )}

      {meta && meta.count > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          <StatCard label="Check-ins válidos"   value={`${meta.count}${meta.excluded > 0 ? ` (${meta.excluded} excl.)` : ''}`} />
          <StatCard label="Tiempo promedio"     value={fmtSecs(meta.avg_seconds)} />
          <StatCard label="Tiempo mínimo"       value={fmtSecs(meta.min_seconds)} />
          <StatCard label="Tiempo máximo"       value={fmtSecs(meta.max_seconds)} />
        </div>
      )}

      {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
      {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && (!meta || meta.count === 0) && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>
          Sin datos — el tiempo de check-in se registra automáticamente a partir de ahora.
        </div>
      )}

      {!loading && !error && data.length > 0 && (
        <>
          <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Tiempo promedio de check-in por día</div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data} margin={{ top: 4, right: 20, left: 8, bottom: tickAngle !== 0 ? 40 : 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text2)' }} angle={tickAngle}
                  textAnchor={tickAngle !== 0 ? 'end' : 'middle'} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text2)' }} width={50}
                  tickFormatter={v => fmtSecs(v)} />
                <RTooltip
                  contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }}
                  formatter={(v: any) => [fmtSecs(Number(v)), 'Promedio']}
                />
                <Bar dataKey="avg" name="Tiempo promedio" fill="#3b82f6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Día</th>
                  <th style={{ textAlign: 'right' }}>Check-ins</th>
                  <th style={{ textAlign: 'right' }}>Tiempo promedio</th>
                </tr>
              </thead>
              <tbody>
                {data.map(d => (
                  <tr key={d.day}>
                    <td style={{ fontWeight: 500 }}>{d.label}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{d.count}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: '#3b82f6' }}>{fmtSecs(d.avg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {byEmployee.length > 0 && (
            <>
              <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Tiempo medio por recepcionista</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={byEmployee.filter(e => e.avg != null)} layout="vertical" margin={{ top: 4, right: 60, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--text2)' }} tickFormatter={v => fmtSecs(v)} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: 'var(--text1)' }} width={110} />
                    <RTooltip
                      contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }}
                      formatter={(v: any, _: any, props: any) => [
                        `${fmtSecs(Number(v))} (${props.payload.count} check-ins · mín ${fmtSecs(props.payload.min)} · máx ${fmtSecs(props.payload.max)})`,
                        'Promedio',
                      ]}
                    />
                    <Bar dataKey="avg" name="Tiempo promedio" fill="#6366f1" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="card">
                <table>
                  <thead>
                    <tr>
                      <th>Recepcionista</th>
                      <th style={{ textAlign: 'right' }}>Check-ins</th>
                      <th style={{ textAlign: 'right' }}>Promedio</th>
                      <th style={{ textAlign: 'right' }}>Mínimo</th>
                      <th style={{ textAlign: 'right' }}>Máximo</th>
                      <th style={{ textAlign: 'right' }}>Sin contrato</th>
                      <th style={{ textAlign: 'right' }}>Sin ZKTeco</th>
                      <th style={{ textAlign: 'right' }}>Sin SES</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byEmployee.map(e => {
                      const skipColor = (n: number) => n === 0 ? 'var(--text2)' : n >= 3 ? 'var(--red)' : 'var(--yellow)'
                      const skipPct   = (n: number) => e.totalCheckins > 0 ? ` (${Math.round(n / e.totalCheckins * 100)}%)` : ''
                      return (
                        <tr key={e.name}>
                          <td style={{ fontWeight: 500 }}>{e.name}</td>
                          <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.totalCheckins}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: e.avg != null ? '#6366f1' : 'var(--text2)' }}>{e.avg != null ? fmtSecs(e.avg) : '—'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--green)' }}>{e.min != null ? fmtSecs(e.min) : '—'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.max != null ? fmtSecs(e.max) : '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: e.skippedContract > 0 ? 600 : 400, color: skipColor(e.skippedContract) }}>{e.skippedContract}{skipPct(e.skippedContract)}</td>
                          <td style={{ textAlign: 'right', fontWeight: e.skippedZkteco > 0 ? 600 : 400, color: skipColor(e.skippedZkteco) }}>{e.skippedZkteco}{skipPct(e.skippedZkteco)}</td>
                          <td style={{ textAlign: 'right', fontWeight: e.skippedSes > 0 ? 600 : 400, color: skipColor(e.skippedSes) }}>{e.skippedSes}{skipPct(e.skippedSes)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

// ── Desayunos ──────────────────────────────────────────────────────────────────

function DesayunosReport() {
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, applyDates, quickMonth } = useMonthRange()
  const [data,        setData]        = useState<any[]>([])
  const [totals,      setTotals]      = useState<any>(null)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo) return
    setLoading(true); setError(null)
    try {
      const r = await api.getBreakfastReport(appliedFrom, appliedTo)
      setData(r.data); setTotals(r.totals)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [appliedFrom, appliedTo])

  useEffect(() => { load() }, [load])

  const tickAngle = data.length > 20 ? -40 : 0

  return (
    <>
      <MonthQuickButtons onQuick={quickMonth} />
      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates} maxDays={366}
      />

      {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
      {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}

      {!loading && !error && totals && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            <StatCard label="Desayunos servidos"     value={String(totals.total_served)} />
            <StatCard label="Media diaria"            value={fmt1(totals.avg_served_per_day)} />
            <StatCard label="Incluidos en tarifa"     value={String(totals.total_rate_due)} sub="del período (tarifas HD/HyD)" />
            <StatCard label="Días sin servicio"       value={String(totals.days_no_service)} color={totals.days_no_service > 0 ? 'var(--yellow)' : undefined} />
          </div>

          {data.length > 0 && (
            <>
              <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Desayunos servidos por día</div>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data} margin={{ top: 4, right: 20, left: 8, bottom: tickAngle !== 0 ? 40 : 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text2)' }} angle={tickAngle}
                      textAnchor={tickAngle !== 0 ? 'end' : 'middle'} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text2)' }} width={40} allowDecimals={false} />
                    <RTooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="served"       name="Servidos"          stackId="d" fill="#22c55e" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="pending_rate" name="Pendientes (tarifa)" stackId="d" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="card" style={{ marginBottom: 16 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Día</th>
                      <th style={{ textAlign: 'right' }}>Incluidos tarifa</th>
                      <th style={{ textAlign: 'right' }}>Servidos</th>
                      <th style={{ textAlign: 'right' }}>Pendientes tarifa</th>
                      <th style={{ textAlign: 'right' }}>Extras activos</th>
                      <th style={{ textAlign: 'center' }}>Sin servicio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map(d => (
                      <tr key={d.date}>
                        <td style={{ fontWeight: 500 }}>{d.label}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{d.from_rate}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: '#22c55e' }}>{d.served}</td>
                        <td style={{ textAlign: 'right', color: d.pending_rate > 0 ? 'var(--yellow)' : 'var(--text2)' }}>{d.pending_rate}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{d.from_extras}</td>
                        <td style={{ textAlign: 'center' }}>{d.no_service_marked ? '⚠' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

// ── Lavandería ─────────────────────────────────────────────────────────────────

function LavanderiaReport() {
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, applyDates, quickMonth } = useMonthRange()
  const [deliveredByDay,      setDeliveredByDay]      = useState<any[]>([])
  const [deliveredByEmployee, setDeliveredByEmployee] = useState<any[]>([])
  const [processedByEmployee, setProcessedByEmployee] = useState<any[]>([])
  const [byStatus, setByStatus] = useState<Record<string, number>>({})
  const [meta,     setMeta]     = useState<any>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo) return
    setLoading(true); setError(null)
    try {
      const r = await api.getLaundryReport(appliedFrom, appliedTo)
      setDeliveredByDay(r.deliveredByDay); setDeliveredByEmployee(r.deliveredByEmployee)
      setProcessedByEmployee(r.processedByEmployee); setByStatus(r.byStatus); setMeta(r.meta)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [appliedFrom, appliedTo])

  useEffect(() => { load() }, [load])

  const tickAngle = deliveredByDay.length > 20 ? -40 : 0
  const statusColor = (n: number) => n === 0 ? 'var(--text2)' : 'var(--red)'

  return (
    <>
      <MonthQuickButtons onQuick={quickMonth} />
      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates} maxDays={366}
      />

      {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
      {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}

      {!loading && !error && meta && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            <StatCard label="Piezas entregadas"  value={String(meta.totalDelivered)} sub={`${meta.deliveriesCount} entregas`} />
            <StatCard label="Piezas procesadas"  value={String(meta.totalProcessed)} sub={`${meta.batchesCount} lotes`} />
            <StatCard label="Discrepancias"      value={String(meta.discrepancies)} color={meta.discrepancies > 0 ? 'var(--red)' : undefined} />
            <StatCard label="Rotas / sucias"     value={`${byStatus.rotas ?? 0} / ${byStatus.sucias ?? 0}`} color={(byStatus.rotas ?? 0) + (byStatus.sucias ?? 0) > 0 ? 'var(--yellow)' : undefined} />
          </div>

          {deliveredByDay.length > 0 && (
            <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Piezas entregadas por día</div>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={deliveredByDay} margin={{ top: 4, right: 20, left: 8, bottom: tickAngle !== 0 ? 40 : 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text2)' }} angle={tickAngle}
                    textAnchor={tickAngle !== 0 ? 'end' : 'middle'} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text2)' }} width={40} allowDecimals={false} />
                  <RTooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }} />
                  <Bar dataKey="total" name="Piezas entregadas" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {deliveredByEmployee.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 14, padding: '14px 18px 0' }}>Entregas por trabajador</div>
              <table>
                <thead>
                  <tr>
                    <th>Trabajador</th>
                    <th style={{ textAlign: 'right' }}>Entregas</th>
                    <th style={{ textAlign: 'right' }}>Toallas ducha</th>
                    <th style={{ textAlign: 'right' }}>Toallas manos</th>
                    <th style={{ textAlign: 'right' }}>Sábanas</th>
                    <th style={{ textAlign: 'right' }}>Alfombrillas</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th style={{ textAlign: 'right' }}>Discrepancias</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveredByEmployee.map(e => (
                    <tr key={e.name}>
                      <td style={{ fontWeight: 500 }}>{e.name}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.deliveries}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.showerTowels}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.handTowels}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.sheetSets}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.footTowels}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: '#3b82f6' }}>{e.total}</td>
                      <td style={{ textAlign: 'right', fontWeight: e.discrepancies > 0 ? 600 : 400, color: statusColor(e.discrepancies) }}>{e.discrepancies}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {processedByEmployee.length > 0 && (
            <div className="card">
              <div style={{ fontWeight: 600, fontSize: 14, padding: '14px 18px 0' }}>Procesado por trabajador</div>
              <table>
                <thead>
                  <tr>
                    <th>Trabajador</th>
                    <th style={{ textAlign: 'right' }}>Lotes</th>
                    <th style={{ textAlign: 'right' }}>Total piezas</th>
                    <th style={{ textAlign: 'right' }}>Listas</th>
                    <th style={{ textAlign: 'right' }}>Tendidas</th>
                    <th style={{ textAlign: 'right' }}>En agua</th>
                    <th style={{ textAlign: 'right' }}>Sucias</th>
                    <th style={{ textAlign: 'right' }}>Rotas</th>
                  </tr>
                </thead>
                <tbody>
                  {processedByEmployee.map(e => (
                    <tr key={e.name}>
                      <td style={{ fontWeight: 500 }}>{e.name}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.batches}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: '#3b82f6' }}>{e.total}</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)' }}>{e.listas}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.tendidas}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.en_agua}</td>
                      <td style={{ textAlign: 'right', fontWeight: e.sucias > 0 ? 600 : 400, color: statusColor(e.sucias) }}>{e.sucias}</td>
                      <td style={{ textAlign: 'right', fontWeight: e.rotas > 0 ? 600 : 400, color: statusColor(e.rotas) }}>{e.rotas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ── Housekeeping reporte ──────────────────────────────────────────────

function HousekeepingStaffReport() {
  const { from, to, appliedFrom, appliedTo, setFrom, setTo, applyDates, quickMonth } = useMonthRange()
  const [data,        setData]        = useState<any[]>([])
  const [byEmployee,  setByEmployee]  = useState<any[]>([])
  const [meta,        setMeta]        = useState<any>(null)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!appliedFrom || !appliedTo) return
    setLoading(true); setError(null)
    try {
      const r = await api.getHousekeepingStaffReport(appliedFrom, appliedTo)
      setData(r.data); setByEmployee(r.byEmployee); setMeta(r.meta)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [appliedFrom, appliedTo])

  useEffect(() => { load() }, [load])

  const tickAngle = data.length > 20 ? -40 : 0

  return (
    <>
      <MonthQuickButtons onQuick={quickMonth} />
      <DateRangeFilter
        from={from} to={to} appliedFrom={appliedFrom} appliedTo={appliedTo}
        onFromChange={setFrom} onToChange={setTo} onApply={applyDates} maxDays={366}
      />
      <div className="card" style={{ marginBottom: 16, padding: '12px 18px', fontSize: 13, color: 'var(--text2)' }}>
        "Tiempo de respuesta" es el tiempo desde que se ASIGNA la tarea de limpieza hasta que se marca hecha (no desde que se
        genera). Si se asigna y se completa en menos de 1 minuto (p.ej. autoasignación al marcarla hecha sin haber estado
        asignada antes) no cuenta para el promedio — no refleja trabajo real, distorsionaría el tiempo medio a la baja.
      </div>

      {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)' }}>Cargando…</div>}
      {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>{error}</div>}

      {!loading && !error && meta && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            <StatCard label="Tareas generadas" value={String(meta.total)} />
            <StatCard label="Completadas"      value={String(meta.completed)} sub={`${meta.completionRate}%`} color="var(--green)" />
            <StatCard label="Pendientes"       value={String(meta.pending)} color={meta.pending > 0 ? 'var(--yellow)' : undefined} />
            <StatCard label="No molestar"      value={String(meta.dnd)} />
          </div>

          {data.length > 0 && (
            <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Tareas generadas vs. completadas por día</div>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data} margin={{ top: 4, right: 20, left: 8, bottom: tickAngle !== 0 ? 40 : 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text2)' }} angle={tickAngle}
                    textAnchor={tickAngle !== 0 ? 'end' : 'middle'} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text2)' }} width={40} allowDecimals={false} />
                  <RTooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="generated" name="Generadas"   fill="#94a3b8" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="completed" name="Completadas" stackId="handled" fill="#22c55e" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="dnd"       name="No molestar" stackId="handled" fill="#ef4444" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {byEmployee.length > 0 && (
            <>
              <div className="card" style={{ marginBottom: 16, padding: '16px 18px 8px' }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Tiempo medio de respuesta por trabajador</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={byEmployee.filter(e => e.avgSeconds != null)} layout="vertical" margin={{ top: 4, right: 60, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--text2)' }} tickFormatter={v => fmtSecs(v)} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: 'var(--text1)' }} width={110} />
                    <RTooltip
                      contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 12 }}
                      formatter={(v: any, _: any, props: any) => [`${fmtSecs(Number(v))} (${props.payload.completed} completadas)`, 'Promedio']}
                    />
                    <Bar dataKey="avgSeconds" name="Tiempo medio" fill="#6366f1" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="card">
                <table>
                  <thead>
                    <tr>
                      <th>Trabajador</th>
                      <th style={{ textAlign: 'right' }}>Asignadas</th>
                      <th style={{ textAlign: 'right' }}>Completadas</th>
                      <th style={{ textAlign: 'right' }}>% completado</th>
                      <th style={{ textAlign: 'right' }}>Tiempo medio</th>
                      <th style={{ textAlign: 'right' }}>Pendientes</th>
                      <th style={{ textAlign: 'right' }}>No molestar</th>
                      <th style={{ textAlign: 'right' }}>Salidas</th>
                      <th style={{ textAlign: 'right' }}>Estancias</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byEmployee.map(e => (
                      <tr key={e.name}>
                        <td style={{ fontWeight: 500 }}>{e.name}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.assigned}</td>
                        <td style={{ textAlign: 'right', color: 'var(--green)' }}>{e.completed}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: e.completionRate >= 90 ? 'var(--green)' : e.completionRate >= 60 ? 'var(--yellow)' : 'var(--red)' }}>{e.completionRate}%</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: e.avgSeconds != null ? '#6366f1' : 'var(--text2)' }}>{e.avgSeconds != null ? fmtSecs(e.avgSeconds) : '—'}</td>
                        <td style={{ textAlign: 'right', color: e.pending > 0 ? 'var(--yellow)' : 'var(--text2)' }}>{e.pending}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.dnd}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.departure}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{e.stay}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

// ── Tabs ────────────────────────────────────────────────────────────────────

// ─── Efecto de las reglas dinámicas ───────────────────────────────────────────
// Reservas de la noche afectada en las 72 h antes vs. después de cada cambio de
// precio, por regla (ver src/lib/pricingEffects.ts). Indicativo, no causal.
const VERDICT: Record<string, { label: string; color: string; icon: string }> = {
  funciona:    { label: 'Funciona',        color: 'var(--green)',  icon: '✅' },
  sin_efecto:  { label: 'Sin efecto',      color: 'var(--yellow)', icon: '⚠️' },
  perjudica:   { label: 'Perjudica',       color: 'var(--red)',    icon: '⛔' },
  pocos_datos: { label: 'Pocos datos',     color: 'var(--text2)',  icon: '…' },
}

function EfectoReglasReport() {
  const [days,    setDays]    = useState(30)
  const [data,    setData]    = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setData((await api.pricingEffects(days)).data) }
    catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [days])
  useEffect(() => { load() }, [load])

  const chart = data.map(r => ({ name: `${r.rule}${r.source === 'manual' ? '' : ''}`, Antes: r.bookingsBefore, Después: r.bookingsAfter, verdict: r.verdict }))
  const bad = data.filter(r => r.verdict === 'perjudica' || r.verdict === 'sin_efecto')

  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label>Cambios de los últimos{' '}
          <select value={days} onChange={e => setDays(Number(e.target.value))}>
            {[14, 30, 60, 90, 120].map(d => <option key={d} value={d}>{d} días</option>)}
          </select>
        </label>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? 'Cargando…' : 'Actualizar'}</button>
      </div>
      <p style={{ color: 'var(--text2)', fontSize: 12, margin: '0 0 12px' }}>
        Para cada cambio de precio se cuentan las reservas de esa noche hechas en las 72 h antes y en las 72 h después.
        Una rebaja que funciona trae más reservas después; una subida que funciona no las hunde. Es indicativo, no causal
        (hay estacionalidad y otros factores) y solo cuentan cambios de hace más de 72 h.
      </p>
      {error && <div style={{ color: 'var(--red)' }}>{error}</div>}

      {data.length > 0 && (
        <>
          <div style={{ height: 260, marginBottom: 16 }}>
            <ResponsiveContainer>
              <BarChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" interval={0} tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} />
                <RTooltip /><Legend />
                <Bar dataKey="Antes" fill="#94a3b8" />
                <Bar dataKey="Después" fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="table-wrap" style={{ marginBottom: 16 }}>
            <table>
              <thead><tr><th>Regla</th><th>Cambios</th><th>Variación media</th><th>Reservas antes</th><th>Reservas después</th><th>Efecto</th><th>Veredicto</th></tr></thead>
              <tbody>
                {data.map((r, i) => {
                  const v = VERDICT[r.verdict]!
                  return (
                    <tr key={i}>
                      <td>{r.rule}{r.threshold != null ? <span style={{ color: 'var(--text2)', fontSize: 11 }}> · umbral {r.threshold}% · {r.adjustType === 'fixed' ? `${r.adjustValue}€` : `${r.adjustValue}%`}</span> : null}</td>
                      <td>{r.changes}</td>
                      <td>{r.avgChangePct > 0 ? '+' : ''}{r.avgChangePct}%</td>
                      <td>{r.bookingsBefore}</td><td>{r.bookingsAfter}</td>
                      <td>{r.liftPct == null ? '—' : `${r.liftPct > 0 ? '+' : ''}${r.liftPct}%`}</td>
                      <td><strong style={{ color: v.color }}>{v.icon} {v.label}</strong></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <h3 style={{ margin: '0 0 8px' }}>Qué ajustar</h3>
          <ul style={{ fontSize: 13, lineHeight: 1.6, paddingLeft: 18 }}>
            {data.map((r, i) => <li key={i}><strong>{r.rule}:</strong> {r.advice}</li>)}
          </ul>
          {bad.length === 0 && <p style={{ color: 'var(--green)', fontSize: 13 }}>Ninguna regla con datos suficientes muestra problemas.</p>}
        </>
      )}
      {!loading && !error && data.length === 0 && (
        <div style={{ color: 'var(--text2)' }}>Sin cambios de precio suficientemente antiguos en este periodo.</div>
      )}
    </>
  )
}

type TabId = 'ocupacion' | 'ventas-canal' | 'comisiones' | 'cancelaciones' | 'lead-time' | 'recepcion'
  | 'desayunos' | 'lavanderia' | 'hk-trabajadores' | 'carritos' | 'efecto-reglas' | 'empresas' | 'feedback' | 'uso-qr'

const TABS: { id: TabId; label: string }[] = [
  { id: 'ocupacion',        label: 'Ocupación' },
  { id: 'ventas-canal',     label: 'Ventas por canal' },
  { id: 'comisiones',       label: 'Comisiones' },
  { id: 'cancelaciones',    label: 'Cancelaciones' },
  { id: 'lead-time',        label: 'Lead time' },
  { id: 'recepcion',        label: 'Recepción' },
  { id: 'desayunos',        label: 'Desayunos' },
  { id: 'lavanderia',       label: 'Lavandería' },
  { id: 'hk-trabajadores',  label: 'Housekeeping' },
  { id: 'carritos',         label: 'Carritos abandonados' },
  { id: 'efecto-reglas',    label: 'Efecto reglas' },
  { id: 'empresas',        label: 'Empresas' },
  { id: 'feedback',        label: 'Feedback' },
  { id: 'uso-qr',          label: 'Uso QR habitaciones' },
]

export default function ReportsView() {
  const [activeTab, setActiveTab] = useState<TabId>('ocupacion')
  const { user } = useAuth()
  const tabs = TABS.filter(t => {
    if (t.id === 'efecto-reglas' || t.id === 'empresas') return canManage(user)  // datos de revenue: solo dirección
    if (t.id === 'feedback') return canManage(user) || hasRole(user, 'recepcion')  // igual que antes de ser pestaña
    return true
  })

  return (
    <>
      <h1 style={{ marginBottom: 16 }}>Informes</h1>

      {/* Desktop: fila de pestañas. Móvil (< 640px): desplegable — ver public/styles.css */}
      <div className="reports-tabs-bar" style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid var(--border)', flexWrap: 'wrap' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '8px 18px', fontSize: 13, border: 'none', cursor: 'pointer',
              background: 'transparent', fontWeight: activeTab === tab.id ? 700 : 400,
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text2)',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -2, transition: 'color .15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <select
        className="reports-tabs-select"
        value={activeTab}
        onChange={e => setActiveTab(e.target.value as TabId)}
        style={{
          width: '100%', marginBottom: 20, padding: '8px 10px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 14,
        }}
      >
        {tabs.map(tab => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
      </select>

      {activeTab === 'ocupacion'      && <OcupacionReport />}
      {activeTab === 'ventas-canal'   && <VentasCanalReport />}
      {activeTab === 'comisiones'     && <ComisionesReport />}
      {activeTab === 'cancelaciones'  && <CancelacionesReport />}
      {activeTab === 'lead-time'      && <LeadTimeReport />}
      {activeTab === 'recepcion'       && <RecepcionReport />}
      {activeTab === 'desayunos'       && <DesayunosReport />}
      {activeTab === 'lavanderia'      && <LavanderiaReport />}
      {activeTab === 'hk-trabajadores' && <HousekeepingStaffReport />}
      {activeTab === 'carritos'        && <CarritosAbandonadosReport />}
      {activeTab === 'efecto-reglas'   && <EfectoReglasReport />}
      {activeTab === 'empresas'        && <CorporateReport />}
      {activeTab === 'feedback'        && <FeedbackReport />}
      {activeTab === 'uso-qr'          && <RoomAccessVisitsReport />}
    </>
  )
}
