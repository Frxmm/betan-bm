import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, canManage } from '../contexts/AuthContext'
import { speak as speakText, SpeechRecognitionCtor } from '../lib/speech'

type Role = 'user' | 'assistant'
interface Msg { role: Role; content: string; actions?: any[] }
interface SessionSummary { sessionId: string; startedAt: string; lastAt: string; messageCount: number; preview: string }

const VIEW_PATHS: Record<string, string> = {
  dashboard: '/dashboard', planning: '/planning', arrivals: '/arrivals',
  departures: '/departures', billing: '/billing', reservations: '/reservations',
  guests: '/guests', rooms: '/rooms',
}

const SUGGESTIONS = ['Resumen de hoy', 'Llegadas de mañana', 'Busca a García', 'Disponibilidad esta semana']

// Voz de las respuestas del asistente — Web Speech API nativa del navegador,
// sin backend ni clave de API. Apagada por defecto (localStorage, por
// dispositivo): que hable el asistente solo si se activa a propósito.
// La limpieza de texto (stripForSpeech) vive en ../lib/speech.ts, compartida
// con AdminQuickStats.tsx.
const TTS_KEY = 'af-tts-enabled'

// Cuánto esperar antes de volver a lanzar un chequeo proactivo (evita saludar
// en cada recarga de página si el usuario deja el dashboard abierto todo el
// día). El límite real ahora está en el servidor (como mucho 1 vez al día
// por usuario, ver POST /api/ai/proactive) — este cooldown local solo evita
// peticiones de red de sobra, ya no es lo que controla el gasto.
const PROACTIVE_COOLDOWN_MS = 20 * 3600_000
const PROACTIVE_KEY = 'af_proactive_at'

// Pregunta diaria de "¿dónde te gustaría estar?" — una vez al día, a una hora
// aleatoria (no siempre a la misma hora ni al abrir la página)
const BG_HOUR_MIN = 9
const BG_HOUR_MAX = 20
const todayStr = () => new Date().toISOString().slice(0, 10)

function getOrCreateBgTarget(): number {
  const key = `af_bg_target_${todayStr()}`
  const saved = localStorage.getItem(key)
  if (saved) return Number(saved)
  const hour   = BG_HOUR_MIN + Math.random() * (BG_HOUR_MAX - BG_HOUR_MIN)
  const target = new Date()
  target.setHours(Math.floor(hour), Math.floor((hour % 1) * 60), 0, 0)
  localStorage.setItem(key, String(target.getTime()))
  return target.getTime()
}

