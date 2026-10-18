import React, { useState, useEffect, useCallback, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useWidgetLang, makeT, plural, type Lang } from './i18n'
import { PORTAL_I18N } from './i18n-portal'
import { pfetch, branding, boot, postParent } from './branding'

const API  = '/api/public'
const CAPI = '/api/customer'
const TKEY = 'bm_customer_token'
const EKEY = 'bm_customer_email'

const BOOKING_ALIAS = /@guest\.booking\.com$/i
function isBookingAlias(email: string) { return BOOKING_ALIAS.test((email ?? '').trim()) }

function fmtMoney(n: number | string) { return parseFloat(String(n)).toFixed(2).replace('.', ',') + ' €' }
function fmtDate(d: string)      { return new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) }

// Reservas con varias habitaciones (extraRoomCodes, ver GET /api/customer/
// reservations[/:id]) — antes solo se veía la habitación principal, nunca
// cuántas más tenía la reserva.
function roomsLabel(d: { room?: { code: string } | null; extraRoomCodes?: string[] }, t: (k: string, vars?: Record<string, string | number>) => string): string {
  if (!d.room) return ''
  const extra = d.extraRoomCodes ?? []
  if (extra.length === 0) return d.room.code
  return t('reservation.roomsTotal', { n: 1 + extra.length, codes: [d.room.code, ...extra].join(', ') })
}
function fmtDateShort(d: string) { return new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) }

function getToken()  { try { return localStorage.getItem(TKEY) } catch { return null } }
function getEmail()  { try { return localStorage.getItem(EKEY) } catch { return null } }
function saveToken(t: string, e: string) { localStorage.setItem(TKEY, t); localStorage.setItem(EKEY, e) }
function clearToken() { localStorage.removeItem(TKEY); localStorage.removeItem(EKEY) }

async function apiFetch(path: string, opts: RequestInit = {}) {
  const token = getToken()
  const res = await pfetch(CAPI + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  })
  const data = await res.json()
  if (res.status === 401) { clearToken(); window.location.reload() }
  if (!res.ok) throw new Error(data.error ?? 'Error')
  return data
}

function postHeight() {
  const h = document.documentElement.scrollHeight
  postParent('portal-height', { height: h })
}

function postClose() {
  postParent('portal-close')
}

// ─── Estilos ──────────────────────────────────────────────────────────────────

