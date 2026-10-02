import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { fmtDateTime, toast } from '../lib/utils'

const SEVERITY_LABEL: Record<string, { label: string; color: string }> = {
  urgent:     { label: 'Urgente',     color: 'var(--red)' },
  warning:    { label: 'Advertencia', color: 'var(--yellow)' },
  info:       { label: 'Info',        color: '#7c3aed' },
  suggestion: { label: 'Propuesta',   color: '#2563eb' },
}

function statusOf(a: any): { label: string; color: string } {
  if (a.silencedAt) return { label: 'Silenciada', color: 'var(--text2)' }
  if (a.resolvedAt) return { label: 'Resuelta',    color: 'var(--green)' }
  return { label: 'Activa', color: 'var(--red)' }
}

// Por defecto, últimos 7 días — en hora de Madrid, no la del navegador
// (toISOString() da la fecha en UTC, que puede ser "otro día" que en Madrid).
const madridISO = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d)
const todayISO = () => madridISO(new Date())
const daysAgoISO = (n: number) => madridISO(new Date(Date.now() - n * 86400000))

export default function AlertsView() {
  const navigate = useNavigate()
  const [tab,      setTab]      = useState<'history' | 'employees'>('history')
  const [from,     setFrom]     = useState(daysAgoISO(7))
  const [to,       setTo]       = useState(todayISO())
  const [data,     setData]     = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [busyKey,  setBusyKey]  = useState<string | null>(null)
  const [triggering, setTriggering] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res: any = await api.alertsHistory({ from, to })
      setData(res.data ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const silence = async (a: any) => {
    if (!confirm(`¿Silenciar esta alerta? Dejará de mostrarse en la barra hasta que se resuelva sola o vuelva a activarse más tarde.\n\n"${a.message}"`)) return
    setBusyKey(a.entityKey)
    try {
      await api.silenceAlert(a.entityKey)
      toast('Alerta silenciada')
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setBusyKey(null) }
  }

  const triggerDireccionUrgente = async () => {
    if (!confirm('¿Enviar aviso urgente a recepción para que se comunique con dirección?')) return
    setTriggering(true)
    try {
      await api.triggerDireccionUrgente()
      toast('Alerta enviada a recepción')
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setTriggering(false) }
  }

  return (
    <>
      <div className="tabs" style={{ margin: '0 0 12px' }}>
        <button className={`tab-btn${tab === 'history' ? ' active' : ''}`} onClick={() => setTab('history')}>Historial</button>
        <button className={`tab-btn${tab === 'employees' ? ' active' : ''}`} onClick={() => setTab('employees')}>Por empleado</button>
      </div>

      <div className="search-bar" style={{ flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>Periodo:</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ width: 140 }} />
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>—</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ width: 140 }} />
        </div>
        {tab === 'history' && (
          <button
            className="btn btn-primary"
            style={{ background: 'var(--red)', borderColor: 'var(--red)' }}
            disabled={triggering}
            onClick={triggerDireccionUrgente}
          >
            🚨 {triggering ? 'Enviando…' : 'Comunicarse con Dirección (urgente)'}
          </button>
        )}
      </div>

      {tab === 'employees' ? (
        <EmployeeReportPanel from={from} to={to} />
      ) : loading ? (
        <div className="loading">Cargando…</div>
      ) : error ? (
        <div className="empty"><p>{error}</p></div>
      ) : data.length === 0 ? (
        <div className="empty"><p>Sin alertas activadas en este periodo</p></div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th>Activada</th><th>Tipo</th><th>Mensaje</th><th>Severidad</th>
              <th>Reserva</th><th>Estado</th><th>Detalle</th><th></th>
            </tr></thead>
            <tbody>
              {data.map((a: any) => {
                const sev = SEVERITY_LABEL[a.severity] ?? { label: a.severity ?? 'Urgente', color: 'var(--red)' }
                const st  = statusOf(a)
                return (
                  <tr key={a.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.firstSeenAt)}</td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}><code>{a.alertType}</code></td>
                    <td style={{ fontSize: 13 }}>{a.message}</td>
                    <td><span style={{ color: sev.color, fontWeight: 600, fontSize: 12 }}>{sev.label}</span></td>
                    <td>
                      {a.reservation ? (
                        <a href="#" onClick={e => { e.preventDefault(); navigate(`/reservations/${a.reservation.id}`) }}>
                          {a.reservation.guest ? `${a.reservation.guest.firstName} ${a.reservation.guest.lastName}` : `#${a.reservation.id}`}
                        </a>
                      ) : '—'}
                    </td>
                    <td><span style={{ color: st.color, fontWeight: 600, fontSize: 12 }}>{st.label}</span></td>
                    <td style={{ fontSize: 11, color: 'var(--text2)' }}>
                      {a.silencedAt && (
                        <>Silenciada el {fmtDateTime(a.silencedAt)}{a.silencedByUser ? ` por ${a.silencedByUser.firstName} ${a.silencedByUser.lastName}` : ''}</>
                      )}
                      {!a.silencedAt && a.resolvedAt && <>Resuelta el {fmtDateTime(a.resolvedAt)}</>}
                      {!a.silencedAt && !a.resolvedAt && a.lastSeenAt !== a.firstSeenAt && <>Última vez visible: {fmtDateTime(a.lastSeenAt)}</>}
                      {a.createdByUser && <div>Creada por {a.createdByUser.firstName} {a.createdByUser.lastName}</div>}
                    </td>
                    <td>
                      {!a.silencedAt && !a.resolvedAt && (
                        <button className="btn btn-ghost btn-sm" disabled={busyKey === a.entityKey}
                          onClick={() => silence(a)}>
                          {busyKey === a.entityKey ? '…' : 'Silenciar'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ─── Informe por empleado ────────────────────────────────────────────────────
// Por cada turno de caja cerrado en el periodo: cuántas alertas activas
// durante ese turno se resolvieron/silenciaron antes de que cerrara (el
// empleado las atendió) frente a cuántas seguían activas justo al cerrarlo
// (se fue sin solucionarlas). Es orientativo, no una auditoría exacta — ver
// nota en el propio informe.
function EmployeeReportPanel({ from, to }: { from: string; to: string }) {
  const [rows,    setRows]    = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    api.alertsEmployeeReport({ from, to }).then((res: any) => {
      if (!cancelled) setRows(res.data ?? [])
    }).catch((e: any) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [from, to])

  if (loading) return <div className="loading">Cargando…</div>
  if (error)   return <div className="empty"><p>{error}</p></div>

  return (
    <>
      <p style={{ color: 'var(--text2)', fontSize: 13, margin: '0 0 12px' }}>
        Por cada turno de caja cerrado en el periodo, cuántas alertas que estaban activas se resolvieron o
        silenciaron antes de cerrarlo, frente a cuántas seguían activas en ese momento (se quedaron para el
        siguiente turno, o para nadie). Si una alerta sigue sin resolverse varios turnos seguidos, cuenta como
        "sin atender" en cada uno de ellos. Orientativo: no todas las alertas se resuelven por una acción humana
        — algunas se autolimpian solas al pasar el tiempo o cambiar la condición que las disparó.
      </p>
      {rows.length === 0 ? (
        <div className="empty"><p>Sin turnos de caja cerrados en este periodo</p></div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th>Empleado</th><th>Turnos</th><th>Atendidas</th><th>Sin atender</th><th>% atendidas</th>
            </tr></thead>
            <tbody>
              {rows.map((r: any) => {
                const totalAlerts = r.resolved + r.abandoned
                const pct = totalAlerts > 0 ? Math.round((r.resolved / totalAlerts) * 100) : null
                return (
                  <tr key={r.userId}>
                    <td>{r.name}</td>
                    <td>{r.shiftsWorked}</td>
                    <td style={{ color: 'var(--green)' }}>{r.resolved}</td>
                    <td style={{ color: r.abandoned > 0 ? 'var(--red)' : undefined, fontWeight: r.abandoned > 0 ? 600 : undefined }}>
                      {r.abandoned}
                    </td>
                    <td>{pct == null ? '—' : `${pct}%`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