export default function AgentFloat() {
  const navigate               = useNavigate()
  const { user }                = useAuth()
  const canUseVoice            = canManage(user) // solo dirección, por ahora
  const [open,    setOpen]     = useState(false)
  const [msgs,    setMsgs]     = useState<Msg[]>([])
  const [input,   setInput]    = useState('')
  const [loading, setLoading]  = useState(false)
  const [unread,  setUnread]   = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [sessions,    setSessions]    = useState<SessionSummary[]>([])
  const bottomRef              = useRef<HTMLDivElement>(null)
  const inputRef                = useRef<HTMLTextAreaElement>(null)
  const panelRef                = useRef<HTMLDivElement>(null)
  const sessionIdRef            = useRef<string | null>(null)
  const [ttsEnabled, setTtsEnabled] = useState(() => {
    try { return localStorage.getItem(TTS_KEY) === '1' } catch { return false }
  })
  // Cuántos mensajes ya se han leído en voz alta — evita releer el historial
  // al restaurar una sesión antigua o al reabrir el panel.
  const spokenCountRef = useRef(0)

  const toggleTts = () => {
    setTtsEnabled(v => {
      const next = !v
      try { localStorage.setItem(TTS_KEY, next ? '1' : '0') } catch {}
      if (!next) { try { window.speechSynthesis?.cancel() } catch {} }
      return next
    })
  }

  const speak = speakText

  // Lee en voz alta el último mensaje del asistente en cuanto llega, si está
  // activado — no relee mensajes ya vistos (historial restaurado, reaperturas).
  useEffect(() => {
    if (msgs.length <= spokenCountRef.current) { spokenCountRef.current = msgs.length; return }
    const newOnes = msgs.slice(spokenCountRef.current)
    spokenCountRef.current = msgs.length
    if (!ttsEnabled || !canUseVoice) return
    const lastAssistant = [...newOnes].reverse().find(m => m.role === 'assistant')
    if (lastAssistant) speak(lastAssistant.content)
  }, [msgs, ttsEnabled, canUseVoice])

  // Dictado por voz (Web Speech API, SpeechRecognition — soporte real: Chrome/
  // Edge de escritorio y Android, nada en Firefox, muy poco fiable en iOS
  // Safari). En cuanto se detecta silencio (fin del habla) se envía solo, sin
  // necesidad de pulsar Enter — se guarda en una ref (no en el estado input,
  // que es asíncrono) para tener el texto definitivo justo al terminar.
  const canDictate = canUseVoice && !!SpeechRecognitionCtor
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<any>(null)
  const dictatedTextRef = useRef('')

  const toggleDictation = () => {
    if (!SpeechRecognitionCtor) return
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    try { window.speechSynthesis?.cancel() } catch {} // no dictar mientras habla el asistente
    dictatedTextRef.current = ''
    const recognition = new SpeechRecognitionCtor()
    recognition.lang = 'es-ES'
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onresult = (e: any) => {
      let transcript = ''
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript
      dictatedTextRef.current = transcript
      setInput(transcript)
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

  useEffect(() => {
    return () => { try { recognitionRef.current?.stop() } catch {} }
  }, [])

  const loadSessions = () => {
    fetch('/api/ai/sessions', { credentials: 'include' })
      .then(r => r.json()).then(d => setSessions(d.data ?? [])).catch(() => {})
  }

  const toggleHistory = () => {
    setShowHistory(o => {
      if (!o) loadSessions()
      return !o
    })
  }

  const restoreSession = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/ai/sessions/${sessionId}`, { credentials: 'include' })
      const data = await res.json()
      const restored = (data.data ?? []).map((m: any) => ({ role: m.role, content: m.content }))
      spokenCountRef.current = restored.length // no releer el historial en voz alta
      setMsgs(restored)
      sessionIdRef.current = sessionId
      setShowHistory(false)
    } catch {}
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs, loading])

  // El fondo se guarda en el servidor, pero el panel ya cargó el suyo al montar
  // Layout — si el asistente lo cambia a mitad de sesión, avisamos para que se
  // vuelva a pedir sin necesidad de recargar la página.
  const notifyIfBgChanged = (actions: any[]) => {
    if (actions?.some(a => a.tool === 'set_dashboard_background' && a.result?.ok)) {
      window.dispatchEvent(new CustomEvent('dashboard-bg-changed'))
    }
  }

  const fireProactive = (kind: 'checkin' | 'background') => {
    fetch('/api/ai/proactive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    })
      .then(r => r.json())
      .then(data => {
        if (!data?.text) return
        setMsgs(prev => [...prev, { role: 'assistant', content: data.text, actions: data.actions ?? [] }])
        setUnread(true)
        notifyIfBgChanged(data.actions ?? [])
      })
      .catch(() => {})
  }

  // Chequeo proactivo: al entrar (login/recarga), si ha pasado el cooldown,
  // el asistente se adelanta y saluda con algo concreto sin que se le pregunte.
  useEffect(() => {
    const lastAt = Number(localStorage.getItem(PROACTIVE_KEY) ?? '0')
    if (Date.now() - lastAt < PROACTIVE_COOLDOWN_MS) return
    localStorage.setItem(PROACTIVE_KEY, String(Date.now()))
    fireProactive('checkin')
  }, [])

  // Pregunta del fondo de pantalla: se comprueba al entrar y luego cada 5 min
  // (por si la hora aleatoria de hoy llega con la pestaña ya abierta).
  useEffect(() => {
    const check = () => {
      const askedKey = `af_bg_asked_${todayStr()}`
      if (localStorage.getItem(askedKey)) return
      if (Date.now() < getOrCreateBgTarget()) return
      localStorage.setItem(askedKey, '1')
      fireProactive('background')
    }
    check()
    const id = setInterval(check, 5 * 60_000)
    return () => clearInterval(id)
  }, [])

  // Buzón de mensajes internos de otro miembro del equipo (nunca de huéspedes):
  // se comprueba al entrar y cada 2 min mientras la pestaña esté abierta.
  useEffect(() => {
    const checkInbox = () => {
      fetch('/api/ai/inbox', { credentials: 'include' })
        .then(r => r.json())
        .then(d => {
          const texts: string[] = d?.data ?? []
          if (!texts.length) return
          setMsgs(prev => [...prev, ...texts.map(t => ({ role: 'assistant' as const, content: t }))])
          setUnread(true)
        })
        .catch(() => {})
    }
    checkInbox()
    const id = setInterval(checkInbox, 2 * 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 80)
      setUnread(false)
    }
  }, [open])

  // Cierra al click fuera del panel
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const send = async (text: string) => {
    const userMsg = text.trim()
    if (!userMsg || loading) return
    setInput('')
    const history: Msg[] = [...msgs, { role: 'user', content: userMsg }]
    setMsgs(history)
    setLoading(true)
    if (!sessionIdRef.current) sessionIdRef.current = crypto.randomUUID()
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map(m => ({ role: m.role, content: m.content })),
          sessionId: sessionIdRef.current,
        }),
      })
      const data = await res.json()
      const assistantMsg: Msg = { role: 'assistant', content: data.text ?? '(sin respuesta)', actions: data.actions ?? [] }
      setMsgs([...history, assistantMsg])
      notifyIfBgChanged(data.actions ?? [])
      if (data.navigate?.view) {
        const path = VIEW_PATHS[data.navigate.view]
        if (path) setTimeout(() => { navigate(data.navigate.id ? `${path}/${data.navigate.id}` : path); setOpen(false) }, 500)
      }
    } catch (e: any) {
      setMsgs([...history, { role: 'assistant', content: `Error: ${e.message}` }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
  }

  return (
    <div ref={panelRef} className="af-root">
      {/* Botón trigger en topbar */}
      <button
        className={`af-trigger${open ? ' af-trigger-open' : ''}${unread && !open ? ' af-trigger-unread' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Asistente IA"
      >
        ✦
        {unread && !open && <span className="af-badge af-badge-dot" />}
        {!unread && msgs.length > 0 && !open && <span className="af-badge">{msgs.filter(m => m.role === 'assistant').length}</span>}
      </button>

      {/* Panel flotante */}
      <div className={`af-panel${open ? ' af-panel-open' : ''}`}>
        <div className="af-header" style={{ position: 'relative' }}>
          <span className="af-title">✦ Asistente</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {canUseVoice && (
              <button className="af-icon-btn" onClick={toggleTts} title={ttsEnabled ? 'Voz activada — click para silenciar' : 'Voz desactivada — click para activar'}>
                {ttsEnabled ? '🔊' : '🔇'}
              </button>
            )}
            <button className="af-icon-btn" onClick={toggleHistory} title="Sesiones anteriores">🕘</button>
            {msgs.length > 0 && (
              <button className="af-icon-btn" onClick={() => { spokenCountRef.current = 0; setMsgs([]); sessionIdRef.current = null }} title="Limpiar">↺</button>
            )}
            <button className="af-icon-btn" onClick={() => { try { window.speechSynthesis?.cancel() } catch {}; setOpen(false) }} title="Cerrar">✕</button>
          </div>
          {showHistory && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 280, maxHeight: 300, overflowY: 'auto',
              background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.45)',
              zIndex: 20, padding: 6,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', padding: '4px 6px', textTransform: 'uppercase' }}>
                Últimas sesiones
              </div>
              {sessions.length === 0 && <div style={{ fontSize: 12, color: 'var(--text2)', padding: '6px' }}>Sin sesiones guardadas</div>}
              {sessions.map(s => (
                <button key={s.sessionId} onClick={() => restoreSession(s.sessionId)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '6px 6px', borderRadius: 6, color: 'var(--text)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                  <div style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.preview || '(sin texto)'}</div>
                  <div style={{ fontSize: 10, color: 'var(--text2)' }}>{new Date(s.lastAt).toLocaleString('es-ES')} · {s.messageCount} msjs</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="af-messages">
          {msgs.length === 0 && (
            <div className="af-empty">
              <p>¿En qué puedo ayudarte?</p>
              <div className="af-suggestions">
                {SUGGESTIONS.map(s => (
                  <button key={s} className="af-suggestion" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`af-msg af-msg-${m.role}`}>
              <div className="af-bubble">
                <pre className="af-text">{m.content}</pre>
                {m.actions && m.actions.length > 0 && (
                  <div className="af-actions">
                    {m.actions.map((a, j) => (
                      <details key={j} className="af-action-detail">
                        <summary>{a.tool}</summary>
                        <pre className="af-action-json">{JSON.stringify(a.result, null, 2)}</pre>
                      </details>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="af-msg af-msg-assistant">
              <div className="af-bubble af-thinking">
                <span className="af-dot"/><span className="af-dot"/><span className="af-dot"/>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="af-input-row">
          {canDictate && (
            <button
              className="af-icon-btn"
              onClick={toggleDictation}
              disabled={loading}
              title={listening ? 'Escuchando… click para parar' : 'Dictar por voz'}
              style={listening ? { color: 'var(--red, #ef4444)' } : undefined}
            >
              {listening ? '🔴' : '🎤'}
            </button>
          )}
          <textarea
            ref={inputRef}
            className="af-input"
            rows={1}
            placeholder={listening ? 'Escuchando…' : 'Escribe… (Enter para enviar)'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={loading}
          />
          <button className="af-send btn btn-primary" onClick={() => send(input)} disabled={loading || !input.trim()}>
            {loading ? '…' : '↑'}
          </button>
        </div>
      </div>
    </div>
  )
}
