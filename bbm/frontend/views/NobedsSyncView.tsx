import { useState, useEffect } from 'react'
import { api } from '../lib/api'

interface NobedRental { id: number; hotel_id: number; title: string }
interface RoomTypeRow { id: number; name: string; nobedsRoomId: number | null }

interface SyncResult {
  total: number
  created: number
  updated: number
  skipped: number
  errors: number
  errorList: string[]
  range: { from: string; to: string }
  syncedAt: string
}

interface PushResult {
  pushed: number
  skipped: number
  errors: number
  errorList: string[]
}

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

export default function NobedsSyncView() {
  const [configured, setConfigured]       = useState<boolean | null>(null)
  const [roomTypes, setRoomTypes]         = useState<RoomTypeRow[]>([])
  const [rentals, setRentals]             = useState<NobedRental[]>([])
  const [loadingRentals, setLoadingRentals] = useState(false)
  const [syncing, setSyncing]             = useState(false)
  const [syncResult, setSyncResult]       = useState<SyncResult | null>(null)
  const [error, setError]                 = useState<string | null>(null)
  const [editValues, setEditValues]       = useState<Record<number, string>>({})

  // Push de tarifas a Expedia
  const [pushFrom,     setPushFrom]     = useState(todayISO())
  const [pushTo,       setPushTo]       = useState(addDays(todayISO(), 90))
  const [pushRateCode, setPushRateCode] = useState('Expedia AL')
  const [pushing,      setPushing]      = useState(false)
  const [pushResult,   setPushResult]   = useState<PushResult | null>(null)

  useEffect(() => {
    fetch('/api/nobeds/status', { credentials: 'include' })
      .then(r => r.json())
      .then((r: any) => setConfigured(r.configured))
      .catch(() => setConfigured(false))

    api.listRoomTypes().then(r => {
      setRoomTypes(r.data.map((rt: any) => ({
        id: rt.id,
        name: rt.name,
        nobedsRoomId: rt.nobedsRoomId ?? null,
      })))
    }).catch(() => {})
  }, [])

  async function loadRentals() {
    setLoadingRentals(true)
    setError(null)
    try {
      const r = await fetch('/api/nobeds/rentals', { credentials: 'include' }).then(x => x.json())
      if (r.error) throw new Error(r.error)
      setRentals(r.data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingRentals(false)
    }
  }

  async function saveMapping(roomTypeId: number) {
    const raw = editValues[roomTypeId] ?? ''
    const val = raw.trim() === '' ? null : parseInt(raw)
    if (raw.trim() !== '' && (isNaN(val!) || val! <= 0)) {
      setError('El ID de Nobeds debe ser un número entero positivo')
      return
    }
    try {
      const r = await fetch(`/api/nobeds/room-types/${roomTypeId}/mapping`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nobedsRoomId: val }),
      }).then(x => x.json())
      if (r.error) throw new Error(r.error)
      setRoomTypes(prev => prev.map(rt => rt.id === roomTypeId ? { ...rt, nobedsRoomId: val } : rt))
      setEditValues(prev => { const next = { ...prev }; delete next[roomTypeId]; return next })
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function runPushPrices() {
    setPushing(true); setPushResult(null); setError(null)
    try {
      const r: any = await api.nobedsPushPrices(pushFrom, pushTo, pushRateCode)
      setPushResult(r.data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setPushing(false)
    }
  }

  async function runSync() {
    setSyncing(true)
    setSyncResult(null)
    setError(null)
    try {
      const r = await fetch('/api/nobeds/sync', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(x => x.json())
      if (r.error) throw new Error(r.error)
      setSyncResult(r.data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSyncing(false)
    }
  }

  const mappedCount = roomTypes.filter(rt => rt.nobedsRoomId != null).length

  return (
    <div className="view-container" style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Nobeds — Channel Manager</h1>
        {configured === null ? null : configured ? (
          <span className="badge badge-checkedin">Conectado</span>
        ) : (
          <span className="badge badge-cancelled">Sin configurar</span>
        )}
      </div>

      {!configured && configured !== null && (
        <div className="card" style={{ marginBottom: 20, padding: '14px 18px', background: 'var(--yellow, #fef3c7)', border: '1px solid #f59e0b', borderRadius: 8 }}>
          <strong>NOBEDS_API_TOKEN</strong> no está definido en el fichero <code>.env</code>.<br />
          Añade <code>NOBEDS_API_TOKEN=tu_token</code> y reinicia el servidor.
        </div>
      )}

      {error && (
        <div className="alert-error" style={{ marginBottom: 16 }}>{error}</div>
      )}

      {/* ── Mapeo de habitaciones ─────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15 }}>Mapeo de tipos de habitación</h2>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>
              {mappedCount} de {roomTypes.length} tipos mapeados
            </span>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={loadRentals}
            disabled={loadingRentals || !configured}
          >
            {loadingRentals ? 'Cargando…' : 'Cargar alojamientos Nobeds'}
          </button>
        </div>

        {rentals.length > 0 && (
          <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--bg2)', borderRadius: 6, fontSize: 13 }}>
            <strong style={{ display: 'block', marginBottom: 6 }}>Alojamientos en Nobeds:</strong>
            {rentals.map(r => (
              <div key={r.id} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                <code style={{ color: 'var(--accent)', minWidth: 60 }}>ID: {r.id}</code>
                <span>{r.title}</span>
              </div>
            ))}
          </div>
        )}

        <table className="table">
          <thead>
            <tr>
              <th>Tipo de habitación</th>
              <th>ID rental Nobeds</th>
              <th>Nuevo ID</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {roomTypes.map(rt => {
              const editing = rt.id in editValues
              const val     = editValues[rt.id] ?? ''
              return (
                <tr key={rt.id}>
                  <td><strong>{rt.name}</strong></td>
                  <td>
                    {rt.nobedsRoomId != null
                      ? <code style={{ color: 'var(--green)' }}>{rt.nobedsRoomId}</code>
                      : <span style={{ color: 'var(--text3)' }}>Sin mapear</span>
                    }
                  </td>
                  <td>
                    <input
                      type="number"
                      className="input input-sm"
                      style={{ width: 110 }}
                      placeholder={rt.nobedsRoomId != null ? String(rt.nobedsRoomId) : 'ID rental'}
                      value={editing ? val : ''}
                      onChange={e => setEditValues(prev => ({ ...prev, [rt.id]: e.target.value }))}
                    />
                  </td>
                  <td>
                    {editing && (
                      <button
                        className="btn btn-primary btn-xs"
                        onClick={() => saveMapping(rt.id)}
                      >
                        Guardar
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Push tarifas a Expedia ──────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ marginBottom: 14 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>Enviar tarifas a Expedia</h2>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>
            Lee los precios de la tarifa seleccionada y los envía a Nobeds (→ Expedia) con la disponibilidad calculada
          </span>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tarifa</div>
            <input
              className="input input-sm"
              value={pushRateCode}
              onChange={e => setPushRateCode(e.target.value)}
              style={{ width: 140 }}
              placeholder="Expedia AL"
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Desde</div>
            <input type="date" className="input input-sm" value={pushFrom} onChange={e => setPushFrom(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Hasta</div>
            <input type="date" className="input input-sm" value={pushTo} onChange={e => setPushTo(e.target.value)} />
          </div>
          <button
            className="btn btn-primary"
            onClick={runPushPrices}
            disabled={pushing || !configured || mappedCount === 0 || !pushFrom || !pushTo || pushFrom > pushTo}
          >
            {pushing ? 'Enviando…' : 'Enviar tarifas →'}
          </button>
        </div>

        {pushResult && (
          <div style={{ padding: '12px 16px', background: 'var(--bg2)', borderRadius: 8, fontSize: 13 }}>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: pushResult.errorList.length > 0 ? 8 : 0 }}>
              <span style={{ color: 'var(--green)' }}>✓ {pushResult.pushed} enviadas</span>
              <span style={{ color: 'var(--text2)' }}>⊘ {pushResult.skipped} sin precio</span>
              {pushResult.errors > 0 && <span style={{ color: 'var(--red)' }}>✕ {pushResult.errors} errores</span>}
            </div>
            {pushResult.errorList.length > 0 && (
              <div>
                {pushResult.errorList.map((e, i) => (
                  <div key={i} style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--red)', marginTop: 2 }}>{e}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Sincronización ──────────────────────────────────────────────── */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15 }}>Sincronizar reservas</h2>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>
              Importa reservas de Nobeds (mes anterior + 6 meses)
            </span>
          </div>
          <button
            className="btn btn-primary"
            onClick={runSync}
            disabled={syncing || !configured || mappedCount === 0}
          >
            {syncing ? 'Sincronizando…' : 'Sincronizar ahora'}
          </button>
        </div>

        {mappedCount === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>
            Mapea al menos una habitación antes de sincronizar.
          </p>
        )}

        {syncResult && (
          <div style={{ padding: '14px 16px', background: 'var(--bg2)', borderRadius: 8, fontSize: 13 }}>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 8 }}>
              <span><strong>{syncResult.total}</strong> reservas recibidas</span>
              <span style={{ color: 'var(--green)' }}>✓ {syncResult.created} creadas</span>
              <span style={{ color: 'var(--blue)' }}>↻ {syncResult.updated} actualizadas</span>
              <span style={{ color: 'var(--text2)' }}>⊘ {syncResult.skipped} omitidas</span>
              {syncResult.errors > 0 && (
                <span style={{ color: 'var(--red)' }}>✕ {syncResult.errors} errores</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>
              Rango: {syncResult.range.from} → {syncResult.range.to} ·{' '}
              {new Date(syncResult.syncedAt).toLocaleString('es-ES')}
            </div>
            {syncResult.errorList.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <strong style={{ color: 'var(--red)' }}>Errores:</strong>
                {syncResult.errorList.map((e, i) => (
                  <div key={i} style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--red)', marginTop: 3 }}>{e}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
