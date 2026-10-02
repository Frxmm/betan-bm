import { useState, useEffect, useCallback } from 'react'
import { api, type Room, type RoomType } from '../lib/api'
import { toast, sortRoomsByCode } from '../lib/utils'
import { Modal } from '../components/Modal'
import { useAuth, canManage } from '../contexts/AuthContext'

type Tab = 'rooms' | 'types' | 'features'

// ─── Vista principal ──────────────────────────────────────────────────────────

export default function RoomsView() {
  const [tab, setTab] = useState<Tab>('rooms')

  return (
    <>
      <div className="view-header">
        <div>
          <h2>Habitaciones</h2>
          <p className="view-subtitle">Gestión de habitaciones y tipos</p>
        </div>
      </div>

      <div className="tab-bar" style={{ marginBottom: 16 }}>
        <button className={`tab-btn${tab === 'rooms'    ? ' active' : ''}`} onClick={() => setTab('rooms')}>Habitaciones</button>
        <button className={`tab-btn${tab === 'features' ? ' active' : ''}`} onClick={() => setTab('features')}>Características</button>
        <button className={`tab-btn${tab === 'types'    ? ' active' : ''}`} onClick={() => setTab('types')}>Tipos</button>
      </div>

      {tab === 'rooms'    && <RoomsTab />}
      {tab === 'features' && <FeaturesTab />}
      {tab === 'types'    && <RoomTypesTab />}
    </>
  )
}

// ─── Pestaña: Habitaciones ────────────────────────────────────────────────────

