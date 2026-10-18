import React, { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { fireBookingConversion } from './gtag'
import { useWidgetLang, makeT, plural, BOOKING_I18N } from './i18n'
import { pfetch, branding, boot, postParent } from './branding'

const API = '/api/public'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMoney(n: number) { return n.toFixed(2).replace('.', ',') + ' €' }
function fmtDate(d: string)  { return new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) }
function toDay(d: Date)      { return d.toISOString().split('T')[0] }

// Notifica al padre la altura actual del documento para redimensionar el iframe
// expanded=true cuando el widget ha pasado del formulario inicial (resultados, formulario de reserva, etc.)
// +16px de margen: scrollHeight puede quedarse un poco corto (redondeo de
// subpíxel, fuentes que aún no han terminado de cargar…) y el iframe del
// padre acababa quedándose justo con scroll vertical.
function postHeight(expanded = false) {
  const h = document.documentElement.scrollHeight + 16
  postParent('widget-height', { height: h, expanded })
}

// ── Reserva iniciada sin pagar — recordarlo aunque el cliente cierre y vuelva
// más tarde a la página de inicio del widget (no solo al volver de Stripe con
// ?cancelled=1). localStorage (no sessionStorage): sobrevive a cerrar la
// pestaña/el navegador — el aviso de "reserva iniciada" tiene sentido volver
// a verlo días después, no solo en la misma sesión.
const PENDING_BOOKING_KEY = 'bm_pending_booking'
type PendingBooking = { reservationId: number; checkIn: string }

