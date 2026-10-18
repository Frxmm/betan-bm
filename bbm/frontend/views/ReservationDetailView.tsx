import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { api } from '../lib/api'
import { fmtDate, fmtDateTime, fmtMoney, STATUS_LABEL, toast, addDays, getDays, accountsForMethod } from '../lib/utils'
import { Badge } from '../components/Badge'
import { Modal } from '../components/Modal'
import { useAuth, canManage, canManageReservations } from '../contexts/AuthContext'
import MUNICIPALITIES from '../data/municipalities.json'
import COUNTRIES from '../data/countries.json'
import { printInvoice, fetchInvoiceTemplate } from '../lib/invoicePrint'
import { useProperty } from '../contexts/PropertyContext'
import { AddressAutocomplete } from '../components/AddressAutocomplete'
import { EditTransactionModal } from '../components/EditTransactionModal'
import { RoomChangeReasonField, roomChangeNeedsReason, countReasonWords, MIN_REASON_WORDS } from '../components/RoomChangeReasonField'
import { validateIdDocNumber } from '../lib/idDocValidation'

// Email alias de Booking.com (caduca tras la estancia): hay que sustituirlo
// por el real del cliente antes de guardar o hacer check-in
export function isBookingAlias(email?: string | null): boolean {
  return !!email && /@guest\.booking\.com$/i.test(email.trim())
}

// Hora (HH:MM) de un timestamp — para completar columnas "Fecha" que hoy solo
// muestran el día (transactionDate no lleva hora; el momento real de registro
// está en createdAt).
function fmtTime(d?: string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
}

