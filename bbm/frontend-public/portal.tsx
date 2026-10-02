import React, { useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { AddressAutocomplete } from '../frontend/components/AddressAutocomplete'
import { useStandaloneLang, makeT, plural, type Lang } from './i18n'
import { PORTAL_I18N } from './i18n-portal'
import { LangSwitcher } from './LangSwitcher'
import { pfetch, branding, boot } from './branding'

const API    = '/api/public'
const CAPI   = '/api/customer'
const TKEY   = 'bm_customer_token'
const EKEY   = 'bm_customer_email'

const BOOKING_ALIAS = /@guest\.booking\.com$/i
function isBookingAlias(email: string) { return BOOKING_ALIAS.test((email ?? '').trim()) }

function fmtMoney(n: number | string) { return parseFloat(String(n)).toFixed(2).replace('.', ',') + ' €' }
function fmtDate(d: string)  { return new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) }
function fmtDateShort(d: string) { return new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) }

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function getToken()  { return localStorage.getItem(TKEY) }
function getEmail()  { return localStorage.getItem(EKEY) }
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

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({ lang, onLangChange, t, email, onLogout }: {
  lang: Lang; onLangChange: (l: Lang) => void; t: (k: string) => string
  email: string; onLogout: () => void
}) {
  return (
    <header className="pub-header">
      <a href="/" className="pub-logo">{(() => { const w = branding.name.split(' '); const last = w.pop(); return <>{w.join(' ')}{w.length ? ' ' : ''}<span>{last}</span></> })()}</a>
      <div className="pub-header-links">
        <span style={{ fontSize: 13, color: 'var(--text2)' }}>{email}</span>
        <button className="btn btn-ghost" style={{ padding: '5px 12px', fontSize: 13 }} onClick={onLogout}>
          {t('nav.logout')}
        </button>
        <LangSwitcher lang={lang} onChange={onLangChange} />
      </div>
    </header>
  )
}

// ─── Status chip ──────────────────────────────────────────────────────────────

function StatusChip({ status, t }: { status: string; t: (k: string) => string }) {
  return (
    <span className={`status-chip status-${status}`}>
      {t(`status.${status}`)}
    </span>
  )
}

// ─── Login page ───────────────────────────────────────────────────────────────

