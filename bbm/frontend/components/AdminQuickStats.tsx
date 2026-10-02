import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAuth, canManage } from '../contexts/AuthContext'
import { api } from '../lib/api'
import { today } from '../lib/utils'
import { speak, SpeechRecognitionCtor } from '../lib/speech'

// ─── Resumen rápido de dirección ────────────────────────────────────────────
// Se abre solo al entrar (una vez al día, por navegador — ver SEEN_KEY) y
// solo para rol dirección: ocupación de hoy, cobros de hoy por método,
// reservas nuevas de hoy y llegadas aún pendientes, más un chat de voz con
// el agente (sin caja de texto — solo dictado, y el texto es de solo
// lectura de lo que responde el agente).
const SEEN_KEY = 'admin-quickstats-seen'

const METHOD_LABEL: Record<string, string> = {
  cash: 'Efectivo', credit_card: 'Tarjeta', bank_transfer: 'Transferencia',
  stripe: 'Stripe', booking_virtual_card: 'Tarjeta virtual (Booking)',
  deposit: 'Depósito efectivo', deposit_cc: 'Depósito CC',
  jumbo_credit: 'Jumbo a crédito', other: 'Otros',
}

function fmtMoney(n: number) { return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €' }

export default function AdminQuickStats() {
  const { user } = useAuth()
  const admin = canManage(user)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!admin) return
    let seen = ''
    try { seen = localStorage.getItem(SEEN_KEY) ?? '' } catch { /* privado/bloqueado: se mostrará cada vez */ }
    if (seen === today()) return
    setOpen(true)
    try { localStorage.setItem(SEEN_KEY, today()) } catch { /* ignore */ }
  }, [admin])

  if (!admin || !open) return null
  return <AdminQuickStatsModal onClose={() => setOpen(false)} />
}

