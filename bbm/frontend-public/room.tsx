import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useStandaloneLang, makeT, type Lang } from './i18n'
import { PORTAL_I18N } from './i18n-portal'
import { LangSwitcher } from './LangSwitcher'
import { pfetch, branding, boot } from './branding'

// ─── Acceso por QR de habitación (frontend) ───────────────────────────────────
// Página independiente de /portal (login por email): aquí se llega con un
// token de HABITACIÓN en la URL (?t=..., el QR físico pegado en la
// habitación), se confirma el primer apellido y se obtiene una sesión corta
// acotada solo a la reserva actual de esa habitación — ver
// src/routes/room-access.ts. No hay "mis reservas", solo la estancia de
// ahora mismo: detalle, ampliar, extras, petición de limpieza del día y
// feedback.

const API_PUBLIC = '/api/public'
const CAPI        = '/api/room-access'
const MAX_EXTEND_NIGHTS = 14

type T = (k: string, vars?: Record<string, string | number>) => string

function fmtMoney(n: number | string) { return parseFloat(String(n)).toFixed(2).replace('.', ',') + ' €' }
function fmtDate(d: string) { return new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) }

// ─── Pantalla de verificación (apellido) ───────────────────────────────────────

function VerifyGate({ t, qrToken, onVerified }: { t: T; qrToken: string; onVerified: (jwt: string) => void }) {
  const [lastName, setLastName] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  const submit = async () => {
    if (!lastName.trim()) return
    setLoading(true); setError('')
    try {
      const r = await pfetch(`${CAPI}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: qrToken, lastName: lastName.trim() }),
      })
      const d = await r.json()
      if (!r.ok) {
        if (r.status === 429) throw new Error(t('roomAccess.rateLimited'))
        if (r.status === 404) throw new Error(t('roomAccess.invalidCode'))
        throw new Error(d.error ?? t('roomAccess.verifyError'))
      }
      onVerified(d.token)
    } catch (e: any) { setError(e.message ?? t('roomAccess.verifyError')) }
    finally { setLoading(false) }
  }

  return (
    <div className="pub-card" style={{ maxWidth: 440, margin: '40px auto', textAlign: 'center' }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>🔑</div>
      <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 8 }}>{t('roomAccess.title')}</div>
      <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 20 }}>{t('roomAccess.intro')}</p>
      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="form-group">
        <input value={lastName} placeholder={t('roomAccess.lastNamePlaceholder')} autoFocus
          onChange={e => setLastName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} />
      </div>
      <button className="btn btn-primary btn-full" onClick={submit} disabled={loading || !lastName.trim()}>
        {loading ? t('roomAccess.verifying') : t('roomAccess.verifyButton')}
      </button>
    </div>
  )
}

// ─── Ampliar estancia ─────────────────────────────────────────────────────────

function RoomExtendSection({ t, rf, fullyPaid }: { t: T; rf: (path: string, opts?: RequestInit) => Promise<any>; fullyPaid: boolean }) {
  const [nights,     setNights]     = useState(1)
  const [quote,      setQuote]      = useState<{ newCheckOutDate: string; total: number } | null>(null)
  const [quoting,    setQuoting]    = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [paying,     setPaying]     = useState(false)
  const [payError,   setPayError]   = useState('')

  useEffect(() => {
    if (!fullyPaid) return
    let cancelled = false
    setQuoting(true); setQuoteError(''); setQuote(null)
    rf(`/extend-quote?nights=${nights}`)
      .then(d => { if (!cancelled) setQuote(d) })
      .catch((e: any) => { if (!cancelled) setQuoteError(e.message ?? t('extendStay.quoteError')) })
      .finally(() => { if (!cancelled) setQuoting(false) })
    return () => { cancelled = true }
  }, [nights, fullyPaid])

  const pay = async () => {
    setPaying(true); setPayError('')
    try {
      const d = await rf('/extend', { method: 'POST', body: JSON.stringify({ nights }) })
      window.location.href = d.url
    } catch (e: any) { setPayError(e.message ?? t('extendStay.payError')); setPaying(false) }
  }

  return (
    <div className="pub-card" style={{ marginBottom: 14 }}>
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

// ─── Extras ─────────────────────────────────────────────────────────────────

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

function RoomExtrasSection({ t, rf, nights, people }: { t: T; rf: (path: string, opts?: RequestInit) => Promise<any>; nights: number; people: number }) {
  const [extras, setExtras] = useState<ExtraItem[]>([])
  const [qtys,   setQtys]   = useState<Record<number, number>>({})
  const [paying, setPaying] = useState(false)
  const [error,  setError]  = useState('')

  useEffect(() => {
    pfetch(`${API_PUBLIC}/extras`).then(r => r.json()).then(d => setExtras(d.data ?? [])).catch(() => {})
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
      const d = await rf('/extras', { method: 'POST', body: JSON.stringify({ extras: selected }) })
      window.location.href = d.url
    } catch (e: any) { setError(e.message ?? t('extras.payError')); setPaying(false) }
  }

  return (
    <div className="pub-card" style={{ marginBottom: 14 }}>
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

// ─── Petición de limpieza del día ───────────────────────────────────────────

function HousekeepingSection({ t, rf }: { t: T; rf: (path: string, opts?: RequestInit) => Promise<any> }) {
  const [allowed, setAllowed] = useState(true)
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [saved,    setSaved]    = useState(false)

  const load = () => {
    setLoading(true)
    rf('/housekeeping-today')
      .then(d => { setAllowed(d.allowed); setLoading(false) })
      .catch(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const send = async (type: 'clean' | 'dnd' | 'towels_only') => {
    setSaving(true); setError(''); setSaved(false)
    try {
      await rf('/housekeeping-request', { method: 'POST', body: JSON.stringify({ type }) })
      setSaved(true)
    } catch (e: any) { setError(e.message ?? t('roomAccess.housekeepingError')) }
    finally { setSaving(false) }
  }

  if (loading) return null

  return (
    <div className="pub-card" style={{ marginBottom: 14 }}>
      <div className="pub-card-title">{t('roomAccess.housekeepingTitle')}</div>
      {!allowed ? (
        <p style={{ fontSize: 13, color: 'var(--text2)' }}>{t('roomAccess.housekeepingDisabled')}</p>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 10 }}>{t('roomAccess.housekeepingIntro')}</p>
          {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" disabled={saving} onClick={() => send('clean')}>🧹 {t('roomAccess.cleanOption')}</button>
            <button className="btn btn-ghost" disabled={saving} onClick={() => send('dnd')}>🚫 {t('roomAccess.dndOption')}</button>
            <button className="btn btn-ghost" disabled={saving} onClick={() => send('towels_only')}>🧺 {t('roomAccess.towelsOption')}</button>
          </div>
          {saved && <div style={{ marginTop: 10, color: 'var(--green)', fontSize: 13, fontWeight: 600 }}>{t('roomAccess.housekeepingSaved')}</div>}
        </>
      )}
    </div>
  )
}

// ─── Feedback ───────────────────────────────────────────────────────────────

const FEEDBACK_OPTIONS: { key: 'positive' | 'neutral' | 'complaint' | 'suggestion'; emoji: string }[] = [
  { key: 'positive',   emoji: '👍' },
  { key: 'neutral',    emoji: '😐' },
  { key: 'complaint',  emoji: '🚩' },
  { key: 'suggestion', emoji: '💡' },
]

function RoomFeedbackSection({ t, rf }: { t: T; rf: (path: string, opts?: RequestInit) => Promise<any> }) {
  const [sentiment, setSentiment] = useState<string | null>(null)
  const [text,      setText]      = useState('')
  const [sending,   setSending]   = useState(false)
  const [sent,      setSent]      = useState(false)
  const [error,     setError]     = useState('')

  const send = async () => {
    if (!sentiment) return
    setSending(true); setError('')
    try {
      await rf('/feedback', { method: 'POST', body: JSON.stringify({ sentiment, text: text.trim() || '(sin comentario)' }) })
      setSent(true); setSentiment(null); setText('')
    } catch (e: any) { setError(e.message ?? t('feedback.sendError')) }
    finally { setSending(false) }
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
            placeholder={t('feedback.placeholder')} rows={2}
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

// ─── Pantalla principal de la estancia ─────────────────────────────────────────

function RoomStay({ t, session, onExpired }: { t: T; session: string; onExpired: () => void }) {
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const rf = async (path: string, opts: RequestInit = {}) => {
    const r = await pfetch(CAPI + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}`, ...(opts.headers ?? {}) },
    })
    if (r.status === 401) { onExpired(); throw new Error(t('roomAccess.sessionExpired')) }
    const d = await r.json()
    if (!r.ok) throw new Error(d.error ?? t('common.genericError'))
    return d
  }

  useEffect(() => {
    rf('/reservation')
      .then(d => { setData(d.data); setLoading(false) })
      .catch((e: any) => { setError(e.message ?? t('roomAccess.loadError')); setLoading(false) })
  }, [])

  if (loading) return <div className="loading"><span className="spin" /></div>
  if (error)   return <div className="alert alert-error">{error}</div>
  if (!data)   return null

  const nights  = Math.round((new Date(data.checkOutDate + 'T12:00:00').getTime() - new Date(data.checkInDate + 'T12:00:00').getTime()) / 86400000)
  const pending = parseFloat(data.total) - parseFloat(data.amountPaid ?? '0')
  const hasExtraRooms = ((data.extraRoomIds ?? []) as number[]).length > 0
  const active  = !['cancelled', 'no_show', 'checked_out'].includes(data.status)

  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <h1 className="pub-title" style={{ marginBottom: 4 }}>{t('roomAccess.headerTitle')}</h1>
        {data.room?.code && <p style={{ color: 'var(--text2)', fontSize: 14 }}>{t('reservation.room')}: {data.room.code}</p>}
      </div>

      <div className="pub-card" style={{ marginBottom: 14 }}>
        <div className="summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.arrival')}</span><strong>{fmtDate(data.checkInDate)}</strong></div>
        <div className="summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.departure')}</span><strong>{fmtDate(data.checkOutDate)}</strong></div>
        <div className="summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.nights')}</span><strong>{nights}</strong></div>
        {data.rate && <div className="summary-row"><span style={{ color: 'var(--text2)' }}>{t('reservation.rate')}</span><strong>{data.rate.title}</strong></div>}
        <div className="summary-row total"><span>{t('common.total')}</span><span>{fmtMoney(data.total)}</span></div>
        {parseFloat(data.amountPaid) > 0 && (
          <div className="summary-row" style={{ color: 'var(--green)' }}><span>{t('reservation.paid')}</span><span>{fmtMoney(data.amountPaid)}</span></div>
        )}
        {pending > 0.01 && (
          <div className="summary-row" style={{ color: 'var(--red)', fontWeight: 600 }}><span>{t('reservation.pending')}</span><span>{fmtMoney(pending.toFixed(2))}</span></div>
        )}
      </div>

      {active && <HousekeepingSection t={t} rf={rf} />}
      {active && !hasExtraRooms && <RoomExtendSection t={t} rf={rf} fullyPaid={pending <= 0.01} />}
      {active && <RoomExtrasSection t={t} rf={rf} nights={nights} people={data.people} />}
      {!['cancelled', 'no_show'].includes(data.status) && <RoomFeedbackSection t={t} rf={rf} />}
    </>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

