import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { today, addDays } from '../lib/utils'

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
function fmtDateTime(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type Parte = {
  id: number
  checkInDate: string
  checkOutDate: string
  people: number
  sesSubmittedAt: string
  sesLocutorioId: string | null
  status: string
  guestFirstName: string | null
  guestLastName:  string | null
  roomCode:       string | null
}

type SesCom = { referencia: string; codigoComunicacion: string; codigoEstado: number; descEstado: string; errores: string[] }
type SesStatus = { codigoEstado: number; descEstado: string; comunicaciones: SesCom[] } | null

const ESTADO_LABEL: Record<number, { label: string; cls: string }> = {
  1: { label: 'Recibido',   cls: 'ses-badge-ok'   },
  2: { label: 'Procesado',  cls: 'ses-badge-ok'   },
  3: { label: 'Error',      cls: 'ses-badge-err'  },
  4: { label: 'Anulado',    cls: 'ses-badge-warn' },
}

export default function SesView() {
  // Por defecto: solo los partes enviados hoy y ayer
  const [from,    setFrom]    = useState(() => addDays(today(), -1))
  const [to,      setTo]      = useState(today)
  const [partes,  setPartes]  = useState<Parte[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, SesStatus>>({})
  const [checking, setChecking] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/ses/partes?from=${from}&to=${to}`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error')
      setPartes(data.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const consultarLote = async (lote: string) => {
    setChecking(c => ({ ...c, [lote]: true }))
    try {
      const res = await fetch(`/api/ses/consultar/${encodeURIComponent(lote)}`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error')
      setStatuses(s => ({ ...s, [lote]: data.data }))
    } catch (e: any) {
      setStatuses(s => ({ ...s, [lote]: { codigoEstado: -1, descEstado: (e as Error).message } }))
    } finally {
      setChecking(c => ({ ...c, [lote]: false }))
    }
  }

  const consultarTodos = async () => {
    const lotes = [...new Set(partes.map(p => p.sesLocutorioId).filter(Boolean))] as string[]
    for (const lote of lotes) await consultarLote(lote)
  }

  const estadoBadge = (lote: string | null) => {
    if (!lote) return <span className="ses-badge ses-badge-warn">Sin lote</span>
    const s = statuses[lote]
    if (!s) return null
    const hasComErrors = s.comunicaciones?.some(c => c.codigoEstado !== 1 && c.codigoEstado !== 2 && c.errores?.length > 0)
    const info = hasComErrors
      ? { label: 'Errores en comunicaciones', cls: 'ses-badge-err' }
      : ESTADO_LABEL[s.codigoEstado] ?? { label: `Cód. ${s.codigoEstado}`, cls: 'ses-badge-warn' }
    return <span className={`ses-badge ${info.cls}`} title={s.descEstado}>{info.label}</span>
  }

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Partes SES Hospedajes</h2>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text2)' }}>Desde</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '4px 8px', fontSize: 13 }} />
          <label style={{ fontSize: 12, color: 'var(--text2)' }}>Hasta</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '4px 8px', fontSize: 13 }} />
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
            {loading ? 'Cargando…' : '↻ Actualizar'}
          </button>
          {partes.length > 0 && (() => {
            // "Consultar todos" solo con rango ≤ 2 días: cada lote es una llamada
            // al SOAP del Ministerio y un rango amplio los machacaría a peticiones
            const rangeDays = (new Date(to).getTime() - new Date(from).getTime()) / 86400000 + 1
            const tooWide   = rangeDays > 2
            return (
              <button className="btn btn-primary btn-sm" onClick={consultarTodos} disabled={tooWide}
                title={tooWide ? 'Reduce el rango a 2 días como máximo para consultar todos' : undefined}>
                Consultar todos en SES
              </button>
            )
          })()}
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Resumen */}
      {partes.length > 0 && (() => {
        const checkedStatuses = Object.values(statuses).filter(Boolean) as NonNullable<SesStatus>[]
        const okCount  = checkedStatuses.filter(s => (s.codigoEstado === 1 || s.codigoEstado === 2) && !s.comunicaciones?.some(c => c.errores?.length > 0)).length
        const errCount = checkedStatuses.filter(s => s.codigoEstado === 3 || s.codigoEstado === 6 || s.comunicaciones?.some(c => c.errores?.length > 0)).length
        const allErrors = checkedStatuses.flatMap(s => s.comunicaciones ?? []).filter(c => c.errores?.length > 0)
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="ses-stat-card">
                <span className="ses-stat-n">{partes.length}</span>
                <span className="ses-stat-l">Partes enviados</span>
              </div>
              <div className="ses-stat-card">
                <span className="ses-stat-n">{partes.filter(p => p.sesLocutorioId).length}</span>
                <span className="ses-stat-l">Con lote</span>
              </div>
              <div className="ses-stat-card">
                <span className="ses-stat-n">{okCount}</span>
                <span className="ses-stat-l">Procesados OK</span>
              </div>
              <div className={`ses-stat-card${errCount > 0 ? ' ses-stat-err' : ''}`}>
                <span className="ses-stat-n">{errCount}</span>
                <span className="ses-stat-l">Con error</span>
              </div>
            </div>
            {allErrors.length > 0 && (
              <div style={{ background: 'rgba(239,68,68,.07)', border: '1px solid rgba(239,68,68,.25)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontWeight: 700, color: '#b91c1c', marginBottom: 6, fontSize: 13 }}>
                  Errores de validación detectados ({allErrors.length})
                </div>
                {allErrors.map((c, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{c.referencia || `Comunicación ${i + 1}`}</span>
                    {c.descEstado && <span style={{ color: 'var(--text2)', fontSize: 12, marginLeft: 6 }}>{c.descEstado}</span>}
                    {c.errores.map((e, j) => (
                      <div key={j} style={{ fontSize: 12, color: 'var(--text)', marginTop: 2, paddingLeft: 10 }}>• {e}</div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {partes.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text2)' }}>
          No hay partes enviados en el rango seleccionado
        </div>
      )}

      {partes.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Reserva</th>
                <th>Huésped</th>
                <th>Hab.</th>
                <th>Entrada</th>
                <th>Salida</th>
                <th>Pers.</th>
                <th>Enviado</th>
                <th>Lote SES</th>
                <th>Estado SES</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {partes.map(p => {
                const lote = p.sesLocutorioId
                const isChecking = lote ? checking[lote] : false
                return (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/reservations/${p.id}`} className="link-primary">#{p.id}</Link>
                    </td>
                    <td>{p.guestFirstName} {p.guestLastName}</td>
                    <td>{p.roomCode ?? '—'}</td>
                    <td>{fmtDate(p.checkInDate)}</td>
                    <td>{fmtDate(p.checkOutDate)}</td>
                    <td style={{ textAlign: 'center' }}>{p.people}</td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}>{fmtDateTime(p.sesSubmittedAt)}</td>
                    <td>
                      {lote
                        ? <code style={{ fontSize: 11, background: 'var(--bg3)', padding: '2px 5px', borderRadius: 4 }}>{lote}</code>
                        : <span style={{ color: 'var(--text2)' }}>—</span>}
                    </td>
                    <td>
                      {estadoBadge(lote)}
                      {lote && statuses[lote] && (() => {
                        const s = statuses[lote]!
                        const comErrors = s.comunicaciones?.filter(c => c.errores?.length > 0) ?? []
                        if (comErrors.length === 0 && (s.codigoEstado === 1 || s.codigoEstado === 2)) return null
                        return (
                          <div style={{ marginTop: 4 }}>
                            {comErrors.length === 0 && (
                              <div style={{ fontSize: 11, color: 'var(--text2)' }}>{s.descEstado}</div>
                            )}
                            {comErrors.map((c, i) => (
                              <div key={i} style={{ marginTop: 4, background: 'rgba(239,68,68,.07)', border: '1px solid rgba(239,68,68,.2)', borderRadius: 5, padding: '4px 8px', fontSize: 11 }}>
                                <div style={{ fontWeight: 600, color: '#b91c1c', marginBottom: 2 }}>
                                  Ref: {c.referencia || '—'} · {c.descEstado}
                                </div>
                                {c.errores.map((e, j) => (
                                  <div key={j} style={{ color: 'var(--text2)' }}>• {e}</div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                    </td>
                    <td>
                      {lote && (
                        <button className="btn btn-ghost btn-xs" disabled={isChecking}
                          onClick={() => consultarLote(lote)}>
                          {isChecking ? '…' : 'Consultar'}
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
    </div>
  )
}