function RoomsTab() {
  const { user } = useAuth()
  const admin = canManage(user)
  const [rooms,     setRooms]     = useState<Room[]>([])
  const [types,     setTypes]     = useState<RoomType[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [editing,   setEditing]   = useState<Room | 'new' | null>(null)
  const [qrRoom,    setQrRoom]    = useState<Room | null>(null)
  const [showInactive, setShowInactive] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [r, t]: any[] = await Promise.all([api.listRooms(), api.listRoomTypes()])
      setRooms(sortRoomsByCode(r.data))
      setTypes(t.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const doDelete = async (room: Room) => {
    if (!confirm(`¿Desactivar la habitación ${room.code}?`)) return
    try { await api.deleteRoom(room.id); toast(`Habitación ${room.code} desactivada`); load() }
    catch (e: any) { toast(e.message, 'err') }
  }

  const doReactivate = async (room: Room) => {
    try { await api.updateRoom(room.id, { active: true }); toast(`Habitación ${room.code} reactivada`); load() }
    catch (e: any) { toast(e.message, 'err') }
  }

  const typesById = Object.fromEntries(types.map(t => [t.id, t]))
  const visible = showInactive ? rooms : rooms.filter(r => r.active)

  if (loading) return <div className="loading">Cargando habitaciones…</div>
  if (error)   return <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <label style={{ fontSize: 13, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Mostrar desactivadas
        </label>
        {admin && <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Nueva habitación</button>}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Tipo</th>
              <th>Capacidad</th>
              <th>Precio base</th>
              <th>Orden</th>
              <th>Color</th>
              <th>TTLock</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map(room => {
              const type = room.roomType ?? typesById[room.roomTypeId]
              return (
                <tr key={room.id} style={{ opacity: room.active ? 1 : 0.5 }}>
                  <td>
                    <strong style={{ color: 'var(--accent2)', fontFamily: 'monospace' }}>{room.code}</strong>
                  </td>
                  <td>{type?.name ?? '—'}</td>
                  <td>{type?.maxOccupancy ?? '—'} pax</td>
                  <td>{type ? `${parseFloat(type.defaultPrice).toFixed(2)} €` : '—'}</td>
                  <td style={{ color: 'var(--text2)', fontSize: 13 }}>{room.orderIndex}</td>
                  <td>
                    {(room.backgroundColor || type?.backgroundColor)
                      ? <span style={{
                          display: 'inline-block', width: 20, height: 20, borderRadius: 4,
                          background: (room.backgroundColor || type?.backgroundColor) as string,
                          border: room.backgroundColor ? '2px solid var(--text2)' : '1px solid var(--border)',
                          verticalAlign: 'middle',
                        }} title={(room.backgroundColor ? 'Override: ' : 'Tipo: ') + (room.backgroundColor || type?.backgroundColor)} />
                      : <span style={{ color: 'var(--text2)', fontSize: 12 }}>—</span>}
                  </td>
                  <td>
                    {(room as any).ttlockId
                      ? <span style={{ fontSize: 11, color: '#7c3aed', fontWeight: 600, fontFamily: 'monospace' }} title={(room as any).ttlockId}>🔒 {(room as any).ttlockId}</span>
                      : <span style={{ color: 'var(--text2)', fontSize: 12 }}>—</span>}
                  </td>
                  <td>
                    <span style={{ color: room.active ? 'var(--green)' : 'var(--text2)', fontSize: 12 }}>
                      {room.active ? '● Activa' : '○ Inactiva'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {admin && <>
                      <button className="btn btn-ghost btn-xs" onClick={() => setEditing(room)}>Editar</button>
                      <button className="btn btn-ghost btn-xs" style={{ marginLeft: 4 }} onClick={() => setQrRoom(room)}>QR</button>
                      {room.active
                        ? <button className="btn btn-ghost btn-xs" style={{ color: 'var(--red)', marginLeft: 4 }} onClick={() => doDelete(room)}>Desactivar</button>
                        : <button className="btn btn-ghost btn-xs" style={{ color: 'var(--green)', marginLeft: 4 }} onClick={() => doReactivate(room)}>Reactivar</button>}
                    </>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="empty" style={{ padding: 24 }}>
            <p>No hay habitaciones{showInactive ? '' : ' activas'}</p>
          </div>
        )}
      </div>

      {qrRoom && <RoomQrModal room={qrRoom} onClose={() => setQrRoom(null)} />}

      {editing !== null && (
        <RoomModal
          room={editing === 'new' ? null : editing}
          types={types}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </>
  )
}

// ─── Modal: QR de acceso de la habitación (huésped) ────────────────────────────
// El token se genera una sola vez (rooms.qrToken, ver src/lib/roomAccess.ts) y
// no cambia con los despliegues — el QR impreso sigue sirviendo siempre. Con
// él, el huésped alojado ahora mismo en esta habitación accede a su reserva
// (confirmando su apellido) desde /room.
function RoomQrModal({ room, onClose }: { room: Room; onClose: () => void }) {
  const [data,    setData]    = useState<{ url: string; qrDataUrl: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    api.getRoomQr(room.id)
      .then(d => setData(d))
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false))
  }, [room.id])

  return (
    <Modal title={`QR de acceso — Habitación ${room.code}`} onClose={onClose} footer={
      <button className="btn btn-ghost" onClick={onClose}>Cerrar</button>
    }>
      {loading && <div className="loading">Generando…</div>}
      {error && <p style={{ color: 'var(--red)' }}>{error}</p>}
      {data && (
        <div style={{ textAlign: 'center' }}>
          <img src={data.qrDataUrl} alt={`QR habitación ${room.code}`} style={{ width: 260, height: 260, marginBottom: 12 }} />
          <p style={{ fontSize: 12, color: 'var(--text2)', wordBreak: 'break-all', marginBottom: 12 }}>{data.url}</p>
          <a className="btn btn-primary btn-sm" href={data.qrDataUrl} download={`qr-habitacion-${room.code}.png`}>
            Descargar PNG
          </a>
          <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 12 }}>
            Imprímelo y ponlo en la habitación — es el mismo QR siempre, no cambia con las actualizaciones del sistema.
          </p>
        </div>
      )}
    </Modal>
  )
}

// ─── Modal: crear / editar habitación ────────────────────────────────────────

function RoomModal({ room, types, onClose, onSaved }:
  { room: Room | null; types: RoomType[]; onClose: () => void; onSaved: () => void }) {
  const isNew = !room
  const [form, setForm] = useState({
    code:               room?.code ?? '',
    roomTypeId:         room?.roomTypeId ? String(room.roomTypeId) : (types[0]?.id ? String(types[0].id) : ''),
    active:             room?.active !== false,
    orderIndex:         String(room?.orderIndex ?? 0),
    startingBedNumber:  String(room?.startingBedNumber ?? 1),
    // Características físicas
    bathroom:           room?.bathroom ?? '',
    terrace:            room?.terrace  ?? '',
    balcony:            room?.balcony  ?? false,
    bedSize:            room?.bedSize  ?? '',
    roomSizeSqm:        room?.roomSizeSqm ? String(parseFloat(room.roomSizeSqm)) : '',
    view:               room?.view     ?? '',
    acBrand:            room?.acBrand  ?? '',
    tvBrand:            room?.tvBrand  ?? '',
    lockType:           room?.lockType ?? '',
    ttlockId:           (room as any)?.ttlockId ?? '',
    // Override de color (vacío = hereda del tipo)
    color:              room?.color ?? '',
    backgroundColor:    room?.backgroundColor ?? '',
    fontColor:          room?.fontColor ?? '',
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))
  const chk = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.checked }))

  const save = async () => {
    if (!form.code.trim())     { toast('El código es obligatorio', 'err'); return }
    if (!form.roomTypeId)      { toast('Selecciona un tipo de habitación', 'err'); return }
    setSaving(true)
    try {
      const payload = {
        code:               form.code.trim(),
        roomTypeId:         Number(form.roomTypeId),
        active:             form.active,
        orderIndex:         Number(form.orderIndex) || 0,
        startingBedNumber:  Number(form.startingBedNumber) || 1,
        bathroom:           (form.bathroom || null) as any,
        terrace:            (form.terrace  || null) as any,
        balcony:            form.balcony,
        bedSize:            (form.bedSize  || null) as any,
        roomSizeSqm:        form.roomSizeSqm ? parseFloat(form.roomSizeSqm) : null,
        view:               (form.view || null) as any,
        acBrand:            form.acBrand.trim() || null,
        tvBrand:            form.tvBrand.trim() || null,
        lockType:           form.lockType.trim() || null,
        ttlockId:           form.ttlockId.trim() || null,
        color:              form.color || null,
        backgroundColor:    form.backgroundColor || null,
        fontColor:          form.fontColor || null,
      }
      if (isNew) await api.createRoom(payload)
      else       await api.updateRoom(room!.id, payload)
      toast(isNew ? 'Habitación creada' : 'Habitación actualizada')
      onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title={isNew ? 'Nueva habitación' : `Editar: ${room!.code}`} onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
    }>
      <div className="form-grid">
        <div className="form-group">
          <label>Código *</label>
          <input value={form.code} onChange={set('code')} placeholder="101" />
        </div>
        <div className="form-group">
          <label>Tipo de habitación *</label>
          <select value={form.roomTypeId} onChange={set('roomTypeId')}>
            <option value="">— Selecciona tipo —</option>
            {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Cama inicial</label>
          <input type="number" min="1" value={form.startingBedNumber} onChange={set('startingBedNumber')} />
        </div>
        <div className="form-group">
          <label>Orden</label>
          <input type="number" min="0" value={form.orderIndex} onChange={set('orderIndex')} />
        </div>
        <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
          <input type="checkbox" id="rm-active" checked={form.active} onChange={chk('active')} />
          <label htmlFor="rm-active">Activa</label>
        </div>
      </div>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 12 }}>
        <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>Características</legend>
        <div className="form-grid">
          <div className="form-group">
            <label>Baño</label>
            <select value={form.bathroom} onChange={set('bathroom')}>
              <option value="">— Sin especificar —</option>
              <option value="shower">Ducha</option>
              <option value="bathtub">Bañera</option>
              <option value="both">Ducha y bañera</option>
            </select>
          </div>
          <div className="form-group">
            <label>Terraza</label>
            <select value={form.terrace} onChange={set('terrace')}>
              <option value="">— Sin especificar —</option>
              <option value="private">Terraza privada</option>
              <option value="shared">Terraza compartida</option>
              <option value="none">Sin terraza</option>
            </select>
          </div>
          <div className="form-group">
            <label>Tamaño de cama</label>
            <select value={form.bedSize} onChange={set('bedSize')}>
              <option value="">— Sin especificar —</option>
              <option value="single">Individual</option>
              <option value="twin">Dos camas</option>
              <option value="double">Doble</option>
              <option value="queen">Queen</option>
              <option value="king">King</option>
              <option value="bunk">Literas</option>
            </select>
          </div>
          <div className="form-group">
            <label>Tamaño (m²)</label>
            <input type="number" step="0.5" min="0" value={form.roomSizeSqm} onChange={set('roomSizeSqm')} placeholder="25" />
          </div>
          <div className="form-group">
            <label>Vistas</label>
            <select value={form.view} onChange={set('view')}>
              <option value="">— Sin especificar —</option>
              <option value="sea">Vistas al mar</option>
              <option value="pool">Vistas a la piscina</option>
              <option value="interior">Vista interior</option>
              <option value="lateral">Vista lateral</option>
              <option value="street">Vistas a la calle</option>
            </select>
          </div>
          <div className="form-group">
            <label>Tipo de cerradura</label>
            <input value={form.lockType} onChange={set('lockType')} placeholder="Llave, tarjeta magnética, código…" />
          </div>
          <div className="form-group">
            <label>TTLock ID <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400 }}>(ID numérico del lock en la app TTLock)</span></label>
            <input value={form.ttlockId} onChange={set('ttlockId')} placeholder="Ej: 7654321" style={{ fontFamily: 'monospace' }} />
          </div>
          <div className="form-group">
            <label>Marca aire acondicionado</label>
            <input value={form.acBrand} onChange={set('acBrand')} placeholder="Daikin, Mitsubishi…" />
          </div>
          <div className="form-group">
            <label>Marca TV</label>
            <input value={form.tvBrand} onChange={set('tvBrand')} placeholder="Samsung, LG…" />
          </div>
          <div className="form-group full" style={{ display: 'flex', gap: 20, flexWrap: 'wrap', paddingTop: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={form.balcony} onChange={chk('balcony')} />
              Balconera
            </label>
          </div>
        </div>
      </fieldset>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 12 }}>
        <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>Override colores (deja vacío para heredar del tipo)</legend>
        <div className="form-grid">
          <div className="form-group">
            <label>Color fondo</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="color" value={form.backgroundColor || '#cccccc'}
                onChange={e => setForm(f => ({ ...f, backgroundColor: e.target.value }))}
                style={{ width: 40, height: 32, padding: 2, border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }} />
              <input value={form.backgroundColor} onChange={set('backgroundColor')} placeholder="#rrggbb (vacío = tipo)" style={{ flex: 1, fontFamily: 'monospace' }} maxLength={7} />
              {form.backgroundColor && <button type="button" style={{ fontSize: 11, color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setForm(f => ({ ...f, backgroundColor: '' }))}>✕</button>}
            </div>
          </div>
          <div className="form-group">
            <label>Color texto</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="color" value={form.fontColor || '#333333'}
                onChange={e => setForm(f => ({ ...f, fontColor: e.target.value }))}
                style={{ width: 40, height: 32, padding: 2, border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }} />
              <input value={form.fontColor} onChange={set('fontColor')} placeholder="#rrggbb (vacío = tipo)" style={{ flex: 1, fontFamily: 'monospace' }} maxLength={7} />
              {form.fontColor && <button type="button" style={{ fontSize: 11, color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setForm(f => ({ ...f, fontColor: '' }))}>✕</button>}
            </div>
          </div>
          <div className="form-group">
            <label>Color borde</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="color" value={form.color || '#999999'}
                onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                style={{ width: 40, height: 32, padding: 2, border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }} />
              <input value={form.color} onChange={set('color')} placeholder="#rrggbb (vacío = tipo)" style={{ flex: 1, fontFamily: 'monospace' }} maxLength={7} />
              {form.color && <button type="button" style={{ fontSize: 11, color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setForm(f => ({ ...f, color: '' }))}>✕</button>}
            </div>
          </div>
          {(form.backgroundColor || form.fontColor) && (
            <div className="form-group" style={{ display: 'flex', alignItems: 'center' }}>
              <label>Vista previa</label>
              <span style={{
                display: 'inline-block', padding: '4px 10px', borderRadius: 4,
                background: form.backgroundColor || 'var(--bg3)',
                color: form.fontColor || 'var(--text)',
                border: `2px solid ${form.color || 'var(--border)'}`,
                fontWeight: 600, fontSize: 13,
              }}>{form.code || '101'}</span>
            </div>
          )}
        </div>
      </fieldset>

    </Modal>
  )
}

// ─── Helpers etiquetas ────────────────────────────────────────────────────────

const BATHROOM_LABEL: Record<string, string> = { shower: 'Ducha', bathtub: 'Bañera', both: 'Ducha + bañera' }
const TERRACE_LABEL:  Record<string, string> = { private: 'Privada', shared: 'Compartida', none: 'Sin terraza' }
const BEDSIZE_LABEL:  Record<string, string> = { single: 'Individual', twin: 'Dos camas', double: 'Doble', queen: 'Queen', king: 'King', bunk: 'Literas' }
const VIEW_LABEL:     Record<string, string> = { sea: 'Mar', pool: 'Piscina', interior: 'Interior', lateral: 'Lateral' }

function BoolCell({ v }: { v?: boolean }) {
  return v ? <span style={{ color: 'var(--green)' }}>✓</span> : <span style={{ color: 'var(--text2)', opacity: .4 }}>—</span>
}

// ─── Pestaña: Características ─────────────────────────────────────────────────

function FeaturesTab() {
  const { user } = useAuth()
  const admin    = canManage(user)
  const [rooms,   setRooms]   = useState<Room[]>([])
  const [types,   setTypes]   = useState<RoomType[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [editing, setEditing] = useState<Room | null>(null)

  // Filtros
  const [fBathroom,    setFBathroom]    = useState('')
  const [fTerrace,     setFTerrace]     = useState('')
  const [fBedSize,     setFBedSize]     = useState('')
  const [fView,        setFView]        = useState('')
  const [fBalcony,     setFBalcony]     = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [r, t]: any[] = await Promise.all([api.listRooms(), api.listRoomTypes()])
      setRooms(sortRoomsByCode(r.data))
      setTypes(t.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = rooms.filter(r => {
    if (fBathroom && r.bathroom !== fBathroom) return false
    if (fTerrace  && r.terrace  !== fTerrace)  return false
    if (fBedSize  && r.bedSize  !== fBedSize)  return false
    if (fView     && r.view     !== fView)     return false
    if (fBalcony  && !r.balcony)               return false
    return true
  })

  const anyFilter = fBathroom || fTerrace || fBedSize || fView || fBalcony
  const clearFilters = () => {
    setFBathroom(''); setFTerrace(''); setFBedSize(''); setFView(''); setFBalcony(false)
  }

  if (loading) return <div className="loading">Cargando…</div>
  if (error)   return <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>

  return (
    <>
      {/* Filtros */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <select value={fBathroom} onChange={e => setFBathroom(e.target.value)} style={{ minWidth: 140 }}>
          <option value="">Baño: todos</option>
          <option value="shower">Ducha</option>
          <option value="bathtub">Bañera</option>
          <option value="both">Ducha + bañera</option>
        </select>
        <select value={fTerrace} onChange={e => setFTerrace(e.target.value)} style={{ minWidth: 160 }}>
          <option value="">Terraza: todas</option>
          <option value="private">Privada</option>
          <option value="shared">Compartida</option>
          <option value="none">Sin terraza</option>
        </select>
        <select value={fBedSize} onChange={e => setFBedSize(e.target.value)} style={{ minWidth: 150 }}>
          <option value="">Cama: todas</option>
          <option value="single">Individual</option>
          <option value="twin">Dos camas</option>
          <option value="double">Doble</option>
          <option value="queen">Queen</option>
          <option value="king">King</option>
          <option value="bunk">Literas</option>
        </select>
        <select value={fView} onChange={e => setFView(e.target.value)} style={{ minWidth: 150 }}>
          <option value="">Vistas: todas</option>
          <option value="sea">Mar</option>
          <option value="pool">Piscina</option>
          <option value="interior">Interior</option>
          <option value="lateral">Lateral</option>
          <option value="street">Calle</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 13,
          background: fBalcony ? 'rgba(79,124,255,.15)' : 'var(--bg3)',
          border: `1px solid ${fBalcony ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 6, padding: '4px 10px', userSelect: 'none' }}>
          <input type="checkbox" checked={fBalcony} onChange={e => setFBalcony(e.target.checked)} style={{ margin: 0 }} />
          Balconera
        </label>
        {anyFilter && (
          <button className="btn btn-ghost btn-sm" onClick={clearFilters}>✕ Limpiar filtros</button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text2)' }}>
          {filtered.length} de {rooms.length} habitaciones
        </span>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Hab.</th>
              <th>Tipo</th>
              <th>Baño</th>
              <th>Terraza</th>
              <th>Balconera</th>
              <th>Cama</th>
              <th>m²</th>
              <th>Vistas</th>
              <th>Cerradura</th>
              <th>Aire</th>
              <th>TV</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(room => {
              const type = room.roomType ?? types.find(t => t.id === room.roomTypeId)
              return (
                <tr key={room.id} style={{ opacity: room.active ? 1 : 0.5 }}>
                  <td><strong style={{ fontFamily: 'monospace', color: 'var(--accent2)' }}>{room.code}</strong></td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{type?.name ?? '—'}</td>
                  <td>{room.bathroom ? BATHROOM_LABEL[room.bathroom] : <span style={{ color: 'var(--text2)', opacity: .4 }}>—</span>}</td>
                  <td>{room.terrace  ? TERRACE_LABEL[room.terrace]   : <span style={{ color: 'var(--text2)', opacity: .4 }}>—</span>}</td>
                  <td><BoolCell v={room.balcony} /></td>
                  <td>{room.bedSize  ? BEDSIZE_LABEL[room.bedSize]   : <span style={{ color: 'var(--text2)', opacity: .4 }}>—</span>}</td>
                  <td style={{ fontSize: 12 }}>{room.roomSizeSqm ? `${parseFloat(room.roomSizeSqm)} m²` : <span style={{ color: 'var(--text2)', opacity: .4 }}>—</span>}</td>
                  <td style={{ fontSize: 12 }}>{room.view ? VIEW_LABEL[room.view] : <span style={{ color: 'var(--text2)', opacity: .4 }}>—</span>}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{room.lockType ?? <span style={{ opacity: .4 }}>—</span>}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{room.acBrand  ?? <span style={{ opacity: .4 }}>—</span>}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{room.tvBrand  ?? <span style={{ opacity: .4 }}>—</span>}</td>
                  {admin && <td><button className="btn btn-ghost btn-xs" onClick={() => setEditing(room)}>Editar</button></td>}
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="empty" style={{ padding: 24 }}><p>Sin habitaciones con esos filtros</p></div>
        )}
      </div>

      {editing && (
        <RoomModal
          room={editing}
          types={types}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </>
  )
}

// ─── Pestaña: Tipos de habitación ─────────────────────────────────────────────

function RoomTypesTab() {
  const { user } = useAuth()
  const admin    = canManage(user)
  const [types,   setTypes]   = useState<RoomType[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [editing, setEditing] = useState<RoomType | 'new' | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const { data }: any = await api.listRoomTypes()
      setTypes(data.slice().sort((a: RoomType, b: RoomType) => a.orderIndex - b.orderIndex || a.id - b.id))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const doDelete = async (t: RoomType) => {
    if (!confirm(`¿Desactivar el tipo "${t.name}"?`)) return
    try { await api.deleteRoomType(t.id); toast(`Tipo "${t.name}" desactivado`); load() }
    catch (e: any) { toast(e.message, 'err') }
  }

  if (loading) return <div className="loading">Cargando tipos…</div>
  if (error)   return <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>

  return (
    <>
      {admin && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Nuevo tipo</button>
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Prefijo</th>
              <th>Capacidad</th>
              <th>Baño privado</th>
              <th>Camas extra</th>
              <th>Precio base</th>
              <th>Orden</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {types.map(t => (
              <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}>
                <td>
                  <strong>{t.name}</strong>
                  {t.description && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>{t.description}</div>}
                </td>
                <td style={{ fontFamily: 'monospace', color: 'var(--text2)' }}>{t.prefix ?? '—'}</td>
                <td>{t.maxOccupancy} pax</td>
                <td style={{ color: t.ensuite ? 'var(--green)' : 'var(--text2)' }}>{t.ensuite ? 'Sí' : 'No'}</td>
                <td>{t.allowExtraBeds > 0 ? `${t.allowExtraBeds} (${parseFloat(t.extraBedPrice).toFixed(2)} €)` : '—'}</td>
                <td>{parseFloat(t.defaultPrice).toFixed(2)} €</td>
                <td style={{ color: 'var(--text2)', fontSize: 13 }}>{t.orderIndex}</td>
                <td>
                  <span style={{ color: t.active ? 'var(--green)' : 'var(--text2)', fontSize: 12 }}>
                    {t.active ? '● Activo' : '○ Inactivo'}
                  </span>
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {admin && <>
                    <button className="btn btn-ghost btn-xs" onClick={() => setEditing(t)}>Editar</button>
                    {t.active && (
                      <button className="btn btn-ghost btn-xs" style={{ color: 'var(--red)', marginLeft: 4 }} onClick={() => doDelete(t)}>Desactivar</button>
                    )}
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {types.length === 0 && (
          <div className="empty" style={{ padding: 24 }}><p>No hay tipos de habitación</p></div>
        )}
      </div>

      {editing !== null && (
        <RoomTypeModal
          type={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </>
  )
}

// ─── Modal: crear / editar tipo de habitación ─────────────────────────────────

function RoomTypeModal({ type, onClose, onSaved }:
  { type: RoomType | null; onClose: () => void; onSaved: () => void }) {
  const isNew = !type
  const [form, setForm] = useState({
    name:           type?.name ?? '',
    description:    type?.description ?? '',
    prefix:         type?.prefix ?? '',
    roomClass:      type?.roomClass != null ? String(type.roomClass) : '',
    maxOccupancy:   String(type?.maxOccupancy ?? 2),
    ensuite:        type?.ensuite !== false,
    allowExtraBeds: String(type?.allowExtraBeds ?? 0),
    extraBedPrice:  type?.extraBedPrice ? parseFloat(type.extraBedPrice).toFixed(2) : '0.00',
    defaultPrice:   type?.defaultPrice ? parseFloat(type.defaultPrice).toFixed(2) : '0.00',
    orderIndex:          String(type?.orderIndex ?? 0),
    bookingEngineLabel:         type?.bookingEngineLabel ?? '',
    maxOccupancyBookingEngine:  type?.maxOccupancyBookingEngine != null ? String(type.maxOccupancyBookingEngine) : '',
    isVirtual:           (type as any)?.isVirtual === true,
    color:               type?.color ?? '',
    backgroundColor:     type?.backgroundColor ?? '',
    fontColor:           type?.fontColor ?? '',
    active:              type?.active !== false,
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))
  const chk = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.checked }))

  const save = async () => {
    if (!form.name.trim()) { toast('El nombre es obligatorio', 'err'); return }
    setSaving(true)
    try {
      const payload = {
        name:           form.name.trim(),
        description:    form.description.trim() || null,
        prefix:         form.prefix.trim() || null,
        roomClass:      form.roomClass ? Number(form.roomClass) : null,
        maxOccupancy:   Number(form.maxOccupancy) || 2,
        ensuite:        form.ensuite,
        allowExtraBeds: Number(form.allowExtraBeds) || 0,
        extraBedPrice:  parseFloat(form.extraBedPrice) || 0,
        defaultPrice:   parseFloat(form.defaultPrice) || 0,
        orderIndex:          Number(form.orderIndex) || 0,
        bookingEngineLabel:         form.bookingEngineLabel.trim() || null,
        maxOccupancyBookingEngine:  form.maxOccupancyBookingEngine ? Number(form.maxOccupancyBookingEngine) : null,
        isVirtual:           form.isVirtual,
        color:               form.color || null,
        backgroundColor:     form.backgroundColor || null,
        fontColor:           form.fontColor || null,
        active:              form.active,
      }
      if (isNew) await api.createRoomType(payload)
      else       await api.updateRoomType(type!.id, payload)
      toast(isNew ? 'Tipo creado' : 'Tipo actualizado')
      onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title={isNew ? 'Nuevo tipo de habitación' : `Editar: ${type!.name}`} onClose={onClose} wide footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
    }>
      <div className="form-grid">
        <div className="form-group">
          <label>Nombre *</label>
          <input value={form.name} onChange={set('name')} placeholder="Doble estándar" />
        </div>
        <div className="form-group">
          <label>Prefijo</label>
          <input value={form.prefix} onChange={set('prefix')} placeholder="DBL" />
        </div>
        <div className="form-group full">
          <label>Descripción</label>
          <input value={form.description} onChange={set('description')} placeholder="Habitación para dos personas…" />
        </div>
        <div className="form-group">
          <label>Capacidad máx.</label>
          <input type="number" min="1" value={form.maxOccupancy} onChange={set('maxOccupancy')} />
        </div>
        <div className="form-group">
          <label>Precio base (€/noche)</label>
          <input type="number" step="0.01" min="0" value={form.defaultPrice} onChange={set('defaultPrice')} />
        </div>
        <div className="form-group">
          <label>Camas extra permitidas</label>
          <input type="number" min="0" value={form.allowExtraBeds} onChange={set('allowExtraBeds')} />
        </div>
        <div className="form-group">
          <label>Precio cama extra (€)</label>
          <input type="number" step="0.01" min="0" value={form.extraBedPrice} onChange={set('extraBedPrice')} />
        </div>
        <div className="form-group">
          <label>Clase FDM</label>
          <input type="number" value={form.roomClass} onChange={set('roomClass')} placeholder="7, 8, 9…" />
        </div>
        <div className="form-group">
          <label>Orden</label>
          <input type="number" min="0" value={form.orderIndex} onChange={set('orderIndex')} />
        </div>
        <div className="form-group full">
          <label>Etiqueta motor de reservas</label>
          <input value={form.bookingEngineLabel} onChange={set('bookingEngineLabel')} placeholder="Habitación doble con vistas al mar" />
        </div>
        <div className="form-group">
          <label>Máx. personas motor de reservas</label>
          <input type="number" min="1" max={Number(form.maxOccupancy) || 10}
            value={form.maxOccupancyBookingEngine}
            onChange={e => {
              const v = e.target.value
              const max = Number(form.maxOccupancy) || 10
              if (v === '' || Number(v) <= max) set('maxOccupancyBookingEngine')(e)
            }}
            placeholder={`— (usa capacidad: ${form.maxOccupancy})`} />
          <span style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3, display: 'block' }}>
            Vacío = sin restricción adicional (se usa la capacidad máx.)
          </span>
        </div>
      </div>
      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 12 }}>
        <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>Colores (planning)</legend>
        <div className="form-grid">
          <div className="form-group">
            <label>Color fondo</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="color" value={form.backgroundColor || '#cccccc'}
                onChange={e => setForm(f => ({ ...f, backgroundColor: e.target.value }))}
                style={{ width: 40, height: 32, padding: 2, border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }} />
              <input value={form.backgroundColor} onChange={set('backgroundColor')} placeholder="#rrggbb" style={{ flex: 1, fontFamily: 'monospace' }} maxLength={7} />
            </div>
          </div>
          <div className="form-group">
            <label>Color texto</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="color" value={form.fontColor || '#333333'}
                onChange={e => setForm(f => ({ ...f, fontColor: e.target.value }))}
                style={{ width: 40, height: 32, padding: 2, border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }} />
              <input value={form.fontColor} onChange={set('fontColor')} placeholder="#rrggbb" style={{ flex: 1, fontFamily: 'monospace' }} maxLength={7} />
            </div>
          </div>
          <div className="form-group">
            <label>Color borde</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="color" value={form.color || '#999999'}
                onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                style={{ width: 40, height: 32, padding: 2, border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }} />
              <input value={form.color} onChange={set('color')} placeholder="#rrggbb" style={{ flex: 1, fontFamily: 'monospace' }} maxLength={7} />
            </div>
          </div>
          {(form.backgroundColor || form.fontColor) && (
            <div className="form-group" style={{ display: 'flex', alignItems: 'center' }}>
              <label>Vista previa</label>
              <span style={{
                display: 'inline-block', padding: '4px 10px', borderRadius: 4,
                background: form.backgroundColor || 'var(--bg3)',
                color: form.fontColor || 'var(--text)',
                border: `2px solid ${form.color || 'var(--border)'}`,
                fontWeight: 600, fontSize: 13,
              }}>{form.name || 'Doble'}</span>
            </div>
          )}
        </div>
      </fieldset>
      <div className="form-grid">
        <div className="form-group" style={{ display: 'flex', gap: 16, paddingTop: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.ensuite} onChange={chk('ensuite')} /> Baño privado
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.isVirtual} onChange={chk('isVirtual')} /> Habitación virtual
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.active} onChange={chk('active')} /> Activo
          </label>
        </div>
      </div>
    </Modal>
  )
}
