import { useState, useEffect, useCallback } from 'react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Legend } from 'recharts'
import { api } from '../lib/api'
import { toast } from '../lib/utils'
import { useAuth, canManage } from '../contexts/AuthContext'

const madridISO = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d)
const daysAgoISO = (n: number) => madridISO(new Date(Date.now() - n * 86400000))

const KIND_COLORS: Record<string, string> = {
  reservas: '#2563eb', estados: '#7c3aed', cobros: '#16a34a', notas: '#f59e0b',
  limpieza: '#0891b2', precios: '#dc2626', alertas: '#db2777', turnos: '#64748b',
}
const ratingColor = (r: number) => r >= 70 ? 'var(--green)' : r >= 40 ? 'var(--yellow)' : 'var(--red)'

export default function EngagementView() {
  const { user } = useAuth()
  return canManage(user) ? <EngagementAdmin /> : <MyEngagement />
}

// Vista personal: cada usuario ve SOLO su rating (media ponderada de 3 meses + compensaciones de dirección).
function MyEngagement() {
  const [me, setMe] = useState<any | null | undefined>(undefined)
  const [kinds, setKinds] = useState<Record<string, string>>({})
  useEffect(() => { api.engagementMe().then(r => { setMe(r.data); setKinds(r.meta?.kinds ?? {}) }).catch(e => { toast(e.message, 'err'); setMe(null) }) }, [])
  if (me === undefined) return <div style={{ color: 'var(--text2)' }}>Cargando…</div>
  if (!me) return <div style={{ color: 'var(--text2)' }}>No hay rating de implicación para tu usuario.</div>
  const kindRows = Object.entries(me.byKind ?? {}).sort((a: any, b: any) => b[1] - a[1])
  return (
    <>
      <h2 style={{ margin: '0 0 4px' }}>Tu implicación</h2>
      <div style={{ fontSize: 56, fontWeight: 800, color: ratingColor(me.rating), lineHeight: 1.1 }}>{me.rating}<span style={{ fontSize: 20, color: 'var(--text2)' }}> / 100</span></div>
      <p style={{ color: 'var(--text2)', fontSize: 13, margin: '4px 0 16px' }}>
        Media ponderada de tus últimos 3 meses (50 % el último mes, 30 % el anterior, 20 % el más antiguo) más los puntos que
        Dirección haya podido darte: base <strong>{me.base}</strong>{me.bonus ? <> · compensación <strong>{me.bonus > 0 ? '+' : ''}{me.bonus}</strong></> : null}.
      </p>
      {(me.noContract > 0 || me.noSes > 0) && (
        <div style={{ border: '1px solid var(--red)', borderRadius: 8, padding: '8px 12px', marginBottom: 16, fontSize: 13 }}>
          ⛔ Este último mes has hecho check-in {me.noContract > 0 && <><strong>{me.noContract}</strong> sin contrato firmado</>}
          {me.noContract > 0 && me.noSes > 0 && ' y '}{me.noSes > 0 && <><strong>{me.noSes}</strong> sin parte SES enviado</>}.
          Cada fallo resta puntos automáticamente ({me.penalty} este mes).
        </div>
      )}
      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table>
          <thead><tr><th>Periodo</th><th>Rating</th></tr></thead>
          <tbody>{me.periods.map((p: any, i: number) => <tr key={i}><td>{p.from} → {p.to}</td><td>{p.rating ?? '—'}</td></tr>)}</tbody>
        </table>
      </div>
      <h3 style={{ margin: '0 0 8px' }}>Tu actividad de los últimos 30 días ({me.total30} acciones · {me.activeDays30} días activos)</h3>
      <div style={{ height: 220, marginBottom: 16 }}>
        <ResponsiveContainer>
          <LineChart data={me.series}>
            <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} /><YAxis allowDecimals={false} /><Tooltip />
            <Line type="monotone" dataKey="n" name="Acciones" stroke="#2563eb" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {kindRows.length > 0 && (
        <ul style={{ fontSize: 13, paddingLeft: 18 }}>{kindRows.map(([k, n]: any) => <li key={k}>{kinds[k] ?? k}: {n}</li>)}</ul>
      )}
      {me.adjustments?.length > 0 && (
        <>
          <h3 style={{ margin: '16px 0 8px' }}>Compensaciones de Dirección</h3>
          <ul style={{ fontSize: 13, paddingLeft: 18 }}>{me.adjustments.map((a: any, i: number) => <li key={i}>{a.points > 0 ? '+' : ''}{a.points} — {a.reason ?? 'sin motivo'} <span style={{ color: 'var(--text2)' }}>({new Date(a.created_at).toLocaleDateString('es-ES')})</span></li>)}</ul>
        </>
      )}
      <h3 style={{ margin: '16px 0 8px' }}>Resúmenes de turno</h3>
      <ShiftEndReportsList />
    </>
  )
}