function LoginPage({ lang, onLangChange, t, onLogin }: {
  lang: Lang; onLangChange: (l: Lang) => void; t: (k: string, vars?: Record<string, string | number>) => string
  onLogin: (token: string, email: string) => void
}) {
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
        window.history.replaceState({}, '', '/portal')
      } else {
        window.history.replaceState({}, '', '/portal')
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
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('common.genericError'))
      setSent(true)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <div className="login-wrap">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <LangSwitcher lang={lang} onChange={onLangChange} />
      </div>
      <div className="login-card">
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🏨</div>
          <div className="login-title">{t('login.title')}</div>
          <div className="login-sub">{t('login.subStandalone')}</div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {magicToken && !error ? (
          <>
            <p style={{ fontSize: 13, color: 'var(--text2)', textAlign: 'center', marginBottom: 16 }}>
              {t('login.clickToAccess')}
            </p>
            <button className="btn btn-primary btn-full btn-lg" onClick={verifyToken} disabled={loading}>
              {loading ? <><span className="spin" /> {t('login.accessing')}</> : t('login.accessButton')}
            </button>
          </>
        ) : sent ? (
          <div className="login-sent">
            <div className="login-sent-icon">📧</div>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('login.checkEmail')}</div>
            <div style={{ fontSize: 13, color: 'var(--text2)' }}>
              {t('login.sentTo', { email })}<br />
              {t('login.validFor48h')}
            </div>
            <button className="btn btn-ghost btn-full" style={{ marginTop: 20 }} onClick={() => setSent(false)}>
              {t('login.useOtherEmail')}
            </button>
          </div>
        ) : (
          <>
            <div className="form-group">
              <label>{t('login.emailLabel')}</label>
              <input
                type="email" value={email} placeholder="tu@email.com"
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && send()}
                autoFocus
              />
            </div>
            <button className="btn btn-primary btn-full btn-lg" onClick={send} disabled={loading || !email}>
              {loading ? <><span className="spin" /> {t('login.sending')}</> : t('login.sendLinkButton')}
            </button>
            <p style={{ fontSize: 12, color: 'var(--text2)', textAlign: 'center', marginTop: 16 }}>
              {t('login.noPasswordNote')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Check-in online ──────────────────────────────────────────────────────────

const COUNTRIES = [
  ['ES','España'],['GB','Reino Unido'],['DE','Alemania'],['FR','Francia'],['IT','Italia'],
  ['PT','Portugal'],['NL','Países Bajos'],['BE','Bélgica'],['CH','Suiza'],['AT','Austria'],
  ['PL','Polonia'],['SE','Suecia'],['NO','Noruega'],['DK','Dinamarca'],['FI','Finlandia'],
  ['US','Estados Unidos'],['CA','Canadá'],['AR','Argentina'],['MX','México'],['BR','Brasil'],
  ['CN','China'],['JP','Japón'],['AU','Australia'],['RU','Rusia'],['MA','Marruecos'],
]

function CheckInForm({ t, reservationId, onDone }: { t: (k: string) => string; reservationId: number; onDone: () => void }) {
  const [docType,     setDocType]     = useState('dni')
  const [docNum,      setDocNum]      = useState('')
  const [nationality, setNationality] = useState('ES')
  const [birthDate,   setBirthDate]   = useState('')
  const [arrival,     setArrival]     = useState('')
  const [address1,    setAddress1]    = useState('')
  const [zipCode,     setZipCode]     = useState('')
  const [city,        setCity]        = useState('')
  const [country,     setCountry]     = useState('ES')
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')
  const [done,        setDone]        = useState(false)

  const submit = async () => {
    if (!docNum)    { setError(t('checkin.docNumberRequired')); return }
    if (!birthDate) { setError(t('checkin.birthDateRequired')); return }
    if (!address1 || !zipCode || !city) { setError(t('checkin.addressRequired')); return }
    setLoading(true); setError('')
    try {
      await apiFetch(`/reservations/${reservationId}/checkin`, {
        method: 'POST',
        body: JSON.stringify({
          documentType:   docType,
          documentNumber: docNum,
          nationality:    nationality || undefined,
          birthDate:      birthDate   || undefined,
          arrivalTime:    arrival     || undefined,
          address1, zipCode, city,
          addressCountryCode: country || undefined,
        }),
      })
      setDone(true)
      onDone()
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  if (done) return <div className="checkin-success">{t('checkin.completed')}</div>

  return (
    <div style={{ marginTop: 16 }}>
      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="form-row">
        <div className="form-group">
          <label>{t('checkin.docTypeLabel')}</label>
          <select value={docType} onChange={e => setDocType(e.target.value)}>
            <option value="dni">DNI</option>
            <option value="nie">NIE</option>
            <option value="passport">Pasaporte</option>
            <option value="driving_licence">Carné de conducir</option>
            <option value="other">Otro</option>
          </select>
        </div>
        <div className="form-group">
          <label>{t('checkin.docNumberLabel')}</label>
          <input type="text" value={docNum} onChange={e => setDocNum(e.target.value.toUpperCase())} placeholder="12345678A" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>{t('checkin.nationalityLabel')}</label>
          <select value={nationality} onChange={e => setNationality(e.target.value)}>
            {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>{t('checkin.birthDateLabel')}</label>
          <input type="date" value={birthDate} onChange={e => setBirthDate(e.target.value)} max={new Date().toISOString().slice(0,10)} />
        </div>
      </div>
      <div className="form-group">
        <label>{t('checkin.addressLabel')}</label>
        <AddressAutocomplete onSelect={a => {
          if (a.address1)    setAddress1(a.address1)
          if (a.zipCode)     setZipCode(a.zipCode)
          if (a.city)        setCity(a.city)
          if (a.countryCode) setCountry(a.countryCode)
        }} placeholder={t('checkin.addressAutocompletePlaceholder')} />
      </div>
      <div className="form-group">
        <label>{t('checkin.streetLabel')}</label>
        <input type="text" value={address1} onChange={e => setAddress1(e.target.value)} placeholder="Calle Mayor 10" />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>{t('checkin.zipLabel')}</label>
          <input type="text" value={zipCode} onChange={e => setZipCode(e.target.value)} placeholder="29001" />
        </div>
        <div className="form-group">
          <label>{t('checkin.cityLabel')}</label>
          <input type="text" value={city} onChange={e => setCity(e.target.value)} placeholder="Málaga" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>{t('checkin.countryLabel')}</label>
          <select value={country} onChange={e => setCountry(e.target.value)}>
            {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ maxWidth: 180 }}>
          <label>{t('checkin.arrivalTimeLabel')}</label>
          <input type="time" value={arrival} onChange={e => setArrival(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-primary" onClick={submit} disabled={loading}>
        {loading ? <><span className="spin" /> {t('login.sending')}</> : t('checkin.confirmButton')}
      </button>
    </div>
  )
}

// ─── Extras (servicios opcionales, post-reserva) ──────────────────────────────

type ExtraItem = { id: number; title: string; description: string | null; icon: string | null; pricingType: string; maxQuantity: number; defaultPrice: string | null }

function extraUnitPrice(item: ExtraItem, nights: number, people: number): number {
  const base = parseFloat(item.defaultPrice ?? '0')
  switch (item.pricingType) {
    case 'per_night':        return base * nights
    case 'per_person':       return base * people
    case 'per_person_night': return base * people * nights
    default:                 return base
  }
}

function ExtrasSection({ t, reservationId, nights, people }: { t: (k: string, vars?: Record<string, string | number>) => string; reservationId: number; nights: number; people: number }) {
  const [extras,  setExtras]  = useState<ExtraItem[]>([])
  const [qtys,    setQtys]    = useState<Record<number, number>>({})
  const [paying,  setPaying]  = useState(false)
  const [error,   setError]   = useState('')

  useEffect(() => {
    pfetch(`${API}/extras`).then(r => r.json()).then(d => setExtras(d.data ?? [])).catch(() => {})
  }, [])

  if (extras.length === 0) return null

  const setQty = (itemId: number, q: number) =>
    setQtys(p => ({ ...p, [itemId]: Math.max(0, Math.min(q, extras.find(e => e.id === itemId)?.maxQuantity ?? 1)) }))

  const total = extras.reduce((s, e) => {
    const q = qtys[e.id] ?? 0
    return s + (q > 0 ? extraUnitPrice(e, nights, people) * q : 0)
  }, 0)

  const pay = async () => {
    const selected = Object.entries(qtys).filter(([, q]) => q > 0).map(([itemId, quantity]) => ({ saleItemId: parseInt(itemId), quantity }))
    if (selected.length === 0) return
    setPaying(true); setError('')
    try {
      const d = await apiFetch(`/reservations/${reservationId}/extras`, {
        method: 'POST', body: JSON.stringify({ extras: selected }),
      })
      window.location.href = d.url
    } catch (e: any) { setError(e.message ?? t('extras.payError')); setPaying(false) }
  }

  return (
    <div className="pub-card">
      <div className="pub-card-title">{t('extras.title')}</div>
      {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}
      {extras.map(e => {
        const q    = qtys[e.id] ?? 0
        const unit = extraUnitPrice(e, nights, people)
        return (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
            {e.icon && <span style={{ fontSize: 20, width: 26, textAlign: 'center' }}>{e.icon}</span>}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{e.title}</div>
              {e.description && <div style={{ fontSize: 11, color: 'var(--text2)' }}>{e.description}</div>}
              <div style={{ fontSize: 11, color: 'var(--blue)', marginTop: 2 }}>
                {fmtMoney(unit)}
                {e.pricingType === 'per_night' && t('common.perNight')}
                {e.pricingType === 'per_person' && t('common.perPerson')}
                {e.pricingType === 'per_person_night' && t('common.perPersonNight')}
              </div>
            </div>
            {e.maxQuantity > 1 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setQty(e.id, q - 1)} style={{ width: 26, height: 26, borderRadius: 5, border: '1px solid var(--border2)', background: '#fff', cursor: 'pointer' }}>−</button>
                <span style={{ minWidth: 18, textAlign: 'center', fontWeight: 700, fontSize: 13 }}>{q}</span>
                <button onClick={() => setQty(e.id, q + 1)} style={{ width: 26, height: 26, borderRadius: 5, border: '1px solid var(--border2)', background: '#fff', cursor: 'pointer' }}>+</button>
              </div>
            ) : (
              <input type="checkbox" checked={q > 0} onChange={ev => setQty(e.id, ev.target.checked ? 1 : 0)} style={{ width: 18, height: 18 }} />
            )}
          </div>
        )
      })}
      {total > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="summary-row total" style={{ marginBottom: 10 }}>
            <span>{t('extras.totalLabel')}</span><span>{fmtMoney(total)}</span>
          </div>
          <button className="btn btn-primary" onClick={pay} disabled={paying}>
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
      window.location.href = d.url
    } catch (e: any) { setPayError(e.message ?? t('extendStay.payError')); setPaying(false) }
  }

  return (
    <div className="pub-card">
      <div className="pub-card-title">{t('extendStay.title')}</div>
      {!fullyPaid ? (
        <p style={{ fontSize: 13, color: 'var(--text2)' }}>{t('extendStay.needsPaymentFirst')}</p>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 10 }}>{t('extendStay.intro')}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 13 }}>{t('extendStay.nightsLabel')}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => setNights(n => Math.max(1, n - 1))} style={{ width: 26, height: 26, borderRadius: 5, border: '1px solid var(--border2)', background: '#fff', cursor: 'pointer' }}>−</button>
              <span style={{ minWidth: 18, textAlign: 'center', fontWeight: 700, fontSize: 13 }}>{nights}</span>
              <button onClick={() => setNights(n => Math.min(MAX_EXTEND_NIGHTS, n + 1))} style={{ width: 26, height: 26, borderRadius: 5, border: '1px solid var(--border2)', background: '#fff', cursor: 'pointer' }}>+</button>
            </div>
          </div>
          {quoting && <p style={{ fontSize: 13, color: 'var(--text2)' }}>{t('extendStay.quoting')}</p>}
          {quoteError && <div className="alert alert-error" style={{ marginBottom: 10 }}>{quoteError}</div>}
          {payError && <div className="alert alert-error" style={{ marginBottom: 10 }}>{payError}</div>}
          {quote && !quoting && (
            <div style={{ marginTop: 4 }}>
              <div className="summary-row"><span style={{ color: 'var(--text2)' }}>{t('extendStay.newCheckout')}</span><strong>{fmtDate(quote.newCheckOutDate)}</strong></div>
              <div className="summary-row total" style={{ marginBottom: 10 }}>
                <span>{t('extendStay.totalLabel')}</span><span>{fmtMoney(quote.total)}</span>
              </div>
              <button className="btn btn-primary" onClick={pay} disabled={paying}>
                {paying ? t('common.redirecting') : t('extendStay.payButton', { total: fmtMoney(quote.total) })}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Reservation detail modal ─────────────────────────────────────────────────

function ReservationModal({ t, id, onClose }: { t: (k: string, vars?: Record<string, string | number>) => string; id: number; onClose: () => void }) {
  const [data,     setData]     = useState<any>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [showCI,   setShowCI]   = useState(false)
  const [paying,   setPaying]   = useState(false)

  useEffect(() => {
    apiFetch(`/reservations/${id}`)
      .then(d => { setData(d.data); setLoading(false) })
      .catch((e: any) => { setError(e.message ?? t('reservation.loadError')); setLoading(false) })
  }, [id])

  const pay = async () => {
    setPaying(true)
    try {
      const d = await apiFetch(`/reservations/${id}/pay`, { method: 'POST' })
      window.location.href = d.url
    } catch (e: any) {
      alert(e.message ?? t('extras.payError'))
      setPaying(false)
    }
  }

  const nights = data ? Math.round((new Date(data.checkOutDate + 'T12:00:00').getTime() - new Date(data.checkInDate + 'T12:00:00').getTime()) / 86400000) : 0

  const canCheckin = data && ['confirmed', 'tentative'].includes(data.status) && !data.onlineCheckIn
  const txs: any[] = data?.transactions ?? []
  const pending    = data ? parseFloat(data.total) - parseFloat(data.amountPaid ?? '0') : 0
  const canPay     = data && pending > 0.01 && !['cancelled', 'no_show'].includes(data.status)
  const canAddExtras = data && !['cancelled', 'no_show', 'checked_out'].includes(data.status)
  const hasExtraRooms = ((data?.extraRoomIds ?? []) as number[]).length > 0
  const canExtendStay = data && !['cancelled', 'no_show', 'checked_out'].includes(data.status) && !hasExtraRooms

  return (
    <>
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 100,
      }} onClick={onClose} />
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        display: 'flex', justifyContent: 'center', zIndex: 101,
      }}>
      <div style={{
        background: '#fff', borderRadius: '16px 16px 0 0',
        width: '100%', maxWidth: 640,
        maxHeight: '90dvh', overflowY: 'auto',
        paddingTop: 24, paddingLeft: 24, paddingRight: 24,
        paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{t('reservation.detailTitle')}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text2)' }}>✕</button>
        </div>

        {loading && <div className="loading"><span className="spin" /></div>}
        {error && <div className="alert alert-error">{error}</div>}

        {data && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 4 }}>{t('reservation.idLabel', { id: data.id })}</div>
                <StatusChip status={data.status} t={t} />
              </div>
              {data.onlineCheckIn && (
                <span style={{ fontSize: 12, background: '#dcfce7', color: '#16a34a', padding: '3px 10px', borderRadius: 99, fontWeight: 600 }}>
                  {t('reservation.onlineCheckinBadge')}
                </span>
              )}
            </div>

            <div className="pub-card" style={{ marginBottom: 14 }}>
              <div className="summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.arrival')}</span><strong>{fmtDate(data.checkInDate)}</strong></div>
              <div className="summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.departure')}</span><strong>{fmtDate(data.checkOutDate)}</strong></div>
              <div className="summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.nights')}</span><strong>{nights}</strong></div>
              {data.room && <div className="summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.room')}</span><strong>{data.room.code}</strong></div>}
              {data.rate && <div className="summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.rate')}</span><strong>{data.rate.title}</strong></div>}
              <div className="summary-row total">
                <span>{t('common.total')}</span><span>{fmtMoney(data.total)}</span>
              </div>
              {parseFloat(data.amountPaid) > 0 && (
                <div className="summary-row" style={{ color: 'var(--green)' }}>
                  <span>{t('reservation.paid')}</span><span>{fmtMoney(data.amountPaid)}</span>
                </div>
              )}
              {pending > 0.01 && (
                <div className="summary-row" style={{ color: 'var(--red)', fontWeight: 600 }}>
                  <span>{t('reservation.pending')}</span><span>{fmtMoney(pending.toFixed(2))}</span>
                </div>
              )}
            </div>

            {canPay && (
              <div className="pub-card" style={{ borderColor: 'var(--blue)', marginBottom: 14 }}>
                <div className="pub-card-title">{t('reservation.pendingPaymentTitle')}</div>
                <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12 }}>
                  {t('reservation.pendingPaymentInfoStandalone', { amount: fmtMoney(pending.toFixed(2)) })}
                </p>
                <button className="btn btn-primary" onClick={pay} disabled={paying}>
                  {paying ? t('common.redirecting') : t('reservation.payButton', { amount: fmtMoney(pending.toFixed(2)) })}
                </button>
              </div>
            )}

            {canCheckin && (
              <div className="pub-card" style={{ borderColor: 'var(--blue)' }}>
                <div className="pub-card-title">{t('checkin.sectionTitle')}</div>
                <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12 }}>
                  {t('checkin.intro')}
                </p>
                {!showCI
                  ? <button className="btn btn-primary" onClick={() => setShowCI(true)}>{t('checkin.doCheckin')}</button>
                  : <CheckInForm t={t} reservationId={id} onDone={() => { setShowCI(false); setData((d: any) => ({ ...d, onlineCheckIn: true })) }} />
                }
              </div>
            )}

            {canExtendStay && (
              <ExtendStaySection t={t} reservationId={id} fullyPaid={pending <= 0.01} />
            )}

            {canAddExtras && (
              <ExtrasSection t={t} reservationId={id} nights={nights} people={data.people} />
            )}

            {txs.length > 0 && (
              <div className="pub-card">
                <div className="pub-card-title">{t('reservation.paymentsTitle')}</div>
                {txs.map((tx: any) => (
                  <div key={tx.id} className="summary-row" style={{ fontSize: 13 }}>
                    <span style={{ color: 'var(--text2)' }}>{tx.transactionDate}</span>
                    <span style={{ fontWeight: 600 }}>{fmtMoney(tx.amount)}</span>
                  </div>
                ))}
              </div>
            )}

            {pending <= 0.01 && !['cancelled','no_show'].includes(data.status) && (
              <InvoiceSection t={t} reservationId={id} />
            )}

            {!['cancelled', 'no_show'].includes(data.status) && (
              <FeedbackSection t={t} reservationId={id} />
            )}
          </>
        )}
      </div>
      </div>
    </>
  )
}

