import React, { useState, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useStandaloneLang, makeT, plural, BOOKING_I18N, type Lang } from './i18n'
import { LangSwitcher } from './LangSwitcher'
import { pfetch, branding, boot } from './branding'

const API = '/api/public'

function fmtMoney(n: number) { return n.toFixed(2).replace('.', ',') + ' €' }
function fmtDate(d: string)  { return new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) }

// ── Reserva iniciada sin pagar — recordarlo aunque el cliente cierre y vuelva
// más tarde a la página de inicio (no solo al volver de Stripe con
// ?cancelled=1). localStorage (no sessionStorage): sobrevive a cerrar la
// pestaña/el navegador.
const PENDING_BOOKING_KEY = 'bm_pending_booking'
type PendingBooking = { reservationId: number; checkIn: string }

function savePendingBooking(b: PendingBooking) {
  try { localStorage.setItem(PENDING_BOOKING_KEY, JSON.stringify(b)) } catch { /* localStorage no disponible */ }
}
function clearPendingBooking() {
  try { localStorage.removeItem(PENDING_BOOKING_KEY) } catch { /* ignorar */ }
}
function loadPendingBooking(): PendingBooking | null {
  try {
    const raw = localStorage.getItem(PENDING_BOOKING_KEY)
    if (!raw) return null
    const b = JSON.parse(raw) as PendingBooking
    if (!b?.reservationId || !b?.checkIn) return null
    if (b.checkIn < new Date().toISOString().slice(0, 10)) { clearPendingBooking(); return null }
    return b
  } catch { return null }
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({ lang, onLangChange, t }: { lang: Lang; onLangChange: (l: Lang) => void; t: (k: string) => string }) {
  return (
    <header className="pub-header">
      <a href={branding.websiteUrl || '/'} target="_top" className="pub-logo">{(() => { const w = branding.name.split(' '); const last = w.pop(); return <>{w.join(' ')}{w.length ? ' ' : ''}<span>{last}</span></> })()}</a>
      <div className="pub-header-links">
        <a href={branding.websiteUrl || '/'} target="_top">{t('booking.backToSite')}</a>
        <a href="/portal" style={{ color: 'var(--blue)', fontWeight: 600 }}>{t('booking.myBookings')}</a>
        <LangSwitcher lang={lang} onChange={onLangChange} />
      </div>
    </header>
  )
}

// ─── Stepper ──────────────────────────────────────────────────────────────────

function Stepper({ step, t }: { step: number; t: (k: string) => string }) {
  const steps = [t('booking.stepAvailability'), t('booking.stepGuestData'), t('booking.stepPayment')]
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <React.Fragment key={i}>
          <div className={`step ${i + 1 === step ? 'active' : i + 1 < step ? 'done' : ''}`}>
            <div className="step-num">{i + 1 < step ? '✓' : i + 1}</div>
            <span>{s}</span>
          </div>
          {i < steps.length - 1 && <div className="step-sep" />}
        </React.Fragment>
      ))}
    </div>
  )
}

// ─── Step 1: Disponibilidad ───────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10) }
function tomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10) }

type RateOption  = { rateId: number; rateTitle: string; rateDescription?: string | null; pricePerNight: number; totalPrice: number; nights: number; minStay?: number; maxStay?: number }
type RoomResult  = { roomTypeId: number; name: string; description: string; maxOccupancy: number; available: number; rates: RateOption[] }
type CartLine    = { roomTypeId: number; rateId: number; quantity: number; roomName: string; rateName: string; maxOccupancy: number; pricePerNight: number; totalPrice: number }