const css = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --amber:   #ffc107;
    --amber-dk:#e0a800;
    --blue:    #2563eb;
    --blue-dk: #1d4ed8;
    --green:   #16a34a;
    --red:     #dc2626;
    --border:  #e5e7eb;
    --bg:      #f9fafb;
    --text:    #111827;
    --text2:   #6b7280;
    --radius:  10px;
  }
  html, body { font-family: 'Inter', -apple-system, sans-serif; background: transparent; color: var(--text); font-size: 15px; }

  /* ── Wrapper principal ── */
  .pw-wrap { background: #fff; border-radius: 14px; overflow: hidden; }

  /* ── Header del widget ── */
  .pw-header {
    background: rgba(255,255,255,0.97);
    border-bottom: 1px solid var(--border);
    padding: 14px 20px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .pw-header-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .pw-header-email { font-size: 12px; color: var(--text2); }
  .pw-close-btn {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    padding: 4px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
    color: var(--text2); display: flex; align-items: center; gap: 4px;
    transition: background .15s;
  }
  .pw-close-btn:hover { background: var(--bg); }

  /* ── Contenido ── */
  .pw-body { padding: 20px; }

  /* ── Login (estilo amber del hotel) ── */
  .pw-login {
    background: rgba(255,255,255,0.97);
    border-radius: 14px;
    padding: 28px 24px;
  }
  .pw-login-icon { font-size: 40px; text-align: center; margin-bottom: 12px; }
  .pw-login-title { font-size: 17px; font-weight: 700; text-align: center; margin-bottom: 4px; }
  .pw-login-sub { font-size: 13px; color: var(--text2); text-align: center; margin-bottom: 20px; }

  .pw-fgroup { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
  .pw-fgroup label { font-size: 0.72rem; font-weight: 700; color: #b08800; text-transform: uppercase; letter-spacing: .6px; }
  .pw-input {
    background: #f8f9fa; color: var(--text);
    border: 1px solid #dee2e6; border-radius: 8px;
    padding: 10px 12px; font-size: 0.92rem; font-family: inherit;
    width: 100%; outline: none; transition: border-color .2s, box-shadow .2s;
  }
  .pw-input:focus { border-color: var(--amber); box-shadow: 0 0 0 3px rgba(255,193,7,.2); }

  .pw-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 11px 18px; border: none; border-radius: 8px;
    font-size: 14px; font-weight: 700; font-family: inherit;
    cursor: pointer; transition: background .15s; text-decoration: none; width: 100%;
  }
  .pw-btn:disabled { opacity: .5; cursor: not-allowed; }
  .pw-btn-amber { background: var(--amber); color: #212529; }
  .pw-btn-amber:hover:not(:disabled) { background: var(--amber-dk); }
  .pw-btn-ghost { background: transparent; color: var(--text2); border: 1px solid var(--border); margin-top: 10px; }
  .pw-btn-ghost:hover:not(:disabled) { background: var(--bg); }
  .pw-btn-blue  { background: var(--blue); color: #fff; }
  .pw-btn-blue:hover:not(:disabled) { background: var(--blue-dk); }

  /* ── Sent confirmation ── */
  .pw-sent { text-align: center; padding: 16px 0; }
  .pw-sent-icon { font-size: 44px; margin-bottom: 10px; }
  .pw-sent-title { font-weight: 700; margin-bottom: 6px; }
  .pw-sent-sub { font-size: 13px; color: var(--text2); line-height: 1.5; }

  /* ── Alert ── */
  .pw-alert { padding: 9px 12px; border-radius: 7px; font-size: 12px; margin-bottom: 12px; }
  .pw-alert-err { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
  .pw-alert-ok  { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }

  /* ── Reservas ── */
  .pw-section { font-size: 13px; font-weight: 700; color: var(--text2); margin-bottom: 10px; text-transform: uppercase; letter-spacing: .5px; }
  .pw-res-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
  .pw-res-card {
    border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; cursor: pointer; background: #fff;
    display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;
    transition: border-color .12s, box-shadow .12s;
  }
  .pw-res-card:hover { border-color: var(--blue); box-shadow: 0 0 0 2px rgba(37,99,235,.08); }
  .pw-res-id    { font-size: 11px; color: var(--text2); margin-bottom: 3px; }
  .pw-res-dates { font-size: 14px; font-weight: 700; margin-bottom: 3px; }
  .pw-res-info  { font-size: 12px; color: var(--text2); }
  .pw-res-total { font-size: 16px; font-weight: 700; text-align: right; }
  .pw-res-arrow { font-size: 12px; color: var(--blue); margin-top: 6px; text-align: right; }

  /* ── Status chips ── */
  .pw-chip { display: inline-block; padding: 2px 9px; border-radius: 99px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; }
  .pw-chip-tentative    { background: #fef9c3; color: #ca8a04; }
  .pw-chip-confirmed    { background: #dcfce7; color: #16a34a; }
  .pw-chip-checked_in   { background: #dbeafe; color: #2563eb; }
  .pw-chip-checking_out { background: #dbeafe; color: #2563eb; }
  .pw-chip-checked_out  { background: #f3f4f6; color: #6b7280; }
  .pw-chip-cancelled    { background: #fee2e2; color: #dc2626; }
  .pw-chip-no_show      { background: #fee2e2; color: #dc2626; }

  /* ── Drawer de detalle ── */
  .pw-drawer-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 50; }
  .pw-drawer {
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 51;
    display: flex; justify-content: center;
  }
  .pw-drawer-inner {
    background: #fff; border-radius: 16px 16px 0 0;
    width: 100%; max-width: 560px;
    max-height: 88dvh; overflow-y: auto;
    padding: 20px 20px max(20px, env(safe-area-inset-bottom));
  }
  .pw-drawer-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
  .pw-drawer-title { font-size: 16px; font-weight: 700; }
  .pw-drawer-close { background: none; border: none; font-size: 20px; cursor: pointer; color: var(--text2); }
  .pw-summary-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
  .pw-summary-row.total { font-weight: 700; font-size: 15px; border-top: 1px solid var(--border); margin-top: 6px; padding-top: 8px; }
  .pw-card { background: #fff; border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 12px; }
  .pw-card-title { font-size: 13px; font-weight: 700; margin-bottom: 10px; }

  /* ── Spin ── */
  .pw-spin { display: inline-block; width: 18px; height: 18px; border: 2px solid rgba(0,0,0,.12); border-top-color: currentColor; border-radius: 50%; animation: pwspin .6s linear infinite; }
  @keyframes pwspin { to { transform: rotate(360deg) } }
  .pw-loading { text-align: center; padding: 32px; color: var(--text2); }

  /* ── Empty ── */
  .pw-empty { text-align: center; padding: 32px 16px; color: var(--text2); }

  /* ── Nueva reserva ── */
  .pw-new-res { margin-bottom: 16px; }
`

// ─── Status ──────────────────────────────────────────────────────────────────

function Chip({ status, t }: { status: string; t: (k: string) => string }) {
  return <span className={`pw-chip pw-chip-${status}`}>{t(`status.${status}`)}</span>
}

// ─── Login ────────────────────────────────────────────────────────────────────

function LoginWidget({ lang, onLogin }: { lang: Lang; onLogin: (t: string, e: string) => void }) {
  const t = makeT(lang, PORTAL_I18N)
  const [email,   setEmail]   = useState('')
  const [sent,    setSent]    = useState(false)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const magicToken = new URLSearchParams(location.search).get('token')

  // El canje requiere un clic explícito: algunos clientes de correo (Outlook
  // Safe Links, proxies corporativos) pre-visitan los enlaces del email para
  // escanearlos, lo que consumiría el token de un solo uso antes de que el
  // huésped real lo abra si lo canjeáramos solo con cargar la página.
  const verifyToken = async () => {
    if (!magicToken) return
    setLoading(true); setError('')
    try {
      const r = await pfetch(`${API}/auth/verify?token=${magicToken}`)
      const d = await r.json()
      if (d.token) {
        onLogin(d.token, d.email)
        window.history.replaceState({}, '', '/portal-widget')
      } else {
        window.history.replaceState({}, '', '/portal-widget')
        setError(d.error ?? t('login.linkInvalid'))
      }
    } catch {
      setError(t('login.verifyError'))
    } finally { setLoading(false) }
  }

  const send = async () => {
    if (!email) return
    setLoading(true); setError('')
    try {
      const res = await pfetch(`${API}/auth/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, redirectUrl: `${location.origin}/portal-widget` }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('common.genericError'))
      setSent(true)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <div className="pw-login">
      <div className="pw-login-icon">🏨</div>
      <div className="pw-login-title">{t('login.title')}</div>
      <div className="pw-login-sub">{t('login.subWidget')}</div>

      {error && <div className="pw-alert pw-alert-err">{error}</div>}

      {magicToken && !error ? (
        <>
          <p style={{ fontSize: 12, color: 'var(--text2)', textAlign: 'center', marginBottom: 12 }}>
            {t('login.clickToAccess')}
          </p>
          <button className="pw-btn pw-btn-amber" onClick={verifyToken} disabled={loading}>
            {loading ? <><span className="pw-spin" /> {t('login.accessing')}</> : t('login.accessButton')}
          </button>
        </>
      ) : sent ? (
        <div className="pw-sent">
          <div className="pw-sent-icon">📧</div>
          <div className="pw-sent-title">{t('login.checkEmail')}</div>
          <div className="pw-sent-sub">
            {t('login.sentTo', { email })}<br />
            {t('login.validFor48h')}
          </div>
          <button className="pw-btn pw-btn-ghost" onClick={() => setSent(false)}>{t('login.useOtherEmail')}</button>
        </div>
      ) : (
        <>
          <div className="pw-fgroup">
            <label>{t('login.emailLabel')}</label>
            <input className="pw-input" type="email" value={email} placeholder="tu@email.com"
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && send()}
              autoFocus />
          </div>
          <button className="pw-btn pw-btn-amber" onClick={send} disabled={loading || !email}>
            {loading ? <><span className="pw-spin" /> {t('login.sending')}</> : t('login.sendLinkButton')}
          </button>
          <p style={{ fontSize: 11, color: 'var(--text2)', textAlign: 'center', marginTop: 10 }}>
            {t('login.noPasswordNote')}
          </p>
        </>
      )}
    </div>
  )
}

// ─── Drawer de detalle de reserva ────────────────────────────────────────────

// ─── Extras (servicios opcionales, post-reserva) ──────────────────────────────

type ExtraItem = { id: number; title: string; description: string | null; icon: string | null; pricingType: string; maxQuantity: number; defaultPrice: string | null }

// Noches entre hoy (hora de Madrid) y el checkout, sin contar las que ya han
// pasado — si todavía no ha hecho check-in, es sencillamente el total de la
// estancia (no tiene sentido restar noches futuras a una compra anticipada).
function remainingNightsFrom(checkInDate: string, checkOutDate: string): number {
  const todayMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: branding.timezone || undefined }).format(new Date())
  const start = todayMadrid > checkInDate ? todayMadrid : checkInDate
  return Math.max(0, Math.round((new Date(checkOutDate + 'T12:00:00').getTime() - new Date(start + 'T12:00:00').getTime()) / 86400000))
}

// unit = precio de UNA unidad (una noche, una persona, o ambos — según
// pricingType), NUNCA el total ya multiplicado — eso se calcula aparte para
// no confundir "8€/noche" con "56€/noche" (ver ExtrasSection).
function extraUnitPrice(item: ExtraItem): number {
  return parseFloat(item.defaultPrice ?? '0')
}

function extraMultiplier(item: ExtraItem, nights: number, people: number): number {
  switch (item.pricingType) {
    case 'per_night':        return nights
    case 'per_person':       return people
    case 'per_person_night': return people * nights
    default:                 return 1
  }
}

function ExtrasSection({ t, reservationId, nights, people }: { t: (k: string, vars?: Record<string, string | number>) => string; reservationId: number; nights: number; people: number }) {
  const [extras, setExtras] = useState<ExtraItem[]>([])
  const [qtys,   setQtys]   = useState<Record<number, number>>({})
  const [paying, setPaying] = useState(false)
  const [error,  setError]  = useState('')

  useEffect(() => {
    pfetch(`${API}/extras`).then(r => r.json()).then(d => setExtras(d.data ?? [])).catch(() => {})
  }, [])

  if (extras.length === 0) return null

  const setQty = (itemId: number, q: number) =>
    setQtys(p => ({ ...p, [itemId]: Math.max(0, Math.min(q, extras.find(e => e.id === itemId)?.maxQuantity ?? 1)) }))

  const total = extras.reduce((s, e) => {
    const q = qtys[e.id] ?? 0
    return s + (q > 0 ? extraUnitPrice(e) * extraMultiplier(e, nights, people) * q : 0)
  }, 0)

  const pay = async () => {
    const selected = Object.entries(qtys).filter(([, q]) => q > 0).map(([itemId, quantity]) => ({ saleItemId: parseInt(itemId), quantity }))
    if (selected.length === 0) return
    setPaying(true); setError('')
    try {
      const d = await apiFetch(`/reservations/${reservationId}/extras`, {
        method: 'POST', body: JSON.stringify({ extras: selected }),
      })
      window.top!.location.href = d.url
    } catch (e: any) { setError(e.message ?? t('extras.payError')); setPaying(false) }
  }

  return (
    <div className="pw-card">
      <div className="pw-card-title">{t('extras.title')}</div>
      {error && <div className="pw-alert pw-alert-err" style={{ marginBottom: 10 }}>{error}</div>}
      {extras.map(e => {
        const q          = qtys[e.id] ?? 0
        const unit       = extraUnitPrice(e)
        const multiplier = extraMultiplier(e, nights, people)
        const lineTotal  = unit * multiplier
        return (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
            {e.icon && <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>{e.icon}</span>}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{e.title}</div>
              {e.description && <div style={{ fontSize: 11, color: 'var(--text2)' }}>{e.description}</div>}
              <div style={{ fontSize: 11, color: 'var(--blue)', marginTop: 2 }}>
                {fmtMoney(unit)}
                {e.pricingType === 'per_night' && t('common.perNight')}
                {e.pricingType === 'per_person' && t('common.perPerson')}
                {e.pricingType === 'per_person_night' && t('common.perPersonNight')}
              </div>
              {e.pricingType === 'per_night' && multiplier > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                  {t('extras.nightsBreakdown', { count: multiplier, total: fmtMoney(lineTotal) })}
                </div>
              )}
              {e.pricingType === 'per_person_night' && multiplier > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                  {t('extras.personNightsBreakdown', { people, count: nights, total: fmtMoney(lineTotal) })}
                </div>
              )}
            </div>
            {e.maxQuantity > 1 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setQty(e.id, q - 1)} style={{ width: 24, height: 24, borderRadius: 5, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer' }}>−</button>
                <span style={{ minWidth: 16, textAlign: 'center', fontWeight: 700, fontSize: 12.5 }}>{q}</span>
                <button onClick={() => setQty(e.id, q + 1)} style={{ width: 24, height: 24, borderRadius: 5, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer' }}>+</button>
              </div>
            ) : (
              <input type="checkbox" checked={q > 0} onChange={ev => setQty(e.id, ev.target.checked ? 1 : 0)} style={{ width: 17, height: 17 }} />
            )}
          </div>
        )
      })}
      {total > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="pw-summary-row total" style={{ marginBottom: 10 }}>
            <span>{t('extras.totalLabel')}</span><span>{fmtMoney(total)}</span>
          </div>
          <button className="pw-btn pw-btn-blue" onClick={pay} disabled={paying} style={{ width: 'auto', padding: '8px 16px', fontSize: 13 }}>
            {paying ? t('common.redirecting') : t('extras.payButton', { total: fmtMoney(total) })}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Ampliar estancia (añadir noches al final, solo si ya está todo pagado) ───

const MAX_EXTEND_NIGHTS = 14

function ExtendStaySection({ t, reservationId, fullyPaid }: { t: (k: string, vars?: Record<string, string | number>) => string; reservationId: number; fullyPaid: boolean }) {
  const [nights,      setNights]      = useState(1)
  const [quote,       setQuote]       = useState<{ newCheckOutDate: string; total: number } | null>(null)
  const [quoting,     setQuoting]     = useState(false)
  const [quoteError,  setQuoteError]  = useState('')
  const [paying,      setPaying]      = useState(false)
  const [payError,    setPayError]    = useState('')

  useEffect(() => {
    if (!fullyPaid) return
    let cancelled = false
    setQuoting(true); setQuoteError(''); setQuote(null)
    apiFetch(`/reservations/${reservationId}/extend-quote?nights=${nights}`)
      .then(d => { if (!cancelled) setQuote(d) })
      .catch((e: any) => { if (!cancelled) setQuoteError(e.message ?? t('extendStay.quoteError')) })
      .finally(() => { if (!cancelled) setQuoting(false) })
    return () => { cancelled = true }
  }, [nights, reservationId, fullyPaid])

  const pay = async () => {
    setPaying(true); setPayError('')
    try {
      const d = await apiFetch(`/reservations/${reservationId}/extend`, { method: 'POST', body: JSON.stringify({ nights }) })
      window.top!.location.href = d.url
    } catch (e: any) { setPayError(e.message ?? t('extendStay.payError')); setPaying(false) }
  }

  return (
    <div className="pw-card">
      <div className="pw-card-title">{t('extendStay.title')}</div>
      {!fullyPaid ? (
        <p style={{ fontSize: 12.5, color: 'var(--text2)' }}>{t('extendStay.needsPaymentFirst')}</p>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--text2)', marginBottom: 10 }}>{t('extendStay.intro')}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 12.5 }}>{t('extendStay.nightsLabel')}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => setNights(n => Math.max(1, n - 1))} style={{ width: 24, height: 24, borderRadius: 5, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer' }}>−</button>
              <span style={{ minWidth: 16, textAlign: 'center', fontWeight: 700, fontSize: 12.5 }}>{nights}</span>
              <button onClick={() => setNights(n => Math.min(MAX_EXTEND_NIGHTS, n + 1))} style={{ width: 24, height: 24, borderRadius: 5, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer' }}>+</button>
            </div>
          </div>
          {quoting && <p style={{ fontSize: 12.5, color: 'var(--text2)' }}>{t('extendStay.quoting')}</p>}
          {quoteError && <div className="pw-alert pw-alert-err" style={{ marginBottom: 10 }}>{quoteError}</div>}
          {payError && <div className="pw-alert pw-alert-err" style={{ marginBottom: 10 }}>{payError}</div>}
          {quote && !quoting && (
            <div style={{ marginTop: 4 }}>
              <div className="pw-summary-row"><span style={{ color: 'var(--text2)' }}>{t('extendStay.newCheckout')}</span><strong>{fmtDate(quote.newCheckOutDate)}</strong></div>
              <div className="pw-summary-row total" style={{ marginBottom: 10 }}>
                <span>{t('extendStay.totalLabel')}</span><span>{fmtMoney(quote.total)}</span>
              </div>
              <button className="pw-btn pw-btn-blue" onClick={pay} disabled={paying} style={{ width: 'auto', padding: '8px 16px', fontSize: 13 }}>
                {paying ? t('common.redirecting') : t('extendStay.payButton', { total: fmtMoney(quote.total) })}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ResDrawer({ t, id, onClose }: { t: (k: string, vars?: Record<string, string | number>) => string; id: number; onClose: () => void }) {
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [showCI,  setShowCI]  = useState(false)
  const [paying,  setPaying]  = useState(false)

  useEffect(() => {
    apiFetch(`/reservations/${id}`)
      .then(d => { setData(d.data); setLoading(false) })
      .catch((e: any) => { setError(e.message); setLoading(false) })
  }, [id])

  const pay = async () => {
    setPaying(true)
    try {
      const d = await apiFetch(`/reservations/${id}/pay`, { method: 'POST' })
      window.top!.location.href = d.url
    } catch (e: any) { alert(e.message ?? t('extras.payError')); setPaying(false) }
  }

  const nights  = data ? Math.round((new Date(data.checkOutDate + 'T12:00:00').getTime() - new Date(data.checkInDate + 'T12:00:00').getTime()) / 86400000) : 0
  const remainingNights = data ? remainingNightsFrom(data.checkInDate, data.checkOutDate) : 0
  const pending = data ? parseFloat(data.total) - parseFloat(data.amountPaid ?? '0') : 0
  const canPay  = data && pending > 0.01 && !['cancelled', 'no_show'].includes(data.status)
  const canCI   = data && ['confirmed', 'tentative'].includes(data.status) && !data.onlineCheckIn
  const canAddExtras = data && !['cancelled', 'no_show', 'checked_out'].includes(data.status)
  const hasExtraRooms = ((data?.extraRoomIds ?? []) as number[]).length > 0
  const canExtendStay = data && !['cancelled', 'no_show', 'checked_out'].includes(data.status) && !hasExtraRooms

  return (
    <>
      <div className="pw-drawer-backdrop" onClick={onClose} />
      <div className="pw-drawer">
        <div className="pw-drawer-inner">
          <div className="pw-drawer-hdr">
            <div className="pw-drawer-title">{t('reservation.detailTitle')}</div>
            <button className="pw-drawer-close" onClick={onClose}>✕</button>
          </div>

          {loading && <div className="pw-loading"><span className="pw-spin" /></div>}
          {error   && <div className="pw-alert pw-alert-err">{error}</div>}

          {data && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>{t('reservation.idLabel', { id: data.id })}</div>
                  <Chip status={data.status} t={t} />
                </div>
                {data.onlineCheckIn && (
                  <span style={{ fontSize: 11, background: '#dcfce7', color: '#16a34a', padding: '3px 9px', borderRadius: 99, fontWeight: 700 }}>
                    {t('reservation.onlineCheckinBadge')}
                  </span>
                )}
              </div>

              <div className="pw-card" style={{ marginBottom: 12 }}>
                <div className="pw-summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.arrival')}</span><strong>{fmtDate(data.checkInDate)}</strong></div>
                <div className="pw-summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.departure')}</span><strong>{fmtDate(data.checkOutDate)}</strong></div>
                <div className="pw-summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.nights')}</span><strong>{nights}</strong></div>
                {data.room && <div className="pw-summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.room')}</span><strong>{roomsLabel(data, t)}</strong></div>}
                {data.rate && <div className="pw-summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.rate')}</span><strong>{data.rate.title}</strong></div>}
                <div className="pw-summary-row total"><span>{t('common.total')}</span><span>{fmtMoney(data.total)}</span></div>
                {parseFloat(data.amountPaid) > 0 && (
                  <div className="pw-summary-row" style={{ color: 'var(--green)' }}>
                    <span>{t('reservation.paid')}</span><span>{fmtMoney(data.amountPaid)}</span>
                  </div>
                )}
                {pending > 0.01 && (
                  <div className="pw-summary-row" style={{ color: 'var(--red)', fontWeight: 700 }}>
                    <span>{t('reservation.pending')}</span><span>{fmtMoney(pending.toFixed(2))}</span>
                  </div>
                )}
              </div>

              {canPay && (
                <div className="pw-card" style={{ borderColor: 'var(--blue)', marginBottom: 12 }}>
                  <div className="pw-card-title">{t('reservation.pendingPaymentTitle')}</div>
                  <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>
                    {t('reservation.pendingPaymentInfoWidget', { amount: fmtMoney(pending.toFixed(2)) })}
                  </p>
                  <button className="pw-btn pw-btn-blue" onClick={pay} disabled={paying} style={{ width: 'auto', padding: '8px 16px', fontSize: 13 }}>
                    {paying ? t('common.redirecting') : t('reservation.payButton', { amount: fmtMoney(pending.toFixed(2)) })}
                  </button>
                </div>
              )}

              {canCI && (
                <div className="pw-card" style={{ borderColor: 'var(--blue)' }}>
                  <div className="pw-card-title">{t('checkin.sectionTitle')}</div>
                  {!showCI ? (
                    <button className="pw-btn pw-btn-blue" style={{ width: 'auto', padding: '8px 16px', fontSize: 13 }}
                      onClick={() => setShowCI(true)}>
                      {t('checkin.doCheckin')}
                    </button>
                  ) : (
                    <CheckInForm t={t} reservationId={id} onDone={() => {
                      setShowCI(false)
                      setData((d: any) => ({ ...d, onlineCheckIn: true }))
                    }} />
                  )}
                </div>
              )}

              {canExtendStay && (
                <div style={{ marginTop: 12 }}>
                  <ExtendStaySection t={t} reservationId={id} fullyPaid={pending <= 0.01} />
                </div>
              )}

              {canAddExtras && (
                <div style={{ marginTop: 12 }}>
                  <ExtrasSection t={t} reservationId={id} nights={remainingNights} people={data.people} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Check-in form ────────────────────────────────────────────────────────────

const COUNTRIES = [
  ['ES','España'],['GB','Reino Unido'],['DE','Alemania'],['FR','Francia'],['IT','Italia'],
  ['PT','Portugal'],['NL','Países Bajos'],['US','EE.UU.'],['MA','Marruecos'],['AR','Argentina'],
  ['MX','México'],['BR','Brasil'],['CN','China'],['JP','Japón'],['AU','Australia'],
]

function CheckInForm({ t, reservationId, onDone }: { t: (k: string) => string; reservationId: number; onDone: () => void }) {
  const [docType,     setDocType]     = useState('dni')
  const [docNum,      setDocNum]      = useState('')
  const [nationality, setNationality] = useState('ES')
  const [birthDate,   setBirthDate]   = useState('')
  const [arrival,     setArrival]     = useState('')
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')

  const submit = async () => {
    if (!docNum || !birthDate) { setError(t('checkin.docAndBirthRequired')); return }
    setLoading(true); setError('')
    try {
      await apiFetch(`/reservations/${reservationId}/checkin`, {
        method: 'POST',
        body: JSON.stringify({ documentType: docType, documentNumber: docNum, nationality, birthDate, arrivalTime: arrival || undefined }),
      })
      onDone()
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <div style={{ marginTop: 10 }}>
      {error && <div className="pw-alert pw-alert-err">{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div className="pw-fgroup">
          <label>{t('checkin.docTypeLabel')}</label>
          <select className="pw-input" value={docType} onChange={e => setDocType(e.target.value)}>
            <option value="dni">DNI</option>
            <option value="nie">NIE</option>
            <option value="passport">Pasaporte</option>
            <option value="driving_licence">Carné conducir</option>
          </select>
        </div>
        <div className="pw-fgroup">
          <label>{t('checkin.docNumberLabel')}</label>
          <input className="pw-input" type="text" value={docNum} onChange={e => setDocNum(e.target.value.toUpperCase())} placeholder="12345678A" />
        </div>
        <div className="pw-fgroup">
          <label>{t('checkin.nationalityLabel')}</label>
          <select className="pw-input" value={nationality} onChange={e => setNationality(e.target.value)}>
            {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </div>
        <div className="pw-fgroup">
          <label>{t('checkin.birthDateLabel')}</label>
          <input className="pw-input" type="date" value={birthDate} onChange={e => setBirthDate(e.target.value)} max={new Date().toISOString().slice(0,10)} />
        </div>
        <div className="pw-fgroup">
          <label>{t('checkin.arrivalTimeLabel')}</label>
          <input className="pw-input" type="time" value={arrival} onChange={e => setArrival(e.target.value)} />
        </div>
      </div>
      <button className="pw-btn pw-btn-blue" style={{ width: 'auto', padding: '8px 16px', fontSize: 13 }}
        onClick={submit} disabled={loading}>
        {loading ? <><span className="pw-spin" /> {t('login.sending')}</> : t('checkin.confirmButtonShort')}
      </button>
    </div>
  )
}

// ─── Lista de reservas ────────────────────────────────────────────────────────

function ReservationsList({ lang, t, onNewBooking }: { lang: Lang; t: (k: string, vars?: Record<string, string | number>) => string; onNewBooking: () => void }) {
  const [list,    setList]    = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [openId,  setOpenId]  = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { const d = await apiFetch('/reservations'); setList(d.data) }
    catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [])

  if (loading) return <div className="pw-loading"><span className="pw-spin" /></div>
  if (error)   return <div className="pw-alert pw-alert-err">{error}</div>

  const today    = new Date().toISOString().slice(0, 10)
  const upcoming = list.filter(r => r.checkOutDate >= today && r.status !== 'cancelled')
  const past     = list.filter(r => r.checkOutDate  < today || r.status === 'cancelled')

  return (
    <>
      <div className="pw-new-res">
        <button className="pw-btn pw-btn-amber" onClick={onNewBooking} style={{ padding: '10px 18px', fontSize: 13 }}>
          {t('list.newBooking')}
        </button>
      </div>

      {list.length === 0 && (
        <div className="pw-empty">
          <div style={{ fontSize: 36, marginBottom: 10 }}>🏖️</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('list.noBookingsWidget')}</div>
          <div style={{ fontSize: 13 }}>{t('list.noBookingsWidgetSub')}</div>
        </div>
      )}

      {upcoming.length > 0 && (
        <>
          <div className="pw-section">{t('list.upcoming')}</div>
          <div className="pw-res-list">
            {upcoming.map(r => <ResCard key={r.id} lang={lang} t={t} r={r} onClick={() => setOpenId(r.id)} />)}
          </div>
        </>
      )}

      {past.length > 0 && (
        <>
          <div className="pw-section">{t('list.past')}</div>
          <div className="pw-res-list">
            {past.map(r => <ResCard key={r.id} lang={lang} t={t} r={r} onClick={() => setOpenId(r.id)} />)}
          </div>
        </>
      )}

      {openId && <ResDrawer t={t} id={openId} onClose={() => { setOpenId(null); load() }} />}
    </>
  )
}

function ResCard({ lang, t, r, onClick }: { lang: Lang; t: (k: string, vars?: Record<string, string | number>) => string; r: any; onClick: () => void }) {
  const nights = Math.round((new Date(r.checkOutDate + 'T12:00:00').getTime() - new Date(r.checkInDate + 'T12:00:00').getTime()) / 86400000)
  return (
    <div className="pw-res-card" onClick={onClick}>
      <div style={{ flex: 1 }}>
        <div className="pw-res-id">{t('reservation.idLabel', { id: r.id })}</div>
        <div className="pw-res-dates">{fmtDateShort(r.checkInDate)} → {fmtDateShort(r.checkOutDate)}</div>
        <div className="pw-res-info">
          {nights} {plural(lang, nights, t('common.nightOne'), t('common.nightOther'))}
          {r.room ? ` · ${r.extraRoomCodes?.length ? roomsLabel(r, t) : `Hab. ${r.room.code}`}` : ''}
          {r.rate ? ` · ${r.rate.title}` : ''}
        </div>
        {r.onlineCheckIn && (
          <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 700, marginTop: 4, display: 'inline-block' }}>
            {t('reservation.onlineCheckinBadge')}
          </span>
        )}
      </div>
      <div style={{ flexShrink: 0, textAlign: 'right' }}>
        <div className="pw-res-total">{fmtMoney(r.total)}</div>
        <Chip status={r.status} t={t} />
        <div className="pw-res-arrow">{t('list.viewDetailShort')}</div>
      </div>
    </div>
  )
}

// ─── App principal ────────────────────────────────────────────────────────────

// ─── Bloqueo: sustituir email temporal de Booking por el real ─────────────────

function EmailGateWidget({ t, onUpdated }: { t: (k: string) => string; onUpdated: (token: string, email: string) => void }) {
  const [email,  setEmail]  = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const submit = async () => {
    if (!email) return
    setSaving(true); setError('')
    try {
      const d = await apiFetch('/email', { method: 'PATCH', body: JSON.stringify({ email }) })
      onUpdated(d.token, d.email)
    } catch (e: any) { setError(e.message ?? t('emailGate.saveError')) }
    finally { setSaving(false) }
  }

  return (
    <div className="pw-card" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 30, marginBottom: 10 }}>📧</div>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{t('emailGate.title')}</div>
      <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 16 }}>
        {t('emailGate.body')}
      </p>
      {error && <div className="pw-alert pw-alert-err" style={{ marginBottom: 10 }}>{error}</div>}
      <div className="pw-fgroup" style={{ textAlign: 'left' }}>
        <input className="pw-input" type="email" value={email} placeholder="tu@email.com" autoFocus
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} />
      </div>
      <button className="pw-btn pw-btn-blue" style={{ width: '100%' }} onClick={submit} disabled={saving || !email}>
        {saving ? t('emailGate.saving') : t('emailGate.saveButton')}
      </button>
    </div>
  )
}

function PortalWidget() {
  const lang = useWidgetLang()
  const t = makeT(lang, PORTAL_I18N)
  const [token, setToken] = useState(getToken)
  const [email, setEmail] = useState(getEmail)

  // Notifica altura al padre en cada cambio de DOM
  useLayoutEffect(() => {
    postHeight()
    const ro = new ResizeObserver(postHeight)
    ro.observe(document.documentElement)
    return () => ro.disconnect()
  }, [token])

  const login = (tok: string, e: string) => { saveToken(tok, e); setToken(tok); setEmail(e) }
  const logout = () => { clearToken(); setToken(null); setEmail(null) }
  const onEmailUpdated = (tok: string, e: string) => { saveToken(tok, e); setToken(tok); setEmail(e) }

  const openBooking = () => {
    postParent('portal-open-booking')
  }

  const blocked = !!token && isBookingAlias(email ?? '')

  return (
    <div className="pw-wrap">
      <div className="pw-header">
        <div>
          <div className="pw-header-title">{t('app.headerTitle')}</div>
          {email && <div className="pw-header-email">{email}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {token && (
            <button className="pw-close-btn" onClick={logout}>{t('nav.logout')}</button>
          )}
          <button className="pw-close-btn" onClick={postClose}>{t('app.close')}</button>
        </div>
      </div>

      <div className="pw-body">
        {!token
          ? <LoginWidget lang={lang} onLogin={login} />
          : blocked
            ? <EmailGateWidget t={t} onUpdated={onEmailUpdated} />
            : <ReservationsList lang={lang} t={t} onNewBooking={openBooking} />
        }
      </div>
    </div>
  )
}

// ─── Mount ───────────────────────────────────────────────────────────────────

const style = document.createElement('style')
style.textContent = css
document.head.appendChild(style)

boot(() => createRoot(document.getElementById('root')!).render(
  <PortalWidget />
))