function savePendingBooking(b: PendingBooking) {
  try { localStorage.setItem(PENDING_BOOKING_KEY, JSON.stringify(b)) } catch { /* localStorage no disponible */ }
}
function clearPendingBooking() {
  try { localStorage.removeItem(PENDING_BOOKING_KEY) } catch { /* ignorar */ }
}
// null si no hay ninguna, o si las fechas ya pasaron (no tiene sentido seguir avisando).
function loadPendingBooking(): PendingBooking | null {
  try {
    const raw = localStorage.getItem(PENDING_BOOKING_KEY)
    if (!raw) return null
    const b = JSON.parse(raw) as PendingBooking
    if (!b?.reservationId || !b?.checkIn) return null
    if (b.checkIn < (toDay(new Date()) ?? '')) { clearPendingBooking(); return null }
    return b
  } catch { return null }
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

type RateOption  = { rateId: number; rateTitle: string; rateDescription?: string | null; pricePerNight: number; totalPrice: number; nights: number; minStay?: number; maxStay?: number }
type RoomResult  = { roomTypeId: number; name: string; description: string; maxOccupancy: number; maxOccupancyBookingEngine: number | null; available: number; rates: RateOption[] }
type ExtraItem   = { id: number; title: string; description: string | null; icon: string | null; pricingType: string; maxQuantity: number; defaultPrice: string | null }
type CartLine    = { roomTypeId: number; rateId: number; quantity: number; roomName: string; rateName: string; maxOccupancy: number; pricePerNight: number; totalPrice: number }

function extraUnitPrice(item: ExtraItem, nights: number, guests: number): number {
  const base = parseFloat(item.defaultPrice ?? '0')
  switch (item.pricingType) {
    case 'per_night':        return base * nights
    case 'per_person':       return base * guests
    case 'per_person_night': return base * guests * nights
    default:                 return base
  }
}

// ─── Estilos inline (sin CSS externo para máxima portabilidad del iframe) ────

const css = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --amber:    #ffc107;
    --amber-dk: #e0a800;
    --amber-lt: #fff8e1;
    --blue:     #2563eb;
    --blue-dk:  #1d4ed8;
    --green:    #16a34a;
    --red:      #dc2626;
    --border:   #dee2e6;
    --border2:  #e5e7eb;
    --bg:       #f8f9fa;
    --card:     #ffffff;
    --text:     #212529;
    --text2:    #6c757d;
    --radius:   10px;
  }

  html, body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: transparent;
    color: var(--text);
    font-size: 14px;
  }

  /* ── Widget booking form ── */
  .w-form {
    background: rgba(255,255,255,0.96);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(255,193,7,0.35);
    border-radius: 12px;
    box-shadow: 0 6px 28px rgba(0,0,0,0.28);
    padding: 1rem 1.2rem 1.2rem;
  }

  /* Siempre horizontal, sin wrap en pantallas ≥540px */
  .w-fields {
    display: grid;
    grid-template-columns: 1fr 1fr auto auto;
    gap: 8px;
    align-items: end;
  }

  .w-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .w-label {
    font-size: 0.67rem;
    font-weight: 700;
    color: #b08800;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
  }

  .w-input {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 7px 10px;
    font-size: 0.87rem;
    font-family: inherit;
    width: 100%;
    cursor: pointer;
    color-scheme: light;
    transition: border-color 0.2s, box-shadow 0.2s;
    outline: none;
    height: 36px;
  }
  .w-input:hover:not(:disabled) { border-color: var(--amber); background: #fff; }
  .w-input:focus { border-color: var(--amber); box-shadow: 0 0 0 3px rgba(255,193,7,0.2); background: #fff; }
  .w-input:disabled { opacity: 0.4; cursor: not-allowed; }
  .w-input::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.5; }

  .w-guests {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 5px 10px;
    height: 36px;
    white-space: nowrap;
  }

  .w-guests-btn {
    background: var(--amber);
    color: var(--text);
    border: none;
    border-radius: 4px;
    width: 22px;
    height: 22px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .w-guests-btn:hover { background: var(--amber-dk); }

  .w-guests-val { font-size: 0.9rem; font-weight: 700; min-width: 18px; text-align: center; }

  .w-btn-search {
    height: 36px;
    padding: 0 14px;
    font-size: 0.87rem;
    font-family: inherit;
    font-weight: 700;
    border: none;
    border-radius: 7px;
    white-space: nowrap;
    background: var(--amber);
    color: var(--text);
    cursor: pointer;
    transition: background 0.15s;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .w-btn-search:hover:not(:disabled) { background: var(--amber-dk); }
  .w-btn-search:disabled { opacity: 0.5; cursor: not-allowed; }

  .w-summary {
    margin-top: 7px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 0.78rem;
    color: var(--text2);
  }

  .w-offer-pill {
    background: var(--amber-lt);
    border: 1px solid var(--amber);
    color: #856404;
    border-radius: 20px;
    padding: 2px 8px;
  }

  /* ── Resultados y flujo de reserva ── */
  .w-results {
    margin-top: 10px;
    background: #fff;
    border: 1px solid rgba(255,193,7,0.3);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 3px 16px rgba(0,0,0,0.10);
  }

  .w-results-inner { padding: 14px 16px; }

  .w-section-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .w-room-list { display: flex; flex-direction: column; gap: 8px; }

  .w-room-card {
    border: 2px solid var(--border2);
    border-radius: 8px;
    padding: 11px 13px;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
    background: #fff;
  }
  .w-room-card:hover { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.08); }
  .w-room-card.selected { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }

  .w-room-hdr { display: flex; justify-content: space-between; align-items: flex-start; }
  .w-room-name { font-size: 14px; font-weight: 700; }
  .w-room-avail { font-size: 11px; color: var(--text2); margin-top: 2px; }
  .w-room-price-main { font-size: 17px; font-weight: 700; color: var(--blue); text-align: right; }
  .w-room-price-night { font-size: 10px; color: var(--text2); text-align: right; }

  .w-rate-list { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .w-rate-opt {
    display: flex; justify-content: space-between; align-items: center;
    padding: 7px 10px; border: 1.5px solid var(--border2); border-radius: 6px;
    cursor: pointer; transition: border-color 0.12s; font-size: 12px;
  }
  .w-rate-opt:hover { border-color: #93c5fd; }
  .w-rate-opt.selected { border-color: var(--blue); background: #eff6ff; }
  .w-rate-name { font-weight: 600; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .w-rate-tag { font-size: 10px; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; border-radius: 4px; padding: 1px 4px; }
  .w-rate-price { font-weight: 700; color: var(--blue); }

  /* ── Stepper ── */
  .w-stepper { display: flex; gap: 6px; margin-bottom: 14px; align-items: center; }
  .w-step { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--text2); }
  .w-step.active { color: var(--blue); }
  .w-step.done { color: var(--green); }
  .w-step-num { width: 20px; height: 20px; border-radius: 50%; border: 2px solid currentColor; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; flex-shrink: 0; }
  .w-step-sep { flex: 1; height: 1px; background: var(--border2); min-width: 12px; }

  /* ── Summary box ── */
  .w-summary-box {
    background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 7px;
    padding: 10px 14px; margin-bottom: 12px; font-size: 12px;
  }
  .w-summary-row { display: flex; justify-content: space-between; padding: 2px 0; }
  .w-summary-row.total { font-weight: 700; font-size: 14px; border-top: 1px solid #bfdbfe; margin-top: 5px; padding-top: 6px; }

  /* ── Form ── */
  .w-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .w-form-full { grid-column: 1 / -1; }
  .w-fgroup { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .w-fgroup label { font-size: 11px; font-weight: 600; color: var(--text); }
  .w-finput {
    border: 1px solid var(--border2); border-radius: 6px;
    padding: 7px 10px; font-size: 13px; font-family: inherit;
    color: var(--text); background: #fff; outline: none;
    transition: border-color .15s;
  }
  .w-finput:focus { border-color: var(--blue); }
  textarea.w-finput { resize: vertical; min-height: 55px; }

  /* ── Buttons ── */
  .w-btn {
    display: inline-flex; align-items: center; justify-content: center;
    gap: 5px; padding: 8px 16px; border: none; border-radius: 7px;
    font-size: 13px; font-weight: 700; font-family: inherit;
    cursor: pointer; transition: opacity .15s, background .15s; text-decoration: none;
  }
  .w-btn:disabled { opacity: .5; cursor: not-allowed; }
  .w-btn-primary { background: var(--blue); color: #fff; }
  .w-btn-primary:hover:not(:disabled) { background: var(--blue-dk); }
  .w-btn-ghost { background: transparent; color: var(--text); border: 1px solid var(--border2); }
  .w-btn-ghost:hover:not(:disabled) { background: var(--bg); }
  .w-btn-full { width: 100%; }
  .w-btn-lg { padding: 10px 18px; font-size: 13px; }

  /* ── Extras ── */
  .w-extra-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 0; border-bottom: 1px solid var(--border2);
  }

  /* ── Alert ── */
  .w-alert { padding: 8px 11px; border-radius: 6px; font-size: 12px; margin-bottom: 10px; }
  .w-alert-err { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }

  /* ── Spin ── */
  .w-spin { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.4); border-top-color: currentColor; border-radius: 50%; animation: wspin .6s linear infinite; }
  .w-spin-amber { border-color: rgba(0,0,0,.15); border-top-color: var(--text); }
  @keyframes wspin { to { transform: rotate(360deg) } }

  /* ── Success ── */
  .w-success { text-align: center; padding: 24px 16px; }
  .w-success-icon { font-size: 44px; margin-bottom: 10px; }
  .w-success-title { font-size: 18px; font-weight: 700; margin-bottom: 5px; }
  .w-success-sub { color: var(--text2); font-size: 12px; margin-bottom: 16px; line-height: 1.5; }

  /* ── Empty ── */
  .w-empty { text-align: center; padding: 24px 16px; color: var(--text2); }

  @media (max-width: 540px) {
    .w-form { padding: 0.8rem 0.9rem 0.7rem; }
    .w-fields { grid-template-columns: 1fr 1fr; }
    .w-btn-search { justify-content: center; }
    .w-form-grid { grid-template-columns: 1fr; }
  }

  /* Pantallas muy estrechas (≤390px, ej. iPhone SE / 16e): inputs de fecha más compactos */
  @media (max-width: 390px) {
    .w-fields .w-field:nth-child(1) .w-input,
    .w-fields .w-field:nth-child(2) .w-input {
      font-size: 0.72rem;
      padding: 6px 4px;
      letter-spacing: -0.3px;
    }
  }
`

// ─── BookingWidget ─────────────────────────────────────────────────────────────

type Phase = 'form' | 'results' | 'guest' | 'success' | 'resume'

type BookingCtx = {
  checkIn: string; checkOut: string; guests: number; nights: number
  cart: CartLine[]; totalPrice: number
}

function offerMsg(t: (k: string) => string, nights: number): string | null {
  if (nights === 2)             return t('booking.offer2Nights')
  if (nights >= 7 && nights < 30) return t('booking.offerWeekly')
  if (nights >= 30)             return t('booking.offerMonthly')
  return null
}

const pendingParams = new URLSearchParams(location.search)
const pendingReservationId = pendingParams.get('cancelled') === '1' ? Number(pendingParams.get('reservationId')) : null

export default function BookingWidget() {
  const lang = useWidgetLang()
  const [phase,        setPhase]        = useState<Phase>(pendingReservationId ? 'resume' : 'form')
  const [ctx,          setCtx]          = useState<BookingCtx | null>(null)
  const [_payUrl,      setPayUrl]       = useState('')
  const [resetTrigger, setResetTrigger] = useState(0)
  // Reserva iniciada sin pagar, guardada en una visita anterior (no viene de
  // la URL de vuelta de Stripe, sino de simplemente reabrir la página de
  // inicio del widget más tarde).
  const [pendingBanner, setPendingBanner] = useState<PendingBooking | null>(() => pendingReservationId ? null : loadPendingBooking())
  const resumeId = pendingReservationId ?? pendingBanner?.reservationId ?? null
  const rootRef = useRef<HTMLDivElement>(null)

  // Altura al padre cada vez que cambia el DOM. Al cambiar de fase (sobre
  // todo al ENCOGER, p.ej. volver de resultados/pago al formulario inicial)
  // se reenvía varias veces en los siguientes instantes: el primer scrollHeight
  // puede quedarse corto por reflows tardíos (fuente, backdrop-filter) y si el
  // padre se queda con ese primer valor el iframe se queda pequeño y reaparece
  // el scroll — los reenvíos posteriores corrigen la altura final.
  useLayoutEffect(() => {
    const isExpanded = phase !== 'form'
    const send = () => postHeight(isExpanded)
    send()
    const timers = [50, 150, 300, 600].map(ms => setTimeout(send, ms))
    const ro = new ResizeObserver(send)
    ro.observe(document.documentElement)
    return () => { timers.forEach(clearTimeout); ro.disconnect() }
  }, [phase])

  // El padre puede pedir al widget que vuelva al formulario sin recargar el iframe
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if ((e.data?.type === 'bm-widget-reset' || e.data?.type === 'betania-widget-reset')) {
        setPhase('form')
        setResetTrigger(t => t + 1)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Al entrar al paso 2 pide al padre que haga scroll al top para que el formulario de fechas quede visible
  useEffect(() => {
    if (phase === 'guest') {
      window.scrollTo(0, 0)
      postParent('widget-scroll-top')
    }
  }, [phase])

  if (phase === 'success') return (
    <div ref={rootRef}>
      <SuccessPhase lang={lang} />
    </div>
  )

  if (phase === 'resume' && resumeId) return (
    <div ref={rootRef}>
      <ResumePendingPhase lang={lang} reservationId={resumeId}
        onStartOver={() => { clearPendingBooking(); setPendingBanner(null); setPhase('form') }} />
    </div>
  )

  return (
    <div ref={rootRef}>
      {phase === 'form' && pendingBanner && (
        <div className="w-pending-banner" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e',
          borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, fontWeight: 600,
        }}>
          <span>📌 {makeT(lang, BOOKING_I18N)('booking.pendingBannerText')}</span>
          <button className="w-btn w-btn-primary" style={{ flexShrink: 0 }} onClick={() => setPhase('resume')}>
            {makeT(lang, BOOKING_I18N)('booking.completePayment')}
          </button>
        </div>
      )}
      <SearchForm
        lang={lang}
        onSearch={() => setPhase('results')}
        resetTrigger={resetTrigger}
        onBook={(checkIn, checkOut, guests, cart) => {
          const nights = Math.round((new Date(checkOut + 'T12:00:00').getTime() - new Date(checkIn + 'T12:00:00').getTime()) / 86400000)
          setCtx({
            checkIn, checkOut, guests, nights, cart,
            totalPrice: cart.reduce((s, l) => s + l.totalPrice * l.quantity, 0),
          })
          setPhase('guest')
        }}
        phase={phase}
        onResetPhase={() => setPhase('form')}
      />

      {phase === 'guest' && ctx && (
        <div className="w-results">
          <div className="w-results-inner">
            <GuestPhase
              lang={lang}
              ctx={ctx}
              onBack={() => setPhase('results')}
              onPay={(url) => { setPayUrl(url); setPhase('success'); window.top!.location.href = url }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── SearchForm ──────────────────────────────────────────────────────────────

function SearchForm({ lang, onSearch, onBook, phase, onResetPhase, resetTrigger }: {
  lang:         import('./i18n').Lang
  onSearch:     () => void
  onBook:       (checkIn: string, checkOut: string, guests: number, cart: CartLine[]) => void
  phase:        Phase
  onResetPhase: () => void
  resetTrigger: number
}) {
  const t = makeT(lang, BOOKING_I18N)
  const todayStr    = toDay(new Date())
  const tomorrowStr = (() => { const d = new Date(); d.setDate(d.getDate()+1); return toDay(d) })()

  const [checkIn,  setCheckIn]  = useState(() => {
    return new URLSearchParams(location.search).get('checkIn') ?? todayStr
  })
  const [checkOut, setCheckOut] = useState(() => {
    return new URLSearchParams(location.search).get('checkOut') ?? tomorrowStr
  })
  const [guests,   setGuests]   = useState(() => {
    return Number(new URLSearchParams(location.search).get('guests') ?? '1')
  })

  const nights   = checkIn && checkOut && checkOut > checkIn
    ? Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000)
    : 0
  const offer    = nights > 0 ? offerMsg(t, nights) : null
  const isValid  = !!(checkIn && checkOut && checkOut > checkIn)

  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [results,  setResults]  = useState<RoomResult[] | null>(null)
  const [cart,     setCart]     = useState<CartLine[]>([])

  // Si viene con query params, busca automáticamente al montar
  useEffect(() => {
    const p = new URLSearchParams(location.search)
    if (p.get('checkIn') && p.get('checkOut')) search(p.get('checkIn')!, p.get('checkOut')!, Number(p.get('guests') ?? '1'))
  }, [])

  // El padre ha pedido un reset: limpiar resultados sin desmontar el componente
  useEffect(() => {
    if (resetTrigger === 0) return
    setResults(null)
    setCart([])
    setError('')
  }, [resetTrigger])

  const search = async (ci = checkIn, co = checkOut, g = guests) => {
    if (!ci || !co || co <= ci) { setError(t('booking.dateError')); return }
    setLoading(true); setError(''); setResults(null); setCart([])
    onSearch()  // Abre el modal inmediatamente al pulsar Buscar, sin esperar resultados
    try {
      const res  = await pfetch(`${API}/availability?checkIn=${ci}&checkOut=${co}&guests=${g}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error')
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
    onBook(checkIn ?? '', checkOut ?? '', guests, cart)
  }

  return (
    <>
      <div className="w-form">
        <div className="w-fields">
          <div className="w-field">
            <label className="w-label">📅 {t('booking.arrival')}</label>
            <input type="date" className="w-input" value={checkIn} min={todayStr}
              onChange={e => { setCheckIn(e.target.value); setResults(null); setCart([]); onResetPhase() }}
              onClick={e => { try { (e.target as any).showPicker() } catch {} }} />
          </div>
          <div className="w-field">
            <label className="w-label">📅 {t('booking.departure')}</label>
            <input type="date" className="w-input" value={checkOut} min={checkIn || todayStr}
              disabled={!checkIn}
              onChange={e => { setCheckOut(e.target.value); setResults(null); setCart([]); onResetPhase() }}
              onClick={e => { try { (e.target as any).showPicker() } catch {} }} />
          </div>
          <div className="w-field">
            <label className="w-label">👤 {t('booking.guestsStepperLabel')}</label>
            <div className="w-guests">
              <button className="w-guests-btn" type="button"
                onClick={() => setGuests(g => Math.max(1, g - 1))}>−</button>
              <span className="w-guests-val">{guests}</span>
              <button className="w-guests-btn" type="button"
                onClick={() => setGuests(g => Math.min(10, g + 1))}>+</button>
            </div>
          </div>
          <div className="w-field w-field-submit">
            <label className="w-label" style={{ visibility: 'hidden' }}>-</label>
            <button className="w-btn-search" onClick={() => search()} disabled={loading || !isValid}>
              {loading
                ? <><span className="w-spin w-spin-amber" /> {t('booking.searching')}</>
                : <>🔍 {t('booking.searchButtonWidget')}</>}
            </button>
          </div>
        </div>

        {(nights > 0 || offer) && (
          <div className="w-summary">
            {nights > 0 && <span>🌙 {nights} {plural(lang, nights, t('common.nightOne'), t('common.nightOther'))}</span>}
            {offer && <span className="w-offer-pill">🏷 {offer}</span>}
          </div>
        )}
      </div>

      {/* Resultados de disponibilidad */}
      {(results !== null || error) && phase !== 'guest' && (
        <div className="w-results">
          <div className="w-results-inner">
            {error && <div className="w-alert w-alert-err">{error}</div>}

            {results !== null && results.length === 0 && (
              <div className="w-empty">
                <div style={{ fontSize: 36, marginBottom: 8 }}>😔</div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('booking.noAvailabilityTitle')}</div>
                <div style={{ fontSize: 13 }}>{t('booking.noAvailabilitySub')}</div>
              </div>
            )}

            {results !== null && results.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div className="w-section-title" style={{ marginBottom: 0 }}>
                    🏨 {t('booking.availableRooms')}
                    <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text2)' }}>
                      {checkIn ? fmtDate(checkIn) : ''} → {checkOut ? fmtDate(checkOut) : ''}
                    </span>
                  </div>
                  <button className="w-btn w-btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
                    onClick={() => { setResults(null); setCart([]); onResetPhase() }}>
                    {t('common.back')}
                  </button>
                </div>

                <div className="w-room-list">
                  {results.map(room => (
                    <div key={room.roomTypeId} className="w-room-card" style={{ cursor: 'default' }}>
                      <div className="w-room-hdr">
                        <div>
                          <div className="w-room-name">{room.name}</div>
                          <div className="w-room-avail">
                            {t('booking.roomAvailCount', {
                              n: room.available, s: room.available !== 1 ? 'es' : '',
                              max: room.maxOccupancyBookingEngine ?? room.maxOccupancy,
                            })}
                          </div>
                        </div>
                      </div>

                      <div className="w-rate-list">
                        {room.rates.map(rate => {
                          const lineQty      = cart.find(l => l.roomTypeId === room.roomTypeId && l.rateId === rate.rateId)?.quantity ?? 0
                          const otherTypeQty = typeQtyInCart(room.roomTypeId) - lineQty
                          const maxForLine   = Math.max(0, room.available - otherTypeQty)
                          return (
                            <div key={rate.rateId} className={`w-rate-opt ${lineQty > 0 ? 'selected' : ''}`} style={{ cursor: 'default' }}>
                              <span className="w-rate-name" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                                <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                                  {rate.rateTitle}
                                  {rate.minStay && rate.minStay > 1 && <span className="w-rate-tag">{t('booking.minStayTag', { n: rate.minStay })}</span>}
                                </span>
                                {rate.rateDescription && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text2)' }}>{rate.rateDescription}</span>}
                                <span style={{ fontSize: 11, color: 'var(--text2)' }}>{fmtMoney(rate.pricePerNight)}{t('common.perNight')}</span>
                              </span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span className="w-rate-price">{fmtMoney(rate.totalPrice)}</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                  <button type="button" onClick={() => setLineQty(room, rate, lineQty - 1)} disabled={lineQty === 0}
                                    style={{ width: 22, height: 22, borderRadius: 5, border: '1px solid var(--border2)', background: '#fff', cursor: 'pointer', fontSize: 13 }}>−</button>
                                  <span style={{ minWidth: 14, textAlign: 'center', fontWeight: 700, fontSize: 12 }}>{lineQty}</span>
                                  <button type="button" onClick={() => setLineQty(room, rate, lineQty + 1)} disabled={lineQty >= maxForLine}
                                    style={{ width: 22, height: 22, borderRadius: 5, border: '1px solid var(--border2)', background: '#fff', cursor: 'pointer', fontSize: 13 }}>+</button>
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
                  <div className="w-summary-box" style={{ marginTop: 16 }}>
                    {cart.map(l => (
                      <div key={`${l.roomTypeId}-${l.rateId}`} className="w-summary-row">
                        <span>{l.quantity}× {l.roomName} ({l.rateName})</span>
                        <span>{fmtMoney(l.totalPrice * l.quantity)}</span>
                      </div>
                    ))}
                    <div className="w-summary-row total"><span>{t('common.total')}</span><span>{fmtMoney(cartTotal)}</span></div>
                  </div>
                )}

                {cart.length > 0 && (
                  <button className="w-btn w-btn-primary w-btn-full w-btn-lg" style={{ marginTop: 10 }}
                    onClick={handleContinue}>
                    {t('booking.continue')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

// ─── Stepper ─────────────────────────────────────────────────────────────────

function Stepper({ step, t }: { step: number; t: (k: string) => string }) {
  const steps = [t('booking.stepAvailability'), t('booking.stepGuestData'), t('booking.stepPayment')]
  return (
    <div className="w-stepper">
      {steps.map((s, i) => (
        <React.Fragment key={i}>
          <div className={`w-step ${i+1 === step ? 'active' : i+1 < step ? 'done' : ''}`}>
            <div className="w-step-num">{i+1 < step ? '✓' : i+1}</div>
            <span>{s}</span>
          </div>
          {i < steps.length - 1 && <div className="w-step-sep" />}
        </React.Fragment>
      ))}
    </div>
  )
}

// ─── GuestPhase ──────────────────────────────────────────────────────────────

function GuestPhase({ lang, ctx, onBack, onPay }: {
  lang: import('./i18n').Lang
  ctx: BookingCtx
  onBack: () => void
  onPay: (url: string) => void
}) {
  const t = makeT(lang, BOOKING_I18N)
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

  const setQty = (id: number, q: number) =>
    setQtys(p => ({ ...p, [id]: Math.max(0, Math.min(q, extras.find(e => e.id === id)?.maxQuantity ?? 1)) }))

  const extrasTotal = extras.reduce((s, e) => {
    const q = qtys[e.id] ?? 0
    return s + (q > 0 ? extraUnitPrice(e, ctx.nights, ctx.guests) * q : 0)
  }, 0)
  const grandTotal = ctx.totalPrice + extrasTotal

  // ── Descuento temporal (ver POST /discount-timer) — mismo mecanismo que
  // booking.tsx, ver comentarios ahí.
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
    }, 800)
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
      const res  = await pfetch(`${API}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checkIn: ctx.checkIn, checkOut: ctx.checkOut,
          rooms: ctx.cart.map(l => ({ roomTypeId: l.roomTypeId, rateId: l.rateId, quantity: l.quantity })),
          guests: ctx.guests,
          firstName, lastName, email, phone: phone || undefined, notes: notes || undefined,
          bedPreferenceTwin: ctx.cart.some(l => l.maxOccupancy === 2) ? bedPreferenceTwin : undefined,
          extras: selectedExtras.length ? selectedExtras : undefined,
          discountToken: discountActive ? discountInfo!.token : undefined,
          source: 'widget',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('booking.checkoutError'))
      if (data.reservationId) savePendingBooking({ reservationId: data.reservationId, checkIn: ctx.checkIn })
      onPay(data.url)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <Stepper step={2} t={t} />
        <button className="w-btn w-btn-ghost" style={{ fontSize: 12, padding: '5px 10px', flexShrink: 0 }}
          onClick={onBack}>
          {t('common.back')}
        </button>
      </div>

      <div className="w-summary-box">
        {ctx.cart.map(l => (
          <div key={`${l.roomTypeId}-${l.rateId}`} className="w-summary-row">
            <span>{l.quantity}× {l.roomName} ({l.rateName})</span><span>{fmtMoney(l.totalPrice * l.quantity)}</span>
          </div>
        ))}
        <div className="w-summary-row">
          <span>{fmtDate(ctx.checkIn)} → {fmtDate(ctx.checkOut)}</span>
          <span>{ctx.nights} {plural(lang, ctx.nights, t('common.nightOne'), t('common.nightOther'))}</span>
        </div>
        {extrasTotal > 0 && <div className="w-summary-row"><span>Extras</span><span>+{fmtMoney(extrasTotal)}</span></div>}
        {discountActive ? (
          <>
            <div className="w-summary-row"><span style={{ textDecoration: 'line-through', opacity: 0.6 }}>{t('common.total')}</span><span style={{ textDecoration: 'line-through', opacity: 0.6 }}>{fmtMoney(grandTotal)}</span></div>
            <div className="w-summary-row"><span>{t('booking.discountApplied', { pct: discountInfo!.pct, amount: fmtMoney(discountAmount) })}</span><span /></div>
            <div className="w-summary-row total"><span>{t('common.total')}</span><span>{fmtMoney(finalTotal)}</span></div>
          </>
        ) : (
          <div className="w-summary-row total"><span>{t('common.total')}</span><span>{fmtMoney(grandTotal)}</span></div>
        )}
      </div>

      {discountActive && (
        <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e', fontWeight: 600, padding: '10px 12px', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
          ⚡ {t('booking.discountCountdown', { time: discountRemainingLabel, pct: discountInfo!.pct })}
        </div>
      )}

      {extras.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="w-section-title" style={{ marginBottom: 10 }}>{t('booking.optionalServices')}</div>
          {extras.map(e => {
            const q    = qtys[e.id] ?? 0
            const unit = extraUnitPrice(e, ctx.nights, ctx.guests)
            return (
              <div key={e.id} className="w-extra-row">
                {e.icon && <span style={{ fontSize: 22, width: 28, textAlign: 'center' }}>{e.icon}</span>}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{e.title}</div>
                  {e.description && <div style={{ fontSize: 11, color: 'var(--text2)' }}>{e.description}</div>}
                  <div style={{ fontSize: 11, color: 'var(--blue)', marginTop: 2 }}>
                    {fmtMoney(parseFloat(e.defaultPrice ?? '0'))}
                    {e.pricingType === 'per_night' && t('common.perNight')}
                    {e.pricingType === 'per_person' && t('common.perPerson')}
                    {e.pricingType === 'per_person_night' && t('common.perPersonNight')}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {e.maxQuantity > 1 ? (
                    <>
                      <button onClick={() => setQty(e.id, q-1)} style={{ width: 26, height: 26, borderRadius: 5, border: '1px solid var(--border2)', background: '#fff', cursor: 'pointer', fontSize: 14 }}>−</button>
                      <span style={{ minWidth: 18, textAlign: 'center', fontWeight: 700, fontSize: 13 }}>{q}</span>
                      <button onClick={() => setQty(e.id, q+1)} style={{ width: 26, height: 26, borderRadius: 5, border: '1px solid var(--border2)', background: '#fff', cursor: 'pointer', fontSize: 14 }}>+</button>
                    </>
                  ) : (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={q > 0} onChange={ev => setQty(e.id, ev.target.checked ? 1 : 0)} style={{ width: 17, height: 17 }} />
                      {q > 0 && <span style={{ color: 'var(--blue)', fontWeight: 700, fontSize: 12 }}>{fmtMoney(unit)}</span>}
                    </label>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {error && <div className="w-alert w-alert-err">{error}</div>}

      <div className="w-section-title" style={{ marginBottom: 12 }}>{t('booking.guestDataTitle')}</div>

      <div className="w-form-grid">
        <div className="w-fgroup">
          <label>{t('booking.firstName')}</label>
          <input className="w-finput" type="text" value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Ana" />
        </div>
        <div className="w-fgroup">
          <label>{t('booking.lastName')}</label>
          <input className="w-finput" type="text" value={lastName} onChange={e => setLastName(e.target.value)} placeholder="García López" />
        </div>
        <div className="w-fgroup">
          <label>{t('booking.email')}</label>
          <input className="w-finput" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="ana@email.com" />
        </div>
        <div className="w-fgroup">
          <label>{t('booking.phone')}</label>
          <input className="w-finput" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+34 600 000 000" />
        </div>
        {ctx.cart.some(l => l.maxOccupancy === 2) && (
          <div className="w-fgroup w-form-full">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={bedPreferenceTwin} onChange={e => setBedPreferenceTwin(e.target.checked)} style={{ width: 17, height: 17 }} />
              {t('booking.twinBeds')}
            </label>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>{t('booking.twinBedsHint')}</div>
          </div>
        )}
        <div className="w-fgroup w-form-full">
          <label>{t('booking.notes')}</label>
          <textarea className="w-finput" value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('booking.notesPlaceholder')} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button className="w-btn w-btn-ghost" onClick={onBack}>{t('common.back')}</button>
        <button className="w-btn w-btn-primary" style={{ flex: 1 }} onClick={submit} disabled={loading}>
          {loading ? <><span className="w-spin" /> {t('common.processing')}</> : t('booking.payButton', { total: fmtMoney(discountActive ? finalTotal : grandTotal) })}
        </button>
      </div>
    </>
  )
}

// ─── SuccessPhase ────────────────────────────────────────────────────────────

function SuccessPhase({ lang }: { lang?: import('./i18n').Lang } = {}) {
  const ownLang = useWidgetLang()
  const t = makeT(lang ?? ownLang, BOOKING_I18N)
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
    <div className="w-form">
      <div className="w-success">
        <div className="w-success-icon">✅</div>
        <div className="w-success-title">{t('booking.successTitle')}</div>
        <div className="w-success-sub">
          {t('booking.successEmailSent')}
          {data && <><br />{t('booking.successInfo', { id: data.id, checkIn: fmtDate(data.checkInDate), checkOut: fmtDate(data.checkOutDate) })}</>}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/portal" className="w-btn w-btn-primary">{t('booking.viewMyBookings')}</a>
          <a href={branding.websiteUrl || '/'} target="_top" className="w-btn w-btn-ghost">{t('booking.backToSite')}</a>
        </div>
      </div>
    </div>
  )
}

// ─── ResumePendingPhase — vuelta de un pago cancelado en Stripe ───────────────
// En vez de mandar al cliente a empezar la búsqueda de cero, se ofrece
// retomar directamente esa misma reserva tentativa (ver POST /checkout/resume)
// — nunca se ha perdido, sigue en la BD sin pagar.
function ResumePendingPhase({ lang, reservationId, onStartOver }: {
  lang?: import('./i18n').Lang; reservationId: number; onStartOver: () => void
}) {
  const ownLang = useWidgetLang()
  const t = makeT(lang ?? ownLang, BOOKING_I18N)
  const [pending, setPending]   = useState<any>(null)
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [nowTick, setNowTick]   = useState(() => Date.now())

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
        body: JSON.stringify({ reservationId, source: 'widget', discountToken: canOfferDiscount ? storedDiscount.token : undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('booking.checkoutError'))
      window.top!.location.href = data.url
    } catch (e: any) { setError(e.message); setLoading(false) }
  }

  if (notFound) return (
    <div className="w-form">
      <p>{t('booking.pendingNotFound')}</p>
      <button className="w-btn w-btn-primary" onClick={onStartOver}>{t('booking.startOver')}</button>
    </div>
  )
  if (!pending) return <div className="w-form">…</div>

  const discountRemainingMs = canOfferDiscount ? Math.max(0, storedDiscount.expiresAt - nowTick) : 0
  const discountRemainingLabel = `${Math.floor(discountRemainingMs / 60000)}:${String(Math.floor((discountRemainingMs % 60000) / 1000)).padStart(2, '0')}`

  return (
    <div className="w-form">
      <div className="w-section-title" style={{ marginBottom: 10 }}>{t('booking.pendingTitle')}</div>
      {error && <div className="alert alert-error">{error}</div>}
      {canOfferDiscount && (
        <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e', fontWeight: 600, padding: '10px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          ⚡ {t('booking.discountCountdown', { time: discountRemainingLabel, pct: storedDiscount.pct })}
        </div>
      )}
      <div className="w-summary-box">
        {pending.rateName && <div className="w-summary-row"><span>{pending.rateName}</span><span /></div>}
        <div className="w-summary-row">
          <span>{fmtDate(pending.checkIn)} → {fmtDate(pending.checkOut)}</span>
          <span>{pending.nights} {plural(lang ?? ownLang, pending.nights, t('common.nightOne'), t('common.nightOther'))}</span>
        </div>
        {alreadyDiscounted && (
          <div className="w-summary-row"><span>{t('booking.discountApplied', { pct: pending.discountPct, amount: fmtMoney(parseFloat(pending.discountAmount)) })}</span><span /></div>
        )}
        <div className="w-summary-row total"><span>{t('common.total')}</span><span>{fmtMoney(parseFloat(pending.total))}</span></div>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <button className="w-btn w-btn-ghost" onClick={onStartOver}>{t('booking.startOver')}</button>
        <button className="w-btn w-btn-primary" style={{ flex: 1 }} onClick={resume} disabled={loading}>
          {loading ? <><span className="w-spin" /> {t('common.processing')}</> : t('booking.completePayment')}
        </button>
      </div>
    </div>
  )
}

// ─── Mount ───────────────────────────────────────────────────────────────────

const isSuccess = location.pathname.includes('/success') || location.search.includes('session_id')

const style = document.createElement('style')
style.textContent = css
document.head.appendChild(style)

boot(() => createRoot(document.getElementById('root')!).render(
  isSuccess ? <SuccessPhase /> : <BookingWidget />
))