function AvailabilityStep({ lang, t, onSelect }: {
  lang: Lang; t: (k: string, vars?: Record<string, string | number>) => string
  onSelect: (checkIn: string, checkOut: string, guests: number, cart: CartLine[]) => void
}) {
  const [checkIn,   setCheckIn]   = useState(today())
  const [checkOut,  setCheckOut]  = useState(tomorrow())
  const [guests,    setGuests]    = useState(1)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [results,   setResults]   = useState<RoomResult[] | null>(null)
  const [cart,      setCart]      = useState<CartLine[]>([])

  const search = async () => {
    if (checkIn >= checkOut) { setError(t('booking.dateError')); return }
    setLoading(true); setError(''); setResults(null); setCart([])
    try {
      const res = await pfetch(`${API}/availability?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('common.genericError'))
      setResults(data.rooms)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  // Cuántas unidades de ESTE tipo de habitación hay ya en el carrito (en
  // cualquier tarifa) — el tope de cada tarifa es compartido, porque
  // `available` cuenta habitaciones físicas, no combinaciones de tarifa.
  const typeQtyInCart = (roomTypeId: number) =>
    cart.filter(l => l.roomTypeId === roomTypeId).reduce((s, l) => s + l.quantity, 0)

  const setLineQty = (room: RoomResult, rate: RateOption, qty: number) => {
    const thisLineQty  = cart.find(l => l.roomTypeId === room.roomTypeId && l.rateId === rate.rateId)?.quantity ?? 0
    const otherTypeQty = typeQtyInCart(room.roomTypeId) - thisLineQty
    const capped = Math.max(0, Math.min(qty, room.available - otherTypeQty))
    setCart(prev => {
      const rest = prev.filter(l => !(l.roomTypeId === room.roomTypeId && l.rateId === rate.rateId))
      if (capped === 0) return rest
      return [...rest, {
        roomTypeId: room.roomTypeId, rateId: rate.rateId, quantity: capped,
        roomName: room.name, rateName: rate.rateTitle, maxOccupancy: room.maxOccupancy,
        pricePerNight: rate.pricePerNight, totalPrice: rate.totalPrice,
      }]
    })
  }

  const cartTotal = cart.reduce((s, l) => s + l.totalPrice * l.quantity, 0)

  const handleContinue = () => {
    if (cart.length === 0) return
    onSelect(checkIn, checkOut, guests, cart)
  }

  return (
    <div>
      <Stepper step={1} t={t} />
      <div className="pub-card">
        <div className="pub-card-title">{t('booking.whenTitle')}</div>
        <div className="form-row">
          <div className="form-group">
            <label>{t('booking.arrival')}</label>
            <input type="date" value={checkIn} min={today()} onChange={e => { setCheckIn(e.target.value); setResults(null); setCart([]) }} />
          </div>
          <div className="form-group">
            <label>{t('booking.departure')}</label>
            <input type="date" value={checkOut} min={checkIn} onChange={e => { setCheckOut(e.target.value); setResults(null); setCart([]) }} />
          </div>
        </div>
        <div className="form-group" style={{ maxWidth: 160 }}>
          <label>{t('booking.guestsSelectLabel')}</label>
          <select value={guests} onChange={e => { setGuests(+e.target.value); setResults(null); setCart([]) }}>
            {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n} {plural(lang, n, t('common.personOne'), t('common.personOther'))}</option>)}
          </select>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <button className="btn btn-primary btn-full btn-lg" onClick={search} disabled={loading}>
          {loading ? <><span className="spin" /> {t('booking.searching')}</> : t('booking.searchButton')}
        </button>
      </div>

      {results !== null && (
        results.length === 0
          ? <div className="pub-card" style={{ textAlign: 'center', color: 'var(--text2)' }}>
              <p style={{ fontSize: 32, marginBottom: 8 }}>😔</p>
              <p>{t('booking.noAvailabilityTitle')} — {t('booking.noAvailabilitySub')}</p>
            </div>
          : <>
              <div className="room-list">
                {results.map(room => (
                  <div key={room.roomTypeId} className="room-card">
                    <div className="room-card-header">
                      <div>
                        <div className="room-card-name">{room.name}</div>
                        <div className="room-card-avail">
                          {t('booking.roomAvailCount', { n: room.available, s: room.available !== 1 ? 's' : '', max: room.maxOccupancy })}
                        </div>
                      </div>
                    </div>

                    <div className="rate-selector">
                      {room.rates.map(rate => {
                        const lineQty      = cart.find(l => l.roomTypeId === room.roomTypeId && l.rateId === rate.rateId)?.quantity ?? 0
                        const otherTypeQty = typeQtyInCart(room.roomTypeId) - lineQty
                        const maxForLine   = Math.max(0, room.available - otherTypeQty)
                        return (
                          <div key={rate.rateId} className={`rate-option ${lineQty > 0 ? 'selected' : ''}`}>
                            <span className="rate-option-name" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                                {rate.rateTitle}
                                {rate.minStay && rate.minStay > 1 && <span className="rate-stay-tag">{t('booking.minStayTag', { n: rate.minStay })}</span>}
                              </span>
                              {rate.rateDescription && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text2)' }}>{rate.rateDescription}</span>}
                              <span style={{ fontSize: 12, color: 'var(--text2)' }}>{fmtMoney(rate.pricePerNight)}{t('common.perNight')}</span>
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span className="rate-option-price">{fmtMoney(rate.totalPrice)}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <button type="button" onClick={() => setLineQty(room, rate, lineQty - 1)} disabled={lineQty === 0}
                                  style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer', fontSize: 15 }}>−</button>
                                <span style={{ minWidth: 16, textAlign: 'center', fontWeight: 700 }}>{lineQty}</span>
                                <button type="button" onClick={() => setLineQty(room, rate, lineQty + 1)} disabled={lineQty >= maxForLine}
                                  style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer', fontSize: 15 }}>+</button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {cart.length > 0 && (
                <div className="pub-card" style={{ marginTop: 20 }}>
                  <div className="pub-card-title">{t('booking.cartTitle')}</div>
                  {cart.map(l => (
                    <div key={`${l.roomTypeId}-${l.rateId}`} className="summary-row">
                      <span>{l.quantity}× {l.roomName} ({l.rateName})</span>
                      <span>{fmtMoney(l.totalPrice * l.quantity)}</span>
                    </div>
                  ))}
                  <div className="summary-row total"><span>{t('common.total')}</span><span>{fmtMoney(cartTotal)}</span></div>
                  <button className="btn btn-primary btn-full btn-lg" style={{ marginTop: 12 }} onClick={handleContinue}>
                    {t('booking.continue')}
                  </button>
                </div>
              )}
            </>
      )}
    </div>
  )
}

// ─── Step 2: Datos del huésped ────────────────────────────────────────────────

type ExtraItem = { id: number; title: string; description: string | null; icon: string | null; pricingType: string; maxQuantity: number; defaultPrice: string | null }

function extraUnitPrice(item: ExtraItem, nights: number, guests: number): number {
  const base = parseFloat(item.defaultPrice ?? '0')
  switch (item.pricingType) {
    case 'per_night':        return base * nights
    case 'per_person':       return base * guests
    case 'per_person_night': return base * guests * nights
    default:                 return base
  }
}

function extraPricingLabel(item: ExtraItem, nights: number, guests: number, t: (k: string) => string): string {
  const unit  = extraUnitPrice(item, nights, guests)
  const price = fmtMoney(parseFloat(item.defaultPrice ?? '0'))
  switch (item.pricingType) {
    case 'per_night':        return `${price}${t('common.perNight')}`
    case 'per_person':       return `${price}${t('common.perPerson')}`
    case 'per_person_night': return `${price}${t('common.perPersonNight')}`
    default:                 return fmtMoney(unit)
  }
}

type BookingData = {
  checkIn: string; checkOut: string; guests: number; nights: number
  cart: CartLine[]; totalPrice: number
}

function GuestStep({ lang, t, booking, onBack, onPay }: {
  lang: Lang; t: (k: string, vars?: Record<string, string | number>) => string
  booking: BookingData
  onBack: () => void
  onPay: (url: string) => void
}) {
  const [firstName, setFirstName] = useState('')
  const [lastName,  setLastName]  = useState('')
  const [email,     setEmail]     = useState('')
  const [phone,     setPhone]     = useState('')
  const [notes,     setNotes]     = useState('')
  const [bedPreferenceTwin, setBedPreferenceTwin] = useState(false)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [extras,    setExtras]    = useState<ExtraItem[]>([])
  const [qtys,      setQtys]      = useState<Record<number, number>>({})

  useEffect(() => {
    pfetch(`${API}/extras`).then(r => r.json()).then(d => setExtras(d.data ?? [])).catch(() => {})
  }, [])

  const extrasTotal = extras.reduce((s, e) => {
    const q = qtys[e.id] ?? 0
    return s + (q > 0 ? extraUnitPrice(e, booking.nights, booking.guests) * q : 0)
  }, 0)
  const grandTotal = booking.totalPrice + extrasTotal

  const setQty = (id: number, q: number) => setQtys(prev => ({ ...prev, [id]: Math.max(0, Math.min(q, extras.find(e => e.id === id)?.maxQuantity ?? 1)) }))

  // ── Descuento temporal (ver POST /discount-timer) ────────────────────────
  // Se arranca UNA vez, en cuanto el cliente ha rellenado nombre+apellidos+
  // email, y se guarda en sessionStorage para que sobreviva a una recarga de
  // página sin reiniciar el reloj. Vive entera en esta página — no se manda
  // nada por email.
  const [discountInfo, setDiscountInfo] = useState<{ token: string; activatesAt: number; expiresAt: number; pct: number } | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const discountRequested = useRef(false)

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('bm_discount_timer')
      if (saved) { setDiscountInfo(JSON.parse(saved)); discountRequested.current = true }
    } catch { /* sessionStorage no disponible — se sigue sin descuento */ }
  }, [])

  useEffect(() => {
    if (discountRequested.current) return
    if (!firstName.trim() || !lastName.trim() || !/^\S+@\S+\.\S+$/.test(email)) return
    discountRequested.current = true
    const t0 = setTimeout(() => {
      pfetch(`${API}/discount-timer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, email }),
      }).then(r => r.json()).then(d => {
        if (!d.data?.enabled) return
        const info = {
          token: d.data.token,
          activatesAt: new Date(d.data.activatesAt).getTime(),
          expiresAt: new Date(d.data.expiresAt).getTime(),
          pct: d.data.discountPct,
        }
        setDiscountInfo(info)
        try { sessionStorage.setItem('bm_discount_timer', JSON.stringify(info)) } catch { /* ignorar */ }
      }).catch(() => {})
    }, 800) // pequeño margen por si el cliente sigue tecleando
    return () => clearTimeout(t0)
  }, [firstName, lastName, email])

  useEffect(() => {
    if (!discountInfo || nowTick > discountInfo.expiresAt) return
    const iv = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [discountInfo, nowTick > (discountInfo?.expiresAt ?? 0)])

  const discountActive = !!discountInfo && nowTick >= discountInfo.activatesAt && nowTick <= discountInfo.expiresAt
  const discountAmount = discountActive ? Math.round(grandTotal * discountInfo!.pct / 100 * 100) / 100 : 0
  const finalTotal = Math.round((grandTotal - discountAmount) * 100) / 100
  const discountRemainingMs = discountActive ? Math.max(0, discountInfo!.expiresAt - nowTick) : 0
  const discountRemainingLabel = `${Math.floor(discountRemainingMs / 60000)}:${String(Math.floor((discountRemainingMs % 60000) / 1000)).padStart(2, '0')}`

  const submit = async () => {
    if (!firstName || !lastName || !email) { setError(t('booking.requiredFieldsError')); return }
    setLoading(true); setError('')
    const selectedExtras = Object.entries(qtys)
      .filter(([, q]) => q > 0)
      .map(([id, quantity]) => ({ saleItemId: parseInt(id), quantity }))
    try {
      const res = await pfetch(`${API}/checkout`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          checkIn:    booking.checkIn,
          checkOut:   booking.checkOut,
          rooms:      booking.cart.map(l => ({ roomTypeId: l.roomTypeId, rateId: l.rateId, quantity: l.quantity })),
          guests:     booking.guests,
          firstName, lastName, email, phone: phone || undefined, notes: notes || undefined,
          bedPreferenceTwin: booking.cart.some(l => l.maxOccupancy === 2) ? bedPreferenceTwin : undefined,
          extras:     selectedExtras.length ? selectedExtras : undefined,
          discountToken: discountActive ? discountInfo!.token : undefined,
          source: 'standalone',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('booking.checkoutError'))
      if (data.reservationId) savePendingBooking({ reservationId: data.reservationId, checkIn: booking.checkIn })
      onPay(data.url)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <div>
      <Stepper step={2} t={t} />

      <div className="summary-box">
        {booking.cart.map(l => (
          <div key={`${l.roomTypeId}-${l.rateId}`} className="summary-row">
            <span>{l.quantity}× {l.roomName} ({l.rateName})</span><span>{fmtMoney(l.totalPrice * l.quantity)}</span>
          </div>
        ))}
        <div className="summary-row"><span>{fmtDate(booking.checkIn)} → {fmtDate(booking.checkOut)}</span><span>{booking.nights} {plural(lang, booking.nights, t('common.nightOne'), t('common.nightOther'))}</span></div>
        {extrasTotal > 0 && <div className="summary-row"><span>Extras</span><span>+{fmtMoney(extrasTotal)}</span></div>}
        {discountActive ? (
          <>
            <div className="summary-row"><span style={{ textDecoration: 'line-through', opacity: 0.6 }}>{t('common.total')}</span><span style={{ textDecoration: 'line-through', opacity: 0.6 }}>{fmtMoney(grandTotal)}</span></div>
            <div className="summary-row"><span>{t('booking.discountApplied', { pct: discountInfo!.pct, amount: fmtMoney(discountAmount) })}</span><span /></div>
            <div className="summary-row total"><span>{t('common.total')}</span><span>{fmtMoney(finalTotal)}</span></div>
          </>
        ) : (
          <div className="summary-row total"><span>{t('common.total')}</span><span>{fmtMoney(grandTotal)}</span></div>
        )}
      </div>

      {discountActive && (
        <div className="alert" style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e', fontWeight: 600, marginBottom: 16 }}>
          ⚡ {t('booking.discountCountdown', { time: discountRemainingLabel, pct: discountInfo!.pct })}
        </div>
      )}

      {extras.length > 0 && (
        <div className="pub-card" style={{ marginBottom: 16 }}>
          <div className="pub-card-title">{t('booking.optionalServices')}</div>
          {extras.map(e => {
            const q    = qtys[e.id] ?? 0
            const unit = extraUnitPrice(e, booking.nights, booking.guests)
            return (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                {e.icon && <span style={{ fontSize: 24, width: 32, textAlign: 'center' }}>{e.icon}</span>}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{e.title}</div>
                  {e.description && <div style={{ fontSize: 12, color: 'var(--text2)' }}>{e.description}</div>}
                  <div style={{ fontSize: 12, color: 'var(--blue)', marginTop: 2 }}>{extraPricingLabel(e, booking.nights, booking.guests, t)}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {e.maxQuantity > 1 ? (
                    <>
                      <button onClick={() => setQty(e.id, q - 1)} style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer', fontSize: 16 }}>−</button>
                      <span style={{ minWidth: 20, textAlign: 'center', fontWeight: 600 }}>{q}</span>
                      <button onClick={() => setQty(e.id, q + 1)} style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer', fontSize: 16 }}>+</button>
                    </>
                  ) : (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={q > 0} onChange={ev => setQty(e.id, ev.target.checked ? 1 : 0)} style={{ width: 18, height: 18 }} />
                      {q > 0 && <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{fmtMoney(unit)}</span>}
                    </label>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="pub-card">
        <div className="pub-card-title">{t('booking.guestDataTitle')}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-row">
          <div className="form-group">
            <label>{t('booking.firstName')}</label>
            <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Ana" />
          </div>
          <div className="form-group">
            <label>{t('booking.lastName')}</label>
            <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} placeholder="García López" />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>{t('booking.email')}</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="ana@email.com" />
          </div>
          <div className="form-group">
            <label>{t('booking.phone')}</label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+34 600 000 000" />
          </div>
        </div>
        {booking.cart.some(l => l.maxOccupancy === 2) && (
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={bedPreferenceTwin} onChange={e => setBedPreferenceTwin(e.target.checked)} style={{ width: 18, height: 18 }} />
              {t('booking.twinBeds')}
            </label>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>{t('booking.twinBedsHint')}</div>
          </div>
        )}
        <div className="form-group">
          <label>{t('booking.notes')}</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('booking.notesPlaceholder')} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          <button className="btn btn-ghost" onClick={onBack}>{t('common.back')}</button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={submit} disabled={loading}>
            {loading ? <><span className="spin" /> {t('common.processing')}</> : t('booking.payButton', { total: fmtMoney(discountActive ? finalTotal : grandTotal) })}
          </button>
        </div>
      </div>
    </div>
  )
}

import { fireBookingConversion } from './gtag'

// ─── Success page ─────────────────────────────────────────────────────────────

function SuccessPage({ t }: { t: (k: string, vars?: Record<string, string | number>) => string }) {
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    const sid = new URLSearchParams(location.search).get('session_id')
    if (!sid) return
    pfetch(`${API}/booking/confirm?session_id=${sid}`)
      .then(r => r.json()).then(d => {
        setData(d.data)
        if (d.data) fireBookingConversion(d.data)   // Google Ads: solo si está pagada
        clearPendingBooking()   // ya pagada — deja de avisar de "reserva iniciada"
      }).catch(() => {})
  }, [])

  return (
    <div>
      <div className="success-wrap">
        <div className="success-icon">✅</div>
        <div className="success-title">{t('booking.successTitle')}</div>
        <div className="success-sub">
          {t('booking.successEmailSent')}<br />
          {data && t('booking.successInfo', { id: data.id, checkIn: fmtDate(data.checkInDate), checkOut: fmtDate(data.checkOutDate) })}
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/portal" className="btn btn-primary btn-lg">{t('booking.viewMyBookings')}</a>
          <a href={branding.websiteUrl || '/'} target="_top" className="btn btn-ghost btn-lg">{t('booking.backToSite')}</a>
        </div>
      </div>
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

// ─── Reserva pendiente (vuelta de un pago cancelado en Stripe) ────────────────
// Cuando el cliente cancela en Stripe, en vez de mandarlo a empezar la
// búsqueda de cero se le ofrece retomar directamente esa misma reserva
// tentativa (ver POST /checkout/resume) — nunca se ha perdido, sigue en la
// BD sin pagar.
function ResumePendingStep({ t, lang, reservationId, source, onStartOver }: {
  t: (k: string, vars?: Record<string, string | number>) => string
  lang: Lang
  reservationId: number
  source: 'standalone' | 'widget'
  onStartOver: () => void
}) {
  const [pending, setPending] = useState<any>(null)
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [nowTick, setNowTick] = useState(() => Date.now())

  useEffect(() => {
    pfetch(`${API}/booking/pending/${reservationId}`).then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setPending(d.data))
      .catch(() => setNotFound(true))
  }, [reservationId])

  // Si no se le aplicó descuento en el primer intento (pagó antes del minuto
  // 5) pero el temporizador guardado en esta misma sesión sigue en ventana
  // válida, se le ofrece ahora al retomar el pago.
  const storedDiscount = (() => {
    try {
      const raw = sessionStorage.getItem('bm_discount_timer')
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  })()
  const alreadyDiscounted = pending?.discountPct != null
  const canOfferDiscount = !alreadyDiscounted && storedDiscount
    && nowTick >= storedDiscount.activatesAt && nowTick <= storedDiscount.expiresAt

  useEffect(() => {
    if (!canOfferDiscount) return
    const iv = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [canOfferDiscount])

  const resume = async () => {
    setLoading(true); setError('')
    try {
      const res = await pfetch(`${API}/checkout/resume`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationId, source, discountToken: canOfferDiscount ? storedDiscount.token : undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('booking.checkoutError'))
      window.location.href = data.url
    } catch (e: any) { setError(e.message); setLoading(false) }
  }

  if (notFound) return (
    <div className="pub-card">
      <p>{t('booking.pendingNotFound')}</p>
      <button className="btn btn-primary" onClick={onStartOver}>{t('booking.startOver')}</button>
    </div>
  )
  if (!pending) return <div className="loading">…</div>

  const discountRemainingMs = canOfferDiscount ? Math.max(0, storedDiscount.expiresAt - nowTick) : 0
  const discountRemainingLabel = `${Math.floor(discountRemainingMs / 60000)}:${String(Math.floor((discountRemainingMs % 60000) / 1000)).padStart(2, '0')}`

  return (
    <div className="pub-card">
      <div className="pub-card-title">{t('booking.pendingTitle')}</div>
      {error && <div className="alert alert-error">{error}</div>}
      {canOfferDiscount && (
        <div className="alert" style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e', fontWeight: 600, marginBottom: 12 }}>
          ⚡ {t('booking.discountCountdown', { time: discountRemainingLabel, pct: storedDiscount.pct })}
        </div>
      )}
      <div className="summary-box">
        {pending.rateName && <div className="summary-row"><span>{pending.rateName}</span><span /></div>}
        <div className="summary-row"><span>{fmtDate(pending.checkIn)} → {fmtDate(pending.checkOut)}</span><span>{pending.nights} {plural(lang, pending.nights, t('common.nightOne'), t('common.nightOther'))}</span></div>
        {alreadyDiscounted && (
          <div className="summary-row"><span>{t('booking.discountApplied', { pct: pending.discountPct, amount: fmtMoney(parseFloat(pending.discountAmount)) })}</span><span /></div>
        )}
        <div className="summary-row total"><span>{t('common.total')}</span><span>{fmtMoney(parseFloat(pending.total))}</span></div>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onStartOver}>{t('booking.startOver')}</button>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={resume} disabled={loading}>
          {loading ? <><span className="spin" /> {t('common.processing')}</> : t('booking.completePayment')}
        </button>
      </div>
    </div>
  )
}

function App() {
  const isSuccess = location.pathname.includes('/success')
  const params = new URLSearchParams(location.search)
  const pendingReservationId = params.get('cancelled') === '1' ? Number(params.get('reservationId')) : null
  const [lang, setLang] = useStandaloneLang()
  const t = makeT(lang, BOOKING_I18N)
  const [step,    setStep]    = useState(1)
  const [booking, setBooking] = useState<BookingData | null>(null)
  const [resuming, setResuming] = useState(!!pendingReservationId)
  // Reserva iniciada sin pagar de una visita anterior (no viene de la vuelta
  // de Stripe, sino de simplemente reabrir la página más tarde).
  const [pendingBanner, setPendingBanner] = useState<PendingBooking | null>(() => pendingReservationId ? null : loadPendingBooking())
  const resumeId = pendingReservationId ?? pendingBanner?.reservationId ?? null

  if (isSuccess) return (
    <>
      <Header lang={lang} onLangChange={setLang} t={t} />
      <div className="pub-wrap"><SuccessPage t={t} /></div>
    </>
  )

  if (resuming && resumeId) return (
    <>
      <Header lang={lang} onLangChange={setLang} t={t} />
      <div className="pub-wrap">
        <ResumePendingStep t={t} lang={lang} reservationId={resumeId} source="standalone"
          onStartOver={() => { clearPendingBooking(); setPendingBanner(null); setResuming(false) }} />
      </div>
    </>
  )

  return (
    <>
      <Header lang={lang} onLangChange={setLang} t={t} />
      <div className="pub-wrap">
        <h1 className="pub-title">{t('booking.pageTitle')}</h1>
        <p className="pub-sub">{t('booking.pageSub')}</p>

        {pendingBanner && (
          <div className="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e', fontWeight: 600, marginBottom: 16 }}>
            <span>📌 {t('booking.pendingBannerText')}</span>
            <button className="btn btn-primary btn-sm" onClick={() => setResuming(true)}>{t('booking.completePayment')}</button>
          </div>
        )}

        {step === 1 && (
          <AvailabilityStep lang={lang} t={t} onSelect={(checkIn, checkOut, guests, cart) => {
            const nights = Math.round((new Date(checkOut + 'T12:00:00').getTime() - new Date(checkIn + 'T12:00:00').getTime()) / 86400000)
            setBooking({
              checkIn, checkOut, guests, nights, cart,
              totalPrice: cart.reduce((s, l) => s + l.totalPrice * l.quantity, 0),
            })
            setStep(2)
          }} />
        )}

        {step === 2 && booking && (
          <GuestStep
            lang={lang} t={t}
            booking={booking}
            onBack={() => setStep(1)}
            onPay={url => { window.location.href = url }}
          />
        )}
      </div>
    </>
  )
}

boot(() => createRoot(document.getElementById('root')!).render(
  <App />
))