// Para cruzar nombres de municipio de Google con el catálogo INE
function normalizeTxt(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

type Muni = { code: string; name: string }
type Country = { code: string; code3: string; name: string }
const MUNI_LIST = MUNICIPALITIES as Muni[]

function MunicipalityPicker({ city, ineCode, onChange, onValidChange }: {
  city: string
  ineCode: string
  onChange: (city: string, ineCode: string) => void
  onValidChange?: (valid: boolean) => void
}) {
  const [open, setOpen]       = useState(false)
  const [query, setQuery]     = useState(city)
  const ref                   = useRef<HTMLDivElement>(null)

  useEffect(() => { setQuery(city) }, [city])

  const matches = query.length >= 2
    ? MUNI_LIST.filter(m => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : []

  const pick = (m: Muni) => {
    onChange(m.name, m.code)
    setQuery(m.name)
    setOpen(false)
    onValidChange?.(true)
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        value={query}
        placeholder="Granada"
        onChange={e => { setQuery(e.target.value); onChange(e.target.value, ineCode); setOpen(true); onValidChange?.(false) }}
        onFocus={() => query.length >= 2 && setOpen(true)}
        autoComplete="off"
      />
      {open && matches.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 999, top: '100%', left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.55)', maxHeight: 220, overflowY: 'auto' }}>
          {matches.map(m => (
            <div
              key={m.code}
              onMouseDown={() => pick(m)}
              style={{ padding: '7px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg2)')}
            >
              <span>{m.name}</span>
              <span style={{ color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{m.code}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CountryPicker({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const COUNTRY_LIST = COUNTRIES as Country[]
  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')
  const ref               = useRef<HTMLDivElement>(null)

  const displayValue = COUNTRY_LIST.find(c => c.code === value.toUpperCase())?.name ?? value

  useEffect(() => { setQuery(displayValue) }, [value])

  const matches = query.length >= 1
    ? COUNTRY_LIST.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        c.code.toLowerCase().startsWith(query.toLowerCase())
      ).slice(0, 10)
    : []

  const pick = (c: Country) => {
    onChange(c.code)
    setQuery(c.name)
    setOpen(false)
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        value={query}
        placeholder="España"
        autoComplete="off"
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setQuery(displayValue); setOpen(false) }, 150)}
      />
      {open && matches.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 999, top: '100%', left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.55)', maxHeight: 220, overflowY: 'auto' }}>
          {matches.map(c => (
            <div
              key={c.code}
              onMouseDown={() => pick(c)}
              style={{ padding: '7px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg2)')}
            >
              <span>{c.name}</span>
              <span style={{ color: 'var(--text2)', fontFamily: 'monospace' }}>{c.code3}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── CityPicker ───────────────────────────────────────────────────────────────
// Dos inputs separados: Ciudad (autocomplete) + CP (5 dígitos con autorrelleno)

type PostalHit =
  | { type: 'city';   display: string; cp: string; province: string }
  | { type: 'barrio'; display: string; cp: string; province: string; city: string }

function CityPicker({ city, zipCode, country, onChange, onValidChange }: {
  city: string; zipCode: string; country: string
  onChange: (city: string, zipCode: string) => void
  onValidChange?: (valid: boolean) => void
}) {
  const [cityQuery, setCityQuery] = useState(city)
  const [results,   setResults]   = useState<PostalHit[]>([])
  const [open,      setOpen]      = useState(false)
  const ref   = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setCityQuery(city) }, [city])

  const searchCity = (val: string) => {
    setCityQuery(val)
    onValidChange?.(false)
    if (timer.current) clearTimeout(timer.current)
    if (val.length < 2) { setResults([]); setOpen(false); return }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/postal/cities?q=${encodeURIComponent(val)}`)
        const d = await r.json()
        setResults(d.data ?? [])
        setOpen((d.data?.length ?? 0) > 0)
      } catch { /* ignore */ }
    }, 200)
  }

  const pick = (m: PostalHit) => {
    // Para barrios: la ciudad guardada es la ciudad padre, no el nombre del barrio
    const cityName = m.type === 'barrio' ? m.city : m.display
    setCityQuery(cityName)
    onChange(cityName, m.cp)
    setResults([]); setOpen(false)
    onValidChange?.(true)
  }

  // CP: cuando tiene 5 dígitos, buscar ciudad y rellenar si ciudad está vacía
  const onCpBlur = async (val: string) => {
    if (val.length !== 5) return
    try {
      const r = await fetch(`/api/postal/cp/${val}`)
      if (!r.ok) return
      const d = await r.json()
      if (d.city && !city) {
        setCityQuery(d.city)
        onChange(d.city, val)
        onValidChange?.(true)
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  if (country !== 'ES') {
    return (
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={city} onChange={e => onChange(e.target.value, zipCode)} placeholder="Ciudad" style={{ flex: 1 }} />
        <input value={zipCode} onChange={e => onChange(city, e.target.value)} placeholder="CP" style={{ width: 90 }} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {/* Ciudad con autocomplete */}
      <div ref={ref} style={{ position: 'relative', flex: 1 }}>
        <input
          value={cityQuery}
          onChange={e => searchCity(e.target.value)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Ciudad o barrio…"
          autoComplete="off"
        />
        {open && results.length > 0 && (
          <div style={{ position: 'absolute', zIndex: 999, top: '100%', left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.55)', maxHeight: 220, overflowY: 'auto' }}>
            {results.map((m, i) => (
              <div
                key={`${m.type}-${m.cp}-${m.display}-${i}`}
                onMouseDown={() => pick(m)}
                style={{ padding: '7px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg2)')}
              >
                <span>
                  {m.display}
                  {m.type === 'barrio' && (
                    <span style={{ color: 'var(--text2)', fontSize: 11, marginLeft: 6 }}>— {m.city}</span>
                  )}
                </span>
                <span style={{ display: 'flex', gap: 10, color: 'var(--text2)' }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{m.cp}</span>
                  <span style={{ fontSize: 11 }}>{m.province}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* CP */}
      <input
        value={zipCode}
        onChange={e => {
          const v = e.target.value.replace(/\D/g, '').slice(0, 5)
          onChange(city, v)
        }}
        onBlur={e => onCpBlur(e.target.value)}
        placeholder="CP"
        inputMode="numeric"
        style={{ width: 80 }}
      />
    </div>
  )
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: 'Efectivo', credit_card: 'Tarjeta', bank_transfer: 'Transferencia',
  stripe: 'Stripe', booking_virtual_card: 'Virtual Booking',
  deposit: 'Depósito', other: 'Otro',
  // split_transfer: traspaso interno entre una reserva partida y su
  // continuación (ver POST /reservations/:id/split) — no es un cobro nuevo.
  split_transfer: 'Traspaso por partición',
}
const METHOD_ACCOUNT_HINT: Record<string, string> = {
  cash: 'Caja', credit_card: 'Tarjeta', bank_transfer: 'Transferencia',
  stripe: 'Stripe', booking_virtual_card: 'Tarjeta', deposit: 'Caja', other: '',
}
const BL_SEVERITY_LABEL: Record<string, string> = { low: 'Baja', medium: 'Media', high: 'Alta' }
const BL_SEVERITY_COLOR: Record<string, string> = { low: 'var(--yellow)', medium: 'var(--red)', high: '#ff0000' }

const DOC_TYPE_LABEL: Record<string, string> = {
  dni: 'DNI', nie: 'NIE', passport: 'Pasaporte', driving_licence: 'Carnet', other: 'Otro',
}

function apiErr(data: any, fallback = 'Error'): string {
  if (typeof data?.error === 'string') return data.error
  if (Array.isArray(data?.error?.issues)) return data.error.issues.map((i: any) => i.message).join(', ')
  if (typeof data?.message === 'string') return data.message
  return fallback
}

// Estrellas de valoración del huésped, editables al vuelo (sin modal) — clic
// en una estrella guarda directamente vía PATCH; clic en la ya marcada la
// quita (vuelve a sin valorar). Pensado para que recepción la pueda marcar
// en cualquier momento, no solo al hacer check-out.
function GuestRatingStars({ guestId, value, onChanged }: { guestId: number; value: number | null; onChanged: () => void }) {
  const [saving, setSaving] = useState(false)
  const set = async (n: number) => {
    if (saving) return
    setSaving(true)
    try {
      const r = await fetch(`/api/guests/${guestId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ guestRating: n === value ? null : n }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); toast(apiErr(d, 'Error al guardar la valoración'), 'err'); return }
      onChanged()
    } finally { setSaving(false) }
  }
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(n => (
        <span key={n} onClick={() => set(n)}
          style={{ fontSize: 16, lineHeight: 1, cursor: saving ? 'default' : 'pointer', color: value && n <= value ? '#f59e0b' : 'var(--border)' }}>
          ★
        </span>
      ))}
    </span>
  )
}

const DEPOSIT_METHODS = new Set(['deposit', 'deposit_cc'])

type TabId = 'huesped' | 'transacciones' | 'depositos' | 'facturas' | 'extras' | 'historial'
const TABS: { id: TabId; label: string }[] = [
  { id: 'huesped',       label: 'Huésped' },
  { id: 'transacciones', label: 'Transacciones' },
  { id: 'depositos',     label: 'Depósitos' },
  { id: 'facturas',      label: 'Facturas' },
  { id: 'extras',        label: 'Extras' },
  { id: 'historial',     label: 'Historial' },
]

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="detail-row">
      <span className="k">{k}</span>
      <span className="v">{v == null || v === '' ? '—' : v}</span>
    </div>
  )
}

// ─── Drawer wrapper (modo panel sobre planning) ───────────────────────────────

export function ReservationDrawer({ resId, onClose }: { resId: number; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer-panel">
        <ReservationDetailContent resId={String(resId)} onClose={onClose} />
      </div>
    </>,
    document.body
  )
}

// ─── EditPriceButton ─────────────────────────────────────────────────────────

function EditPriceButton({ res, onApplied }: { res: any; onApplied: () => void }) {
  const [open,  setOpen]  = useState(false)
  const [price, setPrice] = useState('')
  const [saving, setSaving] = useState(false)

  const openModal = () => { setPrice(res.total ?? '0'); setOpen(true) }

  const save = async () => {
    const val = parseFloat(price)
    if (isNaN(val) || val < 0) { toast('Precio inválido', 'err'); return }
    setSaving(true)
    try {
      await api.updateReservation(res.id, { total: val })
      toast('Precio actualizado'); setOpen(false); onApplied()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px' }}
        onClick={openModal}>Editar precio</button>
      {open && (
        <Modal title="Editar precio" onClose={() => setOpen(false)} footer={
          <><button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
        }>
          <div className="form-group">
            <label>Total (€)</label>
            <input type="number" step="0.01" min="0" value={price}
              onChange={e => setPrice(e.target.value)} autoFocus />
          </div>
        </Modal>
      )}
    </>
  )
}

// ─── EditChannelButton (solo admin) ──────────────────────────────────────────

function EditChannelButton({ res, onApplied }: { res: any; onApplied: () => void }) {
  const [open,     setOpen]     = useState(false)
  const [channels, setChannels] = useState<any[]>([])
  const [channelId, setChannelId] = useState('')
  const [saving,   setSaving]   = useState(false)

  const openModal = () => {
    setChannelId(res.bookingChannelId ? String(res.bookingChannelId) : '')
    setOpen(true)
    api.listChannels().then((r: any) => setChannels(r.data)).catch(() => {})
  }

  const save = async () => {
    setSaving(true)
    try {
      await api.updateReservation(res.id, { bookingChannelId: channelId ? Number(channelId) : null })
      toast('Canal actualizado'); setOpen(false); onApplied()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 6 }}
        onClick={openModal}>✎</button>
      {open && (
        <Modal title="Cambiar canal" onClose={() => setOpen(false)} footer={
          <><button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
        }>
          <div className="form-group">
            <label>Canal de reserva</label>
            <select value={channelId} onChange={e => setChannelId(e.target.value)}>
              <option value="">— Sin canal —</option>
              {channels.map((ch: any) => (
                <option key={ch.id} value={ch.id}>{ch.name}</option>
              ))}
            </select>
          </div>
        </Modal>
      )}
    </>
  )
}

// ─── EditRateButton ───────────────────────────────────────────────────────────

function EditRateButton({ res, onApplied }: { res: any; onApplied: () => void }) {
  const [open,   setOpen]   = useState(false)
  const [rates,  setRates]  = useState<any[]>([])
  const [rateId, setRateId] = useState('')
  const [saving, setSaving] = useState(false)

  const openModal = () => {
    setRateId(res.rateId ? String(res.rateId) : '')
    setOpen(true)
    api.listRates().then((r: any) => setRates(r.data)).catch(() => {})
  }

  const save = async () => {
    setSaving(true)
    try {
      await api.updateReservation(res.id, { rateId: rateId ? Number(rateId) : null })
      toast('Tarifa actualizada'); setOpen(false); onApplied()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 6 }}
        onClick={openModal}>✎</button>
      {open && (
        <Modal title="Cambiar tarifa" onClose={() => setOpen(false)} footer={
          <><button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
        }>
          <div className="form-group">
            <label>Tarifa</label>
            <select value={rateId} onChange={e => setRateId(e.target.value)}>
              <option value="">— Sin tarifa —</option>
              {rates.map((r: any) => (
                <option key={r.id} value={r.id}>{r.title}</option>
              ))}
            </select>
          </div>
        </Modal>
      )}
    </>
  )
}

// ─── EditRoomTypeButton (solo dirección) ──────────────────────────────────────
// El campo "Tipo" se calcula del tipo de la habitación asignada (res.room.roomType) —
// no existe como columna propia en la reserva. Cambiarlo de verdad significa
// mover la reserva a otra habitación de ese tipo: aquí se elige el tipo y,
// si hay más de una habitación libre de ese tipo para las fechas, cuál en
// concreto. Solo dirección — recepción sigue teniendo "⇄ Cambiar hab." para
// moverse dentro del mismo tipo o a mano.
function EditRoomTypeButton({ res, onApplied }: { res: any; onApplied: () => void }) {
  const [open,       setOpen]       = useState(false)
  const [loading,    setLoading]    = useState(false)
  const [availRooms, setAvailRooms] = useState<any[]>([])
  const [typeId,     setTypeId]     = useState('')
  const [roomId,     setRoomId]     = useState('')
  const [reason,     setReason]     = useState('')
  const [saving,     setSaving]     = useState(false)

  const openModal = () => {
    setOpen(true); setLoading(true); setTypeId(''); setRoomId(''); setReason('')
    api.availableRoomsForReservation({
      checkIn: res.checkInDate, checkOut: res.checkOutDate, excludeRoomId: res.roomId, includeVirtual: true,
    }).then((r: any) => setAvailRooms(r.data)).catch(() => setAvailRooms([])).finally(() => setLoading(false))
  }

  const roomTypes = [...new Map(
    availRooms.filter(r => r.roomType).map(r => [r.roomTypeId, r.roomType])
  ).values()].sort((a: any, b: any) => a.name.localeCompare(b.name))
  const filtered     = typeId ? availRooms.filter(r => r.roomTypeId === Number(typeId)) : []
  const selectedRoom = availRooms.find(r => r.id === Number(roomId))

  const needsReason = roomChangeNeedsReason(res.status, selectedRoom)
  const reasonOk     = !needsReason || countReasonWords(reason) >= MIN_REASON_WORDS

  const save = async () => {
    if (!selectedRoom) return
    setSaving(true)
    try {
      await api.updateReservation(res.id, { roomId: Number(roomId), ...(needsReason ? { changeReason: reason } : {}) })
      toast(res.roomId ? `Tipo cambiado a ${selectedRoom.roomType?.name} (hab. ${selectedRoom.code})` : `Asignada hab. ${selectedRoom.code} (${selectedRoom.roomType?.name})`)
      setOpen(false); onApplied()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 6 }}
        onClick={openModal}>✎</button>
      {open && (
        <Modal title={res.roomId ? 'Cambiar tipo de habitación' : 'Asignar tipo de habitación'} onClose={() => setOpen(false)} footer={
          <><button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={save} disabled={saving || !roomId || !reasonOk}>Guardar</button></>
        }>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {loading ? (
              <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>Cargando tipos disponibles…</p>
            ) : roomTypes.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>No hay otro tipo con habitación libre para estas fechas</p>
            ) : (
              <>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Nuevo tipo</label>
                  <select value={typeId} onChange={e => { setTypeId(e.target.value); setRoomId('') }} autoFocus>
                    <option value="">— Selecciona tipo —</option>
                    {roomTypes.map((rt: any) => (
                      <option key={rt.id} value={rt.id}>{rt.name}</option>
                    ))}
                  </select>
                </div>
                {typeId && (
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>Habitación</label>
                    {filtered.length === 0
                      ? <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>Sin habitaciones libres de este tipo para estas fechas</p>
                      : (
                        <select value={roomId} onChange={e => setRoomId(e.target.value)}>
                          <option value="">— Selecciona habitación —</option>
                          {filtered.map((r: any) => (
                            <option key={r.id} value={r.id}>Hab. {r.code}</option>
                          ))}
                        </select>
                      )}
                  </div>
                )}
                <RoomChangeReasonField value={reason} onChange={setReason} reservationStatus={res.status} targetRoom={selectedRoom} />
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}

// ─── RecalcPriceButton ────────────────────────────────────────────────────────

// ─── EditCheckOutButton (solo admin, con confirmación) ────────────────────────
// A diferencia de "Ampliar estancia" (que solo suma noches), esto deja fijar
// cualquier fecha de salida — incluida una anterior a la actual — para
// corregir errores. Pasa por el mismo PATCH que ya valida solapamiento y
// registra el cambio en el historial ("Salida: X → Y").

function EditCheckOutButton({ res, onApplied }: { res: any; onApplied: () => void }) {
  const [open,       setOpen]       = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [checkOut,   setCheckOut]   = useState('')
  const [saving,     setSaving]     = useState(false)

  const minDate = addDays(res.checkInDate, 1)
  const changed = checkOut !== res.checkOutDate

  const openModal = () => { setCheckOut(res.checkOutDate); setConfirming(false); setOpen(true) }
  const close     = () => { setOpen(false); setConfirming(false) }

  const save = async () => {
    setSaving(true)
    try {
      await api.updateReservation(res.id, { checkOutDate: checkOut })
      toast('Fecha de salida actualizada'); close(); onApplied()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  if (!open) {
    return (
      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 6 }}
        onClick={openModal}>✎</button>
    )
  }

  if (confirming) {
    return (
      <Modal title="Confirmar cambio de fecha de salida" onClose={() => setConfirming(false)} footer={
        <><button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={saving}>Volver</button>
          <button className="btn btn-red" onClick={save} disabled={saving}>{saving ? 'Guardando…' : 'Sí, cambiar fecha'}</button></>
      }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 14, margin: 0 }}>
            Vas a cambiar la salida de la reserva #{res.id} de <strong>{fmtDate(res.checkOutDate)}</strong> a <strong>{fmtDate(checkOut)}</strong>.
          </p>
          <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>
            Se recalculan las noches y se comprueba que la habitación siga libre en el nuevo rango.
            No ajusta el precio ya calculado ni genera factura — revísalos aparte si hace falta.
          </p>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Editar fecha de salida (admin)" onClose={close} footer={
      <><button className="btn btn-ghost" onClick={close}>Cancelar</button>
        <button className="btn btn-primary" onClick={() => setConfirming(true)} disabled={!changed}>Continuar</button></>
    }>
      <div className="form-group">
        <label>Nueva fecha de salida</label>
        <input type="date" min={minDate} value={checkOut}
          onChange={e => setCheckOut(e.target.value)} autoFocus />
      </div>
    </Modal>
  )
}

// ─── EditExternalCodeButton ───────────────────────────────────────────────────

function EditExternalCodeButton({ res, onApplied }: { res: any; onApplied: () => void }) {
  const [open,   setOpen]   = useState(false)
  const [code,   setCode]   = useState('')
  const [saving, setSaving] = useState(false)

  const openModal = () => { setCode(res.externalCode ?? ''); setOpen(true) }

  const save = async () => {
    setSaving(true)
    try {
      await api.updateReservation(res.id, { externalCode: code.trim() || null })
      toast('Código externo actualizado'); setOpen(false); onApplied()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 6 }}
        onClick={openModal}>✎</button>
      {open && (
        <Modal title="Editar código externo" onClose={() => setOpen(false)} footer={
          <><button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
        }>
          <div className="form-group">
            <label>Código externo</label>
            <input type="text" value={code} onChange={e => setCode(e.target.value)} autoFocus
              placeholder="Booking.com, Airbnb…" />
          </div>
        </Modal>
      )}
    </>
  )
}

function RecalcPriceButton({ res, onApplied }: { res: any; onApplied: () => void }) {
  const [open,      setOpen]      = useState(false)
  const [rates,     setRates]     = useState<any[]>([])
  const [rateId,    setRateId]    = useState<string>(res.rateId ? String(res.rateId) : '')
  const [calcResult, setCalcResult] = useState<{ total: number; nights: number; missingDates: number } | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [applying,  setApplying]  = useState(false)

  const openModal = () => {
    setOpen(true)
    setCalcResult(null)
    setRateId(res.rateId ? String(res.rateId) : '')
    api.listRates().then((r: any) => setRates(r.data)).catch(() => {})
  }

  const calculate = async () => {
    if (!rateId) { toast('Selecciona una tarifa', 'err'); return }
    setLoading(true); setCalcResult(null)
    try {
      const params = new URLSearchParams({
        roomId: String(res.roomId), rateId, checkIn: res.checkInDate, checkOut: res.checkOutDate,
      })
      const r = await fetch(`/api/reservations/calc-price?${params}`, { credentials: 'include' })
      const d = await r.json()
      if (!r.ok) { toast(d.error ?? 'Error', 'err'); return }
      setCalcResult({ total: d.total, nights: d.nights, missingDates: d.missingDates })
    } catch { toast('Error al calcular precio', 'err') }
    finally { setLoading(false) }
  }

  const apply = async () => {
    if (!calcResult) return
    setApplying(true)
    try {
      const updates: any = { total: calcResult.total }
      if (Number(rateId) !== res.rateId) updates.rateId = Number(rateId)
      await api.updateReservation(res.id, updates)
      toast('Total actualizado')
      setOpen(false); onApplied()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setApplying(false) }
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px' }}
        onClick={openModal}>Recalcular</button>
      {open && (
        <Modal title="Recalcular precio" onClose={() => setOpen(false)} footer={
          <>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
            {calcResult
              ? <button className="btn btn-primary" onClick={apply} disabled={applying}>Aplicar {calcResult.total.toFixed(2)} €</button>
              : <button className="btn btn-primary" onClick={calculate} disabled={loading || !rateId}>{loading ? 'Calculando…' : 'Calcular precio'}</button>
            }
          </>
        }>
          <div className="form-grid">
            <div className="form-group full">
              <label>Tarifa</label>
              <select value={rateId} onChange={e => { setRateId(e.target.value); setCalcResult(null) }}>
                <option value="">— Selecciona tarifa —</option>
                {rates.map((r: any) => (
                  <option key={r.id} value={r.id}>
                    {r.title}{r.id === res.rateId ? ' (actual)' : ''}
                  </option>
                ))}
              </select>
            </div>
            {calcResult && (
              <div className="form-group full" style={{ background: 'var(--bg2)', borderRadius: 8, padding: 12, marginBottom: 0 }}>
                <div style={{ fontSize: 13, marginBottom: 4 }}>Precio calculado del mapa de precios:</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)' }}>{calcResult.total.toFixed(2)} €</div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                  {calcResult.nights} noche{calcResult.nights !== 1 ? 's' : ''}
                  {calcResult.missingDates > 0 && (
                    <span style={{ color: 'var(--warn, #f59e0b)', marginLeft: 8 }}>
                      ⚠ {calcResult.missingDates} noche{calcResult.missingDates !== 1 ? 's' : ''} sin precio en el mapa
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
                  Total actual: {fmtMoney(res.total)} €
                  {Number(rateId) !== res.rateId && rates.find((r: any) => String(r.id) === rateId) && (
                    <span style={{ marginLeft: 8 }}>· Se cambiará la tarifa a <strong>{rates.find((r: any) => String(r.id) === rateId)?.title}</strong></span>
                  )}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}

// ─── ProformaButton ───────────────────────────────────────────────────────────

function ProformaButton({ res, due }: { res: any; due: number }) {
  const { property } = useProperty()
  const [open,   setOpen]   = useState(false)
  const [amount, setAmount] = useState('')
  const [busy,   setBusy]   = useState(false)

  // due ya viene calculado sin contar los depósitos retenidos sin cobrar
  // como pago de la estancia (mismo criterio que usa el backend al generar
  // la proforma — ver src/lib/paymentAggregate.ts).
  const pending = Math.max(0, due)

  const print = async () => {
    setBusy(true)
    try {
      const body: any = {}
      if (amount !== '') body.amount = parseFloat(amount)
      const r = await fetch(`/api/financial/invoices/proforma/${res.id}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) { toast(d.error ?? 'Error', 'err'); return }
      const template = await fetchInvoiceTemplate()
      printInvoice(d.data, template, property)
      setOpen(false); setAmount('')
    } catch { toast('Error al generar proforma', 'err') }
    finally { setBusy(false) }
  }

  return (
    <>
      <button className="btn btn-ghost" onClick={() => setOpen(true)}>Proforma</button>
      {open && (
        <Modal title="Factura proforma" onClose={() => { setOpen(false); setAmount('') }} footer={
          <><button className="btn btn-ghost" onClick={() => { setOpen(false); setAmount('') }}>Cancelar</button>
            <button className="btn btn-primary" onClick={print} disabled={busy}>Imprimir proforma</button></>
        }>
          <div className="form-grid">
            <div className="form-group full">
              <label>
                Importe (€)
                <span style={{ fontWeight: 400, color: 'var(--text2)', fontSize: 12, marginLeft: 8 }}>
                  pendiente: {fmtMoney(String(pending))}
                </span>
              </label>
              <input
                type="number" step="0.01" min="0.01"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder={pending > 0 ? pending.toFixed(2) : '0.00'}
                autoFocus
              />
              <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                Deja vacío para usar el saldo pendiente ({fmtMoney(String(pending))}).
              </p>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

// ─── NewInvoiceButton ─────────────────────────────────────────────────────────
// Crea una factura nueva (puede haber varias por reserva). El importe nunca
// puede superar lo pendiente de facturar: Total pagado (pagos + depósitos ya
// cobrados) menos lo ya facturado (suma de facturas existentes, que ya
// descuenta sola las rectificativas porque se guardan en negativo). El backend
// vuelve a validar este tope de todas formas (ver /invoices/from-reservation/:id).

function NewInvoiceButton({ res, totalPaid, invoices, onDone }: { res: any; totalPaid: number; invoices: any[]; onDone: () => void }) {
  const { property } = useProperty()
  const [open,   setOpen]   = useState(false)
  const [amount, setAmount] = useState('')
  const [busy,   setBusy]   = useState(false)

  const totalInvoiced = invoices.reduce((s: number, i: any) => s + parseFloat(i.total ?? '0'), 0)
  const remaining      = Math.max(0, Math.round((totalPaid - totalInvoiced) * 100) / 100)
  const amountNum       = amount !== '' ? parseFloat(amount) : null
  const overLimit       = amountNum !== null && amountNum > remaining + 0.01

  const create = async () => {
    if (overLimit) return
    setBusy(true)
    try {
      const body: any = {}
      if (amount !== '') body.amount = parseFloat(amount)
      const r = await fetch(`/api/financial/invoices/from-reservation/${res.id}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) { toast(d.error ?? 'Error', 'err'); return }
      toast(`Factura ${d.data.invoiceNumber} creada`)
      const [template, { data: full }] = await Promise.all([
        fetchInvoiceTemplate(),
        api.getInvoice(d.data.id) as Promise<any>,
      ])
      printInvoice(full, template, property)
      setOpen(false); setAmount('')
      onDone()
    } catch (e: any) { toast(e.message ?? 'Error al crear factura', 'err') }
    finally { setBusy(false) }
  }

  return (
    <>
      <button
        className="btn btn-primary"
        onClick={() => setOpen(true)}
        disabled={remaining <= 0}
        title={remaining <= 0 ? 'No hay importe pendiente de facturar' : undefined}
      >+ Nueva factura</button>
      {open && (
        <Modal title="Nueva factura" onClose={() => { setOpen(false); setAmount('') }} footer={
          <><button className="btn btn-ghost" onClick={() => { setOpen(false); setAmount('') }}>Cancelar</button>
            <button className="btn btn-primary" onClick={create} disabled={busy || overLimit}>Crear factura</button></>
        }>
          <div className="form-grid">
            <div className="form-group full">
              <label>
                Importe (€)
                <span style={{ fontWeight: 400, color: 'var(--text2)', fontSize: 12, marginLeft: 8 }}>
                  pendiente de facturar: {fmtMoney(String(remaining))}
                </span>
              </label>
              <input
                type="number" step="0.01" min="0.01" max={remaining}
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder={remaining > 0 ? remaining.toFixed(2) : '0.00'}
                autoFocus
              />
              {overLimit ? (
                <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>
                  No puede superar lo pendiente de facturar ({fmtMoney(String(remaining))}).
                </p>
              ) : (
                <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                  Deja vacío para facturar todo lo pendiente ({fmtMoney(String(remaining))}).
                </p>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

// ─── Vista principal ──────────────────────────────────────────────────────────

export default function ReservationDetailView() {
  const { id } = useParams<{ id: string }>()
  return <ReservationDetailContent resId={id ?? ''} />
}

// Evalúa si el usuario puede editar un campo de reserva según las reglas configuradas.
// Admin/dirección siempre puede; para otros roles se comprueba la regla del campo.
function canEditField(fieldKey: string, user: ReturnType<typeof useAuth>['user'], channelId: number | null | undefined, rules: any[]): boolean {
  if (canManage(user)) return true
  const rule = rules.find((r: any) => r.fieldKey === fieldKey)
  if (!rule) return false
  const allowedRoles: string[]  = rule.allowedRoles ?? []
  const allowedIds:   number[]  = rule.allowedChannelIds ?? []
  if (allowedRoles.length === 0) return false
  const hasRole = (user?.roles ?? []).some((r: string) => allowedRoles.includes(r))
  if (!hasRole) return false
  return allowedIds.length === 0 || (channelId != null && allowedIds.includes(channelId))
}

function ReservationDetailContent({ resId, onClose }: { resId: string; onClose?: () => void }) {
  const { property } = useProperty()
  const navigate = useNavigate()
  const location = useLocation()
  const goBack   = () => onClose ? onClose() : location.key !== 'default' ? navigate(-1) : navigate('/reservations')
  const { user } = useAuth()
  const isAdmin  = canManage(user)
  const checkinStartRef  = useRef<string | null>(null)
  const checkinSkipRef   = useRef<{ zkteco?: string; ses?: string; contract?: string }>({})
  const [fieldRules, setFieldRules] = useState<any[]>([])
  const [res,      setRes]      = useState<any>(null)
  const [tab,      setTab]      = useState<TabId>('huesped')
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  // Tab data
  const [deleting,  setDeleting]  = useState(false)
  const [payments,  setPayments]  = useState<any[]>([])
  const [deposits,  setDeposits]  = useState<any[]>([])
  const [accounts,  setAccounts]  = useState<any[]>([])
  const [invoices,      setInvoices]      = useState<any[]>([])
  const [editingInvoice,  setEditingInvoice]  = useState<any | null>(null)
  const [editingPayment,  setEditingPayment]  = useState<any | null>(null)
  const [editingDescriptionTx, setEditingDescriptionTx] = useState<any | null>(null)
  const [correctingTx,    setCorrectingTx]    = useState<any | null>(null)
  const [extras,    setExtras]    = useState<any[]>([])
  const [history,   setHistory]   = useState<any[]>([])
  const [contracts, setContracts] = useState<any[]>([])

  // Acciones asíncronas
  const [lockLoading,      setLockLoading]      = useState(false)
  const [showEarlyModal,   setShowEarlyModal]   = useState(false)
  const [earlyComment,     setEarlyComment]     = useState('')
  const [zktecoLoading,     setZktecoLoading]     = useState(false)
  const [showZktecoDetails, setShowZktecoDetails] = useState(false)
  const [sesLoading,        setSesLoading]        = useState(false)

  // Modals
  const [zktecoConfigured,     setZktecoConfigured]     = useState(false)
  const [showZktecoReason,     setShowZktecoReason]     = useState(false)
  const [zktecoReasonText,     setZktecoReasonText]     = useState('')
  const [showSesReason,        setShowSesReason]        = useState(false)
  const [sesReasonText,        setSesReasonText]        = useState('')
  const [showContractReason,   setShowContractReason]   = useState(false)
  const [contractReasonText,   setContractReasonText]   = useState('')
  const [showCheckoutRating,   setShowCheckoutRating]   = useState(false)
  const [checkoutRating,       setCheckoutRating]       = useState(0)

  const [showNote,          setShowNote]          = useState(false)
  const [showContract,      setShowContract]      = useState(false)
  const [showPayment,       setShowPayment]        = useState(false)
  const [showDeposit,       setShowDeposit]        = useState(false)
  const [cobrarDeposit,     setCobrarDeposit]      = useState<any>(null)
  const [showBlacklist,     setShowBlacklist]      = useState(false)
  const [showExtra,         setShowExtra]          = useState(false)
  const [showEditGuest,     setShowEditGuest]      = useState(false)
  const [showAddGuest,      setShowAddGuest]       = useState(false)
  const [showChangeTitular, setShowChangeTitular]  = useState(false)
  const [showFeedback,      setShowFeedback]      = useState(false)
  const [editingAdditional, setEditingAdditional]  = useState<any>(null)
  const [showExtend,        setShowExtend]         = useState(false)
  const [showChangeRoom,    setShowChangeRoom]     = useState(false)
  const [showChangeStatus,  setShowChangeStatus]   = useState(false)
  const [showSplit,         setShowSplit]          = useState(false)
  const [showAddExtraRoom,  setShowAddExtraRoom]   = useState(false)
  const [extraRoomDetails,  setExtraRoomDetails]   = useState<any[]>([])
  const [guestSort,         setGuestSort]          = useState<{ by: 'name' | 'room'; dir: 1 | -1 } | null>(null)
  // Quitar una habitación extra exige motivo (min. 5 palabras) — pasa por
  // este modal en vez de quitarla directamente (ver removeExtraRoom).
  const [removeExtraRoomModal, setRemoveExtraRoomModal] = useState<{ roomId: number; code: string } | null>(null)
  // Cancelar exige motivo (min. 10 palabras) salvo para admin/dirección —
  // pasa por este modal en vez de un simple confirm() (ver doCancel).
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [checkinMenuOpen,   setCheckinMenuOpen]    = useState(false)
  const checkinMenuRef = useRef<HTMLDivElement>(null)
  const [paymentMenuOpen,   setPaymentMenuOpen]    = useState(false)
  const paymentMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (checkinMenuRef.current && !checkinMenuRef.current.contains(e.target as Node)) setCheckinMenuOpen(false)
      if (paymentMenuRef.current && !paymentMenuRef.current.contains(e.target as Node)) setPaymentMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    api.getFieldRules().then((r: any) => setFieldRules(r.data ?? [])).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    if (!resId) return
    setLoading(true); setError(null)
    try {
      const [{ data: r }, txRes, acRes, invRes, extRes, histRes, ctrRes]: any[] = await Promise.all([
        api.getReservation(Number(resId)),
        fetch(`/api/financial/transactions?reservationId=${resId}&includeDeposits=1`).then(r => r.json()),
        fetch('/api/financial/accounts').then(r => r.json()),
        fetch(`/api/financial/invoices?reservationId=${resId}`).then(r => r.json()),
        fetch(`/api/reservations/${resId}/extras`).then(r => r.json()),
        fetch(`/api/reservations/${resId}/history`).then(r => r.json()),
        api.listContracts(Number(resId)),
      ])
      setRes(r)
      const allTx = txRes?.data ?? []
      setPayments(allTx.filter((p: any) => !DEPOSIT_METHODS.has(p.paymentMethod)))
      setDeposits(allTx.filter((p: any) =>  DEPOSIT_METHODS.has(p.paymentMethod)))
      setAccounts(acRes?.data ?? [])
      setInvoices(invRes?.data ?? [])
      setExtras(extRes?.data ?? [])
      setHistory(histRes?.data ?? [])
      setContracts((ctrRes as any)?.data ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [resId])

  useEffect(() => { load() }, [load])

  // Solo refresca el historial (pestaña Historial) sin tocar el resto — para
  // acciones que ya se reflejan solas en pantalla con una actualización local
  // (ver moveAdditionalGuestRoom, removeExtraRoom, AddExtraRoomModal) y no
  // necesitan el "Cargando…" completo de load().
  const refreshHistory = useCallback(() => {
    if (!resId) return
    fetch(`/api/reservations/${resId}/history`).then(r => r.json()).then(d => setHistory(d?.data ?? [])).catch(() => {})
  }, [resId])

  useEffect(() => {
    fetch('/api/zkteco/status', { credentials: 'include' })
      .then(r => r.json()).then(d => setZktecoConfigured(!!d.configured)).catch(() => {})
  }, [])

  // Polling para detectar tarjeta ZKTeco enrollada sin recarga manual
  useEffect(() => {
    if (!res) return
    const todayMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date())
    const isDuringStay = res.checkInDate <= todayMadrid && todayMadrid <= res.checkOutDate
    const hasActiveCard = !!(res as any).zktecoCardNo && !(res as any).zktecoCardRevokedAt
    if (!isDuringStay || hasActiveCard) return
    const timer = setInterval(async () => {
      try {
        const { data: fresh }: any = await api.getReservation(Number(resId))
        if (fresh?.zktecoCardNo && !fresh?.zktecoCardRevokedAt) setRes(fresh)
      } catch { /* silencioso */ }
    }, 5_000)
    return () => clearInterval(timer)
  }, [res?.checkInDate, res?.checkOutDate, !!(res as any)?.zktecoCardNo, !!(res as any)?.zktecoCardRevokedAt, resId])

  useEffect(() => {
    const ids: number[] = res?.extraRoomIds ?? []
    if (!ids.length) { setExtraRoomDetails([]); return }
    api.listRooms().then((r: any) => {
      setExtraRoomDetails(r.data.filter((rm: any) => ids.includes(rm.id)))
    }).catch(() => {})
  }, [res?.extraRoomIds])

  if (loading) return <div className="loading">Cargando…</div>
  if (error)   return <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>
  if (!res)    return null

  const g           = res.guest ?? {}
  const cobradosSum = deposits
    .filter((p: any) => p.category === 'deposit_cobrado')
    .reduce((s: number, p: any) => s + parseFloat(p.amount ?? '0'), 0)
  const totalPaid   = payments.reduce((s: number, p: any) => s + parseFloat(p.amount ?? '0'), 0) + cobradosSum
  const due         = parseFloat(res.total ?? '0') - totalPaid
  const isBlacklisted = !!g.blacklistReason

  const additionalGuests: any[] = (() => {
    const seen = new Set<number>()
    if (g.id) seen.add(g.id)
    const out: any[] = []
    for (const night of res.nightRows ?? []) {
      if (night.guest && !seen.has(night.guest.id)) {
        seen.add(night.guest.id)
        // roomId de su primera noche — todas sus noches comparten habitación
        // salvo que se reasigne (moveAdditionalGuestRoom, actualiza todas a la vez).
        out.push({ ...night.guest, roomId: night.roomId })
      }
    }
    return out
  })()

  // Reserva de grupo = tiene habitaciones extra además de la principal —
  // solo entonces tiene sentido elegir en cuál va cada huésped adicional.
  const isGroupReservation = extraRoomDetails.length > 0
  const groupRooms: any[] = [res.room, ...extraRoomDetails].filter(Boolean)
  const roomCodeById = new Map(groupRooms.map((r: any) => [r.id, r.code]))
  const lockedRoomIds: number[] = res.lockedRoomIds ?? []

  const toggleGuestSort = (by: 'name' | 'room') =>
    setGuestSort(s => s?.by === by ? { by, dir: s.dir === 1 ? -1 : 1 } : { by, dir: 1 })

  const sortedAdditionalGuests = guestSort ? [...additionalGuests].sort((a, b) => {
    const va = guestSort.by === 'name' ? `${a.lastName} ${a.firstName}` : (roomCodeById.get(a.roomId) ?? '')
    const vb = guestSort.by === 'name' ? `${b.lastName} ${b.firstName}` : (roomCodeById.get(b.roomId) ?? '')
    return va.localeCompare(vb, 'es', { numeric: true }) * guestSort.dir
  }) : additionalGuests
  const sortArrow = (by: 'name' | 'room') => guestSort?.by === by ? (guestSort.dir === 1 ? ' ▲' : ' ▼') : ''

  const primaryMaxOccupancy: number | null = (res.room as any)?.roomType?.maxOccupancy ?? null
  // Extra rooms contribute their full capacity (titular is in primary room)
  const totalMaxOccupancy: number | null = primaryMaxOccupancy !== null
    ? primaryMaxOccupancy + extraRoomDetails.reduce((s: number, r: any) => s + (r?.roomType?.maxOccupancy ?? 0), 0)
    : null
  const maxOccupancy = totalMaxOccupancy
  const atCapacity = totalMaxOccupancy !== null && (additionalGuests.length + 1) >= totalMaxOccupancy

  // Sincroniza res.people con el número real de huéspedes registrados
  const syncPeople = async (expectedTotal: number) => {
    if (res.people === expectedTotal) return
    try {
      await api.updateReservation(res.id, { people: expectedTotal })
    } catch { /* silencioso — no bloquea la operación principal */ }
  }

  const removeAdditionalGuest = async (guestId: number) => {
    // additionalGuests tiene el estado ANTES de borrar, así que el total correcto es length (= length+1 - 1)
    const resultingTotal = Math.max(1, additionalGuests.length)
    const msg = (res.people === 2 && resultingTotal === 1)
      ? '¿Seguro que solo se va a hospedar 1 persona en esta habitación? Se quitará al segundo huésped de la reserva.'
      : '¿Quitar este huésped de la reserva?'
    if (!confirm(msg)) return
    try {
      const r = await fetch(`/api/reservations/${res.id}/guests/${guestId}`, { method: 'DELETE' })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Error')
      await syncPeople(resultingTotal)
      toast('Huésped eliminado'); load()
      window.dispatchEvent(new CustomEvent('reservation:changed'))
    } catch (e: any) { toast(e.message, 'err') }
  }

  // Marca/desmarca una habitación de la reserva como "cerrada" — ya no se
  // puede mover a otros huéspedes de la misma reserva a ella (ver también la
  // comprobación real en el backend, PATCH /:id/guests/:guestId/room).
  const toggleRoomLock = async (roomId: number) => {
    const next = lockedRoomIds.includes(roomId)
      ? lockedRoomIds.filter(id => id !== roomId)
      : [...lockedRoomIds, roomId]
    try {
      await api.updateReservation(res.id, { lockedRoomIds: next } as any)
      setRes((prev: any) => prev && ({ ...prev, lockedRoomIds: next }))
    } catch (e: any) { toast(e.message, 'err') }
  }

  // Solo aplica en reservas de grupo (con habitaciones adicionales): mueve a
  // un huésped ya añadido a otra habitación del mismo grupo.
  const moveAdditionalGuestRoom = async (guestId: number, roomId: number) => {
    try {
      const r = await fetch(`/api/reservations/${res.id}/guests/${guestId}/room`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Error')
      toast('Huésped movido de habitación')
      // Actualización local en vez de recargar toda la reserva (load()) — eso
      // ponía la pantalla entera en "Cargando…" y perdía el sitio donde
      // estabas. Solo se tocan las noches de este huésped en memoria.
      const newRoom = groupRooms.find((rm: any) => rm.id === roomId)
      setRes((prev: any) => prev && ({
        ...prev,
        nightRows: (prev.nightRows ?? []).map((n: any) =>
          n.guestId === guestId ? { ...n, roomId, roomTypeId: newRoom?.roomTypeId ?? n.roomTypeId, room: newRoom ?? n.room } : n
        ),
      }))
      refreshHistory()
      // Planning tiene su propia copia de las reservas (con additionalGuests
      // por habitación) — sin este aviso, sus barras seguían mostrando el
      // nombre antiguo hasta cerrar y reabrir el cajón.
      window.dispatchEvent(new CustomEvent('reservation:changed'))
    } catch (e: any) { toast(e.message, 'err') }
  }

  const guestAddressComplete = (gu: any) =>
    !!(gu.address1 && gu.zipCode && gu.city &&
      (gu.addressCountryCode !== 'ES' || gu.cityIneCode))

  // Marca el inicio del check-in la primera vez que se entra al flujo (abrir el
  // formulario de huésped o pulsar "Hacer check-in"). Se guarda tanto en el ref
  // local (fallback inmediato) como en BD vía /checkin-start — el ref en memoria
  // se pierde si se recarga la página o se navega fuera y se vuelve, lo que antes
  // hacía que el tiempo medido fuera básicamente ruido (arrancaba de cero al
  // volver, o se quedaba fijado horas si la pestaña se dejaba abierta). Guardarlo
  // en BD en cuanto se entra al flujo hace que sobreviva a eso.
  const markCheckinStarted = () => {
    if (checkinStartRef.current) return
    checkinStartRef.current = new Date().toISOString()
    api.logCheckinStart(res.id).catch(() => {})
  }

  const openEditGuestForCheckin = () => {
    markCheckinStarted()
    setShowEditGuest(true)
  }

  const abandonCheckin = async () => {
    const today = new Date().toISOString().slice(0, 10)
    if (res.checkInDate !== today) return
    await fetch(`/api/reservations/${res.id}/checkin-abandon`, { method: 'POST', credentials: 'include' }).catch(() => {})
  }

  const doCheckInExecute = async () => {
    const skip = checkinSkipRef.current
    try {
      const r: any = await api.checkIn(res.id, { checkinStartedAt: checkinStartRef.current ?? undefined })
      const notes = [
        skip.zkteco   && `⚠️ Check-in sin tarjeta ZKTeco. Motivo: ${skip.zkteco}`,
        skip.ses      && `⚠️ Check-in sin enviar SES Hospedajes. Motivo: ${skip.ses}`,
        skip.contract && `⚠️ Check-in sin contrato firmado. Motivo: ${skip.contract}`,
      ].filter(Boolean) as string[]
      for (const note of notes) await api.addNote(res.id, note)
      checkinSkipRef.current = {}
      if (r?.autoEnrolledFromReservationId) {
        toast(`Check-in realizado — tarjeta ZKTeco reutilizada de la reserva #${r.autoEnrolledFromReservationId} (mismo huésped, entrada consecutiva)`)
      } else {
        toast('Check-in realizado')
      }
      load()
    }
    catch (e: any) { toast(e.message, 'err') }
  }

  const doCheckInFinal = async () => {
    // Contrato: si hay contratos y ninguno firmado, bloquear con motivo
    let contractSigned = true
    try {
      const contracts = await api.listContracts(res.id)
      if (contracts.data.length > 0 && !contracts.data.some((ct: any) => ct.status === 'signed')) {
        contractSigned = false
      }
    } catch { /* sin contratos, continuar */ }

    if (!contractSigned && !checkinSkipRef.current.contract) {
      setShowContractReason(true)
      return
    }
    await doCheckInExecute()
  }

  const doCheckIn = async () => {
    const today = new Date().toISOString().slice(0, 10)
    if (today < res.checkInDate || today > res.checkOutDate) return
    // Capturar el momento del primer intento de check-in para medir el tiempo real
    markCheckinStarted()

    if (isBookingAlias(res.guest?.email)) {
      toast('El huésped tiene el email temporal de Booking — regístrale su email real antes del check-in', 'err')
      openEditGuestForCheckin()
      return
    }
    // Depósito obligatorio: al menos un registro en la pestaña "Depósitos" que
    // no esté ya devuelto (misma comprobación que hace el backend al confirmar).
    const hasActiveDeposit = deposits.some((p: any) =>
      p.category !== 'deposit_return' &&
      !deposits.some((d: any) => d.category === 'deposit_return' && d.description === `dep:${p.id}`)
    )
    if (!hasActiveDeposit) {
      toast('No hay ningún depósito registrado — añádelo antes del check-in', 'err')
      setTab('depositos')
      return
    }
    // Datos obligatorios para SES — se comprueban en el SERVIDOR para TODOS
    // los huéspedes (titular + adicionales), no solo el titular (sesMissing,
    // más abajo, solo mira al titular y por eso se colaban adicionales sin
    // segundo apellido, DNI o nº de soporte). Mismo endpoint que usa el botón
    // "Validar" de la pestaña SES — una sola fuente de verdad.
    try {
      const sesR = await fetch(`/api/ses/validate/${res.id}`, { credentials: 'include' })
      const sesD = await sesR.json()
      if (!sesD.data?.valid) {
        const msg = (sesD.data?.errors ?? []).map((e: any) => `${e.field}: ${e.message}`).join(' · ') || 'Datos incompletos para SES'
        toast(`Faltan datos obligatorios para SES: ${msg}`, 'err')
        openEditGuestForCheckin()
        return
      }
    } catch (e: any) {
      toast('No se pudo comprobar los datos para SES — inténtalo de nuevo', 'err')
      return
    }
    const allGuests = [g, ...additionalGuests]
    const incomplete = allGuests.filter(gu => !guestAddressComplete(gu))
    if (incomplete.length > 0) {
      const names = incomplete.map((gu: any) => `${gu.firstName ?? ''} ${gu.lastName ?? ''}`.trim() || `Huésped #${gu.id}`).join(', ')
      toast(`Dirección incompleta en: ${names}. Rellena calle, CP, municipio e INE antes del check-in.`, 'err')
      openEditGuestForCheckin()
      return
    }
    checkinSkipRef.current = {}
    if (zktecoConfigured && !hasActiveZktecoCard) {
      // Revalidar contra el servidor — el card puede haberse enrollado
      // dentro de la ventana de polling (< 5 seg) antes de que el estado local se actualizara
      try {
        const { data: fresh }: any = await api.getReservation(Number(resId))
        if (fresh?.zktecoCardNo && !fresh?.zktecoCardRevokedAt) {
          setRes(fresh)
          // tarjeta ya enrollada: continuar sin mostrar la advertencia
        } else {
          setShowZktecoReason(true)
          return
        }
      } catch {
        setShowZktecoReason(true)
        return
      }
    }
    const sesSent = !!(res as any).sesSubmittedAt
    if (!sesSent) {
      setShowSesReason(true)
      return
    }
    await doCheckInFinal()
  }
  const doCheckOut = async () => {
    // Depósitos con dinero de por medio (efectivo/preauth CC) deben quedar
    // cobrados o devueltos antes de salir — 'deposit_card' (solo datos, sin
    // importe) no cuenta, no hay nada que resolver. Misma comprobación que el backend.
    const hasUnresolvedDeposit = deposits.some((p: any) =>
      p.category !== 'deposit_return' && p.category !== 'deposit_cobrado' && p.category !== 'deposit_card' &&
      !deposits.some((d: any) => d.category === 'deposit_return' && d.description === `dep:${p.id}`)
    )
    if (hasUnresolvedDeposit) {
      toast('Hay depósitos sin cobrar ni devolver — resuélvelos antes del check-out', 'err')
      setTab('depositos')
      return
    }
    setCheckoutRating(0)
    setShowCheckoutRating(true)
  }

  const confirmCheckOut = async () => {
    try {
      await api.checkOut(res.id, { guestRating: checkoutRating || undefined })
      setShowCheckoutRating(false)
      toast('Check-out realizado'); load()
    } catch (e: any) { toast(e.message, 'err') }
  }
  const doCancel = async () => {
    // Admin/dirección: cancelación directa, sin motivo obligatorio (igual
    // que siempre). Recepción: motivo de 10 palabras vía CancelReservationModal,
    // y ni eso si la reserva ya está checked_in (lo exige también el backend).
    if (!isAdmin) { setShowCancelModal(true); return }
    if (!confirm('¿Cancelar esta reserva?')) return
    try { await api.cancelReservation(res.id); toast('Reserva cancelada'); goBack() }
    catch (e: any) { toast(e.message, 'err') }
  }
  const doCancelWithReason = async (reason: string) => {
    try { await api.cancelReservation(res.id, { changeReason: reason }); toast('Reserva cancelada'); goBack() }
    catch (e: any) { toast(e.message, 'err') }
  }
  // Deshacer la última ampliación (solo mientras siga sin cobrar — ver
  // canUndoExtension más abajo y la comprobación igual en el backend).
  const doUndoExtension = async () => {
    const p = res.pendingExtension
    if (!p) return
    const hadCode = !!(res as any).ttlockCode
    const hadCard = !!(res as any).zktecoCardBe
    const lockWarning = (hadCode || hadCard)
      ? ` Se regenerará ${hadCode && hadCard ? 'el código de la cerradura y la tarjeta' : hadCode ? 'el código de la cerradura' : 'la tarjeta'} para la ventana más corta — lo anterior dejará de funcionar y no se puede recuperar.`
      : ''
    if (!confirm(`¿Deshacer la última ampliación? La salida volverá a ${fmtDate(p.prevCheckOutDate)} y el total a ${fmtMoney(p.prevTotal)}.${lockWarning}`)) return
    try {
      await api.undoExtension(res.id)

      // Igual que al ampliar (ExtendReservationModal): si había código o
      // tarjeta TTLock, hay que regenerarlos para la ventana más corta —
      // el código anterior ya no vale, así que hace falta dar el nuevo.
      let newCode: string | null = null
      let codeError: string | null = null
      let cardError: string | null = null
      if (hadCode) {
        try {
          const r = await fetch(`/api/ttlock/generate/${res.id}`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          })
          const d = await r.json()
          if (r.ok) newCode = (d.data.entries ?? []).map((e: any) => `${e.room}: ${e.code}#`).join(' · ')
          else codeError = d.error ?? 'Error'
        } catch { codeError = 'Error de conexión' }
      }
      if (hadCard) {
        try {
          const r = await fetch(`/api/ttlock/reenroll-card/${res.id}`, { method: 'POST', credentials: 'include' })
          const d = await r.json()
          if (!r.ok || (d.data?.attempted && !d.data.ok)) cardError = d.error ?? d.data?.error ?? 'Error'
        } catch { cardError = 'Error de conexión' }
      }

      if (newCode) {
        toast(`El código de la cerradura ha cambiado. Proporciona el nuevo al cliente: ${newCode}`, 'err')
      } else if (codeError) {
        toast(`Ampliación deshecha, pero no se pudo regenerar el código TTLock: ${codeError}`, 'err')
      } else {
        toast('Ampliación deshecha')
      }
      if (cardError) {
        toast(`Aviso: no se pudo re-enrolar la tarjeta del huésped tras deshacer la ampliación: ${cardError}`, 'err')
      }
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }
  const doRevertCheckIn = async () => {
    if (!confirm('¿Revertir la reserva a checked-in?')) return
    try {
      const r = await fetch(`/api/reservations/${res.id}/revert-checkin`, { method: 'POST', credentials: 'include' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error')
      toast('Reserva revertida a checked-in'); load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  // Quitar una habitación extra exige motivo (min. 5 palabras, ver el
  // servidor) — pasa por un modal en vez de quitarla directamente.
  const removeExtraRoom = async (roomId: number, reason: string) => {
    try {
      const ids = (res.extraRoomIds ?? []).filter((id: number) => id !== roomId)
      await api.updateReservation(res.id, { extraRoomIds: ids, changeReason: reason } as any)
      toast('Habitación adicional eliminada')
      // Local en vez de load() completo — extraRoomDetails se refresca solo
      // (efecto sobre res.extraRoomIds), sin poner la pantalla en "Cargando…".
      setRes((prev: any) => prev && ({ ...prev, extraRoomIds: ids }))
      refreshHistory()
      window.dispatchEvent(new CustomEvent('reservation:changed'))
    } catch (e: any) { toast(e.message, 'err') }
  }

  const waSend = async (kind: 'checkin' | 'payment') => {
    try {
      const r = await fetch(`/api/whatsapp/${kind}/${res.id}`, { method: 'POST', credentials: 'include' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error enviando WhatsApp')
      toast(kind === 'checkin' ? 'Enlace de check-in enviado por WhatsApp' : 'Recordatorio de pago enviado por WhatsApp')
    } catch (e: any) { toast(e.message, 'err') }
  }

  const sendCheckinEmail = async () => {
    try {
      const r = await fetch(`/api/reservations/${res.id}/checkin-email`, { method: 'POST', credentials: 'include' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error enviando email')
      toast('Enlace de check-in enviado por email')
    } catch (e: any) { toast(e.message, 'err') }
  }

  const sendPaymentEmail = async () => {
    try {
      const r = await fetch(`/api/reservations/${res.id}/payment-email`, { method: 'POST', credentials: 'include' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error enviando email')
      toast('Recordatorio de pago enviado por email')
    } catch (e: any) { toast(e.message, 'err') }
  }

  const doWhatsappLock = async () => {
    setLockLoading(true)
    try {
      const r = await fetch(`/api/ttlock/whatsapp/${res.id}`, { method: 'POST', credentials: 'include' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error')
      toast('Código enviado por WhatsApp')
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLockLoading(false) }
  }

  const doGenerateLock = () => {
    // La activación anticipada (09:00 en vez de 14:00) solo tiene sentido cuando
    // el check-in es HOY. Si es un día futuro, el código ya arranca correctamente
    // a las 14:00 del día de check-in — no hay nada "anticipado" que preguntar.
    const todayStr = new Date().toISOString().slice(0, 10)
    if (res.checkInDate !== todayStr) { submitGenerateLock(false); return }
    setEarlyComment(''); setShowEarlyModal(true)
  }

  const submitGenerateLock = async (earlyCheckIn: boolean) => {
    if (earlyCheckIn && !earlyComment.trim()) { toast('Escribe un comentario para la activación anticipada', 'err'); return }
    setShowEarlyModal(false)
    setLockLoading(true)
    try {
      const body = earlyCheckIn ? { earlyCheckIn: true, earlyComment: earlyComment.trim() } : {}
      const r = await fetch(`/api/ttlock/generate/${res.id}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'Error')
      const codes = (data.data.entries ?? []).map((e: any) => `${e.room}: ${e.code}#`).join(' · ')
      toast(`Código ${codes} enviado a ${data.data.sentTo}`)
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLockLoading(false) }
  }
  const doResendLock = async () => {
    setLockLoading(true)
    try {
      const r = await fetch(`/api/ttlock/resend/${res.id}`, { method: 'POST', credentials: 'include' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'Error')
      toast(`Código reenviado a ${data.data.sentTo}`)
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLockLoading(false) }
  }
  const doRevokeLock = async () => {
    if (!confirm('¿Revocar el código de acceso?')) return
    setLockLoading(true)
    try {
      const r = await fetch(`/api/ttlock/revoke/${res.id}`, { method: 'POST', credentials: 'include' })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Error')
      toast('Código revocado')
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLockLoading(false) }
  }

  const hasTtlock  = !!(res.room as any)?.ttlockId || extraRoomDetails.some((r: any) => !!r.ttlockId)
  const hasCode    = !!(res as any).ttlockCode
  const sentAt     = (res as any).ttlockSentAt

  // Parsear códigos almacenados: string simple (1 hab) o JSON array (varias habs)
  const ttlockRaw   = (res as any).ttlockCode as string | null
  const ttlockCodes: Array<{ room: string; code: string }> = ttlockRaw
    ? (ttlockRaw.startsWith('[')
        ? (() => { try { return JSON.parse(ttlockRaw) } catch { return [] } })()
        : [{ room: (res.room as any)?.code ?? '?', code: ttlockRaw }])
    : []

  const zktecoCardNo        = (res as any).zktecoCardNo        as string | null
  const zktecoEnrolledAt    = (res as any).zktecoEnrolledAt    as string | null
  const zktecoCardRevokedAt = (res as any).zktecoCardRevokedAt as string | null
  const zktecoExtraCards    = ((res as any).zktecoExtraCards ?? []) as Array<{ cardNo: string; pin: string; enrolledAt: string }>
  // El número sobrevive a una revocación (checkout/cancelación/revocación a
  // mano) — solo se marca zktecoCardRevokedAt, ver schema. "Activa de verdad
  // ahora mismo" es esto, no solo zktecoCardNo.
  const hasActiveZktecoCard = !!zktecoCardNo && !zktecoCardRevokedAt

  const doRevokeZkteco = async () => {
    if (!confirm('¿Revocar la tarjeta de acceso al recinto?')) return
    setZktecoLoading(true)
    try {
      const r = await fetch(`/api/zkteco/${res.id}`, { method: 'DELETE', credentials: 'include' })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Error')
      toast('Tarjeta de acceso revocada')
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setZktecoLoading(false) }
  }

  const sesSubmittedAt = (res as any).sesSubmittedAt
  const sesLocutorioId = (res as any).sesLocutorioId

  const sesMissing: string[] = (() => {
    const g = res.guest ?? {}
    const m: string[] = []
    if (!g.firstName)   m.push('nombre')
    if (!g.lastName)    m.push('apellido')
    if (!g.dateOfBirth) m.push('fecha nacimiento')
    if (!g.email && !g.phone) m.push('email o teléfono')
    if (!g.idDocType)   m.push('tipo documento')
    if (!g.idDocNumber) m.push('nº documento')
    if (g.idDocType === 'dni' || g.idDocType === 'nie') {
      if (!g.idDocSupportNumber) m.push('nº soporte')
      else if (!/^[A-Z]{3}[0-9]{6}$/.test(g.idDocSupportNumber)) m.push('nº soporte inválido (3 letras + 6 dígitos)')
    }
    if (!g.nationality) m.push('nacionalidad')
    return m
  })()

  const doSesValidate = async () => {
    try {
      const r = await fetch(`/api/ses/validate/${res.id}`, { credentials: 'include' })
      const d = await r.json()
      if (d.data.valid) toast(`✓ Todo correcto — ${d.data.guests} huésped${d.data.guests !== 1 ? 'es' : ''} listo${d.data.guests !== 1 ? 's' : ''} para SES`)
      else toast(d.data.errors.map((e: any) => `${e.field}: ${e.message}`).join(' · '), 'err')
    } catch (e: any) { toast(e.message, 'err') }
  }

  const doSesSend = async () => {
    if (sesMissing.length > 0) { toast(`Faltan datos: ${sesMissing.join(', ')}`, 'err'); return }
    if (!confirm('¿Enviar parte de viajero al SES Hospedajes?')) return
    setSesLoading(true)
    try {
      const r = await fetch(`/api/ses/submit/${res.id}`, { method: 'POST', credentials: 'include' })
      const data = await r.json()
      if (!r.ok) {
        if (data.missingFields) {
          const msgs = data.missingFields.map((f: any) => f.message).join(', ')
          throw new Error(msgs)
        }
        throw new Error(data.error ?? 'Error')
      }
      toast(`Parte enviado · Lote: ${data.data.lote}`)
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSesLoading(false) }
  }

  return (
    <>
      {/* ── Cabecera ── */}
      <div className="res-detail-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" onClick={goBack}>
            {onClose ? '✕ Cerrar' : '← Volver'}
          </button>
          <h2 style={{ fontSize: 18 }}>Reserva #{res.id}</h2>
          <Badge status={res.status} />
          {isBlacklisted && (
            <span className="badge-blacklist">🚫 Lista negra</span>
          )}
        </div>
        <div className="res-detail-meta">
          <span><strong>{res.room?.code ?? '—'}</strong> · {res.room?.roomType?.name ?? ''}</span>
          <span>{fmtDate(res.checkInDate)} → {fmtDate(res.checkOutDate)} · {res.nights} noche{res.nights !== 1 ? 's' : ''}</span>
          <span style={{ color: due > 0.01 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
            {fmtMoney(res.total)} · {due > 0.01 ? `Pendiente ${fmtMoney(due)}` : '✓ Saldado'}
          </span>
        </div>
      </div>

      {/* ── Barra de acciones ── */}
      <div className="action-bar">
        {['confirmed', 'arriving', 'tentative'].includes(res.status)  && <button className="btn btn-green"  onClick={doCheckIn}>Check-in</button>}
        {(res.status === 'checked_in' || res.status === 'checking_out') && <button className="btn btn-yellow" onClick={doCheckOut}>Check-out</button>}
        {(['checked_out','no_show','cancelled'].includes(res.status) && res.checkOutDate >= new Date().toISOString().slice(0,10)) && (
          <button className="btn btn-ghost btn-sm" onClick={doRevertCheckIn}>↩ Revertir a checked-in</button>
        )}
        <button className="btn btn-primary btn-sm" onClick={() => { setTab('transacciones'); setShowPayment(true) }}>+ Pago</button>
        <button className="btn btn-ghost btn-sm"   onClick={() => setShowNote(true)}>+ Nota</button>
        {!['cancelled'].includes(res.status) && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowContract(true)}>
            ✍ Contrato{contracts.some((ct: any) => ct.status === 'signed') && <span style={{ color: 'var(--green)', marginLeft: 4 }}>✓</span>}
          </button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => window.open(`/api/reservations/${res.id}/confirmation-print`, '_blank')}>
          🖨 Confirmación
        </button>
        {(g?.phone || g?.email) && !['checked_out', 'cancelled'].includes(res.status) && (
          res.onlineCheckIn
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: 'rgba(34,197,94,.12)', color: 'var(--green)', border: '1px solid rgba(34,197,94,.35)' }}>
                ✓ Check-in online completado
              </span>
            : <div ref={checkinMenuRef} style={{ position: 'relative' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setCheckinMenuOpen(o => !o)}>
                  Check-in online ▾
                </button>
                {checkinMenuOpen && (
                  <div style={{ position: 'absolute', zIndex: 50, top: '100%', left: 0, marginTop: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.55)', minWidth: 160 }}>
                    {g?.phone && (
                      <div onClick={() => { setCheckinMenuOpen(false); waSend('checkin') }}
                        style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        📲 Por WhatsApp
                      </div>
                    )}
                    {g?.email && (
                      <div onClick={() => { setCheckinMenuOpen(false); sendCheckinEmail() }}
                        style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        ✉️ Por email
                      </div>
                    )}
                  </div>
                )}
              </div>
        )}
        {(g?.phone || g?.email) && due > 0.01 && !['cancelled'].includes(res.status)
          && !((res as any).bookingChannel?.name ?? '').toLowerCase().includes('booking') && (
          <div ref={paymentMenuRef} style={{ position: 'relative' }}>
            <button className="btn btn-ghost btn-sm" title="Enviar recordatorio de pago pendiente"
              onClick={() => setPaymentMenuOpen(o => !o)}>
              🔗 Enlace de pago ▾
            </button>
            {paymentMenuOpen && (
              <div style={{ position: 'absolute', zIndex: 50, top: '100%', left: 0, marginTop: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.55)', minWidth: 160 }}>
                {g?.phone && (
                  <div onClick={() => { setPaymentMenuOpen(false); waSend('payment') }}
                    style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    📲 Por WhatsApp
                  </div>
                )}
                {g?.email && (
                  <div onClick={() => { setPaymentMenuOpen(false); sendPaymentEmail() }}
                    style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    ✉️ Por email
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {!['checked_out','cancelled'].includes(res.status) && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowExtend(true)}>↔ Ampliar</button>
        )}
        {!['checked_out','cancelled'].includes(res.status) && res.pendingExtension
          && res.checkOutDate > res.pendingExtension.prevCheckOutDate && due > 0.10 && (
          <button className="btn btn-ghost btn-sm" onClick={doUndoExtension} title="Solo mientras lo ampliado siga sin cobrar">
            ↩ Deshacer ampliación
          </button>
        )}
        {!['checked_out','cancelled'].includes(res.status) && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowChangeRoom(true)}>
            {res.roomId ? '⇄ Cambiar hab.' : '⇄ Asignar a habitación'}
          </button>
        )}
        {res.roomId && res.nights > 1 && !(res.extraRoomIds?.length > 0) && res.status === 'checked_in' && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowSplit(true)}>✂ Partir reserva</button>
        )}
        {!['checked_out','cancelled'].includes(res.status) && (isAdmin || res.status !== 'checked_in') && (
          <button className="btn btn-red btn-sm" onClick={doCancel}>Cancelar reserva</button>
        )}
        {!isAdmin && res.status === 'checked_in' && (
          <button className="btn btn-red btn-sm" disabled title="El huésped ya está alojado — pide a admin/dirección que cancele esta reserva">
            Cancelar reserva
          </button>
        )}
        {isAdmin && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowChangeStatus(true)} title="Forzar el estado a cualquier valor, sin pasar por check-in/check-out/cancelación">
            ⚙ Cambiar estado
          </button>
        )}
      </div>

      {/* ── Cerradura TTLock ── */}
      {hasTtlock && !['cancelled'].includes(res.status) && (
        <div className="card" style={{ padding: '10px 16px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', minWidth: 0, overflow: 'visible', flexShrink: 0 }}>
          <span style={{ fontSize: 16 }}>🔑</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text1)' }}>Cerradura</span>
          {hasCode ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {ttlockCodes.map((entry, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {ttlockCodes.length > 1 && (
                      <span style={{ fontSize: 11, color: 'var(--text2)', minWidth: 30 }}>Hab. {entry.room}</span>
                    )}
                    <span style={{
                      fontFamily: 'monospace', fontWeight: 700, letterSpacing: 3, color: 'var(--accent2)',
                      fontSize: 'clamp(15px, 4vw, 20px)', background: 'var(--bg3)',
                      padding: '3px 10px', borderRadius: 8, whiteSpace: 'nowrap',
                    }}>
                      {entry.code}#
                    </span>
                  </div>
                ))}
              </div>
              {sentAt && (
                <span style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                  Enviado {new Date(sentAt).toLocaleDateString('es-ES')}
                </span>
              )}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginLeft: 'auto' }}>
                <button className="btn btn-ghost btn-sm" disabled={lockLoading} onClick={doResendLock}>
                  Reenviar email
                </button>
                {g?.phone && (
                  <button className="btn btn-ghost btn-sm" disabled={lockLoading} onClick={doWhatsappLock}>
                    📲 WhatsApp
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" disabled={lockLoading} onClick={doGenerateLock}>
                  Regenerar
                </button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} disabled={lockLoading} onClick={doRevokeLock}>
                  Revocar
                </button>
              </div>
            </>
          ) : (
            <>
              <span style={{ fontSize: 13, color: 'var(--text2)' }}>Sin código generado</span>
              <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} disabled={lockLoading} onClick={doGenerateLock}>
                {lockLoading ? 'Generando…' : 'Generar y enviar código'}
              </button>
            </>
          )}
        </div>
      )}

      {showEarlyModal && (
        <Modal title="Generar código de cerradura" onClose={() => setShowEarlyModal(false)} width={400}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowEarlyModal(false)}>Cancelar</button>
              <button className="btn btn-ghost" onClick={() => submitGenerateLock(false)}>Normal (14:00)</button>
              <button className="btn btn-primary" onClick={() => submitGenerateLock(true)}>Anticipado (09:00)</button>
            </div>
          }>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text2)' }}>
              Para activación anticipada (09:00 en lugar de 14:00) es obligatorio indicar el motivo.
            </p>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Comentario (obligatorio para anticipado)</span>
              <input
                className="form-input"
                placeholder="Ej: llegada temprana confirmada por recepción"
                value={earlyComment}
                onChange={e => setEarlyComment(e.target.value)}
                autoFocus
              />
            </label>
          </div>
        </Modal>
      )}

      {/* ── ZKTeco acceso recinto ── */}
      {!['cancelled'].includes(res.status) && (
        <div className="card" style={{ padding: '10px 16px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', overflow: 'visible', flexShrink: 0 }}>
          <span style={{ fontSize: 16 }}>🚪</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text1)' }}>Acceso recinto</span>
          {hasActiveZktecoCard ? (
            <>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)' }}>✓ Enrollada</span>
              {zktecoExtraCards.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                  {1 + zktecoExtraCards.length} tarjetas
                </span>
              )}
              {zktecoEnrolledAt && (
                <span style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                  {new Date(zktecoEnrolledAt).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => setShowZktecoDetails(v => !v)}
              >
                {showZktecoDetails ? 'Ocultar' : 'Detalles'}
              </button>
              {showZktecoDetails && (
                <div style={{ flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {/* Tarjeta primaria */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text2)', minWidth: 60 }}>Tarjeta 1</span>
                    <code style={{ background: 'var(--bg3)', padding: '3px 10px', borderRadius: 8, fontWeight: 700, color: 'var(--green)', fontSize: 13, letterSpacing: 1 }}>
                      {zktecoCardNo}
                    </code>
                    <span style={{ fontSize: 10, color: 'var(--text3)' }}>PIN {res.id}</span>
                  </div>
                  {/* Tarjetas extra */}
                  {zktecoExtraCards.map((ec, i) => (
                    <div key={ec.pin} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text2)', minWidth: 60 }}>Tarjeta {i + 2}</span>
                      <code style={{ background: 'var(--bg3)', padding: '3px 10px', borderRadius: 8, fontWeight: 700, color: 'var(--green)', fontSize: 13, letterSpacing: 1 }}>
                        {ec.cardNo}
                      </code>
                      <span style={{ fontSize: 10, color: 'var(--text3)' }}>PIN {ec.pin}</span>
                      {ec.enrolledAt && (
                        <span style={{ fontSize: 10, color: 'var(--text3)' }}>
                          {new Date(ec.enrolledAt).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  ))}
                  {isAdmin && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--red)', alignSelf: 'flex-start', marginTop: 4 }}
                      disabled={zktecoLoading}
                      onClick={doRevokeZkteco}
                    >
                      Revocar todas
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <span style={{ fontSize: 13, color: res.status === 'checked_in' ? 'var(--yellow)' : 'var(--text2)' }}>
              {res.status === 'checked_in' ? '⚠ Sin tarjeta enrollada' : 'Sin tarjeta de acceso'}
            </span>
          )}
        </div>
      )}

      {/* ── SES Hospedajes ── */}
      {!['cancelled'].includes(res.status) && (
        <div className="card" style={{ padding: '10px 16px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', overflow: 'visible', flexShrink: 0 }}>
          <span style={{ fontSize: 16 }}>🏛️</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text1)' }}>SES Hospedajes</span>
          {sesSubmittedAt ? (
            <>
              <span className="badge" style={{ background: 'var(--green)', color: '#fff', fontSize: 11 }}>✓ Enviado</span>
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                {new Date(sesSubmittedAt).toLocaleDateString('es-ES')}
                {sesLocutorioId && <> · <code style={{ fontSize: 11 }}>{sesLocutorioId}</code></>}
              </span>
              <button className="btn btn-ghost btn-sm" disabled={sesLoading} onClick={doSesSend}>
                Reenviar
              </button>
            </>
          ) : (
            <>
              {sesMissing.length > 0 ? (
                <span style={{ fontSize: 11, color: 'var(--yellow)' }}>
                  ⚠ Faltan datos: {sesMissing.join(', ')}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>Pendiente de envío</span>
              )}
              <button className="btn btn-ghost btn-sm" disabled={sesLoading} onClick={doSesValidate}>
                Verificar
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={sesLoading || sesMissing.length > 0}
                onClick={doSesSend}
                title={sesMissing.length > 0 ? `Completa los datos del huésped primero: ${sesMissing.join(', ')}` : undefined}
              >
                {sesLoading ? 'Enviando…' : 'Enviar parte'}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="tab-bar" style={{ marginBottom: 0 }}>
        {TABS.map(t => (
          <button key={t.id} className={`tab-btn${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'transacciones' && payments.length > 0  && <span className="tab-count">{payments.length}</span>}
            {t.id === 'depositos'     && deposits.length > 0  && <span className="tab-count">{deposits.length}</span>}
            {t.id === 'extras'        && extras.length > 0    && <span className="tab-count">{extras.length}</span>}
            {t.id === 'facturas'      && invoices.length > 0  && <span className="tab-count">{invoices.length}</span>}
          </button>
        ))}
      </div>

      {/* ── Tab: Huésped ── */}
      {tab === 'huesped' && (
        <div className="res-tab-content">
          <div className="detail-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>

            {/* Card huésped */}
            <div className="detail-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                <h3 style={{ marginBottom: 0 }}>Huésped titular</h3>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {g.isVip && <span style={{ fontSize: 11, color: 'var(--yellow)', fontWeight: 700 }}>★ VIP</span>}
                  {g.id && (
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                      onClick={() => setShowEditGuest(true)}>✎ Editar</button>
                  )}
                  <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                    onClick={() => setShowChangeTitular(true)}>⇄ Cambiar titular</button>
                  <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                    onClick={() => setShowFeedback(true)}>💬 Feedback</button>
                  <button
                    className={`btn btn-sm ${isBlacklisted ? 'btn-red' : 'btn-ghost'}`}
                    style={{ fontSize: 11 }}
                    onClick={() => setShowBlacklist(true)}
                  >{isBlacklisted ? '🚫 L.Negra' : '⚑ L.Negra'}</button>
                </div>
              </div>
              {isBlacklisted && (
                <div className="blacklist-banner">
                  <strong>Lista negra{g.blacklistSeverity ? ` · ${BL_SEVERITY_LABEL[g.blacklistSeverity] ?? g.blacklistSeverity}` : ''}</strong>
                  <span>{g.blacklistReason}</span>
                </div>
              )}
              <Row k="Nombre"        v={`${g.firstName ?? ''} ${g.lastName ?? ''}${g.secondLastName ? ' ' + g.secondLastName : ''}`} />
              {g.id && <Row k="Valoración" v={<GuestRatingStars guestId={g.id} value={g.guestRating ?? null} onChanged={load} />} />}
              <Row k="Email"         v={g.email ? <a href={`mailto:${g.email}`} style={{ color: 'var(--accent)' }}>{g.email}</a> : undefined} />
              <Row k="Teléfono"      v={g.phone ? <a href={`tel:${g.phone}`}    style={{ color: 'var(--accent)' }}>{g.phone}</a> : undefined} />
              <Row k="F. nacimiento" v={g.dateOfBirth ? fmtDate(g.dateOfBirth) : undefined} />
              <Row k="Nacionalidad"  v={g.nationality} />
              {g.gender && g.gender !== 'unspecified' && (
                <Row k="Sexo" v={{ male: 'Hombre', female: 'Mujer', non_binary: 'No binario' }[g.gender as string] ?? g.gender} />
              )}
              {g.idDocType && <>
                <Row k="Documento"   v={`${DOC_TYPE_LABEL[g.idDocType] ?? g.idDocType} ${g.idDocNumber ?? ''}`} />
                {g.idDocSupportNumber && <Row k="Nº soporte" v={g.idDocSupportNumber} />}
                {g.idDocIssueDate     && <Row k="Expedición" v={fmtDate(g.idDocIssueDate)} />}
                {g.idDocExpiryDate    && <Row k="Caducidad"  v={fmtDate(g.idDocExpiryDate)} />}
              </>}
              <Row k="Dirección"     v={g.address1} />
              <Row k="Cód. postal"   v={g.zipCode} />
              <Row k="Municipio"     v={g.cityIneCode ? `${g.city ?? ''} (${g.cityIneCode})` : g.city} />
              {g.purposeOfStay && <Row k="Motivo"   v={g.purposeOfStay} />}
              {g.specialInfo1  && <Row k="Info"     v={g.specialInfo1} />}
            </div>

            {/* Card estancia */}
            <div className="detail-section">
              <h3>Estancia</h3>
              <Row k="Habitación"  v={res.room?.code} />
              <Row k="Tipo" v={
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  {res.room?.roomType?.name ?? '—'}
                  {isAdmin && !['checked_out','cancelled'].includes(res.status) && (
                    <EditRoomTypeButton res={res} onApplied={load} />
                  )}
                </span>
              } />
              {((res.extraRoomIds ?? []).length > 0 || !['checked_out','cancelled'].includes(res.status)) && (
                <Row k="Habs. adicionales" v={
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                    {extraRoomDetails.map((r: any) => {
                      const locked = lockedRoomIds.includes(r.id)
                      return (
                        <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '1px 6px', fontSize: 12 }}>
                          {canManageReservations(user) && (
                            <input type="checkbox" checked={locked} onChange={() => toggleRoomLock(r.id)}
                              title="Cerrada — no se puede mover a otros huéspedes aquí"
                              style={{ margin: 0, cursor: 'pointer' }} />
                          )}
                          <span style={{ textDecoration: locked ? 'line-through' : 'none', color: locked ? 'var(--text2)' : 'inherit' }}>
                            {r.code}
                          </span>
                          {/* Un administrador (dirección) puede quitar habitaciones adicionales
                              en cualquier estado — necesario para limpiar asignaciones erróneas
                              (ej. las que generó el bug de sync FDM) en reservas ya cerradas.
                              Recepción solo puede hacerlo mientras la reserva sigue activa. */}
                          {(isAdmin || (!['checked_out','cancelled'].includes(res.status) && canManageReservations(user))) && (
                            <button type="button" onClick={() => setRemoveExtraRoomModal({ roomId: r.id, code: r.code })}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', lineHeight: 1, padding: 0, fontSize: 11 }}>✕</button>
                          )}
                        </span>
                      )
                    })}
                    {/* Dirección puede añadir habitación extra a cualquier reserva sin dar
                        motivo (igual que siempre). Recepción también puede, para cualquier
                        canal de reserva — pero el modal le exige una explicación de al
                        menos 5 palabras (igual que quitar una extra o un cambio delicado),
                        que comprueba también el backend. */}
                    {!['checked_out','cancelled'].includes(res.status) && canManageReservations(user) && (
                      <button className="btn btn-ghost btn-xs" style={{ fontSize: 11, padding: '1px 6px' }}
                        onClick={() => setShowAddExtraRoom(true)}>+ Hab.</button>
                    )}
                  </div>
                } />
              )}
              <Row k="Entrada"     v={fmtDate(res.checkInDate)} />
              <Row k="Salida" v={
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  {fmtDate(res.checkOutDate)}
                  {isAdmin && <EditCheckOutButton res={res} onApplied={load} />}
                </span>
              } />
              <Row k="Noches"      v={res.nights} />
              <Row k="Personas"    v={res.people} />
              <Row k="Canal" v={
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  {res.bookingChannel?.name ?? '—'}
                  {canEditField('channel', user, res.bookingChannelId, fieldRules) && <EditChannelButton res={res} onApplied={load} />}
                </span>
              } />
              <Row k="Tarifa" v={
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  {res.rate?.title ?? '—'}
                  {canEditField('rate', user, res.bookingChannelId, fieldRules) && <EditRateButton res={res} onApplied={load} />}
                </span>
              } />
              <Row k="Cód. externo" v={
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  {res.externalCode ? <code style={{ fontSize: 12 }}>{res.externalCode}</code> : <span style={{ color: 'var(--text2)', fontSize: 12 }}>—</span>}
                  {canEditField('external_code', user, res.bookingChannelId, fieldRules) && <EditExternalCodeButton res={res} onApplied={load} />}
                </span>
              } />
              {res.groupName    && <Row k="Grupo"         v={res.groupName} />}
            </div>

            {/* Card financiero resumen */}
            <div className="detail-section">
              <h3>Financiero</h3>
              <Row k="Total" v={
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong>{fmtMoney(res.total)}</strong>
                  {res.roomId && canManageReservations(user) && (
                    <RecalcPriceButton res={res} onApplied={load} />
                  )}
                  {canEditField('price', user, res.bookingChannelId, fieldRules) && canManageReservations(user) && (
                    <EditPriceButton res={res} onApplied={load} />
                  )}
                </span>
              } />
              <Row k="Cobrado"   v={<span style={{ color: 'var(--green)', fontWeight: 600 }}>{fmtMoney(totalPaid)}</span>} />
              <Row k="Pendiente" v={<span style={{ color: due > 0.01 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{fmtMoney(due)}</span>} />
              <Row k="Comisión"  v={fmtMoney(res.bmCommission)} />
              <Row k="Pagos reg."   v={payments.length} />
              {deposits.length > 0 && <Row k="Depósitos" v={deposits.length} />}
              <Row k="Facturas"     v={invoices.length} />
            </div>

            {/* Card notas */}
            {res.notes?.length > 0 && (
              <div className="detail-section">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3>Notas ({res.notes.length})</h3>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowNote(true)}>+ Añadir</button>
                </div>
                {res.notes.slice(0, 3).map((n: any) => (
                  <div key={n.id} style={{ fontSize: 12, borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
                    <div style={{ color: 'var(--text2)', marginBottom: 2 }}>
                      {n.author ? `${n.author.firstName} ${n.author.lastName} · ` : ''}{fmtDate(n.createdAt)}
                    </div>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{n.note}</p>
                  </div>
                ))}
                {res.notes.length > 3 && (
                  <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }}
                    onClick={() => setTab('historial')}>Ver todas →</button>
                )}
              </div>
            )}
          </div>

          {/* Huéspedes adicionales */}
          <div className="card" style={{ marginTop: 20 }}>
            <div className="card-header">
              <h2>Huéspedes adicionales ({additionalGuests.length}{totalMaxOccupancy ? `/${totalMaxOccupancy - 1}` : ''})</h2>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setShowAddGuest(true)}
                disabled={atCapacity}
              >+ Añadir</button>
              {atCapacity && (
                <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 8 }}>
                  Aforo completo ({maxOccupancy} {maxOccupancy === 1 ? 'persona' : 'personas'})
                </span>
              )}
            </div>
            {additionalGuests.length === 0 ? (
              <div style={{ padding: '12px 18px' }}>
                <p style={{ fontSize: 13, color: 'var(--text2)' }}>Sin huéspedes adicionales registrados.</p>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ cursor: 'pointer' }} onClick={() => toggleGuestSort('name')}>Nombre{sortArrow('name')}</th>
                    <th>Documento</th><th>F. nacimiento</th><th>Nac.</th>
                    {isGroupReservation && (
                      <th style={{ cursor: 'pointer' }} onClick={() => toggleGuestSort('room')}>Habitación{sortArrow('room')}</th>
                    )}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAdditionalGuests.map((ag: any) => {
                    // Habitación cerrada (ver toggleRoomLock) — el huésped que ya está
                    // en ella queda fijo: ni se puede quitar de la reserva ni mover a
                    // otra habitación, y nadie más puede ocupar la suya.
                    const guestRoomLocked = ag.roomId != null && lockedRoomIds.includes(ag.roomId)
                    return (
                    <tr key={ag.id}>
                      <td style={{ fontWeight: 500 }}>
                        {ag.firstName} {ag.lastName}{ag.secondLastName ? ' ' + ag.secondLastName : ''}
                        {guestRoomLocked && <span title="Habitación cerrada" style={{ marginLeft: 4 }}>🔒</span>}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                        {ag.idDocType ? `${DOC_TYPE_LABEL[ag.idDocType] ?? ag.idDocType} ${ag.idDocNumber ?? ''}` : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                        {ag.dateOfBirth ? fmtDate(ag.dateOfBirth) : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text2)' }}>{ag.nationality ?? '—'}</td>
                      {isGroupReservation && (
                        <td>
                          <select value={ag.roomId ?? ''} style={{ fontSize: 12 }} disabled={guestRoomLocked}
                            title={guestRoomLocked ? 'Habitación cerrada — no se puede cambiar' : undefined}
                            onChange={e => moveAdditionalGuestRoom(ag.id, Number(e.target.value))}>
                            {groupRooms.filter((r: any) => !lockedRoomIds.includes(r.id) || r.id === ag.roomId).map((r: any) => (
                              <option key={r.id} value={r.id}>{r.code}</option>
                            ))}
                          </select>
                        </td>
                      )}
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                            onClick={() => setEditingAdditional(ag)}>✎ Editar</button>
                          <button className="btn btn-ghost btn-sm"
                            disabled={guestRoomLocked}
                            title={guestRoomLocked ? 'Habitación cerrada — no se puede quitar a este huésped' : undefined}
                            style={guestRoomLocked ? { fontSize: 11, opacity: 0.4, cursor: 'not-allowed' } : { fontSize: 11, color: 'var(--red)' }}
                            onClick={guestRoomLocked ? undefined : () => removeAdditionalGuest(ag.id)}>✕</button>
                        </div>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Noches */}
          {res.nightRows?.length > 0 && (
            <div className="card" style={{ marginTop: 20 }}>
              <div className="card-header"><h2>Desglose de noches ({res.nightRows.length})</h2></div>
              <table className="data-table">
                <thead><tr><th>Fecha</th><th>Huésped</th><th>Habitación</th><th>Tipo</th><th>Cama</th><th>Precio</th><th>Comisión</th></tr></thead>
                <tbody>
                  {res.nightRows.map((n: any) => (
                    <tr key={n.id}>
                      <td>{fmtDate(n.date)}</td>
                      <td>{n.guest?.firstName} {n.guest?.lastName}</td>
                      <td>{n.room?.code ?? '—'}</td>
                      <td>{n.room?.roomType?.name ?? '—'}</td>
                      <td>{n.bedIndex ?? '—'}</td>
                      <td>{fmtMoney(n.price)}</td>
                      <td>{fmtMoney(n.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Transacciones ── */}
      {tab === 'transacciones' && (
        <div className="res-tab-content">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn btn-primary" onClick={() => setShowPayment(true)}>+ Registrar pago</button>
          </div>
          {payments.length === 0 ? (
            <div className="empty"><p>Sin pagos registrados</p></div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th>Fecha</th><th>Método</th><th>Nº Op.</th><th>Cuenta / Caja</th><th>Usuario</th><th>Descripción</th>
                  <th>Cobrado en otro turno</th><th>Importe</th><th></th>
                </tr></thead>
                <tbody>
                  {payments.map((p: any) => (
                    <tr key={p.id}>
                      <td title={p.createdByUser ? `Registrado por ${p.createdByUser.firstName} ${p.createdByUser.lastName}` : undefined}>
                        {fmtDate(p.transactionDate)}
                        {fmtTime(p.createdAt) && <span style={{ color: 'var(--text2)', fontSize: 11, marginLeft: 4 }}>{fmtTime(p.createdAt)}</span>}
                      </td>
                      <td><span className="badge">{PAYMENT_METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}</span></td>
                      <td style={{ color: 'var(--text2)', fontSize: 12 }}>{p.cardOperationNumber ?? '—'}</td>
                      <td style={{ color: 'var(--text2)', fontSize: 12 }}>{p.financialAccount?.name ?? '—'}</td>
                      <td style={{ color: 'var(--text2)', fontSize: 12 }}>
                        {p.paidByUser
                          ? `${p.paidByUser.firstName} ${p.paidByUser.lastName}`
                          : p.createdByUser ? `${p.createdByUser.firstName} ${p.createdByUser.lastName}` : (p.user ?? '—')}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {canManageReservations(user) ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: 'var(--text2)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.description ?? undefined}>
                              {p.description ?? '—'}
                            </span>
                            <button className="btn btn-ghost btn-xs" onClick={() => setEditingDescriptionTx(p)}>✎</button>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text2)' }}>{p.description ?? '—'}</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        <label className={`rate-toggle${canManageReservations(user) ? '' : ' rate-toggle-disabled'}`}>
                          <input type="checkbox" checked={!!p.collectedAt}
                            disabled={!canManageReservations(user)}
                            onChange={() => setCorrectingTx(p)} />
                          {p.collectedAt ? 'Corregido' : 'Cobrado en otro turno'}
                        </label>
                        {p.collectedAt && (
                          <div style={{ color: 'var(--text2)', marginTop: 2 }}>
                            {fmtDateTime(p.collectedAt)}
                            {p.paidByUser && ` · ${p.paidByUser.firstName} ${p.paidByUser.lastName}`}
                          </div>
                        )}
                      </td>
                      <td style={{ fontWeight: 600, color: 'var(--green)' }}>{fmtMoney(p.amount)}</td>
                      <td style={{ display: 'flex', gap: 4 }}>
                        {isAdmin && (
                          <>
                            <button className="btn btn-ghost btn-sm"
                              onClick={() => setEditingPayment(p)}>✎</button>
                            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
                              onClick={async () => {
                                if (!confirm('¿Eliminar este pago?')) return
                                await fetch(`/api/financial/transactions/${p.id}`, { method: 'DELETE' })
                                toast('Pago eliminado'); load()
                              }}>✕</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'right', color: 'var(--text2)', fontSize: 12 }}>Total cobrado</td>
                    <td style={{ fontWeight: 700, color: 'var(--green)' }}>{fmtMoney(totalPaid)}</td>
                    <td />
                  </tr>
                  {due > 0.01 && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'right', color: 'var(--text2)', fontSize: 12 }}>Pendiente</td>
                      <td style={{ fontWeight: 700, color: 'var(--red)' }}>{fmtMoney(due)}</td>
                      <td />
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Depósitos ── */}
      {tab === 'depositos' && (
        <div className="res-tab-content">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            {canManageReservations(user) && res.status !== 'cancelled' && (
              <button className="btn btn-primary btn-sm" onClick={() => setShowDeposit(true)}>+ Agregar depósito</button>
            )}
          </div>
          {deposits.filter((p: any) => p.category !== 'deposit_return').length === 0 ? (
            <div className="empty"><p>Sin depósitos registrados</p></div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th>Fecha</th><th>Tipo</th><th>Cuenta</th><th>Descripción</th><th>Importe</th><th>Estado</th><th></th>
                </tr></thead>
                <tbody>
                  {deposits.filter((p: any) => p.category !== 'deposit_return').map((p: any) => {
                    const isCard      = p.category === 'deposit_card'
                    const isCobrado   = p.category === 'deposit_cobrado'
                    const returnTx    = deposits.find((d: any) => d.category === 'deposit_return' && d.description === `dep:${p.id}`)
                    const isReturned  = !!returnTx
                    const typeLabel   = p.category === 'deposit_preauth'  ? 'Preautorización'
                                     : p.category === 'deposit_card'    ? 'Datos de Tarjeta'
                                     : p.category === 'deposit_cash'    ? 'Efectivo'
                                     : p.category === 'deposit_cobrado' ? 'Cobrado'
                                     : PAYMENT_METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod
                    const registeredByLabel = p.createdByUser ? `Registrado por ${p.createdByUser.firstName} ${p.createdByUser.lastName}` : undefined
                    const cobradoTooltip = isCobrado && p.resolvedByUser
                      ? `Cobrado el ${fmtDateTime(p.resolvedAt)} por ${p.resolvedByUser.firstName} ${p.resolvedByUser.lastName}`
                      : undefined
                    const returnedTooltip = isReturned
                      ? `Devuelto el ${fmtDateTime(returnTx.createdAt)}${returnTx.createdByUser ? ` por ${returnTx.createdByUser.firstName} ${returnTx.createdByUser.lastName}` : ''}`
                      : undefined
                    return (
                      <tr key={p.id}>
                        <td title={registeredByLabel}>
                          {fmtDate(p.transactionDate)}
                          {fmtTime(p.createdAt) && <span style={{ color: 'var(--text2)', fontSize: 11, marginLeft: 4 }}>{fmtTime(p.createdAt)}</span>}
                        </td>
                        <td><span className="badge">{typeLabel}</span></td>
                        <td style={{ color: 'var(--text2)', fontSize: 12 }}>{p.financialAccount?.name ?? '—'}</td>
                        <td style={{ color: 'var(--text2)', fontSize: 12 }}>{p.description ?? '—'}</td>
                        <td style={{ fontWeight: 600, color: isCobrado ? 'var(--green)' : 'var(--yellow)' }}>
                          {isCard ? '—' : fmtMoney(p.amount)}
                        </td>
                        <td>
                          {isCard ? (
                            <span style={{ fontSize: 12, color: 'var(--text2)' }}>—</span>
                          ) : isCobrado ? (
                            <span className="badge badge-ok" style={{ fontSize: 11 }} title={cobradoTooltip}>Cobrado</span>
                          ) : isReturned ? (
                            <span className="badge badge-warn" style={{ fontSize: 11 }} title={returnedTooltip}>Devuelto</span>
                          ) : (
                            canManageReservations(user) && (
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button className="btn btn-ghost btn-xs"
                                  onClick={async () => {
                                    if (!confirm('¿Marcar este depósito como devuelto?')) return
                                    const defAccount = accounts.find((a: any) => a.isDefault) ?? accounts[0]
                                    if (!defAccount) { toast('Sin cuenta disponible', 'err'); return }
                                    const r = await fetch('/api/financial/transactions', {
                                      method: 'POST', credentials: 'include',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({
                                        reservationId: res.id,
                                        financialAccountId: p.financialAccountId,
                                        amount: -parseFloat(p.amount),
                                        paymentMethod: p.paymentMethod,
                                        category: 'deposit_return',
                                        description: `dep:${p.id}`,
                                      }),
                                    })
                                    if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.error ?? 'Error al marcar el depósito como devuelto', 'err'); return }
                                    toast('Depósito marcado como devuelto'); load()
                                  }}>Marcar devuelto</button>
                                {parseFloat(p.amount) > 0 && (
                                  <button className="btn btn-primary btn-xs"
                                    onClick={() => setCobrarDeposit(p)}>Cobrar</button>
                                )}
                              </div>
                            )
                          )}
                        </td>
                        <td>
                          {isAdmin && (
                            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
                              onClick={async () => {
                                if (!confirm('¿Eliminar este depósito?')) return
                                await fetch(`/api/financial/transactions/${p.id}`, { method: 'DELETE', credentials: 'include' })
                                toast('Depósito eliminado'); load()
                              }}>✕</button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'right', color: 'var(--text2)', fontSize: 12 }}>Total depósitos</td>
                    <td style={{ fontWeight: 700, color: 'var(--yellow)' }}>
                      {fmtMoney(deposits
                        .filter((p: any) => p.category !== 'deposit_return' && p.category !== 'deposit_card')
                        .reduce((s: number, p: any) => s + parseFloat(p.amount ?? '0'), 0))}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Facturas ── */}
      {tab === 'facturas' && (
        <div className="res-tab-content">
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
            <ProformaButton res={res} due={due} />
            <NewInvoiceButton res={res} totalPaid={totalPaid} invoices={invoices} onDone={load} />
          </div>
          {invoices.length === 0 ? (
            <div className="empty"><p>Sin facturas para esta reserva</p></div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Nº Factura</th><th>Fecha</th><th>Facturar a</th><th>Total</th><th></th></tr></thead>
                <tbody>
                  {invoices.map((inv: any) => (
                    <tr key={inv.id}>
                      <td><code style={{ fontSize: 12 }}>{inv.invoiceNumber}</code></td>
                      <td>{inv.issuedAt}</td>
                      <td style={{ fontSize: 13 }}>
                        {inv.billingName || `${inv.guest?.firstName ?? ''} ${inv.guest?.lastName ?? ''}`.trim() || '—'}
                        {inv.billingNif && <span style={{ color: 'var(--text2)', marginLeft: 6 }}>{inv.billingNif}</span>}
                      </td>
                      <td style={{ fontWeight: 600 }}>{fmtMoney(inv.total)}</td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingInvoice(inv)}>
                          Editar
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={async () => {
                          try {
                            const [template, { data: full }] = await Promise.all([
                              fetchInvoiceTemplate(),
                              api.getInvoice(inv.id) as Promise<any>,
                            ])
                            printInvoice(full, template, property)
                          } catch (e: any) { toast(e.message, 'err') }
                        }}>🖨 Imprimir</button>
                        {isAdmin && parseFloat(inv.total) > 0 && (
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={async () => {
                            if (!confirm(`¿Crear factura rectificativa de ${inv.invoiceNumber}?`)) return
                            try {
                              const r = await fetch(`/api/financial/invoices/${inv.id}/credit-note`, { method: 'POST', credentials: 'include' })
                              const d = await r.json()
                              if (!r.ok) throw new Error(d.error ?? 'Error')
                              toast(`Factura rectificativa ${d.data.invoiceNumber} creada`)
                              load()
                            } catch (e: any) { toast(e.message, 'err') }
                          }}>↩ Devolución</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Modal: editar factura ── */}
      {editingInvoice && (
        <EditInvoiceModal
          invoice={editingInvoice}
          onClose={() => setEditingInvoice(null)}
          onSaved={(updated) => {
            setInvoices(prev => prev.map(i => i.id === updated.id ? { ...i, ...updated } : i))
            setEditingInvoice(null)
          }}
        />
      )}

      {editingPayment && (
        <EditTransactionModal
          tx={editingPayment}
          accounts={accounts}
          onClose={() => setEditingPayment(null)}
          onSaved={() => { setEditingPayment(null); load() }}
        />
      )}

      {editingDescriptionTx && (
        <TransactionDescriptionModal
          tx={editingDescriptionTx}
          onClose={() => setEditingDescriptionTx(null)}
          onSaved={() => { setEditingDescriptionTx(null); load() }}
        />
      )}

      {correctingTx && (
        <CorrectPaymentDateModal
          tx={correctingTx}
          onClose={() => setCorrectingTx(null)}
          onSaved={() => { setCorrectingTx(null); load() }}
        />
      )}

      {/* ── Tab: Extras ── */}
      {tab === 'extras' && (
        <div className="res-tab-content">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn btn-primary" onClick={() => setShowExtra(true)}>+ Añadir extra</button>
          </div>
          {extras.length === 0 ? (
            <div className="empty"><p>Sin extras en esta reserva</p></div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th>Concepto</th><th>Fecha</th><th>Uds.</th><th>Precio unit.</th><th>Total</th><th>Notas</th><th></th>
                </tr></thead>
                <tbody>
                  {extras.map((ex: any) => (
                    <tr key={ex.id}>
                      <td>{ex.saleItem?.title ?? '—'}</td>
                      <td style={{ color: 'var(--text2)', fontSize: 12 }}>{ex.date ?? '—'}</td>
                      <td>{ex.quantity}</td>
                      <td>{fmtMoney(ex.unitPrice)}</td>
                      <td style={{ fontWeight: 600 }}>{fmtMoney(parseFloat(ex.unitPrice) * ex.quantity)}</td>
                      <td style={{ color: 'var(--text2)', fontSize: 12 }}>{ex.notes ?? '—'}</td>
                      <td>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
                          onClick={async () => {
                            if (!confirm('¿Quitar este extra?')) return
                            await fetch(`/api/reservations/${res.id}/extras/${ex.id}`, { method: 'DELETE' })
                            toast('Extra eliminado'); load()
                          }}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'right', color: 'var(--text2)', fontSize: 12 }}>Total extras</td>
                    <td style={{ fontWeight: 700 }}>
                      {fmtMoney(extras.reduce((s: number, ex: any) => s + parseFloat(ex.unitPrice) * ex.quantity, 0))}
                    </td>
                    <td /><td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Historial ── */}
      {tab === 'historial' && (
        <div className="res-tab-content">
          <div className="timeline">
            {history.map((ev: any, i: number) => (
              <div key={i} className="timeline-item">
                <div className="timeline-icon">{ev.icon}</div>
                <div className="timeline-body">
                  <div className="timeline-label">{ev.label}</div>
                  {ev.detail && <div className="timeline-detail">{ev.detail}</div>}
                  <div className="timeline-ts">
                    {new Date(ev.ts).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))}
            {history.length === 0 && <div className="empty"><p>Sin historial disponible</p></div>}
          </div>

          {/* Notas completas */}
          {res.notes?.length > 0 && (
            <div className="card" style={{ marginTop: 20 }}>
              <div className="card-header">
                <h2>Notas ({res.notes.length})</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowNote(true)}>+ Añadir</button>
              </div>
              <div style={{ padding: '0 18px' }}>
                {res.notes.map((n: any) => (
                  <div key={n.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
                      {n.author ? `${n.author.firstName} ${n.author.lastName} · ` : ''}{fmtDate(n.createdAt)}
                    </div>
                    <p style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{n.note}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Zona peligrosa (solo admin) ── */}
      {isAdmin && (
        <div className="card" style={{ marginTop: 20, borderColor: 'var(--red)' }}>
          <div className="card-header" style={{ borderBottomColor: 'var(--red)' }}>
            <h2 style={{ color: 'var(--red)' }}>Zona de peligro</h2>
          </div>
          <div style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Borrar reserva</div>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
                Elimina permanentemente la reserva, sus noches, notas, extras y transacciones asociadas.
              </div>
            </div>
            <button
              className="btn btn-sm"
              style={{ background: 'var(--red)', color: '#fff', flexShrink: 0 }}
              disabled={deleting}
              onClick={async () => {
                if (!confirm(`¿Borrar definitivamente la reserva #${res.id}? Esta acción no se puede deshacer.`)) return
                setDeleting(true)
                try {
                  const r = await fetch(`/api/reservations/${res.id}`, { method: 'DELETE' })
                  if (!r.ok) { const d = await r.json(); throw new Error(d.error ?? 'Error') }
                  window.dispatchEvent(new CustomEvent('reservation:changed'))
                  goBack()
                } catch (e: any) {
                  alert(e.message)
                  setDeleting(false)
                }
              }}
            >
              {deleting ? 'Borrando…' : 'Borrar reserva'}
            </button>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {showNote && (
        <AddNoteModal reservationId={res.id}
          onClose={() => setShowNote(false)} onSaved={() => { setShowNote(false); load() }} />
      )}
      {showZktecoReason && (() => {
        const words = zktecoReasonText.trim().split(/\s+/).filter(Boolean).length
        const ok = words >= 15
        const cancel = async () => { setShowZktecoReason(false); setZktecoReasonText(''); await abandonCheckin() }
        return (
          <Modal title="⚠️ Check-in sin tarjeta ZKTeco" onClose={cancel} footer={
            <>
              <button className="btn btn-ghost" onClick={cancel}>Cancelar</button>
              <button className="btn btn-primary" disabled={!ok} onClick={async () => {
                checkinSkipRef.current.zkteco = zktecoReasonText
                setShowZktecoReason(false); setZktecoReasonText('')
                const sesSent = !!(res as any).sesSubmittedAt
                if (!sesSent) { setShowSesReason(true); return }
                await doCheckInFinal()
              }}>Continuar</button>
            </>
          }>
            <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 14 }}>
              Esta reserva no tiene ninguna tarjeta enrollada. Explica el motivo para continuar (mínimo 15 palabras).
            </p>
            <textarea autoFocus rows={4}
              style={{ width: '100%', resize: 'vertical', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', fontSize: 13 }}
              placeholder="Describe el motivo por el que procedes sin enrollar la tarjeta..."
              value={zktecoReasonText} onChange={e => setZktecoReasonText(e.target.value)} />
            <div style={{ fontSize: 12, color: ok ? 'var(--green)' : 'var(--text2)', marginTop: 4 }}>
              {words} / 15 palabras {ok ? '✓' : ''}
            </div>
          </Modal>
        )
      })()}
      {showSesReason && (() => {
        const words = sesReasonText.trim().split(/\s+/).filter(Boolean).length
        const ok = words >= 15
        const cancel = async () => { setShowSesReason(false); setSesReasonText(''); await abandonCheckin() }
        return (
          <Modal title="⚠️ Check-in sin enviar SES Hospedajes" onClose={cancel} footer={
            <>
              <button className="btn btn-ghost" onClick={cancel}>Cancelar</button>
              <button className="btn btn-primary" disabled={!ok} onClick={async () => {
                checkinSkipRef.current.ses = sesReasonText
                setShowSesReason(false); setSesReasonText('')
                await doCheckInFinal()
              }}>Continuar</button>
            </>
          }>
            <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 14 }}>
              No se ha enviado el parte de viajeros al SES. Explica el motivo para continuar (mínimo 15 palabras).
            </p>
            <textarea autoFocus rows={4}
              style={{ width: '100%', resize: 'vertical', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', fontSize: 13 }}
              placeholder="Describe el motivo por el que procedes sin enviar al SES..."
              value={sesReasonText} onChange={e => setSesReasonText(e.target.value)} />
            <div style={{ fontSize: 12, color: ok ? 'var(--green)' : 'var(--text2)', marginTop: 4 }}>
              {words} / 15 palabras {ok ? '✓' : ''}
            </div>
          </Modal>
        )
      })()}
      {showContractReason && (() => {
        const words = contractReasonText.trim().split(/\s+/).filter(Boolean).length
        const ok = words >= 15
        const cancel = async () => { setShowContractReason(false); setContractReasonText(''); await abandonCheckin() }
        return (
          <Modal title="⚠️ Check-in sin contrato firmado" onClose={cancel} footer={
            <>
              <button className="btn btn-ghost" onClick={cancel}>Cancelar</button>
              <button className="btn btn-primary" disabled={!ok} onClick={async () => {
                checkinSkipRef.current.contract = contractReasonText
                setShowContractReason(false); setContractReasonText('')
                await doCheckInExecute()
              }}>Continuar con check-in</button>
            </>
          }>
            <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 14 }}>
              El contrato de admisión no ha sido firmado. Explica el motivo para continuar (mínimo 15 palabras).
            </p>
            <textarea autoFocus rows={4}
              style={{ width: '100%', resize: 'vertical', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', fontSize: 13 }}
              placeholder="Describe el motivo por el que procedes sin contrato firmado..."
              value={contractReasonText} onChange={e => setContractReasonText(e.target.value)} />
            <div style={{ fontSize: 12, color: ok ? 'var(--green)' : 'var(--text2)', marginTop: 4 }}>
              {words} / 15 palabras {ok ? '✓' : ''}
            </div>
          </Modal>
        )
      })()}
      {showCheckoutRating && (
        <Modal title="Antes de cerrar…" onClose={() => setShowCheckoutRating(false)} footer={
          <>
            <button className="btn btn-ghost" onClick={() => setShowCheckoutRating(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={confirmCheckOut}>Confirmar check-out</button>
          </>
        }>
          <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 14 }}>
            ¿Cómo valoras a este huésped? Es opcional — con 5★ le mandamos un email de agradecimiento
            pidiéndole una reseña.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <span style={{ display: 'inline-flex', gap: 6 }}>
              {[1, 2, 3, 4, 5].map(n => (
                <span key={n}
                  style={{ fontSize: 28, cursor: 'pointer', color: n <= checkoutRating ? '#f59e0b' : 'var(--border)' }}
                  onClick={() => setCheckoutRating(n === checkoutRating ? 0 : n)}>★</span>
              ))}
            </span>
          </div>
        </Modal>
      )}
      {showContract && (
        <ContractModal reservationId={res.id} onClose={() => { setShowContract(false); load() }} />
      )}
      {showPayment && (
        <AddPaymentModal reservationId={res.id} accounts={accounts} due={due}
          onClose={() => setShowPayment(false)} onSaved={() => { setShowPayment(false); load() }} />
      )}
      {showDeposit && (
        <AddDepositModal reservationId={res.id} accounts={accounts}
          onClose={() => setShowDeposit(false)} onSaved={() => { setShowDeposit(false); load() }} />
      )}
      {cobrarDeposit && (
        <CobrarDepositModal deposit={cobrarDeposit} accounts={accounts}
          onClose={() => setCobrarDeposit(null)} onSaved={() => { setCobrarDeposit(null); load() }} />
      )}
      {showBlacklist && g.id && (
        <BlacklistModal guestId={g.id} guestName={`${g.firstName} ${g.lastName}`}
          currentReason={g.blacklistReason} currentSeverity={g.blacklistSeverity}
          onClose={() => setShowBlacklist(false)} onSaved={() => { setShowBlacklist(false); load() }} />
      )}
      {showExtra && (
        <AddExtraModal reservationId={res.id}
          onClose={() => setShowExtra(false)} onSaved={() => { setShowExtra(false); load() }} />
      )}
      {showEditGuest && g.id && (
        <EditGuestModal
          guest={g}
          reservation={{ id: res.id, checkInDate: res.checkInDate, status: res.status, sesSubmittedAt: (res as any).sesSubmittedAt, bookingChannelName: (res as any).bookingChannel?.name, zktecoConfigured, zktecoCardNo: hasActiveZktecoCard ? zktecoCardNo : null }}
          onClose={() => setShowEditGuest(false)}
          onSaved={async () => { await syncPeople(additionalGuests.length + 1); setShowEditGuest(false); load(); window.dispatchEvent(new CustomEvent('reservation:changed')) }}
        />
      )}
      {showAddGuest && (
        <AddGuestModal
          reservationId={res.id}
          groupRooms={groupRooms.filter((r: any) => !lockedRoomIds.includes(r.id))}
          titularAddress={{
            address1:           g.address1           ?? '',
            zipCode:            g.zipCode            ?? '',
            city:               g.city               ?? '',
            cityIneCode:        g.cityIneCode         ?? '',
            addressCountryCode: g.addressCountryCode  ?? 'ES',
            phone:              g.phone               ?? '',
            email:              isBookingAlias(g.email) ? '' : (g.email ?? ''),
          }}
          onClose={() => setShowAddGuest(false)}
          onSaved={async () => {
            // additionalGuests tiene el estado ANTES de añadir; el total correcto es length+2
            await syncPeople(additionalGuests.length + 2)
            setShowAddGuest(false); load(); window.dispatchEvent(new CustomEvent('reservation:changed'))
          }}
        />
      )}
      {showChangeTitular && (
        <AddGuestModal
          mode="primary"
          reservationId={res.id}
          titularAddress={{
            address1:           g.address1           ?? '',
            zipCode:            g.zipCode            ?? '',
            city:               g.city               ?? '',
            cityIneCode:        g.cityIneCode         ?? '',
            addressCountryCode: g.addressCountryCode  ?? 'ES',
            phone:              g.phone               ?? '',
            email:              isBookingAlias(g.email) ? '' : (g.email ?? ''),
          }}
          onClose={() => setShowChangeTitular(false)}
          onSaved={() => { setShowChangeTitular(false); load(); window.dispatchEvent(new CustomEvent('reservation:changed')) }}
        />
      )}
      {showFeedback && (
        <FeedbackModal
          reservationId={res.id}
          guestId={res.guestId}
          onClose={() => setShowFeedback(false)}
          onSaved={() => setShowFeedback(false)}
        />
      )}
      {removeExtraRoomModal && (
        <RemoveExtraRoomModal
          roomCode={removeExtraRoomModal.code}
          onClose={() => setRemoveExtraRoomModal(null)}
          onConfirm={async (reason) => { await removeExtraRoom(removeExtraRoomModal.roomId, reason); setRemoveExtraRoomModal(null) }}
        />
      )}
      {showCancelModal && (
        <CancelReservationModal
          onClose={() => setShowCancelModal(false)}
          onConfirm={async (reason) => { await doCancelWithReason(reason); setShowCancelModal(false) }}
        />
      )}
      {editingAdditional && (
        <EditGuestModal
          guest={editingAdditional}
          reservation={{ id: res.id, checkInDate: res.checkInDate, status: res.status, sesSubmittedAt: true }}
          onClose={() => setEditingAdditional(null)}
          onSaved={async () => { await syncPeople(additionalGuests.length + 1); setEditingAdditional(null); load(); window.dispatchEvent(new CustomEvent('reservation:changed')) }}
        />
      )}
      {showExtend && (
        <ExtendReservationModal
          res={res}
          onClose={() => setShowExtend(false)}
          onSaved={() => { setShowExtend(false); load(); window.dispatchEvent(new CustomEvent('reservation:changed')) }}
        />
      )}
      {showChangeRoom && (
        <ChangeRoomModal
          res={res}
          onClose={() => setShowChangeRoom(false)}
          onMoved={() => { setShowChangeRoom(false); load(); window.dispatchEvent(new CustomEvent('reservation:changed')) }}
        />
      )}
      {showChangeStatus && (
        <ChangeStatusModal
          res={res}
          onClose={() => setShowChangeStatus(false)}
          onChanged={() => { setShowChangeStatus(false); load(); window.dispatchEvent(new CustomEvent('reservation:changed')) }}
        />
      )}
      {showSplit && (
        <SplitReservationModal
          res={res}
          onClose={() => setShowSplit(false)}
          onSplit={(newId) => { setShowSplit(false); load(); toast(`Reserva partida — continuación #${newId}`); window.dispatchEvent(new CustomEvent('reservation:changed')) }}
        />
      )}
      {showAddExtraRoom && (
        <AddExtraRoomModal
          res={res}
          isAdmin={isAdmin}
          onClose={() => setShowAddExtraRoom(false)}
          onAdded={(newExtraRoomIds) => {
            setShowAddExtraRoom(false)
            // Local en vez de load() completo — igual que al quitar una.
            setRes((prev: any) => prev && ({ ...prev, extraRoomIds: newExtraRoomIds }))
            refreshHistory()
            window.dispatchEvent(new CustomEvent('reservation:changed'))
          }}
        />
      )}
    </>
  )
}

// ─── Modal: editar datos de factura ──────────────────────────────────────────

type InvoiceLineItem = { description: string; quantity: number; unitPrice: number }

export function EditInvoiceModal({ invoice, onClose, onSaved }: {
  invoice: any
  onClose: () => void
  onSaved: (updated: any) => void
}) {
  const { user } = useAuth()
  const { currency } = useProperty()
  const admin = canManage(user)
  const [form, setForm] = useState({
    invoiceNumber:  invoice.invoiceNumber  ?? '',
    issuedAt:       invoice.issuedAt       ?? '',
    billingName:    invoice.billingName    ?? '',
    billingNif:     invoice.billingNif     ?? '',
    billingAddress: invoice.billingAddress ?? '',
    notes:          invoice.notes          ?? '',
    total:          invoice.total          ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [editingItems, setEditingItems] = useState(false)
  const initItems = (): InvoiceLineItem[] => {
    const stored = invoice.lineItems
    if (Array.isArray(stored) && stored.length > 0) return stored
    return [{ description: '', quantity: 1, unitPrice: parseFloat(invoice.total ?? '0') }]
  }
  const [lineItems, setLineItems] = useState<InvoiceLineItem[]>(initItems)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const itemsTotal = lineItems.reduce((s, i) => s + (i.quantity || 0) * (i.unitPrice || 0), 0)

  const setItem = (idx: number, field: keyof InvoiceLineItem, value: string | number) =>
    setLineItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it))

  const addItem = () => setLineItems(prev => [...prev, { description: '', quantity: 1, unitPrice: 0 }])
  const removeItem = (idx: number) => setLineItems(prev => prev.filter((_, i) => i !== idx))

  const save = async () => {
    if (!form.invoiceNumber.trim()) { toast('El número de factura no puede estar vacío', 'err'); return }
    setSaving(true)
    try {
      const body: Record<string, any> = {
        billingName:    form.billingName    || null,
        billingNif:     form.billingNif     || null,
        billingAddress: form.billingAddress || null,
        notes:          form.notes          || null,
      }
      if (admin && form.invoiceNumber !== invoice.invoiceNumber) {
        body.invoiceNumber = form.invoiceNumber.trim()
      }
      if (admin && form.issuedAt && form.issuedAt !== invoice.issuedAt) {
        body.issuedAt = form.issuedAt
      }
      if (admin && editingItems) {
        const validItems = lineItems.filter(i => i.description.trim() && i.quantity > 0 && i.unitPrice >= 0)
        body.lineItems = validItems.length > 0 ? validItems : null
      } else {
        const newTotal = parseFloat(form.total)
        if (admin && !isNaN(newTotal) && newTotal > 0 && String(newTotal) !== invoice.total) {
          body.total = newTotal
        }
      }
      const r = await fetch(`/api/financial/invoices/${invoice.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error al guardar')
      toast('Factura actualizada')
      onSaved(d.data)
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  const inputSt: React.CSSProperties = { padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text1)', fontSize: 13, outline: 'none', width: '100%' }

  return (
    <Modal title={`Editar factura ${invoice.invoiceNumber}`} onClose={onClose}>
      <div className="form-grid">
        {admin && (
          <div className="form-group full">
            <label>Número de factura</label>
            <input value={form.invoiceNumber} onChange={set('invoiceNumber')} placeholder="0000001/2026" />
          </div>
        )}
        {admin && (
          <div className="form-group">
            <label>Fecha de emisión</label>
            <input type="date" value={form.issuedAt} onChange={set('issuedAt')} />
          </div>
        )}
        {admin && !editingItems && (
          <div className="form-group">
            <label>Total factura</label>
            <input type="number" step="0.01" min="0.01" value={form.total} onChange={set('total')} placeholder={invoice.total} />
          </div>
        )}
        {admin && editingItems && (
          <div className="form-group">
            <label>Total (calculado)</label>
            <input type="number" value={itemsTotal.toFixed(2)} readOnly
              style={{ ...inputSt, background: 'var(--bg2)', color: 'var(--text2)', cursor: 'default' }} />
          </div>
        )}
        <div className="form-group full">
          <label>Nombre / Razón social</label>
          <input value={form.billingName} onChange={set('billingName')} placeholder="Empresa S.L. o nombre completo" />
        </div>
        <div className="form-group">
          <label>CIF / NIF</label>
          <input value={form.billingNif} onChange={set('billingNif')} placeholder="B12345678" maxLength={20} />
        </div>
        <div className="form-group">
          <label>Dirección fiscal</label>
          <input value={form.billingAddress} onChange={set('billingAddress')} placeholder="C/ Ejemplo 1, 18001 Granada" />
        </div>
        <div className="form-group full">
          <label>Notas de la factura</label>
          <textarea value={form.notes} onChange={set('notes')} rows={3} placeholder="Observaciones que aparecerán en la factura…" style={{ resize: 'vertical' }} />
        </div>
      </div>

      {/* ── Conceptos (solo admin) ── */}
      {admin && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: editingItems ? 12 : 0 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>
              Conceptos de la factura
              {!editingItems && invoice.lineItems && Array.isArray(invoice.lineItems) && invoice.lineItems.length > 0 && (
                <span style={{ marginLeft: 6, fontWeight: 400, color: 'var(--text2)', fontSize: 12 }}>
                  ({invoice.lineItems.length} concepto{invoice.lineItems.length > 1 ? 's' : ''})
                </span>
              )}
            </span>
            <button type="button" className="btn btn-ghost btn-sm"
              onClick={() => { setEditingItems(v => !v); if (!editingItems) setLineItems(initItems()) }}>
              {editingItems ? '✕ Cancelar edición' : 'Editar conceptos'}
            </button>
          </div>

          {editingItems && (
            <div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)' }}>
                      <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text3)', borderBottom: '1px solid var(--border)' }}>Descripción</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right', width: 70, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text3)', borderBottom: '1px solid var(--border)' }}>Cant.</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right', width: 100, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text3)', borderBottom: '1px solid var(--border)' }}>P. unit.</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right', width: 90, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text3)', borderBottom: '1px solid var(--border)' }}>Total</th>
                      <th style={{ padding: '6px 8px', width: 32, borderBottom: '1px solid var(--border)' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((item, idx) => (
                      <tr key={idx}>
                        <td style={{ padding: '4px 8px 4px 0', borderBottom: '1px solid var(--border-subtle, var(--border))' }}>
                          <input style={inputSt} value={item.description}
                            placeholder="Ej: Alojamiento 3 noches…"
                            onChange={e => setItem(idx, 'description', e.target.value)} />
                        </td>
                        <td style={{ padding: '4px 4px', borderBottom: '1px solid var(--border-subtle, var(--border))' }}>
                          <input style={{ ...inputSt, textAlign: 'right' }} type="number" min="0.01" step="0.01"
                            value={item.quantity}
                            onChange={e => setItem(idx, 'quantity', parseFloat(e.target.value) || 0)} />
                        </td>
                        <td style={{ padding: '4px 4px', borderBottom: '1px solid var(--border-subtle, var(--border))' }}>
                          <input style={{ ...inputSt, textAlign: 'right' }} type="number" min="0" step="0.01"
                            value={item.unitPrice}
                            onChange={e => setItem(idx, 'unitPrice', parseFloat(e.target.value) || 0)} />
                        </td>
                        <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border-subtle, var(--border))', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text2)' }}>
                          {fmtMoney((item.quantity || 0) * (item.unitPrice || 0), currency)}
                        </td>
                        <td style={{ padding: '4px 0 4px 4px', borderBottom: '1px solid var(--border-subtle, var(--border))' }}>
                          <button type="button" onClick={() => removeItem(idx)}
                            disabled={lineItems.length <= 1}
                            style={{ background: 'none', border: 'none', cursor: lineItems.length <= 1 ? 'default' : 'pointer', color: lineItems.length <= 1 ? 'var(--text3)' : 'var(--red, #ef4444)', fontSize: 16, padding: '0 4px', lineHeight: 1 }}>
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3} style={{ padding: '8px 8px 4px 0', textAlign: 'right', fontWeight: 600, fontSize: 13 }}>Total:</td>
                      <td style={{ padding: '8px 8px 4px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(itemsTotal, currency)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={addItem} style={{ marginTop: 8 }}>
                + Añadir línea
              </button>
            </div>
          )}
        </div>
      )}

      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </Modal>
  )
}

// ─── Helper: imprimir factura ─────────────────────────────────────────────────


// ─── Modal: editar huésped (campos SES + dirección) ──────────────────────────

type EditGuestReservation = { id: number; checkInDate: string; status: string; sesSubmittedAt: any; bookingChannelName?: string; zktecoConfigured?: boolean; zktecoCardNo?: string | null }

const FREE_DOMAINS = new Set([
  'gmail.com','hotmail.com','hotmail.es','yahoo.com','yahoo.es','outlook.com','outlook.es',
  'live.com','live.es','icloud.com','me.com','protonmail.com','proton.me','aol.com',
  'msn.com','gmx.com','gmx.es','ymail.com','tutanota.com',
])
const OTA_CHANNEL_NAMES = ['booking','airbnb','expedia','agoda','hotelbeds','trivago','despegar','lastminute']

function norm(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
}

function detectSuspiciousEmail(
  newEmail: string,
  prevEmail: string | null | undefined,
  firstName: string,
  lastName: string,
  channelName: string,
): boolean {
  // Solo aplica si el email anterior era un alias de OTA
  const wasAlias = !!prevEmail && /@guest\.(booking|airbnb|expedia)\.com$/i.test(prevEmail.trim())
  if (!wasAlias) return false

  const isOta  = OTA_CHANNEL_NAMES.some(n => channelName.toLowerCase().includes(n))
  if (!isOta) return false

  const [user = '', domain = ''] = newEmail.toLowerCase().split('@')
  const isFree = FREE_DOMAINS.has(domain)
  if (!isFree) return false

  const normUsr = norm(user)
  const normFn  = norm(firstName)
  const normLn  = norm(lastName)

  const matchName = normFn.length >= 3 && (normUsr.includes(normFn) || normFn.includes(normUsr))
  const matchLast = normLn.length >= 3 && (normUsr.includes(normLn) || normLn.includes(normUsr))
  const veryShort = normUsr.length <= 5

  return matchName || matchLast || veryShort
}

function EditGuestModal({ guest, reservation, onClose, onSaved }: {
  guest: any
  reservation: EditGuestReservation
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    firstName:           guest.firstName          ?? '',
    lastName:            guest.lastName           ?? '',
    secondLastName:      guest.secondLastName      ?? '',
    gender:              guest.gender             ?? 'unspecified',
    dateOfBirth:         guest.dateOfBirth        ?? '',
    nationality:         guest.nationality        ?? '',
    idDocType:           guest.idDocType          ?? '',
    idDocNumber:         guest.idDocNumber        ?? '',
    idDocSupportNumber:  guest.idDocSupportNumber ?? '',
    idDocIssueDate:      guest.idDocIssueDate     ?? '',
    idDocExpiryDate:     guest.idDocExpiryDate    ?? '',
    email:               guest.email              ?? '',
    phone:               guest.phone              ?? '',
    address1:              guest.address1              ?? '',
    zipCode:               guest.zipCode               ?? '',
    city:                  guest.city                  ?? '',
    cityIneCode:           guest.cityIneCode           ?? '',
    addressCountryCode:    guest.addressCountryCode     ?? 'ES',
  })
  const [saving,         setSaving]         = useState(false)
  const [phase,          setPhase]          = useState<'edit' | 'suggest'>('edit')
  const [actioning,      setActioning]      = useState(false)
  const [docError,       setDocError]       = useState('')
  const [emailChallenge, setEmailChallenge] = useState(false)
  const [pendingSave,    setPendingSave]    = useState<(() => Promise<void>) | null>(null)
  const [cityValid, setCityValid] = useState(true)
  const [munValid,  setMunValid]  = useState(true)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const [warningInfo, setWarningInfo] = useState<{ missing: string[]; onDismiss: () => void } | null>(null)

  const buildMissingList = () => {
    const m: string[] = []
    if (!form.firstName)                                                                     m.push('nombre')
    if (!form.lastName)                                                                      m.push('apellido')
    if (!form.dateOfBirth)                                                                   m.push('fecha de nacimiento')
    if (!form.email && !form.phone)                                                          m.push('email o teléfono')
    if (!form.idDocType)                                                                     m.push('tipo de documento')
    if (!form.idDocNumber)                                                                   m.push('nº de documento')
    if (form.idDocType === 'dni' || form.idDocType === 'nie') {
      if (!form.idDocSupportNumber) m.push('nº soporte')
      else if (!/^[A-Z]{3}[0-9]{6}$/.test(form.idDocSupportNumber)) m.push('nº soporte inválido (3 letras + 6 dígitos)')
    }
    if (!form.nationality)                                                                   m.push('nacionalidad')
    if (!form.address1)                                                                      m.push('dirección')
    if (!form.zipCode)                                                                       m.push('código postal')
    if (!form.city)                                                                          m.push('municipio')
    if (form.addressCountryCode === 'ES' && !form.cityIneCode)                              m.push('código INE municipio')
    return m
  }

  const warnAndClose = (cb: () => void) => {
    const m = buildMissingList()
    if (m.length > 0) {
      setWarningInfo({ missing: m, onDismiss: () => { setWarningInfo(null); cb() } })
    } else {
      cb()
    }
  }

  const handleClose = () => {
    if (warningInfo) return
    warnAndClose(onClose)
  }

  const validateDoc = () => {
    const err = validateIdDocNumber(form.idDocType, form.idDocNumber)
    setDocError(err ?? ''); return !err
  }

  const todayStr = new Date().toISOString().slice(0, 10)
  const checkinToday = reservation.checkInDate === todayStr
    && reservation.status === 'confirmed'
    && !reservation.sesSubmittedAt

  const doSave = async (confirmedFake = false) => {
    setSaving(true)
    try {
      const body: any = { ...form }
      const NULLABLE_FIELDS = ['secondLastName']
      for (const k of Object.keys(body)) {
        if (NULLABLE_FIELDS.includes(k)) {
          if (body[k] === '') body[k] = null
        } else if (body[k] === '' || body[k] === null) {
          delete body[k]
        }
      }
      if (!body.idDocType) delete body.idDocType
      const r = await fetch(`/api/guests/${guest.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(body),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(apiErr(data, 'Error al guardar'))
      if (confirmedFake) {
        await api.addNote(reservation.id,
          `⚠️ Email registrado tras advertencia del sistema: "${form.email}" — recepcionista confirmó que el cliente lo proporcionó personalmente. Registrado automáticamente para trazabilidad.`
        )
      }
      toast('Huésped actualizado')
      if (checkinToday) {
        warnAndClose(() => setPhase('suggest'))
      } else {
        warnAndClose(onSaved)
      }
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  const save = async () => {
    if (!validateDoc()) return
    if (isBookingAlias(form.email)) {
      toast('Sustituye el email @guest.booking.com por el email real del cliente antes de guardar', 'err')
      return
    }
    const isES = form.addressCountryCode === 'ES'
    const COUNTRY_LIST = COUNTRIES as Country[]
    if (form.addressCountryCode && !COUNTRY_LIST.some(c => c.code === form.addressCountryCode)) {
      toast('País no válido: selecciónalo del desplegable', 'err'); return
    }
    if (isES && form.city && form.zipCode && !cityValid && !form.cityIneCode) {
      toast('Ciudad/CP no válido: selecciónalo del desplegable', 'err'); return
    }
    if (isES && !form.cityIneCode) {
      toast('Debes seleccionar un municipio de la lista antes de guardar', 'err'); return
    }
    if (isES && !munValid && !/^\d{5}$/.test(form.cityIneCode)) {
      toast('Municipio INE no válido: selecciónalo del desplegable', 'err'); return
    }
    if (!form.address1 || !form.zipCode || !form.city) {
      toast('Dirección incompleta: falta calle, CP o ciudad', 'warn')
    }
    // Detección de email inventado: alias OTA → dominio gratuito parecido al nombre
    if (form.email && detectSuspiciousEmail(
      form.email, guest.email, form.firstName, form.lastName,
      reservation.bookingChannelName ?? '',
    )) {
      setEmailChallenge(true)
      return
    }
    await doSave(false)
  }

  const doCheckinAndSes = async () => {
    if (reservation.zktecoConfigured && !reservation.zktecoCardNo) {
      toast('Hay una tarjeta ZKTeco pendiente de enrolar. Completa el check-in desde el botón principal para gestionar la advertencia.', 'err')
      setActioning(false)
      onSaved()
      return
    }
    setActioning(true)
    try {
      await fetch(`/api/reservations/${reservation.id}/check-in`, { method: 'POST', credentials: 'include' })
      const sesRes = await fetch(`/api/ses/submit/${reservation.id}`, { method: 'POST', credentials: 'include' })
      const sesData = await sesRes.json()
      if (!sesRes.ok) {
        if (sesData.missingFields) {
          const msgs = (sesData.missingFields as any[]).map((f: any) => f.message).join(', ')
          toast(`Check-in hecho · SES: faltan datos — ${msgs}`, 'err')
        } else {
          toast(`Check-in hecho · SES: ${sesData.error ?? 'Error'}`, 'err')
        }
      } else {
        toast(`Check-in realizado · Parte SES enviado (lote: ${sesData.data?.lote})`)
      }
      onSaved()
    } catch (e: any) { toast(e.message, 'err'); setActioning(false) }
  }

  const needsSoporte = form.idDocType === 'dni' || form.idDocType === 'nie'

  if (emailChallenge) {
    return (
      <Modal
        title="⚠️ Email sospechoso"
        onClose={() => setEmailChallenge(false)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setEmailChallenge(false)}>
              Voy a pedírselo al cliente
            </button>
            <button className="btn btn-ghost" onClick={() => {
              setForm(f => ({ ...f, email: guest.email ?? '' }))
              setEmailChallenge(false)
            }}>
              No ha dado correo — mantener el de Booking
            </button>
            <button className="btn btn-danger" disabled={saving} onClick={async () => {
              setEmailChallenge(false)
              await doSave(true)
            }}>
              {saving ? 'Guardando…' : 'El cliente me lo ha dado personalmente'}
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{
            background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)',
            borderRadius: 8, padding: '14px 16px',
          }}>
            <p style={{ margin: '0 0 8px', fontWeight: 700, color: 'var(--red)', fontSize: 15 }}>
              No está permitido inventarse correos electrónicos para las reservas y se va a registrar.
            </p>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text1)', lineHeight: 1.5 }}>
              El email <strong>{form.email}</strong> parece inventado: sustituye un alias temporal de {reservation.bookingChannelName ?? 'una OTA'} por un dominio de correo gratuito con un nombre similar al del huésped. Si guardas sin que el cliente te lo haya dado, quedará registrado con tu nombre y hora.
            </p>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text2)' }}>
            Si el cliente no te ha dado su email, pulsa <strong>"Voy a pedírselo"</strong> y solicítaselo directamente.
          </p>
        </div>
      </Modal>
    )
  }

  if (phase === 'suggest') {
    return (
      <Modal title="Huésped guardado" onClose={() => warnAndClose(onSaved)} footer={
        <>
          <button className="btn btn-ghost" onClick={() => warnAndClose(onSaved)} disabled={actioning}>
            Solo guardar
          </button>
          <button className="btn btn-green" onClick={doCheckinAndSes} disabled={actioning}>
            {actioning ? 'Procesando…' : 'Hacer check-in + enviar SES'}
          </button>
        </>
      }>
        <div style={{ padding: '8px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>Datos del huésped actualizados</p>
          <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 20 }}>
            Esta reserva tiene entrada <strong>hoy</strong>.<br />
            ¿Quieres hacer el check-in y enviar el parte de viajero al SES ahora?
          </p>
          <div style={{
            background: 'var(--bg3)', borderRadius: 8, padding: '10px 16px',
            fontSize: 12, color: 'var(--text2)', textAlign: 'left',
          }}>
            <div>· Cambio de estado → <strong>En casa</strong></div>
            <div>· Envío automático al <strong>SES Hospedajes</strong></div>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Editar datos del huésped" onClose={handleClose} footer={
      warningInfo ? (
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={warningInfo.onDismiss}>
          Entendido
        </button>
      ) : (
        <><button className="btn btn-ghost" onClick={handleClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
      )
    }>
      {warningInfo ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '32px 16px', gap: 16 }}>
          <div style={{ fontSize: 44 }}>⚠️</div>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 16 }}>Faltan datos obligatorios</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text2)' }}>
            Los siguientes campos son obligatorios para el envío al SES Hospedajes:
          </p>
          <ul style={{ margin: 0, textAlign: 'left', paddingLeft: 20, lineHeight: 1.8 }}>
            {warningInfo.missing.map(f => <li key={f}>{f}</li>)}
          </ul>
        </div>
      ) : (
      <div className="form-grid">
        <div className="form-group">
          <label>Nombre *</label>
          <input value={form.firstName} onChange={set('firstName')} autoFocus autoComplete="off" />
        </div>
        <div className="form-group">
          <label>Primer apellido *</label>
          <input value={form.lastName} onChange={set('lastName')} autoComplete="off" />
        </div>
        <div className="form-group">
          <label>Segundo apellido</label>
          <input value={form.secondLastName} onChange={set('secondLastName')} autoComplete="off" />
        </div>
        <div className="form-group">
          <label>Sexo</label>
          <select value={form.gender} onChange={set('gender')}>
            <option value="unspecified">—</option>
            <option value="male">Hombre</option>
            <option value="female">Mujer</option>
            <option value="non_binary">No binario</option>
          </select>
        </div>
        <div className="form-group">
          <label>Fecha de nacimiento</label>
          <input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} />
        </div>
        <div className="form-group">
          <label>Nacionalidad</label>
          <CountryPicker value={form.nationality} onChange={code => setForm(f => ({ ...f, nationality: code }))} />
        </div>
        <div className="form-group">
          <label>Email</label>
          <input type="email" value={form.email} onChange={set('email')}
            style={isBookingAlias(form.email) ? { borderColor: 'var(--red)' } : undefined} />
          {isBookingAlias(form.email) && (
            <span style={{ fontSize: 11, color: 'var(--red)', marginTop: 2, display: 'block' }}>
              ⚠ Email temporal de Booking (caduca tras la estancia). Pídele al cliente su email real — no se puede guardar ni hacer check-in con este.
            </span>
          )}
        </div>
        <div className="form-group">
          <label>Teléfono</label>
          <input type="tel" value={form.phone} onChange={set('phone')} />
        </div>

        <div className="form-group full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
          <label style={{ fontWeight: 600, fontSize: 12, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Documento de identidad
          </label>
        </div>
        <div className="form-group">
          <label>Tipo</label>
          <select value={form.idDocType} onChange={set('idDocType')}>
            <option value="">—</option>
            <option value="dni">DNI</option>
            <option value="nie">NIE</option>
            <option value="passport">Pasaporte</option>
            <option value="driving_licence">Carnet de conducir</option>
            <option value="other">Otro</option>
          </select>
        </div>
        <div className="form-group">
          <label>Número</label>
          <input
            value={form.idDocNumber}
            onChange={e => { set('idDocNumber')(e); setDocError('') }}
            onBlur={validateDoc}
            style={{ textTransform: 'uppercase', borderColor: docError ? 'var(--red)' : '' }}
          />
          {docError && <span style={{ fontSize: 11, color: 'var(--red)', marginTop: 3, display: 'block' }}>{docError}</span>}
        </div>
        {needsSoporte && (
          <div className="form-group">
            <label>Nº soporte <span style={{ fontSize: 10, color: 'var(--yellow)' }}>requerido NIF/NIE</span></label>
            <input value={form.idDocSupportNumber} onChange={set('idDocSupportNumber')} />
          </div>
        )}
        <div className="form-group">
          <label>Fecha de expedición</label>
          <input type="date" value={form.idDocIssueDate} onChange={set('idDocIssueDate')} />
        </div>
        <div className="form-group">
          <label>Fecha de caducidad</label>
          <input type="date" value={form.idDocExpiryDate} onChange={set('idDocExpiryDate')} />
        </div>

        <div className="form-group full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
          <label style={{ fontWeight: 600, fontSize: 12, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Dirección
          </label>
        </div>
        <div className="form-group full">
          <AddressAutocomplete onSelect={a => {
            // Cruce con el catálogo INE: primero exacto (norm), luego includes como fallback
            let ine = ''
            if (a.countryCode === 'ES' && a.city) {
              const nc = normalizeTxt(a.city)
              const exact = MUNI_LIST.find(m => normalizeTxt(m.name) === nc)
              if (exact) {
                ine = exact.code
              } else {
                const fuzzy = MUNI_LIST.filter(m => normalizeTxt(m.name).includes(nc) || nc.includes(normalizeTxt(m.name)))
                if (fuzzy.length === 1) ine = fuzzy[0]!.code
              }
            }
            setForm(f => ({
              ...f,
              address1:           a.address1 || f.address1,
              zipCode:            a.zipCode  || f.zipCode,
              city:               a.city     || f.city,
              addressCountryCode: a.countryCode || f.addressCountryCode,
              cityIneCode:        ine || (a.countryCode === 'ES' ? f.cityIneCode : ''),
            }))
            // Google Maps es fuente fiable: los pickers ya muestran los valores correctos
            setCityValid(true)
            if (ine) setMunValid(true)
          }} />
        </div>
        <div className="form-group full">
          <label>Calle / Dirección</label>
          <input value={form.address1} onChange={set('address1')} placeholder="C/ Ejemplo 1" />
        </div>
        <div className="form-group">
          <label>País</label>
          <CountryPicker value={form.addressCountryCode} onChange={code => setForm(f => ({ ...f, addressCountryCode: code }))} />
        </div>
        <div className="form-group">
          <label>Ciudad / Código postal</label>
          <CityPicker
            city={form.city} zipCode={form.zipCode} country={form.addressCountryCode}
            onChange={(city, zip) => setForm(f => ({ ...f, city, zipCode: zip }))}
            onValidChange={setCityValid}
          />
        </div>
        {form.addressCountryCode === 'ES' && (<>
          <div className="form-group">
            <label>Municipio INE</label>
            <MunicipalityPicker
              city={form.city} ineCode={form.cityIneCode}
              onChange={(_city, ineCode) => setForm(f => ({ ...f, cityIneCode: ineCode }))}
              onValidChange={setMunValid}
            />
          </div>
          <div className="form-group">
            <label>Código INE <span style={{ fontSize: 10, color: 'var(--text2)' }}>(5 dígitos)</span></label>
            <input value={form.cityIneCode} onChange={set('cityIneCode')} placeholder="18087" maxLength={5} />
          </div>
        </>)}
      </div>
      )}
    </Modal>
  )
}

// ─── Modal: nota ──────────────────────────────────────────────────────────────

// ─── Modal: contrato de huésped (QR para firmar en el móvil) ──────────────────

function ContractModal({ reservationId, onClose }: { reservationId: number; onClose: () => void }) {
  const [qr, setQr]         = useState('')
  const [url, setUrl]       = useState('')
  const [cid, setCid]       = useState<number | null>(null)
  const [signed, setSigned] = useState(false)
  const [error, setError]   = useState('')

  const generate = () => {
    setSigned(false); setQr(''); setError('')
    api.createContract(reservationId)
      .then(r => {
        setUrl(r.data.url)
        setCid(r.data.id)
        setQr(r.data.qr)
      })
      .catch((e: any) => setError(e.message))
  }

  useEffect(() => {
    // Si ya hay un contrato firmado, mostrarlo en vez de generar un enlace nuevo
    api.listContracts(reservationId)
      .then(r => {
        const s = r.data.find(x => x.status === 'signed')
        if (s) { setCid(s.id); setSigned(true) }
        else generate()
      })
      .catch(() => generate())
  }, [reservationId])

  useEffect(() => {
    if (!cid || signed) return
    const t = setInterval(async () => {
      try {
        const r = await api.listContracts(reservationId)
        if (r.data.find(x => x.id === cid)?.status === 'signed') { setSigned(true); toast('Contrato firmado ✓') }
      } catch {}
    }, 4000)
    return () => clearInterval(t)
  }, [cid, signed, reservationId])

  return (
    <Modal title="Contrato de huésped" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cerrar</button>
        {signed && cid && (
          <button className="btn btn-primary"
            onClick={() => window.open(`/api/reservations/${reservationId}/contracts/${cid}/html`, '_blank')}>
            Ver contrato firmado
          </button>
        )}</>
    }>
      <div style={{ textAlign: 'center' }}>
        {error && <p style={{ color: 'var(--red)' }}>{error}</p>}
        {!error && !qr && <p>Generando enlace…</p>}
        {!error && qr && !signed && (
          <>
            <p style={{ marginTop: 0 }}>El huésped escanea el QR con su móvil y firma con el dedo:</p>
            <img src={qr} alt="QR" style={{ borderRadius: 8 }} />
            <p style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text2)' }}>
              {url}
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }}
                onClick={() => { navigator.clipboard.writeText(url); toast('Enlace copiado') }}>Copiar</button>
            </p>
            <p style={{ fontSize: 12, color: 'var(--text2)' }}>Esperando firma… (se actualiza solo · caduca en 24h)</p>
          </>
        )}
        {signed && (
          <>
            <p style={{ fontSize: 20, fontWeight: 700, color: 'var(--green)' }}>✓ Contrato firmado</p>
            <button className="btn btn-ghost btn-sm" onClick={generate}>Generar nuevo enlace de firma</button>
          </>
        )}
      </div>
    </Modal>
  )
}

function AddNoteModal({ reservationId, onClose, onSaved }: { reservationId: number; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (!note.trim()) return
    setSaving(true)
    try { await api.addNote(reservationId, note); toast('Nota añadida'); onSaved() }
    catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }
  return (
    <Modal title="Añadir nota" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
    }>
      <div className="form-group">
        <label>Nota</label>
        <textarea rows={4} placeholder="Escribe la nota…" value={note}
          onChange={e => setNote(e.target.value)} style={{ width: '100%', resize: 'vertical' }} autoFocus />
      </div>
    </Modal>
  )
}

// ─── Modal: pago ──────────────────────────────────────────────────────────────

function AddPaymentModal({ reservationId, accounts: allAccounts, due, onClose, onSaved }:
  { reservationId: number; accounts: any[]; due: number; onClose: () => void; onSaved: () => void }) {
  // Las cajas de depósitos no son para cobrar pagos de la reserva aquí —
  // tienen su propio flujo (AddDepositModal / CobrarDepositModal, que ya
  // excluye lo mismo), así que no deben aparecer como caja seleccionable
  // al registrar un pago normal.
  const accounts = allAccounts.filter((a: any) =>
    !a.name.toLowerCase().includes('depósito') && !a.name.toLowerCase().includes('deposito')
  )
  const [amount,    setAmount]    = useState('')
  const [method,    setMethod]    = useState('')
  const [methods,   setMethods]   = useState<any[]>([])
  const [accountId, setAccountId] = useState('')
  const [desc,      setDesc]      = useState('')
  const [date,      setDate]      = useState(new Date().toISOString().slice(0, 10))
  const [saving,    setSaving]    = useState(false)
  const [overReason, setOverReason] = useState('')
  const [showOverWarning, setShowOverWarning] = useState(false)

  // "Cobrado en otro turno" — disponible en cuanto hay descripción; pide hora
  // real y quién cobró de verdad (rol recepción), igual que la corrección
  // posterior desde la pestaña Pagos (la fecha ya la da el campo Fecha de arriba).
  const [otherShift,     setOtherShift]     = useState(false)
  const [collectedTime,  setCollectedTime]  = useState('')
  const [paidByUserId,   setPaidByUserId]   = useState('')
  const [receptionUsers, setReceptionUsers] = useState<any[]>([])

  // Tarjeta: exige el nº de pedido/operación de la terminal (para conciliar
  // el pago después) o, si no se tiene a mano, "Cobrado en otro turno" con
  // fecha y hora reales como alternativa — una de las dos, nunca ninguna.
  const [cardOperationNumber, setCardOperationNumber] = useState('')
  // Detecta tarjeta por la CLAVE ("card"/"credit_card", convención habitual
  // en este proyecto — ver scripts/fdm-import.ts) O por la ETIQUETA (por si
  // el admin la escribió con otro texto) — mismo criterio que el backend.
  const isCardMethod = method.toLowerCase().includes('card') || method.toLowerCase().includes('tarjeta')
    || (methods.find((m: any) => m.key === method)?.label?.toLowerCase().includes('tarjeta') ?? false)

  useEffect(() => {
    if (!otherShift || receptionUsers.length > 0) return
    api.listUsers().then((r: any) => {
      setReceptionUsers((r.data ?? []).filter((u: any) => u.active && (u.roles ?? []).includes('recepcion')))
    }).catch(() => {})
  }, [otherShift])

  useEffect(() => {
    api.listPaymentMethods().then((r: any) => {
      const active = (r.data ?? []).filter((m: any) => m.active).sort((a: any, b: any) => a.sortOrder - b.sortOrder)
      setMethods(active)
      setMethod(prev => prev || active.find((m: any) => m.key === 'cash')?.key || active[0]?.key || '')
    }).catch(() => {})
  }, [])

  // Solo las cajas compatibles con la forma de pago elegida
  const visibleAccounts = accountsForMethod(accounts, method)

  useEffect(() => {
    if (!method) return
    const hint  = METHOD_ACCOUNT_HINT[method] ?? ''
    const pool  = accountsForMethod(accounts, method)
    const match = pool.find(a => hint && a.name.toLowerCase().includes(hint.toLowerCase().split(' ')[0]))
    const def   = pool.find(a => a.isDefault)
    setAccountId(String(match?.id ?? def?.id ?? pool[0]?.id ?? ''))
  }, [method, accounts])

  const doSave = async (reason?: string) => {
    setSaving(true)
    try {
      const r = await fetch('/api/financial/transactions', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationId, financialAccountId: Number(accountId),
          amount: parseFloat(amount), paymentMethod: method,
          description: reason ? `${reason}${desc ? ' · ' + desc : ''}` : (desc || undefined),
          transactionDate: date,
          ...(otherShift ? { collectedTime, paidByUserId: Number(paidByUserId) } : {}),
          ...(isCardMethod && cardOperationNumber.trim() ? { cardOperationNumber: cardOperationNumber.trim() } : {}),
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error al registrar el pago')
      toast('Pago registrado'); onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  const save = () => {
    if (!amount || parseFloat(amount) <= 0) { toast('Importe inválido', 'err'); return }
    if (!method) { toast('Selecciona una forma de pago', 'err'); return }
    if (!accountId) { toast('Selecciona una cuenta', 'err'); return }
    if (otherShift) {
      if (!collectedTime) { toast('Indica la hora real del pago', 'err'); return }
      if (!paidByUserId) { toast('Selecciona quién cobró el pago', 'err'); return }
      const payerName = receptionUsers.find((u: any) => String(u.id) === paidByUserId)
      const payerLabel = payerName ? `${payerName.firstName} ${payerName.lastName}` : 'el usuario seleccionado'
      if (!confirm(`¿Confirmas que este pago se cobró en otro turno, el ${date} a las ${collectedTime}, por ${payerLabel}? Quedará registrado como corrección.`)) return
    }
    if (isCardMethod && !cardOperationNumber.trim() && !otherShift) {
      toast('Indica el Nº de pedido/operación, o usa "Cobrado en otro turno" con la fecha y hora', 'err'); return
    }
    if (due <= 0.01) { setShowOverWarning(true); return }
    doSave()
  }

  return (
    <Modal title="Registrar pago" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        {!showOverWarning && <button className="btn btn-primary" onClick={save} disabled={saving}>Registrar</button>}</>
    }>
      <div className="form-grid">
        <div className="form-group">
          <label>Importe *</label>
          <div style={{ position: 'relative' }}>
            <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
              min="0.01" step="0.01" placeholder="0.00" autoFocus style={{ paddingRight: 28 }} />
            <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text2)' }}>€</span>
          </div>
        </div>
        <div className="form-group">
          <label>Fecha</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="form-group full">
          <label>Forma de pago *</label>
          <div className="payment-method-grid">
            {methods.map((m: any) => (
              <button key={m.key} className={`payment-method-btn${method === m.key ? ' active' : ''}`}
                onClick={() => setMethod(m.key)}>{m.label}</button>
            ))}
          </div>
        </div>
        <div className="form-group full">
          <label>Cuenta / Caja</label>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}>
            {visibleAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        {isCardMethod && (
          <div className="form-group full">
            <label>Nº pedido/operación {!otherShift && '*'}</label>
            <input value={cardOperationNumber} onChange={e => setCardOperationNumber(e.target.value)}
              placeholder="Nº de la terminal/recibo de tarjeta" />
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>
              Obligatorio en pagos con tarjeta — si no lo tienes a mano, usa "Cobrado en otro turno" abajo con la fecha y hora reales.
            </span>
          </div>
        )}
        <div className="form-group full">
          <label>Descripción (opcional)</label>
          <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Ej: anticipo, saldo final…" />
        </div>
        <div className="form-group full">
          <label className="rate-toggle">
            <input type="checkbox" checked={otherShift}
              onChange={e => setOtherShift(e.target.checked)} />
            Cobrado en otro turno
          </label>
        </div>
        {otherShift && (
          <>
            <div className="form-group">
              <label>Hora real del pago</label>
              <input type="time" value={collectedTime} onChange={e => setCollectedTime(e.target.value)} />
            </div>
            <div className="form-group">
              <label>¿Quién cobró el pago?</label>
              <select value={paidByUserId} onChange={e => setPaidByUserId(e.target.value)}>
                <option value="">— Selecciona —</option>
                {receptionUsers.map((u: any) => (
                  <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
                ))}
              </select>
              {receptionUsers.length === 0 && (
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>No hay usuarios activos con rol de recepción</span>
              )}
            </div>
          </>
        )}
        {showOverWarning && (
          <div className="form-group full" style={{
            padding: '12px 14px', borderRadius: 8,
            background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.4)',
          }}>
            <label style={{ color: 'var(--red)', fontWeight: 600, marginBottom: 6, display: 'block' }}>
              ⚠️ Esta reserva no tiene saldo pendiente — explica el motivo (mín. 15 palabras)
            </label>
            <textarea rows={3} value={overReason} onChange={e => setOverReason(e.target.value)}
              placeholder="Explica por qué se registra este pago sin saldo pendiente…"
              style={{ width: '100%', resize: 'vertical', fontSize: 13 }} autoFocus />
            <div style={{ fontSize: 12, color: overReason.trim().split(/\s+/).filter(Boolean).length >= 15 ? 'var(--green)' : 'var(--text3)', marginTop: 4 }}>
              {overReason.trim().split(/\s+/).filter(Boolean).length} / 15 palabras
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowOverWarning(false)}>Cancelar</button>
              <button className="btn btn-primary btn-sm"
                disabled={saving || overReason.trim().split(/\s+/).filter(Boolean).length < 15}
                onClick={() => doSave(overReason.trim())}>Confirmar pago</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ─── Modal: descripción de una transacción ────────────────────────────────────
// La misma descripción de siempre del pago — editable después de creado desde
// esta pestaña. Rellenarla es el requisito para poder usar el toggle
// "Cobrado en otro turno" de esa misma fila (ver tab Transacciones).

function TransactionDescriptionModal({ tx, onClose, onSaved }: { tx: any; onClose: () => void; onSaved: () => void }) {
  const [description, setDescription] = useState(tx.description ?? '')
  const [saving,       setSaving]      = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await api.updateTransaction(tx.id, { description })
      toast('Descripción guardada'); onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title="Descripción del pago" onClose={onClose} footer={
      <>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button>
      </>
    }>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 10 }}>
        Hace falta una descripción para poder usar después el toggle "Cobrado en otro turno".
      </p>
      <textarea autoFocus rows={4} value={description} onChange={e => setDescription(e.target.value)}
        placeholder="Ej: anticipo, saldo final…"
        style={{ width: '100%', resize: 'vertical', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', fontSize: 13 }} />
    </Modal>
  )
}

// ─── Modal: corregir fecha/hora/usuario real de cobro ("Cobrado en otro turno") ─
// Solo llegable con una descripción ya guardada en la transacción (gate en la
// tabla de arriba, y revalidado en el servidor). Registra la corrección en
// payment_date_corrections (fecha/usuario ANTERIORES) para poder sacar
// informes de pagos corregidos por usuario más adelante.

function localDateTimeParts(iso?: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

function CorrectPaymentDateModal({ tx, onClose, onSaved }: { tx: any; onClose: () => void; onSaved: () => void }) {
  const existing = localDateTimeParts(tx.collectedAt)
  const [receptionUsers, setReceptionUsers] = useState<any[]>([])
  const [date,   setDate]   = useState(existing.date || tx.transactionDate)
  const [time,   setTime]   = useState(existing.time)
  const [userId, setUserId] = useState(tx.paidByUserId ? String(tx.paidByUserId) : '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.listUsers().then((r: any) => {
      setReceptionUsers((r.data ?? []).filter((u: any) => u.active && (u.roles ?? []).includes('recepcion')))
    }).catch(() => {})
  }, [])

  const save = async () => {
    if (!date || !time) { toast('Indica fecha y hora', 'err'); return }
    if (!userId) { toast('Selecciona quién cobró el pago', 'err'); return }
    const payerName = receptionUsers.find((u: any) => String(u.id) === userId)
    const payerLabel = payerName ? `${payerName.firstName} ${payerName.lastName}` : 'el usuario seleccionado'
    if (!confirm(`¿Confirmas que este pago se cobró en otro turno, el ${date} a las ${time}, por ${payerLabel}? Quedará registrado como corrección.`)) return
    setSaving(true)
    try {
      await api.correctTransactionDate(tx.id, { date, time, paidByUserId: Number(userId) })
      toast('Fecha de cobro corregida'); onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title="Cobrado en otro turno" onClose={onClose} footer={
      <>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar corrección</button>
      </>
    }>
      {tx.description && (
        <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12, padding: '8px 10px', background: 'var(--bg2)', borderRadius: 6 }}>
          Descripción: «{tx.description}»
        </div>
      )}
      <div className="form-grid">
        <div className="form-group">
          <label>Fecha real del pago</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Hora real del pago</label>
          <input type="time" value={time} onChange={e => setTime(e.target.value)} />
        </div>
        <div className="form-group full">
          <label>¿Quién cobró el pago?</label>
          <select value={userId} onChange={e => setUserId(e.target.value)}>
            <option value="">— Selecciona —</option>
            {receptionUsers.map((u: any) => (
              <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
            ))}
          </select>
          {receptionUsers.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>No hay usuarios activos con rol de recepción</span>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ─── Modal: cobrar depósito ──────────────────────────────────────────────────

const COBRAR_METHODS = [
  { value: 'cash',   label: 'Efectivo' },
  { value: 'card',   label: 'Tarjeta' },
  { value: 'bizum',  label: 'Bizum' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'other',  label: 'Otro' },
]

function CobrarDepositModal({ deposit, accounts, onClose, onSaved }:
  { deposit: any; accounts: any[]; onClose: () => void; onSaved: () => void }) {
  const regularAccounts = accounts.filter((a: any) =>
    !a.name.toLowerCase().includes('depósito') && !a.name.toLowerCase().includes('deposito')
  )
  const [accountId, setAccountId] = useState(() => String(regularAccounts[0]?.id ?? accounts[0]?.id ?? ''))
  const [method,    setMethod]    = useState('cash')
  const [saving,    setSaving]    = useState(false)

  const save = async () => {
    if (!accountId) { toast('Selecciona una cuenta', 'err'); return }
    setSaving(true)
    try {
      const r = await fetch(`/api/financial/transactions/${deposit.id}/cobrar`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ financialAccountId: Number(accountId), paymentMethod: method }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error al cobrar depósito')
      toast('Depósito cobrado correctamente')
      onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title="Cobrar depósito" onClose={onClose}
      footer={<button className="btn btn-primary" onClick={save} disabled={saving}>Confirmar cobro</button>}>
      <div className="form-grid">
        <div className="form-group">
          <label>Importe</label>
          <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--yellow)', padding: '6px 0' }}>
            {fmtMoney(deposit.amount)}
          </div>
        </div>
        <div className="form-group">
          <label>Forma de pago</label>
          <select value={method} onChange={e => setMethod(e.target.value)}>
            {COBRAR_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div className="form-group full">
          <label>Cuenta destino</label>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}>
            {(regularAccounts.length > 0 ? regularAccounts : accounts).map((a: any) =>
              <option key={a.id} value={a.id}>{a.name}</option>
            )}
          </select>
        </div>
        <div className="form-group full" style={{
          padding: '10px 14px', borderRadius: 8,
          background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.25)',
          fontSize: 13, color: 'var(--text2)',
        }}>
          El depósito quedará marcado como cobrado en esta pestaña.
          Si hay una alerta de «Posibles objetos robados» activa en esta reserva, se desactivará.
        </div>
      </div>
    </Modal>
  )
}

// ─── Modal: agregar depósito ─────────────────────────────────────────────────

const DEPOSIT_TYPES = [
  { value: 'preauth', label: 'Preautorización', method: 'deposit_cc', category: 'deposit_preauth', needsAmount: true  },
  { value: 'cash',    label: 'Efectivo',         method: 'deposit',    category: 'deposit_cash',    needsAmount: true  },
  { value: 'card',    label: 'Datos de Tarjeta', method: 'deposit_cc', category: 'deposit_card',    needsAmount: false },
] as const

function AddDepositModal({ reservationId, accounts, onClose, onSaved }:
  { reservationId: number; accounts: any[]; onClose: () => void; onSaved: () => void }) {
  // Solo cuentas de depósito (nombre contiene "depósito" en cualquier capitalización)
  const depositAccounts = accounts.filter(a => a.name.toLowerCase().includes('depósito') || a.name.toLowerCase().includes('deposito'))

  const ccAccount   = depositAccounts.find((a: any) => a.name.toLowerCase().includes('cc'))
  const cashAccount = depositAccounts.find((a: any) => a.name.toLowerCase().includes('cash') || a.name.toLowerCase().includes('efect'))

  const [type,      setType]      = useState<'preauth' | 'cash' | 'card'>('preauth')
  const [amount,    setAmount]    = useState('')
  const [accountId, setAccountId] = useState(() => String(ccAccount?.id ?? depositAccounts[0]?.id ?? ''))
  const [desc,      setDesc]      = useState('')
  const [saving,    setSaving]    = useState(false)

  const def = DEPOSIT_TYPES.find(t => t.value === type)!

  // Preautorización y Tarjeta son depósitos de CC — la caja de Depósitos Cash
  // no debe poder elegirse ahí, solo para Efectivo (y viceversa).
  const availableAccounts = type === 'cash'
    ? depositAccounts.filter((a: any) => !a.name.toLowerCase().includes('cc'))
    : depositAccounts.filter((a: any) => a.name.toLowerCase().includes('cc'))

  const handleTypeChange = (newType: 'preauth' | 'cash' | 'card') => {
    setType(newType)
    // Auto-seleccionar cuenta según tipo — con fallback por si no hay cuenta
    // "cc"/"cash" reconocible por nombre, para no dejar seleccionada una cuenta
    // que el nuevo tipo ya no permite.
    const nextAccounts = newType === 'cash'
      ? depositAccounts.filter((a: any) => !a.name.toLowerCase().includes('cc'))
      : depositAccounts.filter((a: any) => a.name.toLowerCase().includes('cc'))
    const preferred = newType === 'cash' ? cashAccount : ccAccount
    setAccountId(String(preferred?.id ?? nextAccounts[0]?.id ?? ''))
  }

  const save = async () => {
    // Depósitos en efectivo deshabilitados por Dirección — no se registran.
    if (type === 'cash') { toast('Depósitos en efectivo deshabilitados — comunícate con Dirección', 'err'); return }
    if (def.needsAmount && (!amount || parseFloat(amount) <= 0)) { toast('Importe inválido', 'err'); return }
    if (!accountId) { toast('Selecciona una cuenta', 'err'); return }
    setSaving(true)
    try {
      const r = await fetch('/api/financial/transactions', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationId,
          financialAccountId: Number(accountId),
          amount: def.needsAmount ? parseFloat(amount) : 0,
          paymentMethod: def.method,
          category: def.category,
          description: desc || undefined,
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error al registrar')
      toast('Depósito registrado'); onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title="Agregar depósito" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Registrar</button></>
    }>
      <div className="form-grid">
        <div className="form-group full">
          <label>Tipo de depósito</label>
          <select value={type} onChange={e => handleTypeChange(e.target.value as any)} autoFocus>
            {DEPOSIT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        {def.needsAmount && (
          <div className="form-group full">
            <label>Importe (€)</label>
            <input type="number" step="0.01" min="0" value={amount}
              onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          </div>
        )}
        <div className="form-group full">
          <label>Cuenta</label>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}>
            {availableAccounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div className="form-group full">
          <label>Descripción <span style={{ color: 'var(--text2)', fontWeight: 400 }}>(opcional)</span></label>
          <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Notas sobre el depósito…" />
        </div>
      </div>
    </Modal>
  )
}

// ─── Modal: lista negra ───────────────────────────────────────────────────────

function BlacklistModal({ guestId, guestName, currentReason, currentSeverity, onClose, onSaved }:
  { guestId: number; guestName: string; currentReason?: string | null; currentSeverity?: string | null
    onClose: () => void; onSaved: () => void }) {
  const isBlacklisted = !!currentReason
  const [reason,   setReason]   = useState(currentReason ?? '')
  const [severity, setSeverity] = useState(currentSeverity ?? 'medium')
  const [saving,   setSaving]   = useState(false)

  const doBlacklist = async () => {
    if (!reason.trim()) { toast('Indica el motivo', 'err'); return }
    setSaving(true)
    try {
      await fetch(`/api/guests/${guestId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blacklistReason: reason, blacklistSeverity: severity }),
      })
      toast('Huésped añadido a lista negra'); onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  const doRemove = async () => {
    if (!confirm('¿Quitar al huésped de la lista negra?')) return
    setSaving(true)
    try {
      await fetch(`/api/guests/${guestId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blacklistReason: null, blacklistSeverity: null }),
      })
      toast('Huésped eliminado de la lista negra'); onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title={isBlacklisted ? '🚫 Gestionar lista negra' : '⚑ Añadir a lista negra'} onClose={onClose} footer={
      <>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        {isBlacklisted && (
          <button className="btn btn-ghost" style={{ color: 'var(--green)' }} onClick={doRemove} disabled={saving}>
            Quitar de lista negra
          </button>
        )}
        <button className="btn btn-red" onClick={doBlacklist} disabled={saving}>
          {isBlacklisted ? 'Actualizar motivo' : 'Añadir a lista negra'}
        </button>
      </>
    }>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 16 }}>
        Huésped: <strong style={{ color: 'var(--text)' }}>{guestName}</strong>
      </p>
      <div className="form-grid">
        <div className="form-group full">
          <label>Motivo *</label>
          <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Describe el motivo…" style={{ width: '100%', resize: 'vertical' }} autoFocus />
        </div>
        <div className="form-group full">
          <label>Severidad</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['low','medium','high'] as const).map(s => (
              <button key={s}
                className={`btn btn-sm ${severity === s ? 'btn-primary' : 'btn-ghost'}`}
                style={severity === s ? { background: BL_SEVERITY_COLOR[s], borderColor: BL_SEVERITY_COLOR[s] } : {}}
                onClick={() => setSeverity(s)}>{BL_SEVERITY_LABEL[s]}</button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ─── Modal: añadir extra ──────────────────────────────────────────────────────

function AddExtraModal({ reservationId, onClose, onSaved }:
  { reservationId: number; onClose: () => void; onSaved: () => void }) {

  const CAT_LABELS: Record<number, string> = { 1: 'Alojamiento', 2: 'Bar & Bebidas', 3: 'Tienda' }

  const [items,   setItems]   = useState<any[]>([])
  const [cat,     setCat]     = useState<number | null>(null)  // categoría activa
  const [sel,     setSel]     = useState<any | null>(null)     // ítem seleccionado
  const [qty,     setQty]     = useState(1)
  const [price,   setPrice]   = useState('')
  const [date,    setDate]    = useState(new Date().toISOString().slice(0, 10))
  const [notes,   setNotes]   = useState('')
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    fetch('/api/catalog/sale-items').then(r => r.json())
      .then(d => {
        const list = d.data ?? []
        setItems(list)
        // activa la primera categoría que tenga ítems
        const firstCat = list.find((i: any) => i.categoryId)?.categoryId ?? null
        setCat(firstCat)
      }).catch(() => {})
  }, [])

  const pick = (item: any) => {
    setSel(item)
    setPrice(item.defaultPrice != null ? String(item.defaultPrice) : '')
    setQty(1)
  }

  const save = async () => {
    if (!sel) { toast('Selecciona un concepto', 'err'); return }
    if (price === '' || parseFloat(price) < 0) { toast('Precio inválido', 'err'); return }
    setSaving(true)
    try {
      await fetch(`/api/reservations/${reservationId}/extras`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saleItemId: sel.id, quantity: qty,
          unitPrice: parseFloat(price),
          date: date || undefined,
          notes: notes || undefined,
        }),
      })
      toast('Extra añadido'); onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  // categorías disponibles (en orden)
  const cats = [1, 2, 3].filter(c => items.some((i: any) => i.categoryId === c))
  const uncategorized = items.filter((i: any) => !i.categoryId)
  const visibleItems  = cat === 0
    ? uncategorized
    : items.filter((i: any) => i.categoryId === cat)

  return (
    <Modal title="Añadir extra" onClose={onClose} width={580} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving || !sel}>
          {saving ? 'Añadiendo…' : sel ? `Añadir ${sel.title}` : 'Selecciona un concepto'}
        </button></>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Tabs de categoría */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {cats.map(c => (
            <button key={c}
              className={`btn btn-sm ${cat === c ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setCat(c); setSel(null) }}>
              {CAT_LABELS[c] ?? `Cat. ${c}`}
            </button>
          ))}
          {uncategorized.length > 0 && (
            <button className={`btn btn-sm ${cat === 0 ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setCat(0); setSel(null) }}>Otros</button>
          )}
        </div>

        {/* Grid de ítems */}
        {items.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text2)' }}>No hay extras configurados. Ejecuta el script <code>seed-sale-items.ts</code> tras aplicar la migración.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
            {visibleItems.map((item: any) => {
              const isSel = sel?.id === item.id
              return (
                <button key={item.id} onClick={() => pick(item)}
                  style={{
                    border: `2px solid ${isSel ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 8, padding: '8px 10px', background: isSel ? 'rgba(79,124,255,0.08)' : 'var(--bg2)',
                    cursor: 'pointer', textAlign: 'left', transition: 'border-color 0.15s',
                    ...(item.color ? { borderLeftColor: item.color, borderLeftWidth: 3 } : {}),
                  }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text1)', lineHeight: 1.3 }}>{item.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3 }}>
                    {item.defaultPrice != null ? fmtMoney(item.defaultPrice) : '—'}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* Panel de configuración del ítem seleccionado */}
        {sel && (
          <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{sel.title}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ color: 'var(--text2)' }}>Cantidad</span>
                <input className="form-input" type="number" value={qty} min={1}
                  onChange={e => setQty(Math.max(1, Number(e.target.value)))} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ color: 'var(--text2)' }}>Precio ud. (€)</span>
                <input className="form-input" type="number" value={price} min={0} step="0.01"
                  onChange={e => setPrice(e.target.value)} placeholder="0.00" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ color: 'var(--text2)' }}>Fecha</span>
                <input className="form-input" type="date" value={date} onChange={e => setDate(e.target.value)} />
              </label>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text2)' }}>Notas</span>
              <input className="form-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Opcional" />
            </label>
            {price !== '' && (
              <div style={{ fontSize: 13, textAlign: 'right' }}>
                Total: <strong>{fmtMoney(String(qty * parseFloat(price || '0')))}</strong>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ─── Modal: añadir huésped adicional / cambiar huésped titular (mode) ─────────

function AddGuestModal({ reservationId, titularAddress, onClose, onSaved, mode = 'additional', groupRooms }:
  {
    reservationId: number
    titularAddress?: { address1: string; zipCode: string; city: string; cityIneCode: string; addressCountryCode: string; phone?: string; email?: string }
    onClose: () => void
    onSaved: () => void
    // 'additional' = añadir huésped más a la reserva (por defecto).
    // 'primary'    = sustituir al huésped titular — mismo formulario de
    // búsqueda/creación, pero llama a change-primary-guest en vez de a
    // guests, y pide confirmación antes de aplicar (deja nota del cambio).
    mode?: 'additional' | 'primary'
    // Habitaciones del grupo (principal + extra) — si hay más de una, se
    // puede elegir en cuál va este huésped adicional. Solo aplica con mode='additional'.
    groupRooms?: any[]
  }) {
  const roomChoices = mode === 'additional' ? (groupRooms ?? []) : []
  const [roomId, setRoomId] = useState<number | ''>('')
  const endpoint     = mode === 'primary' ? `/api/reservations/${reservationId}/change-primary-guest` : `/api/reservations/${reservationId}/guests`
  const modalTitle   = mode === 'primary' ? 'Cambiar huésped titular' : 'Añadir huésped'
  const createTitle  = mode === 'primary' ? 'Nuevo huésped titular' : 'Nuevo huésped adicional'
  const submitLabel  = mode === 'primary' ? 'Cambiar titular' : 'Añadir huésped'
  const savedToast   = mode === 'primary' ? 'Huésped titular cambiado' : 'Huésped añadido'

  const [phase,   setPhase]   = useState<'search' | 'create'>('search')
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<any[]>([])
  const [saving,  setSaving]  = useState(false)
  const [form, setForm] = useState({
    firstName: '', lastName: '', secondLastName: '',
    gender: 'unspecified',
    dateOfBirth: '', nationality: '',
    idDocType: '', idDocNumber: '', idDocSupportNumber: '',
    idDocIssueDate: '', idDocExpiryDate: '',
    email:              titularAddress?.email  ?? '',
    phone:              titularAddress?.phone  ?? '',
    address1:           titularAddress?.address1    ?? '',
    zipCode:            titularAddress?.zipCode     ?? '',
    city:               titularAddress?.city        ?? '',
    cityIneCode:        titularAddress?.cityIneCode ?? '',
    addressCountryCode: titularAddress?.addressCountryCode ?? 'ES',
  })

  useEffect(() => {
    if (query.length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/guests?q=${encodeURIComponent(query)}&limit=8`)
        const d = await r.json()
        setResults(d.data ?? [])
      } catch { setResults([]) }
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  const [docError2, setDocError2] = useState('')

  const validateDoc2 = () => {
    const err = validateIdDocNumber(form.idDocType, form.idDocNumber)
    setDocError2(err ?? ''); return !err
  }

  const [cityValid2, setCityValid2] = useState(true)
  const [munValid2,  setMunValid2]  = useState(true)

  const submit = async (body: any) => {
    // Elegir un huésped YA EXISTENTE (guestId) no rellena nada del
    // formulario — esas validaciones son solo para cuando se está tecleando
    // un huésped NUEVO a mano (fase "create"). Sin este corte, si el titular
    // ACTUAL tenía la dirección incompleta (con la que se precarga `form`),
    // el simple hecho de elegir a otro huésped ya existente como titular
    // quedaba bloqueado por datos que no tienen nada que ver con el cambio.
    if (!body.guestId) {
      if (!validateDoc2()) return
      const isES = form.addressCountryCode === 'ES'
      const COUNTRY_LIST = COUNTRIES as Country[]
      if (form.addressCountryCode && !COUNTRY_LIST.some(c => c.code === form.addressCountryCode)) {
        toast('País no válido: selecciónalo del desplegable', 'err'); return
      }
      if (isES && form.city && form.zipCode && !cityValid2) {
        toast('Ciudad/CP no válido: selecciónalo del desplegable', 'err'); return
      }
      if (isES && !form.cityIneCode) {
        toast('Debes seleccionar un municipio de la lista antes de guardar', 'err'); return
      }
      if (isES && !munValid2) {
        toast('Municipio INE no válido: selecciónalo del desplegable', 'err'); return
      }
      if (!form.address1 || !form.zipCode || !form.city) {
        toast('Dirección incompleta: falta calle, CP o ciudad', 'warn')
      }
    }
    setSaving(true)
    try {
      const r = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(apiErr(d, mode === 'primary' ? 'Error al cambiar el titular' : 'Error al añadir'))
      toast(savedToast); onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  // Cambiar titular es más delicado que añadir un huésped más (cambia a quién
  // se factura/contacta y queda registrado como nota) — pide confirmación
  // antes de aplicar, tanto si se elige uno existente como si se crea nuevo.
  const submitWithConfirm = (body: any, guestLabel: string) => {
    if (mode === 'primary' && !confirm(`¿Hacer a ${guestLabel} el nuevo huésped titular de esta reserva? Se guardará una nota con el titular anterior.`)) return
    submit(roomChoices.length > 1 && roomId ? { ...body, roomId } : body)
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const needsSoporte = form.idDocType === 'dni' || form.idDocType === 'nie'

  if (phase === 'search') {
    return (
      <Modal title={modalTitle} onClose={onClose} footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-ghost" onClick={() => setPhase('create')}>+ Crear nuevo</button>
        </>
      }>
        {roomChoices.length > 1 && (
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label>Habitación (reserva de grupo)</label>
            <select value={roomId} onChange={e => setRoomId(Number(e.target.value))}>
              <option value="">— Principal —</option>
              {roomChoices.map((r: any) => (
                <option key={r.id} value={r.id}>{r.code}{r.roomType?.name ? ` — ${r.roomType.name}` : ''}</option>
              ))}
            </select>
          </div>
        )}
        <div className="form-group" style={{ marginBottom: 12 }}>
          <label>Buscar huésped existente</label>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Nombre, apellido, email o documento…"
          />
        </div>
        {results.length > 0 && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            {results.map((g: any) => (
              <button key={g.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '10px 14px', background: 'none', border: 'none',
                  borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
                  fontSize: 13, color: 'var(--text)',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                disabled={saving}
                onClick={() => submitWithConfirm({ guestId: g.id }, `${g.firstName} ${g.lastName}`)}
              >
                <span style={{ fontWeight: 500 }}>{g.firstName} {g.lastName}</span>
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                  {g.idDocType ? `${g.idDocType.toUpperCase()} ${g.idDocNumber ?? ''}` : g.email ?? ''}
                </span>
              </button>
            ))}
          </div>
        )}
        {query.length >= 2 && results.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text2)', textAlign: 'center', padding: '12px 0' }}>
            Sin resultados. <button className="btn btn-ghost btn-sm" onClick={() => setPhase('create')}>Crear nuevo huésped →</button>
          </p>
        )}
      </Modal>
    )
  }

  return (
    <Modal title={createTitle} onClose={onClose} footer={
      <>
        <button className="btn btn-ghost" onClick={() => setPhase('search')}>← Buscar</button>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" disabled={saving}
          onClick={() => {
            if (!form.firstName.trim() || !form.lastName.trim()) {
              toast('Nombre y apellido son obligatorios', 'err'); return
            }
            const body: any = { ...form }
            for (const k of Object.keys(body)) { if (body[k] === '') body[k] = undefined }
            if (!body.idDocType) body.idDocType = undefined
            submitWithConfirm(body, `${form.firstName} ${form.lastName}`)
          }}>
          {saving ? 'Guardando…' : submitLabel}
        </button>
      </>
    }>
      <div className="form-grid">
        {roomChoices.length > 1 && (
          <div className="form-group" style={{ gridColumn: '1 / -1' }}>
            <label>Habitación (reserva de grupo)</label>
            <select value={roomId} onChange={e => setRoomId(Number(e.target.value))}>
              <option value="">— Principal —</option>
              {roomChoices.map((r: any) => (
                <option key={r.id} value={r.id}>{r.code}{r.roomType?.name ? ` — ${r.roomType.name}` : ''}</option>
              ))}
            </select>
          </div>
        )}
        <div className="form-group">
          <label>Nombre *</label>
          <input autoFocus value={form.firstName} onChange={set('firstName')} autoComplete="off" />
        </div>
        <div className="form-group">
          <label>Primer apellido *</label>
          <input value={form.lastName} onChange={set('lastName')} autoComplete="off" />
        </div>
        <div className="form-group">
          <label>Segundo apellido</label>
          <input value={form.secondLastName} onChange={set('secondLastName')} autoComplete="off" />
        </div>
        <div className="form-group">
          <label>Sexo</label>
          <select value={form.gender} onChange={set('gender')}>
            <option value="unspecified">—</option>
            <option value="male">Hombre</option>
            <option value="female">Mujer</option>
            <option value="non_binary">No binario</option>
          </select>
        </div>
        <div className="form-group">
          <label>Fecha de nacimiento</label>
          <input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} />
        </div>
        <div className="form-group">
          <label>Nacionalidad</label>
          <CountryPicker value={form.nationality} onChange={code => setForm(f => ({ ...f, nationality: code }))} />
        </div>
        <div className="form-group">
          <label>Tipo documento</label>
          <select value={form.idDocType} onChange={set('idDocType')}>
            <option value="">—</option>
            <option value="dni">DNI</option>
            <option value="nie">NIE</option>
            <option value="passport">Pasaporte</option>
            <option value="driving_licence">Carnet</option>
            <option value="other">Otro</option>
          </select>
        </div>
        <div className="form-group">
          <label>Número</label>
          <input
            value={form.idDocNumber}
            onChange={e => { set('idDocNumber')(e); setDocError2('') }}
            onBlur={validateDoc2}
            style={{ textTransform: 'uppercase', borderColor: docError2 ? 'var(--red)' : '' }}
          />
          {docError2 && <span style={{ fontSize: 11, color: 'var(--red)', marginTop: 3, display: 'block' }}>{docError2}</span>}
        </div>
        {needsSoporte && (
          <div className="form-group">
            <label>Nº soporte <span style={{ fontSize: 10, color: 'var(--yellow)' }}>requerido NIF/NIE</span></label>
            <input value={form.idDocSupportNumber} onChange={set('idDocSupportNumber')} />
          </div>
        )}
        <div className="form-group">
          <label>Fecha expedición</label>
          <input type="date" value={form.idDocIssueDate} onChange={set('idDocIssueDate')} />
        </div>
        <div className="form-group">
          <label>Fecha caducidad</label>
          <input type="date" value={form.idDocExpiryDate} onChange={set('idDocExpiryDate')} />
        </div>
        <div className="form-group">
          <label>Email</label>
          <input type="email" value={form.email} onChange={set('email')}
            style={isBookingAlias(form.email) ? { borderColor: 'var(--red)' } : undefined} />
          {isBookingAlias(form.email) && (
            <span style={{ fontSize: 11, color: 'var(--red)', marginTop: 2, display: 'block' }}>
              ⚠ Email temporal de Booking (caduca tras la estancia). Pídele al cliente su email real — no se puede guardar ni hacer check-in con este.
            </span>
          )}
        </div>
        <div className="form-group">
          <label>Teléfono</label>
          <input type="tel" value={form.phone} onChange={set('phone')} />
        </div>
      </div>

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: 'var(--text2)' }}>Dirección</div>
        <div className="form-grid">
          <div className="form-group" style={{ gridColumn: '1 / -1' }}>
            <label>Calle</label>
            <input value={form.address1} onChange={set('address1')} placeholder="Calle Mayor 10, 2ºA" />
          </div>
          <div className="form-group">
            <label>País</label>
            <CountryPicker value={form.addressCountryCode} onChange={code => setForm(f => ({ ...f, addressCountryCode: code }))} />
          </div>
          <div className="form-group">
            <label>Ciudad / Código postal</label>
            <CityPicker
              city={form.city} zipCode={form.zipCode} country={form.addressCountryCode}
              onChange={(city, zip) => setForm(f => ({ ...f, city, zipCode: zip }))}
              onValidChange={setCityValid2}
            />
          </div>
          {form.addressCountryCode === 'ES' && (<>
            <div className="form-group">
              <label>Municipio INE</label>
              <MunicipalityPicker
                city={form.city} ineCode={form.cityIneCode}
                onChange={(_city, ineCode) => setForm(f => ({ ...f, cityIneCode: ineCode }))}
                onValidChange={setMunValid2}
              />
            </div>
            <div className="form-group">
              <label>Código INE <span style={{ fontSize: 10, color: 'var(--text2)' }}>(5 dígitos)</span></label>
              <input value={form.cityIneCode} onChange={set('cityIneCode')} placeholder="18087" maxLength={5} />
            </div>
          </>)}
        </div>
      </div>
    </Modal>
  )
}

// ─── Modal: añadir feedback del huésped (dicho en persona, no por el portal) ──
// Recepción/dirección registran aquí algo que ha dicho el cliente en la
// reserva — mismo hilo de feedback (feedback_threads) que ve dirección en
// Informes → Feedback, ya con la reserva y el huésped enlazados de serie.

function FeedbackModal({ reservationId, guestId, onClose, onSaved }: { reservationId: number; guestId: number | null; onClose: () => void; onSaved: () => void }) {
  const [sentiment, setSentiment] = useState('neutral')
  const [category,  setCategory]  = useState('otro')
  const [text,      setText]      = useState('')
  const [saving,    setSaving]    = useState(false)

  const save = async () => {
    if (!text.trim()) { toast('Escribe lo que ha dicho el huésped', 'err'); return }
    setSaving(true)
    try {
      await api.createFeedback({ text: text.trim(), sentiment, category, channel: 'verbal', reservationId, guestId: guestId ?? undefined })
      toast('Feedback registrado'); onSaved()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <Modal title="Añadir feedback del huésped" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
    }>
      <div className="form-group">
        <label>¿Qué ha dicho?</label>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={3} autoFocus
          placeholder="Ej: se queja de que no ha habido agua caliente esta mañana" />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="form-group" style={{ flex: 1 }}>
          <label>Tipo</label>
          <select value={sentiment} onChange={e => setSentiment(e.target.value)}>
            <option value="positive">😊 Elogio</option><option value="neutral">😐 Neutro</option><option value="complaint">😠 Queja</option><option value="suggestion">💡 Sugerencia</option>
          </select>
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label>Categoría</label>
          <select value={category} onChange={e => setCategory(e.target.value)}>
            <option value="limpieza">limpieza</option><option value="ruido">ruido</option><option value="camas">camas</option><option value="wifi">wifi</option><option value="desayuno">desayuno</option><option value="ducha">ducha</option><option value="checkin">checkin</option><option value="precio">precio</option><option value="trato">trato</option><option value="ubicacion">ubicacion</option><option value="otro">otro</option>
          </select>
        </div>
      </div>
    </Modal>
  )
}

// ─── Modal: quitar habitación extra (exige motivo, min. 5 palabras) ───────────

function RemoveExtraRoomModal({ roomCode, onClose, onConfirm }: { roomCode: string; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const words = countReasonWords(reason)
  const ok    = words >= MIN_REASON_WORDS

  const confirm = async () => { setSaving(true); await onConfirm(reason); setSaving(false) }

  return (
    <Modal title={`Quitar habitación ${roomCode}`} onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-red" onClick={confirm} disabled={saving || !ok}>Quitar habitación</button></>
    }>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label>Motivo — obligatorio</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} autoFocus
          placeholder="Explica por qué se quita esta habitación…" />
        <div style={{ fontSize: 11, color: ok ? 'var(--green)' : 'var(--text2)', marginTop: 2 }}>
          {words}/{MIN_REASON_WORDS} palabras{ok ? ' ✓' : ''}
        </div>
      </div>
    </Modal>
  )
}

// Cancelación por recepción: motivo obligatorio de al menos 10 palabras
// reales (el backend lo exige igual — ver POST /:id/cancel). Admin/dirección
// no pasa por aquí, cancela directo con el confirm() de siempre.
const MIN_CANCEL_REASON_WORDS = 10

function CancelReservationModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const words = countReasonWords(reason)
  const ok    = words >= MIN_CANCEL_REASON_WORDS

  const confirm = async () => { setSaving(true); await onConfirm(reason); setSaving(false) }

  return (
    <Modal title="Cancelar reserva" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cerrar</button>
        <button className="btn btn-red" onClick={confirm} disabled={saving || !ok}>Cancelar reserva</button></>
    }>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label>Motivo de la cancelación — obligatorio</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} autoFocus
          placeholder="Explica por qué se cancela esta reserva…" />
        <div style={{ fontSize: 11, color: ok ? 'var(--green)' : 'var(--text2)', marginTop: 2 }}>
          {words}/{MIN_CANCEL_REASON_WORDS} palabras{ok ? ' ✓' : ''}
        </div>
      </div>
    </Modal>
  )
}

// ─── Modal: cambiar habitación ────────────────────────────────────────────────

function ChangeRoomModal({ res, onClose, onMoved }: { res: any; onClose: () => void; onMoved: () => void }) {
  const [availRooms, setAvailRooms] = useState<any[]>([])
  const [loading,    setLoading]    = useState(true)
  const [typeId,     setTypeId]     = useState('')
  const [roomId,     setRoomId]     = useState('')
  const [reason,     setReason]     = useState('')
  const [saving,     setSaving]     = useState(false)

  useEffect(() => {
    api.availableRoomsForReservation({
      checkIn:        res.checkInDate,
      checkOut:       res.checkOutDate,
      excludeRoomId:  res.roomId,
      includeVirtual: true,
    }).then((r: any) => setAvailRooms(r.data))
      .catch(() => setAvailRooms([]))
      .finally(() => setLoading(false))
  }, [])

  const roomTypes = [...new Map(
    availRooms.filter(r => r.roomType).map(r => [r.roomTypeId, r.roomType])
  ).values()].sort((a: any, b: any) => a.name.localeCompare(b.name))

  const filtered     = typeId ? availRooms.filter(r => r.roomTypeId === Number(typeId)) : []
  const selectedRoom = availRooms.find(r => r.id === Number(roomId))

  const needsReason = roomChangeNeedsReason(res.status, selectedRoom)
  const reasonOk     = !needsReason || countReasonWords(reason) >= MIN_REASON_WORDS

  const save = async () => {
    if (!selectedRoom) { return }
    setSaving(true)
    try {
      await api.updateReservation(res.id, { roomId: Number(roomId), ...(needsReason ? { changeReason: reason } : {}) })
      toast(res.roomId ? `Reserva movida a hab. ${selectedRoom.code}` : `Reserva asignada a hab. ${selectedRoom.code}`)
      onMoved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title={res.roomId ? 'Cambiar habitación' : 'Asignar a habitación'} onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving || !roomId || !reasonOk}>{res.roomId ? 'Mover reserva' : 'Asignar'}</button></>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {loading ? (
          <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>Cargando habitaciones disponibles…</p>
        ) : availRooms.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>No hay habitaciones disponibles para estas fechas</p>
        ) : (
          <>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Tipo de habitación</label>
              <select value={typeId} onChange={e => { setTypeId(e.target.value); setRoomId('') }} autoFocus>
                <option value="">— Selecciona tipo —</option>
                {roomTypes.map((rt: any) => (
                  <option key={rt.id} value={rt.id}>{rt.name}</option>
                ))}
              </select>
            </div>
            {typeId && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Habitación</label>
                {filtered.length === 0
                  ? <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>No hay habitaciones disponibles de este tipo</p>
                  : (
                    <select value={roomId} onChange={e => setRoomId(e.target.value)}>
                      <option value="">— Selecciona habitación —</option>
                      {filtered.map((r: any) => (
                        <option key={r.id} value={r.id}>Hab. {r.code}</option>
                      ))}
                    </select>
                  )
                }
              </div>
            )}
            <RoomChangeReasonField value={reason} onChange={setReason} reservationStatus={res.status} targetRoom={selectedRoom} />
          </>
        )}
        {selectedRoom && (
          <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
            ✓ Se moverá a hab. {selectedRoom.code} ({(selectedRoom.roomType as any)?.name}) · fechas y precio sin cambios
          </div>
        )}
      </div>
    </Modal>
  )
}

// ─── Modal: cambiar estado a mano (solo admin) ───────────────────────────────
// Escape hatch para corregir estados incorrectos (p.ej. un no-show marcado por
// error, o una reserva atascada tras un fallo de sync) sin pasar por los flujos
// normales de check-in/check-out/cancelación. Es un cambio directo del campo
// status — no ejecuta ningún efecto secundario de esos flujos (no genera
// factura, no toca el cierre de caja, no revoca cerraduras, etc.).

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'tentative',    label: 'Provisional' },
  { value: 'arriving',     label: 'Por llegar' },
  { value: 'confirmed',    label: 'Confirmada' },
  { value: 'checked_in',   label: 'En casa' },
  { value: 'checking_out', label: 'Saliendo' },
  { value: 'checked_out',  label: 'Ha salido' },
  { value: 'cancelled',    label: 'Cancelada' },
  { value: 'no_show',      label: 'No show' },
]

function ChangeStatusModal({ res, onClose, onChanged }: { res: any; onClose: () => void; onChanged: () => void }) {
  const [status,    setStatus]    = useState(res.status)
  const [confirming, setConfirming] = useState(false)
  const [saving,     setSaving]     = useState(false)

  const currentLabel = STATUS_OPTIONS.find(o => o.value === res.status)?.label ?? res.status
  const newLabel      = STATUS_OPTIONS.find(o => o.value === status)?.label ?? status
  const changed       = status !== res.status

  const save = async () => {
    setSaving(true)
    try {
      await api.updateReservation(res.id, { status })
      toast(`Estado cambiado a "${newLabel}"`)
      onChanged()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  if (confirming) {
    return (
      <Modal title="Confirmar cambio de estado" onClose={() => setConfirming(false)} footer={
        <><button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={saving}>Volver</button>
          <button className="btn btn-red" onClick={save} disabled={saving}>{saving ? 'Cambiando…' : 'Sí, cambiar estado'}</button></>
      }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 14, margin: 0 }}>
            Vas a cambiar la reserva #{res.id} de <strong>{currentLabel}</strong> a <strong>{newLabel}</strong>.
          </p>
          <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>
            Esto solo cambia el estado — no genera factura, no libera/asigna cerraduras
            ni ejecuta ningún otro efecto de check-in/check-out/cancelación. Úsalo solo
            para corregir un estado incorrecto.
          </p>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Cambiar estado (admin)" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={() => setConfirming(true)} disabled={!changed}>Continuar</button></>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>
          Estado actual: <strong>{currentLabel}</strong>
        </p>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Nuevo estado</label>
          <select value={status} onChange={e => setStatus(e.target.value)} autoFocus>
            {STATUS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  )
}

// ─── Modal: partir reserva por fecha (mueve el tramo final a otra habitación) ──

function SplitReservationModal({ res, onClose, onSplit }: { res: any; onClose: () => void; onSplit: (newId: number) => void }) {
  const minDate = addDays(res.checkInDate, 1)
  const maxDate = addDays(res.checkOutDate, -1)
  const [splitDate,  setSplitDate]  = useState(minDate)
  const [availRooms, setAvailRooms] = useState<any[]>([])
  const [loading,    setLoading]    = useState(true)
  const [typeId,     setTypeId]     = useState('')
  const [roomId,     setRoomId]     = useState('')
  const [saving,     setSaving]     = useState(false)

  useEffect(() => {
    setLoading(true); setRoomId(''); setTypeId('')
    api.availableRoomsForReservation({
      checkIn:        splitDate,
      checkOut:       res.checkOutDate,
      excludeRoomId:  res.roomId,
      includeVirtual: true,
    }).then((r: any) => setAvailRooms(r.data))
      .catch(() => setAvailRooms([]))
      .finally(() => setLoading(false))
  }, [splitDate])

  const roomTypes = [...new Map(
    availRooms.filter(r => r.roomType).map(r => [r.roomTypeId, r.roomType])
  ).values()].sort((a: any, b: any) => a.name.localeCompare(b.name))

  const filtered     = typeId ? availRooms.filter(r => r.roomTypeId === Number(typeId)) : []
  const selectedRoom = availRooms.find(r => r.id === Number(roomId))

  const nightsBefore = Math.round((new Date(splitDate + 'T12:00:00').getTime() - new Date(res.checkInDate + 'T12:00:00').getTime()) / 86400000)
  const nightsAfter  = res.nights - nightsBefore
  const ratio         = nightsBefore / res.nights
  const totalBefore   = parseFloat(res.total) * ratio
  const totalAfter    = parseFloat(res.total) - totalBefore

  const save = async () => {
    if (!selectedRoom) return
    setSaving(true)
    try {
      const r: any = await api.splitReservation(res.id, { splitDate, newRoomId: Number(roomId) })
      onSplit(r.data.created.id)
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title="Partir reserva" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving || !roomId}>
          {saving ? 'Partiendo…' : 'Partir reserva'}
        </button></>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Fecha de corte</label>
          <input type="date" value={splitDate} min={minDate} max={maxDate}
            onChange={e => setSplitDate(e.target.value)} />
          <span style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3, display: 'block' }}>
            La reserva actual pasará a terminar el {fmtDate(splitDate)}; se creará una reserva nueva
            del {fmtDate(splitDate)} al {fmtDate(res.checkOutDate)} en la habitación que elijas.
          </span>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Tipo de habitación</label>
          <select value={typeId} onChange={e => { setTypeId(e.target.value); setRoomId('') }}>
            <option value="">— Selecciona tipo —</option>
            {roomTypes.map((rt: any) => (
              <option key={rt.id} value={rt.id}>{rt.name}</option>
            ))}
          </select>
        </div>
        {loading ? (
          <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>Cargando habitaciones disponibles…</p>
        ) : typeId && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Habitación</label>
            {filtered.length === 0
              ? <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>No hay habitaciones disponibles de este tipo para ese tramo</p>
              : (
                <select value={roomId} onChange={e => setRoomId(e.target.value)}>
                  <option value="">— Selecciona habitación —</option>
                  {filtered.map((r: any) => (
                    <option key={r.id} value={r.id}>Hab. {r.code}</option>
                  ))}
                </select>
              )
            }
          </div>
        )}
        {selectedRoom && (
          <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, lineHeight: 1.5 }}>
            ✓ Reserva #{res.externalCode ?? res.id}: {nightsBefore} noche{nightsBefore !== 1 ? 's' : ''} · {totalBefore.toFixed(2)} €<br/>
            ✓ Reserva nueva en hab. {selectedRoom.code}: {nightsAfter} noche{nightsAfter !== 1 ? 's' : ''} · {totalAfter.toFixed(2)} €
          </div>
        )}
      </div>
    </Modal>
  )
}

// ─── Modal: añadir habitación adicional ──────────────────────────────────────

function AddExtraRoomModal({ res, isAdmin, onClose, onAdded }: { res: any; isAdmin: boolean; onClose: () => void; onAdded: (newExtraRoomIds: number[]) => void }) {
  const currentExtraIds: number[] = res.extraRoomIds ?? []
  const [availRooms, setAvailRooms] = useState<any[]>([])
  const [loading,    setLoading]    = useState(true)
  const [roomId,     setRoomId]     = useState('')
  const [reason,     setReason]     = useState('')
  const [saving,     setSaving]     = useState(false)
  // Dirección no necesita motivo (igual que siempre). Recepción sí — misma
  // explicación mínima de 5 palabras que quitar una extra o un cambio
  // delicado de habitación, comprobada también en el backend.
  const words   = countReasonWords(reason)
  const needsReason = !isAdmin
  const reasonOk     = !needsReason || words >= MIN_REASON_WORDS

  useEffect(() => {
    api.availableRoomsForReservation({
      checkIn:        res.checkInDate,
      checkOut:       res.checkOutDate,
      excludeRoomId:  res.roomId,
    }).then((r: any) => {
      setAvailRooms(r.data.filter((rm: any) => !currentExtraIds.includes(rm.id)))
    })
      .catch(() => setAvailRooms([]))
      .finally(() => setLoading(false))
  }, [])

  const selectedRoom = availRooms.find((r: any) => r.id === Number(roomId))

  const save = async () => {
    if (!roomId || !reasonOk) return
    setSaving(true)
    try {
      const newExtraRoomIds = [...currentExtraIds, Number(roomId)]
      await api.updateReservation(res.id, { extraRoomIds: newExtraRoomIds, ...(needsReason ? { changeReason: reason } : {}) } as any)
      toast('Habitación adicional añadida')
      onAdded(newExtraRoomIds)
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title="Añadir habitación adicional" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving || !roomId || !reasonOk}>Añadir</button></>
    }>
      {loading ? (
        <p style={{ fontSize: 13, color: 'var(--text2)' }}>Cargando habitaciones disponibles…</p>
      ) : availRooms.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text2)' }}>No hay habitaciones disponibles para estas fechas</p>
      ) : (
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Habitación disponible</label>
          <select value={roomId} onChange={e => setRoomId(e.target.value)} autoFocus>
            <option value="">— Selecciona habitación —</option>
            {availRooms.map((r: any) => (
              <option key={r.id} value={r.id}>Hab. {r.code}{r.roomType?.name ? ` — ${r.roomType.name}` : ''}</option>
            ))}
          </select>
          {selectedRoom?.roomType?.maxOccupancy && (
            <p style={{ fontSize: 12, color: 'var(--text2)', margin: '6px 0 0' }}>
              Capacidad de esta habitación: {selectedRoom.roomType.maxOccupancy} persona{selectedRoom.roomType.maxOccupancy !== 1 ? 's' : ''}
            </p>
          )}
          {needsReason && (
            <div className="form-group" style={{ marginTop: 10, marginBottom: 0 }}>
              <label>Motivo — obligatorio</label>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                placeholder="Explica por qué se añade esta habitación…" />
              <div style={{ fontSize: 11, color: reasonOk ? 'var(--green)' : 'var(--text2)', marginTop: 2 }}>
                {words}/{MIN_REASON_WORDS} palabras{reasonOk ? ' ✓' : ''}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

// ─── Modal: ampliar reserva ───────────────────────────────────────────────────

function ExtendReservationModal({ res, onClose, onSaved }: { res: any; onClose: () => void; onSaved: () => void }) {
  const minDate   = addDays(res.checkOutDate, 1)
  const [newCheckOut,    setNewCheckOut]    = useState(minDate)
  const [rates,          setRates]          = useState<any[]>([])
  const [selRateId,      setSelRateId]      = useState<number | null>(res.rateId ?? null)
  const [priceMap,       setPriceMap]       = useState<Record<string, Record<number, Record<string, { price: string }>>>>({})
  const [loadingPrices,  setLoadingPrices]  = useState(false)
  const [saving,         setSaving]         = useState(false)
  const [manualPrice,    setManualPrice]    = useState('')

  const roomTypeId = res.room?.roomTypeId ?? null

  const extraDays   = getDays(res.checkOutDate, addDays(newCheckOut, -1))
  const extraNights = extraDays.length

  useEffect(() => {
    api.listRates().then(r => setRates(r.data.filter((rt: any) => !rt.locked))).catch(() => {})
  }, [])

  useEffect(() => {
    if (extraNights <= 0 || !selRateId) { setPriceMap({}); return }
    setLoadingPrices(true)
    const params: Record<string, string> = {
      dateFrom: res.checkOutDate,
      dateTo:   addDays(newCheckOut, -1),
      rateIds:  String(selRateId),
    }
    if (roomTypeId) params.roomTypeIds = String(roomTypeId)
    api.ratesCalendar(params)
      .then(r => setPriceMap(r.priceMap ?? {}))
      .catch(() => setPriceMap({}))
      .finally(() => setLoadingPrices(false))
  }, [newCheckOut, selRateId])

  const dayPrices = extraDays.map(date => {
    const rtKey = roomTypeId != null ? String(roomTypeId) : 'null'
    // priceMap está indexado [rtKey][rateId][date]
    const entry = priceMap[rtKey]?.[selRateId!]?.[date] ?? priceMap['null']?.[selRateId!]?.[date]
    const price = entry ? parseFloat(entry.price) : NaN
    return { date, price: isNaN(price) ? 0 : price, hasPrice: !!entry && !isNaN(price) }
  })

  const calculatedExtra = dayPrices.reduce((s, d) => s + d.price, 0)
  const useManual       = manualPrice !== ''
  const extraAmount     = useManual ? (parseFloat(manualPrice) || 0) : calculatedExtra
  const newTotal        = parseFloat(res.total ?? '0') + extraAmount
  const newNights       = res.nights + extraNights

  const save = async () => {
    if (extraNights <= 0) { toast('La fecha de salida debe ser posterior a la actual', 'err'); return }
    if (extraAmount <= 0) { toast('El importe adicional no puede ser 0 €', 'err'); return }

    // Si hay código y/o tarjeta ya dados, ampliar los regenera/re-enrola —
    // el código y la credencial de tarjeta ANTERIORES quedan invalidados y no se
    // pueden recuperar. Avisar antes de tocar nada.
    const hadCode = !!(res as any).ttlockCode
    const hadCard = !!(res as any).zktecoCardBe
    if (hadCode || hadCard) {
      const what = hadCode && hadCard ? 'el código de la cerradura y la tarjeta' : hadCode ? 'el código de la cerradura' : 'la tarjeta'
      if (!confirm(`Esta acción es irreversible: al ampliar la reserva se regenerará ${what}. El anterior dejará de funcionar y no se puede recuperar. ¿Continuar?`)) return
    }

    setSaving(true)
    try {
      await api.updateReservation(res.id, {
        checkOutDate: newCheckOut,
        nights:       newNights,
        total:        parseFloat(newTotal.toFixed(2)),
        ...(selRateId ? { rateId: selRateId } : {}),
      })

      // Si había código TTLock, regenerarlo para cubrir la nueva fecha de salida.
      // Si había tarjeta ZKTeco/TTLock ya enrolada, re-enrolarla con la misma
      // ventana (desde ahora hasta el nuevo check-out) — sin que el huésped tenga
      // que volver a pasarla. Las dos cosas son independientes: una reserva puede
      // tener una, la otra, ambas o ninguna. (hadCode/hadCard ya calculados arriba,
      // antes del confirm())
      let newCode: string | null = null
      let codeError: string | null = null
      let cardError: string | null = null

      if (hadCode) {
        try {
          const r = await fetch(`/api/ttlock/generate/${res.id}`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          })
          const d = await r.json()
          if (r.ok) newCode = (d.data.entries ?? []).map((e: any) => `${e.room}: ${e.code}#`).join(' · ')
          else codeError = d.error ?? 'Error'
        } catch { codeError = 'Error de conexión' }
      }
      if (hadCard) {
        try {
          const r = await fetch(`/api/ttlock/reenroll-card/${res.id}`, { method: 'POST', credentials: 'include' })
          const d = await r.json()
          if (!r.ok || (d.data?.attempted && !d.data.ok)) cardError = d.error ?? d.data?.error ?? 'Error'
        } catch { cardError = 'Error de conexión' }
      }

      if (newCode) {
        toast(`El código de la cerradura ha cambiado. Proporciona el nuevo al cliente: ${newCode}`, 'err')
      } else if (codeError) {
        toast(`Reserva ampliada, pero no se pudo regenerar el código TTLock: ${codeError}`, 'err')
      } else {
        toast(`Reserva ampliada a ${newNights} noches`)
      }
      if (cardError) {
        toast(`Aviso: no se pudo re-enrolar la tarjeta del huésped tras la ampliación: ${cardError}`, 'err')
      }

      onSaved()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <Modal title="Ampliar reserva" onClose={onClose} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', marginBottom: 4 }}>Estancia actual</div>
          <div><strong>{res.checkInDate}</strong> → <strong>{res.checkOutDate}</strong> · {res.nights} noche{res.nights !== 1 ? 's' : ''}</div>
          <div style={{ color: 'var(--text2)', marginTop: 2 }}>Total: <strong>{fmtMoney(res.total)}</strong></div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--text2)', fontWeight: 600 }}>Nueva fecha de salida</span>
          <input type="date" className="form-input" value={newCheckOut} min={minDate}
            onChange={e => { setNewCheckOut(e.target.value); setManualPrice('') }} />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--text2)', fontWeight: 600 }}>Tarifa para las noches extra</span>
          <select className="form-input" value={selRateId ?? ''}
            onChange={e => { setSelRateId(e.target.value ? Number(e.target.value) : null); setManualPrice('') }}>
            <option value="">Sin tarifa (precio manual)</option>
            {rates.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        </label>

        {extraNights > 0 && (
          <div style={{ fontSize: 13 }}>
            <div style={{ color: 'var(--text2)', fontWeight: 600, marginBottom: 6 }}>
              {extraNights} noche{extraNights !== 1 ? 's' : ''} extra{loadingPrices ? ' · cargando…' : ''}
            </div>
            {dayPrices.map(({ date, price, hasPrice }) => (
              <div key={date} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                <span>{fmtDate(date)}</span>
                <span style={{ color: hasPrice ? 'var(--text1)' : 'var(--text2)', fontWeight: hasPrice ? 600 : 400 }}>
                  {hasPrice ? fmtMoney(String(price)) : '—'}
                </span>
              </div>
            ))}
          </div>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span style={{ color: 'var(--text2)', fontWeight: 600 }}>
            Importe extra{!useManual && calculatedExtra > 0 ? ` (calculado: ${fmtMoney(String(calculatedExtra))})` : ''}
          </span>
          <input type="number" className="form-input" min="0" step="0.01"
            placeholder={calculatedExtra > 0 ? calculatedExtra.toFixed(2) : '0.00'}
            value={manualPrice}
            onChange={e => setManualPrice(e.target.value)} />
          {!useManual && <span style={{ fontSize: 11, color: 'var(--text2)' }}>Deja vacío para usar el precio calculado</span>}
        </label>

        {extraNights > 0 && (
          <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, borderLeft: '3px solid var(--accent)' }}>
            <strong>{res.checkInDate} → {newCheckOut}</strong> · {newNights} noches<br />
            <span style={{ color: 'var(--text2)' }}>{fmtMoney(res.total)}</span>
            {' + '}{fmtMoney(String(extraAmount))}
            {' = '}<strong style={{ fontSize: 15 }}>{fmtMoney(String(newTotal))}</strong>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || extraNights <= 0}>
            {saving ? 'Guardando…' : `Ampliar a ${newNights} noches`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