// Usado también por Layout.tsx para el "modo admin simplificado" forzado
// (users.simplifiedAdminMode): en ese caso no se pasa onClose, así que en vez
// de la X se muestra el botón de cerrar sesión — es la única salida posible.
export function AdminQuickStatsModal({ onClose }: { onClose?: () => void }) {
  const { logout } = useAuth()
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [occPct,   setOccPct]   = useState<number | null>(null)
  const [newRes,   setNewRes]   = useState<number | null>(null)
  const [totalPaid, setTotalPaid] = useState(0)
  const [byMethod, setByMethod] = useState<Record<string, { count: number; total: number }>>({})
  const [pendingArrivals, setPendingArrivals] = useState<any[]>([])

  useEffect(() => {
    const d = today()
    Promise.all([
      api.dashboardOccupancy(),
      api.dashboard(),
      api.paymentSummary({ dateFrom: d, dateTo: d }),
      api.arrivals(d),
    ]).then(([occ, dash, pay, arr]: any[]) => {
      setOccPct(occ.data.today.pct)
      setNewRes(dash.data.newReservations)
      setByMethod(pay.meta.byMethod)
      setTotalPaid(parseFloat(pay.meta.total))
      setPendingArrivals((arr.data ?? []).filter((r: any) => ['tentative', 'arriving', 'confirmed'].includes(r.status)))
    }).catch((e: any) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  return createPortal(
    <div className="aqs-overlay">
      <div className="aqs-overlay-header">
        <h2>📊 Resumen rápido</h2>
        {onClose
          ? <button className="modal-close" onClick={onClose} title="Cerrar">✕</button>
          : <button className="btn btn-ghost btn-xs" onClick={logout} title="Cerrar sesión">Cerrar sesión</button>}
      </div>
      <div className="aqs-overlay-body">
        {loading && <div className="loading">Cargando…</div>}
        {error && <p style={{ color: 'var(--red)' }}>{error}</p>}
        {!loading && !error && (
          <div className="aqs">
          <div className="aqs-block aqs-stats">
            <StatCard label="Ocupación hoy" value={`${occPct}%`} />
            <StatCard label="Cobrado hoy" value={fmtMoney(totalPaid)} />
            <StatCard label="Reservas nuevas hoy" value={String(newRes)} />
            <StatCard label="Llegadas pendientes" value={String(pendingArrivals.length)} />
          </div>

          {Object.keys(byMethod).length > 0 && (
            <div className="aqs-block card">
              <div className="card-header"><h3 style={{ fontSize: 14, fontWeight: 600 }}>Cobros de hoy por método</h3></div>
              <div style={{ padding: '4px 12px 12px' }}>
                {Object.entries(byMethod).map(([method, v]) => (
                  <div key={method} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <span style={{ color: 'var(--text2)' }}>{METHOD_LABEL[method] ?? method}</span>
                    <strong>{fmtMoney(v.total)} <span style={{ color: 'var(--text2)', fontWeight: 400 }}>({v.count})</span></strong>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="aqs-block card">
            <div className="card-header"><h3 style={{ fontSize: 14, fontWeight: 600 }}>Llegadas pendientes de hoy</h3></div>
            {pendingArrivals.length === 0 ? (
              <p style={{ padding: '0 12px 12px', fontSize: 13, color: 'var(--text2)' }}>Sin llegadas pendientes.</p>
            ) : (
              <table className="data-table">
                <thead><tr><th>Hab.</th><th>Canal</th><th style={{ textAlign: 'right' }}>Saldo pendiente</th></tr></thead>
                <tbody>
                  {pendingArrivals.map(r => (
                    <tr key={r.id}>
                      <td><span className="badge">{r.room?.code ?? '—'}</span></td>
                      <td style={{ fontSize: 13, color: 'var(--text2)' }}>{r.bookingChannel?.name ?? '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: r.pendingBalance > 0.01 ? 'var(--red)' : 'var(--text2)' }}>
                        {fmtMoney(r.pendingBalance ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="aqs-block aqs-chat">
            <VoiceChat />
          </div>
        </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card aqs-stat-card">
      <div className="aqs-stat-value">{value}</div>
      <div className="aqs-stat-label">{label}</div>
    </div>
  )
}

// ─── Chat de voz (solo dictado, texto de solo lectura) ─────────────────────────
interface ChatMsg { role: 'user' | 'assistant'; content: string }

function VoiceChat() {
  const [msgs,      setMsgs]      = useState<ChatMsg[]>([])
  const [listening, setListening] = useState(false)
  const [loading,   setLoading]   = useState(false)
  const sessionIdRef    = useRef<string | null>(null)
  const recognitionRef  = useRef<any>(null)
  const dictatedTextRef = useRef('')

  useEffect(() => () => { try { recognitionRef.current?.stop() } catch { /* ignore */ } }, [])

  const send = async (text: string) => {
    const userMsg = text.trim()
    if (!userMsg || loading) return
    const history: ChatMsg[] = [...msgs, { role: 'user', content: userMsg }]
    setMsgs(history)
    setLoading(true)
    if (!sessionIdRef.current) sessionIdRef.current = crypto.randomUUID()
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.map(m => ({ role: m.role, content: m.content })), sessionId: sessionIdRef.current }),
      })
      const data = await res.json()
      const reply = data.text ?? '(sin respuesta)'
      setMsgs([...history, { role: 'assistant', content: reply }])
      speak(reply)
    } catch (e: any) {
      setMsgs([...history, { role: 'assistant', content: `Error: ${e.message}` }])
    } finally {
      setLoading(false)
    }
  }

  const toggleDictation = () => {
    if (!SpeechRecognitionCtor) return
    if (listening) { recognitionRef.current?.stop(); return }
    try { window.speechSynthesis?.cancel() } catch { /* ignore */ }
    dictatedTextRef.current = ''
    const recognition = new SpeechRecognitionCtor()
    recognition.lang = 'es-ES'
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onresult = (e: any) => {
      let transcript = ''
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript
      dictatedTextRef.current = transcript
    }
    recognition.onerror = () => setListening(false)
    recognition.onend = () => {
      setListening(false)
      const text = dictatedTextRef.current.trim()
      dictatedTextRef.current = ''
      if (text) send(text)
    }
    recognitionRef.current = recognition
    setListening(true)
    recognition.start()
  }

  if (!SpeechRecognitionCtor) return null // sin soporte de dictado en este navegador: no tiene sentido mostrar un chat que no se puede usar

  return (
    <div className="card">
      <div className="card-header"><h3 style={{ fontSize: 14, fontWeight: 600 }}>✦ Pregúntale al agente</h3></div>
      <div style={{ padding: '0 12px 12px' }}>
        {msgs.length === 0 && !loading && (
          <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 10 }}>
            Pulsa el micrófono y habla — el agente responde en voz y aquí abajo puedes leer la conversación.
          </p>
        )}
        {msgs.length > 0 && (
          <div style={{ maxHeight: 240, overflowY: 'auto', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {msgs.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%', fontSize: 13, padding: '8px 12px', borderRadius: 10,
                background: m.role === 'user' ? 'var(--accent2)' : 'var(--bg2)',
                color: m.role === 'user' ? '#fff' : 'var(--text)',
              }}>
                {m.content}
              </div>
            ))}
            {loading && <div style={{ alignSelf: 'flex-start', fontSize: 13, color: 'var(--text2)' }}>…</div>}
          </div>
        )}
        <div style={{ textAlign: 'center' }}>
          <button
            className={`btn ${listening ? 'btn-primary' : 'btn-ghost'}`}
            onClick={toggleDictation}
            disabled={loading}
            style={{ borderRadius: 999, width: 56, height: 56, fontSize: 22 }}
          >
            {listening ? '🔴' : '🎤'}
          </button>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
            {listening ? 'Escuchando…' : loading ? 'Pensando…' : 'Toca para hablar'}
          </div>
        </div>
      </div>
    </div>
  )
}