// ─── Resúmenes de fin de turno (check-ins/check-outs, alertas, extras...) ───
// Compartido entre la vista propia y la de Dirección — ver
// src/lib/shiftEndReport.ts para el cálculo y src/routes/alerts.ts para
// cuándo se genera (15 min antes de que acabe el turno de recepción).
function fmtHora(iso: string) {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
}

function ShiftEndReportsList({ userId }: { userId?: number }) {
  const [reports, setReports] = useState<any[] | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())

  useEffect(() => {
    setReports(null)
    api.engagementShiftReports(userId).then(r => setReports(r.data ?? [])).catch(() => setReports([]))
  }, [userId])

  if (reports === null) return <div style={{ color: 'var(--text2)', fontSize: 13 }}>Cargando resúmenes de turno…</div>
  if (reports.length === 0) return <div style={{ color: 'var(--text2)', fontSize: 13 }}>Sin resúmenes de turno todavía.</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {reports.map(r => {
        const b = r.breakdown
        const isOpen = open.has(r.id)
        return (
          <div key={r.id} className="card" style={{ padding: '10px 14px' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
              onClick={() => setOpen(prev => { const next = new Set(prev); next.has(r.id) ? next.delete(r.id) : next.add(r.id); return next })}
            >
              <span>{isOpen ? '▾' : '▸'}</span>
              <strong>{r.shift_date}</strong>
              <span style={{ color: 'var(--text2)', fontSize: 12 }}>
                {fmtHora(r.shift_start)} → {fmtHora(r.shift_end)}
              </span>
              <strong style={{ marginLeft: 'auto', color: r.total_points >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {r.total_points >= 0 ? '+' : ''}{r.total_points} pts
              </strong>
            </div>

            {isOpen && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 10, color: 'var(--text2)' }}>
                  <span>Check-ins: <strong style={{ color: 'var(--text)' }}>{b.checkins.length}</strong> ({b.points.checkins >= 0 ? '+' : ''}{b.points.checkins})</span>
                  <span>Check-outs: <strong style={{ color: 'var(--text)' }}>{b.checkouts.length}</strong> (dep. {b.points.deposits >= 0 ? '+' : ''}{b.points.deposits}, horario {b.points.checkoutTiming >= 0 ? '+' : ''}{b.points.checkoutTiming})</span>
                  <span>Velocidad check-in: <strong style={{ color: 'var(--text)' }}>{b.avgCheckinSeconds != null ? `${Math.round(b.avgCheckinSeconds)}s` : '—'}</strong> ({b.points.checkinSpeed >= 0 ? '+' : ''}{b.points.checkinSpeed})</span>
                  <span>Carritos llamados: <strong style={{ color: 'var(--text)' }}>{b.abandonedCartCalls}</strong> (+{b.points.abandonedCarts})</span>
                  <span>Extras vendidos: <strong style={{ color: 'var(--text)' }}>{b.extrasCount}</strong> ({b.points.extras >= 0 ? '+' : ''}{b.points.extras})</span>
                  <span>Alertas del turno: <strong style={{ color: 'var(--text)' }}>{b.alertsCount}</strong> ({b.points.alerts >= 0 ? '+' : ''}{b.points.alerts})</span>
                  <span>Alertas de antes resueltas: <strong style={{ color: 'var(--text)' }}>{b.alertsResolvedCount}</strong> (+{b.points.alertsResolved})</span>
                </div>

                {b.checkins.length > 0 && (
                  <div className="table-wrap" style={{ marginBottom: 10 }}>
                    <table>
                      <thead><tr><th>Hab.</th><th>Hora</th><th>SES</th><th>ZKTeco</th><th>Cobro</th></tr></thead>
                      <tbody>
                        {b.checkins.map((ci: any, i: number) => (
                          <tr key={i}>
                            <td>{ci.roomCode}</td><td>{fmtHora(ci.at)}</td>
                            <td style={{ color: ci.sesOk ? 'var(--green)' : 'var(--red)' }}>{ci.sesOk ? '✓' : '✗'}</td>
                            <td style={{ color: ci.zktecoOk ? 'var(--green)' : 'var(--red)' }}>{ci.zktecoOk ? '✓' : '✗'}</td>
                            <td style={{ color: ci.paymentOk ? 'var(--green)' : 'var(--red)' }}>{ci.paymentOk ? '✓' : '✗'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {b.checkouts.length > 0 && (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Hab.</th><th>Hora</th><th>Depósito</th></tr></thead>
                      <tbody>
                        {b.checkouts.map((co: any, i: number) => (
                          <tr key={i}>
                            <td>{co.roomCode}</td><td>{fmtHora(co.at)}</td>
                            <td>{!co.hadDeposit ? '—' : co.depositCharged ? <span style={{ color: 'var(--green)' }}>Cobrado</span> : 'Devuelto'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function EngagementAdmin() {
  const [from, setFrom]     = useState(daysAgoISO(30))
  const [to, setTo]         = useState(madridISO(new Date()))
  const [rows, setRows]     = useState<any[]>([])
  const [kinds, setKinds]   = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [sel, setSel]       = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.engagement({ from, to })
      setRows(r.data); setKinds(r.meta?.kinds ?? {})
      setSel(s => s ?? r.data[0]?.userId ?? null)
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLoading(false) }
  }, [from, to])
  useEffect(() => { load() }, [load])

  const selected = rows.find(r => r.userId === sel)
  const kindKeys = Object.keys(kinds)
  const compare = rows.map(r => ({ name: r.name.split(' ')[0], ...Object.fromEntries(kindKeys.map(k => [k, r.byKind[k] ?? 0])) }))

  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label>Desde <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>Hasta <input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? 'Cargando…' : 'Actualizar'}</button>
      </div>
      <p style={{ color: 'var(--text2)', fontSize: 12, margin: '0 0 12px' }}>
        Rating de implicación (0-100) = volumen de acciones por día activo (50) + constancia de días activos (50), comparado con
        compañeros del mismo rol. Solo mide lo que queda registrado en la plataforma: es orientativo, no una auditoría.
      </p>

      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table>
          <thead><tr><th>Empleado</th><th>Rol</th><th>Rating 3m (oficial)</th><th>Rating periodo</th><th>Fallos check-in</th><th>Acciones</th><th>Días activos</th><th>Acc./día</th><th>Último acceso</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.userId} onClick={() => setSel(r.userId)} style={{ cursor: 'pointer', background: r.userId === sel ? 'var(--bg2)' : undefined }}>
                <td>{r.name}</td><td>{r.role}</td>
                <td><strong style={{ color: ratingColor(r.official?.rating ?? 0) }}>{r.official?.rating ?? '—'}</strong>
                  {r.official && <span style={{ color: 'var(--text2)', fontSize: 11 }}> (base {r.official.base}{r.official.bonus ? ` · comp. ${r.official.bonus > 0 ? '+' : ''}${r.official.bonus}` : ''})</span>}</td>
                <td><strong style={{ color: ratingColor(r.rating) }}>{r.rating}</strong>
                  <span style={{ color: 'var(--text2)', fontSize: 11 }}> (vol. {r.volumeScore} · const. {r.consistencyScore})</span></td>
                <td>{r.noContract + r.noSes > 0 ? <span style={{ color: 'var(--red)' }}>{r.noContract} sin contrato · {r.noSes} sin SES (−{r.penalty})</span> : '—'}</td>
                <td>{r.total}</td><td>{r.activeDays}</td><td>{r.perActiveDay}</td>
                <td>{r.lastLoginAt ? new Date(r.lastLoginAt).toLocaleString('es-ES') : '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text2)' }}>Sin datos</td></tr>}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: '0 0 8px' }}>Comparativa por tipo de acción</h3>
      <div style={{ height: 260, marginBottom: 20 }}>
        <ResponsiveContainer>
          <BarChart data={compare}>
            <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip /><Legend />
            {kindKeys.map(k => <Bar key={k} dataKey={k} name={kinds[k]} stackId="a" fill={KIND_COLORS[k]} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {selected && (
        <>
          <h3 style={{ margin: '0 0 8px' }}>{selected.name} — actividad diaria</h3>
          <div style={{ height: 220, marginBottom: 20 }}>
            <ResponsiveContainer>
              <LineChart data={selected.series}>
                <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} /><YAxis allowDecimals={false} /><Tooltip />
                <Line type="monotone" dataKey="n" name="Acciones" stroke="#2563eb" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <h3 style={{ margin: '0 0 8px' }}>Horas del día en que trabaja en la plataforma</h3>
          <div style={{ height: 200, marginBottom: 20 }}>
            <ResponsiveContainer>
              <BarChart data={selected.byHour.map((n: number, h: number) => ({ h: `${h}h`, n }))}>
                <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="h" interval={1} /><YAxis allowDecimals={false} /><Tooltip />
                <Bar dataKey="n" name="Acciones" fill="#7c3aed" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <h3 style={{ margin: '0 0 8px' }}>{selected.name} — resúmenes de turno</h3>
          <ShiftEndReportsList userId={selected.userId} />
        </>
      )}
    </>
  )
}