function RoomApp() {
  const [lang, setLang] = useStandaloneLang()
  const t = makeT(lang, PORTAL_I18N)
  const qrToken   = new URLSearchParams(location.search).get('t') ?? ''
  const sessionKey = `bm_room_session_${qrToken}`

  const [session,   setSession]   = useState<string | null>(() => { try { return localStorage.getItem(sessionKey) } catch { return null } })
  const [paymentOk, setPaymentOk] = useState(() => new URLSearchParams(location.search).has('payment_ok'))

  const onVerified = (jwt: string) => {
    try { localStorage.setItem(sessionKey, jwt) } catch { /* privado/bloqueado */ }
    setSession(jwt)
  }
  const onExpired = () => {
    try { localStorage.removeItem(sessionKey) } catch { /* ignore */ }
    setSession(null)
  }

  return (
    <>
      <header className="pub-header">
        <a href="/" className="pub-logo">{(() => { const w = branding.name.split(' '); const last = w.pop(); return <>{w.join(' ')}{w.length ? ' ' : ''}<span>{last}</span></> })()}</a>
        <div className="pub-header-links"><LangSwitcher lang={lang} onChange={setLang} /></div>
      </header>
      <div className="pub-wrap">
        {!qrToken ? (
          <div className="alert alert-error" style={{ marginTop: 40 }}>{t('roomAccess.invalidCode')}</div>
        ) : (
          <>
            {paymentOk && (
              <div className="alert" style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 10, padding: '12px 16px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t('app.paymentOk')}</span>
                <button onClick={() => { setPaymentOk(false); window.history.replaceState({}, '', `/room?t=${qrToken}`) }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#15803d' }}>✕</button>
              </div>
            )}
            {!session
              ? <VerifyGate t={t} qrToken={qrToken} onVerified={onVerified} />
              : <RoomStay t={t} session={session} onExpired={onExpired} />}
          </>
        )}
      </div>
    </>
  )
}

boot(() => createRoot(document.getElementById('root')!).render(
  <RoomApp />
))