// ─── Feedback section ─────────────────────────────────────────────────────────
// El huésped deja feedback directamente, sin pasar por el personal — llega a
// Informes → Feedback en el gestor (feedback_threads, source='guest'). Un
// clic rápido (👍/😐/🚩/💡) más un texto opcional; se puede enviar más de una
// vez durante la estancia (no es un único formulario que "se gasta").
const FEEDBACK_OPTIONS: { key: 'positive' | 'neutral' | 'complaint' | 'suggestion'; emoji: string }[] = [
  { key: 'positive',   emoji: '👍' },
  { key: 'neutral',    emoji: '😐' },
  { key: 'complaint',  emoji: '🚩' },
  { key: 'suggestion', emoji: '💡' },
]

function FeedbackSection({ t, reservationId }: { t: (k: string, vars?: Record<string, string | number>) => string; reservationId: number }) {
  const [sentiment, setSentiment] = useState<string | null>(null)
  const [text,      setText]      = useState('')
  const [sending,   setSending]   = useState(false)
  const [sent,      setSent]      = useState(false)
  const [error,     setError]     = useState('')

  const send = async () => {
    if (!sentiment) return
    setSending(true); setError('')
    try {
      await apiFetch(`/reservations/${reservationId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ sentiment, text: text.trim() || '(sin comentario)' }),
      })
      setSent(true); setSentiment(null); setText('')
    } catch (e: any) {
      setError(e.message ?? t('feedback.sendError'))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="pub-card">
      <div className="pub-card-title">{t('feedback.title')}</div>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12 }}>{t('feedback.intro')}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {FEEDBACK_OPTIONS.map(o => (
          <button key={o.key} type="button"
            onClick={() => { setSentiment(o.key); setSent(false) }}
            style={{
              flex: '1 1 auto', minWidth: 70, padding: '10px 8px', borderRadius: 10,
              border: sentiment === o.key ? '2px solid var(--blue)' : '1px solid #e5e7eb',
              background: sentiment === o.key ? '#eff6ff' : '#fff',
              cursor: 'pointer', fontSize: 12, textAlign: 'center', lineHeight: 1.4,
            }}>
            <div style={{ fontSize: 20 }}>{o.emoji}</div>
            {t(`feedback.${o.key}`)}
          </button>
        ))}
      </div>
      {sentiment && (
        <>
          <textarea
            value={text} onChange={e => setText(e.target.value)}
            placeholder={t('feedback.placeholder')}
            rows={2}
            style={{ width: '100%', resize: 'vertical', marginBottom: 10, fontFamily: 'inherit' }}
          />
          <button className="btn btn-primary" onClick={send} disabled={sending}>
            {sending ? t('common.processing') : t('feedback.send')}
          </button>
        </>
      )}
      {error && <div className="alert alert-error" style={{ marginTop: 10 }}>{error}</div>}
      {sent && <div style={{ marginTop: 10, color: 'var(--green)', fontSize: 13, fontWeight: 600 }}>{t('feedback.sent')}</div>}
    </div>
  )
}

// ─── Invoice section ─────────────────────────────────────────────────────────

function InvoiceSection({ t, reservationId }: { t: (k: string, vars?: Record<string, string | number>) => string; reservationId: number }) {
  const [invoices,   setInvoices]   = useState<any[] | null>(null)
  const [requested,  setRequested]  = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [showForm,   setShowForm]   = useState(false)
  const [form, setForm] = useState({ billingName: '', billingNif: '', billingAddress: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    apiFetch(`/reservations/${reservationId}/invoice`)
      .then(d => setInvoices(d.data ?? []))
      .catch(() => setInvoices([]))
  }, [reservationId])

  const validate = () => {
    const e: Record<string, string> = {}
    if (!form.billingName.trim())    e.billingName    = t('invoice.requiredField')
    if (!form.billingNif.trim())     e.billingNif     = t('invoice.requiredField')
    if (!form.billingAddress.trim()) e.billingAddress = t('invoice.requiredField')
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const request = async () => {
    if (!validate()) return
    setRequesting(true)
    try {
      await apiFetch(`/reservations/${reservationId}/request-invoice`, {
        method: 'POST',
        body: JSON.stringify(form),
      })
      setRequested(true)
    } catch (e: any) {
      alert(e.message ?? t('invoice.sendError'))
    } finally { setRequesting(false) }
  }

  if (invoices === null) return null

  const fieldStyle = (field: string): React.CSSProperties => ({
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13,
    border: `1px solid ${errors[field] ? '#e05' : 'var(--border)'}`,
    borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', marginTop: 2,
  })

  return (
    <div className="pub-card">
      <div className="pub-card-title">{t('invoice.title')}</div>
      {invoices.length > 0 ? (
        invoices.map((inv: any) => (
          <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span style={{ color: 'var(--text2)' }}>{t('invoice.line', { number: inv.invoiceNumber, date: inv.issuedAt })}</span>
            {inv.pdfUrl
              ? <a href={inv.pdfUrl} target="_blank" rel="noreferrer" className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}>{t('invoice.download')}</a>
              : <span style={{ color: 'var(--text2)', fontSize: 12 }}>{t('invoice.noPdf')}</span>
            }
          </div>
        ))
      ) : requested ? (
        <p style={{ fontSize: 13, color: 'var(--green)' }}>{t('invoice.requestedMsg')}</p>
      ) : showForm ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>
            {t('invoice.formIntro')}
          </p>
          <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>{t('invoice.nameLabel')} <span style={{ color: '#e05' }}>*</span></span>
            <input value={form.billingName}
              onChange={e => setForm(f => ({ ...f, billingName: e.target.value }))}
              placeholder="Juan García López / EMPRESA SL"
              style={fieldStyle('billingName')} />
            {errors.billingName && <span style={{ color: '#e05', fontSize: 11 }}>{errors.billingName}</span>}
          </label>
          <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>{t('invoice.nifLabel')} <span style={{ color: '#e05' }}>*</span></span>
            <input value={form.billingNif}
              onChange={e => setForm(f => ({ ...f, billingNif: e.target.value }))}
              placeholder="12345678Z"
              style={fieldStyle('billingNif')} />
            {errors.billingNif && <span style={{ color: '#e05', fontSize: 11 }}>{errors.billingNif}</span>}
          </label>
          <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>{t('invoice.addressLabel')} <span style={{ color: '#e05' }}>*</span></span>
            <input value={form.billingAddress}
              onChange={e => setForm(f => ({ ...f, billingAddress: e.target.value }))}
              placeholder="Calle Mayor 10, 29001 Málaga"
              style={fieldStyle('billingAddress')} />
            {errors.billingAddress && <span style={{ color: '#e05', fontSize: 11 }}>{errors.billingAddress}</span>}
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn btn-ghost" onClick={request} disabled={requesting}>
              {requesting ? t('login.sending') : t('invoice.sendRequest')}
            </button>
            <button className="btn btn-ghost" style={{ opacity: 0.6 }}
              onClick={() => { setShowForm(false); setErrors({}) }}>{t('invoice.cancel')}</button>
          </div>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12 }}>
            {t('invoice.requestIntro')}
          </p>
          <button className="btn btn-ghost" onClick={() => setShowForm(true)}>
            {t('invoice.requestButton')}
          </button>
        </>
      )}
    </div>
  )
}

// ─── Reservations list ────────────────────────────────────────────────────────

function ReservationsList({ lang, t }: { lang: Lang; t: (k: string, vars?: Record<string, string | number>) => string }) {
  const [list,    setList]    = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [openId,  setOpenId]  = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/reservations')
      setList(data.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [])

  if (loading) return <div className="loading"><span className="spin" /></div>
  if (error)   return <div className="alert alert-error">{error}</div>

  const upcoming = list.filter(r => r.checkOutDate >= new Date().toISOString().slice(0, 10) && r.status !== 'cancelled')
  const past     = list.filter(r => r.checkOutDate  < new Date().toISOString().slice(0, 10) || r.status === 'cancelled')

  return (
    <>
      {list.length === 0 && (
        <div className="pub-card" style={{ textAlign: 'center', color: 'var(--text2)', padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🏖️</div>
          <p>{t('list.noBookings')}<br />
            <a href="/booking" style={{ color: 'var(--blue)', fontWeight: 600 }}>{t('list.bookNow')}</a>
          </p>
        </div>
      )}

      {upcoming.length > 0 && (
        <>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12 }}>{t('list.upcoming')}</div>
          <div className="res-list" style={{ marginBottom: 28 }}>
            {upcoming.map(r => <ResCard key={r.id} lang={lang} t={t} r={r} onClick={() => setOpenId(r.id)} />)}
          </div>
        </>
      )}

      {past.length > 0 && (
        <>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12, color: 'var(--text2)' }}>{t('list.past')}</div>
          <div className="res-list">
            {past.map(r => <ResCard key={r.id} lang={lang} t={t} r={r} onClick={() => setOpenId(r.id)} />)}
          </div>
        </>
      )}

      {openId && <ReservationModal t={t} id={openId} onClose={() => { setOpenId(null); load() }} />}
    </>
  )
}

function ResCard({ lang, t, r, onClick }: { lang: Lang; t: (k: string, vars?: Record<string, string | number>) => string; r: any; onClick: () => void }) {
  const nights = Math.round((new Date(r.checkOutDate + 'T12:00:00').getTime() - new Date(r.checkInDate + 'T12:00:00').getTime()) / 86400000)
  return (
    <div className="res-card" onClick={onClick} style={{ cursor: 'pointer' }}>
      <div className="res-card-main">
        <div className="res-card-id">{t('reservation.idLabel', { id: r.id })}</div>
        <div className="res-card-dates">{fmtDateShort(r.checkInDate)} → {fmtDateShort(r.checkOutDate)}</div>
        <div className="res-card-info">
          {nights} {plural(lang, nights, t('common.nightOne'), t('common.nightOther'))}
          {r.room   ? ` · Hab. ${r.room.code}` : ''}
          {r.rate   ? ` · ${r.rate.title}` : ''}
        </div>
        {r.onlineCheckIn && (
          <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600, marginTop: 4, display: 'inline-block' }}>
            {t('reservation.onlineCheckinBadge')}
          </span>
        )}
      </div>
      <div className="res-card-right">
        <div className="res-card-total">{fmtMoney(r.total)}</div>
        <StatusChip status={r.status} t={t} />
        <div style={{ fontSize: 12, color: 'var(--blue)', marginTop: 8 }}>{t('list.viewDetail')}</div>
      </div>
    </div>
  )
}

// ─── Bloqueo: sustituir email temporal de Booking por el real ─────────────────

function EmailGate({ t, onUpdated }: { t: (k: string) => string; onUpdated: (token: string, email: string) => void }) {
  const [email,   setEmail]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

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
    <div className="pub-card" style={{ maxWidth: 440, margin: '40px auto', textAlign: 'center' }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>📧</div>
      <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 8 }}>{t('emailGate.title')}</div>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 20 }}>
        {t('emailGate.body')}
      </p>
      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="form-group">
        <input type="email" value={email} placeholder="tu@email.com" autoFocus
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} />
      </div>
      <button className="btn btn-primary btn-full" onClick={submit} disabled={saving || !email}>
        {saving ? t('emailGate.saving') : t('emailGate.saveButton')}
      </button>
    </div>
  )
}

// ─── Portal app ───────────────────────────────────────────────────────────────

function PortalApp() {
  const [lang, setLang] = useStandaloneLang()
  const t = makeT(lang, PORTAL_I18N)
  const [token,      setToken]      = useState(getToken)
  const [email,      setEmail]      = useState(getEmail)
  const [paymentOk,  setPaymentOk]  = useState(() => new URLSearchParams(location.search).has('payment_ok'))

  const login = (tok: string, e: string) => {
    saveToken(tok, e); setToken(tok); setEmail(e)
  }

  const logout = () => {
    clearToken(); setToken(null); setEmail(null)
  }

  const onEmailUpdated = (tok: string, e: string) => { saveToken(tok, e); setToken(tok); setEmail(e) }

  if (!token) return <LoginPage lang={lang} onLangChange={setLang} t={t} onLogin={login} />

  const blocked = isBookingAlias(email ?? '')

  return (
    <>
      <Header lang={lang} onLangChange={setLang} t={t} email={email ?? ''} onLogout={logout} />
      <div className="pub-wrap">
        {blocked ? (
          <EmailGate t={t} onUpdated={onEmailUpdated} />
        ) : (
          <>
            {paymentOk && (
              <div className="alert" style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 10, padding: '12px 16px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t('app.paymentOk')}</span>
                <button onClick={() => { setPaymentOk(false); window.history.replaceState({}, '', '/portal') }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#15803d' }}>✕</button>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <div>
                <h1 className="pub-title" style={{ marginBottom: 4 }}>{t('app.title')}</h1>
                <p style={{ color: 'var(--text2)', fontSize: 14 }}>{t('app.sub')}</p>
              </div>
              <a href="/booking" className="btn btn-primary">{t('list.newBooking')}</a>
            </div>
            <ReservationsList lang={lang} t={t} />
          </>
        )}
      </div>
    </>
  )
}

boot(() => createRoot(document.getElementById('root')!).render(
  <PortalApp />
))
